-- Harden and reuse the reference tables that already belong to the exhibition app.
-- No order/customer table is created: drafts live only in browser memory.

do $$
begin
  if to_regclass('public.products') is null
    or to_regclass('public.exhibition_staff') is null
    or to_regclass('public.exhibition_accounts') is null then
    raise exception 'Expected products, exhibition_staff and exhibition_accounts tables are missing';
  end if;
end
$$;

alter table public.products
  add column if not exists source_batch_id uuid;

create index if not exists products_active_product_no_idx
  on public.products (is_active, product_no);

create index if not exists products_source_batch_idx
  on public.products (source_batch_id);

create index if not exists exhibition_accounts_active_order_idx
  on public.exhibition_accounts (is_active, display_order, account_name);

alter table public.exhibition_staff enable row level security;
alter table public.products enable row level security;
alter table public.exhibition_accounts enable row level security;

-- Postgres privileges are the first gate. RLS policies below are the second gate.
revoke all on table public.exhibition_staff from anon, authenticated;
revoke all on table public.products from anon, authenticated;
revoke all on table public.exhibition_accounts from anon, authenticated;

grant usage on schema public to authenticated;
grant select on table public.exhibition_staff to authenticated;
grant select on table public.products to authenticated;
grant select on table public.exhibition_accounts to authenticated;

drop policy if exists exhibition_staff_read_self on public.exhibition_staff;
create policy exhibition_staff_read_self
  on public.exhibition_staff
  for select
  to authenticated
  using (
    user_id = (select auth.uid())
    and active
  );

drop policy if exists products_active_staff_select on public.products;
create policy products_active_staff_select
  on public.products
  for select
  to authenticated
  using (
    is_active
    and exists (
      select 1
      from public.exhibition_staff as staff
      where staff.user_id = (select auth.uid())
        and staff.active
    )
  );

drop policy if exists exhibition_accounts_active_staff_select on public.exhibition_accounts;
create policy exhibition_accounts_active_staff_select
  on public.exhibition_accounts
  for select
  to authenticated
  using (
    is_active
    and exists (
      select 1
      from public.exhibition_staff as staff
      where staff.user_id = (select auth.uid())
        and staff.active
    )
  );

-- Atomically activate a fully staged import and retain old rows as inactive rollback data.
create or replace function public.activate_product_import(p_source_batch_id uuid)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  activated_count integer;
begin
  if p_source_batch_id is null then
    raise exception 'source batch id is required';
  end if;

  update public.products
  set is_active = false,
      updated_at = now()
  where is_active
    and source_batch_id is distinct from p_source_batch_id;

  update public.products
  set is_active = true,
      updated_at = now()
  where source_batch_id = p_source_batch_id;

  get diagnostics activated_count = row_count;
  if activated_count = 0 then
    raise exception 'no products found for source batch %', p_source_batch_id;
  end if;

  return activated_count;
end;
$$;

revoke all on function public.activate_product_import(uuid) from public, anon, authenticated;
grant execute on function public.activate_product_import(uuid) to service_role;

comment on column public.products.source_batch_id is 'Private import batch identifier used for atomic active-master switching.';
comment on function public.activate_product_import(uuid) is 'Service-role-only atomic switch to a fully staged product import.';
