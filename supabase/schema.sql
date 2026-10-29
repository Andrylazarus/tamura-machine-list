-- =====================================================================
-- Tamura Machine List — database schema for Supabase
-- Run this once in Supabase: Dashboard → SQL Editor → New query → Run.
-- =====================================================================

-- ---------- Profiles: one row per login, holds the user's role ----------
-- Roles:
--   admin   : can view, add, edit, delete, import, and manage user roles
--   viewer  : can view and export only
--   pending : logged in but not approved yet — sees nothing
create table if not exists public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  email      text,
  role       text not null default 'pending' check (role in ('admin', 'viewer', 'pending')),
  created_at timestamptz not null default now()
);

-- Create a profile automatically whenever a user is invited or signs up
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email) values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Role of the user making the request (used by the security rules below)
create or replace function public.app_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role from public.profiles where id = auth.uid();
$$;

-- ---------- Machines ----------
create table if not exists public.machines (
  id          uuid primary key default gen_random_uuid(),
  key         text not null unique,           -- customer + serial, used to match rows on Excel import
  customer    text not null,
  kind        text not null default '',
  model       text not null default '',
  line        text not null default '',
  serial      text not null default '',
  mfg         text not null default '',        -- manufactured month, "YYYY-MM"
  version     text not null default '',
  last_cal    date,
  next_cal    date,
  ip          text not null default '',
  os          text not null default '',
  pc_model    text not null default '',
  memory      text not null default '',
  vga         text not null default '',
  location    text not null default '',
  check_by    text not null default '',
  notes       text not null default '',
  updated_at  timestamptz not null default now(),
  updated_by  uuid references auth.users (id) on delete set null default auth.uid()
);

create index if not exists machines_customer_idx on public.machines (customer);

-- Keep updated_at / updated_by current on every edit
create or replace function public.touch_machine()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end;
$$;

drop trigger if exists machines_touch on public.machines;
create trigger machines_touch
  before update on public.machines
  for each row execute function public.touch_machine();

-- ---------- Security rules (Row Level Security) ----------
alter table public.profiles enable row level security;
alter table public.machines enable row level security;

-- Profiles: everyone reads their own profile; admins read and change everyone's role
drop policy if exists "profiles: read own or admin" on public.profiles;
create policy "profiles: read own or admin" on public.profiles
  for select to authenticated
  using (id = auth.uid() or public.app_role() = 'admin');

drop policy if exists "profiles: admin updates roles" on public.profiles;
create policy "profiles: admin updates roles" on public.profiles
  for update to authenticated
  using (public.app_role() = 'admin')
  with check (public.app_role() = 'admin');

-- Machines: approved users read; only admins write
drop policy if exists "machines: approved users read" on public.machines;
create policy "machines: approved users read" on public.machines
  for select to authenticated
  using (public.app_role() in ('admin', 'viewer'));

drop policy if exists "machines: admin insert" on public.machines;
create policy "machines: admin insert" on public.machines
  for insert to authenticated
  with check (public.app_role() = 'admin');

drop policy if exists "machines: admin update" on public.machines;
create policy "machines: admin update" on public.machines
  for update to authenticated
  using (public.app_role() = 'admin')
  with check (public.app_role() = 'admin');

drop policy if exists "machines: admin delete" on public.machines;
create policy "machines: admin delete" on public.machines
  for delete to authenticated
  using (public.app_role() = 'admin');

-- Nothing is readable without logging in
revoke all on public.machines from anon;
revoke all on public.profiles from anon;

-- Live updates in the browser when someone else edits
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables
                     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'machines') then
    alter publication supabase_realtime add table public.machines;
  end if;
end;
$$;
