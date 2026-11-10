// Morning task email (06:00 WIB). Each approved user gets their own To do and In progress tasks,
// with tasks due within DUE_SOON_DAYS days (H-2) flagged at the top. Tasks with no login assigned
// go to the person who created them. REMINDER_CC (optional) gets the whole team's list.
import { readFileSync } from "node:fs";
import nodemailer from "nodemailer";

const env = process.env;
const DRY = env.DRY_RUN === "true";
const SOON = Number(env.DUE_SOON_DAYS || 2);
const config = readFileSync(new URL("../js/config.js", import.meta.url), "utf8");
const SUPABASE_URL = env.SUPABASE_URL || (config.match(/SUPABASE_URL:\s*"([^"]+)"/) || [])[1];
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const BOARD_URL = env.BOARD_URL || "https://andrylazarus.github.io/tamura-machine-list/tasks/";

function need(name, value) { if (!value) { console.error(`Missing ${name}. Add it under Settings → Secrets and variables → Actions.`); process.exit(1); } }
need("SUPABASE_SERVICE_ROLE_KEY", KEY);
need("SUPABASE_URL", SUPABASE_URL);
if (!DRY) { need("SMTP_USER", env.SMTP_USER); need("SMTP_PASS", env.SMTP_PASS); }

async function api(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
  if (!r.ok) throw new Error(`GET ${path}: ${r.status} ${await r.text()}`);
  return r.json();
}

