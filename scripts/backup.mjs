// Weekly backup: copies every table of the site out of Supabase and emails it as attachments.
//   tamura-backup-YYYY-MM-DD.json.gz  everything, table by table (for restoring)
//   attendance-YYYY-MM-DD.csv         all attendance, opens in Excel
//   daily-report-YYYY-MM-DD.csv       all daily report activities, opens in Excel
// Nothing is written to the repository (it is public); the files only go to the email address(es).
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import nodemailer from "nodemailer";

const env = process.env;
const DRY = env.DRY_RUN === "true";
const config = readFileSync(new URL("../js/config.js", import.meta.url), "utf8");
const SUPABASE_URL = env.SUPABASE_URL || (config.match(/SUPABASE_URL:\s*"([^"]+)"/) || [])[1];
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const TO = (env.BACKUP_TO || env.SMTP_USER || "").trim();

function need(name, value) { if (!value) { console.error(`Missing ${name}. Add it under Settings → Secrets and variables → Actions.`); process.exit(1); } }
need("SUPABASE_SERVICE_ROLE_KEY", KEY);
need("SUPABASE_URL", SUPABASE_URL);
if (!DRY) { need("SMTP_USER", env.SMTP_USER); need("SMTP_PASS", env.SMTP_PASS); need("BACKUP_TO", TO); }

const TABLES = ["profiles", "machines", "stock_items", "daily_reports", "attendance", "tasks", "task_notes",
                "transport_docs", "cal_customers", "cal_engineers", "cal_assets"];
const headers = KEY.startsWith("sb_") ? { apikey: KEY } : { apikey: KEY, Authorization: `Bearer ${KEY}` };

// Read a whole table, 1000 rows at a time
async function readAll(table) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=*`, { headers: { ...headers, Range: `${from}-${from + 999}`, "Range-Unit": "items" } });
    if (r.status === 404 || r.status === 400) return null;            // table not set up in this project
    if (!r.ok && r.status !== 206) throw new Error(`${table}: ${r.status} ${await r.text()}`);
    const page = await r.json();
    rows.push(...page);
    if (page.length < 1000) return rows;
  }
}

const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(new Date());
const backup = { app: "Tamura Machine List", created: new Date().toISOString(), tables: {} };
const counts = [];
for (const t of TABLES) {
  try {
    const rows = await readAll(t);
    if (rows === null) { counts.push([t, "not set up"]); continue; }
    backup.tables[t] = rows; counts.push([t, rows.length]);
  } catch (e) { counts.push([t, "FAILED: " + e.message]); console.error(e.message); }
}
console.table(counts.map(([table, rows]) => ({ table, rows })));
if (!Object.keys(backup.tables).length) { console.error("Nothing could be read. Check the service role key."); process.exit(1); }

// ---------- readable CSV files ----------
const names = {};
(backup.tables.profiles || []).forEach((p) => { names[p.id] = (p.name || "").trim() || String(p.email || "").split("@")[0]; });
const jkt = (ts) => ts ? new Date(ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Jakarta" }) : "";
const cell = (v) => { const s = String(v ?? ""); return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const csv = (head, rows) => "﻿" + [head, ...rows].map((r) => r.map(cell).join(",")).join("\r\n");
const byDate = (k) => (a, b) => String(a[k]).localeCompare(String(b[k]));

const attachments = [{ filename: `tamura-backup-${today}.json.gz`, content: gzipSync(JSON.stringify(backup)) }];
if (backup.tables.attendance) attachments.push({ filename: `attendance-${today}.csv`, content: csv(
  ["Date", "Engineer", "Attendance", "Customer", "Check in", "Check out", "Note"],
  [...backup.tables.attendance].sort(byDate("work_date")).map((a) => [a.work_date, names[a.user_id] || a.user_id, a.status, a.customer || "", jkt(a.check_in), jkt(a.check_out), a.note]))
});
if (backup.tables.daily_reports) attachments.push({ filename: `daily-report-${today}.csv`, content: csv(
  ["Date", "Engineer", "Start", "End", "Customer", "Location", "Type", "Machine", "What was done", "Status", "Next action"],
  [...backup.tables.daily_reports].sort(byDate("report_date")).map((d) => [d.report_date, names[d.created_by] || d.created_by || "", (d.start_time || "").slice(0, 5), (d.end_time || "").slice(0, 5),
    d.customer, d.location, d.activity_type, d.machine, d.description, d.status, d.next_action]))
});
const size = attachments.reduce((n, a) => n + Buffer.byteLength(a.content), 0);
console.log(`Attachments: ${attachments.map((a) => a.filename).join(", ")} (${(size / 1024).toFixed(0)} KB)`);

if (DRY) { console.log(`Dry run: would email ${TO || "(BACKUP_TO not set)"}`); process.exit(0); }

const rowsHtml = counts.map(([t, n]) => `<tr><td style="padding:3px 14px 3px 0">${t}</td><td style="padding:3px 0;text-align:right">${n}</td></tr>`).join("");
const mailer = nodemailer.createTransport({ host: env.SMTP_HOST || "smtp.gmail.com", port: Number(env.SMTP_PORT || 465), secure: true, auth: { user: env.SMTP_USER, pass: env.SMTP_PASS } });
await mailer.sendMail({
  from: `"Tamura Backup" <${env.SMTP_USER}>`, to: TO,
  subject: `Tamura Machine List backup ${today}`,
  html: `<div style="font-family:Arial,sans-serif;font-size:14px;color:#16202e">
    <p>Weekly backup of the Tamura Machine List database, ${today}.</p>
    <table style="font-size:13px;border-collapse:collapse">${rowsHtml}</table>
    <p style="color:#5d6b7e;font-size:12.5px">Keep these emails. The .json.gz file holds every table and can be used to restore the data.
    The two .csv files open directly in Excel.</p></div>`,
  attachments
});
console.log(`Emailed ${TO}`);
