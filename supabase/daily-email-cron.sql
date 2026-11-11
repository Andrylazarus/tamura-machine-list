-- Starts the "Daily task email" GitHub job at exactly 06:00 WIB every day.
-- GitHub's own scheduler sometimes skips or delays jobs, so Supabase triggers it instead.
-- Run once in Supabase → SQL Editor. Replace PASTE_GITHUB_TOKEN_HERE with your GitHub token first.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- One row per day an email went out (stops double sending if both timers fire)
create table if not exists public.daily_email_runs (
  day     date primary key,
  sent_at timestamptz not null default now()
);
alter table public.daily_email_runs enable row level security;
revoke all on public.daily_email_runs from anon, authenticated;

-- Store the GitHub token safely in Supabase Vault (replaces it if you run this again)
do $$
declare existing uuid;
begin
  select id into existing from vault.secrets where name = 'github_dispatch_token';
  if existing is null then
    perform vault.create_secret('PASTE_GITHUB_TOKEN_HERE', 'github_dispatch_token');
  else
    perform vault.update_secret(existing, 'PASTE_GITHUB_TOKEN_HERE');
  end if;
end;
$$;

-- 23:00 UTC = 06:00 WIB (Jakarta)
select cron.unschedule('daily-task-email') where exists (select 1 from cron.job where jobname = 'daily-task-email');
select cron.schedule(
  'daily-task-email',
  '0 23 * * *',
  $job$
  select net.http_post(
    url := 'https://api.github.com/repos/Andrylazarus/tamura-machine-list/actions/workflows/daily-tasks.yml/dispatches',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'github_dispatch_token'),
      'Accept', 'application/vnd.github+json',
      'X-GitHub-Api-Version', '2022-11-28',
      'User-Agent', 'tamura-supabase-cron',
      'Content-Type', 'application/json'
    ),
    body := '{"ref":"main","inputs":{"dry_run":"false","scheduled":"true"}}'::jsonb
  );
  $job$
);

-- Check: select * from cron.job;  and after 06:00: select * from net._http_response order by created desc limit 5;  (201 or 204 = OK)
