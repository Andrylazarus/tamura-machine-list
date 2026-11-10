// Emails a reminder for every open task that is due within DAYS_BEFORE days (H-2 by default).
// Sends to the assigned person; if nobody with a login is assigned, to the person who created the task.
// Each task gets one reminder per due date (tracked in public.task_reminders).
import { readFileSync } from "node:fs";
import nodemailer from "nodemailer";

const env = process.env;
const DRY = env.DRY_RUN === "true";
const DAYS = Number(env.DAYS_BEFORE || 2);
const config = readFileSync(new URL("../js/config.js", import.meta.url), "utf8");
const SUPABASE_URL = env.SUPABASE_URL || (config.match(/SUPABASE_URL:\s*"([^"]+)"/) || [])[1];
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const BOARD_URL = env.BOARD_URL || "https://andrylazarus.github.io/tamura-machine-list/tasks/";

function need(name, value) { if (!value) { console.error(`Missing ${name}. Add it under Settings → Secrets and variables → Actions.`); process.exit(1); } }
need("SUPABASE_SERVICE_ROLE_KEY", KEY);
need("SUPABASE_URL", SUPABASE_URL);
if (!DRY) { need("SMTP_USER", env.SMTP_USER); need("SMTP_PASS", env.SMTP_PASS); }

async function api(path, init = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", ...(init.headers || {}) }
  });
  if (!r.ok) throw new Error(`${init.method || "GET"} ${path}: ${r.status} ${await r.text()}`);
  return r.status === 204 || r.status === 201 ? null : r.json();
}

// Today's date in Jakarta
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(new Date());
const dayNum = (s) => Date.UTC(...s.split("-").map((x, i) => Number(x) - (i === 1 ? 1 : 0))) / 86400000;
const fmt = (s) => new Date(s + "T00:00:00Z").toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const code = (t) => "TSK-" + String(t.num).padStart(3, "0");
const PRI = { high: "High", medium: "Medium", low: "Low" };
const STATUS = { todo: "To do", progress: "In progress", waiting: "Waiting / follow-up" };

const [tasks, profiles, sent] = await Promise.all([
  api("tasks?select=*&status=neq.done&due=not.is.null"),
  api("profiles?select=id,email,role"),
  api("task_reminders?select=task_id,due")
]);
const emailOf = Object.fromEntries(profiles.filter((p) => p.email && p.role !== "pending").map((p) => [p.id, p.email]));
const already = new Set(sent.map((s) => s.task_id + "|" + s.due));

const due = tasks.filter((t) => {
  const left = dayNum(t.due) - dayNum(today);
  return left >= 0 && left <= DAYS && !already.has(t.id + "|" + t.due);
});
console.log(`${today}: ${due.length} task(s) need a reminder${DRY ? " (dry run, nothing is sent)" : ""}.`);

const mailer = DRY ? null : nodemailer.createTransport({
  host: env.SMTP_HOST || "smtp.gmail.com", port: Number(env.SMTP_PORT || 465), secure: true,
  auth: { user: env.SMTP_USER, pass: env.SMTP_PASS }
});

let failed = 0;
for (const t of due) {
  const left = dayNum(t.due) - dayNum(today);
  const to = emailOf[t.assignee] || emailOf[t.created_by];
  const cc = (env.REMINDER_CC || "").split(",").map((s) => s.trim()).filter(Boolean).filter((e) => e !== to);
  if (!to && !cc.length) { console.log(`- ${code(t)} skipped: nobody with an email to send to.`); continue; }
  const when = left === 0 ? "due TODAY" : left === 1 ? "due tomorrow" : `due in ${left} days`;
  const subject = `[Reminder] ${code(t)} ${when}: ${t.title}`;
  const who = t.assignee ? (emailOf[t.assignee] || "") : (t.assignee_label || "Unassigned");
  const rows = [
    ["Due date", fmt(t.due)], ["Status", STATUS[t.status] || t.status], ["Priority", PRI[t.priority] || t.priority],
    ["Assigned to", who], ["Customer / location", t.customer], ["Category", t.category]
  ].filter(([, v]) => v);
  const html = `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#16202e;max-width:560px">
  <p style="margin:0 0 4px;font-size:12px;color:#5d6b7e;letter-spacing:.08em;text-transform:uppercase">PT. Tamura Trade Indonesia · Team Task Board</p>
  <h2 style="margin:0 0 12px;font-size:18px">${esc(t.title)}</h2>
  <p style="margin:0 0 14px;padding:8px 12px;border-left:4px solid ${left === 0 ? "#c2412d" : "#b7791f"};background:#f6f8fb"><b>${esc(code(t))} is ${esc(when)}.</b></p>
  <table style="border-collapse:collapse;margin-bottom:14px">${rows.map(([k, v]) => `<tr><td style="padding:4px 16px 4px 0;color:#5d6b7e">${esc(k)}</td><td style="padding:4px 0"><b>${esc(v)}</b></td></tr>`).join("")}</table>
  ${t.details ? `<p style="white-space:pre-wrap;margin:0 0 14px">${esc(t.details)}</p>` : ""}
  <p><a href="${esc(BOARD_URL)}" style="background:#1f56c9;color:#fff;padding:9px 16px;border-radius:6px;text-decoration:none;font-weight:600">Open the task board</a></p>
  <p style="font-size:12px;color:#5d6b7e">Automatic reminder sent ${DAYS} days before the due date. Update the task on the board when it's done.</p></div>`;
  const text = `${code(t)} is ${when}: ${t.title}\n\n${rows.map(([k, v]) => `${k}: ${v}`).join("\n")}\n\n${t.details || ""}\n\nOpen the task board: ${BOARD_URL}`;

  if (DRY) { console.log(`- ${code(t)} → ${to || "(none)"}${cc.length ? " cc " + cc.join(", ") : ""}: ${subject}`); continue; }
  try {
    await mailer.sendMail({ from: `"Tamura Task Board" <${env.SMTP_USER}>`, to: to || cc[0], cc: to ? cc : cc.slice(1), subject, text, html });
    await api("task_reminders", { method: "POST", headers: { Prefer: "resolution=ignore-duplicates" }, body: JSON.stringify({ task_id: t.id, due: t.due }) });
    console.log(`- ${code(t)} sent to ${to || cc[0]}`);
  } catch (e) { failed++; console.error(`- ${code(t)} FAILED: ${e.message}`); }
}
if (failed) process.exit(1);
