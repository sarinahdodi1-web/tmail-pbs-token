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
  active boolean not null default true,
  access_token_hash text,
  access_token_last4 text,
  token_created_at timestamptz
);

create unique index idx_app_aliases_access_token_hash
on public.app_aliases(access_token_hash)
where access_token_hash is not null;

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
alter table public.app_domains enable row level security;
alter table public.app_logs enable row level security;
alter table public.app_messages enable row level security;
alter table public.app_audit enable row level security;

grant usage on schema public to service_role;
grant all privileges on table public.app_kv to service_role;
grant all privileges on table public.app_aliases to service_role;
grant all privileges on table public.app_domains to service_role;
grant all privileges on table public.app_logs to service_role;
grant all privileges on table public.app_messages to service_role;
grant all privileges on table public.app_audit to service_role;
grant usage, select on all sequences in schema public to service_role;

notify pgrst, 'reload schema';
