-- =====================================================================
-- Tamura Machine List — who may change what
-- Run this once in Supabase: Dashboard → SQL Editor → New query → Run.
-- Safe to run again.
--
--   admin  (the owner account only): sees and edits everything, deletes,
--          imports Excel, manages users
--   viewer (every other approved account): sees everything, adds machines,
--          and edits only the machines that account added itself
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

notify pgrst, 'reload schema';
