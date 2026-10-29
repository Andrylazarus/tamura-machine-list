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
- Columns are recognised by their header names: *Kind / Machine*, *Model / Type*, *Line*, *Serial Number*, *Manufactured Year*, *Current Version*, *Last calibration*, *Next Calibration*, *IP Address*, *OS*, *PC Model*, *Memory*, *VGA*, *Customer*, *Location*, *Check By*, *Notes*.
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
