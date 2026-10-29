/* Tamura Machine List — browser app (Supabase auth + database) */
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var cfg = window.APP_CONFIG || {};

  // ---------- column mapping (JS field ⇄ database column) ----------
  var COL = { lastCal: "last_cal", nextCal: "next_cal", pcModel: "pc_model", checkBy: "check_by" };
  function col(f) { return COL[f] || f; }
  function fromRow(r) {
    var m = { _id: r.id, key: r.key, updatedAt: r.updated_at };
    FIELDS.forEach(function (f) { var v = r[col(f)]; m[f] = v == null ? "" : String(v); });
    return m;
  }
  function toRow(m) {
    var r = { key: m.key };
    FIELDS.forEach(function (f) {
      var v = (m[f] || "").trim();
      r[col(f)] = (f === "lastCal" || f === "nextCal") ? (/^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null) : v;
    });
    return r;
  }

  // ---------- state ----------
  var state = { docs: new Map(), customer: "", kind: "", cal: "", q: "", sort: "customer", dir: 1,
                role: null, user: null, ready: false, channel: null };
  var TODAY = new Date(); TODAY.setHours(0, 0, 0, 0);
  function isAdmin() { return state.role === "admin"; }

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
    return next(0).then(function (rows) {
      var m = new Map(); rows.forEach(function (r) { var o = fromRow(r); m.set(o._id, o); });
      state.docs = m; state.ready = true; $("banner").hidden = true; render();
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
  function natural(a, b) { return String(a || "").localeCompare(String(b || ""), undefined, { numeric: true, sensitivity: "base" }); }
  function all() { return Array.from(state.docs.values()); }
  function filtered() {
    var q = state.q.trim().toLowerCase();
    return all().filter(function (m) {
      if (state.customer && m.customer !== state.customer) return false;
      if (state.kind && (m.kind || "").toUpperCase() !== state.kind) return false;
      if (state.cal && calInfo(m).status !== state.cal) return false;
      if (q) { var hay = FIELDS.map(function (f) { return m[f] || ""; }).join(" ").toLowerCase(); if (hay.indexOf(q) < 0) return false; }
      return true;
    });
  }
  function toast(t) { var el = $("toast"); el.textContent = t; el.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(function () { el.hidden = true; }, 3500); }
  function errText(err) {
    var m = (err && (err.message || err.details)) || String(err);
    if (err && (err.code === "42501" || /row-level security|permission/i.test(m))) return "You don't have permission to change the machine list.";
    if (err && err.code === "23505") return "A machine with this customer and serial number already exists.";
    return m;
  }

  // ---------- render ----------
  function render() {
    var list = all();
    var scope = list.filter(function (m) { return !state.customer || m.customer === state.customer; });
    var c = { overdue: 0, due: 0, none: 0 };
    scope.forEach(function (m) { var s = calInfo(m).status; if (c[s] != null) c[s]++; });
    $("sTotal").textContent = scope.length; $("sOver").textContent = c.overdue; $("sDue").textContent = c.due; $("sNone").textContent = c.none;
    document.querySelectorAll(".stat").forEach(function (b) { b.classList.toggle("active", (b.dataset.cal || "") === state.cal); });

    var custs = {}; list.forEach(function (m) { custs[m.customer] = (custs[m.customer] || 0) + 1; });
    var names = Object.keys(custs).sort(natural);
    if (state.customer && !custs[state.customer]) state.customer = "";
    var th = '<button class="tab" type="button" data-c="" aria-pressed="' + (!state.customer) + '">All customers <span class="n">' + list.length + '</span></button>';
    names.forEach(function (n) { th += '<button class="tab" type="button" data-c="' + esc(n) + '" aria-pressed="' + (state.customer === n) + '">' + esc(n) + ' <span class="n">' + custs[n] + '</span></button>'; });
    $("tabs").innerHTML = th;
    $("custList").innerHTML = names.map(function (n) { return '<option value="' + esc(n) + '">'; }).join("");

    var kinds = {}; list.forEach(function (m) { if (m.kind) kinds[m.kind.toUpperCase()] = 1; });
    var ks = Object.keys(kinds).sort(natural);
    $("fKind").innerHTML = '<option value="">All kinds</option>' + ks.map(function (k) { return '<option' + (k === state.kind ? ' selected' : '') + '>' + esc(k) + '</option>'; }).join("");
    $("kindList").innerHTML = ks.map(function (k) { return '<option value="' + esc(k) + '">'; }).join("");
    var oss = {}; list.forEach(function (m) { if (m.os) oss[m.os] = 1; });
    $("osList").innerHTML = Object.keys(oss).sort().map(function (k) { return '<option value="' + esc(k) + '">'; }).join("");

    var rows = filtered(), key = state.sort, dir = state.dir;
    rows.sort(function (a, b) {
      var r;
      if (key === "nextCal") { var ia = calInfo(a), ib = calInfo(b); r = (ia.next ? ia.next.getTime() : 9e15) - (ib.next ? ib.next.getTime() : 9e15); }
      else r = natural(a[key], b[key]);
      if (r === 0) r = natural(a.customer, b.customer) || natural(a.kind, b.kind) || natural(a.line, b.line);
      return r * dir;
    });
    document.querySelectorAll("th[data-sort]").forEach(function (h) {
      var base = h.textContent.replace(/[ ▲▼]+$/, "");
      h.innerHTML = esc(base) + (h.dataset.sort === key ? ' <span class="arrow">' + (dir > 0 ? "▲" : "▼") + '</span>' : "");
      h.setAttribute("aria-sort", h.dataset.sort === key ? (dir > 0 ? "ascending" : "descending") : "none");
    });
    var html = "";
    rows.forEach(function (m) {
      var ci = calInfo(m);
      var pc = [m.os, m.pcModel].filter(Boolean).join(" · "), pc2 = [m.memory, m.vga].filter(Boolean).join(" · ");
      html += '<tr data-id="' + esc(m._id) + '" tabindex="0">' +
        '<td>' + esc(m.customer) + (m.location ? '<div class="sub">' + esc(m.location) + '</div>' : '') + '</td>' +
        '<td><span class="kind">' + esc(m.kind) + '</span>' + (m.model ? '<div class="sub">' + esc(m.model) + '</div>' : '') + '</td>' +
        '<td class="mono">' + esc(m.line) + '</td>' +
        '<td class="mono">' + (m.serial ? esc(m.serial) : '<span class="muted">—</span>') + '</td>' +
        '<td class="nw">' + esc(fmtMonth(m.mfg)) + '</td>' +
        '<td class="mono">' + esc(m.version) + '</td>' +
        '<td class="nw">' + esc(fmtDate(m.lastCal)) + '</td>' +
        '<td class="nw">' + (ci.next ? '<div>' + esc(fmtDate(m.nextCal || iso(ci.next))) + (ci.est ? ' <span class="sub">(est.)</span>' : '') + '</div>' : '') +
          '<span class="pill ' + ({ overdue: "bad", due: "warn", ok: "ok", none: "none" }[ci.status]) + '">' + esc(ci.label) + '</span></td>' +
        '<td class="mono">' + esc(m.ip) + '</td>' +
        '<td class="pc">' + esc(pc) + (pc2 ? '<div class="sub">' + esc(pc2) + '</div>' : '') + (m.notes ? '<div class="sub" style="color:var(--copper)">' + esc(m.notes) + '</div>' : '') + '</td>' +
        '</tr>';
    });
    $("rows").innerHTML = html;
    $("count").textContent = rows.length + " of " + list.length + " shown";
    var empty = $("empty");
    if (!state.ready) { empty.hidden = false; $("emptyTitle").textContent = "Loading machines…"; $("emptyText").textContent = "The machine list appears here once it loads."; }
    else if (!list.length) { empty.hidden = false; $("emptyTitle").textContent = "No machines yet"; $("emptyText").textContent = isAdmin() ? "Upload your Excel machine list or add a machine by hand to start." : "Nothing has been added yet."; }
    else if (!rows.length) { empty.hidden = false; $("emptyTitle").textContent = "No machines match"; $("emptyText").textContent = "Clear the search or pick another filter."; }
    else empty.hidden = true;
  }

  // ---------- list events ----------
  $("tabs").addEventListener("click", function (e) { var b = e.target.closest(".tab"); if (!b) return; state.customer = b.dataset.c; render(); });
  document.querySelectorAll(".stat").forEach(function (b) { b.addEventListener("click", function () { state.cal = b.dataset.cal || ""; $("fCal").value = state.cal; render(); }); });
  $("fKind").addEventListener("change", function () { state.kind = this.value; render(); });
  $("fCal").addEventListener("change", function () { state.cal = this.value; render(); });
  var qt; $("q").addEventListener("input", function () { var v = this.value; clearTimeout(qt); qt = setTimeout(function () { state.q = v; render(); }, 120); });
  document.querySelector("thead").addEventListener("click", function (e) { var h = e.target.closest("th[data-sort]"); if (!h) return; if (state.sort === h.dataset.sort) state.dir *= -1; else { state.sort = h.dataset.sort; state.dir = 1; } render(); });
  $("rows").addEventListener("click", function (e) { var tr = e.target.closest("tr[data-id]"); if (tr) openEdit(tr.dataset.id); });
  $("rows").addEventListener("keydown", function (e) { if (e.key === "Enter") { var tr = e.target.closest("tr[data-id]"); if (tr) openEdit(tr.dataset.id); } });
  document.querySelectorAll("dialog").forEach(function (d) {
    d.addEventListener("click", function (e) { if (e.target.closest("[data-close]") || e.target === d) d.close(); });
  });

  // ---------- add / edit ----------
  var editing = null;
  function openEdit(id) {
    var m = id ? state.docs.get(id) : null; editing = m;
    var canEdit = isAdmin();
    $("editTitle").textContent = m ? (m.kind + " " + (m.serial || ("line " + m.line))) : "Add machine";
    FIELDS.forEach(function (f) { var el = $("e_" + f); el.value = m ? (m[f] || "") : (f === "customer" ? state.customer : ""); el.disabled = !canEdit; });
    var mfg = $("e_mfg");
    if (m && m.mfg && !/^\d{4}-\d{2}$/.test(m.mfg)) { mfg.type = "text"; mfg.value = m.mfg; } else { mfg.type = "month"; mfg.value = m ? (m.mfg || "") : ""; }
    $("editMeta").textContent = m && m.updatedAt ? "Last changed " + new Date(m.updatedAt).toLocaleString("en-GB") : "";
    $("btnSave").hidden = !canEdit;
    $("delArea").innerHTML = (m && canEdit) ? '<button class="btn danger" type="button" id="btnDel">Delete</button>' : '';
    $("dlgEdit").showModal();
    if (!m && canEdit) setTimeout(function () { $(state.customer ? "e_kind" : "e_customer").focus(); }, 30);
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
    if (!isAdmin()) return;
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
    XLSX.writeFile(buildWorkbook(by), "Tamura_Machine_List_" + (state.customer ? state.customer.replace(/\W+/g, "_") + "_" : "") + iso(new Date()) + ".xlsx");
  });
  $("btnTemplate").addEventListener("click", function () {
    if (typeof XLSX === "undefined") { toast("The Excel library did not load. Reload the page."); return; }
    var ex = {}; FIELDS.forEach(function (f) { ex[f] = ""; });
    Object.assign(ex, { customer: "New Customer", kind: "SPI", model: "KY8030 Nova", line: "1", serial: "SV-SL-00000", mfg: "2026-01", version: "5.2.3.0",
      lastCal: "2026-01-15", nextCal: "2027-01-15", ip: "192.168.0.10", os: "Windows 10 Enterprise LTSC 64-bit", pcModel: "Dell OptiPlex XE4",
      memory: "32768 MB", vga: "NVIDIA T400", notes: "Example row, replace or delete" });
    XLSX.writeFile(buildWorkbook({ "New Customer": [ex] }), "Machine_List_Template.xlsx");
  });

  // ---------- users (admin) ----------
  $("btnUsers").addEventListener("click", function () { $("dlgUsers").showModal(); loadUsers(); });
  function loadUsers() {
    $("usersStatus").textContent = "Loading…";
    sb.from("profiles").select("id,email,role,created_at").order("created_at").then(function (res) {
      if (res.error) { $("usersStatus").textContent = errText(res.error); return; }
      $("usersStatus").textContent = res.data.length + " users";
      $("usersRows").innerHTML = res.data.map(function (u) {
        var self = state.user && u.id === state.user.id;
        return '<tr><td>' + esc(u.email) + (self ? ' <span class="sub">(you)</span>' : '') + '</td><td><select data-uid="' + esc(u.id) + '"' + (self ? ' disabled title="You can\'t change your own role"' : '') + ' aria-label="Role for ' + esc(u.email) + '">' +
          ["pending", "viewer", "admin"].map(function (r) { return '<option' + (r === u.role ? ' selected' : '') + '>' + r + '</option>'; }).join("") +
          '</select></td><td class="sub">' + esc(new Date(u.created_at).toLocaleDateString("en-GB")) + '</td></tr>';
      }).join("");
    });
  }
  $("usersRows").addEventListener("change", function (e) {
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
