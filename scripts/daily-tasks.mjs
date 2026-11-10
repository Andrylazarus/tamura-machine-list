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
const SCHEDULE_URL = BOARD_URL.replace(/tasks\/?$/, "schedule/");

function need(name, value) { if (!value) { console.error(`Missing ${name}. Add it under Settings → Secrets and variables → Actions.`); process.exit(1); } }
need("SUPABASE_SERVICE_ROLE_KEY", KEY);
need("SUPABASE_URL", SUPABASE_URL);
if (!DRY) { need("SMTP_USER", env.SMTP_USER); need("SMTP_PASS", env.SMTP_PASS); }

async function api(path) {
  // New-style keys (sb_secret_…) go in the apikey header only; legacy service_role JWTs also need Authorization.
  const headers = KEY.startsWith("sb_") ? { apikey: KEY } : { apikey: KEY, Authorization: `Bearer ${KEY}` };
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers });
  if (!r.ok) throw new Error(`GET ${path}: ${r.status} ${await r.text()}`);
  return r.json();
}

const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(new Date());
const WEEK_DAYS = 7;
const addDays = (d, n) => new Date(Date.parse(d + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
const weekEnd = addDays(today, WEEK_DAYS - 1);
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
  if (n < 0) return `Overdue ${-n} day${n === -1 ? "" : "s"}`;
  if (n === 0) return "Due TODAY";
  if (n === 1) return "Due tomorrow";
  return `Due ${short(t.due)}`;
}
const urgent = (t) => { const n = left(t); return n != null && n <= SOON; };
const RANK = { high: 0, medium: 1, low: 2 };
const PRI_COLOR = { high: "#c2412d", medium: "#b7791f", low: "#1d8a5b" };
// High priority first, then the nearest due date
const sortTasks = (a, b) => (RANK[a.priority] ?? 1) - (RANK[b.priority] ?? 1) || (a.due || "9999").localeCompare(b.due || "9999");

const [openRows, profiles, todayRows] = await Promise.all([
  api("tasks?select=*&status=in.(todo,progress)"),
  api("profiles?select=id,email,role"),
  api(`tasks?select=*&kind=eq.activity&due=gte.${today}&due=lte.${weekEnd}&order=due.asc,start_time.asc.nullsfirst`).catch((e) => { console.log("Could not read activities (run the activities part of supabase/tasks.sql): " + e.message.slice(0, 200)); return []; })
]);
const tasks = openRows.filter((t) => t.kind !== "activity");
const activities = todayRows;
const people = profiles.filter((p) => p.email && (p.role === "admin" || p.role === "viewer"));
const emailOf = Object.fromEntries(people.map((p) => [p.id, p.email]));
const ownerOf = (t) => (emailOf[t.assignee] ? t.assignee : emailOf[t.created_by] ? t.created_by : null);

const FONT = "font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;";
const C = { ink: "#14213d", muted: "#6b7689", line: "#e4e8ef", bg: "#f2f4f7", navy: "#0f2747", accent: "#1f56c9", red: "#c2412d", amber: "#b7791f", green: "#1d8a5b" };
const PRI_BG = { high: "#fdecea", medium: "#fdf3e1", low: "#e6f4ec" };

function rowHtml(t, showWho) {
  const n = left(t);
  const pc = PRI_COLOR[t.priority] || PRI_COLOR.medium;
  const dueColor = n != null && n < 0 ? C.red : urgent(t) ? C.amber : C.muted;
  const who = emailOf[t.assignee] ? name(emailOf[t.assignee]) : t.assignee_label || "Unassigned";
  const meta = [code(t), t.customer, showWho ? who : ""].filter(Boolean).map(esc).join(" &nbsp;·&nbsp; ");
  return `<tr>
<td width="4" bgcolor="${pc}" style="background:${pc};width:4px;font-size:0;line-height:0">&nbsp;</td>
<td style="padding:12px 14px;border-bottom:1px solid ${C.line};${FONT}">
  <div style="font-size:14px;font-weight:600;color:${C.ink};line-height:1.35">${esc(t.title)}</div>
  <div style="font-size:12px;color:${C.muted};padding-top:3px">${meta}</div>
</td>
<td width="92" align="center" valign="middle" style="padding:12px 6px;border-bottom:1px solid ${C.line};${FONT}">
  <span style="display:inline-block;padding:3px 8px;border-radius:4px;background:${PRI_BG[t.priority] || PRI_BG.medium};color:${pc};font-size:10px;font-weight:700;letter-spacing:.06em">${esc((PRI[t.priority] || "Medium").toUpperCase())}</span>
</td>
<td width="120" align="right" valign="middle" style="padding:12px 14px 12px 6px;border-bottom:1px solid ${C.line};${FONT}font-size:12.5px;color:${dueColor};font-weight:${urgent(t) ? 700 : 500};white-space:nowrap">${esc(dueText(t))}</td>
</tr>`;
}
function section(title, list, showWho, accent) {
  if (!list.length) return "";
  return `<tr><td style="padding:22px 28px 0">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse">
  <tr><td style="${FONT}font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:${accent || C.muted};padding-bottom:8px">${esc(title)} &nbsp;<span style="color:${C.muted};font-weight:500">${list.length}</span></td></tr>
</table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;border:1px solid ${C.line};border-radius:6px">
${list.map((t) => rowHtml(t, showWho)).join("")}
</table></td></tr>`;
}
const hm = (v) => (v || "").slice(0, 5);
const timeRange = (a) => (a.start_time ? hm(a.start_time) + (a.end_time ? " – " + hm(a.end_time) : "") : "All day");
function partHeader(title, sub) {
  return `<tr><td style="padding:28px 28px 0;${FONT}">
  <div style="font-size:16px;font-weight:700;color:${C.ink};border-bottom:2px solid ${C.ink};padding-bottom:6px">${esc(title)}${sub ? ` <span style="font-size:12px;font-weight:500;color:${C.muted}">${esc(sub)}</span>` : ""}</div></td></tr>`;
}
function actRow(a, showWho) {
  const who = emailOf[a.assignee] ? name(emailOf[a.assignee]) : a.assignee_label || "";
  const meta = [a.customer, showWho ? who : "", a.category].filter(Boolean).map(esc).join(" &nbsp;·&nbsp; ");
  return `<tr>
<td width="4" bgcolor="${C.accent}" style="background:${C.accent};width:4px;font-size:0;line-height:0">&nbsp;</td>
<td width="104" valign="top" style="padding:10px 6px 10px 12px;border-bottom:1px solid ${C.line};${FONT}font-size:12.5px;font-weight:700;color:${C.accent};white-space:nowrap">${esc(timeRange(a))}</td>
<td style="padding:10px 12px 10px 6px;border-bottom:1px solid ${C.line};${FONT}">
  <div style="font-size:14px;font-weight:600;color:${C.ink};line-height:1.35">${esc(a.title)}</div>
  ${meta ? `<div style="font-size:12px;color:${C.muted};padding-top:2px">${meta}</div>` : ""}
  ${a.details ? `<div style="font-size:12px;color:${C.muted};padding-top:3px;white-space:pre-wrap">${esc(a.details.slice(0, 200))}</div>` : ""}
</td></tr>`;
}
function scheduleHtml(list, showWho) {
  const days = [];
  for (let i = 0; i < WEEK_DAYS; i++) days.push(addDays(today, i));
  const label = (d, i) => {
    const nice = new Date(d + "T00:00:00Z").toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "short", timeZone: "UTC" });
    return i === 0 ? `Today · ${nice}` : i === 1 ? `Tomorrow · ${nice}` : nice;
  };
  const blocks = days.map((d, i) => {
    const items = list.filter((a) => a.due === d);
    const head = `<tr><td colspan="3" bgcolor="${i === 0 ? "#eaf0fc" : "#f7f9fc"}" style="background:${i === 0 ? "#eaf0fc" : "#f7f9fc"};padding:8px 12px;border-bottom:1px solid ${C.line};${FONT}font-size:12px;font-weight:700;color:${i === 0 ? C.accent : C.ink}">${esc(label(d, i))}${items.length ? ` <span style="color:${C.muted};font-weight:500">&nbsp;${items.length}</span>` : ""}</td></tr>`;
    const body = items.length
      ? `<tr><td colspan="3" style="padding:0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse">${items.map((a) => actRow(a, showWho)).join("")}</table></td></tr>`
      : `<tr><td colspan="3" style="padding:8px 12px;border-bottom:1px solid ${C.line};${FONT}font-size:12px;color:#9aa3b2">No activities</td></tr>`;
    return head + body;
  }).join("");
  return `<tr><td style="padding:14px 28px 0">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;border:1px solid ${C.line}">${blocks}</table>
<div style="${FONT}font-size:12px;padding-top:8px;text-align:right"><a href="${esc(SCHEDULE_URL)}" style="color:${C.accent};text-decoration:none">Open schedule →</a></div>
</td></tr>`;
}
function stat(label, value, color) {
  return `<td width="25%" align="center" style="padding:14px 4px;${FONT}">
  <div style="font-size:24px;font-weight:700;color:${color};line-height:1">${value}</div>
  <div style="font-size:11px;color:${C.muted};padding-top:5px;letter-spacing:.04em">${esc(label)}</div></td>`;
}
function textList(title, list, showWho) {
  if (!list.length) return "";
  return `\n${title} (${list.length})\n` + list.map((t) => `- [${(PRI[t.priority] || "Medium").toUpperCase()}] ${code(t)} ${t.title} | ${dueText(t)}${showWho ? " | " + (emailOf[t.assignee] ? name(emailOf[t.assignee]) : t.assignee_label || "Unassigned") : ""}${t.customer ? " | " + t.customer : ""}`).join("\n") + "\n";
}
function buildEmail(greetName, list, showWho, acts = []) {
  list = list.slice().sort(sortTasks);
  const soon = list.filter(urgent);
  const progress = list.filter((t) => t.status === "progress" && !urgent(t));
  const todo = list.filter((t) => t.status === "todo" && !urgent(t));
  const high = list.filter((t) => t.priority === "high").length;
  const todayCount = acts.filter((a) => a.due === today).length;
  const subject = `Schedule & tasks for ${short(today)}: ${todayCount} today, ${acts.length} this week, ${list.length} open task${list.length === 1 ? "" : "s"}${high ? `, ${high} high priority` : ""}${soon.length ? `, ${soon.length} due soon` : ""}`;
  const overdue = list.filter((t) => left(t) != null && left(t) < 0).length;
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:${C.bg}">
<div style="display:none;max-height:0;overflow:hidden">${esc(`${list.length} open tasks, ${high} high priority, ${soon.length} due soon`)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.bg}" style="background:${C.bg}">
<tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="640" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:640px;background:#ffffff;border:1px solid ${C.line};border-radius:8px;overflow:hidden">
  <tr><td bgcolor="${C.navy}" style="background:${C.navy};padding:22px 28px;${FONT}">
    <div style="font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#9fb3d1">PT. Tamura Trade Indonesia</div>
    <div style="font-size:20px;font-weight:700;color:#ffffff;padding-top:6px">Daily Schedule &amp; Tasks</div>
    <div style="font-size:13px;color:#c9d5e8;padding-top:4px">${esc(longDate)}</div>
  </td></tr>
  <tr><td style="padding:22px 28px 0;${FONT}font-size:14px;color:${C.ink}">Good morning${greetName ? ", " + esc(greetName) : ""}. Here is your schedule for the week and your open tasks.</td></tr>
  ${partHeader("1. Schedule", "this week")}
  ${scheduleHtml(acts, showWho)}
  ${partHeader("2. Tasks", list.length ? `${list.length} open` : "")}
  ${list.length ? `  <tr><td style="padding:14px 28px 0">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f7f9fc" style="background:#f7f9fc;border:1px solid ${C.line};border-radius:6px">
      <tr>${stat("OPEN", list.length, C.ink)}${stat("HIGH PRIORITY", high, high ? C.red : C.muted)}${stat("DUE SOON", soon.length - overdue, soon.length - overdue ? C.amber : C.muted)}${stat("OVERDUE", overdue, overdue ? C.red : C.muted)}</tr>
    </table>
  </td></tr>` : `<tr><td style="padding:14px 28px 0;${FONT}font-size:13px;color:${C.muted}">No open tasks. Nice work.</td></tr>`}
  ${section(`Needs attention · due within ${SOON} days or overdue`, soon, showWho, C.red)}
  ${section("In progress", progress, showWho, C.accent)}
  ${section("To do", todo, showWho)}
  <tr><td align="center" style="padding:28px 28px 8px">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
      <td bgcolor="${C.accent}" style="background:${C.accent};border-radius:6px">
        <a href="${esc(BOARD_URL)}" style="display:inline-block;padding:12px 26px;${FONT}font-size:14px;font-weight:600;color:#ffffff;text-decoration:none">Open Task Board</a>
      </td></tr></table>
  </td></tr>
  <tr><td style="padding:16px 28px 22px;${FONT}font-size:11.5px;line-height:1.5;color:${C.muted};border-top:1px solid ${C.line}">
    Sent automatically every morning at 06:00 WIB. Tasks marked <b>Done</b> on the board no longer appear here.<br>
    Priority: <span style="color:${C.red};font-weight:700">■</span> High &nbsp; <span style="color:${C.amber};font-weight:700">■</span> Medium &nbsp; <span style="color:${C.green};font-weight:700">■</span> Low
  </td></tr>
</table>
</td></tr></table>
</body></html>`;
  const text = `Good morning${greetName ? ", " + greetName : ""}. ${longDate}\n` +
    `\n== 1. SCHEDULE (this week) ==\n` + (acts.length ? acts.map((a) => `- ${short(a.due)}  ${timeRange(a)}  ${a.title}${a.customer ? " | " + a.customer : ""}`).join("\n") : "No activities this week.") + "\n" +
    `\n== 2. TASKS (${list.length} open) ==\n` + (list.length ? "" : "No open tasks.\n") +
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

console.log(`${today}: ${activities.length} activity(ies) this week, ${tasks.length} open task(s)${DRY ? " (dry run, nothing is sent)" : ""}.`);
let failed = 0;
for (const p of people) {
  const mine = tasks.filter((t) => ownerOf(t) === p.id);
  const myActs = activities.filter((a) => ownerOf(a) === p.id);
  if (!mine.length && !myActs.length) continue;
  try { await send(p.email, buildEmail(name(p.email), mine, false, myActs)); } catch (e) { failed++; console.error(`- ${p.email} FAILED: ${e.message}`); }
}
const cc = (env.REMINDER_CC || "").split(",").map((s) => s.trim()).filter(Boolean);
if (cc.length && (tasks.length || activities.length)) {
  try { await send(cc.join(", "), buildEmail("", tasks, true, activities)); } catch (e) { failed++; console.error(`- team summary FAILED: ${e.message}`); }
}
if (failed) process.exit(1);
