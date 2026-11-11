// Excel → stock items. Each sheet is read as one brand (or group); the header row is found by name.
// Recognised headers: Description / Item / Name, Part No, Qty, Remarks / Notes, and optionally
// Brand, Model / Machine, Unit, Min, Location, Condition, Type.
function stockHeader(h) {
  var n = String(h == null ? "" : h).toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!n) return null;
  if (n === "description" || n === "desc" || n === "item" || n === "itemname" || n === "name" || n === "partname" || n === "sparepart" || n === "namabarang" || n === "deskripsi") return "name";
  if (n.indexOf("partno") === 0 || n.indexOf("partnumber") === 0 || n === "pn" || n === "code" || n === "kode" || n.indexOf("serial") === 0 || n === "sn") return "partNo";
  if (n === "qty" || n === "quantity" || n === "stock" || n === "stok" || n === "jumlah" || n === "instock") return "qty";
  if (n === "unit" || n === "uom" || n === "satuan") return "unit";
  if (n === "min" || n === "minimum" || n === "minqty" || n === "minstock") return "minQty";
  if (n === "remarks" || n === "remark" || n === "notes" || n === "note" || n === "keterangan") return "notes";
  if (n === "brand" || n === "maker" || n === "merk" || n === "merek") return "brand";
  if (n === "model" || n === "machine" || n === "machinemodel" || n === "formachine" || n === "mesin") return "model";
  if (n === "location" || n === "lokasi" || n === "rack" || n === "rak") return "location";
  if (n === "condition" || n === "kondisi") return "condition";
  if (n === "type" || n === "kind" || n === "jenis") return "kind";
  return null;
}
function stockText(v) {
  if (v == null) return "";
  if (typeof v === "number") return String(Math.round(v * 1000) / 1000);
  var s = String(v).replace(/\s+/g, " ").trim();
  return s === "-" ? "" : s;
}
var STOCK_UNITS = { satuan: "pcs", pcs: "pcs", pc: "pcs", piece: "pcs", buah: "pcs", unit: "unit", set: "set", box: "box", plastik: "pack", pack: "pack", roll: "roll", lembar: "sheet", sheet: "sheet" };
// "KOHYOUNG" → "Koh Young", otherwise the sheet name as written; "General" has no brand
function stockBrandFromSheet(name, known) {
  var raw = String(name || "").trim(), key = raw.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!key || key === "general" || key === "umum" || key === "others" || key === "other" || /^sheet\d*$/.test(key)) return "";
  if (key === "kohyoung" || key === "ky") return "Koh Young";
  for (var i = 0; i < (known || []).length; i++) if (known[i].toLowerCase().replace(/[^a-z0-9]/g, "") === key) return known[i];
  return raw;
}
// rows: array of arrays (one sheet). Returns { items: [...], title: "", warnings: [] }
function parseStockSheet(sheetName, rows) {
  var items = [], warnings = [], map = null, title = "";
  for (var r = 0; r < rows.length; r++) {
    var row = rows[r] || [];
    if (!map) {
      var cand = row.map(stockHeader);
      if (cand.indexOf("name") >= 0 && cand.filter(Boolean).length >= 2) { map = cand; continue; }
      var texts = row.map(stockText).filter(Boolean);
      if (texts.length === 1 && !title) title = texts[0];   // a heading above the table, e.g. "SPARE PARTS MPI LASER MARKING"
      continue;
    }
    var it = { kind: "part", name: "", brand: "", model: "", partNo: "", qty: 0, unit: "pcs", minQty: 0, location: "", condition: "", notes: "" };
    for (var c = 0; c < map.length; c++) {
      var f = map[c]; if (!f) continue;
      var v = row[c];
      if (f === "qty" || f === "minQty") { var num = typeof v === "number" ? v : parseFloat(String(v == null ? "" : v).replace(",", ".")); it[f] = isFinite(num) && num > 0 ? Math.round(num) : 0; }
      else if (f === "kind") it.kind = /machine|mesin|unit/i.test(stockText(v)) ? "machine" : "part";
      else it[f] = stockText(v);
    }
    if (!it.name) continue;
    // "per plastik", "per set" in the remarks is the unit, not a note
    var m = it.notes.match(/^per\s+([a-z]+)$/i);
    if (m) { it.unit = STOCK_UNITS[m[1].toLowerCase()] || m[1].toLowerCase(); it.notes = ""; }
    else if (it.unit) it.unit = STOCK_UNITS[it.unit.toLowerCase()] || it.unit;
    if (!it.unit) it.unit = "pcs";
    items.push(it);
  }
  if (!map) warnings.push("No header row with a Description column was found.");
  return { items: items, title: title, warnings: warnings };
}
// Machine name guessed from the heading: "SPARE PARTS MPI LASER MARKING" with brand "MPI" → "Laser Marking"
function stockModelFromTitle(title, brand, sheetName) {
  var t = String(title || "").replace(/spare\s*parts?/ig, " ");
  [brand, sheetName, String(brand || "").replace(/\s+/g, "")].forEach(function (w) { if (w) t = t.replace(new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "ig"), " "); });
  t = t.replace(/\s+/g, " ").trim();
  return t.toLowerCase().replace(/\b[a-z]/g, function (ch) { return ch.toUpperCase(); });
}
function stockKey(it) { return [it.brand, it.name, it.partNo].map(function (s) { return String(s || "").toLowerCase().replace(/\s+/g, " ").trim(); }).join("|"); }
if (typeof module !== "undefined") module.exports = { parseStockSheet: parseStockSheet, stockBrandFromSheet: stockBrandFromSheet, stockModelFromTitle: stockModelFromTitle, stockKey: stockKey };
