/* Tamura Machine List — browser app (Supabase auth + database) */
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var cfg = window.APP_CONFIG || {};

  // ---------- column mapping (JS field ⇄ database column) ----------
  var COL = { lastCal: "last_cal", nextCal: "next_cal", pcModel: "pc_model", checkBy: "check_by" };
  function col(f) { return COL[f] || f; }
  function fromRow(r) {
    var m = { _id: r.id, key: r.key, updatedAt: r.updated_at, createdBy: r.created_by || "" };
    FIELDS.forEach(function (f) { var v = r[col(f)]; m[f] = v == null ? "" : String(v); });
    if (!m.brand) m.brand = inferBrand(m.model);
    return m;
  }
  function toRow(m) {
    var r = { key: m.key };
    FIELDS.forEach(function (f) {
      var v = (m[f] || "").trim();
      if (f === "brand" && !state.hasBrand) return;
      r[col(f)] = (f === "lastCal" || f === "nextCal") ? (/^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null) : v;
    });
    return r;
  }

  // ---------- state ----------
  var state = { docs: new Map(), q: "", sort: "customer", dir: 1, group: "customer",
                sel: { customer: new Set(), brand: new Set(), kind: new Set(), cal: new Set() },
                hidden: new Set(), shut: new Set(), shutFacet: {}, facetQ: {}, hasBrand: true, hasCreator: false, people: {},
                role: null, user: null, ready: false, channel: null };
  var TODAY = new Date(); TODAY.setHours(0, 0, 0, 0);
  function isAdmin() { return state.role === "admin"; }
  // Other approved accounts may add machines and edit the ones they added (needs supabase/permissions.sql)
  function canAdd() { return isAdmin() || (state.role === "viewer" && state.hasCreator); }
  function canEditMachine(m) { return isAdmin() || (!!m && state.hasCreator && !!state.user && m.createdBy === state.user.id); }

  // ---------- views ----------
  var VIEWS = ["viewLogin", "viewForgot", "viewSetPassword", "viewPending", "viewSetup", "viewApp"];
  function show(id) { VIEWS.forEach(function (v) { $(v).hidden = v !== id; }); }
  function msg(el, text, kind) { el.textContent = text; el.className = "msg " + (kind || "err"); el.hidden = !text; }
  document.querySelectorAll(".appName").forEach(function (h) { if (cfg.APP_NAME) h.textContent = cfg.APP_NAME; });
  if (cfg.APP_NAME) document.title = cfg.APP_NAME;

  if (!cfg.SUPABASE_URL || /YOUR-PROJECT/.test(cfg.SUPABASE_URL) || !cfg.SUPABASE_ANON_KEY || /YOUR-ANON/.test(cfg.SUPABASE_ANON_KEY)) {
    show("viewSetup"); return;
  }

  // Read the link type (invite / password reset) before the client consumes the URL
  var hashParams = new URLSearchParams(location.hash.replace(/^#/, ""));
  var linkType = hashParams.get("type");
  var linkError = hashParams.get("error_description");
  var needPassword = linkType === "invite" || linkType === "recovery";

  var sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });

  // ---------- auth flow ----------
  $("loginForm").addEventListener("submit", function (e) {
    e.preventDefault();
    var b = $("btnLogin"); b.disabled = true; msg($("loginMsg"), "");
    sb.auth.signInWithPassword({ email: $("loginEmail").value.trim(), password: $("loginPassword").value })
      .then(function (res) {
        if (res.error) msg($("loginMsg"), res.error.message === "Invalid login credentials" ? "Wrong email or password." : res.error.message);
      })
      .finally(function () { b.disabled = false; });
  });
  $("btnForgot").addEventListener("click", function () { $("forgotEmail").value = $("loginEmail").value; msg($("forgotMsg"), ""); show("viewForgot"); });
  $("btnBackLogin").addEventListener("click", function () { show("viewLogin"); });
  $("forgotForm").addEventListener("submit", function (e) {
    e.preventDefault();
    sb.auth.resetPasswordForEmail($("forgotEmail").value.trim(), { redirectTo: location.origin + location.pathname })
      .then(function (res) {
        if (res.error) msg($("forgotMsg"), res.error.message);
        else msg($("forgotMsg"), "If that email has an account, a reset link is on its way. Open it on this device.", "ok");
      });
  });
  $("setPwForm").addEventListener("submit", function (e) {
    e.preventDefault();
    var a = $("newPw").value, b = $("newPw2").value;
    if (a.length < 8) { msg($("setPwMsg"), "Use at least 8 characters."); return; }
    if (a !== b) { msg($("setPwMsg"), "The two passwords don't match."); return; }
    sb.auth.updateUser({ password: a }).then(function (res) {
      if (res.error) { msg($("setPwMsg"), res.error.message); return; }
      needPassword = false;
      history.replaceState(null, "", location.pathname);
      enter(res.data.user);
    });
  });
  document.querySelectorAll("[data-logout]").forEach(function (b) {
    b.addEventListener("click", function () { sb.auth.signOut().then(function () { location.hash = ""; leave(); }); });
  });
  $("btnRecheck").addEventListener("click", function () { if (state.user) enter(state.user); });

  function leave() {
    state.user = null; state.role = null; state.docs = new Map(); state.ready = false;
    if (state.channel) { sb.removeChannel(state.channel); state.channel = null; }
    $("loginPassword").value = "";
    show("viewLogin");
  }

  function enter(user) {
    state.user = user;
    if (needPassword) {
      $("setPwEmail").textContent = "Account: " + (user.email || "");
      show("viewSetPassword"); return;
    }
    sb.from("profiles").select("role,email").eq("id", user.id).maybeSingle().then(function (res) {
      var role = res.data && res.data.role;
      if (!role || role === "pending") {
        $("pendingEmail").textContent = user.email || ""; show("viewPending"); return;
      }
      state.role = role;
      $("userEmail").textContent = user.email || "";
      $("userRole").textContent = role; $("userRole").className = "role " + role;
      document.querySelectorAll("[data-admin]").forEach(function (b) { b.hidden = !isAdmin(); });
      $("btnAdd").hidden = !canAdd();
      // Calibration report, transport claim, team tasks and schedule are for the owner account only
      document.querySelectorAll("[data-owner]").forEach(function (a) { a.hidden = true; });
      if (window.APP_IS_OWNER) window.APP_IS_OWNER(user.email).then(function (ok) {
        document.querySelectorAll("[data-owner]").forEach(function (a) { a.hidden = !ok; });
      });
      show("viewApp");
      loadMachines(); subscribe();
    });
  }

  sb.auth.onAuthStateChange(function (event, session) {
    if (event === "PASSWORD_RECOVERY") needPassword = true;
    if (event === "SIGNED_OUT") { leave(); return; }
    if ((event === "SIGNED_IN" || event === "INITIAL_SESSION" || event === "PASSWORD_RECOVERY") && session) {
      if (!state.user || state.user.id !== session.user.id || needPassword) setTimeout(function () { enter(session.user); }, 0);
    } else if (event === "INITIAL_SESSION" && !session) {
      show("viewLogin");
      if (linkError) msg($("loginMsg"), "That link is invalid or has expired. Ask for a new invite, or use “Forgot password?”.");
    }
  });

  // ---------- data ----------
  function loadMachines() {
    var all = [], page = 1000;
    function next(from) {
      return sb.from("machines").select("*").order("customer").range(from, from + page - 1).then(function (res) {
        if (res.error) throw res.error;
        all = all.concat(res.data);
        return res.data.length === page ? next(from + page) : all;
      });
    }
    // Databases set up before brands existed have no "brand" column yet (see supabase/brand.sql)
    var probe = Promise.all([
      sb.from("machines").select("brand").limit(1).then(function (res) { state.hasBrand = !res.error; }),
      sb.from("machines").select("created_by").limit(1).then(function (res) { state.hasCreator = !res.error; $("btnAdd").hidden = !canAdd(); }),
      sb.rpc("people").then(function (res) { var p = {}; (res.data || []).forEach(function (u) { p[u.id] = u.name; }); if (!res.error) state.people = p; })
    ]);
    return probe.then(function () { return next(0); }).then(function (rows) {
      var m = new Map(); rows.forEach(function (r) { var o = fromRow(r); m.set(o._id, o); });
      state.docs = m; state.ready = true;
      $("banner").hidden = state.hasBrand || !isAdmin();
      $("banner").textContent = "Brands are being guessed from the model name and can't be saved yet. To switch the Brand field on, run supabase/brand.sql once in the Supabase SQL Editor, then reload this page.";
      render();
    }).catch(function (err) {
      state.ready = true; $("banner").hidden = false;
      $("banner").textContent = "Could not load machines: " + (err.message || err) + ". Reload the page to try again.";
      render();
    });
  }
  var reloadTimer;
  function subscribe() {
    if (state.channel) return;
    state.channel = sb.channel("machines-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "machines" }, function () {
        clearTimeout(reloadTimer); reloadTimer = setTimeout(loadMachines, 600);
      }).subscribe();
  }

  // ---------- helpers ----------
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function parseISO(s) { if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null; var p = s.split("-"); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function iso(d) { return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
  function fmtDate(s) { var d = parseISO(s); if (!d) return s || ""; return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }); }
  function fmtMonth(s) { if (!s) return ""; var m = s.match(/^(\d{4})-(\d{2})$/); if (!m) return s; return new Date(+m[1], +m[2] - 1, 1).toLocaleDateString("en-GB", { month: "short", year: "numeric" }); }
  function calInfo(m) {
    var next = parseISO(m.nextCal), est = false;
    if (!next) { var last = parseISO(m.lastCal); if (last) { next = new Date(last); next.setFullYear(next.getFullYear() + 1); est = true; } }
    if (!next) return { status: "none", label: "No date" };
    var days = Math.round((next - TODAY) / 864e5);
    var st = days < 0 ? "overdue" : (days <= 30 ? "due" : "ok");
    var label = days < 0 ? (-days) + " d overdue" : days === 0 ? "Due today" : days <= 30 ? "In " + days + " d" : "OK";
    return { status: st, label: label, next: next, est: est };
  }
  function who(m) { if (!m.createdBy) return ""; if (state.user && m.createdBy === state.user.id && !state.people[m.createdBy]) return "You"; return state.people[m.createdBy] || "Former user"; }
  function natural(a, b) { return String(a || "").localeCompare(String(b || ""), undefined, { numeric: true, sensitivity: "base" }); }
  function all() { return Array.from(state.docs.values()); }
  function toast(t) { var el = $("toast"); el.textContent = t; el.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(function () { el.hidden = true; }, 3500); }
  function errText(err) {
    var m = (err && (err.message || err.details)) || String(err);
    if (err && (err.code === "42501" || /row-level security|permission/i.test(m))) return "You don't have permission for this. You can add machines and edit the ones you added.";
    if (err && err.code === "23505") return "A machine with this customer and serial number already exists.";
    return m;
  }

  // ---------- filters ----------
  var FACETS = [{ k: "customer", label: "Customer" }, { k: "brand", label: "Brand" }, { k: "kind", label: "Kind" }, { k: "cal", label: "Calibration" }];
  var CAL_ORDER = ["overdue", "due", "ok", "none"];
  var CAL_LABEL = { overdue: "Overdue", due: "Due in 30 days", ok: "Up to date", none: "No date" };
  var COLS = [["brand", "Brand"], ["line", "Line"], ["serial", "Serial number"], ["mfg", "Manufactured"], ["version", "Version"],
              ["lastCal", "Last calibration"], ["nextCal", "Next calibration"], ["ip", "IP address"], ["pc", "PC specifications"], ["by", "Added by"]];
  var NCOLS = 12;
  // Suggestions offered when typing a brand or kind; anything else can be typed too.
  var BRAND_HINTS = ["Koh Young", "Tamura"];
  var KIND_HINTS = ["SPI", "AOI", "Review station", "Reflow oven", "Wave soldering", "Selective soldering", "Screen printer", "Mounter", "X-ray"];

  function fval(m, k) {
    if (k === "cal") return calInfo(m).status;
    if (k === "kind") return (m.kind || "").trim().toUpperCase();
    return (m[k] || "").trim();
  }
  var kindName = {};
  function flabel(k, v) { return k === "cal" ? CAL_LABEL[v] : k === "kind" ? (kindName[v] || v || "Not set") : (v || "Not set"); }
  function matches(m, skip) {
    for (var i = 0; i < FACETS.length; i++) {
      var k = FACETS[i].k, s = state.sel[k];
      if (k !== skip && s.size && !s.has(fval(m, k))) return false;
    }
    var q = state.q.trim().toLowerCase();
    if (q) { var hay = FIELDS.map(function (f) { return m[f] || ""; }).join(" ").toLowerCase(); if (hay.indexOf(q) < 0) return false; }
    return true;
  }
  function filtered() { return all().filter(function (m) { return matches(m); }); }
  function selCount() { return FACETS.reduce(function (n, f) { return n + state.sel[f.k].size; }, 0); }
  function only(k) { var s = state.sel[k]; return s.size === 1 ? Array.from(s)[0] : ""; }
  function uniq(list, f) { var o = {}; list.forEach(function (m) { var v = (m[f] || "").trim(); if (v) o[v] = 1; }); return Object.keys(o).sort(natural); }
  function options(arr) { return arr.map(function (v) { return '<option value="' + esc(v) + '">'; }).join(""); }
  function merge(a, b) { var seen = {}, out = []; a.concat(b).forEach(function (v) { var key = v.toLowerCase(); if (!seen[key]) { seen[key] = 1; out.push(v); } }); return out; }

  // ---------- saved view options ----------
  function savePrefs() { try { localStorage.setItem("tml.view", JSON.stringify({ group: state.group, hidden: Array.from(state.hidden) })); } catch (e) {} }
  (function () {
    try {
      var p = JSON.parse(localStorage.getItem("tml.view") || "null");
      if (p) { if (typeof p.group === "string") state.group = p.group; if (Array.isArray(p.hidden)) state.hidden = new Set(p.hidden); }
    } catch (e) {}
    $("fGroup").value = state.group;
    $("colList").innerHTML = COLS.map(function (c) {
      return '<label class="opt"><input type="checkbox" data-col="' + c[0] + '"' + (state.hidden.has(c[0]) ? '' : ' checked') + '><span class="t">' + c[1] + '</span></label>';
    }).join("");
  })();

  // ---------- render ----------
  function renderFacets(list) {
    var body = $("facetBody"), scroll = {};
    body.querySelectorAll(".facet-list").forEach(function (el) { scroll[el.dataset.f] = el.scrollTop; });
    var html = "";
    FACETS.forEach(function (f) {
      var k = f.k, sel = state.sel[k], counts = {}, vals = {};
      list.forEach(function (m) { vals[fval(m, k)] = 1; });
      list.forEach(function (m) { if (matches(m, k)) { var v = fval(m, k); counts[v] = (counts[v] || 0) + 1; } });
      var keys = k === "cal" ? CAL_ORDER.filter(function (v) { return vals[v]; })
                             : Object.keys(vals).sort(function (a, b) { return (a === "") - (b === "") || natural(a, b); });
      html += '<details class="facet" data-f="' + k + '"' + (state.shutFacet[k] ? '' : ' open') + '><summary><span>' + f.label +
        (sel.size ? '<span class="sel">' + sel.size + ' selected</span>' : '') + '</span></summary>';
      if (keys.length > 8) html += '<input class="facet-q" type="search" data-f="' + k + '" placeholder="Find ' + f.label.toLowerCase() + '…" aria-label="Find ' + f.label.toLowerCase() + '" value="' + esc(state.facetQ[k] || "") + '">';
      html += '<div class="facet-list" data-f="' + k + '">';
      keys.forEach(function (v) {
        var n = counts[v] || 0;
        html += '<label class="opt' + (n ? '' : ' zero') + '"><input type="checkbox" data-f="' + k + '" data-v="' + esc(v) + '"' + (sel.has(v) ? ' checked' : '') + '>' +
          '<span class="t" title="' + esc(flabel(k, v)) + '">' + esc(flabel(k, v)) + '</span><span class="n">' + n + '</span></label>';
      });
      html += '</div></details>';
    });
    body.innerHTML = html;
    body.querySelectorAll(".facet-list").forEach(function (el) { if (scroll[el.dataset.f]) el.scrollTop = scroll[el.dataset.f]; });
    body.querySelectorAll(".facet-q").forEach(narrowFacet);
  }
  function narrowFacet(input) {
    var q = input.value.trim().toLowerCase();
    input.parentNode.querySelectorAll(".opt").forEach(function (o) { o.hidden = !!q && o.textContent.toLowerCase().indexOf(q) < 0; });
  }
  function renderChips() {
    var h = "";
    FACETS.forEach(function (f) {
      state.sel[f.k].forEach(function (v) { h += '<button class="chip" type="button" data-f="' + f.k + '" data-v="' + esc(v) + '" title="Remove this filter"><small>' + f.label + '</small>' + esc(flabel(f.k, v)) + '<b aria-hidden="true">×</b></button>'; });
    });
    if (state.q.trim()) h += '<button class="chip" type="button" data-f="q" title="Clear the search"><small>Search</small>' + esc(state.q.trim()) + '<b aria-hidden="true">×</b></button>';
    $("chips").innerHTML = h; $("chips").hidden = !h;
    var n = selCount();
    $("btnClear").hidden = !n && !state.q.trim();
    $("fCount").hidden = !n; $("fCount").textContent = n;
  }
  function rowHtml(m) {
    var ci = calInfo(m);
    var pc = [m.os, m.pcModel].filter(Boolean).join(" · "), pc2 = [m.memory, m.vga].filter(Boolean).join(" · ");
    var dash = '<span class="muted">—</span>';
    return '<tr class="row" data-id="' + esc(m._id) + '" tabindex="0">' +
      (state.group === "customer" ? '<td class="c-customer">' + esc(m.location) + '</td>'
        : '<td class="c-customer"><div class="cust">' + esc(m.customer) + '</div>' + (m.location ? '<div class="sub">' + esc(m.location) + '</div>' : '') + '</td>') +
      '<td class="c-brand">' + (m.brand ? esc(m.brand) : dash) + '</td>' +
      '<td class="c-kind"><span class="kind">' + esc(m.kind || "?") + '</span>' + (m.model ? '<div class="model">' + esc(m.model) + '</div>' : '') + '</td>' +
      '<td class="c-line mono">' + esc(m.line) + '</td>' +
      '<td class="c-serial mono">' + (m.serial ? esc(m.serial) : dash) + '</td>' +
      '<td class="c-mfg nw">' + esc(fmtMonth(m.mfg)) + '</td>' +
      '<td class="c-version mono">' + esc(m.version) + '</td>' +
      '<td class="c-lastCal nw">' + esc(fmtDate(m.lastCal)) + '</td>' +
      '<td class="c-nextCal nw">' + (ci.next ? '<div>' + esc(fmtDate(m.nextCal || iso(ci.next))) + (ci.est ? ' <span class="sub">(est.)</span>' : '') + '</div>' : '') +
        '<span class="pill ' + PILL[ci.status] + '">' + esc(ci.label) + '</span></td>' +
      '<td class="c-ip mono">' + esc(m.ip) + '</td>' +
      '<td class="c-pc">' + esc(pc) + (pc2 ? '<div class="sub">' + esc(pc2) + '</div>' : '') + (m.notes ? '<div class="note">' + esc(m.notes) + '</div>' : '') + '</td>' +
      '<td class="c-by nw">' + (who(m) ? esc(who(m)) : dash) + '</td>' +
      '</tr>';
  }
  var PILL = { overdue: "bad", due: "warn", ok: "ok", none: "none" };
  function render() {
    var list = all();
    // drop selections that no longer exist in the data
    ["customer", "brand", "kind"].forEach(function (k) {
      var have = {}; list.forEach(function (m) { have[fval(m, k)] = 1; });
      state.sel[k].forEach(function (v) { if (!have[v]) state.sel[k].delete(v); });
    });

    kindName = {}; list.forEach(function (m) { var k = fval(m, "kind"); if (k && !kindName[k]) kindName[k] = m.kind.trim(); });

    var scope = list.filter(function (m) { return matches(m, "cal"); });
    var c = { overdue: 0, due: 0, ok: 0, none: 0 };
    scope.forEach(function (m) { c[calInfo(m).status]++; });
    $("sTotal").textContent = scope.length; $("sOver").textContent = c.overdue; $("sDue").textContent = c.due; $("sOk").textContent = c.ok; $("sNone").textContent = c.none;
    $("sTotalH").textContent = scope.length === list.length ? "all machines" : "of " + list.length + " in total";
    document.querySelectorAll(".stat").forEach(function (b) {
      var v = b.dataset.cal || ""; b.classList.toggle("active", v ? only("cal") === v : false);
    });

    var custs = uniq(list, "customer"), brands = uniq(list, "brand"), kinds = uniq(list, "kind");
    $("lede").textContent = state.ready && list.length ? list.length + " machines · " + custs.length + (custs.length === 1 ? " customer · " : " customers · ") +
      brands.length + (brands.length === 1 ? " brand · " : " brands · ") + Object.keys(kinds.reduce(function (o, v) { o[v.toUpperCase()] = 1; return o; }, {})).length + " kinds" : "";
    $("custList").innerHTML = options(custs);
    $("brandList").innerHTML = options(merge(brands, BRAND_HINTS));
    $("kindList").innerHTML = options(merge(kinds, KIND_HINTS));
    $("modelList").innerHTML = options(uniq(list, "model"));
    $("osList").innerHTML = options(uniq(list, "os"));

    renderFacets(list); renderChips();

    var rows = filtered(), key = state.sort, dir = state.dir, g = state.group;
    function gkey(m) { return fval(m, g); }
    rows.sort(function (a, b) {
      if (g) {
        var ga = gkey(a), gb = gkey(b);
        var gr = g === "cal" ? CAL_ORDER.indexOf(ga) - CAL_ORDER.indexOf(gb) : ((ga === "") - (gb === "") || natural(ga, gb));
        if (gr) return gr;
      }
      var r;
      if (key === "nextCal") { var ia = calInfo(a), ib = calInfo(b); r = (ia.next ? ia.next.getTime() : 9e15) - (ib.next ? ib.next.getTime() : 9e15); }
      else if (key === "customer" && g === "customer") r = natural(a.location, b.location);
      else if (key === "createdBy") r = natural(who(a), who(b));
      else r = natural(a[key], b[key]);
      if (r === 0) return natural(a.customer, b.customer) || natural(a.kind, b.kind) || natural(a.line, b.line);
      return r * dir;
    });
    document.querySelectorAll("th[data-sort]").forEach(function (h) {
      var base = h.dataset.sort === "customer" ? (g === "customer" ? "Location" : "Customer") : h.textContent.replace(/[ ▲▼]+$/, "");
      h.innerHTML = esc(base) + (h.dataset.sort === key ? ' <span class="arrow">' + (dir > 0 ? "▲" : "▼") + '</span>' : "");
      h.setAttribute("aria-sort", h.dataset.sort === key ? (dir > 0 ? "ascending" : "descending") : "none");
    });
    var noLoc = g === "customer" && !rows.some(function (m) { return m.location; });
    $("grid").className = Array.from(state.hidden).map(function (h) { return "h-" + h; }).concat(noLoc ? ["h-customer"] : []).join(" ");

    var html = "";
    if (!g) rows.forEach(function (m) { html += rowHtml(m); });
    else {
      var groups = [], cur = null;
      rows.forEach(function (m) { var v = gkey(m); if (!cur || cur.v !== v) { cur = { v: v, items: [] }; groups.push(cur); } cur.items.push(m); });
      groups.forEach(function (gr) {
        var gid = g + "|" + gr.v, shut = state.shut.has(gid), s = { overdue: 0, due: 0 };
        gr.items.forEach(function (m) { var st = calInfo(m).status; if (s[st] != null) s[st]++; });
        html += '<tr class="grp' + (shut ? ' shut' : '') + '" data-g="' + esc(gid) + '" tabindex="0" aria-expanded="' + !shut + '"><td colspan="' + NCOLS + '"><div class="grp-in"><span class="car"></span><strong>' + esc(flabel(g, gr.v)) + '</strong>' +
          '<span class="n">' + gr.items.length + (gr.items.length === 1 ? ' machine' : ' machines') + '</span>' +
          (g !== "cal" && s.overdue ? '<span class="pill bad">' + s.overdue + ' overdue</span>' : '') +
          (g !== "cal" && s.due ? '<span class="pill warn">' + s.due + ' due soon</span>' : '') + '</div></td></tr>';
        if (!shut) gr.items.forEach(function (m) { html += rowHtml(m); });
      });
    }
    $("rows").innerHTML = html;
    $("count").textContent = rows.length === list.length ? list.length + " machines" : rows.length + " of " + list.length + " machines";
    var empty = $("empty");
    if (!state.ready) { empty.hidden = false; $("emptyTitle").textContent = "Loading machines…"; $("emptyText").textContent = "The machine list appears here once it loads."; }
    else if (!list.length) { empty.hidden = false; $("emptyTitle").textContent = "No machines yet"; $("emptyText").textContent = isAdmin() ? "Upload your Excel machine list or add a machine by hand to start." : canAdd() ? "Add the first machine to start." : "Nothing has been added yet."; }
    else if (!rows.length) { empty.hidden = false; $("emptyTitle").textContent = "No machines match"; $("emptyText").textContent = "Clear the search or remove a filter."; }
    else empty.hidden = true;
  }

  // ---------- list events ----------
  $("facetBody").addEventListener("change", function (e) {
    var b = e.target; if (b.type !== "checkbox" || !b.dataset.f) return;
    var s = state.sel[b.dataset.f]; if (b.checked) s.add(b.dataset.v); else s.delete(b.dataset.v);
    render();
  });
  $("facetBody").addEventListener("input", function (e) { if (e.target.classList.contains("facet-q")) { state.facetQ[e.target.dataset.f] = e.target.value; narrowFacet(e.target); } });
  $("facetBody").addEventListener("toggle", function (e) { var d = e.target; if (d.dataset && d.dataset.f) state.shutFacet[d.dataset.f] = !d.open; }, true);
  function clearAll() { FACETS.forEach(function (f) { state.sel[f.k].clear(); }); state.q = ""; $("q").value = ""; render(); }
  $("btnClear").addEventListener("click", clearAll);
  $("chips").addEventListener("click", function (e) {
    var b = e.target.closest(".chip"); if (!b) return;
    if (b.dataset.f === "q") { state.q = ""; $("q").value = ""; } else state.sel[b.dataset.f].delete(b.dataset.v);
    render();
  });
  document.querySelectorAll(".stat").forEach(function (b) {
    b.addEventListener("click", function () {
      var v = b.dataset.cal || "", was = only("cal") === v;
      state.sel.cal.clear(); if (v && !was) state.sel.cal.add(v);
      render();
    });
  });
  $("fGroup").addEventListener("change", function () { state.group = this.value; savePrefs(); render(); });
  $("colList").addEventListener("change", function (e) {
    var k = e.target.dataset.col; if (!k) return;
    if (e.target.checked) state.hidden.delete(k); else state.hidden.add(k);
    savePrefs(); render();
  });
  document.addEventListener("click", function (e) { var m = $("colMenu"); if (m.open && !m.contains(e.target)) m.open = false; });
  var qt; $("q").addEventListener("input", function () { var v = this.value; clearTimeout(qt); qt = setTimeout(function () { state.q = v; render(); }, 120); });
  document.querySelector("#grid thead").addEventListener("click", function (e) { var h = e.target.closest("th[data-sort]"); if (!h) return; if (state.sort === h.dataset.sort) state.dir *= -1; else { state.sort = h.dataset.sort; state.dir = 1; } render(); });
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
  document.querySelectorAll("dialog").forEach(function (d) {
    d.addEventListener("click", function (e) { if (e.target.closest("[data-close]") || e.target === d) d.close(); });
  });

  // ---------- add / edit ----------
  var editing = null;
  function openEdit(id) {
    var m = id ? state.docs.get(id) : null; editing = m;
    var canEdit = m ? canEditMachine(m) : canAdd();
    $("editTitle").textContent = m ? ([m.brand, m.model || m.kind].filter(Boolean).join(" ") + " · " + (m.serial || ("line " + m.line))) : "Add machine";
    var preset = { customer: only("customer"), brand: only("brand"), kind: only("kind") };
    FIELDS.forEach(function (f) { var el = $("e_" + f); el.value = m ? (m[f] || "") : (preset[f] || ""); el.disabled = !canEdit; });
    if (!state.hasBrand) { $("e_brand").disabled = true; $("e_brand").title = "Run supabase/brand.sql in Supabase to switch this field on"; }
    var mfg = $("e_mfg");
    if (m && m.mfg && !/^\d{4}-\d{2}$/.test(m.mfg)) { mfg.type = "text"; mfg.value = m.mfg; } else { mfg.type = "month"; mfg.value = m ? (m.mfg || "") : ""; }
    $("editMeta").textContent = (m && who(m) ? "Added by " + who(m) + ". " : "") + (m && m.updatedAt ? "Last changed " + new Date(m.updatedAt).toLocaleString("en-GB") + ". " : "") +
      (m && !isAdmin() ? (canEdit ? "You added this machine, so you can edit it." : "View only: you can edit the machines you added yourself.") : "");
    $("btnSave").hidden = !canEdit;
    $("delArea").innerHTML = (m && isAdmin()) ? '<button class="btn danger" type="button" id="btnDel">Delete</button>' : '';
    $("dlgEdit").showModal();
    if (!m && canEdit) setTimeout(function () { $(preset.customer ? "e_kind" : "e_customer").focus(); }, 30);
  }
  $("btnAdd").addEventListener("click", function () { openEdit(null); });
  $("delArea").addEventListener("click", function (e) {
    if (e.target.id === "btnDel") $("delArea").innerHTML = '<span class="confirm">Delete this machine? <button class="btn danger solid" type="button" id="btnDelYes">Delete</button><button class="btn" type="button" id="btnDelNo">Keep</button></span>';
    if (e.target.id === "btnDelNo") $("delArea").innerHTML = '<button class="btn danger" type="button" id="btnDel">Delete</button>';
    if (e.target.id === "btnDelYes") {
      sb.from("machines").delete().eq("id", editing._id).then(function (res) {
        if (res.error) { toast("Could not delete: " + errText(res.error)); return; }
        state.docs.delete(editing._id); render(); $("dlgEdit").close(); toast("Machine deleted");
      });
    }
  });
  $("editForm").addEventListener("submit", function (e) {
    e.preventDefault();
    if (editing ? !canEditMachine(editing) : !canAdd()) return;
    var m = {}; FIELDS.forEach(function (f) { m[f] = $("e_" + f).value.trim(); });
    if (!m.customer || !m.kind) { toast("Customer and kind are required."); return; }
    var base = machineKey(m);
    m.key = editing && editing.key && editing.key.split("#")[0] === base ? editing.key : base;
    var row = toRow(m), btn = $("btnSave"); btn.disabled = true;
    var q = editing ? sb.from("machines").update(row).eq("id", editing._id).select().single()
                    : sb.from("machines").insert(row).select().single();
    q.then(function (res) {
      if (res.error) { toast("Could not save: " + errText(res.error)); return; }
      var o = fromRow(res.data); state.docs.set(o._id, o); render();
      $("dlgEdit").close(); toast(editing ? "Machine updated" : "Machine added");
    }).finally(function () { btn.disabled = false; });
  });

  // ---------- import ----------
  var pending = null;
  $("btnImport").addEventListener("click", function () { resetImport(); $("dlgImport").showModal(); });
  function resetImport() { pending = null; $("impPreview").hidden = true; $("impPreview").innerHTML = ""; $("drop").hidden = false; $("btnDoImport").disabled = true; $("btnDoImport").textContent = "Import"; $("impStatus").textContent = ""; $("file").value = ""; }
  var drop = $("drop");
  ["dragenter", "dragover"].forEach(function (t) { drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.add("over"); }); });
  ["dragleave", "drop"].forEach(function (t) { drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.remove("over"); }); });
  drop.addEventListener("drop", function (e) { var f = e.dataTransfer.files[0]; if (f) readFile(f); });
  $("file").addEventListener("change", function () { if (this.files[0]) readFile(this.files[0]); });

  function readFile(file) {
    if (typeof XLSX === "undefined") { $("impStatus").textContent = "The Excel reader did not load. Check your internet connection and reload the page."; return; }
    $("impStatus").textContent = "Reading " + file.name + "…";
    var fr = new FileReader();
    fr.onload = function () {
      try {
        var wb = XLSX.read(new Uint8Array(fr.result), { type: "array", cellDates: true });
        var sheets = wb.SheetNames.map(function (name) {
          var rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: null, blankrows: true });
          var res = parseSheet(name, rows);
          return { name: name, customer: name.trim(), machines: res.machines, warnings: res.warnings, include: res.machines.length > 0 };
        });
        $("impStatus").textContent = "";
        showPreview(file.name, sheets);
      } catch (err) { $("impStatus").textContent = "This file could not be read as Excel (" + (err.message || err) + ")."; }
    };
    fr.readAsArrayBuffer(file);
  }
  function planImport() {
    var ex = {}; all().forEach(function (d) { ex[d.key] = d; });
    var list = [];
    pending.sheets.forEach(function (s) {
      if (!s.include) return;
      s.machines.forEach(function (m) { var c = Object.assign({}, m); if (s.customer.trim() && c.customer === s.name.trim()) c.customer = s.customer.trim(); list.push(c); });
    });
    keyMachines(list);
    var add = 0, upd = 0; list.forEach(function (m) { if (ex[m.key]) upd++; else add++; });
    var mode = (document.querySelector("input[name=impMode]:checked") || {}).value || "merge";
    var del = [];
    if (mode === "replace") {
      var custs = {}, keep = {}; list.forEach(function (m) { custs[m.customer] = 1; keep[m.key] = 1; });
      all().forEach(function (d) { if (custs[d.customer] && !keep[d.key]) del.push(d._id); });
    }
    return { list: list, add: add, upd: upd, del: del };
  }
  function showPreview(fname, sheets) {
    pending = { file: fname, sheets: sheets };
    $("drop").hidden = true;
    var h = '<div class="help"><strong style="color:var(--fg)">' + esc(fname) + '</strong>. Check the customer name for each sheet, untick sheets you don\'t want, then import.</div>';
    h += '<div class="tablebox"><table><thead><tr><th style="width:40px"></th><th>Sheet</th><th>Import as customer</th><th>Machines</th><th>Kinds found</th></tr></thead><tbody>';
    sheets.forEach(function (s, i) {
      var kinds = {}; s.machines.forEach(function (m) { var k = m.kind || "?"; kinds[k] = (kinds[k] || 0) + 1; });
      h += '<tr><td><input type="checkbox" id="inc' + i + '" data-i="' + i + '" ' + (s.include ? 'checked' : '') + (s.machines.length ? '' : ' disabled') + ' aria-label="Include sheet ' + esc(s.name) + '" style="width:auto"></td>' +
        '<td>' + esc(s.name) + (s.warnings.length ? '<div class="sub" style="color:var(--warn)">' + esc(s.warnings.join(" ")) + '</div>' : '') + '</td>' +
        '<td><input id="cust' + i + '" data-i="' + i + '" value="' + esc(s.customer) + '" ' + (s.machines.length ? '' : 'disabled') + ' aria-label="Customer for sheet ' + esc(s.name) + '"></td>' +
        '<td class="mono">' + s.machines.length + '</td>' +
        '<td class="sub">' + esc(Object.keys(kinds).map(function (k) { return k + " " + kinds[k]; }).join(", ")) + '</td></tr>';
    });
    h += '</tbody></table></div>';
    h += '<div class="modes"><label><input type="radio" name="impMode" value="merge" checked> <span><strong>Add and update.</strong> New serial numbers are added; machines with a matching customer and serial number are updated. Nothing is removed.</span></label>' +
         '<label><input type="radio" name="impMode" value="replace"> <span><strong>Replace these customers.</strong> Same as above, and machines of the imported customers that are not in the file are deleted.</span></label></div>';
    h += '<div id="plan" class="help"></div><div class="progress" id="prog" hidden><i></i></div>';
    $("impPreview").innerHTML = h; $("impPreview").hidden = false;
    updatePlan();
  }
  $("impPreview").addEventListener("input", function (e) {
    var i = e.target.dataset.i;
    if (i != null) {
      if (e.target.type === "checkbox") pending.sheets[i].include = e.target.checked;
      else pending.sheets[i].customer = e.target.value;
    }
    updatePlan();
  });
  $("impPreview").addEventListener("change", function (e) { if (e.target.name === "impMode") updatePlan(); });
  function updatePlan() {
    var p = planImport();
    $("plan").innerHTML = p.list.length ? ('Ready: <strong style="color:var(--fg)">' + p.add + ' new</strong>, <strong style="color:var(--fg)">' + p.upd + ' updated</strong>' + (p.del.length ? ', <strong style="color:var(--bad)">' + p.del.length + ' deleted</strong>' : '') + '.') : 'Select at least one sheet with machines.';
    $("btnDoImport").disabled = !p.list.length;
    $("btnDoImport").textContent = p.list.length ? "Import " + p.list.length + " machines" : "Import";
  }
  $("btnDoImport").addEventListener("click", function () {
    var p = planImport(); if (!p.list.length) return;
    var btn = this; btn.disabled = true;
    var rows = p.list.map(toRow), chunks = [];
    for (var i = 0; i < rows.length; i += 200) chunks.push(rows.slice(i, i + 200));
    var delChunks = []; for (var j = 0; j < p.del.length; j += 200) delChunks.push(p.del.slice(j, j + 200));
    var total = chunks.length + delChunks.length, done = 0, prog = $("prog"), bar = prog.querySelector("i"); prog.hidden = false;
    function step() { done++; bar.style.width = (done / total * 100) + "%"; $("impStatus").textContent = "Saving… " + Math.round(done / total * 100) + "%"; }
    var chain = Promise.resolve();
    chunks.forEach(function (c) { chain = chain.then(function () { return sb.from("machines").upsert(c, { onConflict: "key" }).then(function (r) { if (r.error) throw r.error; step(); }); }); });
    delChunks.forEach(function (c) { chain = chain.then(function () { return sb.from("machines").delete().in("id", c).then(function (r) { if (r.error) throw r.error; step(); }); }); });
    chain.then(function () {
      $("dlgImport").close();
      toast("Imported " + p.list.length + " machines" + (p.del.length ? ", removed " + p.del.length : ""));
      loadMachines();
    }).catch(function (err) {
      $("impStatus").textContent = "Import stopped: " + errText(err) + ". Rows saved before the error are kept; run the import again to finish.";
      loadMachines();
    }).finally(function () { btn.disabled = false; });
  });

  // ---------- export ----------
  function buildWorkbook(byCustomer) {
    var wb = XLSX.utils.book_new(), used = {};
    var fields = FIELDS.filter(function (f) { return f !== "customer"; });
    var cols = ["No"].concat(fields.map(function (f) { return LABELS[f]; }));
    Object.keys(byCustomer).sort(natural).forEach(function (c) {
      var aoa = [cols];
      byCustomer[c].forEach(function (m, i) { aoa.push([i + 1].concat(fields.map(function (f) { return m[f] || ""; }))); });
      var ws = XLSX.utils.aoa_to_sheet(aoa);
      ws["!cols"] = cols.map(function (h) { return { wch: h === "No" ? 5 : h === "Notes" ? 30 : (h === "OS" || h === "PC Model" || h === "VGA") ? 26 : 16 }; });
      var nm = (c || "Sheet").replace(/[\\\/\?\*\[\]:]/g, " ").slice(0, 31).trim() || "Sheet", base = nm, k = 2;
      while (used[nm.toLowerCase()]) nm = base.slice(0, 28) + " " + k++;
      used[nm.toLowerCase()] = 1;
      XLSX.utils.book_append_sheet(wb, ws, nm);
    });
    return wb;
  }
  $("btnExport").addEventListener("click", function () {
    if (typeof XLSX === "undefined") { toast("The Excel library did not load. Reload the page."); return; }
    var rows = filtered(); if (!rows.length) { toast("Nothing to export with the current filters."); return; }
    var by = {};
    rows.sort(function (a, b) { return natural(a.kind, b.kind) || natural(a.line, b.line); }).forEach(function (m) { (by[m.customer] = by[m.customer] || []).push(m); });
    XLSX.writeFile(buildWorkbook(by), "Tamura_Machine_List_" + (only("customer") ? only("customer").replace(/\W+/g, "_") + "_" : "") + iso(new Date()) + ".xlsx");
  });
  $("btnTemplate").addEventListener("click", function () {
    if (typeof XLSX === "undefined") { toast("The Excel library did not load. Reload the page."); return; }
    var ex = {}; FIELDS.forEach(function (f) { ex[f] = ""; });
    Object.assign(ex, { customer: "New Customer", brand: "Koh Young", kind: "SPI", model: "KY8030 Nova", line: "1", serial: "SV-SL-00000", mfg: "2026-01", version: "5.2.3.0",
      lastCal: "2026-01-15", nextCal: "2027-01-15", ip: "192.168.0.10", os: "Windows 10 Enterprise LTSC 64-bit", pcModel: "Dell OptiPlex XE4",
      memory: "32768 MB", vga: "NVIDIA T400", notes: "Example row, replace or delete" });
    XLSX.writeFile(buildWorkbook({ "New Customer": [ex] }), "Machine_List_Template.xlsx");
  });

  // ---------- users (admin) ----------
  $("btnUsers").addEventListener("click", function () { $("dlgUsers").showModal(); loadUsers(); });
  function loadUsers() {
    $("usersStatus").textContent = "Loading…";
    sb.from("profiles").select("id,email,name,role,created_at").order("created_at").then(function (res) {
      // databases without the name column yet (supabase/permissions.sql not run)
      return res.error ? sb.from("profiles").select("id,email,role,created_at").order("created_at") : res;
    }).then(function (res) {
      if (res.error) { $("usersStatus").textContent = errText(res.error); return; }
      var named = res.data.length && "name" in res.data[0];
      $("usersStatus").textContent = res.data.length + " users";
      $("usersRows").innerHTML = res.data.map(function (u) {
        var self = state.user && u.id === state.user.id;
        return '<tr><td>' + esc(u.email) + (self ? ' <span class="sub">(you)</span>' : '') + '</td><td>' +
          (named ? '<input data-name="' + esc(u.id) + '" value="' + esc(u.name || "") + '" placeholder="' + esc(String(u.email || "").split("@")[0]) + '" aria-label="Display name for ' + esc(u.email) + '">' : '<span class="sub">—</span>') + '</td><td><select data-uid="' + esc(u.id) + '"' + (self ? ' disabled title="You can\'t change your own role"' : '') + ' aria-label="Role for ' + esc(u.email) + '">' +
          ["pending", "viewer", "admin"].map(function (r) { return '<option' + (r === u.role ? ' selected' : '') + '>' + r + '</option>'; }).join("") +
          '</select></td><td class="sub">' + esc(new Date(u.created_at).toLocaleDateString("en-GB")) + '</td></tr>';
      }).join("");
    });
  }
  $("usersRows").addEventListener("change", function (e) {
    var n = e.target.closest("input[data-name]");
    if (n) {
      sb.from("profiles").update({ name: n.value.trim() }).eq("id", n.dataset.name).select().then(function (res) {
        if (res.error || !res.data || !res.data.length) { toast("Could not save the name: " + (res.error ? errText(res.error) : "not allowed")); return; }
        state.people[n.dataset.name] = n.value.trim() || n.placeholder; render(); toast("Name saved");
      });
      return;
    }
    var s = e.target.closest("select[data-uid]"); if (!s) return;
    s.disabled = true;
    sb.from("profiles").update({ role: s.value }).eq("id", s.dataset.uid).select().then(function (res) {
      s.disabled = false;
      if (res.error || !res.data || !res.data.length) { toast("Could not change the role: " + (res.error ? errText(res.error) : "not allowed")); loadUsers(); return; }
      toast("Role changed to " + s.value);
    });
  });

  render();
})();
