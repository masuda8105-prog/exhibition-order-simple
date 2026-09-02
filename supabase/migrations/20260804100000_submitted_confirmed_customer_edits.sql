-- 受付番号発行 (submitted) とスタッフ注文確定 (confirmed) を分離します。
-- 既存の new / completed は削除・変換せず、旧注文との互換状態として残します。

begin;
alter table public.exhibition_orders
  drop constraint if exists exhibition_orders_status_check;
alter table public.exhibition_orders
  add constraint exhibition_orders_status_check
  check (status in (
    'submitted', 'confirmed',
    'new', 'in_progress', 'completed',
    'sent', 'resend_required', 'deleted'
  )) not valid;
alter table public.exhibition_orders validate constraint exhibition_orders_status_check;
create or replace function public.set_exhibition_order_updated_at()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor_name text;
begin
  new.updated_at = now();

  if auth.uid() is not null then
    select s.display_name into actor_name
    from public.exhibition_staff s
    where s.user_id = auth.uid() and s.active = true;
    if actor_name is not null then
      new.updated_by = auth.uid();
      new.updated_by_name = actor_name;
      new.assigned_to = auth.uid();
      new.assigned_name = actor_name;
    end if;
  end if;

  if new.status in ('confirmed', 'completed', 'sent', 'resend_required')
     and old.status not in ('confirmed', 'completed', 'sent', 'resend_required') then
    new.completed_at = coalesce(new.completed_at, now());
  elsif new.status in ('submitted', 'new', 'in_progress') then
    new.completed_at = null;
  end if;

  if new.status = 'deleted' and old.status is distinct from 'deleted' then
    new.deleted_at = coalesce(new.deleted_at, now());
    new.deleted_by = auth.uid();
    new.deleted_by_name = actor_name;
    new.status_before_delete = coalesce(new.status_before_delete, old.status);
  end if;

  return new;
end;
$$;
drop policy if exists exhibition_orders_staff_update on public.exhibition_orders;
create policy exhibition_orders_staff_update
on public.exhibition_orders for update to authenticated
using (expires_at > now() and public.is_active_exhibition_staff())
with check (
  expires_at > now()
  and public.is_active_exhibition_staff()
  and status in (
    'submitted', 'confirmed',
    'new', 'in_progress', 'completed',
    'sent', 'resend_required', 'deleted'
  )
);
-- 注文確定分のバッチ作成は新 confirmed と旧 completed の両方を受け付けます。
create or replace function public.create_exhibition_order_batch(
  p_event_id text,
  p_event_name text,
  p_event_date date,
  p_order_ids uuid[],
  p_recipient_email text,
  p_created_by_name text default null
)
returns table(batch_id text, order_count integer, total_quantity integer, total_amount numeric)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor_name text;
  next_number integer;
  new_batch_id text;
  requested_count integer;
  selected_count integer;
  quantity_sum integer;
  amount_sum numeric;
