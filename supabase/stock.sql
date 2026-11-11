-- =====================================================================
-- Tamura stock: machines and spare parts kept in stock, by brand and machine model
-- Run this once in Supabase: Dashboard → SQL Editor → New query → Run.
-- Run it after schema.sql and permissions.sql. Safe to run again.
--
--   admin  : sees, adds, edits and deletes everything
--   viewer : sees everything, adds items, and edits the items that account added
-- =====================================================================

create table if not exists public.stock_items (
  id         uuid primary key default gen_random_uuid(),
  kind       text not null default 'part' check (kind in ('machine', 'part')),
  brand      text not null default '' check (char_length(brand) <= 80),
  model      text not null default '' check (char_length(model) <= 120),   -- the machine model (for a part: the machine it fits)
  name       text not null check (char_length(name) between 1 and 160),    -- item name
  part_no    text not null default '' check (char_length(part_no) <= 80),  -- part number, or serial number for a machine
  qty        integer not null default 0 check (qty >= 0),
  unit       text not null default 'pcs' check (char_length(unit) <= 20),
  min_qty    integer not null default 0 check (min_qty >= 0),              -- at or below this the item shows as "low stock"
  location   text not null default '' check (char_length(location) <= 120),
  condition  text not null default '' check (char_length(condition) <= 40),
  notes      text not null default '' check (char_length(notes) <= 2000),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null default auth.uid()
);

create index if not exists stock_items_brand_idx on public.stock_items (brand);

-- Keep "last changed" current and never let a client rewrite who added an item
create or replace function public.touch_stock_item()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  new.created_by := old.created_by;
  new.created_at := old.created_at;
  return new;
end;
$$;

drop trigger if exists stock_items_touch on public.stock_items;
create trigger stock_items_touch
  before update on public.stock_items
  for each row execute function public.touch_stock_item();

alter table public.stock_items enable row level security;

drop policy if exists "stock: approved read" on public.stock_items;
create policy "stock: approved read" on public.stock_items
  for select to authenticated
  using (public.app_role() in ('admin', 'viewer'));

drop policy if exists "stock: approved insert" on public.stock_items;
create policy "stock: approved insert" on public.stock_items
  for insert to authenticated
  with check (public.app_role() = 'admin' or (public.app_role() = 'viewer' and created_by = auth.uid()));

drop policy if exists "stock: admin or creator update" on public.stock_items;
create policy "stock: admin or creator update" on public.stock_items
  for update to authenticated
  using (public.app_role() = 'admin' or (public.app_role() = 'viewer' and created_by = auth.uid()))
  with check (public.app_role() = 'admin' or (public.app_role() = 'viewer' and created_by = auth.uid()));

drop policy if exists "stock: admin delete" on public.stock_items;
create policy "stock: admin delete" on public.stock_items
  for delete to authenticated
  using (public.app_role() = 'admin');

revoke all on public.stock_items from anon;
grant select, insert, update, delete on public.stock_items to authenticated;

-- Live updates in the browser when someone else changes the stock
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables
                     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'stock_items') then
    alter publication supabase_realtime add table public.stock_items;
  end if;
end;
$$;

notify pgrst, 'reload schema';
