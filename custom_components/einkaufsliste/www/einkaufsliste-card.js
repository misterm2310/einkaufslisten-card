/*
 * Einkaufsliste Card – die Familien-Einkaufsliste für Home Assistant
 * Wird automatisch von der Integration "einkaufsliste" geladen.
 */
const EL_VERSION = "2.7.5";

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
const LOG_ACT = {
  add: { label: "✍️ eingetragen", verb: "hat % eingetragen" },
  readd: { label: "♻️ wieder drauf", verb: "hat % wieder auf die Liste genommen" },
  check: { label: "✅ abgehakt", verb: "hat % abgehakt" },
  edit: { label: "✏️ geändert", verb: "hat % geändert" },
  move: { label: "⇄ verschoben", verb: "hat % verschoben" },
  remove: { label: "🗑️ gelöscht", verb: "hat % gelöscht" },
};
const LOG_VIA = { card: "✍️", scan: "▥", recipe: "🍳", merge: "🔗", cleanup: "🧹", service: "🤖" };
const WD_LONG = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"];
const pyWd = (d) => (d.getDay() + 6) % 7;
const DAY = 86400000;

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const dayDiff = (a, b) => Math.round((startOfDay(a) - startOfDay(b)) / DAY);
const fmtDay = (d) => `${WD_SHORT[pyWd(d)]} ${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}.`;
const stripMdi = (icon) => String(icon || "").replace(/^mdi:/, "");
// 🔢 „3 milch“ / „milch 3x“ / „250g nudeln“ -> Name + Menge (wie in Home Assistant)
const QTY_UNITS = { x: "x", "×": "x", stk: "x", "stück": "x", st: "x", g: "g", gr: "g", gramm: "g", kg: "kg", ml: "ml",
  l: "L", ltr: "L", liter: "L", el: "EL", tl: "TL", pck: "Pck.", pkt: "Pck.", "päckchen": "Pck.", packung: "Pck.",
  prise: "Prise", dose: "Dose", dosen: "Dosen", becher: "Becher", bund: "Bund", flasche: "Flasche", flaschen: "Flaschen" };
function splitQty(text) {
  const t = String(text || "").trim().replace(/\s+/g, " ");
  const units = Object.keys(QTY_UNITS).sort((a, b) => b.length - a.length).map((u) => u.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const fmt = (n, u) => { const c = u ? QTY_UNITS[u.toLowerCase()] : "x"; return !c || c === "x" ? `${n}x` : `${n} ${c}`; };
  let m = t.match(new RegExp(`^(\\d+(?:[.,]\\d+)?)\\s*(?:(${units})\\.?(?=\\s)|(?=\\s))\\s*(.+)$`, "i"));
  if (m && /[a-zäöüß]/i.test(m[3])) return { name: m[3], qty: fmt(m[1], m[2]) };
  m = t.match(new RegExp(`^(.+?)\\s+(\\d+(?:[.,]\\d+)?)\\s*(${units})?\\.?$`, "i"));
  if (m && /[a-zäöüß]/i.test(m[1]) && (m[3] || Number(m[2].replace(",", ".")) <= 50)) return { name: m[1], qty: fmt(m[2], m[3]) };
  return { name: t, qty: null };
}

// Wie viele Buchstaben unterscheiden sich? (für die Tippfehler-Hilfe)
function editDistance(a, b) {
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > 2) return 9;
  const d = Array.from({ length: m + 1 }, (_, i) => Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[m][n];
}

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

// 🔥 Backofen & Co.
const HEAT_DEVICES = {
  "Backofen": { icon: "🔥", modes: ["Ober-/Unterhitze", "Umluft", "Heißluft", "Grill", "Umluft + Grill", "Unterhitze", "Pizzastufe"], unit: "°C" },
  "Heißluftfritteuse": { icon: "🍟", modes: ["Heißluft", "Backen", "Grillen", "Aufwärmen"], unit: "°C" },
  "Mikrowelle": { icon: "📡", modes: ["Mikrowelle", "Mikrowelle + Grill", "Auftauen"], unit: "W" },
  "Herd": { icon: "🍳", modes: ["Stufe niedrig", "Stufe mittel", "Stufe hoch", "Köcheln"], unit: "" },
  "Grill": { icon: "🥩", modes: ["Direkt", "Indirekt"], unit: "°C" },
  "Dampfgarer": { icon: "♨️", modes: ["Dampf", "Kombi"], unit: "°C" },
};

function heatText(h) {
  const dev = HEAT_DEVICES[h.device] || { icon: "🔥", unit: "°C" };
  return [
    `${dev.icon} ${h.device || "Backofen"}`,
    h.mode,
    h.temp ? `${h.temp}${dev.unit ? ` ${dev.unit}` : ""}` : "",
    h.minutes ? `${h.minutes}${h.minutes_to ? `–${h.minutes_to}` : ""} Min` : "",
    h.preheat ? "vorheizen" : "",
    h.note,
  ].filter(Boolean).join(" · ");
}

// ---------------------------------------------------------------- Overlays (über allem)
const OV_BTN = "background:rgba(255,255,255,.14);color:#fff;border:0;border-radius:12px;padding:10px 14px;font:500 15px Roboto,sans-serif;cursor:pointer;";
const OV_BTN_MAIN = "background:#43a047;color:#fff;border:0;border-radius:12px;padding:10px 16px;font:600 15px Roboto,sans-serif;cursor:pointer;";

function makeOverlay() {
  const ov = document.createElement("div");
  Object.assign(ov.style, {
    position: "fixed", inset: "0", background: "rgba(0,0,0,.9)", zIndex: "10000",
    display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
    padding: "16px", boxSizing: "border-box", color: "#fff", font: "15px Roboto, sans-serif",
    touchAction: "none",
  });
  document.body.appendChild(ov);
  return ov;
}

function ovButton(label, main = false) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  b.style.cssText = main ? OV_BTN_MAIN : OV_BTN;
  return b;
}

/**
 * ✂️ Foto drehen & zuschneiden, bevor es gespeichert wird.
 * Gibt ein verkleinertes JPEG (data-URL) zurück – oder null bei „Abbrechen“.
 */
async function editImage(file, max = 900, quality = 0.8) {
  const img = await loadImage(file);
  return new Promise((resolve) => {
    const ov = makeOverlay();
    ov.style.background = "#000";
    let rot = 0;
    let src = null; // gedrehtes Bild (Arbeitskopie)
    const wrap = document.createElement("div");
    Object.assign(wrap.style, { position: "relative", lineHeight: "0", userSelect: "none" });
    const canvas = document.createElement("canvas");
    Object.assign(canvas.style, { borderRadius: "8px", maxWidth: "100%" });
    const box = document.createElement("div");
    Object.assign(box.style, {
      position: "absolute", border: "2px solid #fff", boxShadow: "0 0 0 9999px rgba(0,0,0,.55)",
      cursor: "move", boxSizing: "border-box", touchAction: "none",
    });
    const handle = document.createElement("div");
    Object.assign(handle.style, {
      position: "absolute", right: "-12px", bottom: "-12px", width: "26px", height: "26px",
      borderRadius: "50%", background: "#43a047", border: "3px solid #fff", cursor: "nwse-resize", touchAction: "none",
    });
    box.appendChild(handle);
    wrap.append(canvas, box);
    const hint = document.createElement("div");
    hint.textContent = "Rahmen verschieben, grünen Punkt ziehen = Ausschnitt ändern";
    Object.assign(hint.style, { color: "#bbb", fontSize: "13px", margin: "12px 0 10px", textAlign: "center" });
    const row = document.createElement("div");
    Object.assign(row.style, { display: "flex", gap: "8px", flexWrap: "wrap", justifyContent: "center" });
    const bL = ovButton("↺ Drehen"), bR = ovButton("↻ Drehen"), bFull = ovButton("⤢ Ganzes Bild");
    const bCancel = ovButton("Abbrechen"), bOk = ovButton("✔ Übernehmen", true);
    row.append(bL, bR, bFull, bCancel, bOk);
    ov.append(wrap, hint, row);
    let crop = { x: 0, y: 0, w: 0, h: 0 };

    const render = () => {
      const w0 = img.naturalWidth, h0 = img.naturalHeight;
      const big = Math.min(1, 1600 / Math.max(w0, h0));
      const sw = Math.round(w0 * big), sh = Math.round(h0 * big);
      src = document.createElement("canvas");
      const swap = rot % 2 === 1;
      src.width = swap ? sh : sw;
      src.height = swap ? sw : sh;
      const c = src.getContext("2d");
      c.translate(src.width / 2, src.height / 2);
      c.rotate((rot * Math.PI) / 2);
      c.drawImage(img, -sw / 2, -sh / 2, sw, sh);
      const maxW = Math.min(window.innerWidth - 32, 700), maxH = window.innerHeight * 0.62;
      const k = Math.min(maxW / src.width, maxH / src.height, 1);
      canvas.width = Math.round(src.width * k);
      canvas.height = Math.round(src.height * k);
      canvas.getContext("2d").drawImage(src, 0, 0, canvas.width, canvas.height);
      crop = { x: 0, y: 0, w: canvas.width, h: canvas.height };
      place();
    };
    const place = () => Object.assign(box.style, { left: `${crop.x}px`, top: `${crop.y}px`, width: `${crop.w}px`, height: `${crop.h}px` });
    const clamp = () => {
      crop.w = Math.max(40, Math.min(crop.w, canvas.width));
      crop.h = Math.max(40, Math.min(crop.h, canvas.height));
      crop.x = Math.max(0, Math.min(crop.x, canvas.width - crop.w));
      crop.y = Math.max(0, Math.min(crop.y, canvas.height - crop.h));
      place();
    };
    let drag = null;
    const down = (mode) => (e) => {
      e.preventDefault(); e.stopPropagation();
      drag = { mode, x: e.clientX, y: e.clientY, start: { ...crop } };
      (e.target).setPointerCapture?.(e.pointerId);
    };
    box.addEventListener("pointerdown", down("move"));
    handle.addEventListener("pointerdown", down("size"));
    const moveFn = (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (drag.mode === "move") { crop.x = drag.start.x + dx; crop.y = drag.start.y + dy; }
      else { crop.w = Math.min(drag.start.w + dx, canvas.width - drag.start.x); crop.h = Math.min(drag.start.h + dy, canvas.height - drag.start.y); }
      clamp();
    };
    const upFn = () => { drag = null; };
    window.addEventListener("pointermove", moveFn);
    window.addEventListener("pointerup", upFn);
    const finish = (val) => {
      window.removeEventListener("pointermove", moveFn);
      window.removeEventListener("pointerup", upFn);
      ov.remove();
      resolve(val);
    };
    bL.onclick = () => { rot = (rot + 3) % 4; render(); };
    bR.onclick = () => { rot = (rot + 1) % 4; render(); };
    bFull.onclick = () => { crop = { x: 0, y: 0, w: canvas.width, h: canvas.height }; place(); };
    bCancel.onclick = () => finish(null);
    bOk.onclick = () => {
      const k = src.width / canvas.width;
      const cw = crop.w * k, ch = crop.h * k;
      const scale = Math.min(1, max / Math.max(cw, ch));
      const out = document.createElement("canvas");
      out.width = Math.max(1, Math.round(cw * scale));
      out.height = Math.max(1, Math.round(ch * scale));
      out.getContext("2d").drawImage(src, crop.x * k, crop.y * k, cw, ch, 0, 0, out.width, out.height);
      finish(out.toDataURL("image/jpeg", quality));
    };
    render();
  });
}

