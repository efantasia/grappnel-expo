-- Explicit Data API grants. Newer Supabase stacks (local CLI, and cloud after
-- 2026-10-30) no longer auto-expose entities created by `postgres` to the API
-- roles, so grants must be explicit. Row access is still gated by RLS; the
-- hosted project already has equivalent grants from the legacy auto-expose
-- behaviour, so this is a no-op there.

grant usage on schema public to anon, authenticated, service_role;

grant all privileges on all tables in schema public to anon, authenticated, service_role;
grant all privileges on all sequences in schema public to anon, authenticated, service_role;
grant all privileges on all functions in schema public to anon, authenticated, service_role;

alter default privileges for role postgres in schema public
  grant all privileges on tables to anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  grant all privileges on sequences to anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  grant all privileges on functions to anon, authenticated, service_role;
