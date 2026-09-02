-- 注文担当者と最終更新者を分離します。
-- 担当者は確認開始・注文確定時だけ更新し、閲覧後の印刷・一括送付・修正では保持します。

begin;
create or replace function public.set_exhibition_order_updated_at()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor_name text;
  starts_review boolean;
  confirms_order boolean;
begin
  new.updated_at = now();

  starts_review := old.status in ('submitted', 'new')
                   and new.status = 'in_progress';
  confirms_order := old.status in ('submitted', 'new', 'in_progress')
                    and new.status in ('confirmed', 'completed');

  if auth.uid() is not null then
    select s.display_name into actor_name
    from public.exhibition_staff s
    where s.user_id = auth.uid() and s.active = true;

    if actor_name is not null then
      -- 最終更新者は印刷・送付・修正を含む更新履歴として残します。
      new.updated_by = auth.uid();
      new.updated_by_name = actor_name;

      -- 注文担当者は実際に確認を担当したスタッフだけに限定します。
      if starts_review or confirms_order then
        new.assigned_to = auth.uid();
        new.assigned_name = actor_name;
      else
        new.assigned_to = old.assigned_to;
        new.assigned_name = old.assigned_name;
      end if;
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
commit;
