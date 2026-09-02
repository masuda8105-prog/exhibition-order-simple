-- Defense in depth: remove any legacy broad grants restored outside migrations.
-- Browser roles may read and update only the columns required by staff.js.

alter table public.exhibition_orders enable row level security;
revoke all privileges on table public.exhibition_orders from anon, authenticated;
grant select on table public.exhibition_orders to authenticated;
grant update (
  order_data, status, assigned_to, assigned_name, printed_at, completed_at,
  event_id, event_name, event_date, event_day,
  revision_count, revision_reason, requires_resend,
  sent_at, sent_by, sent_by_name, batch_id, pending_batch_id,
  deleted_at, deleted_by, deleted_by_name, delete_reason, status_before_delete,
  updated_at, updated_by, updated_by_name
) on public.exhibition_orders to authenticated;
drop policy if exists "staff can delete exhibition orders" on public.exhibition_orders;
drop policy if exists exhibition_orders_admin_delete on public.exhibition_orders;
