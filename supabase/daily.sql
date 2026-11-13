-- =====================================================================
-- Daily report: what each engineer did, day by day
-- Run this once in Supabase: Dashboard → SQL Editor → New query → Run.
-- Run it after schema.sql and permissions.sql. Safe to run again.
--
--   every approved account : sees everyone's entries; writes, edits and deletes its own
--   admin                  : also edits and deletes everyone's entries
-- =====================================================================

create table if not exists public.daily_reports (
  id            uuid primary key default gen_random_uuid(),
  report_date   date not null default current_date,
  start_time    time,
  end_time      time,
  customer      text not null default '' check (char_length(customer) <= 160),
  location      text not null default '' check (char_length(location) <= 160),
  activity_type text not null default '' check (char_length(activity_type) <= 60),
  machine       text not null default '' check (char_length(machine) <= 200),
  description   text not null check (char_length(description) between 1 and 4000),
  status        text not null default 'done' check (status in ('done', 'ongoing', 'pending')),
  next_action   text not null default '' check (char_length(next_action) <= 2000),
  created_at    timestamptz not null default now(),
  created_by    uuid references auth.users (id) on delete set null default auth.uid(),
  updated_at    timestamptz not null default now()
);

create index if not exists daily_reports_date_idx on public.daily_reports (report_date desc);
create index if not exists daily_reports_by_idx on public.daily_reports (created_by, report_date desc);

-- Keep "last changed" current and never let a client change whose entry it is
create or replace function public.touch_daily_report()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  new.created_by := old.created_by;
  new.created_at := old.created_at;
  return new;
end;
$$;

drop trigger if exists daily_reports_touch on public.daily_reports;
create trigger daily_reports_touch
  before update on public.daily_reports
  for each row execute function public.touch_daily_report();

alter table public.daily_reports enable row level security;

drop policy if exists "daily: own or admin read" on public.daily_reports;
drop policy if exists "daily: approved read" on public.daily_reports;
create policy "daily: approved read" on public.daily_reports
  for select to authenticated
  using (public.app_role() in ('admin', 'viewer'));

drop policy if exists "daily: write own" on public.daily_reports;
create policy "daily: write own" on public.daily_reports
  for insert to authenticated
  with check (public.app_role() in ('admin', 'viewer') and created_by = auth.uid());

drop policy if exists "daily: own or admin update" on public.daily_reports;
create policy "daily: own or admin update" on public.daily_reports
  for update to authenticated
  using (public.app_role() = 'admin' or (public.app_role() = 'viewer' and created_by = auth.uid()))
  with check (public.app_role() = 'admin' or (public.app_role() = 'viewer' and created_by = auth.uid()));

drop policy if exists "daily: own or admin delete" on public.daily_reports;
create policy "daily: own or admin delete" on public.daily_reports
  for delete to authenticated
  using (public.app_role() = 'admin' or (public.app_role() = 'viewer' and created_by = auth.uid()));

revoke all on public.daily_reports from anon;
grant select, insert, update, delete on public.daily_reports to authenticated;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables
                     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'daily_reports') then
    alter publication supabase_realtime add table public.daily_reports;
  end if;
end;
$$;

notify pgrst, 'reload schema';
