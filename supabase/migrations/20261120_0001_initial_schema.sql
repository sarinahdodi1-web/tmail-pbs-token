-- PBS Mail baseline schema for a new Supabase project.
-- The application accesses these tables from server routes using service_role.

create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create table public.app_kv (
  key text primary key,
  value jsonb,
  updated_at timestamptz not null default now()
);

create trigger trg_app_kv_updated_at
before update on public.app_kv
for each row execute function public.set_updated_at();

create table public.app_aliases (
  address text primary key,
  created_at timestamptz,
  last_used_at timestamptz,
  hits integer not null default 0,
  active boolean not null default true
);

create table public.app_alias_tokens (
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

create index idx_app_alias_tokens_fifo
on public.app_alias_tokens(alias_address, created_at, id)
where status = 'waiting';

create table public.app_domains (
  name text primary key,
  active boolean not null default true,
  created_at timestamptz
);

create table public.app_logs (
  id text primary key,
  alias text,
  from_email text,
  subject text,
  date text,
  snippet text,
  last_seen_at timestamptz
);

create table public.app_messages (
  id text primary key,
  alias text not null,
  token_id uuid unique references public.app_alias_tokens(id) on update cascade on delete set null,
  from_email text,
  to_email text,
  subject text,
  date timestamptz,
  snippet text,
  body_text text,
  body_html text,
  raw text,
  headers jsonb not null default '{}'::jsonb,
  source text not null default 'cloudflare_email_worker',
  created_at timestamptz not null default now()
);

alter table public.app_alias_tokens
  add constraint app_alias_tokens_message_id_fkey
  foreign key (message_id) references public.app_messages(id) on update cascade on delete set null;

create index idx_app_messages_alias_created_at
on public.app_messages(alias, created_at desc);

create index idx_app_messages_created_at
on public.app_messages(created_at desc);

create table public.app_audit (
  id bigint generated always as identity primary key,
  timestamp timestamptz not null,
  action text not null,
  ip text,
  user_agent text,
  meta jsonb
);

create index idx_app_audit_timestamp
on public.app_audit(timestamp desc);

-- No public policies are defined. The service_role used by server routes bypasses RLS.
alter table public.app_kv enable row level security;
alter table public.app_aliases enable row level security;
alter table public.app_alias_tokens enable row level security;
alter table public.app_domains enable row level security;
alter table public.app_logs enable row level security;
alter table public.app_messages enable row level security;
alter table public.app_audit enable row level security;

grant usage on schema public to service_role;
grant all privileges on table public.app_kv to service_role;
grant all privileges on table public.app_aliases to service_role;
grant all privileges on table public.app_alias_tokens to service_role;
grant all privileges on table public.app_domains to service_role;
grant all privileges on table public.app_logs to service_role;
grant all privileges on table public.app_messages to service_role;
grant all privileges on table public.app_audit to service_role;
grant usage, select on all sequences in schema public to service_role;

create or replace function public.consume_alias_token(p_token_hash text)
returns table (
  id uuid,
  alias_address text,
  token_hash text,
  status text,
  consumed_at timestamptz
)
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

  select m.token_id into v_existing_token_id
  from public.app_messages m
  where m.id = v_message_id;
  if found then
    return query select 'duplicate'::text, v_existing_token_id, v_message_id;
    return;
  end if;

  insert into public.app_messages (
    id, alias, token_id, from_email, to_email, subject, date, snippet,
    body_text, body_html, raw, headers, source, created_at
  ) values (
    v_message_id, p_alias, null, p_message->>'from_email', p_message->>'to_email',
    p_message->>'subject', nullif(p_message->>'date', '')::timestamptz, p_message->>'snippet',
    p_message->>'body_text', p_message->>'body_html', p_message->>'raw',
    coalesce(p_message->'headers', '{}'::jsonb),
    coalesce(p_message->>'source', 'cloudflare_email_worker'),
    coalesce(nullif(p_message->>'created_at', '')::timestamptz, now())
  );

  select t.* into v_token
  from public.app_alias_tokens t
  where t.alias_address = p_alias and t.status = 'waiting'
  order by t.created_at, t.id
  for update skip locked
  limit 1;

  if not found then
    return query select 'admin_only'::text, null::uuid, v_message_id;
    return;
  end if;

  update public.app_messages set token_id = v_token.id where app_messages.id = v_message_id;

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
