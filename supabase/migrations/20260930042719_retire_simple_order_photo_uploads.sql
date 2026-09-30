-- Photo capture/attachment was removed from SIMPLE. Keep the three existing
-- private objects for administrator recovery, but close all browser access.
-- Do not delete the bucket or files as part of this UI change.
drop policy if exists simple_order_photos_staff_upload on storage.objects;
drop policy if exists simple_order_photos_staff_read on storage.objects;
drop policy if exists simple_order_photos_staff_delete on storage.objects;