const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(new Date());
const dayNum = (s) => Date.UTC(...s.split("-").map((x, i) => Number(x) - (i === 1 ? 1 : 0))) / 86400000;
const left = (t) => (t.due ? dayNum(t.due) - dayNum(today) : null);
const short = (s) => new Date(s + "T00:00:00Z").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
const longDate = new Date(today + "T00:00:00Z").toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const code = (t) => "TSK-" + String(t.num).padStart(3, "0");
const PRI = { high: "High", medium: "Medium", low: "Low" };
const name = (email) => (email || "").split("@")[0].replace(/[._-]+/g, " ").replace(/\d+/g, " ").trim().split(/\s+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ") || email;

function dueText(t) {
  const n = left(t);
  if (n == null) return "No due date";
  if (n < 0) return `OVERDUE ${-n} day${n === -1 ? "" : "s"} (${short(t.due)})`;
  if (n === 0) return "Due TODAY";
  if (n === 1) return "Due tomorrow";
  return `Due ${short(t.due)}`;
}
const urgent = (t) => { const n = left(t); return n != null && n <= SOON; };
const sortTasks = (a, b) => (a.due || "9999").localeCompare(b.due || "9999") || ({ high: 0, medium: 1, low: 2 }[a.priority] - { high: 0, medium: 1, low: 2 }[b.priority]);

const [tasks, profiles] = await Promise.all([
  api("tasks?select=*&status=in.(todo,progress)"),
  api("profiles?select=id,email,role")
]);
const people = profiles.filter((p) => p.email && (p.role === "admin" || p.role === "viewer"));
const emailOf = Object.fromEntries(people.map((p) => [p.id, p.email]));
const ownerOf = (t) => (emailOf[t.assignee] ? t.assignee : emailOf[t.created_by] ? t.created_by : null);

function rowHtml(t, showWho) {
  const n = left(t);
  const color = n != null && n < 0 ? "#c2412d" : urgent(t) ? "#b7791f" : "#5d6b7e";
  const who = showWho ? (emailOf[t.assignee] ? name(emailOf[t.assignee]) : t.assignee_label || "Unassigned") : "";
  return `<tr><td style="padding:8px 10px;border-bottom:1px solid #e3e8ef;vertical-align:top;font-family:Consolas,monospace;font-size:12px;color:#5d6b7e;white-space:nowrap">${esc(code(t))}</td>
<td style="padding:8px 10px;border-bottom:1px solid #e3e8ef;vertical-align:top"><b>${esc(t.title)}</b>${t.customer ? `<br><span style="font-size:12px;color:#5d6b7e">${esc(t.customer)}</span>` : ""}${who ? `<br><span style="font-size:12px;color:#5d6b7e">${esc(who)}</span>` : ""}</td>
<td style="padding:8px 10px;border-bottom:1px solid #e3e8ef;vertical-align:top;white-space:nowrap;color:${color};font-weight:${urgent(t) ? 700 : 400}">${esc(dueText(t))}</td>
<td style="padding:8px 10px;border-bottom:1px solid #e3e8ef;vertical-align:top;font-size:12px">${esc(PRI[t.priority] || "")}</td></tr>`;
}
function section(title, list, showWho) {
  if (!list.length) return "";
  return `<h3 style="margin:20px 0 6px;font-size:15px">${esc(title)} <span style="color:#5d6b7e;font-weight:400">(${list.length})</span></h3>
<table style="border-collapse:collapse;width:100%;font-size:14px">${list.map((t) => rowHtml(t, showWho)).join("")}</table>`;
}
function textList(title, list, showWho) {
  if (!list.length) return "";
  return `\n${title} (${list.length})\n` + list.map((t) => `- ${code(t)} ${t.title} | ${dueText(t)}${showWho ? " | " + (emailOf[t.assignee] ? name(emailOf[t.assignee]) : t.assignee_label || "Unassigned") : ""}${t.customer ? " | " + t.customer : ""}`).join("\n") + "\n";
}
function buildEmail(greetName, list, showWho) {
  list = list.slice().sort(sortTasks);
  const soon = list.filter(urgent);
  const progress = list.filter((t) => t.status === "progress" && !urgent(t));
  const todo = list.filter((t) => t.status === "todo" && !urgent(t));
  const subject = `Tasks for ${short(today)}: ${list.length} open${soon.length ? `, ${soon.length} due soon` : ""}`;
  const html = `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#16202e;max-width:640px">
<p style="margin:0 0 4px;font-size:12px;color:#5d6b7e;letter-spacing:.08em;text-transform:uppercase">PT. Tamura Trade Indonesia · Team Task Board</p>
<h2 style="margin:0 0 4px;font-size:20px">Good morning${greetName ? ", " + esc(greetName) : ""}</h2>
<p style="margin:0;color:#5d6b7e">${esc(longDate)}</p>
${section(`⚠ Due within ${SOON} days or overdue`, soon, showWho)}
${section("In progress", progress, showWho)}
${section("To do", todo, showWho)}
<p style="margin:22px 0 8px"><a href="${esc(BOARD_URL)}" style="background:#1f56c9;color:#fff;padding:9px 16px;border-radius:6px;text-decoration:none;font-weight:600">Open the task board</a></p>
<p style="font-size:12px;color:#5d6b7e">Sent every morning at 06:00. Move tasks to Done on the board to drop them from this list.</p></div>`;
  const text = `Good morning${greetName ? ", " + greetName : ""}. ${longDate}\n` +
    textList(`DUE WITHIN ${SOON} DAYS OR OVERDUE`, soon, showWho) + textList("IN PROGRESS", progress, showWho) + textList("TO DO", todo, showWho) +
    `\nOpen the task board: ${BOARD_URL}\n`;
  return { subject, html, text };
}

const mailer = DRY ? null : nodemailer.createTransport({
  host: env.SMTP_HOST || "smtp.gmail.com", port: Number(env.SMTP_PORT || 465), secure: true,
  auth: { user: env.SMTP_USER, pass: env.SMTP_PASS }
});
async function send(to, mail) {
  if (DRY) { console.log(`- would email ${to}: ${mail.subject}`); return; }
  await mailer.sendMail({ from: `"Tamura Task Board" <${env.SMTP_USER}>`, to, ...mail });
  console.log(`- emailed ${to}: ${mail.subject}`);
}

console.log(`${today}: ${tasks.length} open task(s)${DRY ? " (dry run, nothing is sent)" : ""}.`);
let failed = 0;
for (const p of people) {
  const mine = tasks.filter((t) => ownerOf(t) === p.id);
  if (!mine.length) continue;
  try { await send(p.email, buildEmail(name(p.email), mine, false)); } catch (e) { failed++; console.error(`- ${p.email} FAILED: ${e.message}`); }
}
const cc = (env.REMINDER_CC || "").split(",").map((s) => s.trim()).filter(Boolean);
if (cc.length && tasks.length) {
  try { await send(cc.join(", "), buildEmail("team", tasks, true)); } catch (e) { failed++; console.error(`- team summary FAILED: ${e.message}`); }
}
if (failed) process.exit(1);
