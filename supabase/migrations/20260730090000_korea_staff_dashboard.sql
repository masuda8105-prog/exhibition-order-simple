-- 韓国展示会専用受注システム v2
-- 既存の exhibition_orders を壊さず、受付番号・スタッフ画面・Realtime を追加します。

create extension if not exists pgcrypto;
create table if not exists public.exhibition_orders (
  id uuid primary key default gen_random_uuid(),
  public_token text not null unique,
  order_no text not null,
  order_data jsonb not null,
  business_card_original_path text,
  business_card_preview_path text,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
alter table public.exhibition_orders
  add column if not exists status text not null default 'new',
  add column if not exists assigned_to uuid,
  add column if not exists assigned_name text,
  add column if not exists printed_at timestamptz,
  add column if not exists completed_at timestamptz,
  add column if not exists updated_at timestamptz not null default now();
alter table public.exhibition_orders
  drop constraint if exists exhibition_orders_status_check;
alter table public.exhibition_orders
  add constraint exhibition_orders_status_check
  check (status in ('new', 'in_progress', 'completed'));
create unique index if not exists exhibition_orders_order_no_uidx
  on public.exhibition_orders (order_no);
create index if not exists exhibition_orders_created_at_idx
  on public.exhibition_orders (created_at desc);
create index if not exists exhibition_orders_status_created_idx
  on public.exhibition_orders (status, created_at desc);
create index if not exists exhibition_orders_expires_at_idx
  on public.exhibition_orders (expires_at);
-- 日付ごとの受付番号カウンター。例: K260730-001
create table if not exists public.exhibition_order_counters (
  order_date date primary key,
  last_number integer not null default 0,
  updated_at timestamptz not null default now()
);
alter table public.exhibition_order_counters enable row level security;
revoke all on table public.exhibition_order_counters from anon, authenticated;
create or replace function public.next_korea_order_no()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  target_date date := (now() at time zone 'Asia/Seoul')::date;
  next_number integer;
begin
  insert into public.exhibition_order_counters (order_date, last_number, updated_at)
  values (target_date, 1, now())
  on conflict (order_date)
  do update set
    last_number = public.exhibition_order_counters.last_number + 1,
    updated_at = now()
  returning last_number into next_number;

  return 'K' || to_char(target_date, 'YYMMDD') || '-' || lpad(next_number::text, 3, '0');
end;
$$;
revoke all on function public.next_korea_order_no() from public, anon, authenticated;
grant execute on function public.next_korea_order_no() to service_role;
create or replace function public.set_exhibition_order_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  if new.status = 'completed' and old.status is distinct from 'completed' then
    new.completed_at = coalesce(new.completed_at, now());
  elsif new.status <> 'completed' then
    new.completed_at = null;
  end if;
  return new;
end;
$$;
drop trigger if exists exhibition_orders_updated_at_trigger on public.exhibition_orders;
create trigger exhibition_orders_updated_at_trigger
before update on public.exhibition_orders
for each row execute function public.set_exhibition_order_updated_at();
-- スタッフ許可リスト。Authユーザーを作成した後、この表へ登録したユーザーだけが注文を閲覧できます。
create table if not exists public.exhibition_staff (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
alter table public.exhibition_staff enable row level security;
revoke all on table public.exhibition_staff from anon, authenticated;
grant select on table public.exhibition_staff to authenticated;
drop policy if exists exhibition_staff_read_self on public.exhibition_staff;
create policy exhibition_staff_read_self
  on public.exhibition_staff
  for select
  to authenticated
  using (user_id = auth.uid() and active = true);
-- お客様は Edge Function 経由のみ。スタッフは Supabase Auth ログイン後のみ閲覧・状態更新できます。
alter table public.exhibition_orders enable row level security;
revoke all on table public.exhibition_orders from anon, authenticated;
grant select on table public.exhibition_orders to authenticated;
grant update (status, assigned_to, assigned_name, printed_at, completed_at, updated_at)
  on table public.exhibition_orders to authenticated;
drop policy if exists exhibition_orders_staff_select on public.exhibition_orders;
create policy exhibition_orders_staff_select
  on public.exhibition_orders
  for select
  to authenticated
  using (
    expires_at > now()
    and exists (select 1 from public.exhibition_staff s where s.user_id = auth.uid() and s.active = true)
  );
drop policy if exists exhibition_orders_staff_update on public.exhibition_orders;
create policy exhibition_orders_staff_update
  on public.exhibition_orders
  for update
  to authenticated
  using (
    expires_at > now()
    and exists (select 1 from public.exhibition_staff s where s.user_id = auth.uid() and s.active = true)
  )
  with check (
    expires_at > now()
    and exists (select 1 from public.exhibition_staff s where s.user_id = auth.uid() and s.active = true)
    and status in ('new', 'in_progress', 'completed')
  );
-- 非公開名刺Storage。お客様のアップロードは Edge Function の service_role のみ。
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'business-cards',
  'business-cards',
  false,
  15728640,
  array['image/jpeg','image/png','image/webp','image/heic','image/heif']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;
drop policy if exists business_cards_staff_read on storage.objects;
create policy business_cards_staff_read
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'business-cards'
    and exists (select 1 from public.exhibition_staff s where s.user_id = auth.uid() and s.active = true)
  );
-- Realtime publicationへ追加。すでに追加済みでも失敗しないように確認します。
do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'exhibition_orders'
  ) then
    alter publication supabase_realtime add table public.exhibition_orders;
  end if;
end $$;
-- 期限切れ注文を毎日自動削除（公開可能なPublishable keyで安全に起動）。
-- cleanup-ordersは「期限切れ行だけ」を削除し、任意の注文IDは受け付けません。
create extension if not exists pg_cron;
create extension if not exists pg_net;
do $$
begin
  if not exists (select 1 from cron.job where jobname = 'cleanup-expired-exhibition-orders') then
    perform cron.schedule(
      'cleanup-expired-exhibition-orders',
      '15 18 * * *', -- UTC 18:15 = 日本・韓国時間 03:15
      $job$
      select net.http_post(
        url := 'https://qdexhwgzawisiklekfzm.supabase.co/functions/v1/cleanup-orders',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'apikey', 'sb_publishable__mWzF7WQI5BimtlT4Rmglg_9IRh25LV'
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 10000
      );
      $job$
    );
  end if;
end $$;
