begin;
set local lock_timeout = '5s';
-- Keep the other application's function, grants, sequence and issued numbers.
-- On a fresh SIMPLE-only database there is no production allocator to adjust.
do $$ begin
  if exists (select 1 from pg_trigger where tgrelid='public.exhibition_app_orders'::regclass
    and tgname='assign_exhibition_pickup_number_trigger') then
    execute $ddl$
      create or replace trigger assign_exhibition_pickup_number_trigger
      before insert or update on public.exhibition_app_orders
      for each row when (new.event_name is distinct from 'exhibition-order-simple')
      execute function public.assign_exhibition_pickup_number()
    $ddl$;
  end if;
end $$;
notify pgrst, 'reload schema';
commit;
