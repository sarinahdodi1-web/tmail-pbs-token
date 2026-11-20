-- Keep every inbound email in the admin inbox, even when no user token is waiting.
-- User inboxes remain isolated because public queries require token_id.

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

  update public.app_messages
  set token_id = v_token.id
  where app_messages.id = v_message_id;

  update public.app_alias_tokens
  set status = 'fulfilled', fulfilled_at = now(), message_id = v_message_id
  where app_alias_tokens.id = v_token.id;

  return query select 'allocated'::text, v_token.id, v_message_id;
end;
$$;

revoke all on function public.allocate_alias_message(text, jsonb) from public, anon, authenticated;
grant execute on function public.allocate_alias_message(text, jsonb) to service_role;

notify pgrst, 'reload schema';
