-- Only SIMPLE orders participate; production orders and payloads are unchanged.
create schema if not exists simple_order_private;
revoke all on schema simple_order_private from public, anon, authenticated;
create table simple_order_private.pickup_counter (
  singleton boolean primary key default true check (singleton),
  last_number bigint not null default 0 check (last_number >= 0)
);
insert into simple_order_private.pickup_counter values (true, 0);
create table simple_order_private.pickup_numbers (
  order_id uuid primary key,
  number bigint not null unique check (number > 0)
);
-- No FK cascade: reserved numbers survive order deletion and must never be reused.
alter table simple_order_private.pickup_counter enable row level security;
alter table simple_order_private.pickup_numbers enable row level security;
revoke all on all tables in schema simple_order_private from public, anon, authenticated;

alter table public.exhibition_app_orders add column simple_pickup_number bigint;
alter table public.exhibition_app_orders add constraint simple_pickup_number_scope
  check (simple_pickup_number is null or (event_name = 'exhibition-order-simple' and simple_pickup_number > 0));
create unique index exhibition_simple_pickup_number_unique
  on public.exhibition_app_orders(simple_pickup_number) where simple_pickup_number is not null;

create function simple_order_private.assign_pickup_number()
returns trigger language plpgsql security definer set search_path = '' as $$
declare assigned bigint;
begin
  if auth.uid() is null or not exists (
    select 1 from public.exhibition_staff s where s.user_id = auth.uid() and s.active = true
  ) then
    raise exception 'Active staff authentication required' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and (new.id is distinct from old.id or new.event_name is distinct from old.event_name) then
    raise exception 'Order identity and group cannot be changed' using errcode = '23514';
  end if;
  select number into assigned from simple_order_private.pickup_numbers where order_id = new.id;
  if assigned is null and new.payload->>'type' = 'spot' and new.payload->>'handoff' = 'later' then
    -- Serialize the short allocation transaction across all staff/devices.
    perform 1 from simple_order_private.pickup_counter where singleton for update;
    -- Recheck after waiting for another transaction using the same order UUID.
    select number into assigned from simple_order_private.pickup_numbers where order_id = new.id;
    if assigned is null then
      update simple_order_private.pickup_counter set last_number = last_number + 1
        where singleton returning last_number into assigned;
      insert into simple_order_private.pickup_numbers(order_id, number) values (new.id, assigned);
    end if;
  end if;
  -- Browser-supplied numbers are never authoritative, including old clients.
  new.simple_pickup_number := assigned;
  return new;
end;
$$;
revoke all on function simple_order_private.assign_pickup_number() from public, anon, authenticated;
create trigger simple_assign_pickup_on_insert before insert on public.exhibition_app_orders
  for each row when (new.event_name = 'exhibition-order-simple')
  execute function simple_order_private.assign_pickup_number();
create trigger simple_assign_pickup_on_update before update on public.exhibition_app_orders
  for each row when (old.event_name = 'exhibition-order-simple' or new.event_name = 'exhibition-order-simple')
  execute function simple_order_private.assign_pickup_number();
