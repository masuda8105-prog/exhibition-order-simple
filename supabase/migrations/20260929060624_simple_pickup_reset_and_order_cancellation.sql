-- Keep every issued number, including numbers from cancelled orders. A reset starts
-- a new numbered run so JEX-1 and JEX-2-1 are never confused.
alter table simple_order_private.pickup_counter
  add column generation integer not null default 1 check (generation > 0);
alter table simple_order_private.pickup_numbers
  add column generation integer not null default 1 check (generation > 0);
alter table simple_order_private.pickup_numbers
  drop constraint pickup_numbers_number_key;
alter table simple_order_private.pickup_numbers
  add constraint pickup_numbers_generation_number_key unique (generation, number);

alter table public.exhibition_app_orders
  add column simple_pickup_generation integer;
update public.exhibition_app_orders
set simple_pickup_generation = 1
where simple_pickup_number is not null and event_name = 'exhibition-order-simple';
alter table public.exhibition_app_orders
  add constraint simple_pickup_generation_scope check (
    simple_pickup_generation is null or
    (event_name = 'exhibition-order-simple' and simple_pickup_generation > 0)
  );
drop index public.exhibition_simple_pickup_number_unique;
create unique index exhibition_simple_pickup_generation_number_unique
  on public.exhibition_app_orders(simple_pickup_generation, simple_pickup_number)
  where simple_pickup_number is not null;

create or replace function simple_order_private.assign_pickup_number()
returns trigger language plpgsql security definer set search_path = '' as $$
declare assigned bigint;
declare assigned_generation integer;
begin
  if auth.uid() is null or not exists (
    select 1 from public.exhibition_staff s where s.user_id = auth.uid() and s.active = true
  ) then
    raise exception 'Active staff authentication required' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and (new.id is distinct from old.id or new.event_name is distinct from old.event_name) then
    raise exception 'Order identity and group cannot be changed' using errcode = '23514';
  end if;
  select number, generation into assigned, assigned_generation
    from simple_order_private.pickup_numbers where order_id = new.id;
  if assigned is null and new.payload->>'type' = 'spot' and new.payload->>'handoff' = 'later' then
    -- Reset and allocation both lock this singleton row.
    perform 1 from simple_order_private.pickup_counter where singleton for update;
    select number, generation into assigned, assigned_generation
      from simple_order_private.pickup_numbers where order_id = new.id;
    if assigned is null then
      update simple_order_private.pickup_counter set last_number = last_number + 1
        where singleton returning last_number, generation into assigned, assigned_generation;
      insert into simple_order_private.pickup_numbers(order_id, generation, number)
        values (new.id, assigned_generation, assigned);
    end if;
  end if;
  new.simple_pickup_number := assigned;
  new.simple_pickup_generation := assigned_generation;
  return new;
end;
$$;

create function public.simple_pickup_counter_status()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare result jsonb;
begin
  if auth.uid() is null or not exists (
    select 1 from public.exhibition_staff s where s.user_id = auth.uid() and s.active = true
  ) then
    raise exception 'Active staff authentication required' using errcode = '42501';
  end if;
  select jsonb_build_object('generation', generation, 'next_number', last_number + 1)
    into result from simple_order_private.pickup_counter where singleton;
  return result;
end;
$$;

create function public.reset_simple_pickup_counter()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare result jsonb;
begin
  if auth.uid() is null or not exists (
    select 1 from public.exhibition_staff s where s.user_id = auth.uid() and s.active = true
  ) then
    raise exception 'Active staff authentication required' using errcode = '42501';
  end if;
  update simple_order_private.pickup_counter
    set generation = generation + 1, last_number = 0
    where singleton
    returning jsonb_build_object('generation', generation, 'next_number', 1) into result;
  return result;
end;
$$;

revoke all on function public.simple_pickup_counter_status() from public, anon, authenticated;
revoke all on function public.reset_simple_pickup_counter() from public, anon, authenticated;
grant execute on function public.simple_pickup_counter_status() to authenticated;
grant execute on function public.reset_simple_pickup_counter() to authenticated;
notify pgrst, 'reload schema';
