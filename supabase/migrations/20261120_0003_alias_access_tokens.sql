-- Replace obsolete alias PINs with server-generated access-token metadata.

alter table public.app_aliases
  add column if not exists access_token_hash text,
  add column if not exists access_token_last4 text,
  add column if not exists token_created_at timestamptz;

alter table public.app_aliases
  drop column if exists pin_hash;

create unique index if not exists idx_app_aliases_access_token_hash
on public.app_aliases(access_token_hash)
where access_token_hash is not null;

grant all privileges on table public.app_aliases to service_role;

notify pgrst, 'reload schema';
