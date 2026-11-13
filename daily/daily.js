/* Tamura Daily Report — each engineer's activities, day by day (Supabase auth + database) */
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var cfg = window.APP_CONFIG || {};
  var ST_LABEL = { done: "Done", ongoing: "Ongoing", pending: "Pending" }, ST_PILL = { done: "ok", ongoing: "warn", pending: "none" };
  var FACETS = [{ k: "by", label: "Engineer" }, { k: "customer", label: "Customer" }, { k: "type", label: "Type of activity" }, { k: "status", label: "Status" }];
  var NCOLS = 8;

  var state = { docs: new Map(), q: "", group: "date", range: "week", from: "", to: "", shut: new Set(), shutFacet: {},
                sel: { by: new Set(), customer: new Set(), type: new Set(), status: new Set() },
                people: {}, machines: [], role: null, user: null, ready: false, channel: null };
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
    if (err && (err.code === "42501" || /row-level security|permission/i.test(m))) return "You don't have permission for this. You can only change your own activities.";
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
      if (window.APP_IS_OWNER) window.APP_IS_OWNER(user.email).then(function (ok) {
        document.querySelectorAll("[data-owner]").forEach(function (a) { a.hidden = !ok; });
      });
      if (!isAdmin()) { $("fGroup").querySelector('option[value="by"]').remove(); }
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
      by: r.created_by || "", updatedAt: r.updated_at };
  }
  // Names for the Engineer column, and customers / machines from the Machine List as suggestions
  function loadLookups() {
    sb.rpc("people").then(function (pp) {
      if (pp.error) return; var p = {}; (pp.data || []).forEach(function (u) { p[u.id] = u.name; }); state.people = p; if (state.ready) render();
    });
    sb.from("machines").select("customer,location,brand,model,serial").range(0, 4999).then(function (res) {
      if (res.error) return; state.machines = res.data || []; fillLists();
    });
  }
  var loadSeq = 0;
  function load() {
    var b = bounds(), seq = ++loadSeq;
    return sb.from("daily_reports").select("*").gte("report_date", b[0]).lte("report_date", b[1]).order("report_date", { ascending: false }).range(0, 4999).then(function (res) {
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
      var m = new Map(); res.data.forEach(function (r) { var o = fromRow(r); m.set(o._id, o); });
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
  function all() { return Array.from(state.docs.values()); }
  function who(id) { if (!id) return "Former user"; return state.people[id] || (state.user && id === state.user.id ? "You" : "Former user"); }
  function fval(m, k) { return (m[k] || "").trim(); }
  function flabel(k, v) { return k === "by" ? who(v) : k === "status" ? ST_LABEL[v] : (v || "Not set"); }
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

  try { var pv = JSON.parse(localStorage.getItem("tml.daily") || "null"); if (pv) { if (pv.group != null) state.group = pv.group; if (pv.range && pv.range !== "custom") state.range = pv.range; } } catch (e) {}
  function savePrefs() { try { localStorage.setItem("tml.daily", JSON.stringify({ group: state.group, range: state.range })); } catch (e) {} }
  $("fGroup").value = state.group; $("fRange").value = state.range;

  // ---------- render ----------
  function renderFacets(list) {
    var html = "";
    FACETS.forEach(function (f) {
      var k = f.k, sel = state.sel[k], counts = {}, vals = {};
      if (k === "by" && !isAdmin()) return;
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
      '<td class="c-kind">' + (m.type ? '<span class="kind">' + esc(m.type) + '</span>' : '') + '<div class="desc">' + esc(m.description) + '</div></td>' +
      '<td data-l="Date" class="nw">' + esc(fmtShort(m.date)) + '</td>' +
      '<td data-l="Engineer" class="nw">' + esc(who(m.by)) + '</td>' +
      '<td data-l="Time" class="nw mono">' + esc(time) + (h ? '<div class="sub">' + h + '</div>' : '') + '</td>' +
      '<td data-l="Customer">' + (m.customer ? '<div class="cust">' + esc(m.customer) + '</div>' : dash) + (m.location ? '<div class="sub">' + esc(m.location) + '</div>' : '') + '</td>' +
      '<td data-l="Machine">' + esc(m.machine) + '</td>' +
      '<td data-l="Status"><span class="pill ' + ST_PILL[m.status] + '">' + ST_LABEL[m.status] + '</span></td>' +
      '<td data-l="Next action" class="c-pc">' + (m.next ? '<span class="note">' + esc(m.next) + '</span>' : '') + '</td></tr>';
  }
  function render() {
    var list = all(), b = bounds();
    FACETS.forEach(function (f) { if (f.k === "status") return; var have = {}; list.forEach(function (m) { have[fval(m, f.k)] = 1; }); state.sel[f.k].forEach(function (v) { if (!have[v]) state.sel[f.k].delete(v); }); });
    var rows = filtered();
    var days = {}, people = {}, hrs = 0, open = 0;
    rows.forEach(function (m) { days[m.date] = 1; people[m.by] = 1; hrs += hours(m); if (m.status !== "done") open++; });
    $("sCount").textContent = rows.length;
    $("sCountH").textContent = b[0] === b[1] ? fmtShort(b[0]) : fmtShort(b[0]) + " – " + fmtShort(b[1]);
    if (isAdmin()) { $("sDaysK").textContent = "Engineers reporting"; $("sDays").textContent = Object.keys(people).length; $("sDaysH").textContent = "on " + Object.keys(days).length + (Object.keys(days).length === 1 ? " day" : " days"); }
    else { $("sDays").textContent = Object.keys(days).length; $("sDaysH").textContent = "days with at least one activity"; }
    $("sHours").textContent = hrs ? Math.round(hrs * 10) / 10 : 0; $("sOpen").textContent = open;
    $("statOpen").classList.toggle("active", state.sel.status.size === 2 && state.sel.status.has("ongoing") && state.sel.status.has("pending"));
    $("lede").textContent = isAdmin() ? "Every engineer's activities. Engineers see only their own." : "Your own activities. Only you and the admin can see them.";

    renderFacets(list); fillLists();
    var chips = "";
    FACETS.forEach(function (f) { state.sel[f.k].forEach(function (v) { chips += '<button class="chip" type="button" data-f="' + f.k + '" data-v="' + esc(v) + '"><small>' + f.label + '</small>' + esc(flabel(f.k, v)) + '<b aria-hidden="true">×</b></button>'; }); });
    if (state.q.trim()) chips += '<button class="chip" type="button" data-f="q"><small>Search</small>' + esc(state.q.trim()) + '<b aria-hidden="true">×</b></button>';
    $("chips").innerHTML = chips; $("chips").hidden = !chips; $("btnClear").hidden = !chips;
    var nsel = FACETS.reduce(function (n, f) { return n + state.sel[f.k].size; }, 0);
    $("fCount").hidden = !nsel; $("fCount").textContent = nsel;

    var g = state.group === "by" && !isAdmin() ? "date" : state.group;
    function gval(m) { return g === "date" ? m.date : fval(m, g); }
    rows.sort(function (a, c) {
      if (g && g !== "date") { var ga = flabel(g, gval(a)), gc = flabel(g, gval(c)), gr = (gval(a) === "") - (gval(c) === "") || natural(ga, gc); if (gr) return gr; }
      return (a.date < c.date ? 1 : a.date > c.date ? -1 : 0) || natural(who(a.by), who(c.by)) || natural(a.start || "99", c.start || "99");
    });
    $("grid").classList.toggle("no-eng", !isAdmin());
    var html = "";
    if (!g) rows.forEach(function (m) { html += rowHtml(m); });
    else {
      var groups = [], cur = null;
      rows.forEach(function (m) { var v = gval(m); if (!cur || cur.v !== v) { cur = { v: v, items: [] }; groups.push(cur); } cur.items.push(m); });
      groups.forEach(function (gr) {
        var gid = g + "|" + gr.v, shut = state.shut.has(gid), gh = 0, gp = {};
        gr.items.forEach(function (m) { gh += hours(m); gp[m.by] = 1; });
        html += '<tr class="grp' + (shut ? ' shut' : '') + '" data-g="' + esc(gid) + '" tabindex="0"><td colspan="' + NCOLS + '"><div class="grp-in"><span class="car"></span><strong>' + esc(g === "date" ? fmtDay(gr.v) : flabel(g, gr.v)) + '</strong>' +
          '<span class="n">' + gr.items.length + (gr.items.length === 1 ? ' activity' : ' activities') + (gh ? ' · ' + fmtHours(gh) : '') + (isAdmin() && g !== "by" ? ' · ' + Object.keys(gp).length + (Object.keys(gp).length === 1 ? ' engineer' : ' engineers') : '') + '</span></div></td></tr>';
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
  function openEdit(id) {
    var m = id ? state.docs.get(id) : null; editing = m;
    var ok = m ? canEdit(m) : true, b = bounds(), today = iso(new Date());
    var preset = { date: today >= b[0] && today <= b[1] ? today : b[1], status: "done", customer: state.sel.customer.size === 1 ? Array.from(state.sel.customer)[0] : "" };
    Object.keys(MAP).forEach(function (f) { var el = $("e_" + f); el.value = m ? m[f] : (preset[f] || ""); el.disabled = !ok; });
    machineList();
    $("editTitle").textContent = m ? (isAdmin() || m.by !== state.user.id ? who(m.by) + " · " : "") + fmtShort(m.date) : "Add activity";
    $("editMeta").textContent = m ? ((m.updatedAt ? "Last changed " + new Date(m.updatedAt).toLocaleString("en-GB") + ". " : "") + (ok ? "" : "View only.")) : "This is saved under your name. Add one entry for each job or visit of the day.";
    $("btnSave").hidden = !ok;
    $("delArea").innerHTML = (m && ok) ? '<button class="btn danger" type="button" id="btnDel">Delete</button>' : '';
    $("dlgEdit").showModal();
    if (!m) setTimeout(function () { $("e_customer").focus(); }, 30);
  }
  $("btnAdd").addEventListener("click", function () { openEdit(null); });
  $("delArea").addEventListener("click", function (e) {
    if (e.target.id === "btnDel") $("delArea").innerHTML = '<span class="confirm">Delete this activity? <button class="btn danger solid" type="button" id="btnDelYes">Delete</button><button class="btn" type="button" id="btnDelNo">Keep</button></span>';
    if (e.target.id === "btnDelNo") $("delArea").innerHTML = '<button class="btn danger" type="button" id="btnDel">Delete</button>';
    if (e.target.id === "btnDelYes") sb.from("daily_reports").delete().eq("id", editing._id).then(function (res) {
      if (res.error) { toast("Could not delete: " + errText(res.error)); return; }
      state.docs.delete(editing._id); render(); todayBar(); $("dlgEdit").close(); toast("Activity deleted");
    });
  });
  $("editForm").addEventListener("submit", function (e) {
    e.preventDefault();
    if (editing && !canEdit(editing)) return;
    var v = function (id) { return $("e_" + id).value.trim(); };
    if (!v("date")) { toast("Choose the date."); return; }
    if (!v("description")) { toast("Write what was done."); return; }
    var row = { report_date: v("date"), start_time: v("start") || null, end_time: v("end") || null, customer: v("customer"), location: v("location"), machine: v("machine"),
                activity_type: v("type"), status: v("status") || "done", description: v("description"), next_action: v("next") };
    var btn = $("btnSave"); btn.disabled = true;
    var q = editing ? sb.from("daily_reports").update(row).eq("id", editing._id).select().single() : sb.from("daily_reports").insert(row).select().single();
    q.then(function (res) {
      if (res.error) { toast("Could not save: " + errText(res.error)); return; }
      var o = fromRow(res.data), b = bounds();
      if (o.date >= b[0] && o.date <= b[1]) state.docs.set(o._id, o); else state.docs.delete(o._id);
      render(); todayBar(); $("dlgEdit").close();
      toast(o.date >= b[0] && o.date <= b[1] ? (editing ? "Activity updated" : "Activity added") : "Saved. It is outside the period shown, so change the period to see it.");
    }).finally(function () { btn.disabled = false; });
  });

  // ---------- export ----------
  $("btnExport").addEventListener("click", function () {
    if (typeof XLSX === "undefined") { toast("The Excel library did not load. Reload the page."); return; }
    var rows = filtered(); if (!rows.length) { toast("Nothing to export with the current period and filters."); return; }
    rows.sort(function (a, c) { return natural(a.date, c.date) || natural(who(a.by), who(c.by)) || natural(a.start, c.start); });
    var aoa = [["Date", "Engineer", "Start", "End", "Hours", "Customer", "Location", "Type", "Machine", "What was done", "Status", "Next action"]];
    rows.forEach(function (m) { var h = hours(m); aoa.push([m.date, who(m.by), m.start, m.end, h ? Math.round(h * 100) / 100 : "", m.customer, m.location, m.type, m.machine, m.description, ST_LABEL[m.status], m.next]); });
    var ws = XLSX.utils.aoa_to_sheet(aoa);
    ws["!cols"] = [11, 18, 7, 7, 7, 24, 18, 20, 28, 60, 10, 36].map(function (w) { return { wch: w }; });
    var wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "Daily report");
    var b = bounds();
    XLSX.writeFile(wb, "Tamura_Daily_Report_" + b[0] + (b[0] === b[1] ? "" : "_to_" + b[1]) + ".xlsx");
  });

  render();
})();
