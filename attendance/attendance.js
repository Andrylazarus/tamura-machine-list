/* Tamura Attendance — check in / check out, sick, permission, leave (Supabase auth + database) */
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var cfg = window.APP_CONFIG || {};
  var AT_LABEL = { present: "Present", sick: "Sick", permit: "Permission", leave: "Leave", off: "Day off", absent: "Absent" };
  var AT_ID = { present: "Hadir", sick: "Sakit", permit: "Izin", leave: "Cuti", off: "Libur", absent: "Alpa" };
  var AT_PILL = { present: "ok", sick: "warn", permit: "warn", leave: "att-out", off: "att-off", absent: "bad" };
  var AT_ORDER = ["present", "sick", "permit", "leave", "off", "absent"];
  var GROUP = { present: "present", sick: "away", permit: "away", leave: "leave", off: "leave", absent: "absent" };

  var state = { att: new Map(), today: [], team: {}, role: null, user: null, ready: false, off: false, mine: null,
                range: "last7", from: "", to: "", fUser: "", fStatus: "", channel: null, shown: [] };
  function isAdmin() { return state.role === "admin"; }

  var VIEWS = ["viewLogin", "viewPending", "viewApp"];
  function show(id) { VIEWS.forEach(function (v) { $(v).hidden = v !== id; }); }
  function msg(el, text, kind) { el.textContent = text; el.className = "msg " + (kind || "err"); el.hidden = !text; }
  function toast(t) { var el = $("toast"); el.textContent = t; el.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(function () { el.hidden = true; }, 3500); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function natural(a, b) { return String(a || "").localeCompare(String(b || ""), undefined, { numeric: true, sensitivity: "base" }); }
  function errText(err) {
    var m = (err && (err.message || err.details)) || String(err);
    if (err && err.code === "23505") return "There is already attendance for this engineer on that day. Open that one to change it.";
    if (/Only an admin|only change today/i.test(m)) return m;
    if (err && (err.code === "42501" || /row-level security|permission/i.test(m))) return "You don't have permission for this. You can only change your own attendance for today.";
    return m;
  }
  function noTable(err) { return !!err && /relation|does not exist|schema cache|function .* does not exist/i.test(err.message || ""); }

  // ---------- dates (the person's local calendar day) ----------
  function iso(d) { return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
  function parse(s) { var p = String(s).split("-"); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function addDays(d, n) { var x = new Date(d); x.setDate(x.getDate() + n); return x; }
  function fmtDay(s) { return parse(s).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" }); }
  function fmtShort(s) { return parse(s).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }); }
  function longDate(s) { return parse(s).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }); }
  function bounds() {
    var t = new Date(), today = iso(t), r = state.range;
    if (r === "today") return [today, today];
    if (r === "week") { var mon = addDays(t, -((t.getDay() + 6) % 7)); return [iso(mon), iso(addDays(mon, 6))]; }
    if (r === "last7") return [iso(addDays(t, -6)), today];
    if (r === "last30") return [iso(addDays(t, -29)), today];
    if (r === "month") return [iso(new Date(t.getFullYear(), t.getMonth(), 1)), iso(new Date(t.getFullYear(), t.getMonth() + 1, 0))];
    if (r === "lastmonth") return [iso(new Date(t.getFullYear(), t.getMonth() - 1, 1)), iso(new Date(t.getFullYear(), t.getMonth(), 0))];
    var a = state.from || today, b = state.to || a; return a <= b ? [a, b] : [b, a];
  }
  function hm(ts) { if (!ts) return ""; var d = new Date(ts); return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0"); }
  function fmtHours(h) { return h ? (Math.round(h * 10) / 10) + " h" : ""; }
  function atLabel(st) { return AT_LABEL[st] + " (" + AT_ID[st] + ")"; }
  function fromRow(r) { return { _id: r.id, user: r.user_id, date: r.work_date, status: AT_LABEL[r.status] ? r.status : "present", inAt: r.check_in, outAt: r.check_out, customer: r.customer || "", note: r.note || "", updatedAt: r.updated_at }; }
  function at(a) { return a && a.customer ? " at " + a.customer : ""; }
  function hours(a) { return a && a.inAt && a.outAt ? Math.max(0, (new Date(a.outAt) - new Date(a.inAt)) / 3600000) : 0; }
  function key(u, d) { return u + "|" + d; }
  function name(id) { if (!id) return "Former user"; return state.team[id] || (state.user && id === state.user.id ? "You" : "Former user"); }

  if (!window.supabase || !window.supabase.createClient || !cfg.SUPABASE_URL) {
    show("viewLogin"); msg($("loginMsg"), "The login service did not load. Check your internet connection and reload the page."); return;
  }
  var sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);

  // ---------- login ----------
  $("loginForm").addEventListener("submit", function (e) {
    e.preventDefault();
    var b = $("btnLogin"); b.disabled = true; msg($("loginMsg"), "");
    sb.auth.signInWithPassword({ email: $("loginEmail").value.trim(), password: $("loginPassword").value }).then(function (res) {
      if (res.error) msg($("loginMsg"), res.error.message === "Invalid login credentials" ? "Wrong email or password." : res.error.message);
      else if (res.data && res.data.user) enter(res.data.user);
    }).finally(function () { b.disabled = false; });
  });
  document.querySelectorAll("[data-logout]").forEach(function (b) {
    b.addEventListener("click", function () { sb.auth.signOut().then(function () { location.reload(); }); });
  });
  function enter(user) {
    if (state.user && state.user.id === user.id) return;
    state.user = user;
    sb.from("profiles").select("role,email").eq("id", user.id).maybeSingle().then(function (res) {
      var role = res.data && res.data.role;
      if (role !== "admin" && role !== "viewer") { $("pendingEmail").textContent = user.email || ""; show("viewPending"); return; }
      state.role = role;
      $("userEmail").textContent = user.email || "";
      $("userRole").textContent = role; $("userRole").className = "role " + role;
      document.querySelectorAll("[data-owner]").forEach(function (a) { a.hidden = !isAdmin(); });
      if (!isAdmin() && window.APP_IS_OWNER) window.APP_IS_OWNER(user.email).then(function (ok) {
        document.querySelectorAll("[data-owner]").forEach(function (a) { a.hidden = !ok; });
      });
      $("btnAdd").hidden = !isAdmin();
      $("lede").textContent = isAdmin() ? "Everyone's attendance. As admin you can add or correct any entry; click a row." : "Check in when you start work and check out when you finish. Everyone on the team can see the list.";
      show("viewApp"); loadTeam(); loadCustomers(); load(); loadToday(); subscribe();
    });
  }
  show("viewLogin");
  sb.auth.getSession().then(function (r) { var s = r.data && r.data.session; if (s && s.user) enter(s.user); });
  sb.auth.onAuthStateChange(function (ev, s) {
    if (ev === "SIGNED_OUT") { state.user = null; show("viewLogin"); }
    else if (ev === "SIGNED_IN" && s && s.user) setTimeout(function () { enter(s.user); }, 0);
  });

  // ---------- data ----------
  // The approved accounts that are expected to check in
  function loadTeam() {
    sb.rpc("attendance_roster").then(function (r) {
      if (r.error) return sb.rpc("people").then(function (p) { return p.error ? [] : p.data || []; });
      return r.data || [];
    }).then(function (list) {
      var t = {}; list.forEach(function (u) { if (u.name) t[u.id] = u.name; }); state.team = t;
      var cur = $("fUser").value;
      $("fUser").innerHTML = '<option value="">Everyone</option>' + Object.keys(t).sort(function (a, b) { return natural(t[a], t[b]); })
        .map(function (id) { return '<option value="' + esc(id) + '">' + esc(t[id]) + '</option>'; }).join("");
      $("fUser").value = cur; render(); renderToday();
    });
  }
  // Customers from the Machine List (and ones typed before), as suggestions
  function loadCustomers() {
    sb.from("machines").select("customer").range(0, 4999).then(function (res) {
      var o = { Office: 1 };
      (res.data || []).forEach(function (m) { if (m.customer) o[String(m.customer).trim()] = 1; });
      state.att.forEach(function (a) { if (a.customer) o[a.customer] = 1; });
      $("custList").innerHTML = Object.keys(o).sort(natural).map(function (c) { return '<option value="' + esc(c) + '">'; }).join("");
    });
  }
  var seq = 0;
  function load() {
    var b = bounds(), n = ++seq;
    return sb.from("attendance").select("*").gte("work_date", b[0]).lte("work_date", b[1]).order("work_date", { ascending: false }).range(0, 9999).then(function (res) {
      if (n !== seq) return;
      state.ready = true;
      if (res.error) {
        state.off = noTable(res.error); state.att = new Map();
        $("banner").hidden = false;
        $("banner").textContent = state.off ? "Attendance is not set up yet. Run supabase/attendance.sql once in the Supabase SQL Editor, then reload this page."
                                            : "Could not load attendance: " + res.error.message;
        render(); myCard(); return;
      }
      state.off = false; $("banner").hidden = true;
      var m = new Map(); res.data.forEach(function (r) { var a = fromRow(r); m.set(key(a.user, a.date), a); });
      state.att = m; render();
    });
  }
  // Today, whatever period is chosen: for the cards at the top and my own check in
  function loadToday() {
    return sb.from("attendance").select("*").eq("work_date", iso(new Date())).then(function (res) {
      if (res.error) { if (noTable(res.error)) state.off = true; state.today = []; state.mine = null; myCard(); renderToday(); return; }
      state.today = (res.data || []).map(fromRow);
      state.mine = state.today.filter(function (a) { return a.user === state.user.id; })[0] || null;
      myCard(); renderToday();
    });
  }
  var timer;
  function subscribe() {
    if (state.channel) return;
    state.channel = sb.channel("attendance-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "attendance" }, function () { clearTimeout(timer); timer = setTimeout(function () { load(); loadToday(); }, 600); })
      .subscribe();
  }
  function keep(a) {
    var b = bounds();
    Array.from(state.att.keys()).forEach(function (k) { if (state.att.get(k)._id === a._id) state.att.delete(k); });
    if (a.date >= b[0] && a.date <= b[1]) state.att.set(key(a.user, a.date), a);
    render(); loadToday();
  }

  // ---------- my check in / check out ----------
  function myCard() {
    var card = $("attendCard");
    if (state.off || !state.user) { card.hidden = true; return; }
    card.hidden = false; $("attCustL").hidden = !!state.mine;
    var a = state.mine, cls = "none", st, sub, btn;
    $("attDay").textContent = "My attendance · " + fmtDay(iso(new Date()));
    if (!a) {
      st = "Not checked in yet"; sub = "Fill in where you work today, then check in. Sick, permission or leave? Report it instead.";
      btn = '<button class="btn primary" type="button" data-att="in">Check in</button><button class="btn" type="button" data-att="away">Sick / permission / leave</button>';
    } else if (a.status === "present" && !a.outAt) {
      cls = "in"; st = "Checked in " + hm(a.inAt) + at(a); sub = a.note || "Check out when you finish work.";
      btn = '<button class="btn primary" type="button" data-att="out">Check out</button><button class="btn" type="button" data-att="edit">Change</button>';
    } else if (a.status === "present") {
      cls = "out"; st = "In " + hm(a.inAt) + " · Out " + hm(a.outAt) + " · " + (fmtHours(hours(a)) || "0 h"); sub = [a.customer, a.note].filter(Boolean).join(" · ") || "Done for today.";
      btn = '<button class="btn" type="button" data-att="edit">Change</button>';
    } else {
      cls = a.status === "absent" ? "none" : "away"; st = atLabel(a.status); sub = a.note || "Reported for today.";
      btn = '<button class="btn" type="button" data-att="edit">Change</button>';
    }
    card.className = "attend " + cls; $("attState").textContent = st; $("attSub").textContent = sub; $("attButtons").innerHTML = btn;
  }
  $("attButtons").addEventListener("click", function (e) {
    var b = e.target.closest("[data-att]"); if (!b) return;
    var act = b.dataset.att, a = state.mine, today = iso(new Date());
    if (act === "in" && !$("attCust").value.trim()) { toast("Fill in where you work today (customer, or Office)."); $("attCust").focus(); return; }
    if (act === "away") { openAtt(null, { user: state.user.id, date: today, status: "sick" }); return; }
    if (act === "edit") { openAtt(a); return; }
    b.disabled = true;
    var q = act === "in"
      ? sb.from("attendance").insert({ user_id: state.user.id, work_date: today, status: "present", check_in: new Date().toISOString(), customer: $("attCust").value.trim() }).select().single()
      : sb.from("attendance").update({ check_out: new Date().toISOString() }).eq("id", a._id).select().single();
    q.then(function (res) {
      if (res.error) { toast("Could not save: " + errText(res.error)); if (res.error.code === "23505") loadToday(); return; }
      var o = fromRow(res.data); keep(o);
      if (act === "in") $("attCust").value = "";
      toast(act === "in" ? "Checked in " + hm(o.inAt) + at(o) : "Checked out at " + hm(o.outAt) + " · " + (fmtHours(hours(o)) || "0 h"));
    }).finally(function () { b.disabled = false; });
  });

  // ---------- today cards ----------
  function renderToday() {
    var ids = Object.keys(state.team), seen = {}, g = { present: [], away: [], leave: [], absent: [] };
    state.today.forEach(function (a) { seen[a.user] = 1; g[GROUP[a.status]].push(name(a.user)); });
    var missing = ids.filter(function (id) { return !seen[id]; }).map(name).sort(natural);
    function names(l) { return l.sort(natural).join(", "); }
    $("sPresent").textContent = g.present.length; $("sPresentH").textContent = ids.length ? "of " + ids.length + " engineers" : "";
    $("sAway").textContent = g.away.length; $("sAwayH").textContent = names(g.away);
    $("sLeave").textContent = g.leave.length + g.absent.length; $("sLeaveH").textContent = names(g.leave.concat(g.absent));
    $("sMissing").textContent = state.off ? "–" : missing.length; $("sMissingH").textContent = missing.length ? names(missing) : (ids.length ? "Everyone has checked in" : "");
  }

  // ---------- list: every approved account for every working day, plus what was recorded ----------
  function rowsFor() {
    var b = bounds(), today = iso(new Date()), last = b[1] < today ? b[1] : today, out = [], seen = {};
    var ids = Object.keys(state.team);
    function want(id, a) {
      if (state.fUser && id !== state.fUser) return false;
      if (!state.fStatus) return true;
      return state.fStatus === "none" ? !a : !!a && GROUP[a.status] === state.fStatus;
    }
    for (var d = parse(b[0]); iso(d) <= last; d = addDays(d, 1)) {
      var ds = iso(d), sunday = d.getDay() === 0;
      ids.forEach(function (id) {
        var a = state.att.get(key(id, ds)) || null; if (a) seen[a._id] = 1;
        if (!a && sunday) return;          // Sundays only when someone recorded something
        if (want(id, a)) out.push({ user: id, date: ds, rec: a });
      });
    }
    state.att.forEach(function (a) { if (!seen[a._id] && want(a.user, a)) out.push({ user: a.user, date: a.date, rec: a }); });
    out.sort(function (x, y) { return (x.date < y.date ? 1 : x.date > y.date ? -1 : 0) || natural(name(x.user), name(y.user)); });
    return out;
  }
  function rowHtml(r, i) {
    var a = r.rec, today = iso(new Date()), click = isAdmin() || (a && a.user === state.user.id && a.date === today);
    var pill = a ? '<span class="pill ' + AT_PILL[a.status] + '">' + esc(atLabel(a.status)) + '</span>'
                 : '<span class="pill">' + (r.date === today ? "Not checked in yet" : "No record") + '</span>';
    return '<tr class="row' + (a ? '' : ' miss') + '" data-i="' + i + '"' + (click ? ' tabindex="0"' : ' style="cursor:default"') + '>' +
      '<td data-l="Engineer" class="nw"><strong>' + esc(name(r.user)) + '</strong></td>' +
      '<td data-l="Date" class="nw">' + esc(fmtShort(r.date)) + '</td>' +
      '<td data-l="Attendance">' + pill + '</td>' +
      '<td data-l="Customer">' + esc(a ? a.customer : "") + '</td>' +
      '<td data-l="Check in" class="nw mono">' + esc(a ? hm(a.inAt) : "") + '</td>' +
      '<td data-l="Check out" class="nw mono">' + esc(a ? hm(a.outAt) : "") + '</td>' +
      '<td data-l="Hours" class="nw mono">' + esc(a ? fmtHours(hours(a)) : "") + '</td>' +
      '<td data-l="Note" class="c-pc">' + (a && a.note ? '<span class="note">' + esc(a.note) + '</span>' : '') + '</td>' +
      '<td class="c-sum">' + esc(a ? [a.inAt ? hm(a.inAt) + (a.outAt ? "–" + hm(a.outAt) : "") : "", fmtHours(hours(a)), a.customer].filter(Boolean).join(" · ") : "") + (a && a.note ? '<div class="sub">' + esc(a.note) + '</div>' : '') + '</td></tr>';
  }
  function render() {
    var rows = state.shown = state.off ? [] : rowsFor(), cnt = {}, miss = 0, html = "", cur = null;
    rows.forEach(function (r, i) {
      if (r.rec) cnt[r.rec.status] = (cnt[r.rec.status] || 0) + 1; else miss++;
      if (r.date !== cur) {
        cur = r.date;
        var day = rows.filter(function (x) { return x.date === cur; }), pres = day.filter(function (x) { return x.rec && x.rec.status === "present"; }).length;
        html += '<tr class="grp" style="cursor:default"><td colspan="9"><div class="grp-in"><strong>' + esc(fmtDay(cur)) + '</strong><span class="n">' + pres + ' of ' + day.length + ' present</span></div></td></tr>';
      }
      html += rowHtml(r, i);
    });
    $("rows").innerHTML = html;
    $("attSum").innerHTML = AT_ORDER.filter(function (k) { return cnt[k]; }).map(function (k) { return '<span class="pill ' + AT_PILL[k] + '">' + esc(AT_LABEL[k]) + ': ' + cnt[k] + '</span>'; }).join("") +
      (miss ? '<span class="pill bad">No record: ' + miss + '</span>' : '');
    var b = bounds(); $("count").textContent = b[0] === b[1] ? fmtShort(b[0]) : fmtShort(b[0]) + " – " + fmtShort(b[1]);
    var empty = $("empty");
    if (!state.ready) empty.hidden = false;
    else if (state.off) { empty.hidden = false; $("emptyTitle").textContent = "Attendance is not set up yet"; $("emptyText").textContent = "An admin has to run supabase/attendance.sql once in Supabase."; }
    else if (!rows.length) { empty.hidden = false; $("emptyTitle").textContent = "Nothing to show"; $("emptyText").textContent = "Choose another period, engineer or filter."; }
    else empty.hidden = true;
  }

  // ---------- filters ----------
  try { var pv = JSON.parse(localStorage.getItem("tml.attendance") || "null"); if (pv && pv.range && pv.range !== "custom") state.range = pv.range; } catch (e) {}
  $("fRange").value = state.range;
  $("fRange").addEventListener("change", function () {
    state.range = this.value; $("customRange").hidden = state.range !== "custom";
    if (state.range === "custom") { var b = bounds(); $("fFrom").value = state.from = state.from || b[0]; $("fTo").value = state.to = state.to || b[1]; }
    try { localStorage.setItem("tml.attendance", JSON.stringify({ range: state.range })); } catch (e) {}
    load();
  });
  $("fFrom").addEventListener("change", function () { state.from = this.value; load(); });
  $("fTo").addEventListener("change", function () { state.to = this.value; load(); });
  $("fUser").addEventListener("change", function () { state.fUser = this.value; render(); });
  $("fStatus").addEventListener("change", function () { state.fStatus = this.value; render(); });
  function rowAction(e) {
    var tr = e.target.closest("tr[data-i]"); if (!tr) return;
    var r = state.shown[+tr.dataset.i]; if (!r) return;
    if (r.rec && (isAdmin() || (r.rec.user === state.user.id && r.date === iso(new Date())))) openAtt(r.rec);
    else if (!r.rec && isAdmin()) openAtt(null, { user: r.user, date: r.date, status: "present" });
  }
  $("rows").addEventListener("click", rowAction);
  $("rows").addEventListener("keydown", function (e) { if (e.key === "Enter") rowAction(e); });
  $("btnAdd").addEventListener("click", function () { openAtt(null, { user: state.fUser || state.user.id, date: iso(new Date()), status: "present" }); });

  // ---------- dialog: an engineer changes today's own entry; an admin adds or corrects any ----------
  var editing = null;
  function syncTimes() { var pres = $("a_status").value === "present", show = isAdmin() && pres; $("a_inL").hidden = !show; $("a_outL").hidden = !show; $("a_custL").hidden = !pres; }
  $("a_status").addEventListener("change", syncTimes);
  function openAtt(a, preset) {
    editing = a; preset = preset || {};
    var adm = isAdmin(), uid = a ? a.user : preset.user, date = a ? a.date : preset.date, status = a ? a.status : (preset.status || "present");
    var opts = Object.keys(state.team).map(function (id) { return { id: id, n: state.team[id] }; });
    if (uid && !state.team[uid]) opts.push({ id: uid, n: name(uid) });
    opts.sort(function (x, y) { return natural(x.n, y.n); });
    $("a_user").innerHTML = opts.map(function (o) { return '<option value="' + esc(o.id) + '">' + esc(o.n) + '</option>'; }).join("");
    $("a_user").value = uid || state.user.id; $("a_date").value = date || iso(new Date());
    $("a_userL").hidden = !adm; $("a_dateL").hidden = !adm;
    Array.prototype.forEach.call($("a_status").options, function (o) { var lock = o.hasAttribute("data-admin") && !adm && o.value !== status; o.hidden = lock; o.disabled = lock; });
    $("a_status").value = status;
    $("a_in").value = a ? hm(a.inAt) : (adm && status === "present" ? "08:00" : "");
    $("a_out").value = a ? hm(a.outAt) : "";
    $("a_note").value = a ? a.note : ""; $("a_cust").value = a ? a.customer : "";
    syncTimes();
    $("attTitle").textContent = adm ? (a ? name(uid) + " · " + fmtShort(date) : "Add attendance") : (a ? "Change today's attendance" : "Can't come in today?");
    $("attMeta").textContent = adm ? "As admin you can add or correct attendance for anyone on any date." + (a && a.updatedAt ? " Last changed " + new Date(a.updatedAt).toLocaleString("en-GB") + "." : "")
                                   : "Check-in and check-out times come from the clock when you press the button. Ask an admin to correct a time or an earlier day.";
    $("delArea").innerHTML = (a && adm) ? '<button class="btn danger" type="button" id="btnDel">Delete</button>' : '';
    $("dlgAtt").showModal();
  }
  $("dlgAtt").addEventListener("click", function (e) { if (e.target.closest("[data-close]") || e.target === this) this.close(); });
  $("delArea").addEventListener("click", function (e) {
    if (e.target.id === "btnDel") $("delArea").innerHTML = '<span class="confirm">Delete this attendance? <button class="btn danger solid" type="button" id="btnDelYes">Delete</button><button class="btn" type="button" id="btnDelNo">Keep</button></span>';
    if (e.target.id === "btnDelNo") $("delArea").innerHTML = '<button class="btn danger" type="button" id="btnDel">Delete</button>';
    if (e.target.id === "btnDelYes") sb.from("attendance").delete().eq("id", editing._id).then(function (res) {
      if (res.error) { toast("Could not delete: " + errText(res.error)); return; }
      state.att.delete(key(editing.user, editing.date)); render(); loadToday(); $("dlgAtt").close(); toast("Attendance deleted");
    });
  });
  function stamp(date, time) { if (!date || !time) return null; var d = parse(date), t = time.split(":"); return new Date(d.getFullYear(), d.getMonth(), d.getDate(), +t[0], +t[1]).toISOString(); }
  $("attForm").addEventListener("submit", function (e) {
    e.preventDefault();
    var adm = isAdmin(), status = $("a_status").value, note = $("a_note").value.trim(), cust = status === "present" ? $("a_cust").value.trim() : "", row;
    if (adm) {
      var d = $("a_date").value; if (!d) { toast("Choose the date."); return; }
      var inAt = status === "present" ? stamp(d, $("a_in").value) : null, outAt = status === "present" ? stamp(d, $("a_out").value) : null;
      if (outAt && !inAt) { toast("Fill in the check-in time too."); return; }
      if (inAt && outAt && outAt < inAt) outAt = new Date(new Date(outAt).getTime() + 86400000).toISOString();   // finished after midnight
      row = { user_id: $("a_user").value, work_date: d, status: status, check_in: inAt, check_out: outAt, customer: cust, note: note };
    } else {
      row = editing ? { status: status, customer: cust, note: note }
                    : { user_id: state.user.id, work_date: iso(new Date()), status: status, check_in: status === "present" ? new Date().toISOString() : null, customer: cust, note: note };
    }
    var btn = $("btnSave"); btn.disabled = true;
    var q = editing ? sb.from("attendance").update(row).eq("id", editing._id).select().single() : sb.from("attendance").insert(row).select().single();
    q.then(function (res) {
      if (res.error) { toast("Could not save: " + errText(res.error)); return; }
      keep(fromRow(res.data)); $("dlgAtt").close(); toast("Attendance saved");
    }).finally(function () { btn.disabled = false; });
  });

  // ---------- export ----------
  var INK = "FF111A27", BLUE = "FF1F56C9", LINE = "FFD9DFE8", SOFT = "FFF4F6F9", MUTED = "FF5D6B7E";
  var AT_FILL = { present: "FFDDF1E7", sick: "FFFBEFD4", permit: "FFFBEFD4", leave: "FFE3EBFB", off: "FFE9EDF2", absent: "FFFBE6E3" };
  var AT_INK = { present: "FF18774D", sick: "FF8F5600", permit: "FF8F5600", leave: "FF1F56C9", off: "FF5D6B7E", absent: "FFB3261E" };
  function exportRows() { return rowsFor().sort(function (x, y) { return natural(x.date, y.date) || natural(name(x.user), name(y.user)); }); }
  function fileName() { var b = bounds(); return "Tamura_Attendance_" + b[0] + (b[0] === b[1] ? "" : "_to_" + b[1]) + ".xlsx"; }
  function xlDate(s) { var p = String(s).split("-"); return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])); }
  function styledExport(rows) {
    var b = bounds(), me = name(state.user.id), now = new Date();
    var wb = new ExcelJS.Workbook(); wb.creator = me; wb.created = now; wb.title = "Attendance Report";
    var thin = { style: "thin", color: { argb: LINE } }, box = { top: thin, left: thin, bottom: thin, right: thin };
    function fill(argb) { return { type: "pattern", pattern: "solid", fgColor: { argb: argb } }; }
    var filt = (state.fUser ? "Engineer: " + name(state.fUser) : "All engineers") + (state.fStatus ? "  |  Show: " + $("fStatus").selectedOptions[0].textContent : "");
    function titleBlock(ws, lastCol, subtitle) {
      [1, 2, 3, 4].forEach(function (r) { ws.mergeCells(r, 1, r, lastCol); ws.getCell(r, 1).alignment = { vertical: "middle", horizontal: "left" }; });
      var c1 = ws.getCell(1, 1); c1.value = "PT. TAMURA TRADE INDONESIA"; c1.font = { name: "Calibri", size: 11, bold: true, color: { argb: BLUE } };
      var c2 = ws.getCell(2, 1); c2.value = subtitle; c2.font = { name: "Calibri", size: 20, bold: true, color: { argb: INK } };
      var c3 = ws.getCell(3, 1); c3.value = "Period: " + (b[0] === b[1] ? longDate(b[0]) : longDate(b[0]) + " to " + longDate(b[1])) + "     |     " + filt; c3.font = { name: "Calibri", size: 11, color: { argb: INK } };
      var c4 = ws.getCell(4, 1); c4.value = "Exported " + now.toLocaleString("en-GB", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" }) + " by " + me;
      c4.font = { name: "Calibri", size: 10, italic: true, color: { argb: MUTED } };
      ws.getRow(1).height = 18; ws.getRow(2).height = 30; ws.getRow(3).height = 18; ws.getRow(4).height = 16; ws.getRow(5).height = 8;
    }
    function headRow(ws, r, labels) {
      var row = ws.getRow(r); row.height = 24;
      labels.forEach(function (t, i) { var c = row.getCell(i + 1); c.value = t; c.font = { name: "Calibri", size: 11, bold: true, color: { argb: "FFFFFFFF" } }; c.fill = fill(INK); c.border = box; c.alignment = { vertical: "middle", horizontal: "center", wrapText: true }; });
    }
    var page = { paperSize: 9, orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.6, header: 0.3, footer: 0.3 } };
    var HR = 6, foot = "&L&8PT. Tamura Trade Indonesia - Attendance Report&R&8Page &P of &N";

    var HEAD = ["No", "Date", "Day", "Engineer", "Attendance", "Customer", "Check in", "Check out", "Hours", "Note"], N = HEAD.length;
    var ws = wb.addWorksheet("Attendance", { views: [{ state: "frozen", ySplit: HR, showGridLines: false }], pageSetup: page });
    ws.columns = [5, 13, 6, 22, 28, 24, 10, 10, 8, 46].map(function (w) { return { width: w }; });
    titleBlock(ws, N, "Attendance Report"); headRow(ws, HR, HEAD);
    var r = HR, per = {};
    rows.forEach(function (x, i) {
      r++;
      var a = x.rec, h = hours(a), nm = name(x.user);
      var p = per[x.user] || (per[x.user] = { name: nm, present: 0, sick: 0, permit: 0, leave: 0, off: 0, absent: 0, none: 0, h: 0 });
      if (a) { p[a.status]++; p.h += h; } else p.none++;
      var vals = [i + 1, xlDate(x.date), parse(x.date).toLocaleDateString("en-GB", { weekday: "short" }), nm,
                  a ? atLabel(a.status) : "No record", a ? a.customer : "", a ? hm(a.inAt) : "", a ? hm(a.outAt) : "", h ? Math.round(h * 100) / 100 : null, a ? a.note : ""];
      var row = ws.getRow(r);
      vals.forEach(function (v, k) {
        var c = row.getCell(k + 1); c.value = (v === "" || v == null) ? null : v;
        c.font = { name: "Calibri", size: 10.5, color: { argb: INK } }; c.border = box;
        c.alignment = { vertical: "top", wrapText: true, horizontal: (k === 3 || k === 5 || k === 9) ? "left" : "center" };
        if (i % 2 === 1) c.fill = fill(SOFT);
      });
      row.getCell(2).numFmt = "dd mmm yyyy"; row.getCell(9).numFmt = "0.0";
      var sc = row.getCell(5); sc.fill = fill(a ? AT_FILL[a.status] : "FFFBE6E3"); sc.font = { name: "Calibri", size: 10.5, bold: true, color: { argb: a ? AT_INK[a.status] : "FFB3261E" } };
    });
    ws.autoFilter = { from: { row: HR, column: 1 }, to: { row: HR, column: N } };
    ws.pageSetup.printTitlesRow = HR + ":" + HR; ws.headerFooter.oddFooter = foot;
    // sign-off
    r += 3;
    [[2, "Prepared by", me], [7, "Approved by", ""]].forEach(function (sg) {
      var c = ws.getCell(r, sg[0]); c.value = sg[1]; c.font = { name: "Calibri", size: 10.5, color: { argb: MUTED } };
      ws.mergeCells(r + 4, sg[0], r + 4, sg[0] + 2);
      var n = ws.getCell(r + 4, sg[0]); n.value = sg[2] || null; n.font = { name: "Calibri", size: 11, bold: true, color: { argb: INK } };
      n.border = { top: { style: "thin", color: { argb: INK } } };
      var d = ws.getCell(r + 5, sg[0]); d.value = "Date:"; d.font = { name: "Calibri", size: 10, color: { argb: MUTED } };
    });

    var HEAD2 = ["No", "Engineer", "Present", "Sick", "Permission", "Leave", "Day off", "Absent", "No record", "Hours"], N2 = HEAD2.length;
    var ws2 = wb.addWorksheet("Summary", { views: [{ state: "frozen", ySplit: HR, showGridLines: false }], pageSetup: page });
    ws2.columns = [5, 26, 10, 10, 12, 10, 10, 10, 12, 10].map(function (w) { return { width: w }; });
    titleBlock(ws2, N2, "Attendance Summary per Engineer"); headRow(ws2, HR, HEAD2);
    var r2 = HR, tot = { present: 0, sick: 0, permit: 0, leave: 0, off: 0, absent: 0, none: 0, h: 0 };
    Object.keys(per).map(function (id) { return per[id]; }).sort(function (x, y) { return natural(x.name, y.name); }).forEach(function (p, i) {
      r2++;
      Object.keys(tot).forEach(function (k) { tot[k] += p[k]; });
      var row = ws2.getRow(r2);
      [i + 1, p.name, p.present, p.sick, p.permit, p.leave, p.off, p.absent, p.none, Math.round(p.h * 100) / 100].forEach(function (v, k) {
        var c = row.getCell(k + 1); c.value = v; c.font = { name: "Calibri", size: 10.5, color: { argb: INK } }; c.border = box;
        c.alignment = { vertical: "top", horizontal: k === 1 ? "left" : "center" }; if (i % 2 === 1) c.fill = fill(SOFT);
      });
      row.getCell(10).numFmt = "0.0";
    });
    r2++;
    var t2 = ws2.getRow(r2); t2.height = 22;
    [null, "Total", tot.present, tot.sick, tot.permit, tot.leave, tot.off, tot.absent, tot.none, Math.round(tot.h * 100) / 100].forEach(function (v, k) {
      var c = t2.getCell(k + 1); c.value = v; c.fill = fill("FFE3EBFB"); c.border = box;
      c.font = { name: "Calibri", size: 11, bold: true, color: { argb: INK } }; c.alignment = { vertical: "middle", horizontal: k === 1 ? "left" : "center" };
    });
    t2.getCell(10).numFmt = "0.0";
    ws2.pageSetup.printTitlesRow = HR + ":" + HR; ws2.headerFooter.oddFooter = foot;

    return wb.xlsx.writeBuffer().then(function (buf) {
      var blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      var a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = fileName();
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
    });
  }
  function plainExport(rows) {
    var aoa = [["Date", "Engineer", "Attendance", "Customer", "Check in", "Check out", "Hours", "Note"]];
    rows.forEach(function (x) { var a = x.rec, h = hours(a); aoa.push([x.date, name(x.user), a ? atLabel(a.status) : "No record", a ? a.customer : "", a ? hm(a.inAt) : "", a ? hm(a.outAt) : "", h ? Math.round(h * 100) / 100 : "", a ? a.note : ""]); });
    var ws = XLSX.utils.aoa_to_sheet(aoa); ws["!cols"] = [11, 22, 28, 24, 9, 9, 7, 46].map(function (w) { return { wch: w }; });
    var wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "Attendance"); XLSX.writeFile(wb, fileName());
  }
  $("btnExport").addEventListener("click", function () {
    var rows = exportRows(); if (!rows.length) { toast("Nothing to export with the current period and filters."); return; }
    var btn = this;
    function fallback(err) {
      if (err && window.console) console.warn("Formatted export failed, using the plain one:", err);
      if (typeof XLSX === "undefined") { toast("The Excel library did not load. Reload the page."); return; }
      plainExport(rows);
    }
    if (typeof ExcelJS === "undefined") { fallback(); return; }
    btn.disabled = true;
    Promise.resolve().then(function () { return styledExport(rows); }).catch(fallback).finally(function () { btn.disabled = false; });
  });

  render();
})();
