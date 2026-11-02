-- Transport claim report: one row per saved item, private to each user.
-- Keys: 'settings' (toll routes and prices), 'extra' (replacement days, calibration and Tamura claims),
--       'week:YYYY-MM-DD' (one weekly report, keyed by its Monday).
-- Run once in Supabase → SQL Editor, after schema.sql.

create table if not exists public.transport_docs (
  user_id    uuid        not null default auth.uid() references auth.users(id) on delete cascade,
  key        text        not null check (char_length(key) between 1 and 100),
  data       jsonb       not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, key)
);

alter table public.transport_docs enable row level security;

-- Approved users (admin or viewer) read and write only their own rows.
-- Nobody, admins included, can see another person's transport claims.
drop policy if exists "transport: own rows" on public.transport_docs;
create policy "transport: own rows" on public.transport_docs
  for all to authenticated
  using (user_id = auth.uid() and public.app_role() in ('admin', 'viewer'))
  with check (user_id = auth.uid() and public.app_role() in ('admin', 'viewer'));
