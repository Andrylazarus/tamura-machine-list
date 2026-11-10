(function () {
  const STATUSES = [
    { id: "todo", label: "To do", color: "var(--muted)" },
    { id: "progress", label: "In progress", color: "var(--accent)" },
    { id: "waiting", label: "Waiting / follow-up", color: "var(--warn)" },
    { id: "done", label: "Done", color: "var(--ok)" }
  ];
  const CATEGORIES = ["Customer visit", "Calibration", "Training", "Machine programming", "Repair / troubleshooting", "Report", "Admin", "Other"];
  const PRI_LABEL = { high: "High", medium: "Medium", low: "Low" };
  const PRI_RANK = { high: 0, medium: 1, low: 2 };
  const OTHER = "__other";
  const PAGE = document.body.dataset.page === "schedule" ? "schedule" : "tasks";

  const $ = (id) => document.getElementById(id);
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "text") el.textContent = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const c of kids.flat()) if (c != null) el.append(c.nodeType ? c : document.createTextNode(String(c)));
    return el;
  }

  const state = { showDeadlines: true, lane: "todo", tasks: [], notes: {}, members: [], view: "board", quick: "", q: "", who: "", cat: "", pri: "", me: null, role: null, editing: null };
  let sb = null, channel = null;

  for (const s of STATUSES) $("fStatus").append(h("option", { value: s.id, text: s.label }));
  for (const c of CATEGORIES) { $("fCategory").append(h("option", { value: c, text: c })); $("fCat").append(h("option", { value: c, text: c })); }

  // ---------- Dates ----------
  function dayDiff(due) { if (!due) return null; const [y, m, d] = due.split("-").map(Number); const t = new Date(); t.setHours(0, 0, 0, 0); return Math.round((new Date(y, m - 1, d) - t) / 86400000); }
  function fmtDue(due) { const [y, m, d] = due.split("-").map(Number); return new Date(y, m - 1, d).toLocaleDateString(undefined, { day: "numeric", month: "short" }); }
  function fmtTime(iso) { return iso ? new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : ""; }
  function dueChip(t) {
    if (!t.due) return null;
    const n = dayDiff(t.due);
    if (t.status === "done") return h("span", { class: "chip", text: "Due " + fmtDue(t.due) });
    if (n < 0) return h("span", { class: "chip overdue", text: "Overdue " + (-n) + "d" });
    if (n === 0) return h("span", { class: "chip soon", text: "Due today" });
    if (n <= 2) return h("span", { class: "chip soon", text: "Due " + fmtDue(t.due) });
    return h("span", { class: "chip", text: "Due " + fmtDue(t.due) });
  }
  const codeOf = (t) => (isAct(t) ? "ACT-" : "TSK-") + String(t.num || 0).padStart(3, "0");
  const isAct = (t) => t.kind === "activity";
  const hm = (v) => (v || "").slice(0, 5);
  function timeRange(t) { return t.start_time ? hm(t.start_time) + (t.end_time ? "–" + hm(t.end_time) : "") : "All day"; }
  function calUrl(t) {
    if (!t.due) return null;
    if (isAct(t) && t.start_time) {
      const d = t.due.replace(/-/g, ""), st = hm(t.start_time).replace(":", "");
      let en = t.end_time ? hm(t.end_time).replace(":", "") : String((Number(st.slice(0, 2)) + 1) % 24).padStart(2, "0") + st.slice(2);
      const det = [t.details, "Activity " + codeOf(t) + " on the Team Task Board: " + location.href.split("#")[0]].filter(Boolean).join("\n\n");
      return "https://calendar.google.com/calendar/render?action=TEMPLATE&text=" + encodeURIComponent(t.title) + "&dates=" + d + "T" + st + "00/" + d + "T" + en + "00&ctz=Asia/Jakarta&details=" + encodeURIComponent(det) + (t.customer ? "&location=" + encodeURIComponent(t.customer) : "");
    }
    const a = t.due.replace(/-/g, "");
    const [y, m, d] = t.due.split("-").map(Number);
    const n = new Date(y, m - 1, d + 1);
    const b = n.getFullYear() + String(n.getMonth() + 1).padStart(2, "0") + String(n.getDate()).padStart(2, "0");
    const details = [t.details, t.customer ? "Customer: " + t.customer : "", "Task " + codeOf(t) + " on the Team Task Board: " + location.href.split("#")[0]].filter(Boolean).join("\n\n");
    return "https://calendar.google.com/calendar/render?action=TEMPLATE&text=" + encodeURIComponent(t.title) + "&dates=" + a + "/" + b + "&details=" + encodeURIComponent(details) + (t.customer ? "&location=" + encodeURIComponent(t.customer) : "");
  }

  // ---------- People ----------
  function displayName(email) {
    if (!email) return "";
    const local = email.split("@")[0].replace(/[._-]+/g, " ").replace(/\d+/g, " ").trim();
    return (local || email).split(/\s+/).map(w => w[0].toUpperCase() + w.slice(1)).join(" ");
  }
  function personName(id) { if (!id) return ""; const m = state.members.find(x => x.id === id); return m ? displayName(m.email) : "Former member"; }
  function initials(s) { return (s || "?").split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join(""); }
  function assigneeName(t) { return t.assignee ? personName(t.assignee) : (t.assignee_label || ""); }
  function whoNode(t) {
    const name = assigneeName(t);
    if (!name) return h("span", { class: "who" }, h("span", { text: "Unassigned" }));
    return h("span", { class: "who", title: t.assignee ? (state.members.find(x => x.id === t.assignee) || {}).email || "" : "" }, h("span", { class: "ini", text: initials(name) }), h("span", { text: name + (t.assignee === state.me ? " (you)" : "") }));
  }
  function fillMemberSelects() {
    const keepWho = $("fWho").value;
    $("fWho").replaceChildren(h("option", { value: "", text: "Everyone" }), h("option", { value: "none", text: "Unassigned" }),
      ...state.members.map(m => h("option", { value: m.id, text: displayName(m.email) + (m.id === state.me ? " (you)" : "") })));
    $("fWho").value = keepWho;
    $("fAssignee").replaceChildren(h("option", { value: "", text: "Unassigned" }),
      ...state.members.map(m => h("option", { value: m.id, text: displayName(m.email) + (m.id === state.me ? " (you)" : "") })),
      h("option", { value: OTHER, text: "Someone else…" }));
  }

  // ---------- Filtering & rendering ----------
  const isMine = (t) => state.me && t.assignee === state.me;
  function visible() {
    const q = state.q.trim().toLowerCase();
    return state.tasks.filter(t => {
      if (isAct(t)) return false;
      if (state.cat && t.category !== state.cat) return false;
      if (state.pri && t.priority !== state.pri) return false;
      if (state.who === "none" && (t.assignee || t.assignee_label)) return false;
      if (state.who && state.who !== "none" && t.assignee !== state.who) return false;
      if (state.quick === "open" && t.status === "done") return false;
      if (state.quick === "overdue" && !(t.status !== "done" && t.due && dayDiff(t.due) < 0)) return false;
      if (state.quick === "week") { const n = dayDiff(t.due); if (t.status === "done" || n == null || n < 0 || n > 7) return false; }
      if (state.quick === "mine" && !isMine(t)) return false;
      if (q) {
        const hay = [t.title, t.details, t.customer, t.category, assigneeName(t), codeOf(t), ...(state.notes[t.id] || []).map(n => n.body)].join(" ").toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    }).sort((a, b) => {
      const ad = a.due || "9999", bd = b.due || "9999";
      if (ad !== bd) return ad < bd ? -1 : 1;
      return (PRI_RANK[a.priority] ?? 1) - (PRI_RANK[b.priority] ?? 1);
    });
  }
  function renderStats() {
    if (PAGE === "schedule") {
      const acts = state.tasks.filter(isAct);
      const inRange = (t, a, b) => { const n = dayDiff(t.due); return n != null && n >= a && n <= b; };
      $("sToday").textContent = acts.filter(t => inRange(t, 0, 0)).length;
      $("sTomorrow").textContent = acts.filter(t => inRange(t, 1, 1)).length;
      $("sWeek").textContent = acts.filter(t => inRange(t, 0, 6)).length;
      $("sDeadlines").textContent = state.tasks.filter(t => !isAct(t) && t.status !== "done" && inRange(t, 0, 6)).length;
      return;
    }
    const open = state.tasks.filter(t => !isAct(t) && t.status !== "done");
    $("sOpen").textContent = open.length;
    $("sOver").textContent = open.filter(t => t.due && dayDiff(t.due) < 0).length;
    $("sWeek").textContent = open.filter(t => { const n = dayDiff(t.due); return n != null && n >= 0 && n <= 7; }).length;
    $("sMine").textContent = open.filter(isMine).length;
    document.querySelectorAll("[data-quick]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.quick === state.quick)));
  }
  function card(t) {
    const n = (state.notes[t.id] || []).length;
    const el = h("button", { class: "card p-" + (t.priority || "medium"), type: "button", draggable: "true", onclick: () => openDrawer(t) },
      h("div", { class: "row" }, h("span", { class: "code", text: codeOf(t) }), h("span", { class: "chip", text: PRI_LABEL[t.priority] || "Medium" })),
      h("div", { class: "t", text: t.title }),
      h("div", { class: "chips" }, dueChip(t), t.category ? h("span", { class: "chip", text: t.category }) : null, t.customer ? h("span", { class: "chip", text: t.customer }) : null),
      h("div", { class: "row" }, whoNode(t), n ? h("span", { class: "notes-n", text: n + (n === 1 ? " update" : " updates") }) : null)
    );
    el.addEventListener("dragstart", (e) => { e.dataTransfer.setData("text/plain", t.id); e.dataTransfer.effectAllowed = "move"; });
    return el;
  }
  function renderBoard(list) {
    const tabs = h("div", { class: "lane-tabs", role: "tablist", "aria-label": "Status" },
      STATUSES.map(s => h("button", { type: "button", role: "tab", "aria-selected": String(state.lane === s.id), onclick: () => { state.lane = s.id; render(); } },
        h("span", { class: "dot", style: "background:" + s.color }), s.label, h("span", { class: "n", text: String(list.filter(t => t.status === s.id).length) }))));
    const board = h("div", { class: "board" });
    for (const s of STATUSES) {
      const items = list.filter(t => t.status === s.id);
      const lane = h("section", { class: "lane" + (state.lane === s.id ? " active" : ""), "aria-label": s.label },
        h("div", { class: "lane-h" }, h("h2", null, h("span", { class: "dot", style: "background:" + s.color }), s.label), h("span", { class: "n", text: String(items.length) })),
        items.length ? items.map(card) : h("div", { class: "lane-empty", text: s.id === "done" ? "Finished tasks land here" : "No tasks" }));
      lane.addEventListener("dragover", (e) => { e.preventDefault(); lane.classList.add("drop"); });
      lane.addEventListener("dragleave", () => lane.classList.remove("drop"));
      lane.addEventListener("drop", (e) => { e.preventDefault(); lane.classList.remove("drop"); moveTask(e.dataTransfer.getData("text/plain"), s.id); });
      board.append(lane);
    }
    return h("div", null, tabs, board);
  }
  function renderList(list) {
    const st = Object.fromEntries(STATUSES.map(s => [s.id, s]));
    const body = h("tbody");
    if (!list.length) body.append(h("tr", null, h("td", { colspan: "7", style: "color:var(--muted);text-align:center;padding:24px", text: "No tasks match these filters." })));
    for (const t of list) {
      const s = st[t.status] || st.todo;
      body.append(h("tr", { class: "r", tabindex: "0", onclick: () => openDrawer(t), onkeydown: (e) => { if (e.key === "Enter") openDrawer(t); } },
        h("td", null, h("span", { class: "code", text: codeOf(t) })),
        h("td", null, h("b", { text: t.title })),
        h("td", null, h("span", { class: "status-pill", style: "color:" + s.color + ";border:1px solid currentColor", text: s.label })),
        h("td", null, whoNode(t)),
        h("td", { class: "num" }, dueChip(t) || "–"),
        h("td", null, PRI_LABEL[t.priority] || "Medium"),
        h("td", null, t.customer || "–")));
    }
    return h("div", { class: "list-wrap" }, h("table", { class: "list" },
      h("thead", null, h("tr", null, ["ID", "Task", "Status", "Assigned to", "Due", "Priority", "Customer"].map(x => h("th", { text: x })))), body));
  }
  function dayLabel(d) {
    const n = dayDiff(d);
    const nice = new Date(d + "T00:00:00").toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short" });
    return { main: n === 0 ? "Today" : n === 1 ? "Tomorrow" : n === -1 ? "Yesterday" : nice, sub: (n >= -1 && n <= 1) ? nice : "" };
  }
  function renderSchedule() {
    const q = state.q.trim().toLowerCase();
    const match = (t) => {
      if (state.cat && t.category !== state.cat) return false;
      if (state.who === "none" && (t.assignee || t.assignee_label)) return false;
      if (state.who && state.who !== "none" && t.assignee !== state.who) return false;
      if (q && ![t.title, t.details, t.customer, t.category, assigneeName(t), codeOf(t)].join(" ").toLowerCase().includes(q)) return false;
      return true;
    };
    const from = state.showPast ? -14 : 0;
    const items = state.tasks.filter(t => t.due && match(t) && dayDiff(t.due) >= from &&
      (isAct(t) || (state.showDeadlines && t.status !== "done" && (!state.pri || t.priority === state.pri))));
    const days = {};
    for (const t of items) (days[t.due] = days[t.due] || []).push(t);
    const order = (t) => isAct(t) ? (t.start_time ? "0" + t.start_time : "00") : "2";
    const bar = h("div", { class: "sched-bar" },
      h("p", { class: "hint", text: state.showDeadlines ? "Activities and task deadlines, day by day." : "Activities, day by day." }),
      h("button", { class: "btn", type: "button", text: state.showPast ? "Hide past days" : "Show past 14 days", onclick: () => { state.showPast = !state.showPast; render(); } }));
    const keys = Object.keys(days).sort();
    if (!keys.length) return h("div", { class: "sched" }, bar, h("div", { class: "sched-empty" },
      h("p", { style: "margin:0 0 12px", text: "Nothing scheduled yet." }),
      h("button", { class: "btn primary", type: "button", text: "+ Add an activity", onclick: () => openDrawer(null, "activity") })));
    return h("div", { class: "sched" }, bar, keys.map(d => {
      const n = dayDiff(d), lab = dayLabel(d);
      return h("section", { class: "day" + (n === 0 ? " today" : "") + (n < 0 ? " past" : "") },
        h("h3", null, h("b", { text: lab.main }), lab.sub ? h("span", { text: lab.sub }) : null),
        h("div", { class: "day-items" }, days[d].sort((a, b) => order(a).localeCompare(order(b))).map(t => {
          const who = assigneeName(t);
          const meta = [t.customer, who + (t.assignee === state.me ? " (you)" : "")].filter(Boolean).join(" · ");
          return h("button", { class: "ev" + (isAct(t) ? "" : " deadline p-" + t.priority), type: "button", onclick: () => openDrawer(t) },
            h("span", { class: "time", text: isAct(t) ? timeRange(t) : "Deadline" }),
            h("span", null, h("div", { class: "t", text: t.title }), meta ? h("div", { class: "m", text: meta }) : null),
            h("span", { class: "tag", text: isAct(t) ? (t.category || "Activity") : (PRI_LABEL[t.priority] || "Medium") + " · " + (STATUSES.find(s => s.id === t.status) || {}).label }));
        })));
    }));
  }
  const mobile = window.matchMedia("(max-width: 700px)");
  mobile.addEventListener("change", () => render());
  function render() {
    renderStats();
    const list = visible();
    const v = PAGE === "schedule" ? "schedule" : (state.view === "list" && mobile.matches) || state.view === "schedule" ? "board" : state.view;
    $("main").replaceChildren(v === "schedule" ? renderSchedule() : v === "list" ? renderList(list) : renderBoard(list));
    const customers = [...new Set(state.tasks.map(t => t.customer).filter(Boolean))].sort();
    $("customerList").replaceChildren(...customers.map(c => h("option", { value: c })));
    if (state.editing) { const t = current(); if (t) { renderThread(); renderMeta(t); } }
  }

  let toastTimer;
  function toast(msg) { const t = $("toast"); t.textContent = msg; t.classList.add("show"); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), 2600); }
  function notice(msg) { const n = $("notice"); n.textContent = msg || ""; n.hidden = !msg; }
  function fail(what, err) { console.error(err); toast(what + ": " + ((err && err.message) || "check your connection and try again")); }

  // ---------- Drawer ----------
  const current = () => state.tasks.find(t => t.id === state.editing);
  const canDelete = (t) => state.role === "admin" || t.created_by === state.me;
  function renderMeta(t) {
    $("metaLine").textContent = "Created " + fmtTime(t.created_at) + " by " + (personName(t.created_by) || "someone") +
      (t.updated_at && t.updated_at !== t.created_at ? " · Last updated " + fmtTime(t.updated_at) + " by " + (personName(t.updated_by) || "someone") : "");
    const url = calUrl(t); $("calLink").hidden = !url; if (url) $("calLink").href = url;
  }
  let drawerKind = "task";
  function setKind(k) {
    drawerKind = k;
    const act = k === "activity";
    document.querySelectorAll("[data-kind]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.kind === k)));
    $("lStatus").hidden = act; $("lPriority").hidden = act;
    $("lStart").hidden = !act; $("lEnd").hidden = !act;
    $("lDue").textContent = act ? "Date" : "Due date";
    $("lTitle").textContent = act ? "Activity" : "Task";
    $("fDue").required = act;
    $("fTitle").placeholder = act ? "e.g. Customer visit at PT ABC, SPI training for new trainees" : "e.g. Calibrate Koh Young SPI at customer line 3";
    const t = current();
    $("dTitle").textContent = act ? (t ? "Activity details" : "New activity") : (t ? "Task details" : "New task");
  }
  document.querySelectorAll("[data-kind]").forEach(b => b.addEventListener("click", () => setKind(b.dataset.kind)));
  function openDrawer(t, kind) {
    state.editing = t ? t.id : null;
    $("dTitle").textContent = t ? "Task details" : "New task";
    $("dCode").textContent = t ? codeOf(t) : "";
    $("fTitle").value = t ? t.title : "";
    $("fDesc").value = t ? t.details : "";
    $("fStatus").value = t ? t.status : "todo";
    $("fPriority").value = t ? t.priority : "medium";
    $("fDue").value = t && t.due ? t.due : "";
    $("fStart").value = t ? hm(t.start_time) : "";
    $("fEnd").value = t ? hm(t.end_time) : "";
    setKind(t ? (isAct(t) ? "activity" : "task") : (kind || "task"));
    $("fCategory").value = t ? (CATEGORIES.includes(t.category) ? t.category : "Other") : "Customer visit";
    $("fCustomer").value = t ? t.customer : "";
    if (t && t.assignee && state.members.some(m => m.id === t.assignee)) $("fAssignee").value = t.assignee;
    else if (t && t.assignee_label) { $("fAssignee").value = OTHER; }
    else $("fAssignee").value = t ? "" : (state.me || "");
    $("fAssigneeLabel").value = t ? t.assignee_label : "";
    $("otherWrap").hidden = $("fAssignee").value !== OTHER;
    $("followSec").hidden = !t;
    $("delBtn").hidden = !(t && canDelete(t));
    $("confirmDel").hidden = true;
    $("noteText").value = "";
    $("calLink").hidden = true;
    $("metaLine").textContent = "";
    if (t) { renderMeta(t); renderThread(); }
    $("drawer").classList.add("open"); $("drawer").setAttribute("aria-hidden", "false"); $("scrim").classList.add("open");
    if (!t || !window.matchMedia("(max-width: 700px)").matches) setTimeout(() => $("fTitle").focus(), 50);
  }
  function closeDrawer() { state.editing = null; $("drawer").classList.remove("open"); $("drawer").setAttribute("aria-hidden", "true"); $("scrim").classList.remove("open"); }
  function renderThread() {
    const notes = (state.notes[state.editing] || []).slice().sort((a, b) => b.created_at < a.created_at ? -1 : 1);
    $("thread").replaceChildren(...(notes.length ? notes.map(n => h("div", { class: "note" },
      h("div", { class: "meta" }, h("b", { text: personName(n.created_by) || "Someone" }),
        h("span", null, fmtTime(n.created_at), (state.role === "admin" || n.created_by === state.me) ? [" · ", h("button", { class: "del", type: "button", text: "Delete", onclick: () => deleteNote(n) })] : null)),
      h("p", { text: n.body }))) : [h("div", { class: "hint", text: "No updates yet. Post one so the team knows where this stands." })]));
  }
  $("fAssignee").addEventListener("change", () => { $("otherWrap").hidden = $("fAssignee").value !== OTHER; if (!$("otherWrap").hidden) $("fAssigneeLabel").focus(); });

  // ---------- Writes ----------
  $("form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const title = $("fTitle").value.trim();
    if (!title) { $("fTitle").focus(); return; }
    const a = $("fAssignee").value;
    const act = drawerKind === "activity";
    if (act && !$("fDue").value) { $("fDue").focus(); return toast("Pick a date for the activity."); }
    if (act && $("fStart").value && $("fEnd").value && $("fEnd").value <= $("fStart").value) { $("fEnd").focus(); return toast("End time must be after the start time."); }
    const row = {
      kind: drawerKind, start_time: act ? ($("fStart").value || null) : null, end_time: act ? ($("fEnd").value || null) : null,
      title, details: $("fDesc").value.trim(), status: act ? (current() ? current().status : "todo") : $("fStatus").value, priority: act ? "medium" : $("fPriority").value,
      due: $("fDue").value || null, category: $("fCategory").value, customer: $("fCustomer").value.trim(),
      assignee: a && a !== OTHER ? a : null, assignee_label: a === OTHER ? $("fAssigneeLabel").value.trim() : ""
    };
    $("saveBtn").disabled = true;
    const r = state.editing ? await sb.from("tasks").update(row).eq("id", state.editing) : await sb.from("tasks").insert(row);
    $("saveBtn").disabled = false;
    if (r.error) {
      if (/kind|start_time|end_time/.test(r.error.message || "")) return toast("Activities need a database update. Run the latest supabase/tasks.sql in the Supabase SQL Editor.");
      return fail("Couldn't save", r.error);
    }
    toast((act ? "Activity" : "Task") + (state.editing ? " updated" : " added"));
    closeDrawer();
    reload();
  });
  $("noteBtn").addEventListener("click", async () => {
    const body = $("noteText").value.trim();
    if (!state.editing || !body) return;
    $("noteBtn").disabled = true;
    const r = await sb.from("task_notes").insert({ task_id: state.editing, body });
    $("noteBtn").disabled = false;
    if (r.error) return fail("Couldn't post the update", r.error);
    $("noteText").value = "";
    toast("Update posted");
    reload();
  });
  async function deleteNote(n) {
    const r = await sb.from("task_notes").delete().eq("id", n.id);
    if (r.error) return fail("Couldn't delete the note", r.error);
    reload();
  }
  async function moveTask(id, status) {
    const t = state.tasks.find(x => x.id === id);
    if (!t || t.status === status) return;
    t.status = status; render();
    const r = await sb.from("tasks").update({ status }).eq("id", id);
    if (r.error) { fail("Couldn't move the task", r.error); return reload(); }
    toast("Moved to " + STATUSES.find(s => s.id === status).label);
  }
  $("delBtn").addEventListener("click", () => { $("confirmDel").hidden = false; });
  $("delNo").addEventListener("click", () => { $("confirmDel").hidden = true; });
  $("delYes").addEventListener("click", async () => {
    const r = await sb.from("tasks").delete().eq("id", state.editing).select("id");
    if (r.error) return fail("Couldn't delete the task", r.error);
    if (!r.data || !r.data.length) return toast("Only the person who created this task, or an admin, can delete it.");
    toast("Task deleted"); closeDrawer(); reload();
  });

  // ---------- UI events ----------
  const newKind = () => (PAGE === "schedule" ? "activity" : "task");
  $("newBtn").addEventListener("click", () => openDrawer(null, newKind()));
  $("fab").addEventListener("click", () => openDrawer(null, newKind()));
  if ($("fDeadlines")) $("fDeadlines").addEventListener("change", (e) => { state.showDeadlines = e.target.checked; render(); });
  $("dClose").addEventListener("click", closeDrawer);
  $("cancelBtn").addEventListener("click", closeDrawer);
  $("scrim").addEventListener("click", closeDrawer);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && $("drawer").classList.contains("open")) closeDrawer(); });
  $("q").addEventListener("input", (e) => { state.q = e.target.value; render(); });
  $("fWho").addEventListener("change", (e) => { state.who = e.target.value; render(); });
  $("fCat").addEventListener("change", (e) => { state.cat = e.target.value; render(); });
  $("fPri").addEventListener("change", (e) => { state.pri = e.target.value; render(); });
  document.querySelectorAll("[data-quick]").forEach(b => b.addEventListener("click", () => { state.quick = state.quick === b.dataset.quick ? "" : b.dataset.quick; render(); }));
  function setView(v) { state.view = v; document.querySelectorAll("[data-view]").forEach(x => x.setAttribute("aria-pressed", String(x.dataset.view === v))); }
  document.querySelectorAll("[data-view]").forEach(b => b.addEventListener("click", () => { setView(b.dataset.view); try { localStorage.setItem("ttb-view", state.view); } catch (_) {} render(); }));
  try { const v = localStorage.getItem("ttb-view"); if (v === "list" || v === "board") setView(v); } catch (_) {}

  // ---------- Data ----------
  async function reload() {
    const [t, n] = await Promise.all([
      sb.from("tasks").select("*").order("num"),
      sb.from("task_notes").select("*").order("created_at")
    ]);
    if (t.error || n.error) {
      const err = t.error || n.error;
      notice(/relation|does not exist|schema cache/i.test(err.message) ? "The task tables are not set up yet. Run supabase/tasks.sql once in the Supabase SQL Editor." : "Could not load tasks: " + err.message);
      return;
    }
    notice("");
    state.tasks = t.data || [];
    state.notes = {};
    for (const x of n.data || []) (state.notes[x.task_id] = state.notes[x.task_id] || []).push(x);
    render();
  }
  let reloadTimer;
  const reloadSoon = () => { clearTimeout(reloadTimer); reloadTimer = setTimeout(reload, 400); };

  // ---------- Login ----------
  function gate(mode, msg) {
    $("gate").hidden = false; $("gate-login").hidden = mode !== "login"; $("gate-pending").hidden = mode !== "pending";
    $("gate-msg").hidden = !msg; $("gate-msg").textContent = msg || "";
  }
  let user = null;
  async function enter(u) {
    user = u;
    const p = await sb.from("profiles").select("role,email").eq("id", u.id).maybeSingle();
    if (p.error) return gate("login", "Could not check your account: " + p.error.message);
    const role = p.data && p.data.role;
    if (role !== "admin" && role !== "viewer") return gate("pending");
    state.me = u.id; state.role = role;
    const m = await sb.rpc("team_members");
    state.members = m.error ? [{ id: u.id, email: u.email }] : (m.data || []);
    fillMemberSelects();
    $("me").replaceChildren(h("span", { class: "ini", style: "width:26px;height:26px;border-radius:50%;display:grid;place-items:center;background:var(--accent-soft);color:var(--accent);font-size:11px;font-weight:700", text: initials(displayName(u.email)) }), h("span", { text: u.email }));
    $("gate").hidden = true;
    await reload();
    if (m.error) notice("The task tables are not set up yet. Run supabase/tasks.sql once in the Supabase SQL Editor.");
    if (!channel) {
      channel = sb.channel("tasks-board")
        .on("postgres_changes", { event: "*", schema: "public", table: "tasks" }, reloadSoon)
        .on("postgres_changes", { event: "*", schema: "public", table: "task_notes" }, reloadSoon)
        .subscribe();
    }
  }
  async function logout() { try { await sb.auth.signOut(); } catch (_) {} location.reload(); }
  function start() {
    if (!window.supabase || !window.supabase.createClient || !window.APP_CONFIG) return gate("login", "The login service did not load. Check your internet connection and reload the page.");
    sb = window.supabase.createClient(APP_CONFIG.SUPABASE_URL, APP_CONFIG.SUPABASE_ANON_KEY);
    gate("login");
    sb.auth.getSession().then(r => { const s = r.data && r.data.session; if (s && s.user && !user) enter(s.user); });
    $("gate-login").addEventListener("submit", async (e) => {
      e.preventDefault(); $("g-btn").disabled = true;
      const r = await sb.auth.signInWithPassword({ email: $("g-email").value.trim(), password: $("g-pass").value });
      $("g-btn").disabled = false;
      if (r.error) gate("login", r.error.message === "Invalid login credentials" ? "Wrong email or password." : r.error.message); else enter(r.data.user);
    });
    $("g-again").onclick = () => user && enter(user);
    $("g-out").onclick = logout;
    $("logoutBtn").onclick = logout;
    document.addEventListener("visibilitychange", () => { if (!document.hidden && state.me) { reload(); } });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
