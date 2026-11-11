# Tamura Machine List

A web app for the SPI, AOI and Review machines installed at each customer. It tracks serial numbers, software versions, calibration dates and PC specifications. You can add machines by uploading an Excel file or typing them in, and export the list back to Excel.

- **Login required.** Accounts are by invitation only and there is no public sign-up.
- **Roles:**
  - **Admin:** add, edit, delete, import and manage users.
  - **Viewer:** look and export only.
  - **Pending:** a new account that hasn't been approved yet. It sees nothing.
- **Hosting:** the site runs on GitHub Pages (free). The data and logins are in [Supabase](https://supabase.com) (free tier).
- **Protection:** the database blocks every unauthorised read or write itself (Row Level Security), so the rules hold even if someone calls the database directly.

```
index.html           page layout (login screens + app)
styles.css           design
js/config.js         ← your Supabase URL and anon key go here
js/parser.js         reads Excel sheets into machine records
js/app.js            login, list, edit, import, export, users
supabase/schema.sql  database tables + security rules (run once)
supabase/brand.sql   adds the Brand column to a database made before it existed (run once)
```

---

## Setup (about 20 minutes)

### 1. Create the Supabase project
1. Sign up at <https://supabase.com> and click **New project**. Pick a region close to you, for example *Southeast Asia (Singapore)*, and save the database password somewhere safe.
2. When the project is ready, open **SQL Editor → New query**. Paste in all of `supabase/schema.sql` and click **Run**. It should say *Success*.

### 2. Lock down sign-ups
1. Go to **Authentication → Sign In / Providers**.
2. Turn **off** "Allow new users to sign up". Invitations still work.
3. Keep **Email** enabled.

### 3. Put the site on GitHub Pages
1. Push this folder to a GitHub repository, then open **Settings → Pages** in that repository.
2. Under **Source**, choose **Deploy from a branch**, then pick `main` and `/ (root)`. Click **Save**.
3. After a minute the site is live at `https://<your-username>.github.io/<repo-name>/`.

### 4. Connect the site to Supabase
1. In Supabase, open **Project Settings → API**. Copy the **Project URL** and the **anon public** key.
2. Paste both into `js/config.js`, then commit and push.
   - Never use the `service_role` key. It bypasses all security.
   - The anon key is designed to be public, so it is safe in a public repo. The security rules are what protect the data.
3. In Supabase, open **Authentication → URL Configuration**:
   - **Site URL:** your GitHub Pages address, for example `https://andry.github.io/tamura-machine-list/`.
   - **Redirect URLs:** add the same address.
   - These settings make invitation and password-reset emails link to your site.

### 5. Create the first admin (you)
1. In Supabase, open **Authentication → Users → Invite user** and enter your own email.
2. Open the email, click the link, and set your password on the site.
3. You will see "Waiting for approval". Make yourself admin by running this in the **SQL Editor**:
   ```sql
   update public.profiles set role = 'admin' where email = 'you@example.com';
   ```
4. Click **Check again** on the site. You're in.

### 6. Load the machine list
In the app, click **Upload Excel** and choose `Tamura_Machine_List.xlsx`. Each sheet becomes a customer and all 142 machines are imported.

---

## Adding people
1. In Supabase, open **Authentication → Users → Invite user** and enter their email.
2. They click the link in the email and choose a password. They then appear in the app under **Users** as `pending`.
3. In the app, open **Users** and set them to `viewer` or `admin`.

To remove someone's access, set them back to `pending`, or delete the user in Supabase.

## Excel import rules
- Each sheet is one customer, named after the sheet. You can rename the customer in the preview before importing.
- Columns are recognised by their header names: *Brand / Maker*, *Kind / Machine*, *Model / Type*, *Line*, *Serial Number*, *Manufactured Year*, *Current Version*, *Last calibration*, *Next Calibration*, *IP Address*, *OS*, *PC Model*, *Memory*, *VGA*, *Customer*, *Location*, *Check By*, *Notes*.
- Two-row headers, like a merged "PC Specifications" header, are supported.
- Machines are matched by **customer + serial number**. Re-importing updates them instead of creating duplicates.
- **Replace these customers** mode also deletes machines that are missing from the file.
- Text in a date column, such as "PZT Change", is kept in Notes.
- **Template** downloads an empty file in the right format. **Export Excel** downloads exactly what is currently filtered.

## Calibration status
The app uses the *next calibration* date. If that is empty, it estimates last calibration + 1 year and labels the result "(est.)".
- **Overdue:** the date has passed.
- **Due in 30 days:** the date is within the next 30 days.
- **No date:** neither date is filled in.

## Backups
Supabase's free tier keeps the data but does not give you point-in-time restore. Use **Export Excel** regularly, or download a backup from **Database → Backups** on a paid plan.

## Notes
- Free Supabase projects **pause after 7 days without activity**. Restore them with one click in the dashboard. Upgrade the plan if the app is used daily.
- Don't commit Excel files with real data to this repo. `.gitignore` already blocks `*.xlsx`.

---

## Calibration report builder

`calibration/index.html` is the Customer Service Report builder for calibration visits. It is generated from the private `tamura-calibration-report` repository; edit it there and copy the built file here.

- Open it at `https://<your-username>.github.io/tamura-machine-list/calibration/`, or with the **Calibration report** button in the app header.
- It uses the same logins and roles. Approved users (admin, viewer) can use it, and `pending` accounts see nothing.
- The customer list and each engineer's signature are stored in Supabase (`cal_customers`, `cal_engineers`) and load only after login. The file itself contains no customer data or signatures.
- Calibration data from the machine folder is read in the browser only. Nothing is uploaded.
- The tables are created by `supabase/calibration.sql` in the private `tamura-calibration-report` repository. Run it once in the SQL Editor.

---

## Transport claim report

`transport/index.html` is the weekly Transport Claim Report: tolls, fuel and odometer per workday, exported as `.xlsx` in the usual report layout.

- Open it at `https://<your-username>.github.io/tamura-machine-list/transport/`, or with the **Transport claim** button in the app header.
- It uses the same logins. Approved users (admin, viewer) can use it, and `pending` accounts see nothing.
- Each person's reports, toll routes and replacement days are stored in Supabase (`transport_docs`) and are private to that person. Admins can't see other people's claims either.
- The file itself contains no personal data. The first time, tap **Restore** and choose a backup file to load your replacement day list and earlier weeks.
- **Backup** downloads everything as a `.json` file.
- The table is created by `supabase/transport.sql`. Run it once in the SQL Editor.

---

## Team task board

`tasks/index.html` is a shared task board for the service team: customer visits, calibrations, training, reports and anything else that needs following up.

- Open it at `https://<your-username>.github.io/tamura-machine-list/tasks/`, or with the **Team tasks** button in the app header.
- It uses the same logins. Approved users (admin, viewer) can add tasks, assign them, move them between **To do**, **In progress**, **Waiting / follow-up** and **Done**, and post follow-up notes. `pending` accounts see nothing.
- A task can be deleted only by the person who created it or by an admin. A note can be deleted by its author or an admin.
- Tasks can be assigned to anyone with an approved account, or to a typed-in name for someone without a login.
- Changes from teammates appear live.
- **Activities** are scheduled items without a deadline, like a customer visit, training or meeting. They have a date and an optional start and end time. Tasks and activities are kept apart: the task board has only tasks, and the schedule page has only activities.
- **Schedule page** (`schedule/index.html`, at `https://<your-username>.github.io/tamura-machine-list/schedule/`): activities only, listed day by day: today, tomorrow, and onward. The morning email starts with the week's schedule (today + 6 days).
- Both pages share `tasks/board.css` and `tasks/board.js`. The `data-page` attribute on `<body>` picks the page.
- A task with a due date has an **Add to Google Calendar** link, so each person can put their own reminder in their calendar.
- The tables are created by `supabase/tasks.sql`. Run it once in the SQL Editor.

### Daily task email (06:00)

Every morning at 06:00 WIB, GitHub runs `scripts/daily-tasks.mjs` (`.github/workflows/daily-tasks.yml`). Each person with an approved account gets one email listing their **To do** and **In progress** tasks. Tasks due within 2 days, or overdue, are flagged at the top. People with no open tasks get no email. A task assigned to someone without a login goes to the person who created it. GitHub's own timer is unreliable, so Supabase starts the job at 06:00 sharp. Set it up once with `supabase/daily-email-cron.sql`, using a GitHub fine-grained token for this repository with **Actions: Read and write**. GitHub's timer still runs at about 06:20 as a backup, and the job never sends the daily email twice on the same day.

Setup, once:
1. Create a Gmail **app password** for the sending account: Google Account → Security → 2-Step Verification → App passwords.
2. In this repository, open **Settings → Secrets and variables → Actions → New repository secret** and add:
   - `SUPABASE_SERVICE_ROLE_KEY`: from Supabase → Project Settings → API Keys → a **Secret** key (`sb_secret_…`), or the legacy `service_role` key. It stays secret in GitHub and is never in the website code.
   - `SMTP_USER`: the Gmail address that sends the emails.
   - `SMTP_PASS`: the app password from step 1.
   - `REMINDER_CC` (optional): addresses that get the whole team's list every morning, separated by commas, for example a supervisor or team mailbox.
3. Test it: **Actions → Daily task email → Run workflow**. With *dry run* ticked, it only lists who would get an email. Untick it to really send.

To change the time, edit the `cron` line in the workflow file. It is in UTC, so 06:00 WIB is `0 23 * * *` (23:00 UTC the day before). To change what counts as "due soon", edit `DUE_SOON_DAYS`.
