-- One request ID can advance the numbering run only once, even after a retry.
create table simple_order_private.pickup_resets (
  request_id uuid primary key,
  generation integer not null check (generation > 1),
  reset_by uuid not null,
  created_at timestamptz not null default now()
);
alter table simple_order_private.pickup_resets enable row level security;
revoke all on table simple_order_private.pickup_resets from public, anon, authenticated;

drop function public.reset_simple_pickup_counter();
create function public.reset_simple_pickup_counter(p_confirmation text, p_request_id uuid)
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
  -- The same row lock serializes allocations and resets.
  update simple_order_private.pickup_counter
    set generation = generation + 1, last_number = 0
    where singleton
    returning jsonb_build_object('generation', generation, 'next_number', 1) into result;
  insert into simple_order_private.pickup_resets(request_id, generation, reset_by)
    values (p_request_id, (result->>'generation')::integer, auth.uid());
  return result;
end;
$$;
revoke all on function public.reset_simple_pickup_counter(text, uuid) from public, anon, authenticated;
grant execute on function public.reset_simple_pickup_counter(text, uuid) to authenticated;
notify pgrst, 'reload schema';
