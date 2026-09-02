-- 韓国展示会 受注ワークフロー拡張
-- 既存の exhibition_orders / order_data を残したまま、削除・復元・再送・送信履歴を追加します。

begin;
alter table public.exhibition_staff
  add column if not exists role text not null default 'staff';
alter table public.exhibition_staff
  drop constraint if exists exhibition_staff_role_check;
alter table public.exhibition_staff
  add constraint exhibition_staff_role_check
  check (role in ('staff', 'admin')) not valid;
alter table public.exhibition_staff validate constraint exhibition_staff_role_check;
alter table public.exhibition_orders
  add column if not exists client_submission_id uuid,
  add column if not exists event_id text,
  add column if not exists event_name text,
  add column if not exists event_date date,
  add column if not exists event_day integer,
  add column if not exists updated_by uuid,
  add column if not exists updated_by_name text,
  add column if not exists revision_count integer not null default 0,
  add column if not exists revision_reason text,
  add column if not exists requires_resend boolean not null default false,
  add column if not exists sent_at timestamptz,
  add column if not exists sent_by uuid,
  add column if not exists sent_by_name text,
  add column if not exists batch_id text,
  add column if not exists pending_batch_id text,
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by uuid,
  add column if not exists deleted_by_name text,
  add column if not exists delete_reason text,
  add column if not exists status_before_delete text;
alter table public.exhibition_orders
  drop constraint if exists exhibition_orders_status_check;
alter table public.exhibition_orders
  add constraint exhibition_orders_status_check
  check (status in ('new', 'in_progress', 'completed', 'sent', 'resend_required', 'deleted')) not valid;
alter table public.exhibition_orders validate constraint exhibition_orders_status_check;
create unique index if not exists exhibition_orders_client_submission_uidx
  on public.exhibition_orders (client_submission_id)
  where client_submission_id is not null;
create index if not exists exhibition_orders_event_date_status_idx
  on public.exhibition_orders (event_id, event_date, status, created_at desc);
create index if not exists exhibition_orders_pending_batch_idx
  on public.exhibition_orders (pending_batch_id)
  where pending_batch_id is not null;
create table if not exists public.order_revisions (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.exhibition_orders(id) on delete cascade,
  event_id text,
  revision_number integer not null,
  changed_at timestamptz not null default now(),
  changed_by uuid,
  changed_by_name text,
  change_reason text not null,
  status_before text,
  status_after text,
  before_data jsonb not null,
  after_data jsonb not null,
  batch_id_before text
);
create unique index if not exists order_revisions_order_revision_uidx
  on public.order_revisions (order_id, revision_number);
create index if not exists order_revisions_order_changed_idx
  on public.order_revisions (order_id, changed_at desc);
create table if not exists public.order_activity_logs (
  id uuid primary key default gen_random_uuid(),
  order_id uuid references public.exhibition_orders(id) on delete set null,
  event_id text,
  action text not null,
  performed_at timestamptz not null default now(),
  performed_by uuid,
  performed_by_name text,
  details jsonb not null default '{}'::jsonb
);
create index if not exists order_activity_logs_order_time_idx
  on public.order_activity_logs (order_id, performed_at desc);
create table if not exists public.order_batch_counters (
  event_id text not null,
  event_date date not null,
  last_number integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (event_id, event_date)
);
create table if not exists public.order_batches (
  id uuid primary key default gen_random_uuid(),
  batch_id text not null unique,
  event_id text,
  event_name text,
  event_date date,
  created_at timestamptz not null default now(),
  created_by uuid,
  created_by_name text,
  sent_at timestamptz,
  sent_by uuid,
  sent_by_name text,
  recipient_email text,
  order_count integer not null default 0,
  total_quantity integer not null default 0,
  total_amount numeric not null default 0,
  status text not null default 'draft' check (status in ('draft', 'sent', 'cancelled')),
  pdf_created_at timestamptz,
  mail_opened_at timestamptz,
  notes text
);
create index if not exists order_batches_event_date_idx
  on public.order_batches (event_id, event_date, created_at desc);
create table if not exists public.order_batch_items (
  id uuid primary key default gen_random_uuid(),
  batch_id text not null references public.order_batches(batch_id) on delete cascade,
  order_id uuid references public.exhibition_orders(id) on delete set null,
  order_snapshot jsonb not null,
  revision_number integer not null default 0,
  created_at timestamptz not null default now(),
  unique (batch_id, order_id)
);
create or replace function public.is_active_exhibition_staff()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.exhibition_staff s
    where s.user_id = auth.uid() and s.active = true
  );
$$;
create or replace function public.is_exhibition_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.exhibition_staff s
    where s.user_id = auth.uid() and s.active = true and s.role = 'admin'
  );
$$;
revoke all on function public.is_active_exhibition_staff() from public, anon;
revoke all on function public.is_exhibition_admin() from public, anon;
grant execute on function public.is_active_exhibition_staff() to authenticated;
grant execute on function public.is_exhibition_admin() to authenticated;
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

  if new.status in ('completed', 'sent', 'resend_required')
     and old.status not in ('completed', 'sent', 'resend_required') then
    new.completed_at = coalesce(new.completed_at, now());
  elsif new.status in ('new', 'in_progress') then
    new.completed_at = null;
  end if;

  if new.status = 'deleted' and old.status is distinct from 'deleted' then
    new.deleted_at = coalesce(new.deleted_at, now());
    -- Actor metadata supplied by the browser must never be trusted.
    new.deleted_by = auth.uid();
    new.deleted_by_name = actor_name;
    new.status_before_delete = coalesce(new.status_before_delete, old.status);
  end if;

  return new;