const STYLE = `
:host { display:block; }
ha-card { display:block; padding:12px 12px 8px; overflow:hidden; }
* { box-sizing:border-box; }
button { font:inherit; color:inherit; }
.head { display:flex; align-items:center; gap:4px; margin:0 2px 8px; min-height:36px; }
.title { display:flex; align-items:center; gap:8px; font-size:1.25em; font-weight:600; flex:1; min-width:0; }
.title span.t { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.live { width:9px; height:9px; border-radius:50%; background:var(--success-color,#43a047); flex:0 0 auto; box-shadow:0 0 0 3px color-mix(in srgb, var(--success-color,#43a047) 25%, transparent); }
.live.off { background:var(--error-color,#db4437); box-shadow:0 0 0 3px color-mix(in srgb, var(--error-color,#db4437) 25%, transparent); animation: pulse 1.2s infinite; }
.updbar { margin:0 2px 8px; padding:8px 10px; border-radius:12px; background:color-mix(in srgb, var(--primary-color,#03a9f4) 14%, transparent); font-size:.88em; display:flex; align-items:center; gap:8px; }
.updbar b { flex:1; }
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
.sug.fuzzy { border-style:dashed; }
.chips { display:flex; flex-wrap:wrap; gap:6px; }
.chip2 { border:1.5px solid var(--divider-color, rgba(127,127,127,.35)); background:transparent; border-radius:999px; padding:7px 14px; cursor:pointer; font-size:.95em; min-width:44px; }
.chip2.sel { background:var(--primary-color,#03a9f4); border-color:var(--primary-color,#03a9f4); color:var(--text-primary-color,#fff); }
@keyframes pulse { 50% { opacity:.3; } }

.photobtn .pcount { font-size:10px; font-weight:700; margin-left:1px; }
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
.item .forwhom.colored { color:var(--pc); background:color-mix(in srgb, var(--pc) 14%, transparent); border:1px solid color-mix(in srgb, var(--pc) 45%, transparent); border-radius:999px; padding:0 8px; font-weight:600; }
.pchip { border-color:color-mix(in srgb, var(--pc) 55%, transparent) !important; display:inline-flex; align-items:center; gap:6px; }
.pchip .pdot { width:10px; height:10px; border-radius:50%; background:var(--pc); }
.pchip.sel { background:var(--pc) !important; border-color:var(--pc) !important; color:#fff; }
.pchip.sel .pdot { background:#fff; }
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
ha-card.shop .item { padding:11px 5px; font-size:1.2em; }
ha-card.shop .item .name { font-weight:600; }
ha-card.shop .item .check { padding:9px; --mdc-icon-size:38px; }
ha-card.shop .item .meta { font-size:.66em; }
ha-card.shop .item .acts { opacity:1; --mdc-icon-size:26px; }
ha-card.shop .item .acts .iconbtn { padding:8px; }
ha-card.shop .item .qty { font-size:.8em; padding:2px 10px; }
ha-card.shop .ghead { font-size:.95em; padding:10px 4px 4px; }
ha-card.shop .tab { padding:9px 15px; font-size:1.05em; }
ha-card.shop .shopbar { font-size:1.05em; padding:10px 12px; }
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
.tiles { display:grid; grid-template-columns:repeat(auto-fill, minmax(120px, 1fr)); gap:8px; }
.tile { display:flex; flex-direction:column; align-items:flex-start; gap:2px; text-align:left; padding:12px; border-radius:14px; cursor:pointer; border:1px solid var(--divider-color, rgba(127,127,127,.25)); background:var(--secondary-background-color, rgba(127,127,127,.06)); color:var(--primary-text-color); font:inherit; }
.tile:hover { border-color:var(--primary-color,#03a9f4); }
.tile ha-icon { color:var(--primary-color,#03a9f4); margin-bottom:4px; }
.tile small { color:var(--secondary-text-color); font-size:.78em; }
.sechead { display:flex; align-items:center; gap:10px; margin-bottom:6px; }
.sechead h3 { margin:0; }
.sechead .back { padding:6px 10px; }
.prodrow { cursor:pointer; }
.prodrow .pmeta { display:flex; flex-wrap:wrap; gap:2px 8px; }
.prodedit { display:grid; grid-template-columns:1fr 1fr; gap:6px; padding:8px; border-radius:12px; background:var(--secondary-background-color, rgba(127,127,127,.07)); margin:6px 0; }
.prodedit .btnrow, .prodedit .hint { grid-column:1/-1; }
.logfilter { display:grid; grid-template-columns:repeat(auto-fit, minmax(110px, 1fr)); gap:6px; margin:4px 0; }
.logday { font-size:.78em; font-weight:600; text-transform:uppercase; letter-spacing:.04em; color:var(--secondary-text-color); margin:10px 2px 2px; }
.logrow { display:flex; gap:8px; align-items:flex-start; padding:6px 4px; border-bottom:1px solid var(--divider-color, rgba(127,127,127,.12)); font-size:.9em; }
.logrow .lt { color:var(--secondary-text-color); font-variant-numeric:tabular-nums; min-width:38px; }
.logrow .lv { min-width:20px; text-align:center; }
.logrow .lx { flex:1; min-width:0; }
.logrow .lx small { display:block; color:var(--secondary-text-color); font-size:.8em; }
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
.recipe mark { background:none; color:var(--primary-color,#03a9f4); font-weight:700; }
.rsearch { margin:4px 2px 8px; }
.rsearch input[type=search]::-webkit-search-cancel-button { display:none; }
.recipe .rname b { display:block; word-break:break-word; }
.recipe .rname small { color:var(--secondary-text-color); font-size:.78em; display:block; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.recipe .primary { padding:8px 10px; font-size:.85em; }
.rtools { display:flex; gap:6px; justify-content:flex-end; margin:-2px 4px 8px; }
.rtools .btn { padding:5px 10px; font-size:.8em; }
.rtools .rheat { flex:1; align-self:center; font-size:.78em; color:var(--secondary-text-color); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.heatrow { display:grid; grid-template-columns:1fr 1fr; gap:6px; padding:8px; border-radius:12px; background:color-mix(in srgb, #ff7043 10%, transparent); border:1px solid color-mix(in srgb, #ff7043 35%, transparent); margin:6px 0; }
.heatrow .hnums { display:grid; grid-template-columns:1fr 1fr; gap:6px; }
.heatrow .hfoot { grid-column:1/-1; display:flex; align-items:center; gap:8px; }
.heatrow .hfoot input[type=text] { flex:1; }
.heatrow input[type=checkbox] { width:auto; }
.heatrow .hnums { grid-column:1/-1; grid-template-columns:1fr 2fr !important; }
.heatrow .hmin { display:flex; align-items:center; gap:4px; }
.heatrow .hmin input { flex:1; min-width:0; }
.heatrow .hmin span { opacity:.6; }
.heatrow label { display:flex; align-items:center; gap:4px; font-size:.85em; white-space:nowrap; }
.pickrow.basic .pname { font-size:.85em; }
.pickrow .pbasic { font-size:.72em; color:var(--secondary-text-color); white-space:nowrap; }
.recipe .rbtns { display:flex; flex-direction:column; gap:4px; align-items:stretch; }
.recipe .rbtns .btn { padding:6px 10px; font-size:.8em; justify-content:center; }
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
.rsub { margin-top:14px !important; flex-wrap:wrap; }
.rsteps { width:100%; box-sizing:border-box; font:inherit; font-size:.92em; color:var(--primary-text-color); background:var(--input-fill-color, var(--secondary-background-color, rgba(127,127,127,.08))); border:1px solid var(--divider-color, rgba(127,127,127,.3)); border-radius:10px; padding:9px 10px; resize:vertical; }
.rimportbtn { margin-left:auto; padding:5px 10px; font-size:.8em; font-weight:400; }
.rimport textarea { width:100%; box-sizing:border-box; font:inherit; font-size:.9em; color:var(--primary-text-color); background:var(--input-fill-color, var(--secondary-background-color, rgba(127,127,127,.08))); border:1px solid var(--divider-color, rgba(127,127,127,.3)); border-radius:10px; padding:9px 10px; resize:vertical; }
.rimport .btnrow { justify-content:flex-end; }
#rPhotoRow { margin:4px 2px 2px; }
#rPhotoRow .btn.on { color:var(--primary-color,#03a9f4); }
.redithint { font-size:.85em; padding:6px 10px; border-radius:10px; background:color-mix(in srgb, var(--primary-color,#03a9f4) 12%, transparent); margin:4px 2px; }
.rrow .iconbtn { align-self:center; }
.rrow.editing { outline:2px solid var(--primary-color,#03a9f4); }
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
    this._updateLive();
  }

  // 🟢 Live-Anzeige: verbunden und Liste abonniert = grün, sonst rot
  _updateLive() {
    const dot = this.$("liveDot");
    if (!dot) return;
    const ok = this._hass?.connected !== false && !!this._unsub && !this._error;
    dot.classList.toggle("off", !ok);
    dot.title = ok ? "Verbunden – alles ist aktuell" : "Keine Verbindung – Änderungen kommen gerade nicht an";
  }

  // 🔄 Update-Hinweis: Karte (Handy-Speicher) und Integration haben verschiedene Versionen
  _renderUpdateBar() {
    const bar = this.$("updBar");
    if (!bar) return;
    const server = this._data?.version;
    const show = !!server && server !== EL_VERSION;
    bar.hidden = !show;
    if (show) {
      const num = (v) => String(v).split(".").map((x) => Number(x) || 0);
      const [a, b] = [num(server), num(EL_VERSION)];
      const serverNewer = a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
      bar.innerHTML = serverNewer > 0
        ? `🔄 <b>Neue Version ${esc(server)} ist da (hier läuft noch ${EL_VERSION}).</b><button class="btn" data-act="reload">Neu laden</button>`
        : `🔄 <b>Die Karte ist schon ${EL_VERSION}, Home Assistant noch ${esc(server)} – bitte Home Assistant neu starten.</b>`;
    }
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
      this._updateLive();
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
          <div class="title"><ha-icon id="titleIcon" icon="mdi:cart-variant"></ha-icon><span class="t" id="title"></span><span class="badge" id="count" hidden></span><span class="live" id="liveDot" title="Verbindung"></span></div>
          <button class="iconbtn" id="btnShop" data-act="shopmode" title="Laden-Modus"><ha-icon icon="mdi:cart-outline"></ha-icon></button>
          <button class="iconbtn" id="btnRecipes" data-act="view" data-view="recipes" title="Rezepte"><ha-icon icon="mdi:chef-hat"></ha-icon></button>
          <button class="iconbtn" id="btnSettings" data-act="view" data-view="settings" title="Geschäfte & Kategorien"><ha-icon icon="mdi:cog-outline"></ha-icon></button>
        </div>
        <div class="error" id="error" hidden></div>
        <div class="updbar" id="updBar" hidden></div>
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
              <button class="tool" id="tBasic" type="button" data-act="basic-toggle" title="🧂 Grundvorrat – haben wir immer (z. B. Salz, Öl)" hidden><ha-icon icon="mdi:shaker-outline"></ha-icon></button>
              <button class="tool tclear" id="tClear" type="button" data-act="clear-form" title="Alles leeren" hidden><ha-icon icon="mdi:eraser"></ha-icon></button>
            </div>
            <div class="extras">
              <div id="qtyBox" class="chipbox" hidden>
                <div class="chips" id="qtyChips"></div>
                <input id="inQty" placeholder="🔢 Menge, z. B. 500 g" hidden>
              </div>
              <input id="inNote" placeholder="📝 Notiz, z. B. Bio" hidden>
              <div class="chips" id="noteChips" hidden></div>
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
    this._renderUpdateBar();
    this._updateLive();
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
    if (this._view !== "recipe") this._parkForm();
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
    const noneFn = (i) => !i.store_id;
    const parts = [`<button class="tab ${active === "all" ? "active" : ""}" data-act="tab" data-tab="all">Alle <span class="n">${openCount(() => true)}</span>${bubble(() => true, active === "all")}</button>`];
    for (const s of d.stores) {
      parts.push(`<button class="tab ${active === s.id ? "active" : ""}" style="--c:${esc(s.color)}" data-act="tab" data-tab="${s.id}"><span class="dot"></span>${this._lastNear === s.id ? "📍 " : ""}${esc(s.name)} <span class="n">${openCount((i) => i.store_id === s.id)}</span>${bubble((i) => i.store_id === s.id, active === s.id)}</button>`);
    }
    const none = d.items.filter((i) => !i.store_id).length;
    if (none || active === "none") {
      parts.push(`<button class="tab ${active === "none" ? "active" : ""}" style="--c:#888" data-act="tab" data-tab="none"><span class="dot"></span>Egal wo <span class="n">${openCount(noneFn)}</span>${bubble(noneFn, active === "none")}</button>`);
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
  // Vorschläge suchen (für das Eingabefeld oben und für Rezept-Zutaten)
  _suggestList(q, { recipe = false } = {}) {
    if (!q || !this._data) return [];
    const score = (low) => (low.startsWith(q) || low.split(/\s+/).some((w) => w.startsWith(q)) ? 0 : low.includes(q) ? 1 : -1);
    const cands = [];
    const seenVariant = new Set();
    const names = new Set();
    // zuerst Artikel aus der Liste: aktueller Reiter vor anderen, abgehakt vor offen
    const items = [...this._data.items].sort((a, b) =>
      (recipe ? 0 : this._matchesTab(b) - this._matchesTab(a)) || (b.checked - a.checked)
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
    // 🤓 Tippfehler-Hilfe: „Mlich“ -> „Meintest du Milch?“
    if (q.length >= 4 && !cands.some((c) => c.sc === 0)) {
      const maxD = q.length > 6 ? 2 : 1;
      const pool = new Map();
      for (const h of this._data.history || []) pool.set(h.name.toLowerCase(), { name: h.name, hist: h });
      for (const i of this._data.items) if (!i.recipe_id && !pool.has(i.name.toLowerCase())) pool.set(i.name.toLowerCase(), { name: i.name, item: i });
      const fuzzy = [];
      for (const [low, c] of pool) {
        if (names.has(low) || low === q) continue;
        const d = Math.min(editDistance(q, low), q.length < low.length ? editDistance(q, low.slice(0, q.length)) : 9);
        if (d <= maxD) fuzzy.push({ ...c, sc: 2 + d, fuzzy: true });
      }
      fuzzy.sort((a, b) => a.sc - b.sc);
      cands.push(...fuzzy.slice(0, 2));
    }
    cands.sort((a, b) => a.sc - b.sc);
    return cands.slice(0, 8);
  }

  _suggestChips(list, q, act, { recipe = false } = {}) {
    const mark = (name) => {
      const at = name.toLowerCase().indexOf(q);
      return at < 0 ? esc(name) : esc(name.slice(0, at)) + "<b>" + esc(name.slice(at, at + q.length)) + "</b>" + esc(name.slice(at + q.length));
    };
    return list.map((c, n) => {
      const i = c.item;
      const bits = [];
      if (i) {
        if (i.quantity) bits.push(esc(i.quantity));
        if (i.note) bits.push("📝 " + esc(i.note));
        if (i.for_whom) bits.push("👤 " + esc(i.for_whom));
        const st = i.store_id && this._store(i.store_id);
        if (st && (recipe || this._activeTab === "all")) bits.push(esc(st.name));
        if (!i.checked && !recipe) bits.push("steht drauf");
      }
      if (c.fuzzy) return `<button type="button" class="sug fuzzy" data-act="${act}" data-n="${n}"><span>Meintest du <b>${esc(c.name)}</b>?</span></button>`;
      return `<button type="button" class="sug" data-act="${act}" data-n="${n}"><span>${mark(c.name)}</span>${
        bits.length ? `<span class="on">· ${bits.join(" · ")}</span>` : ""}</button>`;
    }).join("");
  }

  // 🔎 Eigene Vorschläge beim Tippen (datalist klappt in der HA-App am Handy nicht)
  // Jede Variante aus der Liste (Menge, Notiz, für wen, Geschäft) ist ein eigener Vorschlag –
  // antippen übernimmt alles davon ins Formular.
  _renderSuggest() {
    const box = this.$("sugg");
    if (!box) return;
    const q = (this.$("inName").value || "").trim().toLowerCase();
    const list = this._suggestList(q);
    this._suggMap = new Map(list.map((c, n) => [String(n), c]));
    if (!list.length) { box.hidden = true; box.innerHTML = ""; return; }
    box.innerHTML = this._suggestChips(list, q, "suggest");
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
    const grp = this._grpMap?.get(item.id);
    if (grp && grp.length > 1) {
      for (const g of grp) { const st = this._store(g.store_id); if (st) meta.push(`<span class="chip" style="--c:${esc(st.color)}">${esc(st.name)}</span>`); }
    } else if (this._activeTab === "all" && store) meta.push(`<span class="chip" style="--c:${esc(store.color)}">${esc(store.name)}</span>`);
    // Reihenfolge unter dem Namen: Geschäft · Notiz · Barcode · wer eingetragen · wer abgehakt · (Rezept, Zeit)
    if (item.note) meta.push(`<span>📝 ${esc(item.note)}</span>`);
    const pk = this._pk(item.name, item.note);
    const codes = this._barcodesOf(pk);
    if (codes.length) meta.push(`<span class="bc" title="Barcode hinterlegt: ${esc(codes.join(", "))}">▥</span>`);
    if (c.show_added_by && item.added_by) meta.push(`<span title="Eingetragen von">✍️ ${esc(this._who(item.added_by))}</span>`);
    if (c.show_dates && item.checked) meta.push(`<span title="Abgehakt von">✓ ${item.checked_by ? esc(this._who(item.checked_by)) : "automatisch"}</span>`);
    if (recipe) meta.push(`<span>🍽️ ${esc(recipe.name)}</span>`);
    if (c.show_dates) {
      if (item.checked) {
        // (wer abgehakt hat, steht schon oben)
      } else {
        meta.push(`<span>${fmtSince(item.added_at)}</span>`);
        const auto = this._autoCheckDate(item);
        if (auto) meta.push(`<span title="Wird an diesem Tag automatisch abgehakt">🧹 ${fmtDay(auto)}</span>`);
      }
    }
    // hinter dem Namen: für wen es ist (wer es eingetragen hat, steht klein darunter)
    const who = item.for_whom ? this._forWhomHtml(item.for_whom) : "";
    const qty = item.quantity ? `<button class="qty" data-act="qty-edit" title="Menge ändern">${esc(item.quantity)}</button>` : "";
    const icon = item.checked ? "mdi:checkbox-marked-circle-outline" : "mdi:checkbox-blank-circle-outline";
    const cat = this._cat(item.category_id);
    const isNew = this._isNew(item);
    return `
      <div class="item ${item.checked ? "done" : ""} ${this._pending.has(item.id) ? "pending" : ""} ${isNew ? "new" : ""} ${item.name.startsWith("❓") ? "unknown" : ""}" data-id="${item.id}" style="--cc:${esc(cat?.color || "transparent")}">
        <button class="iconbtn check" data-act="toggle" title="${item.checked ? "Wieder auf die Liste" : "Abhaken"}"><ha-icon icon="${icon}"></ha-icon></button>
        <div class="txt">
          <div class="line">${isNew ? `<span class="newbadge" title="Neu seit deinem letzten Blick">✨</span>` : ""}<span class="name">${esc(item.name)}</span>${qty}${who}${this._hasPhoto(pk) ? `<button class="photobtn" data-act="photo-view" data-name="${esc(pk)}" title="Foto ansehen"><ha-icon icon="mdi:camera"></ha-icon>${this._data.photo_counts?.[pk] > 1 ? `<small class="pcount">${this._data.photo_counts[pk]}</small>` : ""}</button>` : ""}</div>
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
        ${b("menu-photo", "mdi:camera-plus-outline", this._hasPhoto(this._pk(item.name, item.note)) ? "Fotos" : "Foto")}
        ${this._hasAppScanner() ? b("barcode-assign", "mdi:barcode-scan", this._barcodesOf(this._pk(item.name, item.note)).length ? "Barcode ✓" : "Barcode") : ""}
        ${this._barcodesOf(this._pk(item.name, item.note)).length ? b("menu-info", "mdi:information-outline", "Infos") : ""}
        <button class="iconbtn" data-act="menu-close" title="Schließen"><ha-icon icon="mdi:close"></ha-icon></button>
      </div>`;
  }

  // 🔢 Menge zerlegen: „250 g“ -> {n: 250, unit: "g"}, „3x“ -> {n: 3, unit: "x"}
  _parseQty(q) {
    const m = String(q || "1x").trim().match(/^(\d+(?:[.,]\d+)?)\s*([A-Za-zÄÖÜäöü.]+)?$/);
    if (!m) return null;
    return { n: Number(m[1].replace(",", ".")), unit: m[2] || "x", comma: m[1].includes(",") };
  }

  _fmtQty(n, unit) {
    const num = Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100).replace(".", ",");
    return unit === "x" ? `${num}x` : `${num} ${unit}`;
  }

  _qtyStepFor(item) {
    const p = this._parseQty(item.quantity);
    if (!p) return 1;
    if (/^(g|ml|mg)$/i.test(p.unit)) return p.n > 0 ? p.n : 100; // 250 g -> 500 g -> 750 g
    return Number.isInteger(p.n) ? 1 : 0.5; // 1 L -> 2 L, 1,5 L -> 2 L
  }

  _qtyHtml(item) {
    const p = this._parseQty(item.quantity) || { n: 1, unit: "x" };
    const step = (this._qtyStep ||= {})[item.id] || (this._qtyStep[item.id] = this._qtyStepFor(item));
    return `
      <div class="qtyrow" data-id="${item.id}">
        <button class="qbtn" data-act="qty-minus" ${p.n <= step ? "disabled" : ""}>−</button>
        <span class="qval">${esc(this._fmtQty(p.n, p.unit))}</span>
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
          <button type="button" class="btn" data-act="photo-take" data-name="${esc(this._pk(item.name, item.note))}"><ha-icon icon="mdi:camera-plus-outline"></ha-icon>${this._hasPhoto(this._pk(item.name, item.note)) ? "Foto ändern" : "Foto"}</button>
          ${this._hasAppScanner() ? `<button type="button" class="btn" data-act="barcode-assign" data-id="${item.id}"><ha-icon icon="mdi:barcode-scan"></ha-icon>Barcode zuordnen</button>` : ""}
          ${this._hasPhoto(this._pk(item.name, item.note)) ? `<button type="button" class="btn" data-act="photo-view" data-name="${esc(this._pk(item.name, item.note))}"><ha-icon icon="mdi:image-outline"></ha-icon>Ansehen</button>
          <button type="button" class="btn danger" data-act="photo-remove" data-name="${esc(this._pk(item.name, item.note))}"><ha-icon icon="mdi:image-remove-outline"></ha-icon>Foto löschen</button>` : ""}
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
    const allView = this._activeTab === "all" && !this._fixedStore;
    this._grpMap = new Map();
    const rawOpen = items.filter((i) => !i.checked);
    const open = allView ? this._groupStores(rawOpen) : rawOpen;
    const filter = (this.$("inName").value || "").trim().toLowerCase();
    let done = items.filter((i) => i.checked);
    if (filter) done = done.filter((i) => i.name.toLowerCase().includes(filter));
    if (allView) done = this._groupStores(done);
    const row = (i) => (this._editing === i.id ? this._editHtml(i) : this._itemHtml(i)
      + (this._wherePick?.id === i.id ? this._whereHtml(i) : "")
      + (this._menuId === i.id ? this._menuHtml(i) : "")
      + (this._qtyEdit === i.id ? this._qtyHtml(i) : "")
      + (this._moving === i.id ? this._moveHtml(i) : ""));
    const byName = (a, b) => a.name.localeCompare(b.name, "de");
    const html = [];
    if (this._shopMode) {
      html.push(`<div class="shopbar"><ha-icon icon="mdi:cart"></ha-icon><b>Laden-Modus – einfach abhaken 🛒</b><button class="btn" data-act="shopmode">Beenden</button></div>`);
    }
    if (this._conflict) html.push(this._conflictHtml());
    const dup = filter ? null : this._findDuplicate(rawOpen);
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
      const total = allView ? this._groupStores(items.filter((i) => i.checked)).length : items.filter((i) => i.checked).length;
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
      if (Object.keys(upd).length) await this._ws({ type: "einkaufsliste/item/update", item_id: keep.id, via: "merge", ...upd });
      await this._ws({ type: "einkaufsliste/item/remove", item_id: drop.id, via: "merge" });
      this._toast(`🔗 Zusammengelegt zu „${keep.name}“${upd.quantity ? ` (${upd.quantity})` : ""}`);
    } catch (_) { /* Meldung kam schon */ }
  }

  // 🔗 Gleiches Produkt in mehreren Geschäften (für „Alle“ und das Verschieben)
  _gkey(i) {
    return [String(i.name || "").trim().toLowerCase(), String(i.note || "").trim().toLowerCase(),
      String(i.for_whom || "").trim().toLowerCase(), i.recipe_id || ""].join("|");
  }

  _siblings(item, checked) {
    const k = this._gkey(item);
    return this._data.items.filter((i) => i.checked === checked && this._gkey(i) === k);
  }

  _openElsewhere(item, storeId) {
    if (!storeId || !this._data) return null;
    const k = this._gkey(item);
    return this._data.items.find((i) => !i.checked && i.store_id && i.store_id !== storeId && this._gkey(i) === k) || null;
  }

  _storeOrder(a, b) {
    const idx = (i) => { const n = this._data.stores.findIndex((s) => s.id === i.store_id); return n < 0 ? 999 : n; };
    return idx(a) - idx(b);
  }

  // „Alle“: gleiche Produkte aus verschiedenen Geschäften zu einer Zeile zusammenfassen
  _groupStores(list) {
    const map = new Map();
    for (const i of list) {
      const k = this._gkey(i);
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(i);
    }
    const reps = [];
    for (const arr of map.values()) {
      arr.sort((a, b) => this._storeOrder(a, b));
      const rep = arr.find((i) => i.id === this._wherePick?.id) || arr[0];
      this._grpMap.set(rep.id, arr);
      reps.push(rep);
    }
    return reps;
  }

  _whereHtml(item) {
    const grp = this._grpMap?.get(item.id) || [item];
    const buy = !item.checked;
    return `<div class="moverow whererow" data-id="${item.id}">
      <span class="movetxt">${buy ? "Wo gekauft?" : "Wieder drauf bei:"}</span>
      ${grp.map((i) => { const st = this._store(i.store_id); return `<button class="tab" style="--c:${esc(st?.color || "#888")}" data-act="where-go" data-item="${i.id}"><span class="dot"></span>${esc(st?.name || "Egal wo")}</button>`; }).join("")}
      <button class="iconbtn" data-act="where-cancel" title="Abbrechen"><ha-icon icon="mdi:close"></ha-icon></button>
    </div>`;
  }

  _conflictHtml() {
    const c = this._conflict;
    const other = c && this._data.items.find((i) => i.id === c.other && !i.checked);
    const target = c && this._store(c.store);
    if (!other || !target) { this._conflict = null; return ""; }
    const from = this._store(other.store_id);
    return `<div class="dupbar conflict">🛒 <b>„${esc(other.name)}“</b> steht schon bei <b>${esc(from?.name || "?")}</b> offen.
      <div class="dbtns">
        <button class="btn" data-act="conflict-cancel">Abbrechen</button>
        <button class="btn" data-act="conflict-extra"><ha-icon icon="mdi:plus"></ha-icon>Zusätzlich bei ${esc(target.name)}</button>
        <button class="primary addbtn" data-act="conflict-move"><ha-icon icon="mdi:swap-horizontal"></ha-icon>Nach ${esc(target.name)} verschieben</button>
      </div></div>`;
  }

  // Wieder auf die Liste nehmen – aber erst fragen, wenn es woanders schon offen ist
  _readd(item) {
    const other = this._openElsewhere(item, item.store_id);
    if (other) {
      this._conflict = { kind: "readd", other: other.id, store: item.store_id, item: item.id };
      this._renderList();
      return;
    }
    this._toggle(item.id);
  }

  _toggle(id) {
    if (!id || this._pending.has(id)) return;
    const it = this._data?.items.find((i) => i.id === id);
    if (it && !it.checked) { try { navigator.vibrate?.(35); } catch (_) { /* egal */ } }
    this._pending.add(id);
    this.shadowRoot.querySelector(`.item[data-id="${id}"]`)?.classList.add("pending");
    this._ws({ type: "einkaufsliste/item/toggle", item_id: id })
      .catch(() => {})
      .finally(() => { this._pending.delete(id); this._renderAll(); });
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
    this._parkForm();
    const d = this._data;
    const s = d.settings;
    const row = (kind, e, i, len) => `
      <div class="srow" data-kind="${kind}" data-id="${e.id}">
        ${kind === "stores"
          ? `<input type="color" value="${esc(e.color || "#607d8b")}" data-field="color" title="Farbe">`
          : kind === "categories" || kind === "persons"
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
    const persons = d.persons || [];
    const recipes = [...(d.recipes || [])].sort((a, b) => a.name.localeCompare(b.name, "de", { sensitivity: "base" }));
    const sections = [
      { key: "stores", icon: "mdi:store-outline", title: "Geschäfte", info: d.stores.length === 1 ? "1 Geschäft" : `${d.stores.length} Geschäfte`, html: () => `
        ${d.stores.map((e, i) => row("stores", e, i, d.stores.length)).join("")}
        <form class="srow" data-addkind="stores">
          <input type="color" value="#607d8b" name="color" title="Farbe">
          <input class="grow" name="name" placeholder="Neues Geschäft, z. B. Kaufland">
          <button class="primary" type="submit" title="Hinzufügen"><ha-icon icon="mdi:plus"></ha-icon></button>
        </form>
        <p class="hint">📍 Hat ein Geschäft eine <b>Zone</b>, springt die Liste automatisch auf dieses Geschäft, sobald du dort bist. Zonen legst du unter Einstellungen → Bereiche & Zonen an.</p>` },
      { key: "categories", icon: "mdi:shape-outline", title: "Kategorien", info: d.categories.length === 1 ? "1 Kategorie" : `${d.categories.length} Kategorien`, html: () => `
        ${d.categories.map((e, i) => row("categories", e, i, d.categories.length)).join("")}
        <form class="srow" data-addkind="categories">
          <ha-icon class="prev" icon="mdi:tag-plus-outline"></ha-icon>
          <input class="grow" name="name" placeholder="Neue Kategorie">
          ${this._iconField("", 'name="icon" data-newicon="1"')}
          <button class="primary" type="submit" title="Hinzufügen"><ha-icon icon="mdi:plus"></ha-icon></button>
        </form>
        <div class="picker" hidden></div>
        <p class="hint">Icon: einfach den Namen tippen (z. B. <b>hund</b>, <b>dog</b> oder <b>fish</b>) und aus der Vorschau antippen.</p>` },
      { key: "recipes", icon: "mdi:chef-hat", title: "Rezepte", info: recipes.length ? (recipes.length === 1 ? "1 Rezept" : `${recipes.length} Rezepte`) : "noch keine", html: () => `
        ${recipes.length ? this._recipeSearchHtml("recipeSearchS") : ""}
        <div id="setRecipeList"></div>
        <div class="btnrow"><button class="btn" data-act="recipe-new"><ha-icon icon="mdi:plus"></ha-icon>Neues Rezept</button></div>` },
      { key: "persons", icon: "mdi:account-group-outline", title: "Personen", info: persons.length ? `${persons.length} für „Für wen?“` : "noch keine", html: () => `
        ${persons.map((e, i) => row("persons", e, i, persons.length)).join("")}
        <form class="srow" data-addkind="persons">
          <ha-icon class="prev" icon="mdi:account-plus-outline"></ha-icon>
          <input class="grow" name="name" placeholder="Neue Person, z. B. Oma">
          <button class="primary" type="submit" title="Hinzufügen"><ha-icon icon="mdi:plus"></ha-icon></button>
        </form>
        <p class="hint">${persons.length ? "Diese Namen erscheinen als Schnellknöpfe bei 👤 „Für wen?“." : "Noch keine Personen – solange bleibt das Feld „Für wen?“ ausgeblendet."}</p>` },
      { key: "products", icon: "mdi:package-variant-closed", title: "Produkte", info: "Katalog: Fotos, Barcodes …", html: () => `
        <p class="hint">Alle Produkte, die die Liste kennt. Antippen = ändern. Umbenennen zieht Fotos, Barcodes, Artikel und Rezepte mit.</p>
        <div class="srow"><ha-icon class="prev" icon="mdi:magnify"></ha-icon><input class="grow" id="prodSearch" placeholder="Produkt suchen …" value="${esc(this._prodFilter || "")}"></div>
        <div id="prodList"><p class="hint">Lade Produkte …</p></div>` },
      { key: "log", icon: "mdi:history", title: "Verlauf", info: "wer, wann, was, wie", html: () => this._logSectionHtml() },
      { key: "cleanup", icon: "mdi:broom", title: "Aufräumen", info: `${WD_SHORT[s.cleanup_weekday]} ${s.cleanup_time} Uhr`, html: () => `
        <p>Jeden <b>${WD_LONG[s.cleanup_weekday]}</b> um <b>${s.cleanup_time} Uhr</b> werden alle offenen Artikel <b>abgehakt</b>, die mindestens <b>${s.min_age_days} Tage</b> auf der Liste stehen. Gelöscht wird nichts – so kannst du sie später mit einem Tipp wieder auf die Liste nehmen.</p>
        <p class="hint">Tag & Uhrzeit ändern: Einstellungen → Geräte & Dienste → Einkaufsliste → Konfigurieren</p>
        <div class="btnrow">
          <button class="btn" data-act="cleanup-now"><ha-icon icon="mdi:broom"></ha-icon>Jetzt aufräumen</button>
          <button class="btn" data-act="check-all"><ha-icon icon="mdi:checkbox-multiple-marked-circle-outline"></ha-icon>Alles abhaken</button>
        </div>` },
      { key: "delete", icon: "mdi:delete-outline", title: "Artikel löschen", info: "endgültig, mit Suche", html: () => `
        <p class="hint">Hier verschwinden Artikel endgültig, auch aus „Erledigt“ und samt Foto.</p>
        <div class="srow"><ha-icon class="prev" icon="mdi:magnify"></ha-icon><input class="grow" id="delSearch" placeholder="Artikel suchen …" value="${esc(this._delFilter || "")}"></div>
        <div id="delList"></div>` },
    ];
    const cur = sections.find((x) => x.key === this._setSec);
    if (!cur) {
      this.$("otherView").innerHTML = `
        <div class="sec">
          <h3><ha-icon icon="mdi:cog-outline"></ha-icon>Einstellungen</h3>
          <div class="tiles">${sections.map((x) => `
            <button class="tile" data-act="set-sec" data-sec="${x.key}">
              <ha-icon icon="${x.icon}"></ha-icon><b>${x.title}</b><small>${esc(x.info)}</small>
            </button>`).join("")}
          </div>
        </div>
        <p class="hint" style="text-align:right">Einkaufsliste v${EL_VERSION}</p>`;
      return;
    }
    this.$("otherView").innerHTML = `
      <div class="sec">
        <div class="sechead">
          <button class="btn back" data-act="set-sec" data-sec=""><ha-icon icon="mdi:arrow-left"></ha-icon>Übersicht</button>
          <h3><ha-icon icon="${cur.icon}"></ha-icon>${cur.title}</h3>
        </div>
        ${cur.html()}
      </div>`;
    if (cur.key === "log") { this._renderLogList(); this._loadLog(); }
    if (cur.key === "products") { this._renderProducts(); this._loadProducts(); }
    if (cur.key === "recipes") this._renderSetRecipeList();
    this._renderDelList();
  }

  // 📋 Verlauf: wer hat wann was wie gemacht?
  _logSectionHtml() {
    const f = (this._logF ||= { who: "", store: "", act: "", q: "" });
    const opt = (v, label, cur) => `<option value="${esc(v)}" ${v === cur ? "selected" : ""}>${esc(label)}</option>`;
    const names = [...new Set((this._logData?.entries || []).map((e) => e.w).filter(Boolean))].sort((a, b) => a.localeCompare(b, "de"));
    const days = this._logData?.days || 90;
    return `
      <div class="logfilter">
        <select id="logWho" title="Person">${opt("", "👤 Alle", f.who)}${opt("~auto", "🤖 Automatisch", f.who)}${names.map((n) => opt(n, n, f.who)).join("")}</select>
        <select id="logStore" title="Geschäft">${opt("", "🏪 Alle", f.store)}${this._data.stores.map((st) => opt(st.id, st.name, f.store)).join("")}${opt("~none", "Egal wo", f.store)}</select>
        <select id="logAct" title="Aktion">${opt("", "⚡ Alles", f.act)}${Object.entries(LOG_ACT).map(([k, v]) => opt(k, v.label, f.act)).join("")}</select>
      </div>
      <div class="srow"><ha-icon class="prev" icon="mdi:magnify"></ha-icon><input class="grow" id="logSearch" placeholder="Artikel suchen …" value="${esc(f.q)}"></div>
      <div id="logList"><p class="hint">Lade Verlauf …</p></div>
      <div class="srow" style="margin-top:12px">
        <ha-icon class="prev" icon="mdi:calendar-clock"></ha-icon>
        <span class="grow hint">Aufheben für</span>
        <select id="logDays" style="width:auto">${[7, 30, 90, 180, 365].map((n) => `<option value="${n}" ${n === days ? "selected" : ""}>${n} Tage</option>`).join("")}</select>
      </div>
      <div class="btnrow"><button class="btn" data-act="log-clear"><ha-icon icon="mdi:delete-sweep-outline"></ha-icon>Verlauf leeren</button></div>
      <p class="hint">Zeichen: ✍️ in der Karte · ▥ gescannt · 🍳 Rezept · 🔗 zusammengelegt · 🧹 automatisch aufgeräumt · 🤖 Automation/Dienst</p>`;
  }

  async _loadLog() {
    if (this._logLoading) return;
    this._logLoading = true;
    try {
      this._logData = await this._ws({ type: "einkaufsliste/log/get" });
    } catch (_) { /* Meldung kam schon */ }
    this._logLoading = false;
    if (this._view !== "settings" || this._setSec !== "log") return;
    // Personen-Auswahl auffrischen, ohne den Rest neu zu malen
    const who = this.$("logWho");
    if (who && !this.shadowRoot.activeElement?.closest?.(".logfilter")) {
      const tmp = document.createElement("div");
      tmp.innerHTML = this._logSectionHtml();
      who.innerHTML = tmp.querySelector("#logWho").innerHTML;
    }
    this._renderLogList();
  }

  _renderLogList() {
    const box = this.$("logList");
    if (!box || !this._logData) return;
    const f = this._logF;
    const q = f.q.trim().toLowerCase();
    const list = this._logData.entries.filter((e) =>
      (!f.who || (f.who === "~auto" ? !e.w : e.w === f.who))
      && (!f.store || (f.store === "~none" ? !e.s : e.s === f.store))
      && (!f.act || e.a === f.act)
      && (!q || String(e.n || "").toLowerCase().includes(q)));
    if (!list.length) {
      box.innerHTML = `<p class="hint">${this._logData.entries.length ? "Nichts gefunden – probier einen anderen Filter. 🔍" : "Noch nichts passiert. Sobald jemand etwas einträgt, steht es hier. ✍️"}</p>`;
      return;
    }
    const max = this._logMax || 150;
    const shown = list.slice(0, max);
    const now = new Date();
    let lastDay = "";
    const html = [];
    for (const e of shown) {
      const d = new Date(e.t);
      const diff = dayDiff(now, d);
      const day = diff === 0 ? "Heute" : diff === 1 ? "Gestern" : `${WD_LONG[pyWd(d)]}, ${fmtDay(d).slice(3)}`;
      if (day !== lastDay) { html.push(`<div class="logday">${day}</div>`); lastDay = day; }
      const act = LOG_ACT[e.a] || { label: e.a, verb: e.a };
      const via = LOG_VIA[e.v] || "🤖";
      const who = e.w ? `<b>${esc(this._who(e.w))}</b>` : (e.v === "cleanup" ? "<b>Aufräumen</b>" : "<b>Automatisch</b>");
      const st = this._store(e.s);
      html.push(`<div class="logrow">
        <span class="lt">${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}</span>
        <span class="lv" title="${esc(e.v || "")}">${via}</span>
        <span class="lx">${who} ${act.verb.replace("%", `<b>${esc(e.n || "?")}</b>`)}${st ? ` <span class="chip" style="--c:${esc(st.color)}">${esc(st.name)}</span>` : ""}${e.d ? `<small>${esc(e.d)}</small>` : ""}</span>
      </div>`);
    }
    if (list.length > shown.length) html.push(`<div class="btnrow"><button class="btn" data-act="log-more">Mehr anzeigen (${list.length - shown.length} weitere)</button></div>`);
    box.innerHTML = html.join("");
  }

  // 📦 Produkt-Katalog (nur hier in den Einstellungen)
  async _loadProducts() {
    if (this._prodLoading) return;
    this._prodLoading = true;
    try { this._products = await this._ws({ type: "einkaufsliste/products" }); } catch (_) { /* Meldung kam schon */ }
    this._prodLoading = false;
    this._renderProducts();
  }

  _renderProducts() {
    const box = this.$("prodList");
    if (!box || !this._products) return;
    const q = (this._prodFilter || "").trim().toLowerCase();
    const list = this._products.filter((p) => !q || `${p.name} ${p.note || ""}`.toLowerCase().includes(q));
    if (!list.length) { box.innerHTML = `<p class="hint">${q ? `Nichts gefunden zu „${esc(q)}“.` : "Noch keine Produkte."}</p>`; return; }
    const shown = list.slice(0, 80);
    box.innerHTML = shown.map((p) => {
      const cat = this._cat(p.category_id), st = this._store(p.store_id);
      const bits = [
        st ? `<span class="chip" style="--c:${esc(st.color)}">${esc(st.name)}</span>` : "",
        cat ? `<span>${esc(cat.name)}</span>` : "",
        p.barcodes.length ? `<span>▥ ${p.barcodes.length}</span>` : "",
        p.photos ? `<span>📷 ${p.photos}</span>` : "",
        p.count ? `<span>${p.count}× eingetragen</span>` : "",
        p.open ? `<span>🛒 steht drauf</span>` : "",
      ].filter(Boolean).join("");
      if (this._prodEdit === p.key) {
        return `<div class="prodedit" data-key="${esc(p.key)}">
          <input id="peName" value="${esc(p.name)}" placeholder="Name">
          <input id="peNote" value="${esc(p.note || "")}" placeholder="📝 Notiz / Sorte">
          <select id="peCat">${this._selectOptions(this._data.categories, p.category_id, "📦 Ohne Kategorie")}</select>
          <select id="peStore">${this._selectOptions(this._data.stores, p.store_id, "🛒 Kein Standard-Geschäft")}</select>
          ${p.barcodes.length ? `<div class="hint">▥ Barcodes: ${p.barcodes.map(esc).join(", ")}</div>` : ""}
          <div class="btnrow">
            ${p.photos ? `<button class="btn" data-act="prod-photos"><ha-icon icon="mdi:image-multiple-outline"></ha-icon>Fotos</button>` : ""}
            <button class="btn danger" data-act="prod-forget" title="Fotos, Barcodes und Verlauf vergessen"><ha-icon icon="mdi:delete-outline"></ha-icon>Vergessen</button>
            <span style="flex:1"></span>
            <button class="btn" data-act="prod-cancel">Abbrechen</button>
            <button class="btn primary" data-act="prod-save"><ha-icon icon="mdi:content-save-outline"></ha-icon>Speichern</button>
          </div>
        </div>`;
      }
      return `<div class="srow delrow prodrow" data-act="prod-edit" data-key="${esc(p.key)}">
        <div class="grow delname"><b>${esc(p.name)}${p.note ? ` · ${esc(p.note)}` : ""}</b><small class="pmeta">${bits || "–"}</small></div>
        <ha-icon icon="mdi:chevron-right"></ha-icon>
      </div>`;
    }).join("") + (list.length > shown.length ? `<p class="hint">… und ${list.length - shown.length} weitere – oben suchen.</p>` : "");
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
  // 🔎 Rezept-Suche: Anfangsbuchstaben zuerst, dann „steckt drin“, dann Zutaten, dann Tippfehler
  _recipeMatches(q) {
    const recipes = [...(this._data.recipes || [])].sort((a, b) => a.name.localeCompare(b.name, "de", { sensitivity: "base" }));
    q = (q || "").trim().toLowerCase();
    if (!q) return recipes.map((r) => ({ r, sc: 0 }));
    const starts = (low) => low.startsWith(q) || low.split(/[\s\-–,/()]+/).some((w) => w.startsWith(q));
    const out = [];
    const rest = [];
    for (const r of recipes) {
      const low = r.name.toLowerCase();
      if (starts(low)) { out.push({ r, sc: 0 }); continue; }
      // ein einzelner Buchstabe zählt nur am Wortanfang – sonst findet „z“ auch Pi-z-za und Sal-z
      if (q.length > 1 && low.includes(q)) { out.push({ r, sc: 1 }); continue; }
      const ing = r.items.find((i) => starts(i.name.toLowerCase()))
        || (q.length > 2 ? r.items.find((i) => i.name.toLowerCase().includes(q)) : null);
      if (ing) { out.push({ r, sc: 2, via: ing.name }); continue; }
      rest.push(r);
    }
    // 🤓 Tippfehler-Hilfe: „Lasange“ -> „Meintest du Lasagne?“
    if (q.length >= 4 && !out.some((m) => m.sc <= 1)) {
      const maxD = q.length > 6 ? 2 : 1;
      for (const r of rest) {
        const low = r.name.toLowerCase();
        let d = 9;
        for (const w of [low, ...low.split(/[\s\-–,/()]+/)]) {
          if (!w) continue;
          d = Math.min(d, editDistance(q, w), q.length < w.length ? editDistance(q, w.slice(0, q.length)) : 9);
        }
        if (d <= maxD) out.push({ r, sc: 3 + d, fuzzy: true });
      }
    }
    return out.sort((a, b) => a.sc - b.sc);
  }

  _markHit(name, q) {
    const at = q ? name.toLowerCase().indexOf(q) : -1;
    return at < 0 ? esc(name) : esc(name.slice(0, at)) + "<mark>" + esc(name.slice(at, at + q.length)) + "</mark>" + esc(name.slice(at + q.length));
  }

  _recipeSearchHtml(id) {
    return `<div class="srow rsearch"><ha-icon class="prev" icon="mdi:magnify"></ha-icon><input class="grow" id="${id}" type="search" placeholder="Rezept oder Zutat suchen …" value="${esc(this._recipeFilter || "")}" autocomplete="off"><button class="iconbtn rclear" data-act="recipe-search-clear" title="Suche löschen" ${this._recipeFilter ? "" : "hidden"}><ha-icon icon="mdi:close"></ha-icon></button></div>`;
  }

  _renderRecipes() {
    this._parkForm();
    const ov = this.$("otherView");
    const count = (this._data.recipes || []).length;
    // Suchfeld nur einmal bauen – sonst springt beim Tippen der Cursor raus
    if (!ov.querySelector("#recipeList") || !!ov.querySelector("#recipeSearch") !== count > 0) {
      ov.innerHTML = `<div class="sec"><h3><ha-icon icon="mdi:chef-hat"></ha-icon>Rezepte</h3>${
        count ? this._recipeSearchHtml("recipeSearch") : ""}<div id="recipeList"></div></div>`;
    }
    this._renderRecipeList();
  }

  _renderRecipeList() {
    const box = this.$("recipeList");
    if (!box) return;
    const q = (this._recipeFilter || "").trim().toLowerCase();
    this.shadowRoot.querySelectorAll(".rclear").forEach((b) => { b.hidden = !q; });
    const html = [];
    if (!(this._data.recipes || []).length) {
      html.push(`<div class="empty"><ha-icon icon="mdi:pot-steam-outline"></ha-icon>Noch keine Rezepte. 🐟<br>Anlegen und bearbeiten kannst du sie über das ⚙️-Zahnrad.</div>`);
    }
    const found = this._recipeMatches(q);
    if (q && !found.length) html.push(`<div class="empty"><ha-icon icon="mdi:magnify-close"></ha-icon>Nix gefunden für „${esc(q)}“. 🕵️<br>Weniger Buchstaben probieren?</div>`);
    const onList = (r) => this._data.items.filter((i) => i.recipe_id === r.id && !i.checked).length;
    for (const { r, via, fuzzy } of found) {
      const names = r.items.map((i) => i.name + (i.for_whom ? ` (für ${i.for_whom})` : "")).join(", ");
      const sub = fuzzy ? `🤓 Meintest du das? · ${r.items.length} Zutaten`
        : via ? `🥕 enthält ${this._markHit(via, q)} · ${r.items.length} Zutaten`
        : `${r.items.length} Zutaten · ${esc(names)}`;
      html.push(`
        <div class="recipe" data-id="${r.id}">
          <ha-icon icon="${esc(r.icon || "mdi:silverware-fork-knife")}"></ha-icon>
          <div class="rname"><b>${via || fuzzy ? esc(r.name) : this._markHit(r.name, q)}${this._recipePhotoBtn(r)}</b><small>${sub}</small></div>
          <div class="rbtns">
            <button class="primary" data-act="recipe-apply" title="Zutaten auswählen"><ha-icon icon="mdi:cart-plus"></ha-icon>Auf die Liste</button>
            ${onList(r) ? `<button class="btn" data-act="recipe-unapply" title="Alle offenen Zutaten dieses Rezepts von der Liste nehmen"><ha-icon icon="mdi:cart-remove"></ha-icon>Von der Liste (${onList(r)})</button>` : ""}
          </div>
        </div>
        <div class="rtools" data-id="${r.id}">
          ${(r.heat || []).length ? `<span class="rheat">${esc(heatText(r.heat[0]))}</span>` : ""}
          ${(r.steps || "").trim() ? `<button class="btn" data-act="recipe-cook"><ha-icon icon="mdi:fire"></ha-icon>Kochen</button>` : ""}
          <button class="btn" data-act="recipe-share"><ha-icon icon="mdi:share-variant-outline"></ha-icon>Teilen</button>
        </div>${this._pickRecipe === r.id ? this._pickHtml(r) : ""}`);
    }
    box.innerHTML = html.join("");
  }

  // ⚙️ Rezepte in den Einstellungen – gleiche Suche
  _renderSetRecipeList() {
    const box = this.$("setRecipeList");
    if (!box) return;
    const q = (this._recipeFilter || "").trim().toLowerCase();
    this.shadowRoot.querySelectorAll(".rclear").forEach((b) => { b.hidden = !q; });
    const found = this._recipeMatches(q);
    box.innerHTML = (q && !found.length ? `<p class="hint">Nix gefunden für „${esc(q)}“ 🕵️</p>` : "") + found.map(({ r, via, fuzzy }) => `
      <div class="recipe" data-id="${r.id}">
        <ha-icon icon="${esc(r.icon || "mdi:silverware-fork-knife")}"></ha-icon>
        <div class="rname"><b>${via || fuzzy ? esc(r.name) : this._markHit(r.name, q)}${this._recipePhotoBtn(r)}</b><small>${
          fuzzy ? "🤓 Meintest du das? · " : via ? `🥕 enthält ${this._markHit(via, q)} · ` : ""}${r.items.length} Zutaten${r.steps ? " · 📖 Anleitung" : " · ohne Anleitung"}${(r.heat || []).length ? " · 🔥 Backofen & Co." : ""}</small></div>
        <button class="iconbtn" data-act="recipe-edit" title="Bearbeiten"><ha-icon icon="mdi:pencil-outline"></ha-icon></button>
      </div>`).join("");
  }

  // 🍳 Erst fragen: Welche Zutaten sollen auf die Liste?
  _pickHtml(r) {
    const open = new Set(this._data.items.filter((i) => !i.checked).map((i) => i.name.toLowerCase()));
    const sel = this._pickSel;
    const rows = r.items.map((it, n) => {
      const on = sel.has(n);
      const info = [it.quantity, it.note, it.for_whom ? "für " + it.for_whom : ""].filter(Boolean).map(esc).join(" · ");
      return `<div class="pickrow ${on ? "on" : ""} ${it.basic ? "basic" : ""}" data-act="pick-toggle" data-n="${n}">
        <ha-icon icon="${on ? "mdi:checkbox-marked" : "mdi:checkbox-blank-outline"}"></ha-icon>
        <span class="pname">${esc(it.name)}${info ? `<small>${info}</small>` : ""}</span>
        ${open.has(it.name.toLowerCase()) ? `<span class="phint">steht schon drauf</span>` : it.basic ? `<span class="pbasic">🧂 haben wir immer</span>` : ""}
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
      ? { id: recipe.id, name: recipe.name, icon: recipe.icon, steps: recipe.steps || "", heat: (recipe.heat || []).map((h) => ({ ...h })), items: recipe.items.map((i) => ({ ...i })) }
      : { id: null, name: "", icon: "mdi:silverware-fork-knife", items: [], heat: [] };
    this._view = "recipe";
    this._draftRendered = false;
    this._renderAll();
  }

  _renderRecipeEditor() {
    const dr = this._draft;
    this._draftRendered = true;
    this._parkForm();
    this.$("otherView").innerHTML = `
      <div class="sec">
        <h3><ha-icon icon="mdi:chef-hat"></ha-icon>${dr.id ? "Rezept bearbeiten" : "Neues Rezept"}</h3>
        <div class="srow recipehead">
          <ha-icon class="prev" id="rIconPrev" icon="${esc(dr.icon)}"></ha-icon>
          <input class="grow" id="rName" value="${esc(dr.name)}" placeholder="Name, z. B. Freitags Fisch">
          ${this._iconField(dr.icon, 'id="rIcon"')}
        </div>
        <div class="picker" hidden></div>
        <div class="photorow" id="rPhotoRow"></div>
        <h3 class="rsub"><ha-icon icon="mdi:food-apple-outline"></ha-icon>Zutaten
          <button class="btn rimportbtn" data-act="rimport-toggle"><ha-icon icon="mdi:clipboard-text-outline"></ha-icon>Rezept einfügen</button></h3>
        <div class="rimport" id="rImport" hidden>
          <textarea id="rImportText" rows="6" placeholder="Zutaten-Liste hier einfügen – eine Zutat pro Zeile, z. B.&#10;200 g Mehl&#10;3 Eier&#10;½ l Milch&#10;&#10;…oder einfach einen Rezept-Link (z. B. von Chefkoch)."></textarea>
          <div class="btnrow"><button class="btn" data-act="rimport-toggle">Abbrechen</button><button class="primary addbtn btn" data-act="rimport-go"><ha-icon icon="mdi:check-bold"></ha-icon>Übernehmen</button></div>
        </div>
        <div class="redithint" id="rEditHint" hidden>✏️ Du bearbeitest eine Zutat – ✔ speichert sie. <button class="linkbtn" data-act="ritem-edit-cancel">Abbrechen</button></div>
        <div id="rFormSlot"></div>
        <div id="rItems"></div>
        <h3 class="rsub"><ha-icon icon="mdi:stove"></ha-icon>Backofen &amp; Co.</h3>
        <div id="rHeat"></div>
        <div class="btnrow"><button class="btn" data-act="heat-add"><ha-icon icon="mdi:plus"></ha-icon>Einstellung (Grad, Minuten …)</button></div>
        <h3 class="rsub"><ha-icon icon="mdi:chef-hat"></ha-icon>Zubereitung</h3>
        <textarea id="rSteps" class="rsteps" rows="5" placeholder="Ein Schritt pro Zeile, z. B.&#10;Nudeln 10 Minuten kochen&#10;Soße anrühren">${esc(dr.steps || "")}</textarea>
        <p class="hint">Eintragen geht genau wie in der Liste: Name tippen (mit Vorschlägen), 🔢 Menge, 📝 Notiz, 👤 Für wen, 📷 Foto, ▥ Barcode (auch „📦 Mehrere scannen“) – dann ✔. „Wie zuletzt“ = Geschäft & Kategorie, die bei diesem Produkt zuletzt benutzt wurden.</p>
        <div class="btnrow" style="justify-content:space-between">
          ${dr.id ? `<button class="btn danger" data-act="recipe-delete"><ha-icon icon="mdi:trash-can-outline"></ha-icon>Löschen</button>` : "<span></span>"}
          <span style="display:flex;gap:6px">
            <button class="btn" data-act="recipe-cancel">Abbrechen</button>
            <button class="btn primary" data-act="recipe-save"><ha-icon icon="mdi:content-save-outline"></ha-icon>Speichern</button>
          </span>
        </div>
      </div>`;
    this._enterRecipeForm();
    this._renderRecipeItems();
    this._renderHeat();
    this._renderRecipePhoto();
  }

  // 📷 Foto vom Rezept (fertiges Gericht, Kochbuch-Seite …)
  _recipePhotoKey(id) { return `rezept#${id}`.toLowerCase(); }

  _recipePhotoBtn(r) {
    const key = this._recipePhotoKey(r.id);
    return this._hasPhoto(key)
      ? ` <button class="photobtn" data-act="photo-view" data-name="${esc(key)}" data-title="${esc(r.name)}" title="Rezept-Foto ansehen"><ha-icon icon="mdi:camera"></ha-icon></button>` : "";
  }

  _renderRecipePhoto() {
    const box = this.$("rPhotoRow");
    const dr = this._draft;
    if (!box || !dr) return;
    const saved = dr.id && !dr.photoRemove && this._hasPhoto(this._recipePhotoKey(dr.id));
    const has = !!dr.photoData || saved;
    box.innerHTML = `
      <button type="button" class="btn ${has ? "on" : ""}" data-act="rphoto-take"><ha-icon icon="${has ? "mdi:camera" : "mdi:camera-plus-outline"}"></ha-icon>${has ? "Rezept-Foto ändern" : "Rezept-Foto"}</button>
      ${has ? `<button type="button" class="btn" data-act="rphoto-view"><ha-icon icon="mdi:image-outline"></ha-icon>Ansehen</button>
      <button type="button" class="btn danger" data-act="rphoto-remove"><ha-icon icon="mdi:image-remove-outline"></ha-icon>Löschen</button>` : ""}`;
  }

  async _importRecipe() {
    const ta = this.$("rImportText");
    const text = (ta?.value || "").trim();
    if (!text) { ta?.classList.remove("shake"); void ta?.offsetWidth; ta?.classList.add("shake"); return; }
    const btn = this.shadowRoot.querySelector('[data-act="rimport-go"]');
    btn?.classList.add("busy");
    try {
      const res = await this._ws({ type: "einkaufsliste/recipe/import", text });
      const dr = this._draft;
      let added = 0;
      for (const it of res.items) {
        const ing = { name: it.name, quantity: it.quantity || null, note: it.note || null, for_whom: null,
          store_id: it.store_id || null, category_id: it.category_id || null };
        if (dr.items.some((a) => this._gkey(a) === this._gkey(ing))) continue;
        dr.items.push(ing);
        added++;
      }
      const nameEl = this.$("rName");
      if (res.name && !nameEl.value.trim()) nameEl.value = res.name;
      const stepsEl = this.$("rSteps");
      if (res.steps && stepsEl && !stepsEl.value.trim()) stepsEl.value = res.steps;
      const hasPhoto = dr.photoData || (dr.id && !dr.photoRemove && this._hasPhoto(this._recipePhotoKey(dr.id)));
      if (res.image && !hasPhoto) { dr.photoData = res.image; dr.photoRemove = false; }
      ta.value = "";
      this.$("rImport").hidden = true;
      this._renderRecipeItems();
      this._renderRecipePhoto();
      this._toast(`📋 ${added} Zutaten übernommen${res.image && !hasPhoto ? " – samt Foto 📷" : ""}. Kurz drüberschauen, dann Speichern!`);
    } catch (_) { /* Meldung kam schon */ }
    btn?.classList.remove("busy");
  }

  // 🔥 Backofen & Co. im Rezept-Editor
  _renderHeat() {
    const box = this.$("rHeat");
    if (!box) return;
    const rows = this._draft.heat || [];
    const opt = (v, cur) => `<option value="${esc(v)}" ${v === cur ? "selected" : ""}>${esc(v)}</option>`;
    box.innerHTML = rows.map((h, n) => {
      const dev = HEAT_DEVICES[h.device] || HEAT_DEVICES.Backofen;
      const modes = [...dev.modes];
      if (h.mode && !modes.includes(h.mode)) modes.push(h.mode);
      return `<div class="heatrow" data-n="${n}">
        <select data-hf="device">${Object.keys(HEAT_DEVICES).map((d) => `<option value="${d}" ${d === (h.device || "Backofen") ? "selected" : ""}>${HEAT_DEVICES[d].icon} ${d}</option>`).join("")}</select>
        <select data-hf="mode"><option value="">– Modus –</option>${modes.map((m) => opt(m, h.mode)).join("")}</select>
        <div class="hnums">
          <input data-hf="temp" type="number" inputmode="numeric" min="0" value="${esc(h.temp ?? "")}" placeholder="${dev.unit === "W" ? "Watt" : dev.unit ? "°C" : "–"}">
          <span class="hmin"><input data-hf="minutes" type="number" inputmode="numeric" min="0" value="${esc(h.minutes ?? "")}" placeholder="Min"><span>–</span><input data-hf="minutes_to" type="number" inputmode="numeric" min="0" value="${esc(h.minutes_to ?? "")}" placeholder="bis"></span>
        </div>
        <label><input data-hf="preheat" type="checkbox" ${h.preheat ? "checked" : ""}> vorheizen</label>
        <div class="hfoot">
          <input data-hf="note" type="text" value="${esc(h.note || "")}" placeholder="Hinweis, z. B. mittlere Schiene">
          <button class="iconbtn" data-act="heat-remove" title="Entfernen"><ha-icon icon="mdi:trash-can-outline"></ha-icon></button>
        </div>
      </div>`;
    }).join("") || `<p class="hint">Noch nichts – z. B. Backofen · Ober-/Unterhitze · 200 °C · 25 Min.</p>`;
  }

  _readHeat() {
    const box = this.$("rHeat");
    if (!box || !this._draft) return;
    this._draft.heat = [...box.querySelectorAll(".heatrow")].map((row) => {
      const v = (f) => row.querySelector(`[data-hf=${f}]`);
      return { device: v("device").value, mode: v("mode").value || null, temp: v("temp").value || null,
        minutes: v("minutes").value || null, minutes_to: v("minutes_to").value || null, preheat: v("preheat").checked, note: v("note").value.trim() || null };
    });
  }

  // Das Eingabe-Formular der Liste wandert in den Rezept-Editor – so ist alles genau gleich
  _enterRecipeForm() {
    const form = this.$("addForm");
    const slot = this.$("rFormSlot");
    if (!form || !slot) return;
    slot.appendChild(form);
    this._formMode = "recipe";
    this._rEditIdx = null;
    form.classList.remove("fixed");
    this._clearForm();
    this.$("inStore").hidden = false;
    this.$("inStore").value = "";
    this.$("inStore").options[0].textContent = "🛒 Wie zuletzt";
    this.$("inCat").options[0].textContent = "📦 Wie zuletzt";
    this.$("inName").placeholder = "Zutat, z. B. Fischstäbchen";
    this.$("btnScan").classList.remove("instore");
    this.$("btnScan").title = "Barcode scannen";
    this.$("tBasic").hidden = false;
    this.$("rEditHint").hidden = true;
  }

  _parkForm() {
    const form = this.$("addForm");
    const home = this.$("listView");
    if (!form || !home || form.parentElement === home) return;
    home.insertBefore(form, this.$("list"));
    this._formMode = null;
    this._rEditIdx = null;
    this.$("tBasic").hidden = true;
    this.$("inName").placeholder = "Was brauchen wir?";
    this._clearForm();
    this._lastTab = null; // Auswahl-Felder neu aufbauen (Geschäft passend zum Reiter)
  }

  _renderRecipeItems() {
    const box = this.$("rItems");
    if (!box) return;
    const items = this._draft.items;
    if (!items.length) {
      box.innerHTML = `<p class="hint">Noch keine Zutaten – oben eintragen und ✔ tippen. 🥕</p>`;
      return;
    }
    box.innerHTML = items.map((it, n) => {
      const st = this._store(it.store_id);
      const cat = this._cat(it.category_id);
      const pk = this._pk(it.name, it.note);
      const meta = [
        `<span class="chip" style="--c:${esc(st?.color || "#888")}">${esc(st?.name || "Wie zuletzt")}</span>`,
        it.note ? `<span>📝 ${esc(it.note)}</span>` : "",
        it.barcode || this._barcodesOf(pk).length ? `<span class="bc">▥</span>` : "",
        it.basic ? `<span>🧂 Grundvorrat</span>` : "",
        cat ? `<span>${esc(cat.name)}</span>` : "",
      ].filter(Boolean).join("");
      return `<div class="item rrow ${this._rEditIdx === n ? "editing" : ""}" data-n="${n}" style="--cc:${esc(cat?.color || "transparent")}">
        <div class="txt">
          <div class="line"><span class="name">${esc(it.name)}</span>${it.quantity ? `<span class="qty">${esc(it.quantity)}</span>` : ""}${it.for_whom ? this._forWhomHtml(it.for_whom) : ""}${this._hasPhoto(pk) ? `<button class="photobtn" data-act="photo-view" data-name="${esc(pk)}" title="Foto ansehen"><ha-icon icon="mdi:camera"></ha-icon></button>` : ""}</div>
          <div class="meta">${meta}</div>
        </div>
        <button class="iconbtn" data-act="ritem-edit" title="Bearbeiten"><ha-icon icon="mdi:pencil-outline"></ha-icon></button>
        <button class="iconbtn" data-act="ritem-remove" title="Zutat entfernen"><ha-icon icon="mdi:trash-can-outline"></ha-icon></button>
      </div>`;
    }).join("");
  }

  async _addRecipeIngredient() {
    const dr = this._draft;
    let raw = this.$("inName").value.trim();
    const val = (id) => this.$(id).value.trim() || null;
    let qty = val("inQty");
    if (!qty) { const sp = splitQty(raw); raw = sp.name; qty = sp.qty; } // „250g nudeln“ -> Nudeln · 250 g
    const name = raw.charAt(0).toUpperCase() + raw.slice(1);
    const ing = {
      name,
      quantity: qty,
      note: val("inNote") ? val("inNote").charAt(0).toUpperCase() + val("inNote").slice(1) : null,
      for_whom: this.$("inFor").value || null,
      store_id: this.$("inStore").value || null,
      category_id: this.$("inCat").value || null,
      basic: !!this._rBasic,
    };
    const idx = this._rEditIdx;
    if (this._pendingBarcode) ing.barcode = this._pendingBarcode;
    else if (idx != null && dr.items[idx]?.barcode) ing.barcode = dr.items[idx].barcode;
    const same = (a) => this._gkey(a) === this._gkey(ing) && (a.store_id || "") === (ing.store_id || "");
    if (dr.items.some((a, n) => n !== idx && same(a))) {
      this._toast(`„${name}“ steht schon im Rezept 😉`);
      const el = this.$("inName");
      el.classList.remove("shake"); void el.offsetWidth; el.classList.add("shake");
      return;
    }
    if (idx != null && dr.items[idx]) dr.items[idx] = ing;
    else dr.items.push(ing);
    const photo = this._newPhoto;
    this._rEditIdx = null;
    this.$("rEditHint").hidden = true;
    this._clearForm();
    this.$("inStore").value = "";
    this._renderRecipeItems();
    this.$("inName").focus();
    if (photo) await this._savePhoto({ name: this._pk(ing.name, ing.note), button: null, quiet: true, keepEdit: true }, photo);
    this._renderRecipeItems();
  }

  _editRecipeIngredient(n) {
    const it = this._draft.items[n];
    if (!it) return;
    this._clearForm();
    this._rEditIdx = n;
    this.$("inName").value = it.name || "";
    this.$("inQty").value = it.quantity || "";
    this.$("inNote").value = it.note || "";
    this.$("inNote").hidden = !it.note;
    const f = this.$("inFor");
    if (it.for_whom && ![...f.options].some((o) => o.value === it.for_whom)) {
      const o = document.createElement("option"); o.value = o.textContent = it.for_whom; f.appendChild(o);
    }
    f.value = it.for_whom || "";
    this.$("inStore").value = it.store_id || "";
    this.$("inCat").value = it.category_id || "";
    this._catManual = !!it.category_id;
    this._setBasic(it.basic);
    this._renderQtyChips();
    this._renderForChips();
    this._updateTools();
    this.$("rEditHint").hidden = false;
    this._renderRecipeItems();
    this.$("inName").focus();
  }

  _readDraft() {
    const dr = this._draft;
    dr.name = this.$("rName").value;
    dr.icon = this.$("rIcon").value;
    if (this.$("rSteps")) dr.steps = this.$("rSteps").value;
    this._readHeat();
  }

  async _saveRecipe() {
    this._readDraft();
    const dr = this._draft;
    const items = dr.items.filter((i) => i.name).map((i) => {
      const o = { name: i.name };
      for (const k of ["quantity", "note", "for_whom", "store_id", "category_id", "barcode"]) if (i[k]) o[k] = i[k];
      if (i.basic) o.basic = true;
      return o;
    });
    if (this.$("inName").value.trim() && !confirm("Oben steht noch eine Zutat, die nicht mit ✔ übernommen wurde. Trotzdem speichern?")) return;
    const heat = (dr.heat || []).filter((h) => h.mode || h.temp || h.minutes || h.note)
      .map((h) => ({ device: h.device || "Backofen", mode: h.mode || null, temp: h.temp ? Number(h.temp) : null,
        minutes: h.minutes ? Number(h.minutes) : null, minutes_to: h.minutes_to ? Number(h.minutes_to) : null, preheat: !!h.preheat, note: h.note || null }));
    const msg = { name: dr.name.trim(), icon: dr.icon || null, items, steps: (dr.steps || "").trim() || null, heat };
    if (!msg.name) { this.$("rName").classList.add("shake"); return; }
    try {
      const saved = dr.id
        ? await this._ws({ type: "einkaufsliste/recipe/update", recipe_id: dr.id, ...msg })
        : await this._ws({ type: "einkaufsliste/recipe/add", ...msg });
      const rid = saved?.id || dr.id;
      if (rid && dr.photoData) {
        await this._ws({ type: "einkaufsliste/photo/set", name: this._recipePhotoKey(rid), data: dr.photoData }).catch(() => {});
        this._photoCache.delete(this._recipePhotoKey(rid));
      } else if (rid && dr.photoRemove && this._hasPhoto(this._recipePhotoKey(rid))) {
        await this._ws({ type: "einkaufsliste/photo/remove", name: this._recipePhotoKey(rid) }).catch(() => {});
      }
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
    // ✨ höchstens 24 Stunden lang
    if (Date.now() - Date.parse(item.added_at || 0) > 864e5) return false;
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

  // 🔴 Blase: zählt, was andere eingetragen haben, seit DU diesen Reiter zuletzt angetippt hast
  // (wie bei WhatsApp – bloß „Alle“ anschauen lässt die Blasen der Geschäfte stehen)
  _newCount(fn) {
    const seen = this._mySeen();
    if (!seen) return 0;
    const me = this._hass?.user;
    const myName = this._myName();
    return this._data.items.filter((i) => {
      if (!fn(i) || i.checked) return false;
      if (i.added_by_id ? i.added_by_id === me?.id : i.added_by && i.added_by === myName) return false;
      const key = i.store_id || "none";
      const t = seen["b:" + key] || seen["b:all"];
      return !!t && i.added_at > t;
    }).length;
  }

  _markSeen() {
    if (!this._data || this._view !== "list" || !this.isConnected) return;
    const uid = this._hass?.user?.id;
    if (!uid) return;
    const tab = this._activeTab;
    const seen = this._mySeen();
    if (!seen) {
      // erstes Mal: alles bisherige gilt als gesehen
      if (!this._seenInit) { this._seenInit = true; this._ws({ type: "einkaufsliste/seen", store: "init" }).catch(() => {}); }
      return;
    }
    const fn = tab === "all" ? () => true : tab === "none" ? (i) => !i.store_id : (i) => i.store_id === tab;
    const sendSeen = (key) => {
      if (this._seenSending?.has(key)) return;
      (this._seenSending ||= new Set()).add(key);
      this._ws({ type: "einkaufsliste/seen", store: key }).catch(() => {}).finally(() => this._seenSending.delete(key));
    };
    // ✨ angeschaut
    if (this._data.items.some((i) => fn(i) && this._isNewFor(i, seen)) || (tab === "all" && !seen.all)) sendSeen(tab);
    // 🔴 Blase: nur der Reiter, der gerade offen ist (nicht „Alle“)
    if (tab !== "all" && this._newCount(fn)) sendSeen("b:" + tab);
  }

  // Ein Produkt = Name + Notiz (Käse · Gouda ≠ Käse · Leerdammer) – für Fotos und Barcodes
  // Ein Produkt = Name + Notiz – danach richten sich Fotos und Barcodes.
  // „Für wen“ zählt hier absichtlich nicht: gleiche Packung, gleicher Barcode, gleiches Foto.
  _pk(name, note) {
    const n = String(name || "").trim().toLowerCase();
    const t = String(note || "").trim().toLowerCase();
    return t ? `${n}|${t}` : n;
  }

  _pkLabel(key) {
    const k = String(key).toLowerCase();
    const item = this._data?.items.find((i) => this._pk(i.name, i.note) === k);
    if (item) return [item.name, item.note].filter(Boolean).join(" · ");
    return String(key).split("|").filter(Boolean).join(" · ");
  }

  // 👤 Jede Person hat ihre Farbe (in den Einstellungen änderbar)
  _personColor(name) {
    const p = (this._data?.persons || []).find((x) => x.name.toLowerCase() === String(name || "").toLowerCase());
    return p?.color || null;
  }

  _forWhomHtml(name) {
    const c = this._personColor(name);
    return `<span class="who forwhom ${c ? "colored" : ""}"${c ? ` style="--pc:${esc(c)}"` : ""}>${c ? "" : "("}für ${esc(name)}${c ? "" : ")"}</span>`;
  }

  _barcodesOf(key) {
    return (key && this._data?.barcodes_by_name?.[String(key).toLowerCase()]) || [];
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
      const data = await editImage(file, 900, 0.8);
      if (!data) return;
      this._newPhoto = data;
      this._updateNewPhotoBtn();
      this._toast("📸 Foto gemerkt – kommt beim Hinzufügen mit");
    } catch (_) {
      this._toast("Das Foto konnte nicht gelesen werden 🙈");
    }
  }

  // Symbol-Leiste: ein Tipp öffnet/schließt genau ein Feld
  // 📝 Notiz-Vorschläge: eure häufigsten Notizen (zum getippten Produkt zuerst)
  _renderNoteChips() {
    const box = this.$("noteChips");
    const input = this.$("inNote");
    if (!box || !input) return;
    if (input.hidden || !this._data) { box.hidden = true; return; }
    const name = (this.$("inName").value || "").trim().toLowerCase();
    const typed = input.value.trim().toLowerCase();
    const score = new Map();
    const all = [...this._data.items, ...(this._data.recipes || []).flatMap((r) => r.items)];
    for (const i of all) {
      const n = String(i.note || "").trim();
      if (!n) continue;
      const k = n.toLowerCase();
      const e = score.get(k) || { text: n, count: 0, same: 0 };
      e.count++;
      if (name && i.name.toLowerCase() === name) e.same++;
      score.set(k, e);
    }
    const list = [...score.values()]
      .filter((e) => e.text.toLowerCase() !== typed && (!typed || e.text.toLowerCase().startsWith(typed)))
      .sort((a, b) => b.same - a.same || b.count - a.count)
      .slice(0, 6);
    box.hidden = !list.length;
    const key = list.map((e) => e.text).join("|");
    if (box._key === key) return;
    box._key = key;
    box.innerHTML = list.map((e) => `<button type="button" class="chip2" data-act="note-chip" data-v="${esc(e.text)}">📝 ${esc(e.text)}</button>`).join("");
  }

  _setBasic(on) {
    this._rBasic = !!on;
    const b = this.$("tBasic");
    if (b) b.classList.toggle("on", this._rBasic);
  }

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
    this._setBasic(false);
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
      .map((p) => `<button type="button" class="chip2 pchip ${p.name === val ? "sel" : ""}" style="--pc:${esc(p.color || "#9e9e9e")}" data-act="for-chip" data-v="${esc(p.name)}"><span class="pdot"></span>${esc(p.name)}</button>`)
      .join("");
  }

  _updateTools() {
    this._renderNoteChips();
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
      data = await editImage(file, 900, 0.8);
    } catch (_) {
      this._toast("Das Foto konnte nicht gelesen werden 🙈");
      return;
    }
    if (!data) return; // abgebrochen
    if (target.recipeDraft && this._draft) {
      // Rezept-Foto: wird beim Speichern mitgespeichert
      this._draft.photoData = data;
      this._draft.photoRemove = false;
      this._renderRecipePhoto();
      this._toast("📷 Rezept-Foto ausgewählt – wird beim Speichern mitgespeichert");
      return;
    }
    this._savePhoto(target, data);
  }

  async _savePhoto(target, data) {
    try {
      this._toast("📸 Foto wird gespeichert …");
      await this._ws({ type: "einkaufsliste/photo/set", name: target.name, data, add: !!target.add });
      for (const k of [...this._photoCache.keys()]) if (k.startsWith(target.name.toLowerCase())) this._photoCache.delete(k);
      if (target.onDone) { target.onDone(); return; }
      this._toast(`📸 Foto für „${this._pkLabel(target.name)}“ gespeichert`);
      if (target.button) {
        target.button.classList.add("on");
        target.button.querySelector("ha-icon")?.setAttribute("icon", "mdi:camera");
      } else if (target.keepEdit) {
        /* Rezept-Editor bleibt offen */
      } else {
        this._editing = null;
        this._renderList();
      }
    } catch (_) { /* Meldung kam schon */ }
  }

  async _photoData(key, index) {
    const updated = this._data?.photos?.[key];
    const ck = `${key}#${index}`;
    const cached = this._photoCache.get(ck);
    if (cached && cached.updated === updated) return cached.data;
    const res = await this._ws({ type: "einkaufsliste/photo/get", name: key, index });
    this._photoCache.set(ck, { updated, data: res.data });
    return res.data;
  }

  // 📷 Foto-Galerie: blättern, weitere Fotos dazu, einzelne löschen
  async _openPhoto(name, title, start = 0) {
    const key = String(name).toLowerCase();
    const label = title || this._pkLabel(name);
    const count = () => (this._data?.photo_counts?.[key] || (this._data?.photos?.[key] ? 1 : 0));
    if (!count()) return;
    let idx = Math.min(start, count() - 1);
    const ov = makeOverlay();
    const img = document.createElement("img");
    Object.assign(img.style, { maxWidth: "100%", maxHeight: "66vh", borderRadius: "14px", boxShadow: "0 10px 40px rgba(0,0,0,.6)" });
    const cap = document.createElement("div");
    Object.assign(cap.style, { font: "500 17px Roboto, sans-serif", marginTop: "12px", textAlign: "center" });
    const nav = document.createElement("div");
    Object.assign(nav.style, { display: "flex", gap: "8px", alignItems: "center", margin: "10px 0" });
    const prev = ovButton("‹"), next = ovButton("›"), pos = document.createElement("span");
    pos.style.minWidth = "48px"; pos.style.textAlign = "center";
    nav.append(prev, pos, next);
    const row = document.createElement("div");
    Object.assign(row.style, { display: "flex", gap: "8px", flexWrap: "wrap", justifyContent: "center" });
    const bAdd = ovButton("➕ Foto dazu"), bDel = ovButton("🗑️ Dieses löschen"), bClose = ovButton("Schließen", true);
    row.append(bAdd, bDel, bClose);
    ov.append(img, cap, nav, row);
    const show = async () => {
      const n = count();
      if (!n) { close(); return; }
      idx = Math.max(0, Math.min(idx, n - 1));
      pos.textContent = `${idx + 1} / ${n}`;
      nav.style.visibility = n > 1 ? "visible" : "hidden";
      cap.textContent = label;
      bAdd.style.display = n >= 6 || key.startsWith("rezept#") ? "none" : "";
      try { img.src = await this._photoData(key, idx); } catch (_) { close(); }
    };
    const close = () => { ov.remove(); document.removeEventListener("keydown", onKey); };
    const onKey = (e) => {
      if (e.key === "Escape") close();
      if (e.key === "ArrowLeft") { idx--; show(); }
      if (e.key === "ArrowRight") { idx++; show(); }
    };
    document.addEventListener("keydown", onKey);
    prev.onclick = () => { idx = (idx - 1 + count()) % count(); show(); };
    next.onclick = () => { idx = (idx + 1) % count(); show(); };
    // wischen zum Blättern
    let sx = null;
    img.addEventListener("pointerdown", (e) => { sx = e.clientX; });
    img.addEventListener("pointerup", (e) => {
      if (sx == null) return;
      const dx = e.clientX - sx; sx = null;
      if (Math.abs(dx) > 40 && count() > 1) { idx += dx < 0 ? 1 : -1; idx = (idx + count()) % count(); show(); }
    });
    bClose.onclick = close;
    bDel.onclick = async () => {
      if (!confirm("Dieses Foto löschen?")) return;
      try {
        await this._ws({ type: "einkaufsliste/photo/remove", name: key, index: idx });
        for (const k of [...this._photoCache.keys()]) if (k.startsWith(key + "#")) this._photoCache.delete(k);
        this._toast("Foto gelöscht 🗑️");
        setTimeout(show, 300);
      } catch (_) { /* Meldung kam schon */ }
    };
    bAdd.onclick = () => {
      this._photoTarget = { name: key, add: true, onDone: () => { this._toast("📸 Foto dazu gespeichert"); idx = count(); setTimeout(show, 400); } };
      this._pickFile("photoFile");
    };
    show();
  }

  // 👨‍🍳 Koch-Modus: Schritt für Schritt, groß, Bildschirm bleibt an
  async _cookMode(r) {
    const steps = String(r.steps || "").split(/\n+/).map((x) => x.trim()).filter(Boolean);
    const heat = r.heat || [];
    if (!steps.length && !heat.length) return;
    if (!steps.length) steps.push("Alles bereit? Dann los! 👨‍🍳");
    let idx = 0;
    const ov = makeOverlay();
    Object.assign(ov.style, { background: "#111", justifyContent: "flex-start", overflowY: "auto", touchAction: "pan-y",
      paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 90px)" });
    const wrapW = { width: "100%", maxWidth: "700px" };
    const head = document.createElement("div");
    Object.assign(head.style, { ...wrapW, display: "flex", alignItems: "center", gap: "10px" });
    const title = document.createElement("div");
    title.textContent = `👨‍🍳 ${r.name}`;
    Object.assign(title.style, { font: "600 18px Roboto,sans-serif", flex: "1" });
    const bIng = ovButton("🥕 Zutaten"), bClose = ovButton("✕");
    head.append(title, bIng, bClose);
    const heatBox = document.createElement("div");
    Object.assign(heatBox.style, { ...wrapW, display: heat.length ? "flex" : "none", flexDirection: "column", gap: "6px", marginTop: "14px" });
    heatBox.innerHTML = heat.map((h) => `<div style="background:#3a1f0f;border:1px solid #a64b12;color:#ffd7b5;border-radius:12px;padding:10px 12px;font:600 17px Roboto,sans-serif">${esc(heatText(h))}</div>`).join("");
    const pos = document.createElement("div");
    Object.assign(pos.style, { ...wrapW, color: "#aaa", font: "600 16px Roboto,sans-serif", margin: "28px 0 10px" });
    const text = document.createElement("div");
    Object.assign(text.style, { ...wrapW, font: "500 clamp(22px, 6vw, 34px)/1.35 Roboto,sans-serif", whiteSpace: "pre-wrap", minHeight: "4.2em" });
    const nav = document.createElement("div");
    Object.assign(nav.style, { ...wrapW, display: "flex", gap: "10px", marginTop: "22px" });
    const bPrev = ovButton("‹ Zurück"), bNext = ovButton("Weiter ›", true);
    for (const b of [bPrev, bNext]) Object.assign(b.style, { flex: "1", padding: "16px", fontSize: "18px" });
    nav.append(bPrev, bNext);
    const ing = document.createElement("div");
    Object.assign(ing.style, { ...wrapW, display: "none", font: "17px/1.6 Roboto,sans-serif", color: "#ddd", marginTop: "22px" });
    ing.innerHTML = r.items.map((i) => `• ${esc([i.quantity, i.name].filter(Boolean).join(" "))}${i.note ? ` <span style="color:#999">(${esc(i.note)})</span>` : ""}`).join("<br>");
    ov.append(head, heatBox, pos, text, nav, ing);
    const show = () => {
      pos.textContent = `Schritt ${idx + 1} von ${steps.length}`;
      text.textContent = steps[idx];
      bPrev.style.visibility = idx ? "visible" : "hidden";
      bNext.textContent = idx < steps.length - 1 ? "Weiter ›" : "✔ Fertig – guten Appetit!";
    };
    const close = () => { ov.remove(); document.removeEventListener("keydown", onKey); };
    const onKey = (e) => {
      if (e.key === "Escape") close();
      if (e.key === "ArrowRight" && idx < steps.length - 1) { idx++; show(); }
      if (e.key === "ArrowLeft" && idx) { idx--; show(); }
    };
    document.addEventListener("keydown", onKey);
    bPrev.onclick = () => { if (idx) { idx--; show(); } };
    bNext.onclick = () => { if (idx < steps.length - 1) { idx++; show(); } else close(); };
    bClose.onclick = close;
    bIng.onclick = () => { ing.style.display = ing.style.display === "none" ? "block" : "none"; };
    show();
  }

  _recipeText(r) {
    const lines = [`🍳 ${r.name}`, "", "Zutaten:"];
    for (const i of r.items) {
      lines.push(`• ${[i.quantity, i.name].filter(Boolean).join(" ")}${i.note ? ` (${i.note})` : ""}`);
    }
    if ((r.heat || []).length) {
      lines.push("", "Garen:");
      for (const h of r.heat) lines.push(`• ${heatText(h)}`);
    }
    const steps = String(r.steps || "").split(/\n+/).map((x) => x.trim()).filter(Boolean);
    if (steps.length) {
      lines.push("", "Zubereitung:");
      steps.forEach((st, n) => lines.push(`${n + 1}. ${st}`));
    }
    return lines.join("\n");
  }

  // 📤 Rezept weitergeben: WhatsApp, Teilen-Menü des Handys oder kopieren
  _shareRecipe(r) {
    const text = this._recipeText(r);
    const ov = makeOverlay();
    ov.style.touchAction = "auto";
    const card = document.createElement("div");
    Object.assign(card.style, { background: "#1e1e1e", borderRadius: "16px", padding: "18px", maxWidth: "460px", width: "100%" });
    const h = document.createElement("div");
    h.textContent = `📤 „${r.name}“ weitergeben`;
    Object.assign(h.style, { font: "600 18px Roboto,sans-serif", marginBottom: "10px" });
    const pre = document.createElement("textarea");
    pre.value = text;
    pre.readOnly = true;
    Object.assign(pre.style, { width: "100%", height: "38vh", boxSizing: "border-box", background: "#111", color: "#eee", border: "1px solid #333", borderRadius: "10px", padding: "10px", font: "14px/1.45 Roboto,sans-serif" });
    const row = document.createElement("div");
    Object.assign(row.style, { display: "flex", gap: "8px", flexWrap: "wrap", marginTop: "12px" });
    const wa = document.createElement("a");
    wa.href = `https://wa.me/?text=${encodeURIComponent(text)}`;
    wa.target = "_blank";
    wa.rel = "noopener";
    wa.textContent = "WhatsApp";
    wa.style.cssText = OV_BTN_MAIN + "text-decoration:none;display:inline-block;";
    const bShare = ovButton("Teilen …"), bCopy = ovButton("Kopieren"), bClose = ovButton("Schließen");
    if (!navigator.share) bShare.style.display = "none";
    bShare.onclick = () => navigator.share({ title: r.name, text }).catch(() => {});
    bCopy.onclick = async () => {
      let ok = false;
      try { await navigator.clipboard.writeText(text); ok = true; } catch (_) {
        pre.select();
        try { ok = document.execCommand("copy"); } catch (__) { ok = false; }
      }
      this._toast(ok ? "📋 Rezept kopiert – jetzt einfach einfügen" : "Kopieren ging nicht – bitte Text markieren und kopieren");
    };
    bClose.onclick = () => ov.remove();
    row.append(wa, bShare, bCopy, bClose);
    card.append(h, pre, row);
    ov.appendChild(card);
    ov.addEventListener("click", (e) => { if (e.target === ov) ov.remove(); });
  }

  // ℹ️ Produkt-Infos – nur auf Nachfrage (lange drücken → Infos)
  async _showProductInfo(item) {
    const codes = this._barcodesOf(this._pk(item.name, item.note));
    if (!codes.length) { this._toast("Für Infos braucht das Produkt einen Barcode ▥"); return; }
    let info;
    try {
      this._toast("ℹ️ Infos werden geladen …");
      info = await this._ws({ type: "einkaufsliste/barcode/info", code: codes[0] });
    } catch (_) { return; }
    const ov = makeOverlay();
    ov.style.justifyContent = "flex-start";
    ov.style.overflowY = "auto";
    ov.style.touchAction = "auto";
    const card = document.createElement("div");
    Object.assign(card.style, { background: "#1e1e1e", borderRadius: "16px", padding: "18px", maxWidth: "460px", width: "100%", marginTop: "4vh", lineHeight: "1.45" });
    const ns = { A: "#038141", B: "#85bb2f", C: "#fecb02", D: "#ee8100", E: "#e63e11" };
    const list = (arr) => (arr?.length ? arr.map((x) => esc(x)).join(", ") : "–");
    card.innerHTML = info.found ? `
      <div style="font:600 19px Roboto,sans-serif;margin-bottom:2px">${esc(info.name || item.name)}</div>
      <div style="color:#bbb;margin-bottom:12px">${esc([info.brand, info.quantity].filter(Boolean).join(" · ") || "")}</div>
      ${info.nutriscore ? `<div style="display:flex;align-items:center;gap:10px;margin-bottom:12px"><span style="background:${ns[info.nutriscore]};color:#fff;font:700 22px Roboto,sans-serif;border-radius:10px;padding:4px 14px">${info.nutriscore}</span><span>Nutri-Score</span></div>` : `<div style="color:#bbb;margin-bottom:12px">Kein Nutri-Score bekannt</div>`}
      <div><b>⚠️ Allergene:</b> ${list(info.allergens)}</div>
      <div><b>Kann Spuren enthalten:</b> ${list(info.traces)}</div>
      ${info.labels?.length ? `<div><b>🏷️</b> ${list(info.labels)}</div>` : ""}
      ${info.ingredients ? `<details style="margin-top:10px"><summary style="cursor:pointer">Zutaten anzeigen</summary><div style="color:#ccc;font-size:13px;margin-top:6px">${esc(info.ingredients)}</div></details>` : ""}
      <div style="color:#888;font-size:12px;margin-top:12px">Quelle: ${esc(info.source)} · Barcode ${esc(info.code)} · Angaben ohne Gewähr</div>`
      : `<div style="font:600 17px Roboto,sans-serif">Keine Infos gefunden 🤷</div><div style="color:#bbb;margin-top:6px">Die Produkt-Datenbank kennt Barcode ${esc(codes[0])} (noch) nicht.</div>`;
    const b = ovButton("Schließen", true);
    b.style.marginTop = "14px";
    b.onclick = () => ov.remove();
    card.appendChild(b);
    ov.appendChild(card);
    ov.addEventListener("click", (e) => { if (e.target === ov) ov.remove(); });
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
    const near = this._formMode !== "recipe" && this._lastNear && this._store(this._lastNear);
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
        if (this._formMode === "recipe" && this._draft) {
          // 🍳 im Rezept-Editor: gescannte Packung wird eine Zutat
          const ing = {
            name, quantity: null, note: (res.found && res.note) || null, for_whom: null,
            store_id: res.store_id && this._store(res.store_id) ? res.store_id : null,
            category_id: guess && this._cat(guess) ? guess : null, barcode: res.code || code,
          };
          if (this._draft.items.some((a) => this._gkey(a) === this._gkey(ing))) return `ℹ️ ${name} ist schon im Rezept`;
          this._draft.items.push(ing);
          stats.added++;
          this._renderRecipeItems();
          return res.found ? `✅ ${name} ist im Rezept` : `❓ Unbekannt – später umbenennen`;
        }
        try {
          await this._hass.callWS({
            type: "einkaufsliste/item/add",
            via: "scan",
            name,
            ...(res.found && res.note ? { note: res.note } : {}),
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
    this._toast(`📦 ${stats.added} ${this._formMode === "recipe" ? "Zutaten ins Rezept übernommen" : "Artikel eingetragen"}${stats.unknown ? ` – ${stats.unknown}× ❓ bitte noch umbenennen` : ""}`);
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
        const want = this._pk(res.name, res.note);
        let open = this._data.items.filter((i) => !i.checked && this._pk(i.name, i.note) === want);
        if (!open.length && !res.note) open = this._data.items.filter((i) => !i.checked && i.name.toLowerCase() === res.name.toLowerCase());
        const item = open.find((i) => i.store_id === store.id) || open[0];
        if (!item) return `ℹ️ ${res.name} steht nicht auf der Liste`;
        try {
          await this._hass.callWS({ type: "einkaufsliste/item/toggle", item_id: item.id, checked: true, via: "scan" });
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
        if (res.note) { this.$("inNote").value = res.note; this.$("inNote").hidden = false; }
        this._catManual = false;
        if (res.category_id && this._cat(res.category_id)) this.$("inCat").value = res.category_id;
        else this._onNameInput();
        if (res.store_id && !this._fixedStore && this._activeTab === "all" && this._store(res.store_id)) this.$("inStore").value = res.store_id;
        this._toast(res.source === "gemerkt"
          ? `🔍 Kenn ich: „${res.name}${res.note ? ` · ${res.note}` : ""}“ – tippe ✅ zum Hinzufügen`
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
    if (t.id === "recipeSearch" || t.id === "recipeSearchS") {
      this._recipeFilter = t.value;
      if (t.id === "recipeSearch") this._renderRecipeList(); else this._renderSetRecipeList();
      return;
    }
    if (t.id === "prodSearch") {
      this._prodFilter = t.value;
      this._renderProducts();
      return;
    }
    if (t.id === "logSearch") {
      this._logF.q = t.value;
      this._logMax = 150;
      this._renderLogList();
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
    if (this._formMode === "recipe") { this._addRecipeIngredient(); return; }
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
    if (this._pendingBarcode) { msg.barcode = this._pendingBarcode; msg.via = "scan"; }
    if (!msg.quantity) { const sp = splitQty(name); if (sp.qty) { msg.name = sp.name; msg.quantity = sp.qty; } }
    // Steht das schon bei einem anderen Geschäft offen? Dann erst fragen: verschieben oder zusätzlich?
    const other = this._openElsewhere({ name: msg.name, note: msg.note, for_whom: msg.for_whom }, msg.store_id);
    if (other) {
      this._conflict = { kind: "add", other: other.id, store: msg.store_id, msg };
      this._renderList();
      return;
    }
    await this._doAdd(msg);
  }

  async _doAdd(msg) {
    const name = msg.name;
    try {
      const item = await this._ws(msg);
      if (this._newPhoto) {
        const data = this._newPhoto;
        this._newPhoto = null;
        this._updateNewPhotoBtn();
        await this._savePhoto({ name: this._pk(item?.name || name, item ? item.note : msg.note), button: this.$("btnNewPhoto"), quiet: true }, data);
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
      case "reload":
        try { caches?.keys?.().then((ks) => ks.forEach((k) => caches.delete(k))); } catch (_) { /* egal */ }
        setTimeout(() => location.reload(), 150);
        break;
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
        if (this._view === "settings" && current !== "settings") this._setSec = null;
        this._draft = null;
        this._renderAll();
        break;
      }
      case "tab":
        this._tab = el.dataset.tab;
        this._seenSnap = { ...(this._mySeen() || {}) };
        this._renderAll();
        break;
      case "toggle": {
        if (!id || this._pending.has(id)) return;
        const item = this._data.items.find((i) => i.id === id);
        if (!item) return;
        if (this._activeTab === "all" && !this._fixedStore && this._siblings(item, item.checked).length > 1) {
          // mehrere Geschäfte in einer Zeile: erst fragen, welches
          this._wherePick = this._wherePick?.id === id ? null : { id };
          this._renderList();
          return;
        }
        if (item.checked) this._readd(item);
        else this._toggle(id);
        break;
      }
      case "where-go": {
        const target = this._data.items.find((i) => i.id === el.dataset.item);
        this._wherePick = null;
        if (!target) { this._renderList(); break; }
        if (target.checked) this._readd(target);
        else this._toggle(target.id);
        break;
      }
      case "where-cancel":
        this._wherePick = null;
        this._renderList();
        break;
      case "conflict-cancel":
        this._conflict = null;
        this._renderList();
        break;
      case "conflict-extra": {
        const c = this._conflict;
        this._conflict = null;
        if (c?.kind === "add") this._doAdd(c.msg);
        else if (c?.kind === "readd") this._toggle(c.item);
        this._renderList();
        break;
      }
      case "conflict-move": {
        const c = this._conflict;
        this._conflict = null;
        if (!c) break;
        const target = this._store(c.store);
        this._ws({ type: "einkaufsliste/item/move", item_id: c.other, store_id: c.store })
          .then(() => {
            this._toast(`🔁 Verschoben – jetzt bei ${target?.name || "?"} offen`);
            if (c.kind === "add") return this._doAdd(c.msg);
            return null;
          })
          .catch(() => {})
          .finally(() => this._renderAll());
        break;
      }
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
      case "heat-add":
        this._readHeat();
        (this._draft.heat ||= []).push({ device: "Backofen", mode: "Ober-/Unterhitze", temp: null, minutes: null, preheat: false, note: null });
        this._renderHeat();
        break;
      case "heat-remove":
        this._readHeat();
        this._draft.heat.splice(Number(el.closest(".heatrow").dataset.n), 1);
        this._renderHeat();
        break;
      case "basic-toggle":
        this._setBasic(!this._rBasic);
        this._toast(this._rBasic ? "🧂 Grundvorrat: wird bei „Auf die Liste“ nicht vorausgewählt" : "🧂 Kein Grundvorrat");
        break;
      case "recipe-cook": {
        const r = this._recipe(el.closest(".rtools").dataset.id);
        if (r) this._cookMode(r);
        break;
      }
      case "recipe-share": {
        const r = this._recipe(el.closest(".rtools").dataset.id);
        if (r) this._shareRecipe(r);
        break;
      }
      case "note-chip": {
        const n = this.$("inNote");
        n.value = el.dataset.v;
        this._updateTools();
        this.$("inName").focus();
        break;
      }
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
      case "menu-info": {
        const item = this._data.items.find((i) => i.id === el.dataset.id);
        this._menuId = null;
        this._renderList();
        if (item) this._showProductInfo(item);
        break;
      }
      case "menu-photo": {
        const item = this._data.items.find((i) => i.id === el.dataset.id);
        this._menuId = null;
        this._renderList();
        const pk = this._pk(item.name, item.note);
        if (this._hasPhoto(pk)) this._openPhoto(pk);
        else this._takePhoto(pk, null);
        break;
      }
      case "qty-edit": {
        const item = this._data.items.find((i) => i.id === id);
        if (this._parseQty(item?.quantity)) {
          this._qtyEdit = this._qtyEdit === id ? null : id;
          if (this._qtyStep) delete this._qtyStep[id];
        } else {
          this._editing = id; // z. B. „ein paar“ -> normal bearbeiten
        }
        this._renderList();
        break;
      }
      case "qty-minus":
      case "qty-plus": {
        const itemId = el.closest(".qtyrow").dataset.id;
        const item = this._data.items.find((i) => i.id === itemId);
        const p = this._parseQty(item?.quantity) || { n: 1, unit: "x" };
        const step = (this._qtyStep ||= {})[itemId] || this._qtyStepFor(item);
        const n = act === "qty-plus" ? p.n + step : Math.max(step, p.n - step);
        this._ws({ type: "einkaufsliste/item/update", item_id: itemId, quantity: this._fmtQty(n, p.unit) }).catch(() => {});
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
        const from = this._store(item?.store_id);
        this._ws({ type: "einkaufsliste/item/move", item_id: itemId, store_id: target.id })
          .then(() => this._toast(`🔁 ${item?.name || "Artikel"}: ${from ? `bei ${from.name} abgehakt, ` : ""}jetzt bei ${target.name} offen`))
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
        this._openPhoto(el.dataset.name, el.dataset.title);
        break;
      case "photo-take":
        this._takePhoto(el.dataset.name, null);
        break;
      case "photo-remove":
        if (!confirm(`Foto von „${this._pkLabel(el.dataset.name)}“ löschen?`)) return;
        this._ws({ type: "einkaufsliste/photo/remove", name: el.dataset.name })
          .then(() => { this._toast("Foto gelöscht 🗑️"); this._editing = null; this._renderList(); }).catch(() => {});
        break;
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
      case "set-sec":
        this._setSec = el.dataset.sec || null;
        this._renderSettings();
        this.$("otherView").scrollIntoView?.({ block: "nearest" });
        break;
      case "prod-edit":
        this._prodEdit = el.dataset.key;
        this._renderProducts();
        break;
      case "prod-cancel":
        this._prodEdit = null;
        this._renderProducts();
        break;
      case "prod-photos":
        this._openPhoto(el.closest(".prodedit").dataset.key);
        break;
      case "prod-save": {
        const key = el.closest(".prodedit").dataset.key;
        const msg = {
          type: "einkaufsliste/product/update", key,
          name: this.$("peName").value.trim(), note: this.$("peNote").value.trim() || null,
          category_id: this.$("peCat").value || null, store_id: this.$("peStore").value || null,
        };
        if (!msg.name) { this.$("peName").classList.add("shake"); break; }
        this._ws(msg).then(() => { this._toast("📦 Produkt gespeichert"); this._prodEdit = null; this._loadProducts(); }).catch(() => {});
        break;
      }
      case "prod-forget": {
        const key = el.closest(".prodedit").dataset.key;
        if (!confirm("Dieses Produkt vergessen? Fotos, Barcodes und Vorschläge sind dann weg. Artikel auf der Liste bleiben stehen.")) break;
        this._ws({ type: "einkaufsliste/product/remove", key })
          .then(() => { this._toast("🧹 Produkt vergessen"); this._prodEdit = null; this._loadProducts(); }).catch(() => {});
        break;
      }
      case "log-more":
        this._logMax = (this._logMax || 150) + 150;
        this._renderLogList();
        break;
      case "log-clear":
        if (!confirm("Den ganzen Verlauf löschen? Das geht nicht rückgängig.")) break;
        this._ws({ type: "einkaufsliste/log/clear" }).then(() => { this._toast("🧽 Verlauf geleert"); this._loadLog(); }).catch(() => {});
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
      case "recipe-search-clear": {
        this._recipeFilter = "";
        const inp = this.$("recipeSearch") || this.$("recipeSearchS");
        if (inp) { inp.value = ""; inp.focus(); }
        if (this.$("recipeList")) this._renderRecipeList(); else this._renderSetRecipeList();
        break;
      }
      case "recipe-edit":
        this._openRecipe(this._recipe(el.closest(".recipe").dataset.id));
        break;
      case "recipe-apply": {
        const r = this._recipe(el.closest(".recipe").dataset.id);
        if (this._pickRecipe === r.id) { this._pickRecipe = null; this._renderRecipes(); break; }
        const open = new Set(this._data.items.filter((i) => !i.checked).map((i) => i.name.toLowerCase()));
        this._pickRecipe = r.id;
        this._pickSel = new Set(r.items.map((it, n) => (open.has(it.name.toLowerCase()) || it.basic ? -1 : n)).filter((n) => n >= 0));
        this._renderRecipes();
        break;
      }
      case "recipe-unapply": {
        const r = this._recipe(el.closest(".recipe").dataset.id);
        if (!r || !confirm(`Alle offenen Zutaten von „${r.name}“ von der Liste nehmen?`)) break;
        this._ws({ type: "einkaufsliste/recipe/unapply", recipe_id: r.id })
          .then((res) => this._toast(`🧺 ${res.removed} Zutaten von „${r.name}“ von der Liste genommen`))
          .catch(() => {});
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
      case "rphoto-take":
        this._photoTarget = { recipeDraft: true };
        this._pickFile("photoFile");
        break;
      case "rphoto-view": {
        const dr = this._draft;
        if (dr?.photoData) showPhotoOverlay(dr.photoData, this.$("rName")?.value || dr.name || "Rezept");
        else if (dr?.id) this._openPhoto(this._recipePhotoKey(dr.id));
        break;
      }
      case "rphoto-remove":
        if (!this._draft || !confirm("Rezept-Foto löschen? (Wird beim Speichern übernommen.)")) break;
        this._draft.photoData = null;
        this._draft.photoRemove = true;
        this._renderRecipePhoto();
        break;
      case "rimport-toggle": {
        const box = this.$("rImport");
        box.hidden = !box.hidden;
        if (!box.hidden) this.$("rImportText").focus();
        break;
      }
      case "rimport-go":
        this._importRecipe();
        break;
      case "ritem-edit":
        this._editRecipeIngredient(Number(el.closest(".rrow").dataset.n));
        break;
      case "ritem-edit-cancel":
        this._rEditIdx = null;
        this._clearForm();
        this.$("inStore").value = "";
        this.$("rEditHint").hidden = true;
        this._renderRecipeItems();
        break;
      case "ritem-remove": {
        const n = Number(el.closest(".rrow").dataset.n);
        this._draft.items.splice(n, 1);
        if (this._rEditIdx === n) { this._rEditIdx = null; this.$("rEditHint").hidden = true; this._clearForm(); this.$("inStore").value = ""; }
        this._renderRecipeItems();
        break;
      }
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
    if (t.dataset?.hf === "device") { this._readHeat(); const n = Number(t.closest(".heatrow").dataset.n); this._draft.heat[n].mode = HEAT_DEVICES[t.value]?.modes[0] || null; this._renderHeat(); return; }
    const logKey = { logWho: "who", logStore: "store", logAct: "act" }[t.id];
    if (logKey) {
      this._logF[logKey] = t.value;
      this._logMax = 150;
      this._renderLogList();
      return;
    }
    if (t.id === "logDays") {
      this._ws({ type: "einkaufsliste/log/settings", days: Number(t.value) })
        .then(() => { this._toast(`📋 Verlauf wird ${t.value} Tage aufgehoben`); this._loadLog(); }).catch(() => {});
      return;
    }
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
  show_added_by: "✍️ Wer eingetragen hat (klein unter dem Artikel)",
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
