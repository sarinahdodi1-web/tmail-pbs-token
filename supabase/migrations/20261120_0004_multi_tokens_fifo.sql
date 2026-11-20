-- One-time access tokens with recoverable encrypted values and FIFO message allocation.

create table if not exists public.app_alias_tokens (
  id uuid primary key default gen_random_uuid(),
  alias_address text not null references public.app_aliases(address) on update cascade on delete cascade,
  token_hash text not null unique,
  token_ciphertext text not null,
  token_last4 text,
  status text not null default 'available' check (status in ('available', 'waiting', 'fulfilled', 'revoked')),
  created_at timestamptz not null default now(),
  consumed_at timestamptz,
  fulfilled_at timestamptz,
  message_id text unique
);

create index if not exists idx_app_alias_tokens_fifo
on public.app_alias_tokens(alias_address, created_at, id)
where status = 'waiting';

alter table public.app_messages
  add column if not exists token_id uuid;

create unique index if not exists idx_app_messages_token_id
on public.app_messages(token_id)
where token_id is not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'app_messages_token_id_fkey') then
    alter table public.app_messages
      add constraint app_messages_token_id_fkey
      foreign key (token_id) references public.app_alias_tokens(id) on update cascade on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'app_alias_tokens_message_id_fkey') then
    alter table public.app_alias_tokens
      add constraint app_alias_tokens_message_id_fkey
      foreign key (message_id) references public.app_messages(id) on update cascade on delete set null;
  end if;
end $$;

-- Legacy hashes are not decryptable. Do not create misleading token rows; admins must issue new tokens.
drop index if exists public.idx_app_aliases_access_token_hash;
alter table public.app_aliases
  drop column if exists access_token_hash,
  drop column if exists access_token_last4,
  drop column if exists token_created_at;

alter table public.app_alias_tokens enable row level security;
grant all privileges on table public.app_alias_tokens to service_role;

create or replace function public.consume_alias_token(p_token_hash text)
returns table (id uuid, alias_address text, token_hash text, status text, consumed_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  update public.app_alias_tokens t
  set status = 'waiting', consumed_at = now()
  from public.app_aliases a
  where t.token_hash = p_token_hash
    and t.status = 'available'
    and a.address = t.alias_address
    and a.active = true
  returning t.id, t.alias_address, t.token_hash, t.status, t.consumed_at;
end;
$$;

create or replace function public.allocate_alias_message(p_alias text, p_message jsonb)
returns table (outcome text, token_id uuid, message_id text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_token public.app_alias_tokens%rowtype;
  v_message_id text := p_message->>'id';
  v_existing_token_id uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended(v_message_id, 0));

  select m.token_id into v_existing_token_id from public.app_messages m where m.id = v_message_id;
  if found then
    return query select 'duplicate'::text, v_existing_token_id, v_message_id;
    return;
  end if;

  select t.* into v_token
  from public.app_alias_tokens t
  where t.alias_address = p_alias and t.status = 'waiting'
  order by t.created_at, t.id
  for update skip locked
  limit 1;

  if not found then
    return query select 'no_waiting_token'::text, null::uuid, v_message_id;
    return;
  end if;

  insert into public.app_messages (
    id, alias, token_id, from_email, to_email, subject, date, snippet,
    body_text, body_html, raw, headers, source, created_at
  ) values (
    v_message_id, p_alias, v_token.id, p_message->>'from_email', p_message->>'to_email',
    p_message->>'subject', nullif(p_message->>'date', '')::timestamptz, p_message->>'snippet',
    p_message->>'body_text', p_message->>'body_html', p_message->>'raw',
    coalesce(p_message->'headers', '{}'::jsonb),
    coalesce(p_message->>'source', 'cloudflare_email_worker'),
    coalesce(nullif(p_message->>'created_at', '')::timestamptz, now())
  );

  update public.app_alias_tokens
  set status = 'fulfilled', fulfilled_at = now(), message_id = v_message_id
  where app_alias_tokens.id = v_token.id;

  return query select 'allocated'::text, v_token.id, v_message_id;
end;
$$;

revoke all on function public.consume_alias_token(text) from public, anon, authenticated;
revoke all on function public.allocate_alias_message(text, jsonb) from public, anon, authenticated;
grant execute on function public.consume_alias_token(text) to service_role;
grant execute on function public.allocate_alias_message(text, jsonb) to service_role;

notify pgrst, 'reload schema';
