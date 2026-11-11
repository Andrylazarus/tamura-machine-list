// ===================================================================
// Fill these in from Supabase: Project Settings → API
// The "anon public" / "publishable" key is meant to be public — the database security
// rules (supabase/schema.sql) are what protect the data.
// NEVER put the "service_role" key here.
// ===================================================================
window.APP_CONFIG = {
  SUPABASE_URL: "https://zsnefzgwnuigtomouidi.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_DI3G12_SrDMDz0qfe3VzsQ_uhhh9aUi",
  APP_NAME: "Tamura Machine List",
  // Log out automatically after this many minutes without any click, tap, scroll or typing.
  // Set to 0 to switch automatic log out off.
  AUTO_LOGOUT_MINUTES: 60
};

// The calibration report, transport claim, team tasks and schedule pages open for one account only.
// OWNER_ID is the SHA-256 of that account's email (lowercase), so the address itself is not published here.
window.APP_CONFIG.OWNER_ID = "f40b7cb7749f58d5e767e5e32d98866c3fed1400f1792045447e9fdf16d09379";
window.APP_IS_OWNER = async function (email) {
  try {
    var bytes = new TextEncoder().encode(String(email || "").trim().toLowerCase());
    var buf = await crypto.subtle.digest("SHA-256", bytes);
    var hex = Array.from(new Uint8Array(buf)).map(function (b) { return b.toString(16).padStart(2, "0"); }).join("");
    return hex === window.APP_CONFIG.OWNER_ID;
  } catch (e) { return false; }
};

// ---------- Automatic log out (shared by every page of the site) ----------
(function () {
  var minutes = Number(window.APP_CONFIG.AUTO_LOGOUT_MINUTES) || 0;
  if (!minutes) return;
  var LIMIT = minutes * 60000, SEEN = "tml.lastActive", NOTE = "tml.autoLogout";
  var tokenKey;
  try { tokenKey = "sb-" + new URL(window.APP_CONFIG.SUPABASE_URL).hostname.split(".")[0] + "-auth-token"; } catch (e) { return; }
  function get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function loggedIn() { return !!get(tokenKey); }
  function idleFor() { var t = Number(get(SEEN)); return t ? Date.now() - t : 0; }
  function logOut(reload) {
    try { localStorage.removeItem(tokenKey); } catch (e) {}
    set(NOTE, "1");
    if (reload) location.reload();
  }
  // Coming back after a long break (tab or browser was closed): log out before the page starts
  if (loggedIn() && idleFor() > LIMIT) logOut(false);
  if (!get(SEEN) || !loggedIn()) set(SEEN, String(Date.now()));

  var last = 0;
  function active() {
    var now = Date.now();
    if (now - last < 10000) return;
    if (loggedIn() && idleFor() > LIMIT) { logOut(true); return; }   // e.g. laptop woke from sleep
    last = now; set(SEEN, String(now));
  }
  ["pointerdown", "keydown", "wheel", "touchstart", "scroll"].forEach(function (ev) { window.addEventListener(ev, active, { passive: true, capture: true }); });
  document.addEventListener("visibilitychange", function () { if (!document.hidden && loggedIn() && idleFor() > LIMIT) logOut(true); });
  setInterval(function () { if (loggedIn() && idleFor() > LIMIT) logOut(true); }, 20000);

  // Tell the person why they are looking at the login form
  window.addEventListener("DOMContentLoaded", function () {
    if (!get(NOTE)) return;
    try { localStorage.removeItem(NOTE); } catch (e) {}
    var el = document.getElementById("loginMsg") || document.getElementById("gate-msg");
    if (el) setTimeout(function () {
      if (loggedIn()) return;
      el.textContent = "You were logged out after " + (minutes % 60 ? minutes + " minutes" : minutes === 60 ? "1 hour" : minutes / 60 + " hours") + " without activity. Log in again to continue.";
      el.hidden = false; if (el.id === "loginMsg") el.className = "msg ok";
    }, 600);
  });
})();
