-- Patch for databases created before service_role privileges were included
-- in the baseline schema. RLS stays enabled; service_role bypasses it.

grant usage on schema public to service_role;
grant all privileges on table public.app_kv to service_role;
grant all privileges on table public.app_aliases to service_role;
grant all privileges on table public.app_domains to service_role;
grant all privileges on table public.app_logs to service_role;
grant all privileges on table public.app_messages to service_role;
grant all privileges on table public.app_audit to service_role;
grant usage, select on all sequences in schema public to service_role;

notify pgrst, 'reload schema';
