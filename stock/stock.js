/* Tamura Stock — machines and spare parts in stock (Supabase auth + database) */
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var cfg = window.APP_CONFIG || {};
  var FIELDS = ["kind", "name", "brand", "model", "partNo", "qty", "unit", "minQty", "location", "condition", "notes"];
  var COL = { partNo: "part_no", minQty: "min_qty" };
  var NUM = { qty: 1, minQty: 1 };
  var KIND_LABEL = { part: "Spare part", machine: "Machine" };
  var ST_LABEL = { ok: "In stock", low: "Low stock", out: "Out of stock" };
  var ST_ORDER = ["out", "low", "ok"], ST_PILL = { ok: "ok", low: "warn", out: "bad" };
  var FACETS = [{ k: "kind", label: "Type" }, { k: "brand", label: "Brand" }, { k: "model", label: "Machine model" }, { k: "location", label: "Location" }, { k: "st", label: "Stock status" }];
  var NCOLS = 9;

  var state = { docs: new Map(), q: "", sort: "name", dir: 1, group: "brand", shut: new Set(), shutFacet: {}, facetQ: {},
                sel: { kind: new Set(), brand: new Set(), model: new Set(), location: new Set(), st: new Set() },
                people: {}, role: null, user: null, ready: false, channel: null };
  function isAdmin() { return state.role === "admin"; }
  function canEdit(m) { return isAdmin() || (!!m && !!state.user && m.createdBy === state.user.id); }

  var VIEWS = ["viewLogin", "viewPending", "viewApp"];
  function show(id) { VIEWS.forEach(function (v) { $(v).hidden = v !== id; }); }
  function msg(el, text, kind) { el.textContent = text; el.className = "msg " + (kind || "err"); el.hidden = !text; }
  function toast(t) { var el = $("toast"); el.textContent = t; el.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(function () { el.hidden = true; }, 3500); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function natural(a, b) { return String(a || "").localeCompare(String(b || ""), undefined, { numeric: true, sensitivity: "base" }); }
  function errText(err) {
    var m = (err && (err.message || err.details)) || String(err);
    if (err && (err.code === "42501" || /row-level security|permission/i.test(m))) return "You don't have permission for this. You can add items and edit the ones you added.";
    return m;
  }

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
      $("btnImport").hidden = !isAdmin();
      show("viewApp"); load(); subscribe();
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
    var m = { _id: r.id, createdBy: r.created_by || "", updatedAt: r.updated_at };
    FIELDS.forEach(function (f) { var v = r[COL[f] || f]; m[f] = NUM[f] ? (Number(v) || 0) : (v == null ? "" : String(v)); });
    if (m.kind !== "machine") m.kind = "part";
    return m;
  }
  function load() {
    return Promise.all([
      sb.from("stock_items").select("*").order("name").range(0, 4999),
      sb.rpc("people")
    ]).then(function (out) {
      var res = out[0], pp = out[1];
      if (!pp.error) { var p = {}; (pp.data || []).forEach(function (u) { p[u.id] = u.name; }); state.people = p; }
      state.ready = true;
      if (res.error) {
        $("banner").hidden = false;
        $("banner").textContent = /relation|does not exist|schema cache/i.test(res.error.message)
          ? "The stock table is not set up yet. Run supabase/stock.sql once in the Supabase SQL Editor, then reload this page."
          : "Could not load the stock list: " + res.error.message;
        $("btnAdd").hidden = true; render(); return;
      }
      $("banner").hidden = true; $("btnAdd").hidden = false;
      var m = new Map(); res.data.forEach(function (r) { var o = fromRow(r); m.set(o._id, o); });
      state.docs = m; render();
    });
  }
  var reloadTimer;
  function subscribe() {
    if (state.channel) return;
    state.channel = sb.channel("stock-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "stock_items" }, function () { clearTimeout(reloadTimer); reloadTimer = setTimeout(load, 600); })
      .subscribe();
  }

  // ---------- helpers ----------
  function all() { return Array.from(state.docs.values()); }
  function status(m) { return m.qty <= 0 ? "out" : (m.minQty > 0 && m.qty <= m.minQty ? "low" : "ok"); }
  function who(m) { if (!m.createdBy) return ""; return state.people[m.createdBy] || (state.user && m.createdBy === state.user.id ? "You" : "Former user"); }
  function fval(m, k) { return k === "st" ? status(m) : (m[k] || "").trim(); }
  function flabel(k, v) { return k === "st" ? ST_LABEL[v] : k === "kind" ? KIND_LABEL[v] : (v || "Not set"); }
  function matches(m, skip) {
    for (var i = 0; i < FACETS.length; i++) { var k = FACETS[i].k, s = state.sel[k]; if (k !== skip && s.size && !s.has(fval(m, k))) return false; }
    var q = state.q.trim().toLowerCase();
    if (q && [m.name, m.brand, m.model, m.partNo, m.location, m.condition, m.notes, KIND_LABEL[m.kind]].join(" ").toLowerCase().indexOf(q) < 0) return false;
    return true;
  }
  function filtered() { return all().filter(function (m) { return matches(m); }); }
  function only(k) { var s = state.sel[k]; return s.size === 1 ? Array.from(s)[0] : ""; }
  function uniq(list, f) { var o = {}; list.forEach(function (m) { var v = (m[f] || "").trim(); if (v) o[v] = 1; }); return Object.keys(o).sort(natural); }
  function options(arr) { return arr.map(function (v) { return '<option value="' + esc(v) + '">'; }).join(""); }

  try { var pg = localStorage.getItem("tml.stockGroup"); if (pg != null) state.group = pg; } catch (e) {}
  $("fGroup").value = state.group;

  // ---------- render ----------
  function renderFacets(list) {
    var html = "";
    FACETS.forEach(function (f) {
      var k = f.k, sel = state.sel[k], counts = {}, vals = {};
      list.forEach(function (m) { vals[fval(m, k)] = 1; if (matches(m, k)) { var v = fval(m, k); counts[v] = (counts[v] || 0) + 1; } });
      var keys = k === "st" ? ST_ORDER.filter(function (v) { return vals[v]; }) : Object.keys(vals).sort(function (a, b) { return (a === "") - (b === "") || natural(a, b); });
      if (k === "location" && keys.length === 1 && keys[0] === "") return;
      html += '<details class="facet" data-f="' + k + '"' + (state.shutFacet[k] ? '' : ' open') + '><summary><span>' + f.label + (sel.size ? '<span class="sel">' + sel.size + ' selected</span>' : '') + '</span></summary>';
      if (keys.length > 8) html += '<input class="facet-q" type="search" data-f="' + k + '" placeholder="Find ' + f.label.toLowerCase() + '…" aria-label="Find ' + f.label.toLowerCase() + '" value="' + esc(state.facetQ[k] || "") + '">';
      html += '<div class="facet-list">';
      keys.forEach(function (v) {
        var n = counts[v] || 0;
        html += '<label class="opt' + (n ? '' : ' zero') + '"><input type="checkbox" data-f="' + k + '" data-v="' + esc(v) + '"' + (sel.has(v) ? ' checked' : '') + '><span class="t">' + esc(flabel(k, v)) + '</span><span class="n">' + n + '</span></label>';
      });
      html += '</div></details>';
    });
    $("facetBody").innerHTML = html;
    $("facetBody").querySelectorAll(".facet-q").forEach(narrow);
  }
  function narrow(input) { var q = input.value.trim().toLowerCase(); input.parentNode.querySelectorAll(".opt").forEach(function (o) { o.hidden = !!q && o.textContent.toLowerCase().indexOf(q) < 0; }); }
  function rowHtml(m) {
    var st = status(m), dash = '<span class="muted">—</span>';
    return '<tr class="row" data-id="' + esc(m._id) + '" tabindex="0">' +
      '<td class="c-kind"><span class="kind">' + KIND_LABEL[m.kind] + '</span><div class="model">' + esc(m.name) + '</div></td>' +
      '<td data-l="Brand" class="nw">' + (m.brand ? esc(m.brand) : dash) + '</td>' +
      '<td data-l="' + (m.kind === "machine" ? "Model" : "For machine") + '">' + (m.model ? esc(m.model) : dash) + '</td>' +
      '<td data-l="' + (m.kind === "machine" ? "Serial no." : "Part no.") + '" class="mono">' + esc(m.partNo) + '</td>' +
      '<td data-l="In stock" class="nw c-qty"><b class="qty">' + m.qty + '</b> <span class="sub">' + esc(m.unit) + '</span> <span class="pill ' + ST_PILL[st] + '">' + ST_LABEL[st] + '</span>' +
        (m.minQty > 0 ? '<div class="sub">min. ' + m.minQty + '</div>' : '') + '</td>' +
      '<td data-l="Location">' + esc(m.location) + '</td>' +
      '<td data-l="Condition">' + esc(m.condition) + '</td>' +
      '<td data-l="Notes" class="c-pc">' + (m.notes ? '<span class="note">' + esc(m.notes) + '</span>' : '') + '</td>' +
      '<td data-l="Added by" class="nw">' + esc(who(m)) + '</td></tr>';
  }
  function render() {
    var list = all();
    ["brand", "model", "location"].forEach(function (k) {
      var have = {}; list.forEach(function (m) { have[fval(m, k)] = 1; });
      state.sel[k].forEach(function (v) { if (!have[v]) state.sel[k].delete(v); });
    });
    var scope = list.filter(function (m) { return matches(m, "st"); }), c = { ok: 0, low: 0, out: 0 };
    scope.forEach(function (m) { c[status(m)]++; });
    $("sItems").textContent = scope.length; $("sOk").textContent = c.ok; $("sLow").textContent = c.low; $("sOut").textContent = c.out;
    $("sItemsH").textContent = scope.length === list.length ? "all items" : "of " + list.length + " in total";
    document.querySelectorAll(".stat").forEach(function (b) { var v = b.dataset.st || ""; b.classList.toggle("active", !!v && only("st") === v); });
    var nm = list.filter(function (m) { return m.kind === "machine"; }).length;
    $("lede").textContent = state.ready && list.length ? nm + (nm === 1 ? " machine" : " machines") + " · " + (list.length - nm) + " spare part " + (list.length - nm === 1 ? "item" : "items") + " · " + uniq(list, "brand").length + " brands" : "";
    $("brandList").innerHTML = options(uniq(list, "brand")); $("modelList").innerHTML = options(uniq(list, "model")); $("locList").innerHTML = options(uniq(list, "location"));

    renderFacets(list);
    var chips = "";
    FACETS.forEach(function (f) { state.sel[f.k].forEach(function (v) { chips += '<button class="chip" type="button" data-f="' + f.k + '" data-v="' + esc(v) + '"><small>' + f.label + '</small>' + esc(flabel(f.k, v)) + '<b aria-hidden="true">×</b></button>'; }); });
    if (state.q.trim()) chips += '<button class="chip" type="button" data-f="q"><small>Search</small>' + esc(state.q.trim()) + '<b aria-hidden="true">×</b></button>';
    $("chips").innerHTML = chips; $("chips").hidden = !chips; $("btnClear").hidden = !chips;
    var nsel = FACETS.reduce(function (n, f) { return n + state.sel[f.k].size; }, 0);
    $("fCount").hidden = !nsel; $("fCount").textContent = nsel;

    var rows = filtered(), key = state.sort, dir = state.dir, g = state.group;
    rows.sort(function (a, b) {
      if (g) { var ga = fval(a, g), gb = fval(b, g), gr = (ga === "") - (gb === "") || natural(g === "kind" ? KIND_LABEL[ga] : ga, g === "kind" ? KIND_LABEL[gb] : gb); if (gr) return gr; }
      var r = key === "qty" ? a.qty - b.qty : key === "by" ? natural(who(a), who(b)) : natural(a[key], b[key]);
      return r ? r * dir : natural(a.name, b.name);
    });
    document.querySelectorAll("th[data-sort]").forEach(function (h) {
      var base = h.textContent.replace(/[ ▲▼]+$/, "");
      h.innerHTML = esc(base) + (h.dataset.sort === key ? ' <span class="arrow">' + (dir > 0 ? "▲" : "▼") + '</span>' : "");
    });
    var html = "";
    if (!g) rows.forEach(function (m) { html += rowHtml(m); });
    else {
      var groups = [], cur = null;
      rows.forEach(function (m) { var v = fval(m, g); if (!cur || cur.v !== v) { cur = { v: v, items: [] }; groups.push(cur); } cur.items.push(m); });
      groups.forEach(function (gr) {
        var gid = g + "|" + gr.v, shut = state.shut.has(gid), s = { low: 0, out: 0 };
        gr.items.forEach(function (m) { var st = status(m); if (s[st] != null) s[st]++; });
        html += '<tr class="grp' + (shut ? ' shut' : '') + '" data-g="' + esc(gid) + '" tabindex="0"><td colspan="' + NCOLS + '"><div class="grp-in"><span class="car"></span><strong>' + esc(flabel(g, gr.v)) + '</strong>' +
          '<span class="n">' + gr.items.length + (gr.items.length === 1 ? ' item' : ' items') + '</span>' +
          (s.out ? '<span class="pill bad">' + s.out + ' out of stock</span>' : '') + (s.low ? '<span class="pill warn">' + s.low + ' low</span>' : '') + '</div></td></tr>';
        if (!shut) gr.items.forEach(function (m) { html += rowHtml(m); });
      });
    }
    $("rows").innerHTML = html;
    $("count").textContent = rows.length === list.length ? list.length + " items" : rows.length + " of " + list.length + " items";
    var empty = $("empty");
    if (!state.ready) { empty.hidden = false; }
    else if (!list.length) { empty.hidden = false; $("emptyTitle").textContent = "No stock items yet"; $("emptyText").textContent = "Add the first machine or spare part to start."; }
    else if (!rows.length) { empty.hidden = false; $("emptyTitle").textContent = "No items match"; $("emptyText").textContent = "Clear the search or remove a filter."; }
    else empty.hidden = true;
  }

  // ---------- list events ----------
  $("facetBody").addEventListener("change", function (e) {
    var b = e.target; if (b.type !== "checkbox" || !b.dataset.f) return;
    var s = state.sel[b.dataset.f]; if (b.checked) s.add(b.dataset.v); else s.delete(b.dataset.v); render();
  });
  $("facetBody").addEventListener("input", function (e) { if (e.target.classList.contains("facet-q")) { state.facetQ[e.target.dataset.f] = e.target.value; narrow(e.target); } });
  $("facetBody").addEventListener("toggle", function (e) { var d = e.target; if (d.dataset && d.dataset.f) state.shutFacet[d.dataset.f] = !d.open; }, true);
  $("btnClear").addEventListener("click", function () { FACETS.forEach(function (f) { state.sel[f.k].clear(); }); state.q = ""; $("q").value = ""; render(); });
  $("chips").addEventListener("click", function (e) {
    var b = e.target.closest(".chip"); if (!b) return;
    if (b.dataset.f === "q") { state.q = ""; $("q").value = ""; } else state.sel[b.dataset.f].delete(b.dataset.v);
    render();
  });
  document.querySelectorAll(".stat").forEach(function (b) {
    b.addEventListener("click", function () { var v = b.dataset.st || "", was = only("st") === v; state.sel.st.clear(); if (v && !was) state.sel.st.add(v); render(); });
  });
  $("fGroup").addEventListener("change", function () { state.group = this.value; try { localStorage.setItem("tml.stockGroup", state.group); } catch (e) {} render(); });
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
  document.querySelectorAll("dialog").forEach(function (d) { d.addEventListener("click", function (e) { if (e.target.closest("[data-close]") || e.target === d) d.close(); }); });

  // ---------- add / edit ----------
  var editing = null;
  function kindLabels() {
    var mach = $("e_kind").value === "machine";
    $("lName").textContent = mach ? "Machine name" : "Part name";
    $("lModel").textContent = mach ? "Model" : "For machine model";
    $("lPartNo").textContent = mach ? "Serial number" : "Part number";
    $("e_name").placeholder = mach ? "e.g. SPI demo unit" : "e.g. Projection lamp, Z-axis motor";
  }
  $("e_kind").addEventListener("change", kindLabels);
  function openEdit(id) {
    var m = id ? state.docs.get(id) : null; editing = m;
    var ok = m ? canEdit(m) : true;
    var preset = { kind: only("kind") || "part", brand: only("brand"), model: only("model"), location: only("location"), unit: "pcs", qty: 1, minQty: 0 };
    FIELDS.forEach(function (f) { var el = $("e_" + f); el.value = m ? m[f] : (preset[f] != null ? preset[f] : ""); el.disabled = !ok; });
    $("qMinus").disabled = $("qPlus").disabled = !ok;
    kindLabels();
    $("editTitle").textContent = m ? m.name : "Add item";
    $("editMeta").textContent = m ? ((who(m) ? "Added by " + who(m) + ". " : "") + (m.updatedAt ? "Last changed " + new Date(m.updatedAt).toLocaleString("en-GB") + ". " : "") +
      (!isAdmin() ? (ok ? "You added this item, so you can edit it." : "View only: you can edit the items you added yourself.") : "")) : "";
    $("btnSave").hidden = !ok;
    $("delArea").innerHTML = (m && isAdmin()) ? '<button class="btn danger" type="button" id="btnDel">Delete</button>' : '';
    $("dlgEdit").showModal();
    if (!m) setTimeout(function () { $("e_name").focus(); }, 30);
  }
  $("btnAdd").addEventListener("click", function () { openEdit(null); });
  function step(d) { var el = $("e_qty"); el.value = Math.max(0, (parseInt(el.value, 10) || 0) + d); }
  $("qMinus").addEventListener("click", function () { step(-1); });
  $("qPlus").addEventListener("click", function () { step(1); });
  $("delArea").addEventListener("click", function (e) {
    if (e.target.id === "btnDel") $("delArea").innerHTML = '<span class="confirm">Delete this item? <button class="btn danger solid" type="button" id="btnDelYes">Delete</button><button class="btn" type="button" id="btnDelNo">Keep</button></span>';
    if (e.target.id === "btnDelNo") $("delArea").innerHTML = '<button class="btn danger" type="button" id="btnDel">Delete</button>';
    if (e.target.id === "btnDelYes") sb.from("stock_items").delete().eq("id", editing._id).then(function (res) {
      if (res.error) { toast("Could not delete: " + errText(res.error)); return; }
      state.docs.delete(editing._id); render(); $("dlgEdit").close(); toast("Item deleted");
    });
  });
  $("editForm").addEventListener("submit", function (e) {
    e.preventDefault();
    if (editing && !canEdit(editing)) return;
    var row = {};
    FIELDS.forEach(function (f) { var v = $("e_" + f).value.trim(); row[COL[f] || f] = NUM[f] ? Math.max(0, parseInt(v, 10) || 0) : v; });
    if (!row.name) { toast("Give the item a name."); return; }
    if (!row.unit) row.unit = "pcs";
    var btn = $("btnSave"); btn.disabled = true;
    var q = editing ? sb.from("stock_items").update(row).eq("id", editing._id).select().single() : sb.from("stock_items").insert(row).select().single();
    q.then(function (res) {
      if (res.error) { toast("Could not save: " + errText(res.error)); return; }
      var o = fromRow(res.data); state.docs.set(o._id, o); render(); $("dlgEdit").close(); toast(editing ? "Item updated" : "Item added");
    }).finally(function () { btn.disabled = false; });
  });

  // ---------- import from Excel (admin) ----------
  var pending = null;
  function resetImport() { pending = null; $("impPreview").hidden = true; $("impPreview").innerHTML = ""; $("drop").hidden = false; $("btnDoImport").disabled = true; $("btnDoImport").textContent = "Import"; $("impStatus").textContent = ""; $("file").value = ""; }
  $("btnImport").addEventListener("click", function () { resetImport(); $("dlgImport").showModal(); });
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
        var wb = XLSX.read(new Uint8Array(fr.result), { type: "array" });
        showPreview(file.name, wb.SheetNames.map(function (name) {
          return { name: name, rows: XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: null, blankrows: true }) };
        }));
        $("impStatus").textContent = "";
      } catch (err) { $("impStatus").textContent = "This file could not be read as Excel (" + (err.message || err) + ")."; }
    };
    fr.readAsArrayBuffer(file);
  }
  function showPreview(fname, sheets) {
    var brands = uniq(all(), "brand");
    pending = { file: fname, sheets: sheets.map(function (s) {
      var res = parseStockSheet(s.name, s.rows), brand = stockBrandFromSheet(s.name, brands);
      return { name: s.name, items: res.items, warnings: res.warnings, brand: brand, model: stockModelFromTitle(res.title, brand, s.name), include: res.items.length > 0 };
    }) };
    $("drop").hidden = true;
    var h = '<div class="help"><strong style="color:var(--fg)">' + esc(fname) + '</strong>. Check the brand and machine for each sheet, untick sheets you don\'t want, then import.</div>';
    h += '<div class="tablebox"><table><thead><tr><th style="width:40px"></th><th>Sheet</th><th>Brand</th><th>For machine model</th><th>Items</th></tr></thead><tbody>';
    pending.sheets.forEach(function (s, i) {
      var off = s.items.length ? '' : ' disabled';
      h += '<tr><td><input type="checkbox" data-i="' + i + '" data-p="include" ' + (s.include ? 'checked' : '') + off + ' aria-label="Include sheet ' + esc(s.name) + '" style="width:auto"></td>' +
        '<td>' + esc(s.name) + (s.warnings.length ? '<div class="sub" style="color:var(--warn)">' + esc(s.warnings.join(" ")) + '</div>' : '') + '</td>' +
        '<td><input data-i="' + i + '" data-p="brand" list="brandList" value="' + esc(s.brand) + '" placeholder="No brand"' + off + ' aria-label="Brand for sheet ' + esc(s.name) + '"></td>' +
        '<td><input data-i="' + i + '" data-p="model" list="modelList" value="' + esc(s.model) + '" placeholder="Optional"' + off + ' aria-label="Machine model for sheet ' + esc(s.name) + '"></td>' +
        '<td class="mono">' + s.items.length + '</td></tr>';
    });
    h += '</tbody></table></div><div id="plan" class="help"></div><div class="progress" id="prog" hidden><i></i></div>';
    $("impPreview").innerHTML = h; $("impPreview").hidden = false;
    updatePlan();
  }
  function planImport() {
    var ex = {}; all().forEach(function (d) { ex[stockKey(d)] = d; });
    var add = [], upd = [], seen = {};
    pending.sheets.forEach(function (s) {
      if (!s.include) return;
      s.items.forEach(function (it) {
        var c = Object.assign({}, it);
        if (!c.brand) c.brand = s.brand.trim();
        if (!c.model) c.model = s.model.trim();
        var k = stockKey(c);
        if (seen[k]) { seen[k].qty += c.qty; return; }   // the same item twice in the file: add the quantities
        seen[k] = c;
        if (ex[k]) { c._id = ex[k]._id; upd.push(c); } else add.push(c);
      });
    });
    return { add: add, upd: upd };
  }
  function updatePlan() {
    var p = planImport(), n = p.add.length + p.upd.length;
    $("plan").innerHTML = n ? 'Ready: <strong style="color:var(--fg)">' + p.add.length + ' new</strong>' + (p.upd.length ? ', <strong style="color:var(--fg)">' + p.upd.length + ' already in stock</strong> (their quantity and details are replaced by the file)' : '') + '. Nothing is deleted.' : 'Select at least one sheet with items.';
    $("btnDoImport").disabled = !n; $("btnDoImport").textContent = n ? "Import " + n + " items" : "Import";
  }
  $("impPreview").addEventListener("input", function (e) {
    var i = e.target.dataset.i, p = e.target.dataset.p; if (i == null) return;
    pending.sheets[i][p] = e.target.type === "checkbox" ? e.target.checked : e.target.value;
    updatePlan();
  });
  function toDb(it) { var row = {}; FIELDS.forEach(function (f) { row[COL[f] || f] = it[f]; }); return row; }
  $("btnDoImport").addEventListener("click", function () {
    var p = planImport(), total = p.add.length + p.upd.length; if (!total) return;
    var btn = this; btn.disabled = true;
    var prog = $("prog"), bar = prog.querySelector("i"), done = 0; prog.hidden = false;
    function tick(n) { done += n; bar.style.width = (done / total * 100) + "%"; $("impStatus").textContent = "Saving… " + Math.round(done / total * 100) + "%"; }
    var chain = Promise.resolve();
    for (var i = 0; i < p.add.length; i += 200) (function (chunk) {
      chain = chain.then(function () { return sb.from("stock_items").insert(chunk.map(toDb)).then(function (r) { if (r.error) throw r.error; tick(chunk.length); }); });
    })(p.add.slice(i, i + 200));
    p.upd.forEach(function (it) {
      chain = chain.then(function () { return sb.from("stock_items").update(toDb(it)).eq("id", it._id).then(function (r) { if (r.error) throw r.error; tick(1); }); });
    });
    chain.then(function () {
      $("dlgImport").close(); toast("Imported " + total + " items"); load();
    }).catch(function (err) {
      $("impStatus").textContent = "Import stopped: " + errText(err) + ". Items saved before the error are kept; run the import again to finish."; load();
    }).finally(function () { btn.disabled = false; });
  });

  // ---------- export ----------
  $("btnExport").addEventListener("click", function () {
    if (typeof XLSX === "undefined") { toast("The Excel library did not load. Reload the page."); return; }
    var rows = filtered(); if (!rows.length) { toast("Nothing to export with the current filters."); return; }
    rows.sort(function (a, b) { return natural(a.brand, b.brand) || natural(a.model, b.model) || natural(a.name, b.name); });
    var aoa = [["No", "Type", "Brand", "Machine model", "Item", "Part / serial no.", "Qty", "Unit", "Minimum", "Status", "Location", "Condition", "Notes", "Added by"]];
    rows.forEach(function (m, i) { aoa.push([i + 1, KIND_LABEL[m.kind], m.brand, m.model, m.name, m.partNo, m.qty, m.unit, m.minQty, ST_LABEL[status(m)], m.location, m.condition, m.notes, who(m)]); });
    var ws = XLSX.utils.aoa_to_sheet(aoa);
    ws["!cols"] = [5, 12, 16, 22, 34, 20, 7, 7, 9, 13, 18, 14, 34, 16].map(function (w) { return { wch: w }; });
    var wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "Stock");
    var d = new Date();
    XLSX.writeFile(wb, "Tamura_Stock_" + d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0") + ".xlsx");
  });

  render();
})();
