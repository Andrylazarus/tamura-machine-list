-- =====================================================================
-- Attendance (absen) for every engineer, shown on the Daily report page
-- Run this once in Supabase: Dashboard → SQL Editor → New query → Run.
-- Run it after schema.sql, permissions.sql and daily.sql. Safe to run again.
--
--   every approved account : sees everyone's attendance; checks itself in and out for TODAY,
--                            or reports today as sick / permission / leave
--   admin                  : also adds, edits and deletes attendance for anyone on any date
--
-- Check-in and check-out times are taken from the server clock, so they can't be typed in.
-- =====================================================================

create table if not exists public.attendance (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade default auth.uid(),
  work_date   date not null default ((now() at time zone 'Asia/Jakarta')::date),
  status      text not null default 'present'
              check (status in ('present', 'sick', 'permit', 'leave', 'off', 'absent')),
  check_in    timestamptz,
  check_out   timestamptz,
  note        text not null default '' check (char_length(note) <= 500),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (user_id, work_date)
);

create index if not exists attendance_date_idx on public.attendance (work_date desc);

-- Engineers: only today, only themselves, and times from the server clock.
-- Admins: free to correct anything.
create or replace function public.guard_attendance()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  today date := (now() at time zone 'Asia/Jakarta')::date;
begin
  new.updated_at := now();
  if public.app_role() = 'admin' then
    if tg_op = 'UPDATE' then new.created_at := old.created_at; end if;
    return new;
  end if;

  if tg_op = 'INSERT' then
    new.user_id   := auth.uid();
    new.work_date := today;
    new.created_at := now();
    new.check_in  := case when new.status = 'present' then now() else null end;
    new.check_out := null;
    if new.status in ('off', 'absent') then
      raise exception 'Only an admin can set day off or absent' using errcode = '42501';
    end if;
    return new;
  end if;

  -- UPDATE by an engineer
  if old.work_date <> today then
    raise exception 'You can only change today''s attendance. Ask an admin to correct an earlier day.' using errcode = '42501';
  end if;
  if new.status in ('off', 'absent') and new.status is distinct from old.status then
    raise exception 'Only an admin can set day off or absent' using errcode = '42501';
  end if;
  new.user_id    := old.user_id;
  new.work_date  := old.work_date;
  new.created_at := old.created_at;
  -- check in: keep the first time; set it now when switching to present
  if new.status = 'present' then
    new.check_in := coalesce(old.check_in, now());
  else
    new.check_in := null; new.check_out := null;
  end if;
  -- check out: whenever the app asks for it, the server time is used
  if new.status = 'present' and new.check_out is not null and old.check_out is null then
    new.check_out := now();
  elsif new.status = 'present' then
    new.check_out := old.check_out;
  end if;
  return new;
end;
$$;

drop trigger if exists attendance_guard on public.attendance;
create trigger attendance_guard
  before insert or update on public.attendance
  for each row execute function public.guard_attendance();

alter table public.attendance enable row level security;

drop policy if exists "attendance: approved read" on public.attendance;
create policy "attendance: approved read" on public.attendance
  for select to authenticated
  using (public.app_role() in ('admin', 'viewer'));

drop policy if exists "attendance: own or admin insert" on public.attendance;
create policy "attendance: own or admin insert" on public.attendance
  for insert to authenticated
  with check (public.app_role() = 'admin' or (public.app_role() = 'viewer' and user_id = auth.uid()));

drop policy if exists "attendance: own or admin update" on public.attendance;
create policy "attendance: own or admin update" on public.attendance
  for update to authenticated
  using (public.app_role() = 'admin' or (public.app_role() = 'viewer' and user_id = auth.uid()))
  with check (public.app_role() = 'admin' or (public.app_role() = 'viewer' and user_id = auth.uid()));

drop policy if exists "attendance: admin delete" on public.attendance;
create policy "attendance: admin delete" on public.attendance
  for delete to authenticated
  using (public.app_role() = 'admin');

revoke all on public.attendance from anon;
grant select, insert, update, delete on public.attendance to authenticated;

-- Approved accounts (admin + viewer) that are expected to check in. Pending accounts are left out.
create or replace function public.attendance_roster()
returns table (id uuid, name text)
language sql
stable
security definer
set search_path = public
as $$
  select p.id, coalesce(nullif(trim(p.name), ''), split_part(coalesce(p.email, ''), '@', 1))
  from public.profiles p
  where public.app_role() in ('admin', 'viewer') and p.role in ('admin', 'viewer');
$$;
revoke all on function public.attendance_roster() from public, anon;
grant execute on function public.attendance_roster() to authenticated;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables
                     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'attendance') then
    alter publication supabase_realtime add table public.attendance;
  end if;
end;
$$;

notify pgrst, 'reload schema';
