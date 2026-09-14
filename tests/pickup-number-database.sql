-- Run against the migrated database. All test orders AND counter increments roll back.
begin;
-- Refuse testing if another application's global allocator would consume a
-- nontransactional sequence for these rolled-back SIMPLE test orders.
do $$ begin
  if exists (select 1 from pg_trigger where tgrelid='public.exhibition_app_orders'::regclass
    and tgname='assign_exhibition_pickup_number_trigger' and tgqual is null) then
    raise exception 'The production allocator must exclude SIMPLE before this test runs';
  end if;
end $$;
do $$ begin
  perform set_config('request.jwt.claim.sub', (select user_id::text from public.exhibition_staff where active limit 1), true);
end $$;
set local role authenticated;
do $$
declare a uuid := gen_random_uuid(); b uuid := gen_random_uuid(); c uuid := gen_random_uuid();
  na bigint; nb bigint; changed bigint;
begin
  insert into public.exhibition_app_orders(id,event_name,payload) values
    (a,'exhibition-order-simple','{"type":"spot","handoff":"later","store":"自動試験・ロールバック"}')
    returning simple_pickup_number into na;
  begin
    insert into public.exhibition_app_orders(id,event_name,payload,simple_pickup_number) values
      (b,'exhibition-order-simple','{"type":"spot","handoff":"later"}',na);
    raise exception 'Client supplied number was permitted';
  exception when insufficient_privilege then null; end;
  insert into public.exhibition_app_orders(id,event_name,payload) values
    (b,'exhibition-order-simple','{"type":"spot","handoff":"later"}')
    returning simple_pickup_number into nb;
  if na is null or nb <> na + 1 then raise exception 'Sequential allocation failed'; end if;
  update public.exhibition_app_orders set
    payload = payload || '{"slackShared":true,"pickupDate":"2030-01-02"}' where id=a
    returning simple_pickup_number into changed;
  if changed <> na then raise exception 'Number changed on edit'; end if;
  update public.exhibition_app_orders set payload=payload || '{"handoff":"hotel"}' where id=a;
  update public.exhibition_app_orders set payload=payload || '{"handoff":"later"}' where id=a
    returning simple_pickup_number into changed;
  if changed <> na then raise exception 'Number changed after handoff switch'; end if;
  insert into public.exhibition_app_orders(id,event_name,payload) values
    (c,'exhibition-order-simple','{"type":"spot","handoff":"hotel"}')
    returning simple_pickup_number into changed;
  if changed is not null then raise exception 'Hotel received pickup number'; end if;
  update public.exhibition_app_orders set payload=payload || '{"handoff":"later"}' where id=c
    returning simple_pickup_number into changed;
  if changed <> nb + 1 then raise exception 'Converted pickup allocation failed'; end if;
  if exists (select 1 from public.exhibition_app_orders o where id in (a,b,c)
    and to_jsonb(o)->>'pickup_number' is not null) then
    raise exception 'JEX order was allocated a NEO number';
  end if;
  begin
    update public.exhibition_app_orders set event_name='other' where id=a;
    raise exception 'Order group change was not blocked';
  exception when check_violation or insufficient_privilege then null; end;
  begin
    perform last_number from simple_order_private.pickup_counter;
    raise exception 'Private counter was exposed';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
-- Same UUID retains its reservation even after a privileged hard delete/reinsert.
do $$ declare a uuid := gen_random_uuid(); n bigint; reused bigint;
begin
  insert into public.exhibition_app_orders(id,event_name,payload) values
    (a,'exhibition-order-simple','{"type":"spot","handoff":"later"}') returning simple_pickup_number into n;
  delete from public.exhibition_app_orders where id=a;
  insert into public.exhibition_app_orders(id,event_name,payload) values
    (a,'exhibition-order-simple','{"type":"spot","handoff":"later"}') returning simple_pickup_number into reused;
  if n <> reused then raise exception 'Reservation lost'; end if;
  perform set_config('request.jwt.claim.sub','',true);
  begin
    insert into public.exhibition_app_orders(id,event_name,payload) values
      (gen_random_uuid(),'exhibition-order-simple','{"type":"spot","handoff":"later"}');
    raise exception 'Unauthenticated allocation was permitted';
  exception when insufficient_privilege then null; end;
end $$;
rollback;
select 'PASS: allocation, immutable numbers, deduplication, hotel exclusion, private access, unauthenticated denial; all test data rolled back' as result;
