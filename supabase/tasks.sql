-- Team task board: shared tasks and their follow-up notes.
-- Approved users (admin, viewer) can see, add and update every task and post follow-up notes.
-- A task can be deleted by the person who created it or by an admin.
-- Run once in Supabase → SQL Editor, after schema.sql.

create table if not exists public.tasks (
  id             uuid primary key default gen_random_uuid(),
  num            bigint generated always as identity,
  title          text not null check (char_length(title) between 1 and 160),
  details        text not null default '' check (char_length(details) <= 4000),
  status         text not null default 'todo' check (status in ('todo', 'progress', 'waiting', 'done')),
  priority       text not null default 'medium' check (priority in ('high', 'medium', 'low')),
  due            date,
  category       text not null default 'Other' check (char_length(category) <= 60),
  customer       text not null default '' check (char_length(customer) <= 120),
  assignee       uuid references auth.users (id) on delete set null,
  assignee_label text not null default '' check (char_length(assignee_label) <= 80),
  done_at        timestamptz,
  created_at     timestamptz not null default now(),
  created_by     uuid references auth.users (id) on delete set null default auth.uid(),
  updated_at     timestamptz not null default now(),
  updated_by     uuid references auth.users (id) on delete set null default auth.uid()
);

create table if not exists public.task_notes (
  id         uuid primary key default gen_random_uuid(),
  task_id    uuid not null references public.tasks (id) on delete cascade,
  body       text not null check (char_length(body) between 1 and 2000),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null default auth.uid()
);

create index if not exists task_notes_task_idx on public.task_notes (task_id);

-- Keep updated_at / updated_by / done_at current, and never let a client rewrite who created a task
create or replace function public.touch_task()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  new.created_by := old.created_by;
  new.created_at := old.created_at;
  if new.status = 'done' and old.status <> 'done' then new.done_at := now(); end if;
  if new.status <> 'done' then new.done_at := null; end if;
  return new;
end;
$$;

drop trigger if exists tasks_touch on public.tasks;
create trigger tasks_touch
  before update on public.tasks
  for each row execute function public.touch_task();

-- People who can be assigned a task (approved users only). Lets viewers pick a teammate
-- without opening the profiles table, which stays admin-only.
create or replace function public.team_members()
returns table (id uuid, email text)
language sql
stable
security definer
set search_path = public
as $$
  select p.id, p.email from public.profiles p
  where p.role in ('admin', 'viewer')
    and public.app_role() in ('admin', 'viewer')
  order by p.email;
$$;
revoke all on function public.team_members() from public, anon;
grant execute on function public.team_members() to authenticated;

-- ---------- Security rules ----------
alter table public.tasks enable row level security;
alter table public.task_notes enable row level security;

drop policy if exists "tasks: approved read" on public.tasks;
create policy "tasks: approved read" on public.tasks
  for select to authenticated using (public.app_role() in ('admin', 'viewer'));

drop policy if exists "tasks: approved insert" on public.tasks;
create policy "tasks: approved insert" on public.tasks
  for insert to authenticated
  with check (public.app_role() in ('admin', 'viewer') and created_by = auth.uid());

drop policy if exists "tasks: approved update" on public.tasks;
create policy "tasks: approved update" on public.tasks
  for update to authenticated
  using (public.app_role() in ('admin', 'viewer'))
  with check (public.app_role() in ('admin', 'viewer'));

drop policy if exists "tasks: creator or admin delete" on public.tasks;
create policy "tasks: creator or admin delete" on public.tasks
  for delete to authenticated
  using (public.app_role() = 'admin' or (public.app_role() = 'viewer' and created_by = auth.uid()));

drop policy if exists "task notes: approved read" on public.task_notes;
create policy "task notes: approved read" on public.task_notes
  for select to authenticated using (public.app_role() in ('admin', 'viewer'));

drop policy if exists "task notes: post as yourself" on public.task_notes;
create policy "task notes: post as yourself" on public.task_notes
  for insert to authenticated
  with check (public.app_role() in ('admin', 'viewer') and created_by = auth.uid());

drop policy if exists "task notes: author or admin delete" on public.task_notes;
create policy "task notes: author or admin delete" on public.task_notes
  for delete to authenticated
  using (public.app_role() = 'admin' or created_by = auth.uid());

revoke all on public.tasks from anon;
revoke all on public.task_notes from anon;

-- Live updates when a teammate changes something
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'tasks') then
      alter publication supabase_realtime add table public.tasks;
    end if;
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'task_notes') then
      alter publication supabase_realtime add table public.task_notes;
    end if;
  end if;
end;
$$;

