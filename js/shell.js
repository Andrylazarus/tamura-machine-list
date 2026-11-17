/* Tamura service portal: the top bar shared by every page.
   <script src="../js/shell.js" data-page="tasks" defer></script> after supabase-js and js/config.js.
   It shows once someone is logged in, highlights the current page, shows the private pages only to accounts
   that may open them, and logs out. Pages keep their own login screens and data code. */
(function () {
  "use strict";
  var me = document.currentScript, page = me.getAttribute("data-page") || "", base = me.getAttribute("data-base") || "../";
  // Pages that already have their own top bar (Machines, Stock, Daily report, Attendance) only get the phone tab bar
  var ownBar = !!document.querySelector("header.appbar");
  var cfg = window.APP_CONFIG || {};
  var ICON = {
    machines: '<path d="M4 6h16v10H4z"/><path d="M8 20h8M12 16v4"/>',
    stock: '<path d="M3 7l9-4 9 4-9 4-9-4z"/><path d="M3 7v10l9 4 9-4V7"/><path d="M12 11v10"/>',
    daily: '<path d="M7 3h10a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M9 8h6M9 12h6M9 16h4"/>',
    attendance: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    calibration: '<path d="M9 3h6l1 4H8z"/><path d="M6 7h12v14H6z"/><path d="M9 12l2 2 4-4"/>',
    transport: '<path d="M3 13l2-6h14l2 6v5H3z"/><circle cx="7.5" cy="17.5" r="1.5"/><circle cx="16.5" cy="17.5" r="1.5"/>',
    tasks: '<path d="M4 5h4v14H4zM10 5h4v9h-4zM16 5h4v6h-4z"/>',
    schedule: '<path d="M4 6h16v15H4z"/><path d="M4 10h16M8 3v4M16 3v4"/>',
    more: '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>'
  };
  function icon(k) { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICON[k] + '</svg>'; }
  // [path from the site root, label, page id, beta, private]
  var LINKS = [
    ["", "Machines", "machines"],
    ["stock/", "Stock", "stock"],
    ["daily/", "Daily report", "daily"],
    ["attendance/", "Attendance", "attendance", true, true],
    ["calibration/", "Calibration report", "calibration", false, true],
    ["transport/", "Transport claim", "transport", false, true],
    ["tasks/", "Team tasks", "tasks", true, false],
    ["schedule/", "Schedule", "schedule", false, true]
  ];
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }

  var bar = document.createElement("header");
  bar.className = "appbar"; bar.hidden = true;
  bar.innerHTML =
    '<div class="appbar-in">' +
      '<a class="logo" href="' + esc(base) + '" aria-label="Tamura service portal"><span class="mark" aria-hidden="true">T</span><span class="logo-t"><b>Tamura</b><i>Service portal</i></span></a>' +
      '<nav class="mainnav" aria-label="Sections">' +
        LINKS.map(function (l) {
          return '<a href="' + esc(base + l[0]) + '"' + (l[2] === page ? ' aria-current="page"' : '') + (l[4] ? ' data-private hidden' : '') + '>' + esc(l[1]) +
                 (l[3] ? '<span class="beta" title="Still being tested and may change">Beta</span>' : '') + '</a>';
        }).join("") +
      '</nav>' +
      '<div class="account"><span class="who"><span class="avatar" aria-hidden="true"></span><span class="em"></span></span>' +
        '<button class="navbtn" type="button" data-shell-logout>Log out</button></div>' +
    '</div>';
  if (!ownBar) document.body.insertBefore(bar, document.body.firstChild);
  document.body.classList.add("shelled");

  // Phone: a tab bar at the bottom (Machines, Daily report, Team tasks, More) and a sheet with every page
  var TABS = ["machines", "daily", "tasks"];
  var byId = {}; LINKS.forEach(function (l) { byId[l[2]] = l; });
  var tabbar = document.createElement("nav");
  tabbar.className = "tabbar"; tabbar.hidden = true; tabbar.setAttribute("aria-label", "Sections");
  var short = { machines: "Machines", daily: "Daily", tasks: "Tasks" };
  tabbar.innerHTML = TABS.map(function (id) {
    var l = byId[id];
    return '<a href="' + esc(base + l[0]) + '"' + (id === page ? ' aria-current="page"' : '') + '>' + icon(id) + '<span>' + short[id] + '</span></a>';
  }).join("") + '<button type="button" class="tb-more"' + (TABS.indexOf(page) < 0 ? ' aria-current="page"' : '') + '>' + icon("more") + '<span>More</span></button>';
  var sheet = document.createElement("div");
  sheet.className = "tb-sheet"; sheet.hidden = true;
  sheet.innerHTML = '<div class="tb-scrim"></div><div class="tb-panel" role="dialog" aria-label="All pages"><div class="tb-grab"></div><p class="tb-title">All pages</p><div class="tb-grid">' +
    LINKS.map(function (l) {
      return '<a href="' + esc(base + l[0]) + '"' + (l[2] === page ? ' aria-current="page"' : '') + (l[4] ? ' data-private hidden' : '') + '>' + icon(l[2]) + '<span>' + esc(l[1]) + (l[3] ? ' <em>Beta</em>' : '') + '</span></a>';
    }).join("") + '</div><button type="button" class="tb-out" data-shell-logout>Log out</button></div>';
  document.body.appendChild(tabbar); document.body.appendChild(sheet);
  function openSheet(on) { sheet.hidden = !on; document.documentElement.classList.toggle("tb-lock", on); }
  tabbar.querySelector(".tb-more").addEventListener("click", function () { openSheet(true); });
  sheet.querySelector(".tb-scrim").addEventListener("click", function () { openSheet(false); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") openSheet(false); });

  if (!window.supabase || !window.supabase.createClient || !cfg.SUPABASE_URL) return;
  var sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);

  function setShown(on) { bar.hidden = !on; tabbar.hidden = !on; document.body.classList.toggle("has-tabbar", on); if (!on) openSheet(false); }
  function showFor(user) {
    if (!user) { setShown(false); return; }
    var email = user.email || "";
    bar.querySelector(".em").textContent = email;
    bar.querySelector(".avatar").textContent = email.charAt(0) || "?";
    setShown(true);
    sb.from("profiles").select("role").eq("id", user.id).maybeSingle().then(function (res) {
      var role = res.data && res.data.role;
      if (role !== "admin" && role !== "viewer") { setShown(false); return; }      // pending: the page shows its own screen
      var open = function (ok) { document.querySelectorAll(".appbar [data-private], .tb-sheet [data-private]").forEach(function (a) { a.hidden = !ok; }); };
      if (role === "admin") open(true);
      else if (window.APP_IS_OWNER) window.APP_IS_OWNER(email).then(open, function () { open(false); });
      else open(false);
    });
  }
  sb.auth.getSession().then(function (r) { showFor(r.data && r.data.session && r.data.session.user); });
  sb.auth.onAuthStateChange(function (ev, s) {
    if (ev === "SIGNED_OUT") setShown(false);
    else if (ev === "SIGNED_IN" && s && s.user) showFor(s.user);
  });
  document.querySelectorAll("[data-shell-logout]").forEach(function (b) {
    b.addEventListener("click", function () { sb.auth.signOut().then(function () { location.href = base; }, function () { location.href = base; }); });
  });
})();
