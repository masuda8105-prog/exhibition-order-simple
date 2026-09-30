-- The simple app stores order photos separately from the public GitHub site and
-- from the production app's receipt bucket. Originals/EXIF never leave the device.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('exhibition-simple-photos', 'exhibition-simple-photos', false, 10485760, array['image/jpeg']);

create policy simple_order_photos_staff_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'exhibition-simple-photos'
    and exists (select 1 from public.exhibition_staff s
      where s.user_id = (select auth.uid()) and s.active = true)
    and exists (select 1 from public.exhibition_app_orders o
      where o.id::text = (storage.foldername(name))[1]
        and o.event_name = 'exhibition-order-simple' and o.deleted_at is null)
  );

create policy simple_order_photos_staff_upload on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'exhibition-simple-photos'
    and name ~ '^[0-9a-f-]{36}/[0-9]{13}-[0-9a-f-]{36}[.]jpg$'
    and exists (select 1 from public.exhibition_staff s
      where s.user_id = (select auth.uid()) and s.active = true)
    and exists (select 1 from public.exhibition_app_orders o
      where o.id::text = (storage.foldername(name))[1]
        and o.event_name = 'exhibition-order-simple' and o.deleted_at is null)
  );

create policy simple_order_photos_staff_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'exhibition-simple-photos'
    and exists (select 1 from public.exhibition_staff s
      where s.user_id = (select auth.uid()) and s.active = true)
    and exists (select 1 from public.exhibition_app_orders o
      where o.id::text = (storage.foldername(name))[1]
        and o.event_name = 'exhibition-order-simple' and o.deleted_at is null)
  );