end;
$$;
drop trigger if exists exhibition_orders_updated_at_trigger on public.exhibition_orders;
create trigger exhibition_orders_updated_at_trigger
before update on public.exhibition_orders
for each row execute function public.set_exhibition_order_updated_at();
alter table public.exhibition_orders enable row level security;
revoke all on table public.exhibition_orders from anon, authenticated;
grant select on table public.exhibition_orders to authenticated;
grant update (
  order_data, status, assigned_to, assigned_name, printed_at, completed_at,
  event_id, event_name, event_date, event_day,
  revision_count, revision_reason, requires_resend,
  sent_at, sent_by, sent_by_name, batch_id, pending_batch_id,
  deleted_at, deleted_by, deleted_by_name, delete_reason, status_before_delete,
  updated_at, updated_by, updated_by_name
) on public.exhibition_orders to authenticated;
drop policy if exists exhibition_orders_staff_select on public.exhibition_orders;
create policy exhibition_orders_staff_select
on public.exhibition_orders for select to authenticated
using (expires_at > now() and public.is_active_exhibition_staff());
drop policy if exists exhibition_orders_staff_update on public.exhibition_orders;
create policy exhibition_orders_staff_update
on public.exhibition_orders for update to authenticated
using (expires_at > now() and public.is_active_exhibition_staff())
with check (
  expires_at > now()
  and public.is_active_exhibition_staff()
  and status in ('new', 'in_progress', 'completed', 'sent', 'resend_required', 'deleted')
);
drop policy if exists "staff can delete exhibition orders" on public.exhibition_orders;
drop policy if exists exhibition_orders_admin_delete on public.exhibition_orders;
-- Physical deletion is not available to browser clients. Retention cleanup is
-- performed only by the server-side cleanup function.
revoke delete on table public.exhibition_orders from authenticated;
alter table public.order_revisions enable row level security;
alter table public.order_activity_logs enable row level security;
alter table public.order_batches enable row level security;
alter table public.order_batch_items enable row level security;
alter table public.order_batch_counters enable row level security;
revoke all on public.order_revisions, public.order_activity_logs, public.order_batches,
  public.order_batch_items, public.order_batch_counters from anon, authenticated;
grant select, insert on public.order_revisions to authenticated;
grant select, insert on public.order_activity_logs to authenticated;
grant select on public.order_batches, public.order_batch_items to authenticated;
drop policy if exists order_revisions_staff_select on public.order_revisions;
create policy order_revisions_staff_select on public.order_revisions
for select to authenticated using (public.is_active_exhibition_staff());
drop policy if exists order_revisions_staff_insert on public.order_revisions;
create policy order_revisions_staff_insert on public.order_revisions
for insert to authenticated with check (public.is_active_exhibition_staff() and changed_by = auth.uid());
drop policy if exists order_activity_logs_staff_select on public.order_activity_logs;
create policy order_activity_logs_staff_select on public.order_activity_logs
for select to authenticated using (public.is_active_exhibition_staff());
drop policy if exists order_activity_logs_staff_insert on public.order_activity_logs;
create policy order_activity_logs_staff_insert on public.order_activity_logs
for insert to authenticated with check (public.is_active_exhibition_staff() and performed_by = auth.uid());
drop policy if exists order_batches_staff_select on public.order_batches;
create policy order_batches_staff_select on public.order_batches
for select to authenticated using (public.is_active_exhibition_staff());
drop policy if exists order_batch_items_staff_select on public.order_batch_items;
create policy order_batch_items_staff_select on public.order_batch_items
for select to authenticated using (public.is_active_exhibition_staff());
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
    and o.status in ('completed', 'resend_required')
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
    and o.status in ('completed', 'resend_required');
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
create or replace function public.cancel_exhibition_order_batch(p_batch_id text)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  affected integer;
begin
  if not public.is_active_exhibition_staff() then raise exception 'staff_not_allowed'; end if;
  update public.order_batches set status = 'cancelled'
  where batch_id = p_batch_id and status = 'draft';
  if not found then raise exception 'batch_not_draft'; end if;
  update public.exhibition_orders set pending_batch_id = null where pending_batch_id = p_batch_id;
  get diagnostics affected = row_count;
  return affected;
end;
$$;
revoke all on function public.create_exhibition_order_batch(text, text, date, uuid[], text, text) from public, anon;
revoke all on function public.mark_exhibition_order_batch_sent(text, text) from public, anon;
revoke all on function public.cancel_exhibition_order_batch(text) from public, anon;
grant execute on function public.create_exhibition_order_batch(text, text, date, uuid[], text, text) to authenticated;
grant execute on function public.mark_exhibition_order_batch_sent(text, text) to authenticated;
grant execute on function public.cancel_exhibition_order_batch(text) to authenticated;
-- 旧マイグレーションが公開用キーで作成したcleanup Cronは停止します。
-- CLEANUP_SECRETを使う安全な再登録は supabase/sql/04_secure_cleanup_schedule.sql を参照してください。
do $$
declare
  cleanup_job_id bigint;
begin
  for cleanup_job_id in
    select jobid from cron.job where jobname = 'cleanup-expired-exhibition-orders'
  loop
    perform cron.unschedule(cleanup_job_id);
  end loop;
end $$;
commit;
