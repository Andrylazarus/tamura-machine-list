-- =====================================================================
-- Tamura Machine List — add the Brand column
-- Run this once in Supabase: Dashboard → SQL Editor → New query → Run.
-- Safe to run again; it changes nothing the second time.
-- =====================================================================

alter table public.machines add column if not exists brand text not null default '';

-- Fill in the brand of the machines already in the list, from the model name
update public.machines
   set brand = 'Koh Young'
 where brand = ''
   and model ~* '(koh\s*young|zenith|meister|neptune|aspire|\mky\s*-?\s*\d)';

update public.machines
   set brand = 'Tamura'
 where brand = ''
   and model ~* 'tamura';

create index if not exists machines_brand_idx on public.machines (brand);

-- Make the new column visible to the app straight away
notify pgrst, 'reload schema';
