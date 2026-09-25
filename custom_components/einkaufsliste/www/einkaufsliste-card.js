/*
 * Einkaufsliste Card – die Familien-Einkaufsliste für Home Assistant
 * Wird automatisch von der Integration "einkaufsliste" geladen.
 */
const EL_VERSION = "2.1.0";

// Doppelt-Finder: Wörter, die dasselbe meinen (alles klein, ohne Leer-/Sonderzeichen)
const DUP_SYNONYMS = (() => {
  const groups = [
    ["klopapier", "toilettenpapier", "wcpapier", "klopapie"],
    ["küchenrolle", "küchenpapier", "küchentücher"],
    ["taschentücher", "taschentuch", "tempos", "tempo"],
    ["brötchen", "semmel", "semmeln", "schrippen", "schrippe"],
    ["sahne", "schlagsahne"],
    ["hackfleisch", "hack", "gehacktes"],
    ["spülmittel", "spüli"],
    ["kartoffel", "kartoffeln", "erdäpfel"],
    ["joghurt", "jogurt", "yoghurt"],
    ["spülmaschinentabs", "spülitabs", "tabs", "geschirrspültabs"],
    ["mineralwasser", "sprudel", "wasser"],
  ];
  const map = {};
  for (const g of groups) for (const w of g) map[w] = g[0];
  return map;
})();
const EL_BASE = "/einkaufsliste_files";

const WD_SHORT = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"]; // Python: Montag = 0
const WD_LONG = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"];
const pyWd = (d) => (d.getDay() + 6) % 7;
const DAY = 86400000;

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const dayDiff = (a, b) => Math.round((startOfDay(a) - startOfDay(b)) / DAY);
const fmtDay = (d) => `${WD_SHORT[pyWd(d)]} ${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}.`;
const stripMdi = (icon) => String(icon || "").replace(/^mdi:/, "");
function fmtSince(iso) {
  const d = new Date(iso);
  const diff = dayDiff(new Date(), d);
  if (diff <= 0) {
    const min = Math.floor((Date.now() - d.getTime()) / 60000);
    if (min < 1) return "gerade eben";
    if (min < 60) return `vor ${min} Min`;
    return `vor ${Math.floor(min / 60)} Std`;
  }
  if (diff === 1) return "gestern";
  if (diff < 7) return `seit ${WD_SHORT[pyWd(d)]}`;
  return `seit ${fmtDay(d)}`;
}

// Deutsche Suchbegriffe -> englische Icon-Namen (für die Icon-Suche)
const ICON_DE = {
  apfel: "apple", obst: "fruit", frucht: "fruit", gemüse: "carrot", gemuese: "carrot", karotte: "carrot", möhre: "carrot",
  brot: "bread", brötchen: "baguette", backwaren: "baguette", kuchen: "cake", torte: "cake", käse: "cheese", kaese: "cheese",
  milch: "cup", fleisch: "food-steak", wurst: "sausage", fisch: "fish", huhn: "food-drumstick", hähnchen: "food-drumstick",
  ei: "egg", eier: "egg", nudel: "pasta", nudeln: "pasta", reis: "rice", pizza: "pizza", burger: "hamburger", suppe: "bowl",
  tiefkühl: "snowflake", tk: "snowflake", eis: "ice-cream", süß: "candy", suess: "candy", süßigkeiten: "candy", schokolade: "candy",
  keks: "cookie", snack: "food", essen: "food", getränk: "bottle-soda", getraenk: "bottle-soda", wasser: "water", saft: "cup",
  bier: "beer", wein: "glass-wine", kaffee: "coffee", tee: "tea", konserve: "package-variant", vorrat: "package-variant",
  gewürz: "shaker", gewuerz: "shaker", salz: "shaker", öl: "bottle-tonic", drogerie: "lotion", creme: "lotion", seife: "hand-wash",
  zahn: "toothbrush", zahnpasta: "toothbrush", shampoo: "bottle-tonic", haushalt: "spray-bottle", putzen: "broom", reinigung: "spray-bottle",
  waschen: "washing-machine", wäsche: "tshirt-crew", papier: "paper-roll", klopapier: "paper-roll", müll: "trash-can", muell: "trash-can",
  baby: "baby-bottle", windel: "baby-face", hund: "dog", katze: "cat", tier: "paw", vogel: "bird", pferd: "horse",
  medizin: "pill", apotheke: "medical-bag", tablette: "pill", pflaster: "bandage", blume: "flower", pflanze: "sprout", garten: "shovel",
  werkzeug: "tools", baumarkt: "hammer-wrench", batterie: "battery", lampe: "lightbulb", strom: "flash", kabel: "cable-data",
  auto: "car", tanken: "gas-station", geschenk: "gift", party: "party-popper", kerze: "candle", buch: "book", schule: "school",
  stift: "pencil", kleidung: "tshirt-crew", schuh: "shoe-sneaker", einkauf: "cart", wagen: "cart", tasche: "shopping", laden: "store",
  geschäft: "store", markt: "store", rezept: "chef-hat", kochen: "pot-steam", besteck: "silverware-fork-knife", grill: "grill",
  sonstiges: "dots-horizontal", herz: "heart", stern: "star",
};

// Foto auf dem Handy verkleinern (spart Platz in Home Assistant)
async function loadImage(file) {
  const url = URL.createObjectURL(file);
  try {
    return await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = url;
    });
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

function drawScaled(img, max) {
  const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
  canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas;
}

async function shrinkImage(file, max = 900, quality = 0.8) {
  return drawScaled(await loadImage(file), max).toDataURL("image/jpeg", quality);
}

// Kategorie aus dem eingebauten Wörterbuch raten (gleiche Regeln wie in Home Assistant)
function guessCategory(name, hints) {
  const text = String(name || "").toLowerCase().trim();
  if (!text || !hints?.length) return null;
  const best = (t, minLen, whole) => {
    let len = 0, id = null;
    for (const h of hints) for (const w of h.words) {
      if (w.length < minLen || w.length <= len) continue;
      if ((whole && w.length <= 3) ? t === w : t.includes(w)) { len = w.length; id = h.id; }
    }
    return id;
  };
  const long = best(text.replace(/-/g, ""), 8, false);
  if (long) return long;
  for (const token of text.replace(/-/g, " ").split(/\s+/)) {
    const hit = best(token, 1, true);
    if (hit) return hit;
  }
  return null;
}

