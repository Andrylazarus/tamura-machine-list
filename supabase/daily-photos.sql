-- =====================================================================
-- Photos on daily report activities (up to 3 per activity)
-- Run this once in Supabase: Dashboard → SQL Editor → New query → Run.
-- Run it after daily.sql. Safe to run again.
--
-- The photos are compressed in the browser (about 200–300 KB each) and stored in a
-- public Storage bucket "daily-photos" (Free plan: 1 GB in total). Anyone with a photo's
-- link can open it; only approved accounts can upload, and each person uploads into a
-- folder named after their own account.
-- =====================================================================

alter table public.daily_reports add column if not exists photos jsonb not null default '[]'::jsonb;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('daily-photos', 'daily-photos', true, 3145728, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = true, file_size_limit = 3145728, allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp'];

drop policy if exists "daily photos: approved read" on storage.objects;
create policy "daily photos: approved read" on storage.objects
  for select to authenticated
  using (bucket_id = 'daily-photos' and public.app_role() in ('admin', 'viewer'));

drop policy if exists "daily photos: upload own folder" on storage.objects;
create policy "daily photos: upload own folder" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'daily-photos' and public.app_role() in ('admin', 'viewer')
              and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "daily photos: delete own or admin" on storage.objects;
create policy "daily photos: delete own or admin" on storage.objects
  for delete to authenticated
  using (bucket_id = 'daily-photos'
         and (public.app_role() = 'admin' or (public.app_role() = 'viewer' and (storage.foldername(name))[1] = auth.uid()::text)));

notify pgrst, 'reload schema';
