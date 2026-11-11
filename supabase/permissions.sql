-- =====================================================================
-- Tamura Machine List — who may change what
-- Run this once in Supabase: Dashboard → SQL Editor → New query → Run.
-- Safe to run again.
--
--   admin  (the owner account only): sees and edits everything, deletes,
--          imports Excel, manages users
--   viewer (every other approved account): sees everything, adds machines,
--          and edits only the machines that account added itself.
--          A machine added by a viewer waits for the admin's approval;
--          until then only that viewer and the admin can see it.
-- =====================================================================

-- 1. Remember who added each machine. Machines already in the list keep an
--    empty value, so only the owner can edit them.
alter table public.machines add column if not exists created_by uuid references auth.users (id) on delete set null;
alter table public.machines alter column created_by set default auth.uid();

-- 2. Security rules
drop policy if exists "machines: admin insert" on public.machines;
drop policy if exists "machines: approved insert" on public.machines;
create policy "machines: approved insert" on public.machines
  for insert to authenticated
  with check (
    public.app_role() = 'admin'
    or (public.app_role() = 'viewer' and created_by = auth.uid())
  );

drop policy if exists "machines: admin update" on public.machines;
drop policy if exists "machines: admin or creator update" on public.machines;
create policy "machines: admin or creator update" on public.machines
  for update to authenticated
  using (
    public.app_role() = 'admin'
    or (public.app_role() = 'viewer' and created_by = auth.uid())
  )
  with check (
    public.app_role() = 'admin'
    or (public.app_role() = 'viewer' and created_by = auth.uid())
  );
-- Deleting stays with the admin ("machines: admin delete" in schema.sql).

-- 3. Make the owner account the only admin. The owner is matched by the
--    SHA-256 of its email (same value as OWNER_ID in js/config.js), so the
--    address is not written in this public file. If no account matches,
--    this step stops with an error and changes no roles.
do $$
declare
  owner_id constant text := 'f40b7cb7749f58d5e767e5e32d98866c3fed1400f1792045447e9fdf16d09379';
begin
  if not exists (
    select 1 from public.profiles
    where encode(sha256(convert_to(lower(trim(email)), 'UTF8')), 'hex') = owner_id
  ) then
    raise exception 'No account with the owner email was found. Roles were not changed.';
  end if;

  update public.profiles set role = 'admin'
   where encode(sha256(convert_to(lower(trim(email)), 'UTF8')), 'hex') = owner_id;

  update public.profiles set role = 'viewer'
   where role = 'admin'
     and encode(sha256(convert_to(lower(trim(coalesce(email, ''))), 'UTF8')), 'hex') <> owner_id;
end;
$$;

-- 4. Show who added each machine. Each account gets a display name (the admin can
--    change it under Users); without one, the part of the email before "@" is shown.
alter table public.profiles add column if not exists name text not null default '';

-- Names of approved accounts, for the "Added by" column. Emails are not exposed.
create or replace function public.people()
returns table (id uuid, name text)
language sql
stable
security definer
set search_path = public
as $$
  select p.id, coalesce(nullif(trim(p.name), ''), split_part(coalesce(p.email, ''), '@', 1))
  from public.profiles p
  where public.app_role() in ('admin', 'viewer');
$$;
revoke all on function public.people() from public, anon;
grant execute on function public.people() to authenticated;

-- 5. Everything in the list so far was entered by the owner (Andry)
do $$
declare
  owner_id constant text := 'f40b7cb7749f58d5e767e5e32d98866c3fed1400f1792045447e9fdf16d09379';
  owner_uid uuid;
begin
  select id into owner_uid from public.profiles
   where encode(sha256(convert_to(lower(trim(email)), 'UTF8')), 'hex') = owner_id
   limit 1;
  update public.profiles set name = 'Andry' where id = owner_uid and name = '';
  -- touch_machine() would stamp "last changed" on every row, so switch it off for this one update
  alter table public.machines disable trigger machines_touch;
  update public.machines set created_by = owner_uid where created_by is null;
  alter table public.machines enable trigger machines_touch;
end;
$$;

-- 6. Machines added by a viewer wait for the admin's approval
alter table public.machines add column if not exists status text not null default 'approved';
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'machines_status_check') then
    alter table public.machines add constraint machines_status_check check (status in ('approved', 'pending'));
  end if;
end;
$$;

-- Only the admin decides the status: a viewer's new machine is always "pending",
-- and a viewer's edit can never change the status.
create or replace function public.guard_machine_status()
returns trigger
language plpgsql
as $$
begin
  if auth.uid() is not null and public.app_role() is distinct from 'admin' then
    if tg_op = 'INSERT' then
      new.status := 'pending';
    else
      new.status := old.status;
      new.created_by := old.created_by;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists machines_guard_status on public.machines;
create trigger machines_guard_status
  before insert or update on public.machines
  for each row execute function public.guard_machine_status();

-- Viewers see approved machines plus their own waiting ones; the admin sees everything
drop policy if exists "machines: approved users read" on public.machines;
create policy "machines: approved users read" on public.machines
  for select to authenticated
  using (
    public.app_role() = 'admin'
    or (public.app_role() = 'viewer' and (status = 'approved' or created_by = auth.uid()))
  );

notify pgrst, 'reload schema';
