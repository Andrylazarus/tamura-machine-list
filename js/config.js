// ===================================================================
// Fill these in from Supabase: Project Settings → API
// The "anon public" / "publishable" key is meant to be public — the database security
// rules (supabase/schema.sql) are what protect the data.
// NEVER put the "service_role" key here.
// ===================================================================
window.APP_CONFIG = {
  SUPABASE_URL: "https://zsnefzgwnuigtomouidi.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_DI3G12_SrDMDz0qfe3VzsQ_uhhh9aUi",
  APP_NAME: "Tamura Machine List"
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
