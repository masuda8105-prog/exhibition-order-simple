-- Keep the original numeric column globally unique for clients opened before
-- this release. A separate run number starts at 1 after each reset.
alter table simple_order_private.pickup_counter
  add column run_last_number bigint not null default 0 check (run_last_number >= 0);
update simple_order_private.pickup_counter set run_last_number = last_number
  where singleton and generation = 1;
alter table simple_order_private.pickup_numbers
  add column run_number bigint;
update simple_order_private.pickup_numbers set run_number = number where generation = 1;
alter table simple_order_private.pickup_numbers
  add constraint pickup_numbers_global_number_key unique (number);
alter table simple_order_private.pickup_numbers
  add constraint pickup_numbers_run_number_check check (run_number is null or run_number > 0);
alter table public.exhibition_app_orders
  add column simple_pickup_run_number bigint;
update public.exhibition_app_orders
  set simple_pickup_run_number = simple_pickup_number
  where event_name = 'exhibition-order-simple' and simple_pickup_generation = 1;
alter table public.exhibition_app_orders
  add constraint simple_pickup_run_number_scope check (
    simple_pickup_run_number is null or
    (event_name = 'exhibition-order-simple' and simple_pickup_run_number > 0)
  );
create unique index exhibition_simple_pickup_global_number_unique
  on public.exhibition_app_orders(simple_pickup_number)
  where simple_pickup_number is not null;

create or replace function simple_order_private.assign_pickup_number()
returns trigger language plpgsql security definer set search_path = '' as $$
declare assigned bigint;
declare assigned_generation integer;
declare assigned_run bigint;
begin
  if auth.uid() is null or not exists (
    select 1 from public.exhibition_staff s where s.user_id = auth.uid() and s.active = true
  ) then
    raise exception 'Active staff authentication required' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and (new.id is distinct from old.id or new.event_name is distinct from old.event_name) then
    raise exception 'Order identity and group cannot be changed' using errcode = '23514';
  end if;
  select number, generation, run_number into assigned, assigned_generation, assigned_run
    from simple_order_private.pickup_numbers where order_id = new.id;
  if assigned is null and new.payload->>'type' = 'spot' and new.payload->>'handoff' = 'later' then
    perform 1 from simple_order_private.pickup_counter where singleton for update;
    select number, generation, run_number into assigned, assigned_generation, assigned_run
      from simple_order_private.pickup_numbers where order_id = new.id;
    if assigned is null then
      update simple_order_private.pickup_counter
        set last_number = last_number + 1, run_last_number = run_last_number + 1
        where singleton
        returning last_number, generation, run_last_number
        into assigned, assigned_generation, assigned_run;
      insert into simple_order_private.pickup_numbers(order_id, generation, number, run_number)
        values (new.id, assigned_generation, assigned, assigned_run);
    end if;
  end if;
  new.simple_pickup_number := assigned;
  new.simple_pickup_generation := assigned_generation;
  new.simple_pickup_run_number := assigned_run;
  return new;
end;
$$;

create or replace function public.simple_pickup_counter_status()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare result jsonb;
begin
  if auth.uid() is null or not exists (
    select 1 from public.exhibition_staff s where s.user_id = auth.uid() and s.active = true
  ) then
    raise exception 'Active staff authentication required' using errcode = '42501';
  end if;
  select jsonb_build_object('generation', generation, 'next_number', run_last_number + 1)
    into result from simple_order_private.pickup_counter where singleton;
  return result;
end;
$$;

create or replace function public.reset_simple_pickup_counter(p_confirmation text, p_request_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare existing_generation integer;
declare existing_staff uuid;
declare result jsonb;
begin
  if auth.uid() is null or not exists (
    select 1 from public.exhibition_staff s where s.user_id = auth.uid() and s.active = true
  ) then
    raise exception 'Active staff authentication required' using errcode = '42501';
  end if;
  if p_confirmation is distinct from 'リセット' or p_request_id is null then
    raise exception 'Explicit reset confirmation and request ID required' using errcode = '22023';
  end if;
  select generation, reset_by into existing_generation, existing_staff
    from simple_order_private.pickup_resets where request_id = p_request_id;
  if existing_generation is not null then
    if existing_staff is distinct from auth.uid() then
      raise exception 'Request ID belongs to another staff member' using errcode = '42501';
    end if;
    return jsonb_build_object('generation', existing_generation, 'next_number', 1);
  end if;
  update simple_order_private.pickup_counter
    set generation = generation + 1, run_last_number = 0
    where singleton
    returning jsonb_build_object('generation', generation, 'next_number', 1) into result;
  insert into simple_order_private.pickup_resets(request_id, generation, reset_by)
    values (p_request_id, (result->>'generation')::integer, auth.uid());
  return result;
end;
$$;
notify pgrst, 'reload schema';
