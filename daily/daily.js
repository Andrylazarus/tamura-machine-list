/* Tamura Daily Report — each engineer's activities, day by day (Supabase auth + database) */
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var cfg = window.APP_CONFIG || {};
  var ST_LABEL = { done: "Done", ongoing: "Ongoing", pending: "Pending" }, ST_PILL = { done: "ok", ongoing: "warn", pending: "none" };
  var FACETS = [{ k: "by", label: "Engineer" }, { k: "customer", label: "Customer" }, { k: "type", label: "Type of activity" }, { k: "status", label: "Status" }];
  var KIND_LABEL = { day: "Daily", week: "Weekly" };
  var NCOLS = 9;

  var state = { docs: new Map(), q: "", group: "date", range: "last7", from: "", to: "", shut: new Set(), shutFacet: {},
                sel: { by: new Set(), kind: new Set(), customer: new Set(), type: new Set(), status: new Set() },
                people: {}, machines: [], role: null, user: null, ready: false, channel: null, view: "day" };
  function isAdmin() { return state.role === "admin"; }
  function canEdit(m) { return isAdmin() || (!!m && !!state.user && m.by === state.user.id); }

  var VIEWS = ["viewLogin", "viewPending", "viewApp"];
  function show(id) { VIEWS.forEach(function (v) { $(v).hidden = v !== id; }); }
  function msg(el, text, kind) { el.textContent = text; el.className = "msg " + (kind || "err"); el.hidden = !text; }
  function toast(t) { var el = $("toast"); el.textContent = t; el.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(function () { el.hidden = true; }, 3500); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function natural(a, b) { return String(a || "").localeCompare(String(b || ""), undefined, { numeric: true, sensitivity: "base" }); }
  function errText(err) {
    var m = (err && (err.message || err.details)) || String(err);
    if (/report_kind/.test(m)) return "Weekly reports are not switched on yet. An admin has to run supabase/daily.sql again in the Supabase SQL Editor.";
    if (err && (err.code === "42501" || /row-level security|permission/i.test(m))) return isAdmin()
      ? "Saving for another engineer is not switched on yet. Run supabase/daily.sql again in the Supabase SQL Editor."
      : "You don't have permission for this. You can only change your own activities.";
    return m;
  }

  // ---------- dates (always the person's local calendar day) ----------
  function iso(d) { return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
  function parse(s) { var p = String(s).split("-"); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function addDays(d, n) { var x = new Date(d); x.setDate(x.getDate() + n); return x; }
  function fmtDay(s) { return parse(s).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" }); }
  function fmtShort(s) { return parse(s).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }); }
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
  function hours(m) {
    if (!m.start || !m.end) return 0;
    var a = m.start.split(":"), b = m.end.split(":"), mins = (+b[0] * 60 + +b[1]) - (+a[0] * 60 + +a[1]);
    if (mins < 0) mins += 1440;   // finished after midnight
    return mins / 60;
  }
  function fmtHours(h) { return h ? (Math.round(h * 10) / 10) + " h" : ""; }

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
      show("viewApp"); loadLookups(); load(); subscribe();
    });
  }
  show("viewLogin");
  sb.auth.getSession().then(function (r) { var s = r.data && r.data.session; if (s && s.user) enter(s.user); });
  sb.auth.onAuthStateChange(function (ev, s) {
    if (ev === "SIGNED_OUT") { state.user = null; show("viewLogin"); }
    else if (ev === "SIGNED_IN" && s && s.user) setTimeout(function () { enter(s.user); }, 0);
  });

  // ---------- data ----------
  function fromRow(r) {
    return { _id: r.id, date: r.report_date, start: (r.start_time || "").slice(0, 5), end: (r.end_time || "").slice(0, 5),
      customer: r.customer || "", location: r.location || "", type: r.activity_type || "", machine: r.machine || "",
      description: r.description || "", status: ST_LABEL[r.status] ? r.status : "done", next: r.next_action || "",
      by: r.created_by || "", updatedAt: r.updated_at, kind: r.report_kind === "week" ? "week" : "day",
      photos: Array.isArray(r.photos) ? r.photos.filter(function (p) { return typeof p === "string"; }) : [] };
  }
  // A weekly entry covers Monday (its date) to Sunday; it shows when that week overlaps the period
  function weekEnd(m) { return iso(addDays(parse(m.date), 6)); }
  function inRange(m, b) { return m.kind === "week" ? (m.date <= b[1] && weekEnd(m) >= b[0]) : (m.date >= b[0] && m.date <= b[1]); }
  function weekText(d, long) { var a = parse(d), e = addDays(a, 6), o = { day: "numeric", month: "short" }; return a.toLocaleDateString("en-GB", long ? { weekday: "short", day: "numeric", month: "short" } : o) + " – " + e.toLocaleDateString("en-GB", long ? { weekday: "short", day: "numeric", month: "short", year: "numeric" } : o); }
  function sortKey(m) { return m.date + (m.kind === "week" ? "W" : ""); }
  // Names for the Engineer column, and customers / machines from the Machine List as suggestions
  function loadLookups() {
    sb.rpc("people").then(function (pp) {
      if (!pp.error) return (pp.data || []).map(function (u) { return { id: u.id, name: u.name }; });
      // people() comes with supabase/permissions.sql; without it, take the names from the task board's member list
      return sb.rpc("team_members").then(function (tm) {
        return tm.error ? [] : (tm.data || []).map(function (u) {
          var n = String(u.email || "").split("@")[0].replace(/[._-]+/g, " ").trim();
          return { id: u.id, name: n.replace(/\b[a-z]/g, function (ch) { return ch.toUpperCase(); }) };
        });
      });
    }).then(function (list) {
      if (!list.length) return;
      var p = {}; list.forEach(function (u) { if (u.name) p[u.id] = u.name; }); state.people = p;
      if (state.ready) { render(); todayBar(); }
    });
    sb.from("machines").select("customer,location,brand,model,serial").range(0, 4999).then(function (res) {
      if (res.error) return; state.machines = res.data || []; fillLists();
    });
  }
  var loadSeq = 0;
  function load() {
    var b = bounds(), seq = ++loadSeq;
    return sb.from("daily_reports").select("*").gte("report_date", iso(addDays(parse(b[0]), -6))).lte("report_date", b[1]).order("report_date", { ascending: false }).range(0, 4999).then(function (res) {
      if (seq !== loadSeq) return;
      state.ready = true;
      if (res.error) {
        $("banner").hidden = false;
        $("banner").textContent = /relation|does not exist|schema cache/i.test(res.error.message)
          ? "The daily report is not set up yet. Run supabase/daily.sql once in the Supabase SQL Editor, then reload this page."
          : "Could not load the daily report: " + res.error.message;
        $("btnAdd").hidden = true; render(); return;
      }
      $("banner").hidden = true; $("btnAdd").hidden = false;
      var m = new Map(); res.data.forEach(function (r) { var o = fromRow(r); if (inRange(o, b)) m.set(o._id, o); });
      state.docs = m; render(); todayBar();
    });
  }
  // For the admin: who has and hasn't written anything today
  function todayBar() {
    var bar = $("todayBar");
    if (!isAdmin()) { bar.hidden = true; return; }
    var today = iso(new Date());
    sb.from("daily_reports").select("created_by").eq("report_date", today).then(function (res) {
      if (res.error) { bar.hidden = true; return; }
      var ids = Object.keys(state.people); if (!ids.length) { bar.hidden = true; return; }
      var done = {}; (res.data || []).forEach(function (r) { done[r.created_by] = 1; });
      var missing = ids.filter(function (id) { return !done[id]; }).map(function (id) { return state.people[id]; }).sort(natural);
      bar.hidden = false;
      bar.textContent = "Today: " + (ids.length - missing.length) + " of " + ids.length + " accounts have reported." + (missing.length ? " Not yet: " + missing.join(", ") + "." : "");
    });
  }
  var reloadTimer;
  function subscribe() {
    if (state.channel) return;
    state.channel = sb.channel("daily-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "daily_reports" }, function () { clearTimeout(reloadTimer); reloadTimer = setTimeout(load, 600); })
      .subscribe();
  }

  // ---------- helpers ----------
  // Daily and weekly entries are shown on separate tabs
  function all() { return Array.from(state.docs.values()).filter(function (m) { return m.kind === state.view; }); }
  function who(id) { if (!id) return "Former user"; return state.people[id] || (state.user && id === state.user.id ? "You" : "Unknown user"); }
  function fval(m, k) { return (m[k] || "").trim(); }
  function flabel(k, v) { return k === "by" ? who(v) : k === "status" ? ST_LABEL[v] : k === "kind" ? KIND_LABEL[v] : (v || "Not set"); }
  function matches(m, skip) {
    for (var i = 0; i < FACETS.length; i++) { var k = FACETS[i].k, s = state.sel[k]; if (k !== skip && s.size && !s.has(fval(m, k))) return false; }
    var q = state.q.trim().toLowerCase();
    if (q && [m.description, m.customer, m.location, m.machine, m.type, m.next, who(m.by)].join(" ").toLowerCase().indexOf(q) < 0) return false;
    return true;
  }
  function filtered() { return all().filter(function (m) { return matches(m); }); }
  function options(arr) { return arr.map(function (v) { return '<option value="' + esc(v) + '">'; }).join(""); }
  function distinct(arr) { var o = {}; arr.forEach(function (v) { v = String(v || "").trim(); if (v) o[v] = 1; }); return Object.keys(o).sort(natural); }
  function fillLists() {
    var docs = all();
    $("custList").innerHTML = options(distinct(state.machines.map(function (x) { return x.customer; }).concat(docs.map(function (d) { return d.customer; }), ["Office"])));
    $("locList").innerHTML = options(distinct(state.machines.map(function (x) { return x.location; }).concat(docs.map(function (d) { return d.location; }))));
    machineList();
  }
  // Machines of the chosen customer first; all machines when no customer is typed
  function machineList() {
    var c = $("e_customer").value.trim().toLowerCase();
    var ms = state.machines.filter(function (x) { return !c || String(x.customer || "").toLowerCase() === c; });
    $("machList").innerHTML = options(distinct(ms.map(function (x) { return [x.brand, x.model, x.serial].filter(Boolean).join(" "); })).slice(0, 400));
  }
  $("e_customer").addEventListener("input", machineList);

  try { var pv = JSON.parse(localStorage.getItem("tml.daily") || "null"); if (pv) { if (pv.group != null) state.group = pv.group; if (pv.range && pv.range !== "custom") state.range = pv.range; if (pv.view === "week") state.view = "week"; } } catch (e) {}
  function savePrefs() { try { localStorage.setItem("tml.daily", JSON.stringify({ group: state.group, range: state.range, view: state.view })); } catch (e) {} }
  $("fGroup").value = state.group; $("fRange").value = state.range;

  // ---------- render ----------
  function renderFacets(list) {
    var html = "";
    FACETS.forEach(function (f) {
      var k = f.k, sel = state.sel[k], counts = {}, vals = {};
      list.forEach(function (m) { vals[fval(m, k)] = 1; if (matches(m, k)) { var v = fval(m, k); counts[v] = (counts[v] || 0) + 1; } });
      var keys = Object.keys(vals).sort(function (a, b) { return (a === "") - (b === "") || natural(flabel(k, a), flabel(k, b)); });
      if (!keys.length) return;
      html += '<details class="facet" data-f="' + k + '"' + (state.shutFacet[k] ? '' : ' open') + '><summary><span>' + f.label + (sel.size ? '<span class="sel">' + sel.size + ' selected</span>' : '') + '</span></summary><div class="facet-list">';
      keys.forEach(function (v) {
        var n = counts[v] || 0;
        html += '<label class="opt' + (n ? '' : ' zero') + '"><input type="checkbox" data-f="' + k + '" data-v="' + esc(v) + '"' + (sel.has(v) ? ' checked' : '') + '><span class="t">' + esc(flabel(k, v)) + '</span><span class="n">' + n + '</span></label>';
      });
      html += '</div></details>';
    });
    $("facetBody").innerHTML = html;
  }
  function rowHtml(m) {
    var time = m.start ? m.start + (m.end ? "–" + m.end : "") : "", h = fmtHours(hours(m)), dash = '<span class="muted">—</span>';
    return '<tr class="row" data-id="' + esc(m._id) + '" tabindex="0">' +
      '<td class="c-kind">' + (m.type ? '<span class="kind">' + esc(m.type) + '</span>' : dash) + '</td>' +
      '<td data-l="Date" class="nw">' + (m.kind === "week" ? '<span class="pill wk">Weekly</span><div class="sub">' + esc(weekText(m.date)) + '</div>' : esc(fmtShort(m.date))) + '</td>' +
      '<td data-l="Engineer" class="nw">' + esc(who(m.by)) + '</td>' +
      '<td data-l="Time" class="nw mono">' + esc(time) + (h ? '<div class="sub">' + h + '</div>' : '') + '</td>' +
      '<td data-l="Customer">' + (m.customer ? '<div class="cust">' + esc(m.customer) + '</div>' : dash) + (m.location ? '<div class="sub">' + esc(m.location) + '</div>' : '') + '</td>' +
      '<td data-l="Machine">' + esc(m.machine) + '</td>' +
      '<td data-l="Action" class="c-action"><div class="desc">' + esc(m.description) + '</div>' + (m.photos.length ? '<div class="sub pcount">📷 ' + m.photos.length + (m.photos.length === 1 ? ' photo' : ' photos') + (function (t) { return t ? ' · ' + fmtSize(t) : ''; })(m.photos.reduce(function (t, p) { return t + photoBytes(p); }, 0)) + '</div>' : '') + '</td>' +
      '<td data-l="Status"><span class="pill ' + ST_PILL[m.status] + '">' + ST_LABEL[m.status] + '</span></td>' +
      '<td data-l="Next action" class="c-pc">' + (m.next ? '<span class="note">' + esc(m.next) + '</span>' : '') + '</td></tr>';
  }
  function render() {
    var list = all(), b = bounds();
    FACETS.forEach(function (f) { if (f.k === "status" || f.k === "kind") return; var have = {}; list.forEach(function (m) { have[fval(m, f.k)] = 1; }); state.sel[f.k].forEach(function (v) { if (!have[v]) state.sel[f.k].delete(v); }); });
    var rows = filtered();
    var days = {}, people = {}, hrs = 0, open = 0;
    rows.forEach(function (m) { days[m.date] = 1; people[m.by] = 1; hrs += hours(m); if (m.status !== "done") open++; });
    $("sCount").textContent = rows.length;
    $("sCountH").textContent = b[0] === b[1] ? fmtShort(b[0]) : fmtShort(b[0]) + " – " + fmtShort(b[1]);
    $("sDaysK").textContent = "Engineers reporting"; $("sDays").textContent = Object.keys(people).length; $("sDaysH").textContent = (state.view === "week" ? "in " : "on ") + Object.keys(days).length + (state.view === "week" ? (Object.keys(days).length === 1 ? " week" : " weeks") : (Object.keys(days).length === 1 ? " day" : " days"));
    var nd = 0, nw = 0; state.docs.forEach(function (m) { if (m.kind === "week") nw++; else nd++; });
    $("tabDayN").textContent = nd; $("tabWeekN").textContent = nw;
    $("tabDay").setAttribute("aria-selected", String(state.view === "day")); $("tabWeek").setAttribute("aria-selected", String(state.view === "week"));
    $("sHours").textContent = hrs ? Math.round(hrs * 10) / 10 : 0; $("sOpen").textContent = open;
    $("statOpen").classList.toggle("active", state.sel.status.size === 2 && state.sel.status.has("ongoing") && state.sel.status.has("pending"));
    $("lede").textContent = isAdmin() ? "Every engineer's activities. Everyone on the team can read them." : "Every engineer's activities. You can edit only your own.";

    renderFacets(list); fillLists();
    var chips = "";
    FACETS.forEach(function (f) { state.sel[f.k].forEach(function (v) { chips += '<button class="chip" type="button" data-f="' + f.k + '" data-v="' + esc(v) + '"><small>' + f.label + '</small>' + esc(flabel(f.k, v)) + '<b aria-hidden="true">×</b></button>'; }); });
    if (state.q.trim()) chips += '<button class="chip" type="button" data-f="q"><small>Search</small>' + esc(state.q.trim()) + '<b aria-hidden="true">×</b></button>';
    $("chips").innerHTML = chips; $("chips").hidden = !chips; $("btnClear").hidden = !chips;
    var nsel = FACETS.reduce(function (n, f) { return n + state.sel[f.k].size; }, 0);
    $("fCount").hidden = !nsel; $("fCount").textContent = nsel;

    var g = state.group;
    function gval(m) { return g === "date" ? sortKey(m) : fval(m, g); }
    rows.sort(function (a, c) {
      if (g && g !== "date") { var ga = flabel(g, gval(a)), gc = flabel(g, gval(c)), gr = (gval(a) === "") - (gval(c) === "") || natural(ga, gc); if (gr) return gr; }
      var ka = sortKey(a), kc = sortKey(c);
      return (ka < kc ? 1 : ka > kc ? -1 : 0) || natural(who(a.by), who(c.by)) || natural(a.start || "99", c.start || "99");
    });
    var html = "";
    if (!g) rows.forEach(function (m) { html += rowHtml(m); });
    else {
      var groups = [], cur = null;
      rows.forEach(function (m) { var v = gval(m); if (!cur || cur.v !== v) { cur = { v: v, items: [] }; groups.push(cur); } cur.items.push(m); });
      groups.forEach(function (gr) {
        var gid = g + "|" + gr.v, shut = state.shut.has(gid), gh = 0, gp = {};
        gr.items.forEach(function (m) { gh += hours(m); gp[m.by] = 1; });
        html += '<tr class="grp' + (shut ? ' shut' : '') + '" data-g="' + esc(gid) + '" tabindex="0"><td colspan="' + NCOLS + '"><div class="grp-in"><span class="car"></span><strong>' + esc(g === "date" ? (/W$/.test(gr.v) ? "Weekly report · " + weekText(gr.v.slice(0, 10), true) : fmtDay(gr.v)) : flabel(g, gr.v)) + '</strong>' +
          '<span class="n">' + gr.items.length + (gr.items.length === 1 ? ' activity' : ' activities') + (gh ? ' · ' + fmtHours(gh) : '') + (g !== "by" ? ' · ' + Object.keys(gp).length + (Object.keys(gp).length === 1 ? ' engineer' : ' engineers') : '') + '</span></div></td></tr>';
        if (!shut) gr.items.forEach(function (m) { html += rowHtml(m); });
      });
    }
    $("rows").innerHTML = html;
    $("count").textContent = rows.length === list.length ? list.length + (list.length === 1 ? " activity" : " activities") : rows.length + " of " + list.length + " activities";
    var empty = $("empty");
    if (!state.ready) empty.hidden = false;
    else if (!list.length) { empty.hidden = false; $("emptyTitle").textContent = "Nothing reported in this period"; $("emptyText").textContent = "Add an activity, or choose another period under Filters."; }
    else if (!rows.length) { empty.hidden = false; $("emptyTitle").textContent = "No activities match"; $("emptyText").textContent = "Clear the search or remove a filter."; }
    else empty.hidden = true;
  }

  // ---------- list events ----------
  $("fRange").addEventListener("change", function () {
    state.range = this.value; $("customRange").hidden = state.range !== "custom";
    if (state.range === "custom") { var b = bounds(); $("fFrom").value = state.from = state.from || b[0]; $("fTo").value = state.to = state.to || b[1]; }
    savePrefs(); load();
  });
  $("fFrom").addEventListener("change", function () { state.from = this.value; load(); });
  $("fTo").addEventListener("change", function () { state.to = this.value; load(); });
  $("facetBody").addEventListener("change", function (e) {
    var b = e.target; if (b.type !== "checkbox" || !b.dataset.f) return;
    var s = state.sel[b.dataset.f]; if (b.checked) s.add(b.dataset.v); else s.delete(b.dataset.v); render();
  });
  $("facetBody").addEventListener("toggle", function (e) { var d = e.target; if (d.dataset && d.dataset.f) state.shutFacet[d.dataset.f] = !d.open; }, true);
  $("btnClear").addEventListener("click", function () { FACETS.forEach(function (f) { state.sel[f.k].clear(); }); state.q = ""; $("q").value = ""; render(); });
  $("chips").addEventListener("click", function (e) {
    var b = e.target.closest(".chip"); if (!b) return;
    if (b.dataset.f === "q") { state.q = ""; $("q").value = ""; } else state.sel[b.dataset.f].delete(b.dataset.v);
    render();
  });
  $("statOpen").addEventListener("click", function () {
    var on = this.classList.contains("active"); state.sel.status.clear();
    if (!on) { state.sel.status.add("ongoing"); state.sel.status.add("pending"); }
    render();
  });
  function setView(v) { state.view = v; FACETS.forEach(function (f) { state.sel[f.k].clear(); }); savePrefs(); render(); }
  $("tabDay").addEventListener("click", function () { setView("day"); });
  $("tabWeek").addEventListener("click", function () { setView("week"); });
  $("fGroup").addEventListener("change", function () { state.group = this.value; savePrefs(); render(); });
  var qt; $("q").addEventListener("input", function () { var v = this.value; clearTimeout(qt); qt = setTimeout(function () { state.q = v; render(); }, 120); });
  function rowAction(e) {
    var gr = e.target.closest("tr.grp");
    if (gr) { var id = gr.dataset.g; if (state.shut.has(id)) state.shut.delete(id); else state.shut.add(id); render(); return; }
    var tr = e.target.closest("tr[data-id]"); if (tr) openEdit(tr.dataset.id);
  }
  $("rows").addEventListener("click", rowAction);
  $("rows").addEventListener("keydown", function (e) { if (e.key === "Enter") rowAction(e); });
  function drawer(open) { $("facets").classList.toggle("open", open); $("scrim").hidden = !open; }
  $("btnFacets").addEventListener("click", function () { drawer(true); });
  $("btnFacetsClose").addEventListener("click", function () { drawer(false); });
  $("scrim").addEventListener("click", function () { drawer(false); });
  $("dlgEdit").addEventListener("click", function (e) { if (e.target.closest("[data-close]") || e.target === this) this.close(); });

  // ---------- add / edit ----------
  var editing = null, MAP = { date: "date", start: "start", end: "end", customer: "customer", location: "location", machine: "machine", type: "type", status: "status", description: "description", next: "next" };
  // Daily or weekly entry
  var kind = "day";
  function mondayOf(d) { return addDays(d, -((d.getDay() + 6) % 7)); }
  function fillWeeks(keep) {
    var mon = mondayOf(new Date()), html = "", have = false;
    for (var i = -1; i < 12; i++) {
      var a = iso(addDays(mon, -7 * i)); if (a === keep) have = true;
      html += '<option value="' + a + '">' + (i === 0 ? "This week: " : i === 1 ? "Last week: " : i === -1 ? "Next week: " : "") + weekText(a, true) + '</option>';
    }
    if (keep && !have) html += '<option value="' + keep + '">' + weekText(keep, true) + '</option>';
    $("e_week").innerHTML = html;
  }
  function setKind(k) {
    kind = k;
    Array.prototype.forEach.call($("kindSeg").children, function (b) { b.setAttribute("aria-checked", String(b.dataset.kind === k)); });
    $("editForm").classList.toggle("is-week", k === "week");
    $("e_dateL").hidden = k === "week"; $("e_weekL").hidden = k !== "week";
    if (!editing) $("editMeta").textContent = k === "week" ? "Saved under your name for the whole week. Add one entry for each job you did that week." : "This is saved under your name. Add one entry for each job or visit of the day.";
    $("btnMoreAct").lastChild.textContent = k === "week" ? "Add another job this week" : "Add another activity";
    $("moreHelp").textContent = k === "week" ? "Did more than one job this week? Add each one here and save them all together." : "Did more than one job this day? Add each one here and save them all together.";
    syncSaveLabel(); syncByMeta();
  }
  $("kindSeg").addEventListener("click", function (e) { var b = e.target.closest("[data-kind]"); if (b && !editing) setKind(b.dataset.kind); });
  function openEdit(id) {
    var m = id ? state.docs.get(id) : null; editing = m;
    var ok = m ? canEdit(m) : true, b = bounds(), today = iso(new Date());
    var preset = { date: today >= b[0] && today <= b[1] ? today : b[1], status: "done", customer: state.sel.customer.size === 1 ? Array.from(state.sel.customer)[0] : "" };
    Object.keys(MAP).forEach(function (f) { var el = $("e_" + f); el.value = m ? m[f] : (preset[f] || ""); el.disabled = !ok; });
    machineList();
    $("editTitle").textContent = m ? (isAdmin() || m.by !== state.user.id ? who(m.by) + " · " : "") + fmtShort(m.date) : "Add activity";
    $("editMeta").textContent = m ? ((m.updatedAt ? "Last changed " + new Date(m.updatedAt).toLocaleString("en-GB") + ". " : "") + (ok ? "" : "View only: you can edit your own activities.")) : "This is saved under your name. Add one entry for each job or visit of the day.";
    $("btnSave").hidden = !ok;
    fillWeeks(m && m.kind === "week" ? m.date : ""); $("e_week").value = m && m.kind === "week" ? m.date : iso(mondayOf(new Date())); $("e_week").disabled = !ok;
    $("kindSeg").hidden = !!m; setKind(m ? m.kind : state.view);
    if (m && m.kind === "week") $("editTitle").textContent = (isAdmin() || m.by !== state.user.id ? who(m.by) + " · " : "") + "Week " + weekText(m.date);
    fillEngineers(m); photoField($("e_photos"), m ? m.photos : [], ok);
    $("extraActs").innerHTML = ""; $("moreActs").hidden = !!m; syncSaveLabel();
    $("delArea").innerHTML = (m && ok) ? '<button class="btn danger" type="button" id="btnDel">Delete</button>' : '';
    $("dlgEdit").showModal();
    if (!m) setTimeout(function () { $("e_customer").focus(); }, 30);
  }
  $("btnAdd").addEventListener("click", function () { openEdit(null); });

  // Admins choose whose activity it is (default: themselves); everyone else always writes their own
  function fillEngineers(m) {
    var adm = isAdmin();
    $("e_byL").hidden = !adm;
    if (!adm) return;
    var cur = m ? m.by : (state.sel.by.size === 1 ? Array.from(state.sel.by)[0] : state.user.id);
    var ids = Object.keys(state.people);
    if (ids.indexOf(state.user.id) < 0) ids.push(state.user.id);
    if (cur && ids.indexOf(cur) < 0) ids.push(cur);
    ids.sort(function (a, b) { return natural(who(a), who(b)); });
    $("e_by").innerHTML = ids.map(function (id) { return '<option value="' + esc(id) + '">' + esc(who(id) + (id === state.user.id ? " (me)" : "")) + '</option>'; }).join("");
    $("e_by").value = cur || state.user.id;
    syncByMeta();
  }
  function syncByMeta() {
    if (editing || !isAdmin()) return;
    var mine = $("e_by").value === state.user.id;
    $("editMeta").textContent = mine ? (kind === "week" ? "Saved under your name for the whole week." : "This is saved under your name. Add one entry for each job or visit of the day.")
                                     : "Saved under " + who($("e_by").value) + "'s name. They can see and edit it too.";
  }
  $("e_by").addEventListener("change", syncByMeta);

  // ---------- more than one activity in one go (new entries only) ----------
  function syncSaveLabel() {
    var n = $("extraActs").children.length;
    $("btnSave").textContent = n ? "Save " + (n + 1) + " activities" : kind === "week" ? "Save weekly report" : "Save activity";
    Array.prototype.forEach.call($("extraActs").children, function (el, i) { el.querySelector(".xact-n").textContent = "Activity " + (i + 2); });
  }
  $("btnMoreAct").addEventListener("click", function () {
    var prev = $("extraActs").lastElementChild, val = function (sel, main) { return prev ? prev.querySelector(sel).value : $(main).value; };
    var el = document.createElement("section"); el.className = "xact";
    el.innerHTML =
      '<div class="xact-head"><strong class="xact-n"></strong><button class="x" type="button" data-x="del" aria-label="Remove this activity" title="Remove this activity">×</button></div>' +
      '<fieldset>' +
        '<label>Start<input type="time" data-x="start" value="' + esc(val("[data-x=end]", "e_end")) + '"></label>' +
        '<label>End<input type="time" data-x="end"></label>' +
        '<label>Customer<input data-x="customer" list="custList" autocomplete="off" maxlength="160" value="' + esc(val("[data-x=customer]", "e_customer")) + '"></label>' +
        '<label>Location<input data-x="location" list="locList" autocomplete="off" maxlength="160" value="' + esc(val("[data-x=location]", "e_location")) + '"></label>' +
        '<label>Machine<input data-x="machine" list="machList" autocomplete="off" maxlength="200" placeholder="Brand, model, serial"></label>' +
        '<label>Type of activity<input data-x="type" list="typeList" autocomplete="off" maxlength="60" placeholder="Service, Calibration…"></label>' +
        '<label>Status<select data-x="status"><option value="done">Done</option><option value="ongoing">Ongoing</option><option value="pending">Pending</option></select></label>' +
        '<label class="wide"><span class="req">Action (what was done)</span><textarea data-x="description" rows="3" maxlength="4000"></textarea></label>' +
        '<label class="wide">Next action<textarea data-x="next" rows="2" maxlength="2000"></textarea></label>' +
        '<div class="wide photofield" data-x="photos"></div>' +
      '</fieldset>';
    $("extraActs").appendChild(el); photoField(el.querySelector("[data-x=photos]"), [], true); syncSaveLabel();
    el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    setTimeout(function () { el.querySelector("[data-x=machine]").focus(); }, 60);
  });
  $("extraActs").addEventListener("click", function (e) {
    var b = e.target.closest("[data-x=del]"); if (!b) return; b.closest(".xact").remove(); syncSaveLabel();
  });
  $("delArea").addEventListener("click", function (e) {
    if (e.target.id === "btnDel") $("delArea").innerHTML = '<span class="confirm">Delete this activity? <button class="btn danger solid" type="button" id="btnDelYes">Delete</button><button class="btn" type="button" id="btnDelNo">Keep</button></span>';
    if (e.target.id === "btnDelNo") $("delArea").innerHTML = '<button class="btn danger" type="button" id="btnDel">Delete</button>';
    if (e.target.id === "btnDelYes") sb.from("daily_reports").delete().eq("id", editing._id).then(function (res) {
      if (res.error) { toast("Could not delete: " + errText(res.error)); return; }
      removePhotos(editing.photos);
      state.docs.delete(editing._id); render(); todayBar(); $("dlgEdit").close(); toast("Activity deleted");
    });
  });
  $("editForm").addEventListener("submit", function (e) {
    e.preventDefault();
    if (editing && !canEdit(editing)) return;
    var v = function (id) { return $("e_" + id).value.trim(); }, wk = kind === "week";
    if (!wk && !v("date")) { toast("Choose the date."); return; }
    if (wk && !$("e_week").value) { toast("Choose the week."); return; }
    if (!v("description")) { toast("Write what was done."); return; }
    var row = { report_date: wk ? $("e_week").value : v("date"), start_time: wk ? null : v("start") || null, end_time: wk ? null : v("end") || null, customer: v("customer"), location: v("location"), machine: v("machine"),
                activity_type: v("type"), status: v("status") || "done", description: v("description"), next_action: v("next") };
    if (wk) row.report_kind = "week";     // daily entries leave it out, so they also work before daily.sql is re-run
    // An admin's choice of engineer; sent only when it is someone else (or changed), so own entries work as before
    var byPick = isAdmin() && $("e_by").value ? $("e_by").value : "";
    if (byPick && (editing ? byPick !== editing.by : byPick !== state.user.id)) row.created_by = byPick;
    var rowsToAdd = [row];
    if (!editing) {
      var blocks = $("extraActs").querySelectorAll(".xact");
      for (var i = 0; i < blocks.length; i++) {
        var x = function (k) { return blocks[i].querySelector("[data-x=" + k + "]").value.trim(); };
        if (!x("description")) { toast("Write what was done for activity " + (i + 2) + ", or remove it."); blocks[i].querySelector("[data-x=description]").focus(); return; }
        var extra = { report_date: row.report_date, start_time: wk ? null : x("start") || null, end_time: wk ? null : x("end") || null, customer: x("customer"), location: x("location"), machine: x("machine"),
                         activity_type: x("type"), status: x("status") || "done", description: x("description"), next_action: x("next") };
        if (wk) extra.report_kind = "week";
        if (row.created_by) extra.created_by = row.created_by;
        rowsToAdd.push(extra);
      }
    }
    // Photos: one field per activity, in the same order as rowsToAdd
    var fields = [$("e_photos")._photos];
    if (!editing) Array.prototype.forEach.call($("extraActs").querySelectorAll(".xact [data-x=photos]"), function (f) { fields.push(f._photos); });
    var btn = $("btnSave"), label = btn.textContent, uploaded = [];
    btn.disabled = true;
    var pending = fields.reduce(function (n, f) { return n + (f ? f.add.length : 0); }, 0);
    if (pending) btn.textContent = "Uploading " + pending + (pending === 1 ? " photo…" : " photos…");
    fields.reduce(function (p, f, i) {
      return p.then(function () {
        if (!f) return;
        return uploadPhotos(f).then(function (paths) {
          uploaded = uploaded.concat(paths.added);
          if (paths.all.length || (editing && editing.photos.length)) rowsToAdd[i].photos = paths.all;
        });
      });
    }, Promise.resolve()).then(function () {
      btn.textContent = label;
      return editing ? sb.from("daily_reports").update(row).eq("id", editing._id).select() : sb.from("daily_reports").insert(rowsToAdd).select();
    }).then(function (res) {
      if (res.error) { removePhotos(uploaded); toast("Could not save: " + errText(res.error)); return; }
      if (editing && fields[0]) removePhotos(fields[0].removed);
      var b = bounds(), list = res.data || [], inside = true;
      list.forEach(function (r) { var o = fromRow(r); if (inRange(o, b)) state.docs.set(o._id, o); else { state.docs.delete(o._id); inside = false; } });
      render(); todayBar(); $("dlgEdit").close();
      toast(!inside ? "Saved. It is outside the period shown, so change the period to see it."
                    : editing ? "Activity updated" : list.length > 1 ? list.length + " activities added" : "Activity added");
    }).catch(function (err) {
      removePhotos(uploaded);
      toast("Could not save: " + photoErr(err));
    }).finally(function () { btn.disabled = false; btn.textContent = label; });
  });

  // ---------- photos (Supabase Storage, bucket "daily-photos") ----------
  var MAX_PHOTOS = 3, BUCKET = "daily-photos", signed = {};
  function photoErr(err) {
    var m = (err && (err.message || err.error)) || String(err);
    if (/bucket not found|not found|photos/i.test(m) && !/read/i.test(m)) return "Photos are not switched on yet. An admin has to run supabase/daily-photos.sql in the Supabase SQL Editor.";
    return m;
  }
  // Shrink a phone photo to at most 1600 px on its long side, as JPEG (about 200–300 KB)
  function compress(file) {
    return new Promise(function (res, rej) {
      var url = URL.createObjectURL(file), img = new Image();
      img.onload = function () {
        var k = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight)), c = document.createElement("canvas");
        c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
        var g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        c.toBlob(function (b) { if (b) res(b); else rej(new Error("Could not read that photo.")); }, "image/jpeg", 0.75);
      };
      img.onerror = function () { URL.revokeObjectURL(url); rej(new Error("That file is not a photo this browser can read.")); };
      img.src = url;
    });
  }
  // Photos are in a public bucket: each one has a fixed link
  function photoUrl(p) { if (!signed[p]) signed[p] = sb.storage.from(BUCKET).getPublicUrl(p).data.publicUrl; return signed[p]; }
  // The size is part of the file name (…-245760.jpg), so it shows without downloading the photo
  function photoBytes(p) { var m = /-(\d+)\.jpg$/.exec(p); return m ? +m[1] : 0; }
  function fmtSize(b) { return b >= 1048576 ? (Math.round(b / 104857.6) / 10) + " MB" : Math.max(1, Math.round(b / 1024)) + " KB"; }
  // A photo field: shows the saved photos, lets you add (up to 3 in all) and remove them
  function photoField(box, existing, editable) {
    var st = { keep: (existing || []).slice(), add: [], removed: [] };
    box._photos = editable ? st : null;
    box.hidden = !editable && !st.keep.length;
    function draw() {
      var n = st.keep.length + st.add.length, total = st.keep.reduce(function (t, p) { return t + photoBytes(p); }, 0) + st.add.reduce(function (t, a) { return t + a.blob.size; }, 0);
      var html = '<span class="plabel">Photos <small>' + (editable ? "up to " + MAX_PHOTOS : "") + (total ? " · " + fmtSize(total) + " in all" : "") + '</small></span><div class="pgrid">';
      st.keep.forEach(function (p, i) {
        var u = photoUrl(p), sz = photoBytes(p);
        html += '<div class="pthumb"><a href="' + esc(u) + '" target="_blank" rel="noopener"><img src="' + esc(u) + '" alt="Photo ' + (i + 1) + '"></a>' +
                (sz ? '<span class="psize">' + fmtSize(sz) + '</span>' : '') +
                (editable ? '<button type="button" class="pdel" data-keep="' + i + '" aria-label="Remove photo">×</button>' : '') + '</div>';
      });
      st.add.forEach(function (a, i) {
        html += '<div class="pthumb new"><img src="' + a.url + '" alt="New photo ' + (i + 1) + '"><span class="psize">' + fmtSize(a.blob.size) + (a.orig ? ' <s>' + fmtSize(a.orig) + '</s>' : '') + '</span><button type="button" class="pdel" data-add="' + i + '" aria-label="Remove photo">×</button></div>';
      });
      if (editable && n < MAX_PHOTOS) html += '<button type="button" class="padd"><span>📷</span>Add photo</button>';
      html += '</div><input type="file" accept="image/*" multiple hidden>';
      box.innerHTML = html;
    }
    box.onclick = function (e) {
      var d = e.target.closest(".pdel");
      if (d) {
        if (d.dataset.keep != null) st.removed.push(st.keep.splice(+d.dataset.keep, 1)[0]);
        else { var a = st.add.splice(+d.dataset.add, 1)[0]; URL.revokeObjectURL(a.url); }
        draw(); return;
      }
      if (e.target.closest(".padd")) box.querySelector("input[type=file]").click();
    };
    box.onchange = function (e) {
      if (e.target.type !== "file") return;
      var files = Array.prototype.slice.call(e.target.files || []), room = MAX_PHOTOS - st.keep.length - st.add.length;
      if (files.length > room) toast("Up to " + MAX_PHOTOS + " photos per activity. Only the first " + room + " were added.");
      files.slice(0, room).reduce(function (p, f) {
        return p.then(function () { return compress(f).then(function (b) { st.add.push({ blob: b, url: URL.createObjectURL(b), orig: f.size > b.size ? f.size : 0 }); draw(); }); });
      }, Promise.resolve()).catch(function (err) { toast(err.message || String(err)); });
    };
    draw();
  }
  function uploadPhotos(st) {
    var me = state.user.id, added = [];
    return st.add.reduce(function (p, a) {
      return p.then(function () {
        var path = me + "/" + Date.now() + "-" + Math.random().toString(36).slice(2, 8) + "-" + a.blob.size + ".jpg";
        return sb.storage.from(BUCKET).upload(path, a.blob, { contentType: "image/jpeg", upsert: false }).then(function (res) {
          if (res.error) throw res.error;
          added.push(path);
        });
      });
    }, Promise.resolve()).then(function () { return { added: added, all: st.keep.concat(added) }; },
                               function (err) { removePhotos(added); throw err; });
  }
  function removePhotos(paths) { if (paths && paths.length) sb.storage.from(BUCKET).remove(paths).then(function () {}, function () {}); }

  // ---------- export ----------
  // A formatted workbook (ExcelJS): report header, styled table, totals, sign-off block and a per-engineer summary.
  // If that library did not load, the plain export below is used instead.
  var INK = "FF111A27", BLUE = "FF1F56C9", LINE = "FFD9DFE8", SOFT = "FFF4F6F9", MUTED = "FF5D6B7E";
  var ST_FILL = { done: "FFDDF1E7", ongoing: "FFFBEFD4", pending: "FFE9EDF2" }, ST_INK = { done: "FF18774D", ongoing: "FF8F5600", pending: "FF5D6B7E" };
  function exportRows() {
    var rows = filtered();
    rows.sort(function (a, c) { return natural(sortKey(a), sortKey(c)) || natural(who(a.by), who(c.by)) || natural(a.start || "99", c.start || "99"); });
    return rows;
  }
  function fileName() { var b = bounds(); return "Tamura_Daily_Report_" + b[0] + (b[0] === b[1] ? "" : "_to_" + b[1]) + ".xlsx"; }
  function longDate(s) { return parse(s).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }); }
  function xlDate(s) { var p = String(s).split("-"); return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])); }
  function filterNote() {
    var parts = [];
    FACETS.forEach(function (f) { var s = state.sel[f.k]; if (s.size) parts.push(f.label + ": " + Array.from(s).map(function (v) { return flabel(f.k, v); }).join(", ")); });
    if (state.q.trim()) parts.push('Search: "' + state.q.trim() + '"');
    return parts.length ? parts.join("  |  ") : "All engineers, customers and activity types";
  }
  // Photos for the Excel file: downloaded from Storage and shrunk to small JPEGs, so the file stays light
  function exportPhotos(rows) {
    var paths = []; rows.forEach(function (m) { paths = paths.concat(m.photos || []); });
    var out = {};
    if (!paths.length) return Promise.resolve(out);
    toast("Adding " + paths.length + (paths.length === 1 ? " photo" : " photos") + " to the Excel file…");
    return paths.reduce(function (p, path) {
      return p.then(function () {
        return sb.storage.from(BUCKET).download(path).then(function (res) {
          if (res.error || !res.data) return;
          return new Promise(function (done) {
            var url = URL.createObjectURL(res.data), img = new Image();
            img.onload = function () {
              var k = Math.min(1, 360 / img.naturalHeight, 480 / img.naturalWidth), c = document.createElement("canvas");
              c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
              c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
              out[path] = { data: c.toDataURL("image/jpeg", 0.72).split(",")[1], w: c.width, h: c.height };
              URL.revokeObjectURL(url); done();
            };
            img.onerror = function () { URL.revokeObjectURL(url); done(); };
            img.src = url;
          });
        }, function () {});
      });
    }, Promise.resolve()).then(function () { return out; });
  }
  function styledExport(rows, pics) {
    pics = pics || {};
    var hasPics = rows.some(function (m) { return (m.photos || []).some(function (p) { return pics[p]; }); });
    var b = bounds(), me = who(state.user.id), now = new Date();
    var wb = new ExcelJS.Workbook();
    wb.creator = me; wb.created = now; wb.title = "Daily Activity Report";
    var thin = { style: "thin", color: { argb: LINE } }, box = { top: thin, left: thin, bottom: thin, right: thin };
    function fill(argb) { return { type: "pattern", pattern: "solid", fgColor: { argb: argb } }; }
    function titleBlock(ws, lastCol, subtitle) {
      ws.mergeCells(1, 1, 1, lastCol); ws.mergeCells(2, 1, 2, lastCol); ws.mergeCells(3, 1, 3, lastCol); ws.mergeCells(4, 1, 4, lastCol);
      var c1 = ws.getCell(1, 1); c1.value = "PT. TAMURA TRADE INDONESIA"; c1.font = { name: "Calibri", size: 11, bold: true, color: { argb: BLUE } };
      var c2 = ws.getCell(2, 1); c2.value = subtitle; c2.font = { name: "Calibri", size: 20, bold: true, color: { argb: INK } };
      var c3 = ws.getCell(3, 1); c3.value = "Period: " + (b[0] === b[1] ? longDate(b[0]) : longDate(b[0]) + " to " + longDate(b[1])) + "     |     " + filterNote();
      c3.font = { name: "Calibri", size: 11, color: { argb: INK } };
      var c4 = ws.getCell(4, 1); c4.value = "Exported " + now.toLocaleString("en-GB", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" }) + " by " + me;
      c4.font = { name: "Calibri", size: 10, italic: true, color: { argb: MUTED } };
      ws.getRow(1).height = 18; ws.getRow(2).height = 30; ws.getRow(3).height = 18; ws.getRow(4).height = 16; ws.getRow(5).height = 8;
      [1, 2, 3, 4].forEach(function (r) { ws.getCell(r, 1).alignment = { vertical: "middle", horizontal: "left" }; });
    }
    function headRow(ws, r, labels) {
      var row = ws.getRow(r); row.height = 24;
      labels.forEach(function (t, i) {
        var c = row.getCell(i + 1); c.value = t;
        c.font = { name: "Calibri", size: 11, bold: true, color: { argb: "FFFFFFFF" } };
        c.fill = fill(INK); c.border = box; c.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
      });
    }
    var page = { paperSize: 9, orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0,
                 margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.6, header: 0.3, footer: 0.3 } };

    // ----- Sheet 1: the activities -----
    var HEAD = ["No", "Date", "Day", "Engineer", "Start", "End", "Hours", "Customer", "Location", "Type", "Machine", "Action", "Status", "Next action"];
    var WID = [5, 16, 6, 18, 7, 7, 7, 24, 16, 18, 26, 52, 11, 32];
    var PIC_H = 96, PIC_W = 128, PIC_COL = 3 * (PIC_W + 6) / 7 + 2;          // three photos side by side in the last column
    if (hasPics) { HEAD.push("Photos"); WID.push(Math.ceil(PIC_COL)); }
    var N = HEAD.length, HR = 6, colPx = Math.ceil(PIC_COL) * 7 + 5;
    var ws = wb.addWorksheet("Daily report", { views: [{ state: "frozen", ySplit: HR, showGridLines: false }], pageSetup: page });
    ws.columns = WID.map(function (w) { return { width: w }; });
    titleBlock(ws, N, "Daily Activity Report");
    headRow(ws, HR, HEAD);
    var total = 0, r = HR;
    rows.forEach(function (m, i) {
      r++;
      var h = hours(m); total += h;
      var vals = [i + 1, m.kind === "week" ? weekText(m.date) : xlDate(m.date), m.kind === "week" ? "Week" : parse(m.date).toLocaleDateString("en-GB", { weekday: "short" }), who(m.by), m.start, m.end, h ? Math.round(h * 100) / 100 : null,
                  m.customer, m.location, m.type, m.machine, m.description, ST_LABEL[m.status], m.next];
      var row = ws.getRow(r);
      vals.forEach(function (v, k) {
        var c = row.getCell(k + 1); c.value = (v === "" || v == null) ? null : v;
        c.font = { name: "Calibri", size: 10.5, color: { argb: INK } };
        c.border = box;
        c.alignment = { vertical: "top", wrapText: true, horizontal: (k <= 2 || (k >= 4 && k <= 6) || k === 12) ? "center" : "left" };
        if (i % 2 === 1) c.fill = fill(SOFT);
      });
      row.getCell(2).numFmt = "dd mmm yyyy"; row.getCell(7).numFmt = "0.0";
      var sc = row.getCell(13); sc.fill = fill(ST_FILL[m.status]); sc.font = { name: "Calibri", size: 10.5, bold: true, color: { argb: ST_INK[m.status] } };
      if (hasPics) {
        var pc = row.getCell(N); pc.border = box; if (i % 2 === 1) pc.fill = fill(SOFT);
        var x = 4;
        (m.photos || []).forEach(function (p) {
          var im = pics[p]; if (!im) return;
          var hgt = PIC_H, wid = Math.min(PIC_W, Math.round(im.w * PIC_H / im.h)); if (wid < im.w * PIC_H / im.h) hgt = Math.round(im.h * wid / im.w);
          var id = wb.addImage({ base64: im.data, extension: "jpeg" });
          ws.addImage(id, { tl: { col: N - 1 + x / colPx, row: r - 1 + 0.08 }, ext: { width: wid, height: hgt }, editAs: "oneCell" });
          x += wid + 6;
        });
        if (x > 4) row.height = Math.max(row.height || 15, (PIC_H + 10) * 0.75);
      }
    });
    r++;
    var tr = ws.getRow(r); tr.height = 22;
    ws.mergeCells(r, 1, r, 6);
    for (var k = 1; k <= N; k++) { var tc = tr.getCell(k); tc.fill = fill("FFE3EBFB"); tc.border = box; tc.font = { name: "Calibri", size: 11, bold: true, color: { argb: INK } }; tc.alignment = { vertical: "middle", horizontal: k === 7 ? "center" : "left" }; }
    tr.getCell(1).value = "Total: " + rows.length + (rows.length === 1 ? " activity" : " activities"); tr.getCell(1).alignment = { vertical: "middle", horizontal: "right" };
    tr.getCell(7).value = Math.round(total * 100) / 100; tr.getCell(7).numFmt = "0.0";
    tr.getCell(8).value = "hours logged";
    // sign-off
    r += 3;
    [[2, "Prepared by", me], [11, "Approved by", ""]].forEach(function (sg) {
      var c = ws.getCell(r, sg[0]); c.value = sg[1]; c.font = { name: "Calibri", size: 10.5, color: { argb: MUTED } };
      ws.mergeCells(r + 4, sg[0], r + 4, sg[0] + 2);
      var n = ws.getCell(r + 4, sg[0]); n.value = sg[2] || null; n.font = { name: "Calibri", size: 11, bold: true, color: { argb: INK } };
      n.border = { top: { style: "thin", color: { argb: INK } } }; n.alignment = { horizontal: "left", vertical: "top" };
      var d = ws.getCell(r + 5, sg[0]); d.value = "Date:"; d.font = { name: "Calibri", size: 10, color: { argb: MUTED } };
    });
    ws.autoFilter = { from: { row: HR, column: 1 }, to: { row: HR, column: N } };
    ws.pageSetup.printTitlesRow = HR + ":" + HR;
    ws.headerFooter.oddFooter = "&L&8PT. Tamura Trade Indonesia - Daily Activity Report&R&8Page &P of &N";

    // ----- Sheet 2: summary per engineer -----
    var HEAD2 = ["No", "Engineer", "Activities", "Days reported", "Hours", "Done", "Ongoing", "Pending", "Customers visited"], N2 = HEAD2.length;
    var ws2 = wb.addWorksheet("Summary", { views: [{ state: "frozen", ySplit: HR, showGridLines: false }], pageSetup: page });
    ws2.columns = [5, 24, 12, 14, 10, 10, 10, 10, 60].map(function (w) { return { width: w }; });
    titleBlock(ws2, N2, "Daily Activity Report: Summary per Engineer");
    headRow(ws2, HR, HEAD2);
    var per = {};
    rows.forEach(function (m) {
      var p = per[m.by] || (per[m.by] = { name: who(m.by), n: 0, days: {}, h: 0, done: 0, ongoing: 0, pending: 0, cust: {} });
      p.n++; p.days[m.date] = 1; p.h += hours(m); p[m.status]++; if (m.customer) p.cust[m.customer] = 1;
    });
    var list = Object.keys(per).map(function (id) { return per[id]; }).sort(function (a, c) { return natural(a.name, c.name); });
    var r2 = HR, sum = { n: 0, h: 0, done: 0, ongoing: 0, pending: 0 };
    list.forEach(function (p, i) {
      r2++;
      var vals = [i + 1, p.name, p.n, Object.keys(p.days).length, Math.round(p.h * 100) / 100, p.done, p.ongoing, p.pending, Object.keys(p.cust).sort(natural).join(", ")];
      var row = ws2.getRow(r2);
      vals.forEach(function (v, k) {
        var c = row.getCell(k + 1); c.value = v === "" ? null : v;
        c.font = { name: "Calibri", size: 10.5, color: { argb: INK } }; c.border = box;
        c.alignment = { vertical: "top", wrapText: true, horizontal: (k === 1 || k === 8) ? "left" : "center" };
        if (i % 2 === 1) c.fill = fill(SOFT);
      });
      row.getCell(5).numFmt = "0.0";
      sum.n += p.n; sum.h += p.h; sum.done += p.done; sum.ongoing += p.ongoing; sum.pending += p.pending;
    });
    r2++;
    var t2 = ws2.getRow(r2); t2.height = 22;
    [null, "Total", sum.n, null, Math.round(sum.h * 100) / 100, sum.done, sum.ongoing, sum.pending, null].forEach(function (v, k) {
      var c = t2.getCell(k + 1); c.value = v; c.fill = fill("FFE3EBFB"); c.border = box;
      c.font = { name: "Calibri", size: 11, bold: true, color: { argb: INK } }; c.alignment = { vertical: "middle", horizontal: k === 1 ? "left" : "center" };
    });
    t2.getCell(5).numFmt = "0.0";
    ws2.pageSetup.printTitlesRow = HR + ":" + HR;
    ws2.headerFooter.oddFooter = "&L&8PT. Tamura Trade Indonesia - Daily Activity Report&R&8Page &P of &N";

    return wb.xlsx.writeBuffer().then(function (buf) {
      var blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      var a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = fileName();
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
    });
  }
  function plainExport(rows) {
    var aoa = [["Date", "Engineer", "Start", "End", "Hours", "Customer", "Location", "Type", "Machine", "Action", "Status", "Next action", "Photos"]];
    rows.forEach(function (m) { var h = hours(m); aoa.push([m.kind === "week" ? "Week " + m.date + " to " + weekEnd(m) : m.date, who(m.by), m.start, m.end, h ? Math.round(h * 100) / 100 : "", m.customer, m.location, m.type, m.machine, m.description, ST_LABEL[m.status], m.next, (m.photos || []).length || ""]); });
    var ws = XLSX.utils.aoa_to_sheet(aoa);
    ws["!cols"] = [11, 18, 7, 7, 7, 24, 18, 20, 28, 60, 10, 36].map(function (w) { return { wch: w }; });
    var wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "Daily report");
    XLSX.writeFile(wb, fileName());
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
    exportPhotos(rows).catch(function () { return {}; }).then(function (pics) { return styledExport(rows, pics); }).catch(fallback).finally(function () { btn.disabled = false; });
  });

  render();
})();
