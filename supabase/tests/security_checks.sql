-- Run in the Supabase SQL editor after applying the migration.
-- These metadata checks do not expose table contents.

select tablename, rowsecurity
from pg_tables
where schemaname = 'public'
  and tablename in ('exhibition_staff', 'products', 'exhibition_accounts')
order by tablename;

select grantee, table_name, privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name in ('exhibition_staff', 'products', 'exhibition_accounts')
  and grantee in ('anon', 'authenticated')
order by table_name, grantee, privilege_type;

select schemaname, tablename, policyname, roles, cmd
from pg_policies
where schemaname = 'public'
  and tablename in ('exhibition_staff', 'products', 'exhibition_accounts')
order by tablename, policyname;
