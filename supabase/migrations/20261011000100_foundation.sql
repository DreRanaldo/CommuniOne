-- Stage 1 / Migration 1: foundation
--
-- Creates the `private` schema used for internal helper functions and a
-- generic updated_at trigger function.
--
-- The `private` schema is NOT exposed through the Supabase Data API
-- (only `public` is), so functions placed here cannot be called as RPCs by
-- clients. Authenticated users still need USAGE + EXECUTE because RLS
-- policies are evaluated with the privileges of the querying role.

create schema if not exists private;

revoke all on schema private from public;
grant usage on schema private to authenticated, service_role;

-- Keeps updated_at accurate regardless of what the client sends.
create or replace function private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

revoke all on function private.set_updated_at() from public;
