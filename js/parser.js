// Excel → machine records. Shared by the import screen.
// Each sheet = one customer; headers are matched by name (two-row headers supported).
var FIELDS = ["customer","kind","model","line","serial","mfg","version","lastCal","nextCal","ip","os","pcModel","memory","vga","location","checkBy","notes"];
var LABELS = {customer:"Customer",kind:"Kind",model:"Model",line:"Line",serial:"Serial Number",mfg:"Manufactured Year",version:"Current Version",lastCal:"Last Calibration",nextCal:"Next Calibration",ip:"IP Address",os:"OS",pcModel:"PC Model",memory:"Memory",vga:"VGA",location:"Location",checkBy:"Check By",notes:"Notes"};

function normHeader(h){ return String(h==null?"":h).toLowerCase().replace(/[^a-z0-9]/g,""); }
function headerField(h){
  var n = normHeader(h);
  if(!n) return null;
  if(n==="no"||n==="nr"||n==="number"||n==="pcspecifications"||n==="agents"||n==="agent") return null;
  if(n.indexOf("serial")===0||n==="sn"||n==="serialno") return "serial";
  if(n==="kind"||n.indexOf("machine")===0) return "kind";
  if(n==="type"||n==="model"||n==="machinemodel") return "model";
  if(n==="line") return "line";
  if(n.indexOf("manufactur")>=0||n.indexOf("yearmanufact")>=0||n==="mfg"||n==="mfgyear") return "mfg";
  if(n.indexOf("version")>=0) return "version";
  if(n.indexOf("lastcal")===0) return "lastCal";
  if(n.indexOf("nextcal")===0) return "nextCal";
  if(n==="ip"||n.indexOf("ipaddress")===0) return "ip";
  if(n==="os"||n==="operatingsystem") return "os";
  if(n==="pcmodel"||n==="pc") return "pcModel";
  if(n==="memory"||n==="ram") return "memory";
  if(n==="vga"||n==="gpu"||n==="graphics") return "vga";
  if(n==="customer") return "customer";
  if(n==="location"||n==="site") return "location";
  if(n==="checkby"||n==="checkedby") return "checkBy";
  if(n==="notes"||n==="note"||n==="remarks"||n==="remark"||n==="needs") return "notes";
  return null;
}
function pad(n){ return (n<10?"0":"")+n; }
function toDate(v){
  // returns {date:"YYYY-MM-DD"} or {text:"..."} or null
  if(v==null) return null;
  if(v instanceof Date && !isNaN(v)){ var d=new Date(v.getTime()+12*3600e3); return {date:d.getFullYear()+"-"+pad(d.getMonth()+1)+"-"+pad(d.getDate())}; }
  if(typeof v==="number" && v>20000 && v<80000){ var ms=Math.round((v-25569)*86400e3); var u=new Date(ms+12*3600e3); return {date:u.getUTCFullYear()+"-"+pad(u.getUTCMonth()+1)+"-"+pad(u.getUTCDate())}; }
  var s=String(v).trim(); if(!s||s==="-") return null;
  var m=s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/); if(m) return {date:m[1]+"-"+pad(+m[2])+"-"+pad(+m[3])};
  m=s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/); if(m) return {date:m[3]+"-"+pad(+m[2])+"-"+pad(+m[1])};
  return {text:s};
}
function toMonth(v){
  if(v==null) return "";
  var d=toDate(v); if(d&&d.date) return d.date.slice(0,7);
  var s=String(v).trim(); if(!s||s==="-") return "";
  var m=s.match(/(\d{4})\s*[-.\/ ]\s*\.?\s*(\d{1,2})/); if(m&&+m[2]>=1&&+m[2]<=12) return m[1]+"-"+pad(+m[2]);
  m=s.match(/^(\d{4})$/); if(m) return m[1];
  return s;
}
function clean(v){
  if(v==null) return "";
  if(typeof v==="number") return String(Math.round(v*1000)/1000);
  if(v instanceof Date) return toDate(v).date;
  var s=String(v).replace(/\s+/g," ").trim();
  return s==="-"?"":s;
}
function machineKey(m){
  var s=(m.serial||"").toUpperCase().replace(/\s+/g,"");
  var c=(m.customer||"").toUpperCase().trim();
  if(s) return c+"|SN|"+s;
  return c+"|"+(m.kind||"").toUpperCase()+"|"+(m.line||"").toUpperCase()+"|"+(m.ip||"");
}
function keyId(key){
  var h1=0x811c9dc5, h2=0x12345678;
  for(var i=0;i<key.length;i++){ var c=key.charCodeAt(i); h1=Math.imul(h1^c,16777619)>>>0; h2=Math.imul(h2^c,2246822519)>>>0; }
  return "m-"+h1.toString(16).padStart(8,"0")+h2.toString(16).padStart(8,"0");
}
// rows: array of arrays (one sheet). Returns {machines:[], warnings:[]}
function parseSheet(sheetName, rows){
  var out=[], warnings=[], map=null, inBlock=false;
  for(var r=0;r<rows.length;r++){
    var row=rows[r]||[];
    var cand=row.map(headerField);
    var hasSerial=cand.indexOf("serial")>=0, nMapped=cand.filter(Boolean).length;
    if(hasSerial && nMapped>=3){
      map=cand.slice();
      var nxt=rows[r+1]||[], subMapped=0;
      for(var c=0;c<nxt.length;c++){ var f=headerField(nxt[c]); if(f && ["os","pcModel","memory","vga"].indexOf(f)>=0){ map[c]=f; subMapped++; } }
      if(subMapped) r++;
      inBlock=true; continue;
    }
    if(!map||!inBlock) continue;
    var blank=row.every(function(v){return clean(v)==="";});
    if(blank){ inBlock=false; continue; }
    var first=row[0];
    if(typeof first==="string" && first.trim() && isNaN(+first.trim()) && first.trim()!=="-"){ inBlock=false; continue; }
    var m={}; FIELDS.forEach(function(f){m[f]="";});
    var notes=[];
    for(var c2=0;c2<map.length;c2++){
      var f2=map[c2]; if(!f2) continue; var v=row[c2];
      if(f2==="lastCal"||f2==="nextCal"){ var d=toDate(v); if(d&&d.date) m[f2]=d.date; else if(d&&d.text) notes.push(LABELS[f2]+": "+d.text); }
      else if(f2==="mfg") m.mfg=toMonth(v);
      else { var cv=clean(v); if(cv) m[f2]= m[f2] ? m[f2]+" "+cv : cv; }
    }
    if(notes.length) m.notes = m.notes ? m.notes+" · "+notes.join(" · ") : notes.join(" · ");
    if(!m.customer) m.customer=sheetName.trim();
    if(!m.kind && m.model){ m.kind = /zenith|aoi|meister/i.test(m.model) ? "AOI" : /ky\s*\d|spi|aspire/i.test(m.model) ? "SPI" : m.model; }
    if(!m.kind && !m.serial && !m.model){ continue; }
    out.push(m);
  }
  if(!map) warnings.push("No header row with a Serial Number column was found.");
  return {machines:out, warnings:warnings};
}
// Assign stable keys, disambiguating duplicates inside one import
function keyMachines(list){
  var seen={};
  list.forEach(function(m){
    var k=machineKey(m);
    if(seen[k]){ seen[k]++; k=k+"#"+seen[k]; } else seen[k]=1;
    m.key=k;
  });
  return list;
}