begin
  select s.display_name into actor_name
  from public.exhibition_staff s
  where s.user_id = auth.uid() and s.active = true;
  if actor_name is null then raise exception 'staff_not_allowed'; end if;

  select count(distinct x) into requested_count from unnest(p_order_ids) as requested(x);
  if coalesce(requested_count, 0) = 0 then raise exception 'orders_required'; end if;
  if p_event_date is null then raise exception 'event_date_required'; end if;

  perform 1 from public.exhibition_orders o
  where o.id = any(p_order_ids)
  for update;

  select count(*),
         coalesce(sum((select coalesce(sum(
                         case when coalesce(item->>'q', '') ~ '^\d+(\.\d+)?$'
                           then greatest(0, floor((item->>'q')::numeric)) else 0 end
                       ), 0)
                       from jsonb_array_elements(coalesce(o.order_data->'items', '[]'::jsonb)) item)), 0)::integer,
         coalesce(sum(case when coalesce(o.order_data->>'total', '') ~ '^-?\d+(\.\d+)?$'
                           then (o.order_data->>'total')::numeric else 0 end), 0)
    into selected_count, quantity_sum, amount_sum
  from public.exhibition_orders o
  where o.id = any(p_order_ids)
    and o.status in ('confirmed', 'completed', 'resend_required')
    and o.pending_batch_id is null
    and o.expires_at > now();

  if selected_count <> requested_count then raise exception 'orders_changed_or_already_batched'; end if;

  insert into public.order_batch_counters(event_id, event_date, last_number, updated_at)
  values (coalesce(nullif(p_event_id, ''), 'korea-exhibition'), p_event_date, 1, now())
  on conflict (event_id, event_date)
  do update set last_number = public.order_batch_counters.last_number + 1, updated_at = now()
  returning last_number into next_number;

  new_batch_id := 'KY-' || to_char(p_event_date, 'YYYYMMDD') || '-' || lpad(next_number::text, 2, '0');

  insert into public.order_batches(
    batch_id, event_id, event_name, event_date, created_by, created_by_name,
    recipient_email, order_count, total_quantity, total_amount, status
  ) values (
    new_batch_id, p_event_id, p_event_name, p_event_date, auth.uid(), actor_name,
    nullif(trim(p_recipient_email), ''), selected_count, quantity_sum, amount_sum, 'draft'
  );

  insert into public.order_batch_items(batch_id, order_id, order_snapshot, revision_number)
  select new_batch_id, o.id,
         o.order_data || jsonb_build_object(
           'status', o.status,
           'orderNo', o.order_no,
           '_batchId', new_batch_id,
           '_snapshotAt', now()
         ),
         coalesce(o.revision_count, 0)
  from public.exhibition_orders o where o.id = any(p_order_ids);

  update public.exhibition_orders o
  set pending_batch_id = new_batch_id
  where o.id = any(p_order_ids);

  return query select new_batch_id, selected_count, quantity_sum, amount_sum;
end;
$$;
create or replace function public.mark_exhibition_order_batch_sent(
  p_batch_id text,
  p_sent_by_name text default null
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor_name text;
  sent_time timestamptz := now();
  affected integer;
begin
  select s.display_name into actor_name
  from public.exhibition_staff s
  where s.user_id = auth.uid() and s.active = true;
  if actor_name is null then raise exception 'staff_not_allowed'; end if;

  perform 1 from public.order_batches b where b.batch_id = p_batch_id and b.status = 'draft' for update;
  if not found then raise exception 'batch_not_draft'; end if;

  update public.exhibition_orders o
  set status = 'sent', sent_at = sent_time, sent_by = auth.uid(), sent_by_name = actor_name,
      batch_id = p_batch_id, pending_batch_id = null, requires_resend = false,
      order_data = o.order_data || jsonb_build_object(
        'status', 'sent', '_sentAt', sent_time, '_sentBy', actor_name,
        '_batchId', p_batch_id, '_requiresResend', false
      )
  where o.pending_batch_id = p_batch_id
    and o.status in ('confirmed', 'completed', 'resend_required');
  get diagnostics affected = row_count;
  if affected = 0 then raise exception 'batch_orders_missing'; end if;

  update public.order_batches b
  set status = 'sent', sent_at = sent_time, sent_by = auth.uid(), sent_by_name = actor_name
  where b.batch_id = p_batch_id;

  insert into public.order_activity_logs(order_id, event_id, action, performed_by, performed_by_name, details)
  select o.id, o.event_id, 'batch_sent', auth.uid(), actor_name, jsonb_build_object('batch_id', p_batch_id)
  from public.exhibition_orders o where o.batch_id = p_batch_id;

  return affected;
end;
$$;
revoke all on function public.create_exhibition_order_batch(text, text, date, uuid[], text, text) from public, anon;
revoke all on function public.mark_exhibition_order_batch_sent(text, text) from public, anon;
grant execute on function public.create_exhibition_order_batch(text, text, date, uuid[], text, text) to authenticated;
grant execute on function public.mark_exhibition_order_batch_sent(text, text) to authenticated;
commit;