// Luftlinie in Metern
function distance(lat1, lon1, lat2, lon2) {
  const r = (d) => (d * Math.PI) / 180;
  const a = Math.sin(r(lat2 - lat1) / 2) ** 2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(r(lon2 - lon1) / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Großes Foto über allem anzeigen
function showPhotoOverlay(src, title) {
  const overlay = document.createElement("div");
  Object.assign(overlay.style, {
    position: "fixed", inset: "0", background: "rgba(0,0,0,.88)", zIndex: "10000",
    display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
    padding: "16px", cursor: "zoom-out", boxSizing: "border-box",
  });
  const img = document.createElement("img");
  img.src = src;
  img.alt = title;
  Object.assign(img.style, { maxWidth: "100%", maxHeight: "80vh", borderRadius: "14px", boxShadow: "0 10px 40px rgba(0,0,0,.6)" });
  const cap = document.createElement("div");
  cap.textContent = title;
  Object.assign(cap.style, { color: "#fff", font: "500 17px Roboto, sans-serif", marginTop: "14px", textAlign: "center" });
  const hint = document.createElement("div");
  hint.textContent = "Tippen zum Schließen";
  Object.assign(hint.style, { color: "#aaa", font: "13px Roboto, sans-serif", marginTop: "4px" });
  overlay.append(img, cap, hint);
  const close = () => { overlay.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  overlay.addEventListener("click", close);
  document.addEventListener("keydown", onKey);
  document.body.appendChild(overlay);
}

const STYLE = `
:host { display:block; }
ha-card { display:block; padding:12px 12px 8px; overflow:hidden; }
* { box-sizing:border-box; }
button { font:inherit; color:inherit; }
.head { display:flex; align-items:center; gap:4px; margin:0 2px 8px; min-height:36px; }
.title { display:flex; align-items:center; gap:8px; font-size:1.25em; font-weight:600; flex:1; min-width:0; }
.title span.t { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.badge { background:var(--primary-color,#03a9f4); color:var(--text-primary-color,#fff); border-radius:999px; padding:1px 9px; font-size:.75em; font-weight:600; }
.iconbtn { background:none; border:0; cursor:pointer; padding:6px; border-radius:50%; display:inline-flex; color:var(--secondary-text-color); line-height:0; }
.iconbtn:hover { background:var(--secondary-background-color, rgba(127,127,127,.12)); color:var(--primary-text-color); }
.iconbtn[disabled] { opacity:.3; pointer-events:none; }
.iconbtn.on { color:var(--primary-color,#03a9f4); }
.tabs { display:flex; gap:6px; overflow-x:auto; padding:2px 2px 8px; scrollbar-width:thin; cursor:grab; user-select:none; -webkit-overflow-scrolling:touch; }
.tabs.dragging { cursor:grabbing; }
.tabs.dragging .tab { pointer-events:none; }
.tabs::-webkit-scrollbar { height:4px; }
.tabs::-webkit-scrollbar-thumb { background:var(--divider-color, rgba(127,127,127,.35)); border-radius:4px; }
@media (hover:none) { .tabs { scrollbar-width:none; } .tabs::-webkit-scrollbar { display:none; } }
.tab { --c: var(--primary-color,#03a9f4); flex:0 0 auto; border:1.5px solid color-mix(in srgb, var(--c) 55%, transparent); background:transparent; border-radius:999px; padding:5px 12px; cursor:pointer; display:inline-flex; align-items:center; gap:6px; font-size:.9em; }
.tab .dot { width:9px; height:9px; border-radius:50%; background:var(--c); }
.tab .n { opacity:.7; font-size:.85em; }
.tab.active { background:var(--c); border-color:var(--c); color:#fff; }
.tab.active .dot { background:#fff; }
form.add { display:grid; grid-template-columns: 1fr 48px; gap:6px; margin:2px 2px 6px; }
form.add .toolbar { grid-column: 1 / -1; display:flex; gap:4px; margin:-2px 0 0; }
.tool { background:none; border:0; border-radius:10px; padding:6px 10px; cursor:pointer; color:var(--secondary-text-color); display:inline-flex; align-items:center; line-height:0; position:relative; --mdc-icon-size:22px; }
.tool:hover { background:var(--secondary-background-color, rgba(127,127,127,.1)); }
.tool.on { color:var(--primary-color,#03a9f4); background:color-mix(in srgb, var(--primary-color,#03a9f4) 12%, transparent); }
.tool.filled::after { content:""; position:absolute; top:5px; right:6px; width:7px; height:7px; border-radius:50%; background:var(--primary-color,#03a9f4); }
form.add .extras { grid-column: 1 / -1; display:flex; flex-direction:column; gap:6px; }
form.add .extras:not(:has(> :not([hidden]))) { display:none; }
.tool.busy ha-icon { animation: pulse 1s infinite; }
.tool.hasval { color:var(--primary-color,#03a9f4); }
.tool.tclear { margin-left:auto; color:var(--error-color,#db4437); }
.tool.instore { color:var(--success-color,#43a047); background:color-mix(in srgb, var(--success-color,#43a047) 14%, transparent); }
.tool.instore::after { content:"✓"; position:absolute; right:3px; bottom:2px; font-size:10px; font-weight:700; line-height:1; }
.item.unknown .name { color:var(--warning-color,#ff9800); animation: pulse 1.6s infinite; }
.tool .tval { font-size:.8em; font-weight:600; margin-left:3px; line-height:1; max-width:70px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.chipbox { display:flex; flex-direction:column; gap:6px; }
form.add .sugg { grid-column: 1 / -1; display:flex; flex-wrap:wrap; gap:6px; margin-top:-2px; }
.sug { border:1.5px solid color-mix(in srgb, var(--primary-color,#03a9f4) 45%, transparent); background:color-mix(in srgb, var(--primary-color,#03a9f4) 8%, transparent); color:var(--primary-text-color); border-radius:999px; padding:7px 12px; cursor:pointer; font-size:.95em; display:inline-flex; align-items:center; gap:4px; }
.sug b { color:var(--primary-color,#03a9f4); }
.sug .on { font-size:.75em; opacity:.7; }
.chips { display:flex; flex-wrap:wrap; gap:6px; }
.chip2 { border:1.5px solid var(--divider-color, rgba(127,127,127,.35)); background:transparent; border-radius:999px; padding:7px 14px; cursor:pointer; font-size:.95em; min-width:44px; }
.chip2.sel { background:var(--primary-color,#03a9f4); border-color:var(--primary-color,#03a9f4); color:var(--text-primary-color,#fff); }
@keyframes pulse { 50% { opacity:.3; } }

.photobtn { background:none; border:0; cursor:pointer; padding:0 2px; color:var(--primary-color,#03a9f4); line-height:0; --mdc-icon-size:17px; align-self:center; }
.photorow { display:flex; flex-wrap:wrap; gap:6px; }
.photorow .btn { padding:6px 10px; font-size:.85em; }
form.add .row2 { grid-column: 1 / -1; display:grid; grid-template-columns:1fr 1fr; gap:6px; }
form.add.fixed .sel { grid-template-columns:1fr; }
input, select { font:inherit; font-size:.95em; color:var(--primary-text-color); background:var(--input-fill-color, var(--secondary-background-color, rgba(127,127,127,.08))); border:1px solid var(--divider-color, rgba(127,127,127,.3)); border-radius:10px; padding:9px 10px; min-width:0; width:100%; outline:none; }
input:focus, select:focus { border-color:var(--primary-color,#03a9f4); }
.primary { background:var(--primary-color,#03a9f4); color:var(--text-primary-color,#fff); border:0; border-radius:10px; cursor:pointer; display:inline-flex; align-items:center; justify-content:center; gap:6px; }
.primary:active { transform:scale(.96); }
.addbtn { background:var(--success-color, #43a047); color:#fff; }
.shake { animation: shake .35s; }
@keyframes shake { 25%{transform:translateX(-5px)} 75%{transform:translateX(5px)} }
.group { margin-top:8px; }
.ghead { display:flex; align-items:center; gap:6px; font-size:.8em; font-weight:600; text-transform:uppercase; letter-spacing:.04em; color:var(--secondary-text-color); padding:6px 4px 2px; }
.ghead ha-icon { --mdc-icon-size:16px; }
.ghead .n { margin-left:auto; font-weight:500; }
.subhead { font-size:.72em; padding-left:10px; opacity:.85; }
.item { display:flex; align-items:center; gap:4px; padding:4px 2px; border-radius:10px; transition: opacity .25s, background .2s; }
.item .check { color:var(--primary-color,#03a9f4); }
.item .txt { flex:1; min-width:0; padding:2px 0; }
.item .line { display:flex; flex-wrap:wrap; align-items:baseline; gap:0 6px; }
.item .name { font-weight:500; word-break:break-word; }
.item .qty { font-size:.85em; background:var(--secondary-background-color, rgba(127,127,127,.12)); border-radius:6px; padding:0 6px; }
.item .who { font-size:.85em; color:var(--secondary-text-color); }
.item .meta { font-size:.75em; color:var(--secondary-text-color); display:flex; flex-wrap:wrap; gap:2px 8px; margin-top:1px; }
.chip { --c:#888; display:inline-flex; align-items:center; gap:4px; }
.chip::before { content:""; width:7px; height:7px; border-radius:50%; background:var(--c); }
.item { border-left:4px solid var(--cc, transparent); padding-left:0; }
.item .txt { -webkit-user-select:none; user-select:none; -webkit-touch-callout:none; }
.item .qty { border:0; font:inherit; font-size:.85em; cursor:pointer; color:inherit; }
.item.new { background:color-mix(in srgb, var(--primary-color,#03a9f4) 7%, transparent); }
.newbadge { font-size:.9em; }
.bubble { background:var(--error-color,#e53935); color:#fff; border-radius:999px; font-size:.72em; font-weight:700; padding:1px 6px; margin-left:2px; }
.menurow, .qtyrow { display:flex; flex-wrap:wrap; align-items:center; gap:6px; padding:4px 8px 8px 44px; }
.menubtn { display:inline-flex; align-items:center; gap:4px; border:1px solid var(--divider-color, rgba(127,127,127,.35)); background:transparent; border-radius:999px; padding:6px 10px; cursor:pointer; font-size:.85em; --mdc-icon-size:18px; }
.qbtn { width:40px; height:40px; border-radius:50%; border:1.5px solid var(--primary-color,#03a9f4); background:transparent; color:var(--primary-color,#03a9f4); font-size:1.3em; cursor:pointer; }
.qbtn[disabled] { opacity:.3; }
.qval { min-width:44px; text-align:center; font-weight:600; font-size:1.1em; }
ha-card.shop form.add { display:none; }
ha-card.shop .item { padding:9px 4px; font-size:1.12em; }
ha-card.shop .item .check { padding:8px; --mdc-icon-size:34px; }
ha-card.shop .item .meta { font-size:.7em; }
ha-card.shop .tab { padding:8px 14px; font-size:1em; }
.shopbar { display:flex; align-items:center; gap:8px; margin:2px 2px 8px; padding:8px 10px; border-radius:12px; background:color-mix(in srgb, var(--success-color,#43a047) 14%, transparent); font-size:.9em; }
.shopbar b { flex:1; }
.dupbar { margin:4px 2px 8px; padding:8px 10px; border-radius:12px; background:color-mix(in srgb, var(--warning-color,#ff9800) 14%, transparent); font-size:.9em; }
.dupbar .dbtns { display:flex; gap:8px; justify-content:flex-end; margin-top:6px; flex-wrap:wrap; }
.dupbar .primary { padding:7px 12px; }
ha-card.compact .item { padding:1px 2px; }
ha-card.compact .item .meta { display:none; }
ha-card.compact .item .check { padding:3px; }
ha-card.compact .ghead { padding:3px 4px 0; }
ha-card.compact .group { margin-top:4px; }
.item .acts { display:flex; opacity:.55; }
.delrow { padding:4px 0; border-bottom:1px solid var(--divider-color, rgba(127,127,127,.15)); }
.delname { min-width:0; }
.delname b { display:block; font-weight:500; word-break:break-word; }
.delname small { color:var(--secondary-text-color); font-size:.78em; }
.moverow { display:flex; flex-wrap:wrap; align-items:center; gap:6px; padding:6px 8px 8px 44px; }
.moverow .movetxt { font-size:.8em; color:var(--secondary-text-color); width:100%; }
.moverow .tab { padding:4px 10px; font-size:.85em; }
.item:hover .acts { opacity:1; }
.item.done .name { opacity:.6; }
.item.done .check { color:var(--secondary-text-color); }
.item.pending { opacity:.45; }
.donehead { cursor:pointer; user-select:none; }
.donehead ha-icon.chev { transition: transform .2s; }
.donehead.closed ha-icon.chev { transform: rotate(-90deg); }
.donehint { font-size:.75em; color:var(--secondary-text-color); padding:0 4px 4px; }
.textbtn { background:none; border:0; cursor:pointer; color:var(--primary-color,#03a9f4); font-size:.85em; padding:6px 4px; }
.textbtn.danger { color:var(--error-color,#db4437); }
.empty { text-align:center; padding:22px 8px; color:var(--secondary-text-color); }
.empty ha-icon { --mdc-icon-size:42px; opacity:.5; display:block; margin:0 auto 6px; }
.footer { display:flex; align-items:center; gap:6px; font-size:.75em; color:var(--secondary-text-color); margin:10px 4px 2px; border-top:1px solid var(--divider-color, rgba(127,127,127,.2)); padding-top:8px; }
.footer ha-icon { --mdc-icon-size:15px; }
.editrow { display:grid; grid-template-columns:1fr 1fr; gap:6px; padding:8px; border:1px solid var(--primary-color,#03a9f4); border-radius:12px; margin:4px 0; }
.editrow .full { grid-column: 1 / span 2; }
.editrow .btns { grid-column: 1 / span 2; display:flex; justify-content:flex-end; gap:6px; }
.editrow .btns .primary { padding:7px 14px; }
.error { background: color-mix(in srgb, var(--error-color,#db4437) 15%, transparent); color:var(--primary-text-color); border-radius:10px; padding:10px; margin:4px 2px 8px; font-size:.9em; }
.sec { margin:4px 2px 16px; }
.sec h3 { display:flex; align-items:center; gap:6px; font-size:1em; margin:6px 0 8px; }
.srow { display:flex; align-items:center; gap:6px; margin:5px 0; }
.srow input.grow { flex:1; min-width:80px; }
.srow input[type=color] { width:40px; height:38px; padding:2px; flex:0 0 auto; cursor:pointer; }
.srow input.icon { width:86px; flex:0 0 auto; font-size:.8em; }
.srow .prev { width:24px; flex:0 0 auto; color:var(--secondary-text-color); }
.srow .primary { width:40px; height:38px; flex:0 0 auto; }
.srow .iconbtn { padding:4px; }
.picker { display:grid; grid-template-columns:repeat(auto-fill, minmax(44px, 1fr)); gap:4px; padding:6px; margin:2px 0 8px; border:1px solid var(--divider-color, rgba(127,127,127,.3)); border-radius:10px; max-height:170px; overflow-y:auto; }
.picker button { background:none; border:1px solid transparent; border-radius:8px; cursor:pointer; padding:6px 0; display:flex; flex-direction:column; align-items:center; gap:2px; color:var(--primary-text-color); }
.picker button:hover { border-color:var(--primary-color,#03a9f4); }
.picker button span { font-size:.55em; color:var(--secondary-text-color); max-width:44px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.picker .none { grid-column:1/-1; font-size:.8em; color:var(--secondary-text-color); padding:4px; }
.sec p { margin:4px 0; font-size:.9em; line-height:1.4; }
.hint { color:var(--secondary-text-color); font-size:.8em !important; }
.btnrow { display:flex; flex-wrap:wrap; gap:6px; margin-top:8px; }
.btn { border:1px solid var(--divider-color, rgba(127,127,127,.35)); background:transparent; border-radius:10px; padding:8px 12px; cursor:pointer; font-size:.9em; display:inline-flex; align-items:center; gap:6px; }
.btn.danger { color:var(--error-color,#db4437); border-color:color-mix(in srgb, var(--error-color,#db4437) 50%, transparent); }
.btn.primary { border:0; background:var(--primary-color,#03a9f4); color:var(--text-primary-color,#fff); }
.recipe { display:flex; align-items:center; gap:8px; padding:8px 6px; border-radius:12px; border:1px solid var(--divider-color, rgba(127,127,127,.25)); margin:6px 2px; }
.recipe .rname { flex:1; min-width:0; }
.recipe .rname b { display:block; word-break:break-word; }
.recipe .rname small { color:var(--secondary-text-color); font-size:.78em; display:block; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.recipe .primary { padding:8px 10px; font-size:.85em; }
.rpick { margin:-2px 2px 10px; padding:8px; border-radius:0 0 12px 12px; border:1px solid var(--divider-color, rgba(127,127,127,.25)); border-top:0; background:var(--secondary-background-color, rgba(127,127,127,.06)); }
.rpick .phead { display:flex; justify-content:space-between; align-items:center; font-weight:600; font-size:.9em; padding:2px 4px 6px; }
.rpick .phead span { font-weight:400; }
.linkbtn { background:none; border:0; color:var(--primary-color,#03a9f4); cursor:pointer; font:inherit; padding:2px; }
.pickrow { display:flex; align-items:center; gap:10px; padding:8px 6px; border-radius:10px; cursor:pointer; }
.pickrow ha-icon { color:var(--secondary-text-color); flex:0 0 auto; }
.pickrow.on ha-icon { color:var(--primary-color,#03a9f4); }
.pickrow:not(.on) .pname { opacity:.55; }
.pickrow .pname { flex:1; min-width:0; }
.pickrow .pname small { display:block; font-size:.78em; color:var(--secondary-text-color); }
.pickrow .phint { font-size:.75em; color:var(--success-color,#43a047); white-space:nowrap; }
.rpick .pbtns { display:flex; gap:8px; justify-content:flex-end; margin-top:6px; }
.rpick .pbtns .primary { padding:9px 14px; }
.rpick .pbtns .primary[disabled] { opacity:.4; cursor:default; }
.ritem { display:grid; grid-template-columns: 1fr 64px 34px 34px; gap:5px; padding:8px; border-radius:12px; background:var(--secondary-background-color, rgba(127,127,127,.07)); margin:6px 0; }
.ritem .two { grid-column: 1 / -1; display:grid; grid-template-columns:1fr 1fr; gap:5px; }
.ritem input, .ritem select { padding:7px 8px; font-size:.88em; }
[hidden] { display:none !important; }
`;

class EinkaufslisteCard extends HTMLElement {
  static getConfigElement() { return document.createElement("einkaufsliste-card-editor"); }
  static getStubConfig() { return { title: "Einkaufsliste" }; }

  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._data = null;
    this._tab = null;
    this._view = "list"; // list | recipes | recipe | settings
    this._editing = null;
    this._draft = null;
    this._doneOpen = true;
    this._openDoneCats = new Set(); // aufgeklappte Kategorien bei „Erledigt“
    this._pending = new Set();
    this._picker = null; // welches Icon-Feld gerade sucht
    this._photoCache = new Map();
    this._newPhoto = null;
  }

  setConfig(config) {
    this._config = {
      title: "Einkaufsliste",
      show_title: true,
      store: "all",
      show_checked: true,
      show_added_by: true,
      added_by_style: "name",
      show_dates: true,
      show_settings: true,
      show_recipes: true,
      auto_store: true,
      compact: false,
      ...config,
    };
    if (!this._config.store) this._config.store = "all";
    if (this._config.store !== "all") this._tab = this._config.store;
    if (this._built) this._renderAll();
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._built) this._build();
    if (!this._unsub && !this._subscribing && this.isConnected) this._subscribe();
    this._autoStore();
  }

  // 📍 Nächstes Geschäft: springt auf den Reiter des Geschäfts, bei dem DU gerade bist
  _nearStore() {
    if (!this._hass || !this._data) return null;
    const uid = this._hass.user?.id;
    const person = Object.values(this._hass.states).find(
      (st) => st.entity_id.startsWith("person.") && st.attributes.user_id === uid
    );
    if (!person) return null;
    const { latitude: lat, longitude: lon } = person.attributes;
    let best = null;
    for (const store of this._data.stores) {
      const zone = store.zone && this._hass.states[store.zone];
      if (!zone) continue;
      const zname = zone.attributes.friendly_name || store.zone.slice(5);
      const inside = String(person.state).toLowerCase() === String(zname).toLowerCase();
      let dist = inside ? 0 : null;
      if (dist === null && lat != null && zone.attributes.latitude != null) {
        dist = distance(lat, lon, zone.attributes.latitude, zone.attributes.longitude);
        if (dist > (zone.attributes.radius || 100) + 200) dist = null; // noch zu weit weg
      }
      if (dist !== null && (!best || dist < best.dist)) best = { id: store.id, dist };
    }
    return best?.id || null;
  }

  _autoStore() {
    if (!this._config?.auto_store || this._fixedStore || !this._data) return;
    const near = this._nearStore();
    if (near === this._lastNear) return;
    const prev = this._lastNear;
    this._lastNear = near;
    if (near) {
      this._tab = near;
      this._toast(`📍 Du bist bei ${this._store(near)?.name} – hier ist deine Liste dafür`);
    } else if (prev && this._tab === prev) {
      this._tab = "all";
    }
    this._renderAll();
  }

  connectedCallback() {
    clearInterval(this._clock);
    this._clock = setInterval(() => {
      if (this._view === "list" && !this._editing && this._data) this._renderList(); // „vor 5 Min“ aktuell halten
    }, 60000);
    if (this._hass && !this._unsub && !this._subscribing) this._subscribe();
  }

  disconnectedCallback() {
    clearInterval(this._clock);
    if (this._unsub) { this._unsub(); this._unsub = null; }
  }

  getCardSize() { return 3 + Math.min(10, (this._data?.items?.filter((i) => !i.checked).length || 0)); }

  async _subscribe() {
    this._subscribing = true;
    try {
      const unsub = await this._hass.connection.subscribeMessage(
        (data) => {
          this._data = data;
          this._error = null;
          if (!this._seenSnap && this._mySeen()) this._seenSnap = { ...this._mySeen() };
          this._renderAll();
          this._autoStore();
        },
        { type: "einkaufsliste/subscribe" }
      );
      if (!this.isConnected) unsub(); else this._unsub = unsub;
    } catch (err) {
      this._error = err?.code === "unknown_command" || err?.code === "not_loaded"
        ? "Die Integration „Einkaufsliste“ ist noch nicht eingerichtet. Einstellungen → Geräte & Dienste → Integration hinzufügen → Einkaufsliste."
        : `Verbindung klappt nicht: ${err?.message || err}`;
      this._renderAll();
    }
    this._subscribing = false;
  }

  _ws(msg) {
    return this._hass.callWS(msg).catch((err) => {
      this._toast(err?.message || "Da ist was schiefgelaufen 🙈");
      throw err;
    });
  }

  _toast(message) {
    this.dispatchEvent(new CustomEvent("hass-notification", { detail: { message }, bubbles: true, composed: true }));
  }

  $(id) { return this.shadowRoot.getElementById(id); }

  // ---------------------------------------------------------------- Aufbau
  _build() {
    this._built = true;
    this.shadowRoot.innerHTML = `
      <style>${STYLE}</style>
      <ha-card>
        <div class="head">
          <div class="title"><ha-icon id="titleIcon" icon="mdi:cart-variant"></ha-icon><span class="t" id="title"></span><span class="badge" id="count" hidden></span></div>
          <button class="iconbtn" id="btnShop" data-act="shopmode" title="Laden-Modus"><ha-icon icon="mdi:cart-outline"></ha-icon></button>
          <button class="iconbtn" id="btnRecipes" data-act="view" data-view="recipes" title="Rezepte"><ha-icon icon="mdi:chef-hat"></ha-icon></button>
          <button class="iconbtn" id="btnSettings" data-act="view" data-view="settings" title="Geschäfte & Kategorien"><ha-icon icon="mdi:cog-outline"></ha-icon></button>
        </div>
        <div class="error" id="error" hidden></div>
        <div id="listView">
          <div class="tabs" id="tabs"></div>
          <form class="add" id="addForm" autocomplete="off">
            <input id="inName" placeholder="Was brauchen wir?" enterkeyhint="done">
            <button class="primary addbtn" type="submit" title="Hinzufügen"><ha-icon icon="mdi:check-bold"></ha-icon></button>
            <div class="sugg" id="sugg" hidden></div>
            <div class="toolbar">
              <button class="tool" id="tQty" type="button" data-act="tool" data-field="qtyBox" title="Menge"><ha-icon icon="mdi:numeric"></ha-icon></button>
              <button class="tool" id="tNote" type="button" data-act="tool" data-field="inNote" title="Notiz"><ha-icon icon="mdi:note-text-outline"></ha-icon></button>
              <button class="tool" id="tFor" type="button" data-act="tool" data-field="forBox" title="Für wen?"><ha-icon icon="mdi:account-outline"></ha-icon></button>
              <button class="tool" id="btnNewPhoto" type="button" data-act="new-photo" title="Foto zum Artikel"><ha-icon icon="mdi:camera-plus-outline"></ha-icon></button>
              <button class="tool" id="btnScan" type="button" data-act="scan" title="Barcode scannen" hidden><ha-icon icon="mdi:barcode-scan"></ha-icon></button>
              <button class="tool tclear" id="tClear" type="button" data-act="clear-form" title="Alles leeren" hidden><ha-icon icon="mdi:eraser"></ha-icon></button>
            </div>
            <div class="extras">
              <div id="qtyBox" class="chipbox" hidden>
                <div class="chips" id="qtyChips"></div>
                <input id="inQty" placeholder="🔢 Menge, z. B. 500 g" hidden>
              </div>
              <input id="inNote" placeholder="📝 Notiz, z. B. Bio" hidden>
              <div id="forBox" class="chipbox" hidden><div class="chips" id="forChips"></div></div>
              <select id="inFor" title="Für wen?" hidden></select>
            </div>
            <div class="row2 sel">
              <select id="inStore" title="Geschäft"></select>
              <select id="inCat" title="Kategorie"></select>
            </div>
            <datalist id="hist"></datalist>
            <input type="file" id="newPhotoFile" accept="image/*" hidden>
            <input type="file" id="photoFile" accept="image/*" hidden>
          </form>
          <div id="list"></div>
        </div>
        <div id="otherView" hidden></div>
        <div class="footer" id="footer" hidden></div>
      </ha-card>`;

    const root = this.shadowRoot;
    this.$("addForm").addEventListener("submit", (e) => this._onAdd(e));
    this.$("newPhotoFile").addEventListener("change", (e) => this._onNewPhotoFile(e));
    this.$("inCat").addEventListener("change", () => { this._catManual = !!this.$("inCat").value; this._updateTools(); });
    for (const id of ["inQty", "inNote", "inFor"]) {
      this.$(id).addEventListener("input", () => this._updateTools());
      this.$(id).addEventListener("change", () => this._updateTools());
    }
    this.$("photoFile").addEventListener("change", (e) => this._onPhotoFile(e));
    this.$("inName").addEventListener("input", () => { if (!this.$("inName").value.trim()) this._pendingBarcode = null; this._onNameInput(); this._renderSuggest(); this._updateTools(); if (!this._editing) this._renderList(); });
    root.addEventListener("click", (e) => this._onClick(e), true);
    this._setupTabScroll(this.$("tabs"));
    this._setupLongPress(this.$("list"));
    root.addEventListener("change", (e) => this._onChange(e));
    root.addEventListener("input", (e) => this._onInput(e));
    root.addEventListener("submit", (e) => {
      if (e.target.dataset?.addkind) this._onGroupAdd(e);
      if (e.target.classList?.contains("editrow")) { e.preventDefault(); this._saveEdit(); }
    });
    this._renderAll();
  }

  // 👆 Lange drücken (oder Rechtsklick) auf einen Artikel öffnet sein Menü
  _setupLongPress(list) {
    let timer = null, startX = 0, startY = 0;
    const open = (itemEl) => {
      const id = itemEl?.dataset.id;
      if (!id) return;
      navigator.vibrate?.(30);
      this._menuId = this._menuId === id ? null : id;
      this._moving = null;
      this._qtyEdit = null;
      // nach 8 Sekunden ohne Tipp wieder zuklappen
      clearTimeout(this._menuTimer);
      if (this._menuId) {
        const openId = this._menuId;
        this._menuTimer = setTimeout(() => {
          if (this._menuId === openId) { this._menuId = null; this._renderList(); }
        }, 8000);
      }
      this._longPressed = true;
      setTimeout(() => { this._longPressed = false; }, 400);
      this._renderList();
    };
    list.addEventListener("pointerdown", (e) => {
      const itemEl = e.target.closest(".item");
      if (!itemEl || e.target.closest("[data-act]")) return;
      startX = e.clientX; startY = e.clientY;
      clearTimeout(timer);
      timer = setTimeout(() => open(itemEl), 500);
    });
    const cancel = () => clearTimeout(timer);
    list.addEventListener("pointerup", cancel);
    list.addEventListener("pointercancel", cancel);
    list.addEventListener("pointerleave", cancel);
    list.addEventListener("pointermove", (e) => {
      if (Math.abs(e.clientX - startX) > 8 || Math.abs(e.clientY - startY) > 8) cancel();
    });
    list.addEventListener("contextmenu", (e) => {
      const itemEl = e.target.closest(".item");
      if (!itemEl) return;
      e.preventDefault();
      clearTimeout(timer);
      if (!this._longPressed) open(itemEl);
    });
  }

  // Geschäfte-Leiste am PC: Mausrad und Ziehen mit der Maus scrollen waagerecht
  _setupTabScroll(el) {
    el.addEventListener("wheel", (e) => {
      if (el.scrollWidth <= el.clientWidth) return;
      const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      const atStart = el.scrollLeft <= 0 && delta < 0;
      const atEnd = el.scrollLeft + el.clientWidth >= el.scrollWidth - 1 && delta > 0;
      if (atStart || atEnd) return; // am Rand: Seite normal weiterscrollen lassen
      el.scrollLeft += delta;
      e.preventDefault();
    }, { passive: false });
    let startX = 0, startLeft = 0, down = false;
    el.addEventListener("pointerdown", (e) => {
      if (e.pointerType !== "mouse" || e.button !== 0) return;
      down = true; this._dragged = false; startX = e.clientX; startLeft = el.scrollLeft;
    });
    window.addEventListener("pointermove", (e) => {
      if (!down) return;
      const dx = e.clientX - startX;
      if (!this._dragged && Math.abs(dx) > 5) { this._dragged = true; el.classList.add("dragging"); }
      if (this._dragged) el.scrollLeft = startLeft - dx;
    });
    window.addEventListener("pointerup", () => {
      if (!down) return;
      down = false;
      el.classList.remove("dragging");
      setTimeout(() => { this._dragged = false; }, 0);
    });
  }

  // ---------------------------------------------------------------- Helfer
  get _fixedStore() { return this._config.store && this._config.store !== "all" ? this._config.store : null; }
  get _activeTab() {
    if (this._fixedStore) return this._fixedStore;
    const t = this._tab || "all";
    if (t !== "all" && t !== "none" && this._data && !this._data.stores.some((s) => s.id === t)) return "all";
    return t;
  }
  _store(id) { return this._data?.stores.find((s) => s.id === id); }
  _cat(id) { return this._data?.categories.find((c) => c.id === id); }
  _recipe(id) { return this._data?.recipes?.find((r) => r.id === id); }
  _who(name) {
    if (!name) return "";
    const st = this._config.added_by_style;
    if (st === "first") return name.split(/\s+/)[0];
    if (st === "initials") return name.split(/\s+/).filter(Boolean).map((p) => p[0]).join("").toUpperCase();
    return name;
  }
  _matchesTab(item) {
    const t = this._activeTab;
    if (t === "all") return true;
    if (t === "none") return !item.store_id;
    return item.store_id === t;
  }
  _autoCheckDate(item) {
    const s = this._data?.settings;
    if (!s || item.checked) return null;
    let d = new Date(s.next_cleanup);
    const added = new Date(item.added_at);
    for (let i = 0; i < 60 && dayDiff(d, added) < s.min_age_days; i++) d = new Date(d.getTime() + 7 * DAY);
    return d;
  }
  _personOptions(selected) {
    const names = (this._data?.persons || []).map((p) => p.name);
    if (selected && !names.some((n) => n.toLowerCase() === selected.toLowerCase())) names.push(selected);
    return `<option value="">👤 Für wen?</option>` + names.map((n) => `<option value="${esc(n)}" ${selected && n.toLowerCase() === selected.toLowerCase() ? "selected" : ""}>👤 ${esc(n)}</option>`).join("");
  }
  _selectOptions(list, selected, empty) {
    return `<option value="">${empty}</option>` + list.map((x) => `<option value="${x.id}" ${x.id === selected ? "selected" : ""}>${esc(x.name)}</option>`).join("");
  }

  // ---------------------------------------------------------------- Rendern
  _renderAll() {
    if (!this._built || !this._config) return;
    if (this._shopMode === undefined) {
      try { this._shopMode = localStorage.getItem("einkaufsliste_shopmode") === "1"; } catch (_) { this._shopMode = false; }
      try { this._dupIgnore = new Set(JSON.parse(localStorage.getItem("einkaufsliste_dup_ignore") || "[]")); } catch (_) { this._dupIgnore = new Set(); }
    }
    const d = this._data;
    const c = this._config;
    const titleText = this._fixedStore && this._store(this._fixedStore)
      ? `${c.title || ""}${c.title ? " · " : ""}${this._store(this._fixedStore).name}` : (c.title || "");
    const showTitle = c.show_title !== false && !!titleText;
    const cardEl = this.shadowRoot.querySelector("ha-card");
    cardEl.classList.toggle("compact", !!c.compact);
    const shop = !!this._shopMode && this._view === "list";
    cardEl.classList.toggle("shop", shop);
    const btnShop = this.$("btnShop");
    btnShop.hidden = !d || this._view !== "list";
    btnShop.classList.toggle("on", shop);
    btnShop.title = shop ? "Laden-Modus beenden" : "Laden-Modus (große Zeilen, nur Abhaken)";
    btnShop.querySelector("ha-icon").setAttribute("icon", shop ? "mdi:cart-off" : "mdi:cart-outline");
    this.$("title").textContent = showTitle ? titleText : "";
    this.$("titleIcon").hidden = !showTitle;
    const err = this.$("error");
    err.hidden = !this._error;
    err.textContent = this._error || "";
    const btnS = this.$("btnSettings");
    const btnR = this.$("btnRecipes");
    btnS.hidden = !c.show_settings || !d;
    btnR.hidden = !c.show_recipes || !d;
    const inSettings = this._view === "settings" || this._view === "recipe";
    btnS.classList.toggle("on", inSettings);
    btnR.classList.toggle("on", this._view === "recipes");
    btnS.querySelector("ha-icon").setAttribute("icon", inSettings ? "mdi:close" : "mdi:cog-outline");
    btnR.querySelector("ha-icon").setAttribute("icon", this._view === "recipes" ? "mdi:close" : "mdi:chef-hat");
    if (!d) { this.$("listView").hidden = true; this.$("footer").hidden = true; return; }

    const open = d.items.filter((i) => !i.checked && (this._fixedStore ? i.store_id === this._fixedStore : true));
    const cnt = this.$("count");
    cnt.hidden = open.length === 0;
    cnt.textContent = open.length;

    const isList = this._view === "list";
    this.$("listView").hidden = !isList;
    this.$("otherView").hidden = isList;
    if (isList) {
      this._renderTabs();
      this._renderSelects();
      this._renderHistory();
      if (!this._editing) this._renderList();
    } else {
      const ov = this.$("otherView");
      const switched = this._renderedView !== this._view;
      const busy = !switched && ov.contains(this.shadowRoot.activeElement);
      if (this._view === "settings" && !busy) this._renderSettings();
      if (this._view === "recipes") this._renderRecipes();
      if (this._view === "recipe" && !this._draftRendered) this._renderRecipeEditor();
    }
    this._renderedView = this._view;
    this._renderFooter();
  }

  _renderTabs() {
    const tabs = this.$("tabs");
    const d = this._data;
    if (this._fixedStore) { tabs.hidden = true; this._markSeen(); return; }
    tabs.hidden = false;
    const openCount = (fn) => d.items.filter((i) => !i.checked && fn(i)).length;
    const active = this._activeTab;
    const bubble = (fn, isActive) => {
      const n = isActive ? 0 : this._newCount(fn);
      return n ? `<span class="bubble">+${n}</span>` : "";
    };
    const parts = [`<button class="tab ${active === "all" ? "active" : ""}" data-act="tab" data-tab="all">Alle <span class="n">${openCount(() => true)}</span>${bubble(() => true, active === "all")}</button>`];
    for (const s of d.stores) {
      parts.push(`<button class="tab ${active === s.id ? "active" : ""}" style="--c:${esc(s.color)}" data-act="tab" data-tab="${s.id}"><span class="dot"></span>${this._lastNear === s.id ? "📍 " : ""}${esc(s.name)} <span class="n">${openCount((i) => i.store_id === s.id)}</span>${bubble((i) => i.store_id === s.id, active === s.id || active === "all")}</button>`);
    }
    const none = d.items.filter((i) => !i.store_id).length;
    if (none || active === "none") {
      parts.push(`<button class="tab ${active === "none" ? "active" : ""}" style="--c:#888" data-act="tab" data-tab="none"><span class="dot"></span>Egal wo <span class="n">${openCount((i) => !i.store_id)}</span></button>`);
    }
    const left = tabs.scrollLeft;
    tabs.innerHTML = parts.join("");
    this._markSeen();
    tabs.scrollLeft = left;
  }

  _renderSelects() {
    const d = this._data;
    const st = this.$("inStore");
    const ct = this.$("inCat");
    this.$("addForm").classList.toggle("fixed", !!this._fixedStore);
    const scanBtn = this.$("btnScan");
    scanBtn.hidden = !this._hasAppScanner();
    const nearStore = this._lastNear && this._store(this._lastNear);
    scanBtn.classList.toggle("instore", !!nearStore);
    scanBtn.title = nearStore ? `Scannen & abhaken (${nearStore.name})` : "Barcode scannen";
    this._updateTools();
    st.hidden = !!this._fixedStore;
    const prevStore = st.value;
    const prevCat = ct.value;
    const pf = this.$("inFor");
    const prevFor = pf.value;
    pf.innerHTML = this._personOptions(null);
    this.$("tFor").hidden = !(d.persons || []).length;
    if (this.$("tFor").hidden) this.$("forBox").hidden = true;
    if ((d.persons || []).some((p) => p.name === prevFor)) pf.value = prevFor;
    st.innerHTML = this._selectOptions(d.stores, null, "🛒 Egal wo");
    ct.innerHTML = this._selectOptions(d.categories, null, "📦 Ohne Kategorie");
    const tab = this._activeTab;
    if (this._lastTab !== tab) {
      st.value = tab !== "all" && tab !== "none" ? tab : "";
      this._lastTab = tab;
    } else if (d.stores.some((s) => s.id === prevStore)) st.value = prevStore;
    if (d.categories.some((c) => c.id === prevCat)) ct.value = prevCat;
  }

  // 🔎 Eigene Vorschläge beim Tippen (datalist klappt in der HA-App am Handy nicht)
  // Jede Variante aus der Liste (Menge, Notiz, für wen, Geschäft) ist ein eigener Vorschlag –
  // antippen übernimmt alles davon ins Formular.
  _renderSuggest() {
    const box = this.$("sugg");
    if (!box) return;
    const q = (this.$("inName").value || "").trim().toLowerCase();
    this._suggMap = new Map();
    if (!q || !this._data) { box.hidden = true; box.innerHTML = ""; return; }
    const score = (low) => (low.startsWith(q) || low.split(/\s+/).some((w) => w.startsWith(q)) ? 0 : low.includes(q) ? 1 : -1);
    const cands = [];
    const seenVariant = new Set();
    const names = new Set();
    // zuerst Artikel aus der Liste: aktueller Reiter vor anderen, abgehakt vor offen
    const items = [...this._data.items].sort((a, b) =>
      (this._matchesTab(b) - this._matchesTab(a)) || (b.checked - a.checked)
      || String(b.added_at || "").localeCompare(String(a.added_at || "")));
    for (const i of items) {
      if (i.recipe_id) continue;
      const low = i.name.toLowerCase();
      const sc = score(low);
      if (sc < 0) continue;
      const key = [low, i.quantity || "", i.note || "", i.for_whom || "", i.store_id || ""].join("|");
      if (seenVariant.has(key)) continue;
      seenVariant.add(key);
      names.add(low);
      cands.push({ sc, name: i.name, item: i });
    }
    for (const h of this._data.history || []) {
      const low = h.name.toLowerCase();
      if (names.has(low)) continue;
      const sc = score(low);
      if (sc < 0) continue;
      names.add(low);
      cands.push({ sc, name: h.name, hist: h });
    }
    cands.sort((a, b) => a.sc - b.sc);
    const list = cands.slice(0, 8);
    if (!list.length) { box.hidden = true; box.innerHTML = ""; return; }
    const mark = (name) => {
      const at = name.toLowerCase().indexOf(q);
      return at < 0 ? esc(name) : esc(name.slice(0, at)) + "<b>" + esc(name.slice(at, at + q.length)) + "</b>" + esc(name.slice(at + q.length));
    };
    box.innerHTML = list.map((c, n) => {
      this._suggMap.set(String(n), c);
      const i = c.item;
      const bits = [];
      if (i) {
        if (i.quantity) bits.push(esc(i.quantity));
        if (i.note) bits.push("📝 " + esc(i.note));
        if (i.for_whom) bits.push("👤 " + esc(i.for_whom));
        const st = i.store_id && this._store(i.store_id);
        if (st && this._activeTab === "all") bits.push(esc(st.name));
        if (!i.checked) bits.push("steht drauf");
      }
      return `<button type="button" class="sug" data-act="suggest" data-n="${n}"><span>${mark(c.name)}</span>${
        bits.length ? `<span class="on">· ${bits.join(" · ")}</span>` : ""}</button>`;
    }).join("");
    box.hidden = false;
  }

  _applySuggest(c) {
    const set = (id, v) => { this.$(id).value = v || ""; };
    set("inName", c.name);
    const i = c.item;
    if (!i) {
      this._onNameInput();
      return;
    }
    set("inQty", i.quantity);
    set("inNote", i.note);
    const f = this.$("inFor");
    if (i.for_whom && ![...f.options].some((o) => o.value === i.for_whom)) {
      const o = document.createElement("option");
      o.value = o.textContent = i.for_whom;
      f.appendChild(o);
    }
    f.value = i.for_whom || "";
    if (!this._fixedStore && i.store_id && this._store(i.store_id)) this.$("inStore").value = i.store_id;
    if (i.category_id && this._cat(i.category_id)) { this.$("inCat").value = i.category_id; this._catManual = true; }
    this.$("inNote").hidden = !i.note;
    this._renderQtyChips();
    this._renderForChips();
  }

  _renderHistory() {
    const d = this._data;
    const key = d.history.map((h) => h.name).join("|");
    if (key === this._histKey) return;
    this._histKey = key;
    this.$("hist").innerHTML = d.history.map((h) => `<option value="${esc(h.name)}"></option>`).join("");
  }

  _itemHtml(item) {
    const c = this._config;
    const store = this._store(item.store_id);
    const recipe = this._recipe(item.recipe_id);
    const meta = [];
    if (this._activeTab === "all" && store) meta.push(`<span class="chip" style="--c:${esc(store.color)}">${esc(store.name)}</span>`);
    if (item.for_whom) meta.push(`<span>👤 für ${esc(item.for_whom)}</span>`);
    if (item.note) meta.push(`<span>📝 ${esc(item.note)}</span>`);
    if (recipe) meta.push(`<span>🍽️ ${esc(recipe.name)}</span>`);
    if (c.show_dates) {
      if (item.checked) {
        meta.push(`<span>✓ ${item.checked_by ? esc(this._who(item.checked_by)) : "automatisch"}</span>`);
      } else {
        meta.push(`<span>${fmtSince(item.added_at)}</span>`);
        const auto = this._autoCheckDate(item);
        if (auto) meta.push(`<span title="Wird an diesem Tag automatisch abgehakt">🧹 ${fmtDay(auto)}</span>`);
      }
    }
    const who = c.show_added_by && item.added_by ? `<span class="who">(${esc(this._who(item.added_by))})</span>` : "";
    const qty = item.quantity ? `<button class="qty" data-act="qty-edit" title="Menge ändern">${esc(item.quantity)}</button>` : "";
    const icon = item.checked ? "mdi:checkbox-marked-circle-outline" : "mdi:checkbox-blank-circle-outline";
    const cat = this._cat(item.category_id);
    const isNew = this._isNew(item);
    return `
      <div class="item ${item.checked ? "done" : ""} ${this._pending.has(item.id) ? "pending" : ""} ${isNew ? "new" : ""} ${item.name.startsWith("❓") ? "unknown" : ""}" data-id="${item.id}" style="--cc:${esc(cat?.color || "transparent")}">
        <button class="iconbtn check" data-act="toggle" title="${item.checked ? "Wieder auf die Liste" : "Abhaken"}"><ha-icon icon="${icon}"></ha-icon></button>
        <div class="txt">
          <div class="line">${isNew ? `<span class="newbadge" title="Neu seit deinem letzten Blick">✨</span>` : ""}<span class="name">${esc(item.name)}</span>${qty}${who}${this._hasPhoto(item.name) ? `<button class="photobtn" data-act="photo-view" data-name="${esc(item.name)}" title="Foto ansehen"><ha-icon icon="mdi:camera"></ha-icon></button>` : ""}</div>
          ${meta.length ? `<div class="meta">${meta.join("")}</div>` : ""}
        </div>
        ${!item.checked && this._data.stores.length > 1 ? `<div class="acts"><button class="iconbtn" data-act="move" title="War aus – in anderes Geschäft"><ha-icon icon="mdi:swap-horizontal"></ha-icon></button></div>` : ""}
      </div>`;
  }

  _menuHtml(item) {
    const b = (act, icon, label) => `<button class="menubtn" data-act="${act}" data-id="${item.id}"><ha-icon icon="${icon}"></ha-icon>${label}</button>`;
    return `
      <div class="menurow" data-id="${item.id}">
        ${b("menu-edit", "mdi:pencil-outline", "Bearbeiten")}
        ${!item.checked && this._data.stores.length > 1 ? b("menu-move", "mdi:swap-horizontal", "Verschieben") : ""}
        ${b("menu-qty", "mdi:numeric", "Menge")}
        ${b("menu-photo", "mdi:camera-plus-outline", this._hasPhoto(item.name) ? "Foto ändern" : "Foto")}
        ${this._hasAppScanner() ? b("barcode-assign", "mdi:barcode-scan", "Barcode") : ""}
        <button class="iconbtn" data-act="menu-close" title="Schließen"><ha-icon icon="mdi:close"></ha-icon></button>
      </div>`;
  }

  _qtyHtml(item) {
    const m = String(item.quantity || "").match(/^(\d+)\s*(x|stk\.?|stück)?$/i);
    const n = m ? Number(m[1]) : 1;
    return `
      <div class="qtyrow" data-id="${item.id}">
        <button class="qbtn" data-act="qty-minus" ${n <= 1 ? "disabled" : ""}>−</button>
        <span class="qval">${n}x</span>
        <button class="qbtn" data-act="qty-plus">＋</button>
        <button class="iconbtn" data-act="qty-done" title="Fertig"><ha-icon icon="mdi:check"></ha-icon></button>
      </div>`;
  }

  _moveHtml(item) {
    const here = this._store(item.store_id);
    const targets = this._data.stores.filter((s) => s.id !== item.store_id);
    return `
      <div class="moverow" data-id="${item.id}">
        <span class="movetxt">${here ? `Bei ${esc(here.name)} nicht da? Ab zu:` : "Wo gibt's das?"}</span>
        ${targets.map((s) => `<button class="tab" style="--c:${esc(s.color)}" data-act="move-to" data-store="${s.id}"><span class="dot"></span>${esc(s.name)}</button>`).join("")}
        <button class="iconbtn" data-act="move-cancel" title="Abbrechen"><ha-icon icon="mdi:close"></ha-icon></button>
      </div>`;
  }

  _editHtml(item) {
    const d = this._data;
    return `
      <form class="editrow" data-id="${item.id}">
        <input class="full" id="edName" value="${esc(item.name)}" placeholder="Name">
        <input id="edQty" value="${esc(item.quantity || "")}" placeholder="Menge">
        <select id="edFor">${this._personOptions(item.for_whom)}</select>
        <input class="full" id="edNote" value="${esc(item.note || "")}" placeholder="📝 Notiz (z. B. Bio)">
        <select id="edStore">${this._selectOptions(d.stores, item.store_id, "🛒 Egal wo")}</select>
        <select id="edCat">${this._selectOptions(d.categories, item.category_id, "📦 Ohne Kategorie")}</select>
        <div class="full photorow">
          <button type="button" class="btn" data-act="photo-take" data-name="${esc(item.name)}"><ha-icon icon="mdi:camera-plus-outline"></ha-icon>${this._hasPhoto(item.name) ? "Foto ändern" : "Foto"}</button>
          ${this._hasAppScanner() ? `<button type="button" class="btn" data-act="barcode-assign" data-id="${item.id}"><ha-icon icon="mdi:barcode-scan"></ha-icon>Barcode zuordnen</button>` : ""}
          ${this._hasPhoto(item.name) ? `<button type="button" class="btn" data-act="photo-view" data-name="${esc(item.name)}"><ha-icon icon="mdi:image-outline"></ha-icon>Ansehen</button>
          <button type="button" class="btn danger" data-act="photo-remove" data-name="${esc(item.name)}"><ha-icon icon="mdi:image-remove-outline"></ha-icon>Foto löschen</button>` : ""}
        </div>
        <div class="btns">
          <button type="button" class="textbtn" data-act="edit-cancel">Abbrechen</button>
          <button type="submit" class="primary">Speichern</button>
        </div>
      </form>`;
  }

  _groupedHtml(items, row, sortFn, collapsible = false, forceOpen = false) {
    const d = this._data;
    const groups = new Map();
    for (const c of d.categories) groups.set(c.id, []);
    groups.set(null, []);
    for (const i of items) (groups.has(i.category_id) ? groups.get(i.category_id) : groups.get(null)).push(i);
    const html = [];
    for (const [cid, arr] of groups) {
      if (!arr.length) continue;
      arr.sort(sortFn);
      const cat = this._cat(cid);
      const label = `<ha-icon icon="${esc(cat?.icon || "mdi:tag-outline")}"></ha-icon>${esc(cat?.name || "Ohne Kategorie")}<span class="n">${arr.length}</span>`;
      if (!collapsible) {
        html.push(`<div class="group"><div class="ghead subhead">${label}</div>${arr.map(row).join("")}</div>`);
        continue;
      }
      const key = cid || "none";
      const open = forceOpen || this._openDoneCats.has(key) || arr.some((i) => i.id === this._editing);
      html.push(`<div class="group"><div class="ghead subhead donehead ${open ? "" : "closed"}" data-act="toggle-donecat" data-cat="${key}"><ha-icon class="chev" icon="mdi:chevron-down"></ha-icon>${label}</div>${open ? arr.map(row).join("") : ""}</div>`);
    }
    return html.join("");
  }

  _renderList() {
    const d = this._data;
    if (!d) return;
    const list = this.$("list");
    const items = d.items.filter((i) => this._matchesTab(i));
    const open = items.filter((i) => !i.checked);
    const filter = (this.$("inName").value || "").trim().toLowerCase();
    let done = items.filter((i) => i.checked);
    if (filter) done = done.filter((i) => i.name.toLowerCase().includes(filter));
    const row = (i) => (this._editing === i.id ? this._editHtml(i) : this._itemHtml(i)
      + (this._menuId === i.id ? this._menuHtml(i) : "")
      + (this._qtyEdit === i.id ? this._qtyHtml(i) : "")
      + (this._moving === i.id ? this._moveHtml(i) : ""));
    const byName = (a, b) => a.name.localeCompare(b.name, "de");
    const html = [];
    if (this._shopMode) {
      html.push(`<div class="shopbar"><ha-icon icon="mdi:cart"></ha-icon><b>Laden-Modus – einfach abhaken 🛒</b><button class="btn" data-act="shopmode">Beenden</button></div>`);
    }
    const dup = filter ? null : this._findDuplicate(open);
    if (dup) {
      const [a, b] = dup;
      const st = this._store(a.store_id);
      html.push(`<div class="dupbar" data-a="${a.id}" data-b="${b.id}">🔍 <b>„${esc(a.name)}“</b> und <b>„${esc(b.name)}“</b> stehen beide${st ? ` bei ${esc(st.name)}` : ""} auf der Liste. Zusammenlegen?
        <div class="dbtns"><button class="btn" data-act="dup-ignore">Passt so</button><button class="primary addbtn" data-act="dup-merge"><ha-icon icon="mdi:call-merge"></ha-icon>Zusammenlegen</button></div></div>`);
    }

    if (!open.length) {
      html.push(`<div class="empty"><ha-icon icon="mdi:cart-check"></ha-icon>${
        items.length ? "Alles im Korb – nix mehr offen! 🎉" : "Noch nichts auf der Liste. Tipp oben rein, was fehlt! ✍️"}</div>`);
    } else {
      html.push(this._groupedHtml(open, row, byName).replace(/ghead subhead/g, "ghead"));
    }

    if (this._config.show_checked && (done.length || filter)) {
      const total = items.filter((i) => i.checked).length;
      html.push(`<div class="group">
        <div class="ghead donehead ${this._doneOpen || filter ? "" : "closed"}" data-act="toggle-done"><ha-icon class="chev" icon="mdi:chevron-down"></ha-icon>Erledigt – schon mal gekauft<span class="n">${filter ? `${done.length} / ` : ""}${total}</span></div>
        ${this._doneOpen || filter ? `<div class="donehint">Tipp auf den Kreis, um es wieder auf die Liste zu nehmen.</div>${
          done.length ? this._groupedHtml(done, row, byName, true, !!filter) : `<div class="donehint">Nichts gefunden zu „${esc(filter)}“.</div>`}` : ""}
      </div>`);
    }
    list.innerHTML = html.join("");
    if (this._editing) this.$("edName")?.focus();
  }

  // 🔍 Doppelt-Finder: „Tomate“ + „Tomaten“, „Klopapier“ + „Toilettenpapier“ …
  _dupKey(name) {
    let w = name.toLowerCase().replace(/ß/g, "ss").replace(/[^a-zäöü0-9]/g, "");
    const syn = DUP_SYNONYMS[w];
    if (syn) return syn;
    for (const end of ["en", "n", "e", "s", "er"]) {
      if (w.length > end.length + 3 && w.endsWith(end)) { w = w.slice(0, -end.length); break; }
    }
    return DUP_SYNONYMS[w] || w;
  }

  _findDuplicate(open) {
    const seen = new Map();
    const list = open.filter((i) => !i.recipe_id)
      .sort((a, b) => String(a.added_at || "").localeCompare(String(b.added_at || "")));
    for (const i of list) {
      const key = [this._dupKey(i.name), i.store_id || "", (i.for_whom || "").toLowerCase()].join("|");
      const other = seen.get(key);
      if (other && other.name.toLowerCase() !== i.name.toLowerCase()) {
        const pair = [other.id, i.id].sort().join("+");
        if (!this._dupIgnore?.has(pair)) return [other, i];
      }
      if (!other) seen.set(key, i);
    }
    return null;
  }

  async _mergeDuplicate(keepId, dropId) {
    const keep = this._data.items.find((i) => i.id === keepId);
    const drop = this._data.items.find((i) => i.id === dropId);
    if (!keep || !drop) return;
    const upd = {};
    const num = (q) => { const m = /^(\d+)\s*x$/i.exec((q || "").trim()); return m ? Number(m[1]) : null; };
    if (num(keep.quantity) && num(drop.quantity)) upd.quantity = `${num(keep.quantity) + num(drop.quantity)}x`;
    else if (!keep.quantity && drop.quantity) upd.quantity = drop.quantity;
    if (!keep.note && drop.note) upd.note = drop.note;
    else if (keep.note && drop.note && keep.note !== drop.note) upd.note = `${keep.note}, ${drop.note}`;
    try {
      if (Object.keys(upd).length) await this._ws({ type: "einkaufsliste/item/update", item_id: keep.id, ...upd });
      await this._ws({ type: "einkaufsliste/item/remove", item_id: drop.id });
      this._toast(`🔗 Zusammengelegt zu „${keep.name}“${upd.quantity ? ` (${upd.quantity})` : ""}`);
    } catch (_) { /* Meldung kam schon */ }
  }

  _renderFooter() {
    const f = this.$("footer");
    const s = this._data?.settings;
    if (!s || this._view !== "list") { f.hidden = true; return; }
    f.hidden = false;
    const next = new Date(s.next_cleanup);
    f.innerHTML = `<ha-icon icon="mdi:broom"></ha-icon><span>Nächstes Aufräumen: <b>${fmtDay(next)} ${s.cleanup_time}</b> – was ${s.min_age_days} Tage oder länger drauf steht, wird abgehakt</span>`;
  }

  // ---------------------------------------------------------------- Icon-Suche
  async _loadIcons() {
    if (this.constructor._icons) return this.constructor._icons;
    if (!this.constructor._iconsPromise) {
      this.constructor._iconsPromise = fetch(`${EL_BASE}/mdi-icons.json?v=${EL_VERSION}`)
        .then((r) => r.json())
        .then((list) => (this.constructor._icons = list.map((e) => { const [name, ...alias] = e.split(" "); return { name, text: e }; })))
        .catch(() => (this.constructor._icons = []));
    }
    return this.constructor._iconsPromise;
  }

  async _showPicker(input) {
    const box = input.closest(".srow, .sec, .recipehead")?.nextElementSibling;
    const picker = box?.classList.contains("picker") ? box : null;
    if (!picker) return;
    const q = stripMdi(input.value).trim().toLowerCase();
    if (!q) { picker.hidden = true; return; }
    const icons = await this._loadIcons();
    // Deutsche Begriffe zuerst übersetzen, dann nach Treffer-Güte sortieren
    const mapped = [];
    for (const [de, en] of Object.entries(ICON_DE)) if (de.startsWith(q) || (q.length > 3 && q.startsWith(de))) mapped.push(en);
    const score = (ic) => {
      let best = 99;
      const words = ic.text.split(" ");
      mapped.forEach((t, n) => {
        if (ic.name === t) best = Math.min(best, 0 + n * 0.01);
        else if (ic.name.startsWith(t + "-")) best = Math.min(best, 1 + n * 0.01);
        else if (words.includes(t)) best = Math.min(best, 2);
      });
      if (ic.name === q) best = Math.min(best, 0.5);
      else if (ic.name.startsWith(q)) best = Math.min(best, 3);
      else if (ic.name.split("-").some((w) => w.startsWith(q))) best = Math.min(best, 4);
      else if (words.some((w) => w.startsWith(q))) best = Math.min(best, 5);
      else if (!mapped.length && ic.text.includes(q)) best = Math.min(best, 6);
      return best;
    };
    const found = icons
      .map((ic) => [score(ic), ic])
      .filter(([sc]) => sc < 99)
      .sort((a, b) => a[0] - b[0] || a[1].name.length - b[1].name.length)
      .slice(0, 40)
      .map(([, ic]) => ic);
    picker.hidden = false;
    picker.innerHTML = found.length
      ? found.map((ic) => `<button type="button" data-act="pick-icon" data-icon="${ic.name}" title="${ic.name}"><ha-icon icon="mdi:${ic.name}"></ha-icon><span>${ic.name}</span></button>`).join("")
      : `<div class="none">Kein Icon gefunden – versuch's mal auf Englisch (z. B. „dog“, „fish“) 🔎</div>`;
  }

  _iconField(value, attrs = "") {
    return `<input class="icon" value="${esc(stripMdi(value))}" placeholder="Icon" title="Icon-Name, z. B. dog – Vorschläge erscheinen beim Tippen" ${attrs}>`;
  }

  // ---------------------------------------------------------------- Einstellungen
  _renderSettings() {
    const d = this._data;
    const s = d.settings;
    const row = (kind, e, i, len) => `
      <div class="srow" data-kind="${kind}" data-id="${e.id}">
        ${kind === "stores"
          ? `<input type="color" value="${esc(e.color || "#607d8b")}" data-field="color" title="Farbe">`
          : kind === "categories"
            ? `<input type="color" value="${esc(e.color || "#9e9e9e")}" data-field="color" title="Farbe">`
            : `<ha-icon class="prev" icon="${esc(kind === "persons" ? "mdi:account-outline" : e.icon || "mdi:tag-outline")}"></ha-icon>`}
        <input class="grow" value="${esc(e.name)}" data-field="name">
        ${kind === "categories" ? this._iconField(e.icon, 'data-field="icon"') : ""}
        <button class="iconbtn" data-act="up" ${i === 0 ? "disabled" : ""} title="Nach oben"><ha-icon icon="mdi:chevron-up"></ha-icon></button>
        <button class="iconbtn" data-act="down" ${i === len - 1 ? "disabled" : ""} title="Nach unten"><ha-icon icon="mdi:chevron-down"></ha-icon></button>
        <button class="iconbtn" data-act="group-remove" title="Löschen"><ha-icon icon="mdi:trash-can-outline"></ha-icon></button>
      </div>
      ${kind === "categories" ? `<div class="picker" hidden></div>` : ""}
      ${kind === "stores" && zones.length ? `
      <div class="srow zonerow" data-kind="stores" data-id="${e.id}">
        <ha-icon class="prev" icon="mdi:map-marker-outline"></ha-icon>
        <select class="grow" data-field="zone" title="Zone für „Nächstes Geschäft“">
          <option value="">📍 Keine Zone</option>
          ${zones.map((z) => `<option value="${z.id}" ${z.id === e.zone ? "selected" : ""}>📍 ${esc(z.name)}</option>`).join("")}
        </select>
      </div>` : ""}`;
    const zones = Object.values(this._hass.states)
      .filter((st) => st.entity_id.startsWith("zone.") && st.entity_id !== "zone.home")
      .map((st) => ({ id: st.entity_id, name: st.attributes.friendly_name || st.entity_id }))
      .sort((a, b) => a.name.localeCompare(b.name, "de"));
    this.$("otherView").innerHTML = `
      <div class="sec">
        <h3><ha-icon icon="mdi:store-outline"></ha-icon>Geschäfte</h3>
        ${d.stores.map((e, i) => row("stores", e, i, d.stores.length)).join("")}
        <form class="srow" data-addkind="stores">
          <input type="color" value="#607d8b" name="color" title="Farbe">
          <input class="grow" name="name" placeholder="Neues Geschäft, z. B. Kaufland">
          <button class="primary" type="submit" title="Hinzufügen"><ha-icon icon="mdi:plus"></ha-icon></button>
        </form>
        <p class="hint">📍 Hat ein Geschäft eine <b>Zone</b>, springt die Liste automatisch auf dieses Geschäft, sobald du dort bist. Zonen legst du unter Einstellungen → Bereiche & Zonen an.</p>
      </div>
      <div class="sec">
        <h3><ha-icon icon="mdi:shape-outline"></ha-icon>Kategorien</h3>
        ${d.categories.map((e, i) => row("categories", e, i, d.categories.length)).join("")}
        <form class="srow" data-addkind="categories">
          <ha-icon class="prev" icon="mdi:tag-plus-outline"></ha-icon>
          <input class="grow" name="name" placeholder="Neue Kategorie">
          ${this._iconField("", 'name="icon" data-newicon="1"')}
          <button class="primary" type="submit" title="Hinzufügen"><ha-icon icon="mdi:plus"></ha-icon></button>
        </form>
        <div class="picker" hidden></div>
        <p class="hint">Icon: einfach den Namen tippen (z. B. <b>hund</b>, <b>dog</b> oder <b>fish</b>) und aus der Vorschau antippen.</p>
      </div>
      <div class="sec">
        <h3><ha-icon icon="mdi:chef-hat"></ha-icon>Rezepte</h3>
        ${(d.recipes || []).map((r) => `
          <div class="recipe" data-id="${r.id}">
            <ha-icon icon="${esc(r.icon || "mdi:silverware-fork-knife")}"></ha-icon>
            <div class="rname"><b>${esc(r.name)}</b><small>${r.items.length} Zutaten</small></div>
            <button class="iconbtn" data-act="recipe-edit" title="Bearbeiten"><ha-icon icon="mdi:pencil-outline"></ha-icon></button>
          </div>`).join("")}
        <div class="btnrow"><button class="btn" data-act="recipe-new"><ha-icon icon="mdi:plus"></ha-icon>Neues Rezept</button></div>
      </div>
      <div class="sec">
        <h3><ha-icon icon="mdi:account-group-outline"></ha-icon>Personen (für „Für wen?“)</h3>
        ${(d.persons || []).map((e, i) => row("persons", e, i, d.persons.length)).join("")}
        <form class="srow" data-addkind="persons">
          <ha-icon class="prev" icon="mdi:account-plus-outline"></ha-icon>
          <input class="grow" name="name" placeholder="Neue Person, z. B. Oma">
          <button class="primary" type="submit" title="Hinzufügen"><ha-icon icon="mdi:plus"></ha-icon></button>
        </form>
        ${(d.persons || []).length ? "" : `<p class="hint">Noch keine Personen – solange bleibt das Feld „Für wen?“ ausgeblendet.</p>`}
      </div>
      <div class="sec">
        <h3><ha-icon icon="mdi:delete-outline"></ha-icon>Artikel ganz löschen</h3>
        <p class="hint">Hier verschwinden Artikel endgültig, auch aus „Erledigt“ und samt Foto.</p>
        <div class="srow"><ha-icon class="prev" icon="mdi:magnify"></ha-icon><input class="grow" id="delSearch" placeholder="Artikel suchen …" value="${esc(this._delFilter || "")}"></div>
        <div id="delList"></div>
      </div>
      <div class="sec">
        <h3><ha-icon icon="mdi:broom"></ha-icon>Aufräumen</h3>
        <p>Jeden <b>${WD_LONG[s.cleanup_weekday]}</b> um <b>${s.cleanup_time} Uhr</b> werden alle offenen Artikel <b>abgehakt</b>, die mindestens <b>${s.min_age_days} Tage</b> auf der Liste stehen. Gelöscht wird nichts – so kannst du sie später mit einem Tipp wieder auf die Liste nehmen.</p>
        <p class="hint">Tag & Uhrzeit ändern: Einstellungen → Geräte & Dienste → Einkaufsliste → Konfigurieren</p>
        <div class="btnrow">
          <button class="btn" data-act="cleanup-now"><ha-icon icon="mdi:broom"></ha-icon>Jetzt aufräumen</button>
          <button class="btn" data-act="check-all"><ha-icon icon="mdi:checkbox-multiple-marked-circle-outline"></ha-icon>Alles abhaken</button>
        </div>
      </div>
      <p class="hint" style="text-align:right">Einkaufsliste v${EL_VERSION}</p>`;
    this._renderDelList();
  }

  _renderDelList() {
    const box = this.$("delList");
    if (!box || !this._data) return;
    const q = (this._delFilter || "").trim().toLowerCase();
    const items = this._data.items
      .filter((i) => !q || i.name.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name, "de"));
    if (!items.length) {
      box.innerHTML = `<p class="hint">${q ? `Nichts gefunden zu „${esc(q)}“.` : "Die Liste ist leer."}</p>`;
      return;
    }
    const shown = items.slice(0, 60);
    box.innerHTML = shown.map((i) => {
      const st = this._store(i.store_id);
      const info = [st ? st.name : "Egal wo", i.checked ? "erledigt" : "offen", i.note, i.for_whom && `für ${i.for_whom}`]
        .filter(Boolean).map(esc).join(" · ");
      return `<div class="srow delrow" data-id="${i.id}">
        <div class="grow delname"><b>${esc(i.name)}</b><small>${info}</small></div>
        <button class="iconbtn" data-act="item-delete" title="Ganz löschen"><ha-icon icon="mdi:trash-can-outline"></ha-icon></button>
      </div>`;
    }).join("") + (items.length > shown.length ? `<p class="hint">… und ${items.length - shown.length} weitere – tipp oben was ein, um zu suchen.</p>` : "");
  }

  // ---------------------------------------------------------------- Rezepte
  _renderRecipes() {
    const recipes = this._data.recipes || [];
    const html = [`<div class="sec"><h3><ha-icon icon="mdi:chef-hat"></ha-icon>Rezepte</h3>`];
    if (!recipes.length) {
      html.push(`<div class="empty"><ha-icon icon="mdi:pot-steam-outline"></ha-icon>Noch keine Rezepte. 🐟<br>Anlegen und bearbeiten kannst du sie über das ⚙️-Zahnrad.</div>`);
    }
    for (const r of recipes) {
      const names = r.items.map((i) => i.name + (i.for_whom ? ` (für ${i.for_whom})` : "")).join(", ");
      html.push(`
        <div class="recipe" data-id="${r.id}">
          <ha-icon icon="${esc(r.icon || "mdi:silverware-fork-knife")}"></ha-icon>
          <div class="rname"><b>${esc(r.name)}</b><small>${r.items.length} Zutaten · ${esc(names)}</small></div>
          <button class="primary" data-act="recipe-apply" title="Zutaten auswählen"><ha-icon icon="mdi:cart-plus"></ha-icon>Auf die Liste</button>
        </div>${this._pickRecipe === r.id ? this._pickHtml(r) : ""}`);
    }
    html.push(`</div>`);
    this.$("otherView").innerHTML = html.join("");
  }

  // 🍳 Erst fragen: Welche Zutaten sollen auf die Liste?
  _pickHtml(r) {
    const open = new Set(this._data.items.filter((i) => !i.checked).map((i) => i.name.toLowerCase()));
    const sel = this._pickSel;
    const rows = r.items.map((it, n) => {
      const on = sel.has(n);
      const info = [it.quantity, it.note, it.for_whom ? "für " + it.for_whom : ""].filter(Boolean).map(esc).join(" · ");
      return `<div class="pickrow ${on ? "on" : ""}" data-act="pick-toggle" data-n="${n}">
        <ha-icon icon="${on ? "mdi:checkbox-marked" : "mdi:checkbox-blank-outline"}"></ha-icon>
        <span class="pname">${esc(it.name)}${info ? `<small>${info}</small>` : ""}</span>
        ${open.has(it.name.toLowerCase()) ? `<span class="phint">steht schon drauf</span>` : ""}
      </div>`;
    }).join("");
    return `<div class="rpick" data-id="${r.id}">
      <div class="phead">Was davon brauchst du?<span>
        <button class="linkbtn" data-act="pick-all">Alle</button> · <button class="linkbtn" data-act="pick-none">Keine</button></span></div>
      ${rows}
      <div class="pbtns">
        <button class="btn" data-act="pick-cancel">Abbrechen</button>
        <button class="primary addbtn" data-act="pick-go" ${sel.size ? "" : "disabled"}><ha-icon icon="mdi:check-bold"></ha-icon>${sel.size} auf die Liste</button>
      </div>
    </div>`;
  }

  _openRecipe(recipe) {
    this._draft = recipe
      ? { id: recipe.id, name: recipe.name, icon: recipe.icon, items: recipe.items.map((i) => ({ ...i })) }
      : { id: null, name: "", icon: "mdi:silverware-fork-knife", items: [{ name: "" }] };
    this._view = "recipe";
    this._draftRendered = false;
    this._renderAll();
  }

  _renderRecipeEditor() {
    const d = this._data;
    const dr = this._draft;
    this._draftRendered = true;
    const rows = dr.items.map((it, n) => `
      <div class="ritem" data-n="${n}">
        <input data-rf="name" value="${esc(it.name || "")}" list="hist" placeholder="Zutat, z. B. Fischstäbchen">
        <input data-rf="quantity" value="${esc(it.quantity || "")}" placeholder="Menge">
        <button class="iconbtn ${this._hasPhoto(it.name) ? "on" : ""}" type="button" data-act="ritem-photo" title="Foto"><ha-icon icon="${this._hasPhoto(it.name) ? "mdi:camera" : "mdi:camera-plus-outline"}"></ha-icon></button>
        <button class="iconbtn" type="button" data-act="ritem-remove" title="Zutat entfernen"><ha-icon icon="mdi:trash-can-outline"></ha-icon></button>
        <div class="two">
          <input data-rf="note" value="${esc(it.note || "")}" placeholder="📝 Notiz">
          <select data-rf="for_whom">${this._personOptions(it.for_whom)}</select>
          <select data-rf="store_id">${this._selectOptions(d.stores, it.store_id, "🛒 Wie zuletzt")}</select>
          <select data-rf="category_id">${this._selectOptions(d.categories, it.category_id, "📦 Wie zuletzt")}</select>
        </div>
      </div>`).join("");
    this.$("otherView").innerHTML = `
      <div class="sec">
        <h3><ha-icon icon="mdi:chef-hat"></ha-icon>${dr.id ? "Rezept bearbeiten" : "Neues Rezept"}</h3>
        <div class="srow recipehead">
          <ha-icon class="prev" id="rIconPrev" icon="${esc(dr.icon)}"></ha-icon>
          <input class="grow" id="rName" value="${esc(dr.name)}" placeholder="Name, z. B. Freitags Fisch">
          ${this._iconField(dr.icon, 'id="rIcon"')}
        </div>
        <div class="picker" hidden></div>
        <div id="rItems">${rows}</div>
        <div class="btnrow"><button class="btn" data-act="ritem-add"><ha-icon icon="mdi:plus"></ha-icon>Zutat hinzufügen</button></div>
        <p class="hint">„Wie zuletzt“ = Geschäft & Kategorie, die bei diesem Produkt zuletzt benutzt wurden.</p>
        <div class="btnrow" style="justify-content:space-between">
          ${dr.id ? `<button class="btn danger" data-act="recipe-delete"><ha-icon icon="mdi:trash-can-outline"></ha-icon>Löschen</button>` : "<span></span>"}
          <span style="display:flex;gap:6px">
            <button class="btn" data-act="recipe-cancel">Abbrechen</button>
            <button class="btn primary" data-act="recipe-save"><ha-icon icon="mdi:content-save-outline"></ha-icon>Speichern</button>
          </span>
        </div>
      </div>`;
  }

  _readDraft() {
    const dr = this._draft;
    dr.name = this.$("rName").value;
    dr.icon = this.$("rIcon").value;
    dr.items = [...this.shadowRoot.querySelectorAll(".ritem")].map((row) => {
      const o = {};
      row.querySelectorAll("[data-rf]").forEach((el) => { o[el.dataset.rf] = el.value.trim() || null; });
      return o;
    });
  }

  async _saveRecipe() {
    this._readDraft();
    const dr = this._draft;
    const items = dr.items.filter((i) => i.name);
    const msg = { name: dr.name.trim(), icon: dr.icon || null, items };
    if (!msg.name) { this.$("rName").classList.add("shake"); return; }
    try {
      if (dr.id) await this._ws({ type: "einkaufsliste/recipe/update", recipe_id: dr.id, ...msg });
      else await this._ws({ type: "einkaufsliste/recipe/add", ...msg });
      this._toast(`Rezept „${msg.name}“ gespeichert 👨‍🍳`);
      this._draft = null;
      this._view = "settings";
      this._renderAll();
    } catch (_) { /* Meldung kam schon */ }
  }

  // ---------------------------------------------------------------- Fotos
  // ✨ Neu seit deinem letzten Blick
  _mySeen() {
    const uid = this._hass?.user?.id;
    return (uid && this._data?.seen?.[uid]) || null;
  }

  _isNewFor(item, seen) {
    if (!seen || item.checked) return false;
    const me = this._hass?.user;
    if (item.added_by_id ? item.added_by_id === me?.id : item.added_by && item.added_by === this._myName()) return false;
    const t = seen[item.store_id || "none"] || seen.all;
    return !!t && item.added_at > t;
  }

  _isNew(item) {
    return this._isNewFor(item, this._seenSnap || this._mySeen());
  }

  _myName() {
    const uid = this._hass?.user?.id;
    const person = Object.values(this._hass?.states || {}).find((st) => st.entity_id?.startsWith("person.") && st.attributes.user_id === uid);
    return person?.attributes.friendly_name || this._hass?.user?.name;
  }

  _newCount(fn) {
    const seen = this._mySeen();
    return this._data.items.filter((i) => fn(i) && this._isNewFor(i, seen)).length;
  }

  _markSeen() {
    if (!this._data || this._view !== "list" || !this.isConnected) return;
    const uid = this._hass?.user?.id;
    if (!uid) return;
    const tab = this._activeTab;
    const seen = this._mySeen();
    if (!seen) {
      // erstes Mal: alles bisherige gilt als gesehen
      if (!this._seenInit) { this._seenInit = true; this._ws({ type: "einkaufsliste/seen", store: "all" }).catch(() => {}); }
      return;
    }
    const fn = tab === "all" ? () => true : tab === "none" ? (i) => !i.store_id : (i) => i.store_id === tab;
    if (this._newCount(fn) && this._seenSending !== tab) {
      this._seenSending = tab;
      this._ws({ type: "einkaufsliste/seen", store: tab }).catch(() => {}).finally(() => { this._seenSending = null; });
    }
  }

  _hasPhoto(name) {
    return !!(name && this._data?.photos && this._data.photos[String(name).toLowerCase()]);
  }

  _pickFile(id) {
    this.$(id).value = "";
    this.$(id).click();
  }

  _takePhoto(name, button) {
    this._photoTarget = { name, button };
    this._pickFile("photoFile");
  }

  async _onNewPhotoFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      this._newPhoto = await shrinkImage(file, 900, 0.8);
      this._updateNewPhotoBtn();
      this._toast("📸 Foto gemerkt – kommt beim Hinzufügen mit");
    } catch (_) {
      this._toast("Das Foto konnte nicht gelesen werden 🙈");
    }
  }

  // Symbol-Leiste: ein Tipp öffnet/schließt genau ein Feld
  _toggleTool(boxId) {
    const box = this.$(boxId);
    const open = box.hidden;
    // immer nur ein Feld offen – spart Platz
    for (const id of ["qtyBox", "inNote", "forBox"]) if (id !== boxId) this.$(id).hidden = true;
    box.hidden = !open;
    if (open) {
      if (boxId === "qtyBox") this._renderQtyChips();
      if (boxId === "forBox") this._renderForChips();
      if (boxId === "inNote") box.focus();
    }
    this._updateTools();
  }

  _clearForm() {
    for (const id of ["inName", "inQty", "inNote", "inFor", "inCat"]) this.$(id).value = "";
    this._renderSuggest();
    for (const id of ["qtyBox", "inQty", "inNote", "forBox"]) this.$(id).hidden = true;
    const tab = this._activeTab;
    this.$("inStore").value = tab !== "all" && tab !== "none" ? tab : "";
    this._newPhoto = null;
    this._pendingBarcode = null;
    this._catManual = false;
    this._updateNewPhotoBtn();
    this._updateTools();
    this._renderList();
  }

  _renderQtyChips() {
    const val = this.$("inQty").value.trim();
    const quick = ["1x", "2x", "3x", "4x", "6x", "10x"];
    const custom = val && !quick.includes(val);
    this.$("qtyChips").innerHTML =
      quick.map((q) => `<button type="button" class="chip2 ${q === val ? "sel" : ""}" data-act="qty-chip" data-v="${q}">${q}</button>`).join("") +
      `<button type="button" class="chip2 ${custom ? "sel" : ""}" data-act="qty-custom" title="Andere Menge">✏️${custom ? " " + esc(val) : ""}</button>`;
    this.$("inQty").hidden = !custom && this.$("inQty").hidden;
  }

  _renderForChips() {
    const val = this.$("inFor").value;
    this.$("forChips").innerHTML = (this._data?.persons || [])
      .map((p) => `<button type="button" class="chip2 ${p.name === val ? "sel" : ""}" data-act="for-chip" data-v="${esc(p.name)}">👤 ${esc(p.name)}</button>`)
      .join("");
  }

  _updateTools() {
    const clear = this.$("tClear");
    if (clear) {
      const any = ["inName", "inQty", "inNote", "inFor"].some((id) => this.$(id)?.value.trim())
        || this._newPhoto || this._pendingBarcode || this._catManual;
      clear.hidden = !any;
    }
    const tools = [
      ["tQty", "qtyBox", this.$("inQty")?.value.trim(), "mdi:numeric"],
      ["tNote", "inNote", this.$("inNote")?.value.trim() ? "✓" : "", "mdi:note-text-outline"],
      ["tFor", "forBox", this.$("inFor")?.value, "mdi:account-outline"],
    ];
    for (const [tool, boxId, value, icon] of tools) {
      const btn = this.$(tool);
      const box = this.$(boxId);
      if (!btn || !box) continue;
      btn.classList.toggle("on", !box.hidden);
      btn.classList.toggle("filled", !!value && tool === "tNote");
      const label = tool === "tNote" ? "" : value || "";
      btn.classList.toggle("hasval", !!label);
      const key = icon + "|" + label;
      if (btn._key !== key) {
        btn._key = key;
        btn.innerHTML = `<ha-icon icon="${icon}"></ha-icon>${label ? `<span class="tval">${esc(label)}</span>` : ""}`;
      }
    }
  }

  _updateNewPhotoBtn() {
    const btn = this.$("btnNewPhoto");
    btn.classList.toggle("on", !!this._newPhoto);
    btn.classList.toggle("filled", !!this._newPhoto);
    this._updateTools();
    btn.title = this._newPhoto ? "Foto ist dabei – antippen zum Entfernen" : "Foto zum Artikel";
    btn.querySelector("ha-icon").setAttribute("icon", this._newPhoto ? "mdi:camera" : "mdi:camera-plus-outline");
  }

  async _onPhotoFile(e) {
    const file = e.target.files?.[0];
    const target = this._photoTarget;
    if (!file || !target) return;
    let data;
    try {
      data = await shrinkImage(file, 900, 0.8);
    } catch (_) {
      this._toast("Das Foto konnte nicht gelesen werden 🙈");
      return;
    }
    this._savePhoto(target, data);
  }

  async _savePhoto(target, data) {
    try {
      this._toast("📸 Foto wird gespeichert …");
      await this._ws({ type: "einkaufsliste/photo/set", name: target.name, data });
      this._photoCache.delete(target.name.toLowerCase());
      this._toast(`📸 Foto für „${target.name}“ gespeichert`);
      if (target.button) {
        target.button.classList.add("on");
        target.button.querySelector("ha-icon")?.setAttribute("icon", "mdi:camera");
      } else {
        this._editing = null;
        this._renderList();
      }
    } catch (_) { /* Meldung kam schon */ }
  }

  async _openPhoto(name) {
    const key = String(name).toLowerCase();
    const updated = this._data?.photos?.[key];
    let cached = this._photoCache.get(key);
    if (!cached || cached.updated !== updated) {
      try {
        const res = await this._ws({ type: "einkaufsliste/photo/get", name });
        cached = { updated, data: res.data };
        this._photoCache.set(key, cached);
      } catch (_) { return; }
    }
    showPhotoOverlay(cached.data, name);
  }

  // ---------------------------------------------------------------- Barcode (Scanner der HA-App)
  // Die Home-Assistant-App bringt einen eigenen Barcode-Scanner mit. Weil die App
  // die Kamera öffnet (nicht der Browser), klappt das auch ohne https.
  _hasAppScanner() {
    return Boolean(this._hass?.auth?.external?.config?.hasBarCodeScanner);
  }

  _listenToApp() {
    const ext = this._hass.auth.external;
    if (ext.__einkaufslisteTap) return;
    const original = ext.receiveMessage.bind(ext);
    ext.receiveMessage = (msg) => {
      try {
        if (msg?.type === "command" && String(msg.command).startsWith("bar_code/")) {
          window.dispatchEvent(new CustomEvent("einkaufsliste-barcode", { detail: msg }));
        }
      } catch (_) { /* nie die App stören */ }
      return original(msg);
    };
    ext.__einkaufslisteTap = true;
  }

  /**
   * Scanner der HA-App öffnen.
   * series = true: Scanner bleibt offen, jeder Treffer ruft onCode auf (mit Meldung im Scanner).
   * onAlt: was beim Zusatz-Knopf passiert (z. B. „Mehrere scannen“ oder „Fertig“).
   */
  _appScan({ title, description, altLabel, series = false, onCode, onAlt, onEnd }) {
    const ext = this._hass?.auth?.external;
    if (!ext) return;
    this._listenToApp();
    let last = { code: null, at: 0 };
    const done = () => window.removeEventListener("einkaufsliste-barcode", onMsg);
    const close = () => ext.fireMessage({ type: "bar_code/close" });
    const onMsg = async (ev) => {
      const msg = ev.detail;
      if (msg.command === "bar_code/scan_result") {
        const code = msg.payload?.rawValue;
        if (!code) return;
        if (!series) { done(); close(); onCode(code); return; }
        // gleiche Packung doppelt erkannt? kurz ignorieren
        if (code === last.code && Date.now() - last.at < 2500) return;
        last = { code, at: Date.now() };
        const note = await onCode(code);
        if (note) ext.fireMessage({ type: "bar_code/notify", payload: { message: note } });
        navigator.vibrate?.(60);
      } else if (msg.command === "bar_code/aborted") {
        done();
        close();
        if (msg.payload?.reason === "alternative_options" && onAlt) onAlt();
        else onEnd?.();
      }
    };
    window.addEventListener("einkaufsliste-barcode", onMsg);
    ext.fireMessage({
      type: "bar_code/scan",
      payload: { title, description: description || "Halte den Strichcode der Packung in den Rahmen.", alternative_option_label: altLabel },
    });
  }

  // Alter Name bleibt für „Barcode zuordnen“
  _startAppScan(onCode = (code) => this._handleCode(code), title = "🛒 Barcode scannen") {
    this._appScan({ title, altLabel: "Abbrechen", onCode });
  }

  // ▥ antippen: im Laden = abhaken, zu Hause = eintragen
  _scanButton() {
    const near = this._lastNear && this._store(this._lastNear);
    if (near) return this._scanCheckOff(near);
    this._appScan({
      title: "🛒 Barcode scannen",
      altLabel: "📦 Mehrere scannen",
      onCode: (code) => this._handleCode(code),
      onAlt: () => this._scanSeries(),
    });
  }

  async _lookup(code) {
    try {
      return await this._hass.callWS({ type: "einkaufsliste/barcode/lookup", code });
    } catch (_) {
      return { code, found: false };
    }
  }

  // 📦 Serien-Scan am Kühlschrank: jede Packung kommt direkt auf die Liste
  _scanSeries() {
    const stats = { added: 0, unknown: 0 };
    const tab = this._activeTab;
    const defaultStore = tab !== "all" && tab !== "none" ? tab : null;
    this._appScan({
      title: "📦 Mehrere scannen",
      description: "Eine Packung nach der anderen in den Rahmen halten.",
      altLabel: "✔ Fertig",
      series: true,
      onCode: async (code) => {
        const res = await this._lookup(code);
        let name = res.found ? res.name : null;
        if (!name) {
          name = `❓ Unbekannt ${String(res.code || code).slice(-4)}`;
          stats.unknown++;
        }
        const guess = res.category_id || guessCategory(name, this._data?.category_hints);
        try {
          await this._hass.callWS({
            type: "einkaufsliste/item/add",
            name,
            store_id: (res.store_id && this._store(res.store_id) ? res.store_id : defaultStore) || null,
            category_id: guess && this._cat(guess) ? guess : null,
            barcode: res.code || code,
          });
          stats.added++;
          return res.found ? `✅ ${name} ist drauf` : `❓ Unbekannt – später umbenennen`;
        } catch (err) {
          return `⚠️ ${err?.message || "Hat nicht geklappt"}`;
        }
      },
      onAlt: () => this._seriesDone(stats),
      onEnd: () => this._seriesDone(stats),
    });
  }

  _seriesDone(stats) {
    if (!stats.added) return;
    this._toast(`📦 ${stats.added} Artikel eingetragen${stats.unknown ? ` – ${stats.unknown}× ❓ bitte noch umbenennen` : ""}`);
  }

  // ✅ Im Laden: gescannte Packung wird auf der Liste abgehakt
  _scanCheckOff(store) {
    const stats = { checked: 0 };
    this._appScan({
      title: `✅ Scannen & abhaken · ${store.name}`,
      description: "Packung scannen, bevor sie in den Wagen kommt.",
      altLabel: "✔ Fertig",
      series: true,
      onCode: async (code) => {
        const res = await this._lookup(code);
        if (!res.found) return "🤔 Diesen Barcode kenne ich noch nicht";
        const open = this._data.items.filter((i) => !i.checked && i.name.toLowerCase() === res.name.toLowerCase());
        const item = open.find((i) => i.store_id === store.id) || open[0];
        if (!item) return `ℹ️ ${res.name} steht nicht auf der Liste`;
        try {
          await this._hass.callWS({ type: "einkaufsliste/item/toggle", item_id: item.id, checked: true });
          stats.checked++;
          return `✅ ${item.name} abgehakt`;
        } catch (err) {
          return `⚠️ ${err?.message || "Hat nicht geklappt"}`;
        }
      },
      onAlt: () => stats.checked && this._toast(`✅ ${stats.checked} Artikel per Scan abgehakt`),
      onEnd: () => stats.checked && this._toast(`✅ ${stats.checked} Artikel per Scan abgehakt`),
    });
  }

  async _handleCode(code) {
    const btn = this.$("btnScan");
    btn.classList.add("busy");
    try {
      const res = await this._ws({ type: "einkaufsliste/barcode/lookup", code });
      this._pendingBarcode = res.code;
      const nameEl = this.$("inName");
      if (res.found) {
        nameEl.value = res.name;
        this._catManual = false;
        if (res.category_id && this._cat(res.category_id)) this.$("inCat").value = res.category_id;
        else this._onNameInput();
        if (res.store_id && !this._fixedStore && this._activeTab === "all" && this._store(res.store_id)) this.$("inStore").value = res.store_id;
        this._toast(res.source === "gemerkt"
          ? `🔍 Kenn ich: „${res.name}“ – tippe ✅ zum Hinzufügen`
          : `🔍 Gefunden: „${res.name}“ – Name passt? Dann ✅ tippen`);
      } else {
        nameEl.value = "";
        this._toast(`🤔 Diesen Barcode kenne ich noch nicht – tipp den Namen ein, ich merk ihn mir!`);
      }
      nameEl.focus();
      this._renderSuggest();
      this._updateTools();
      this._renderList();
    } catch (_) { /* Meldung kam schon */ } finally {
      btn.classList.remove("busy");
    }
  }

  // ---------------------------------------------------------------- Aktionen
  _onNameInput() {
    const val = this.$("inName").value.trim().toLowerCase();
    const h = this._data?.history.find((x) => x.name.toLowerCase() === val);
    if (!h) {
      // 📖 Unbekanntes Produkt: Kategorie aus dem Wörterbuch raten (nur wenn du nicht selbst gewählt hast)
      if (this._catManual) return;
      const guess = guessCategory(val, this._data?.category_hints);
      this.$("inCat").value = guess && this._cat(guess) ? guess : "";
      return;
    }
    if (h.category_id && this._cat(h.category_id)) this.$("inCat").value = h.category_id;
    if (!this._fixedStore && this._activeTab === "all" && h.store_id && this._store(h.store_id)) this.$("inStore").value = h.store_id;
  }

  _onInput(e) {
    const t = e.target;
    if (t.id === "delSearch") {
      this._delFilter = t.value;
      this._renderDelList();
      return;
    }
    if (t.classList?.contains("icon")) {
      const prev = t.closest(".srow")?.querySelector(".prev");
      const val = stripMdi(t.value).trim();
      if (prev && val) prev.setAttribute("icon", `mdi:${val}`);
      this._showPicker(t);
    }
  }

  async _onAdd(e) {
    e.preventDefault();
    const name = this.$("inName").value.trim();
    if (!name) {
      const el = this.$("inName");
      el.classList.remove("shake"); void el.offsetWidth; el.classList.add("shake");
      return;
    }
    const msg = {
      type: "einkaufsliste/item/add",
      name,
      store_id: this._fixedStore || this.$("inStore").value || null,
      category_id: this.$("inCat").value || null,
    };
    for (const [key, id] of [["quantity", "inQty"], ["note", "inNote"], ["for_whom", "inFor"]]) {
      const v = this.$(id).value.trim();
      if (v) msg[key] = v;
    }
    if (this._pendingBarcode) msg.barcode = this._pendingBarcode;
    try {
      const item = await this._ws(msg);
      if (this._newPhoto) {
        const data = this._newPhoto;
        this._newPhoto = null;
        this._updateNewPhotoBtn();
        await this._savePhoto({ name: item?.name || name, button: this.$("btnNewPhoto"), quiet: true }, data);
        this._updateNewPhotoBtn();
      }
      for (const id of ["inName", "inQty", "inNote", "inFor", "inCat"]) this.$(id).value = "";
      this._catManual = false;
      this._pendingBarcode = null;
      for (const id of ["qtyBox", "inQty", "inNote", "forBox"]) this.$(id).hidden = true;
      this._updateTools();
      this._renderSuggest();
      this._renderList();
      this.$("inName").focus();
    } catch (_) { /* Meldung kam schon */ }
  }

  _onClick(e) {
    if (this._dragged) { e.stopPropagation(); e.preventDefault(); return; } // war nur Ziehen
    const el = e.target.closest("[data-act]");
    if (!el) return;
    const act = el.dataset.act;
    const itemEl = el.closest(".item");
    const id = itemEl?.dataset.id;
    const srow = el.closest(".srow");

    switch (act) {
      case "shopmode":
        this._shopMode = !this._shopMode;
        try { localStorage.setItem("einkaufsliste_shopmode", this._shopMode ? "1" : "0"); } catch (_) { /* egal */ }
        this._menuId = null;
        this._toast(this._shopMode ? "🛒 Laden-Modus an – viel Spaß beim Einkaufen!" : "✍️ Laden-Modus aus");
        this._renderAll();
        break;
      case "dup-merge": {
        const bar = el.closest(".dupbar");
        this._mergeDuplicate(bar.dataset.a, bar.dataset.b);
        break;
      }
      case "dup-ignore": {
        const bar = el.closest(".dupbar");
        this._dupIgnore.add([bar.dataset.a, bar.dataset.b].sort().join("+"));
        try { localStorage.setItem("einkaufsliste_dup_ignore", JSON.stringify([...this._dupIgnore].slice(-200))); } catch (_) { /* egal */ }
        this._renderList();
        break;
      }
      case "view": {
        const v = el.dataset.view;
        const current = this._view === "recipe" ? "settings" : this._view;
        this._view = current === v ? "list" : v;
        this._draft = null;
        this._renderAll();
        break;
      }
      case "tab":
        this._tab = el.dataset.tab;
        this._seenSnap = { ...(this._mySeen() || {}) };
        this._renderAll();
        break;
      case "toggle":
        if (!id || this._pending.has(id)) return;
        this._pending.add(id);
        itemEl.classList.add("pending");
        this._ws({ type: "einkaufsliste/item/toggle", item_id: id })
          .catch(() => {})
          .finally(() => { this._pending.delete(id); this._renderAll(); });
        break;
      case "item-delete": {
        const itemId = el.closest(".delrow").dataset.id;
        const item = this._data.items.find((i) => i.id === itemId);
        if (!item || !confirm(`„${item.name}“ endgültig löschen? Dann ist es auch aus „Erledigt“ weg.`)) return;
        this._ws({ type: "einkaufsliste/item/remove", item_id: itemId })
          .then(() => { this._toast(`🗑️ „${item.name}“ gelöscht`); setTimeout(() => this._renderDelList(), 50); })
          .catch(() => {});
        break;
      }
      case "edit":
        this._editing = id;
        this._renderList();
        break;
      case "scan":
        this._scanButton();
        break;
      case "tool":
        this._toggleTool(el.dataset.field);
        break;
      case "clear-form":
        this._clearForm();
        this._toast("🧽 Alles geleert");
        this.$("inName").focus();
        break;
      case "qty-chip": {
        const q = this.$("inQty");
        q.value = q.value === el.dataset.v ? "" : el.dataset.v;
        q.hidden = true;
        this.$("qtyBox").hidden = true;
        this._updateTools();
        break;
      }
      case "qty-custom": {
        const q = this.$("inQty");
        q.hidden = false;
        q.focus();
        break;
      }
      case "for-chip": {
        const f = this.$("inFor");
        f.value = f.value === el.dataset.v ? "" : el.dataset.v;
        this.$("forBox").hidden = true;
        this._updateTools();
        break;
      }
      case "barcode-assign": {
        const item = this._data.items.find((i) => i.id === el.dataset.id);
        this._menuId = null;
        this._startAppScan((code) => {
          this._ws({ type: "einkaufsliste/barcode/assign", item_id: item.id, code })
            .then(() => this._toast(`▥ Barcode gespeichert – beim nächsten Scan erkenne ich „${item.name}“ sofort!`))
            .catch(() => {});
        }, `▥ Barcode für „${item.name}“`);
        break;
      }
      case "menu-close":
        this._menuId = null;
        this._renderList();
        break;
      case "menu-edit":
        this._menuId = null;
        this._editing = el.dataset.id;
        this._renderList();
        break;
      case "menu-move":
        this._menuId = null;
        this._moving = el.dataset.id;
        this._renderList();
        break;
      case "menu-qty":
        this._menuId = null;
        this._qtyEdit = el.dataset.id;
        this._renderList();
        break;
      case "menu-photo": {
        const item = this._data.items.find((i) => i.id === el.dataset.id);
        this._menuId = null;
        this._renderList();
        this._takePhoto(item.name, null);
        break;
      }
      case "qty-edit": {
        const item = this._data.items.find((i) => i.id === id);
        if (/^\d+\s*(x|stk\.?|stück)?$/i.test(item?.quantity || "")) {
          this._qtyEdit = this._qtyEdit === id ? null : id;
        } else {
          this._editing = id; // z. B. „500 g“ -> normal bearbeiten
        }
        this._renderList();
        break;
      }
      case "qty-minus":
      case "qty-plus": {
        const itemId = el.closest(".qtyrow").dataset.id;
        const item = this._data.items.find((i) => i.id === itemId);
        const m = String(item?.quantity || "").match(/^(\d+)/);
        let n = m ? Number(m[1]) : 1;
        n = act === "qty-plus" ? n + 1 : Math.max(1, n - 1);
        this._ws({ type: "einkaufsliste/item/update", item_id: itemId, quantity: `${n}x` }).catch(() => {});
        break;
      }
      case "qty-done":
        this._qtyEdit = null;
        this._renderList();
        break;
      case "move":
        this._moving = this._moving === id ? null : id;
        this._renderList();
        break;
      case "move-cancel":
        this._moving = null;
        this._renderList();
        break;
      case "move-to": {
        const itemId = el.closest(".moverow").dataset.id;
        const item = this._data.items.find((i) => i.id === itemId);
        const target = this._store(el.dataset.store);
        this._moving = null;
        this._ws({ type: "einkaufsliste/item/update", item_id: itemId, store_id: target.id })
          .then(() => this._toast(`🔁 ${item?.name || "Artikel"} wandert zu ${target.name}`))
          .catch(() => this._renderList());
        break;
      }
      case "new-photo":
        if (this._newPhoto) {
          this._newPhoto = null;
          this._updateNewPhotoBtn();
          this._toast("Foto wieder entfernt");
        } else {
          this._pickFile("newPhotoFile");
        }
        break;
      case "photo-view":
        this._openPhoto(el.dataset.name);
        break;
      case "photo-take":
        this._takePhoto(el.dataset.name, null);
        break;
      case "photo-remove":
        if (!confirm(`Foto von „${el.dataset.name}“ löschen?`)) return;
        this._ws({ type: "einkaufsliste/photo/remove", name: el.dataset.name })
          .then(() => { this._toast("Foto gelöscht 🗑️"); this._editing = null; this._renderList(); }).catch(() => {});
        break;
      case "ritem-photo": {
        const name = el.closest(".ritem").querySelector("[data-rf=name]").value.trim();
        if (!name) { this._toast("Erst den Namen der Zutat eintragen 😉"); return; }
        this._takePhoto(name, el);
        break;
      }
      case "edit-cancel":
        this._editing = null;
        this._renderList();
        break;
      case "toggle-donecat": {
        const key = el.dataset.cat;
        if (this._openDoneCats.has(key)) this._openDoneCats.delete(key);
        else this._openDoneCats.add(key);
        this._renderList();
        break;
      }
      case "suggest": {
        const inp = this.$("inName");
        const c = this._suggMap?.get(el.dataset.n);
        if (!c) break;
        this._applySuggest(c);
        this.$("sugg").hidden = true;
        this._updateTools();
        this._renderList();
        inp.focus();
        break;
      }
      case "toggle-done":
        this._doneOpen = !this._doneOpen;
        this._renderList();
        break;
      case "cleanup-now":
        this._ws({ type: "einkaufsliste/cleanup" })
          .then((r) => this._toast(r.checked ? `${r.checked} alte Artikel abgehakt 🧹` : "Nix zu tun – alles noch frisch! ✨")).catch(() => {});
        break;
      case "check-all":
        if (!confirm("Wirklich ALLE offenen Artikel abhaken?")) return;
        this._ws({ type: "einkaufsliste/cleanup", force: true })
          .then((r) => this._toast(`${r.checked} Artikel abgehakt ✅`)).catch(() => {});
        break;
      case "pick-icon": {
        const picker = el.closest(".picker");
        const input = picker.previousElementSibling?.querySelector("input.icon");
        if (!input) return;
        input.value = el.dataset.icon;
        const prev = input.closest(".srow")?.querySelector(".prev");
        if (prev) prev.setAttribute("icon", `mdi:${el.dataset.icon}`);
        picker.hidden = true;
        if (input.dataset.field) input.dispatchEvent(new Event("change", { bubbles: true }));
        break;
      }
      case "up":
      case "down": {
        const kind = srow.dataset.kind;
        const ids = this._data[kind].map((x) => x.id);
        const pos = ids.indexOf(srow.dataset.id);
        const to = act === "up" ? pos - 1 : pos + 1;
        if (to < 0 || to >= ids.length) return;
        [ids[pos], ids[to]] = [ids[to], ids[pos]];
        this._ws({ type: "einkaufsliste/group/reorder", kind, ids }).then(() => this._renderSettings()).catch(() => {});
        break;
      }
      case "group-remove": {
        const kind = srow.dataset.kind;
        const entry = this._data[kind].find((x) => x.id === srow.dataset.id);
        let txt = `„${entry.name}“ löschen?`;
        if (kind === "persons") {
          txt += " Artikel, die schon für diese Person eingetragen sind, behalten den Namen.";
        } else {
          const field = kind === "stores" ? "store_id" : "category_id";
          const used = this._data.items.filter((i) => i[field] === entry.id).length;
          if (used) txt += ` ${used} Artikel landen dann bei „${kind === "stores" ? "Egal wo" : "Ohne Kategorie"}“.`;
        }
        if (!confirm(txt)) return;
        this._ws({ type: "einkaufsliste/group/remove", kind, group_id: entry.id }).then(() => this._renderSettings()).catch(() => {});
        break;
      }
      case "recipe-new":
        this._openRecipe(null);
        break;
      case "recipe-edit":
        this._openRecipe(this._recipe(el.closest(".recipe").dataset.id));
        break;
      case "recipe-apply": {
        const r = this._recipe(el.closest(".recipe").dataset.id);
        if (this._pickRecipe === r.id) { this._pickRecipe = null; this._renderRecipes(); break; }
        const open = new Set(this._data.items.filter((i) => !i.checked).map((i) => i.name.toLowerCase()));
        this._pickRecipe = r.id;
        this._pickSel = new Set(r.items.map((it, n) => (open.has(it.name.toLowerCase()) ? -1 : n)).filter((n) => n >= 0));
        this._renderRecipes();
        break;
      }
      case "pick-toggle": {
        const n = Number(el.dataset.n);
        if (this._pickSel.has(n)) this._pickSel.delete(n); else this._pickSel.add(n);
        this._renderRecipes();
        break;
      }
      case "pick-all":
      case "pick-none": {
        const r = this._recipe(this._pickRecipe);
        this._pickSel = new Set(act === "pick-all" && r ? r.items.map((_, n) => n) : []);
        this._renderRecipes();
        break;
      }
      case "pick-cancel":
        this._pickRecipe = null;
        this._renderRecipes();
        break;
      case "pick-go": {
        const r = this._recipe(this._pickRecipe);
        if (!r || !this._pickSel.size) break;
        const items = [...this._pickSel].sort((a, b) => a - b);
        this._pickRecipe = null;
        this._ws({ type: "einkaufsliste/recipe/apply", recipe_id: r.id, items })
          .then((res) => {
            this._toast(res.added
              ? `🍽️ ${res.added} Zutaten für „${r.name}“ auf der Liste${res.already ? ` (${res.already} standen schon drauf)` : ""}`
              : `Alles für „${r.name}“ steht schon auf der Liste 👍`);
            this._view = "list";
            this._renderAll();
          }).catch(() => {});
        break;
      }
      case "ritem-add":
        this._readDraft();
        this._draft.items.push({ name: "" });
        this._renderRecipeEditor();
        this.shadowRoot.querySelector(".ritem:last-child input")?.focus();
        break;
      case "ritem-remove":
        this._readDraft();
        this._draft.items.splice(Number(el.closest(".ritem").dataset.n), 1);
        this._renderRecipeEditor();
        break;
      case "recipe-cancel":
        this._draft = null;
        this._view = "settings";
        this._renderAll();
        break;
      case "recipe-save":
        this._saveRecipe();
        break;
      case "recipe-delete": {
        if (!confirm(`Rezept „${this._draft.name}“ wirklich löschen?`)) return;
        this._ws({ type: "einkaufsliste/recipe/remove", recipe_id: this._draft.id })
          .then(() => { this._draft = null; this._view = "settings"; this._renderAll(); }).catch(() => {});
        break;
      }
    }
  }

  _onChange(e) {
    const t = e.target;
    const srow = t.closest(".srow[data-kind]");
    if (!srow || !t.dataset.field) return;
    const msg = { type: "einkaufsliste/group/update", kind: srow.dataset.kind, group_id: srow.dataset.id };
    msg[t.dataset.field] = t.dataset.field === "icon" ? stripMdi(t.value).trim() || null
      : t.dataset.field === "zone" ? (t.value || null) : t.value;
    if (t.dataset.field === "icon" && !msg.icon) return;
    this._ws(msg).catch(() => this._renderSettings());
  }

  _onGroupAdd(e) {
    e.preventDefault();
    const form = e.target;
    const kind = form.dataset.addkind;
    const name = form.elements.name.value.trim();
    if (!name) return;
    const msg = { type: "einkaufsliste/group/add", kind, name };
    if (form.elements.color) msg.color = form.elements.color.value;
    if (form.elements.icon && form.elements.icon.value.trim()) msg.icon = stripMdi(form.elements.icon.value.trim());
    this._ws(msg).then(() => this._renderSettings()).catch(() => {});
  }

  async _saveEdit() {
    const id = this._editing;
    try {
      await this._ws({
        type: "einkaufsliste/item/update",
        item_id: id,
        name: this.$("edName").value,
        quantity: this.$("edQty").value,
        note: this.$("edNote").value,
        for_whom: this.$("edFor").value,
        store_id: this.$("edStore").value || null,
        category_id: this.$("edCat").value || null,
      });
      this._editing = null;
      this._renderAll();
    } catch (_) { /* bleibt im Bearbeiten-Modus */ }
  }
}

// ------------------------------------------------------------------ Editor
const EDITOR_LABELS = {
  title: "Titel",
  show_title: "Titel oben anzeigen",
  store: "Welche Geschäfte zeigen?",
  show_checked: "Erledigte Artikel anzeigen",
  show_added_by: "Name „(X)“ hinter dem Artikel",
  added_by_style: "Name anzeigen als",
  show_dates: "Datum & Aufräum-Tag anzeigen",
  show_recipes: "Rezepte-Knopf anzeigen",
  auto_store: "📍 Automatisch zum Geschäft springen, bei dem ich gerade bin",
  compact: "📱 Kompakt-Modus (kleinere Zeilen, ohne Zusatz-Infos)",
  show_settings: "Zahnrad für Einstellungen anzeigen",
};

class EinkaufslisteCardEditor extends HTMLElement {
  setConfig(config) { this._config = { store: "all", ...config }; this._render(); }
  set hass(hass) {
    this._hass = hass;
    if (!this._stores && !this._loading) {
      this._loading = true;
      hass.callWS({ type: "einkaufsliste/get" })
        .then((d) => { this._stores = d.stores; this._render(); })
        .catch(() => { this._stores = []; this._render(); });
    }
    this._render();
  }
  _schema() {
    const stores = (this._stores || []).map((s) => ({ value: s.id, label: `Nur ${s.name}` }));
    return [
      { name: "show_title", selector: { boolean: {} } },
      { name: "title", selector: { text: {} } },
      { name: "store", selector: { select: { mode: "dropdown", options: [{ value: "all", label: "Alle (mit Reitern oben)" }, ...stores] } } },
      { name: "show_added_by", selector: { boolean: {} } },
      { name: "added_by_style", selector: { select: { mode: "dropdown", options: [
        { value: "name", label: "Ganzer Name (Max Mustermann)" },
        { value: "first", label: "Vorname (Max)" },
        { value: "initials", label: "Kürzel (MM)" },
      ] } } },
      { name: "show_checked", selector: { boolean: {} } },
      { name: "show_dates", selector: { boolean: {} } },
      { name: "show_recipes", selector: { boolean: {} } },
      { name: "auto_store", selector: { boolean: {} } },
      { name: "compact", selector: { boolean: {} } },
      { name: "show_settings", selector: { boolean: {} } },
    ];
  }
  _render() {
    if (!this._hass || !this._config) return;
    if (!this._form) {
      this._form = document.createElement("ha-form");
      this._form.computeLabel = (s) => EDITOR_LABELS[s.name] || s.name;
      this._form.addEventListener("value-changed", (ev) => {
        this._config = ev.detail.value;
        this.dispatchEvent(new CustomEvent("config-changed", { detail: { config: this._config }, bubbles: true, composed: true }));
      });
      this.appendChild(this._form);
    }
    this._form.hass = this._hass;
    this._form.data = {
      title: "Einkaufsliste", show_title: true, show_checked: true, show_added_by: true, added_by_style: "name",
      show_dates: true, show_recipes: true, show_settings: true, auto_store: true, ...this._config,
    };
    this._form.schema = this._schema();
  }
}

if (!customElements.get("einkaufsliste-card")) customElements.define("einkaufsliste-card", EinkaufslisteCard);
if (!customElements.get("einkaufsliste-card-editor")) customElements.define("einkaufsliste-card-editor", EinkaufslisteCardEditor);

window.customCards = window.customCards || [];
if (!window.customCards.some((c) => c.type === "einkaufsliste-card")) {
  window.customCards.push({
    type: "einkaufsliste-card",
    name: "Einkaufsliste",
    description: "Familien-Einkaufsliste mit Geschäften, Kategorien, Rezepten und Live-Sync.",
    preview: false,
    documentationURL: "https://github.com/misterm2310/einkaufslisten-card",
  });
}

console.info(`%c 🛒 EINKAUFSLISTE %c v${EL_VERSION} `, "background:#43a047;color:#fff;font-weight:700;border-radius:4px 0 0 4px", "background:#333;color:#fff;border-radius:0 4px 4px 0");
