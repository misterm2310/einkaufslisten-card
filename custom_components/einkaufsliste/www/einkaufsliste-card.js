/*
 * Einkaufsliste Card – die Familien-Einkaufsliste für Home Assistant
 * Wird automatisch von der Integration "einkaufsliste" geladen.
 */
const EL_VERSION = "2.43.1";
// 🆕 Was ist neu in dieser Version (deutsch, englisch) – bei jedem Update neu schreiben
const EL_NEWS = [
  ["📷 <b>Fotos laden zuverlässiger:</b> Kommt ein Foto nicht an, fragt die Karte nach 5 Sekunden von selbst nochmal (bis zu 3-mal). Solange es lädt, steht „Foto lädt …“ da; klappt es gar nicht, gibt es einen Knopf „Nochmal“ und einen Eintrag im Fehler-Protokoll.",
   "📷 <b>Photos load more reliably:</b> if a photo does not arrive, the card asks again by itself after 5 seconds (up to 3 times). While it loads you see “Photo loading …”; if it still fails there is a “Try again” button and an entry in the error log."],
];
const EL_START_STORE_ICONS = new Set(["mdi:cart", "mdi:lotion"]); // so bekommen Geschäfte beim Einrichten ihr Icon – zählt als „automatisch“
const EGAL_CHIP = `<span class="chip" style="--c:#888">🤷 Egal wo</span>`; // Artikel ohne Geschäft: überall kaufen

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
  out: { label: "⇄ war aus", verb: "hat % als „war aus“ markiert" },
  remove: { label: "🗑️ gelöscht", verb: "hat % gelöscht" },
  buy: { label: "🧾 bezahlt", verb: "hat % bezahlt" },
};
const LOG_VIA = { card: "✍️", scan: "▥", recipe: "🍳", merge: "🔗", cleanup: "🧹", service: "🤖", sync: "🔁", mail: "📧" };
const WD_LONG = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"];
const pyWd = (d) => (d.getDay() + 6) % 7;
const DAY = 86400000;

// 🌍 Englisch als zweite Sprache: Die Karte ist auf Deutsch geschrieben. Ist Home Assistant NICHT auf Deutsch
// (oder steht in der Karte „language: en“), holt sie sich einmal das Wörterbuch einkaufsliste-en.json
// und übersetzt alles, was sie anzeigt. Deine eigenen Einträge (Artikel, Notizen, Rezepte) bleiben, wie sie sind.
let EL_LANG = "de";
let EL_DICT = null;       // exakte Texte: deutsch -> englisch
let EL_PATTERNS = [];     // Texte mit Platzhaltern („{}“)
let EL_DICT_PROMISE = null;
const EL_I18N_ROOTS = new Set();
const EL_SKIP = ".name,.rname,.pname,.inote,.delname,.lname,.stitle,textarea,style,script,[translate=no]";
const EL_ATTRS = ["placeholder", "title", "aria-label", "label", "alt"];
const EL_UNIT_RX = /^([\d½¼¾⅓⅔⅛][\d.,/½¼¾⅓⅔⅛\s-]*?)\s*(EL|TL|Msp\.|Pck\.|Prisen?|Dosen?|Becher|Bund|Flaschen?|Kisten?|Glas|Gläser|Rollen?|Beutel|Tüten?|Scheiben?|Zehen?|Tassen?|Schluck|Schuss|Spritzer|Tropfen|Handvoll|Stangen?|Kopf|Köpfe|Würfel|Zweige?|Blatt|Knollen?|Kugeln?|Schalen?|Netze?)$/;
const EL_DAY_RX = /^(Mo|Di|Mi|Do|Fr|Sa|So)(?= \d)/;
const elNorm = (t) => t.replace(/\s+/g, " ").trim();
function elWantLang(hass, config) {
  const want = String(config?.language || "auto").toLowerCase();
  const l = want !== "auto" ? want : String(hass?.locale?.language || hass?.language || "de").toLowerCase();
  return l.startsWith("de") ? "de" : "en";
}
function elLoadDict() {
  if (!EL_DICT_PROMISE) {
    EL_DICT_PROMISE = fetch(`${EL_BASE}/einkaufsliste-en.json?v=${EL_VERSION}`).then((r) => r.json()).then((raw) => {
      const dict = {};
      const pats = [];
      for (const [de, en] of Object.entries(raw)) {
        const key = elNorm(de);
        if (!key.includes("{}")) { dict[key] = en; continue; }
        const parts = key.split("{}");
        const rx = new RegExp("^" + parts.map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("(.*?)") + "$", "s");
        pats.push([rx, en, parts.join("").length]);
      }
      pats.sort((a, b) => b[2] - a[2]); // genauere Muster zuerst
      EL_DICT = dict;
      EL_PATTERNS = pats;
      for (const root of EL_I18N_ROOTS) elTranslateTree(root);
    }).catch(() => { EL_DICT_PROMISE = null; });
  }
  return EL_DICT_PROMISE;
}
function elT(text, depth = 0) {
  if (EL_LANG === "de" || !EL_DICT || text == null) return text;
  const raw = String(text);
  const key = elNorm(raw);
  if (!key || !/[A-Za-zÄÖÜäöüß]/.test(key)) return raw;
  const lead = raw.match(/^\s*/)[0], trail = raw.match(/\s*$/)[0];
  const wrap = (x) => lead + x + trail;
  if (key in EL_DICT) return wrap(EL_DICT[key]);
  for (const [rx, en] of EL_PATTERNS) {
    const m = key.match(rx);
    if (!m) continue;
    return wrap(en.replace(/\{(\d)\}/g, (_, i) => {
      const g = m[Number(i) + 1] ?? "";
      return depth < 2 ? elT(g, depth + 1) : g;
    }));
  }
  let m = key.match(EL_UNIT_RX);
  if (m && EL_DICT[m[2]]) return wrap(`${m[1].trim()} ${EL_DICT[m[2]]}`);
  m = key.match(EL_DAY_RX);
  if (m && EL_DICT[m[1]]) return wrap(EL_DICT[m[1]] + key.slice(m[1].length));
  m = depth < 2 && key.match(/^([^\p{L}\p{N}„“"(]+?)\s(.+)$/u); // „🏪 Geschäfte“: Zeichen vorne weg, Rest übersetzen
  if (m) { const rest = elT(m[2], depth + 1); if (rest !== m[2]) return wrap(`${m[1]} ${rest}`); }
  return raw;
}
function elTranslateNode(node) {
  if (node.nodeType === 3) {
    const p = node.parentElement;
    if (!p || p.closest(EL_SKIP)) return;
    const t = elT(node.data);
    if (t !== node.data) node.data = t;
    return;
  }
  if (node.nodeType !== 1) return;
  {
    for (const a of EL_ATTRS) {
      const v = node.getAttribute(a);
      if (v) { const t = elT(v); if (t !== v) node.setAttribute(a, t); }
    }
  }
}
function elTranslateTree(root) {
  if (EL_LANG === "de" || !EL_DICT || !root) return;
  if (root.nodeType === 1 || root.nodeType === 3) elTranslateNode(root);
  if (root.nodeType === 3) return;
  const w = document.createTreeWalker(root, 5 /* Elemente + Text */);
  let n;
  while ((n = w.nextNode())) elTranslateNode(n);
}
// Einmal pro Karte: alles Neue im Schatten-DOM gleich übersetzen
function elWatch(root, keep = true) {
  if (EL_LANG === "de" && !keep) return;
  if (EL_I18N_ROOTS.has(root)) return;
  if (keep) EL_I18N_ROOTS.add(root); // Einblendungen (Anleitung, Kochen …) nicht merken – die verschwinden wieder
  new MutationObserver((muts) => {
    if (EL_LANG === "de" || !EL_DICT) return;
    for (const mu of muts) {
      if (mu.type === "childList") mu.addedNodes.forEach((x) => elTranslateTree(x));
      else if (mu.type === "characterData") elTranslateNode(mu.target);
      else elTranslateNode(mu.target);
    }
  }).observe(root, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: EL_ATTRS });
  elTranslateTree(root);
}
function elUseLang(hass, config, root) {
  const lang = elWantLang(hass, config);
  if (lang !== EL_LANG) EL_LANG = lang;
  if (root) elWatch(root);
  if (EL_LANG !== "de") elLoadDict();
}
const elConfirm = (msg) => confirm(elT(msg));

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const dayDiff = (a, b) => Math.round((startOfDay(a) - startOfDay(b)) / DAY);
const fmtDay = (d) => `${WD_SHORT[pyWd(d)]} ${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}.`;
const stripMdi = (icon) => String(icon || "").replace(/^mdi:/, "");
// 🔢 Mengen einheitlich schreiben – GENAU dieselben Regeln wie quantity.py im Server.
// „3el“ -> „3 EL“, „1“ -> „1x“, „1/2 tl“ -> „0,5 TL“, „2 bis 3 el“ -> „2-3 EL“, „2 tasse“ -> „2 Tassen“
// [Einzahl, Mehrzahl, Schreibweisen] – Einzahl bei genau 1, sonst Mehrzahl
const QTY_DEFS = [
  ["x", "x", ["x", "×", "mal", "stk", "stück", "st", "stck", "pc", "pcs", "piece", "pieces"]], ["g", "g", ["g", "gr", "gramm", "gram", "grams"]],
  ["kg", "kg", ["kg", "kilo", "kilogramm", "kilos"]], ["mg", "mg", ["mg", "milligramm"]], ["ml", "ml", ["ml", "milliliter"]],
  ["cl", "cl", ["cl"]], ["dl", "dl", ["dl"]], ["L", "L", ["l", "ltr", "liter", "litre", "litres", "liters"]],
  ["EL", "EL", ["el", "essl", "esslöffel", "tbsp", "tbs"]], ["TL", "TL", ["tl", "teel", "teelöffel", "tsp"]],
  ["Msp.", "Msp.", ["msp", "messerspitze", "messerspitzen"]],
  ["Pck.", "Pck.", ["pck", "pkt", "päckchen", "packung", "packungen", "pack", "packs", "package", "packages", "packet", "packets"]], ["Prise", "Prisen", ["prise", "prisen", "pinch", "pinches"]],
  ["Dose", "Dosen", ["dose", "dosen", "can", "cans", "tin", "tins"]], ["Becher", "Becher", ["becher", "tub", "tubs"]], ["Bund", "Bund", ["bund", "bunch", "bunches"]],
  ["Flasche", "Flaschen", ["flasche", "flaschen", "bottle", "bottles"]], ["Kiste", "Kisten", ["kiste", "kisten", "crate", "crates"]],
  ["Glas", "Gläser", ["glas", "gläser", "jar", "jars"]], ["Rolle", "Rollen", ["rolle", "rollen"]], ["Beutel", "Beutel", ["beutel", "bag", "bags"]],
  ["Tüte", "Tüten", ["tüte", "tüten"]], ["Scheibe", "Scheiben", ["scheibe", "scheiben", "slice", "slices"]], ["Zehe", "Zehen", ["zehe", "zehen", "clove", "cloves"]],
  ["Tasse", "Tassen", ["tasse", "tassen", "cup", "cups"]], ["Schluck", "Schluck", ["schluck", "schlucke"]], ["Schuss", "Schuss", ["schuss"]],
  ["Spritzer", "Spritzer", ["spritzer"]], ["Tropfen", "Tropfen", ["tropfen", "drop", "drops"]], ["Handvoll", "Handvoll", ["handvoll", "handful", "handfuls"]],
  ["Stange", "Stangen", ["stange", "stangen", "stick", "sticks"]], ["Kopf", "Köpfe", ["kopf", "köpfe", "head", "heads"]], ["Würfel", "Würfel", ["würfel", "cube", "cubes"]],
  ["Zweig", "Zweige", ["zweig", "zweige", "sprig", "sprigs"]], ["Blatt", "Blatt", ["blatt", "blätter", "leaf", "leaves"]], ["Knolle", "Knollen", ["knolle", "knollen", "bulb", "bulbs"]],
  ["Kugel", "Kugeln", ["kugel", "kugeln", "scoop", "scoops"]], ["Schale", "Schalen", ["schale", "schalen", "tray", "trays"]], ["Netz", "Netze", ["netz", "netze"]],
];
const QTY_UNITS = {}; // Schreibweise -> [Einzahl, Mehrzahl]
for (const [one, many, vs] of QTY_DEFS) for (const v of vs) QTY_UNITS[v] = [one, many];
const QTY_UNIT_RX = Object.keys(QTY_UNITS).sort((a, b) => b.length - a.length).map((u) => u.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
const QTY_FRAC = { "½": 0.5, "¼": 0.25, "¾": 0.75, "⅓": 1 / 3, "⅔": 2 / 3, "⅛": 0.125 };
const QTY_N1 = "(?:\\d+\\s*[½¼¾⅓⅔⅛]|\\d+\\s+\\d+\\s*/\\s*\\d+|\\d+(?:[.,]\\d+)?(?:\\s*/\\s*\\d+)?|[½¼¾⅓⅔⅛])";
const QTY_NUM = `${QTY_N1}(?:\\s*(?:-|–|—|bis)\\s*${QTY_N1})?`;
const QTY_RANGE_RX = new RegExp(`^(${QTY_N1})(?:\\s*(?:-|–|—|bis)\\s*(${QTY_N1}))?$`, "i");
const QTY_RX = new RegExp(`^\\s*(${QTY_NUM})\\s*(?:(${QTY_UNIT_RX})\\.?)?\\s*$`, "i");
const QTY_START_RX = new RegExp(`^\\s*(${QTY_NUM})\\s*(?:(${QTY_UNIT_RX})\\.?(?=\\s)|(?=\\s))\\s*(.+)$`, "i");
const QTY_END_RX = new RegExp(`^(.+?)\\s+(${QTY_NUM})\\s*(${QTY_UNIT_RX})?\\.?\\s*$`, "i");
const QTY_PAREN_RX = new RegExp(`^(.+?)\\s*\\(\\s*(${QTY_NUM})\\s*(${QTY_UNIT_RX})?\\.?\\s*\\)\\s*$`, "i"); // „Milch (2)“ wie bei OurGroceries
function qtyValue(text) { // „1½“ -> 1.5, „1 1/2“ -> 1.5, „1/2“ -> 0.5, „1,5“ -> 1.5
  const t = String(text).trim();
  let m;
  if ((m = t.match(/^(\d*)\s*([½¼¾⅓⅔⅛])$/))) return Number(m[1] || 0) + QTY_FRAC[m[2]];
  if ((m = t.match(/^(\d+)\s+(\d+)\s*\/\s*(\d+)$/))) return Number(m[3]) ? Number(m[1]) + Number(m[2]) / Number(m[3]) : null;
  if ((m = t.match(/^(\d+)\s*\/\s*(\d+)$/))) return Number(m[2]) ? Number(m[1]) / Number(m[2]) : null;
  if ((m = t.match(/^([1-9]\d*)\.(\d{3})$/))) return Number(m[1] + m[2]); // „1.000“ = tausend
  const v = Number(t.replace(",", "."));
  return Number.isFinite(v) && /^\d+(?:[.,]\d+)?$/.test(t) ? v : null;
}
const qtyRound = (v) => Math.floor(v * 100 + 0.5) / 100;
const qtyNumText = (v) => { v = qtyRound(v); return Number.isInteger(v) ? String(v) : String(v).replace(".", ","); };
function qtyFmt(num, unit) { // Zahl (oder Bereich) + Einheit ordentlich, null wenn nicht lesbar
  const m = String(num).trim().match(QTY_RANGE_RX);
  if (!m) return null;
  const a = qtyValue(m[1]);
  let b = m[2] ? qtyValue(m[2]) : null;
  if (a == null || (m[2] && b == null)) return null;
  let text = qtyNumText(a);
  if (b != null && qtyNumText(b) !== text) text += "-" + qtyNumText(b);
  else b = null;
  const canon = unit ? QTY_UNITS[unit.toLowerCase().replace(/\.+$/, "")] : null;
  if (!canon || canon[0] === "x") return `${text}x`;
  return `${text} ${qtyRound(b ?? a) === 1 ? canon[0] : canon[1]}`;
}
function normQty(q) { // Unbekanntes bleibt, wie es ist
  const t = String(q ?? "").trim().replace(/\s+/g, " ");
  if (!t) return null;
  const m = t.match(QTY_RX);
  return m ? qtyFmt(m[1], m[2]) || t : t;
}
// „3 milch“ / „milch 3x“ / „250g nudeln“ -> Name + Menge
function splitQty(text) {
  const t = String(text || "").trim().replace(/\s+/g, " ");
  for (const mode of ["paren", "start", "end"]) {
    const end = mode !== "start";
    const m = t.match(mode === "paren" ? QTY_PAREN_RX : end ? QTY_END_RX : QTY_START_RX);
    if (!m) continue;
    const rest = (end ? m[1] : m[3]).replace(/^[\s,-]+|[\s,-]+$/g, "");
    const num = end ? m[2] : m[1], unit = end ? m[3] : m[2];
    if (!/[a-zäöüß]/i.test(rest)) continue;
    if (end && !unit) { // „Cola 2“ ja, aber nicht „Xbox 360“
      const first = num.trim().match(QTY_RANGE_RX);
      const v = first ? qtyValue(first[1]) : null;
      if (v == null || v > 50) continue;
    }
    const qty = qtyFmt(num, unit);
    if (qty) return { name: rest, qty, num: num.trim(), bare: !unit };
  }
  return { name: t, qty: null };
}
// 📋 „milch, 6 eier; brot“ -> ["milch", "6 eier", "brot"] – das Komma in „1,5 l“ trennt nicht
const splitMany = (text) => String(text || "").split(/;|\n|(?<!\d),|,(?!\d)/).map((t) => t.trim()).filter(Boolean);
// 📏 Einheit einer Menge („2 Dosen“ -> „Dose“, „3x“ -> „x“), null wenn unbekannt
function unitOf(q) {
  const m = String(q ?? "").trim().replace(/\s+/g, " ").match(QTY_RX);
  if (!m) return null;
  if (!m[2]) return "x";
  const c = QTY_UNITS[m[2].toLowerCase().replace(/\.+$/, "")];
  return c ? c[0] : null;
}
const isBareQty = (q) => new RegExp(`^\\s*${QTY_NUM}\\s*$`, "i").test(String(q ?? ""));
// Andere Einheit an die Zahl: („2x“, „Pck.“) -> „2 Pck.“
function applyUnit(q, unit) {
  const m = String(q ?? "").trim().replace(/\s+/g, " ").match(QTY_RX);
  return m && unit ? qtyFmt(m[1], unit) || q : q;
}
// Einheiten zur Auswahl in der Mengen-Box: erst die häufigen, hinter „mehr …“ der Rest
const UNIT_MAIN = ["x", "g", "kg", "ml", "L", "EL", "TL", "Pck.", "Dose", "Flasche", "Glas", "Becher"];
const UNIT_MORE = QTY_DEFS.map((d) => d[0]).filter((u) => !UNIT_MAIN.includes(u));
// Schnell-Zahlen je Einheit (bei Gramm & Co. sind 1, 2, 3 unpraktisch)
const QTY_PRESETS = { g: [100, 200, 250, 500, 750, 1000], ml: [100, 200, 250, 500, 750, 1000], mg: [100, 200, 250, 500],
  cl: [10, 20, 33, 50, 70, 100], dl: [1, 2, 3, 5], kg: [0.5, 1, 1.5, 2, 2.5, 5], L: [0.5, 1, 1.5, 2, 3, 6] };

// Wie viele Buchstaben unterscheiden sich? (für die Tippfehler-Hilfe)
// 👥 Menge umrechnen: „200 g“ für 4 -> „300 g“ für 6. Stückzahlen werden aufgerundet (4,5 Eier -> 5x).
const WHOLE_UNITS = new Set(["x", "Pck.", "Prise", "Dose", "Becher", "Bund", "Flasche", "Kiste", "Glas", "Rolle", "Beutel", "Tüte",
  "Scheibe", "Zehe", "Schluck", "Schuss", "Spritzer", "Tropfen", "Handvoll", "Stange", "Kopf", "Würfel", "Zweig", "Blatt",
  "Knolle", "Kugel", "Schale", "Netz"]);
function scaleQty(qty, factor) {
  if (!qty || !factor || Math.abs(factor - 1) < 1e-9) return qty || null;
  const m = String(qty).trim().match(/^(\d+(?:[.,]\d+)?(?:\s*\/\s*\d+)?)(?:\s*-\s*(\d+(?:[.,]\d+)?))?\s*(.*)$/);
  if (!m) return qty;
  const num = (t) => { const [a, b] = t.replace(",", ".").split("/").map((x) => parseFloat(x)); return b ? a / b : a; };
  const unit = m[3].trim();
  const canon = unit ? QTY_UNITS[unit.toLowerCase().replace(/\.+$/, "")] : ["x", "x"];
  const whole = !unit || (canon && WHOLE_UNITS.has(canon[0]));
  const round = (v) => {
    if (whole) return Math.max(1, Math.ceil(v - 1e-9));
    if (v >= 100) return Math.round(v / 10) * 10;
    if (v >= 10) return Math.round(v);
    return Math.round(v * 10) / 10;
  };
  const fmt = (v) => String(v).replace(".", ",");
  const a = round(num(m[1]) * factor);
  const b = m[2] ? round(num(m[2]) * factor) : null;
  const n = fmt(a) + (b != null && b !== a ? "-" + fmt(b) : "");
  return normQty(unit ? `${n} ${unit}` : `${n}x`); // Einzahl/Mehrzahl passt sich an (1 Dose -> 2 Dosen)
}

// 👥 Personen oder 🍰 Bleche: richtige Wörter für die Anzeige
const servLabel = (unit, n) => (unit === "trays" ? (n === 1 ? "Blech" : "Bleche") : (n === 1 ? "Person" : "Personen"));

// 🔤 Zutaten A–Z (Ä wie A, groß/klein egal) – genau wie im Backend
const abcSort = (list) => list.sort((a, b) => (a.name || "").localeCompare(b.name || "", "de", { sensitivity: "base" })
  || (a.note || "").localeCompare(b.note || "", "de", { sensitivity: "base" }));

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

// ✍️ Wann eingetragen: heute „vor 5 Min“, sonst der Wochentag „Mo.“ (älter als eine Woche: „Mo. 21.09.“)
function fmtWhen(iso) {
  const d = new Date(iso);
  const diff = dayDiff(new Date(), d);
  if (diff <= 0) return fmtSince(iso);
  const wd = `${WD_SHORT[pyWd(d)]}.`;
  return diff < 7 ? wd : `${wd} ${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}.`;
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
  grillen: "grill", pfanne: "pot-mix", geflügel: "food-drumstick", gefluegel: "food-drumstick", salat: "bowl-mix",
  plätzchen: "cookie", plaetzchen: "cookie", gebäck: "food-croissant", gebaeck: "food-croissant", dessert: "ice-cream",
  nachtisch: "ice-cream", frühstück: "coffee", fruehstueck: "coffee", soße: "soy-sauce", sosse: "soy-sauce", sauce: "soy-sauce",
  dip: "soy-sauce", cocktail: "glass-cocktail", vegetarisch: "leaf", vegan: "leaf", eintopf: "pot-steam", weihnachten: "pine-tree",
  ostern: "egg-easter", asiatisch: "noodles", wok: "noodles", mexikanisch: "taco", kinder: "human-child", brote: "baguette",
};

// 💡 Icon-Vorschlag aus einem Namen („Grillen“ → mdi:grill)
function suggestIcon(name) {
  const words = String(name || "").toLowerCase().split(/[^a-zäöüß]+/).filter(Boolean);
  for (const w of words) {
    if (ICON_DE[w]) return "mdi:" + ICON_DE[w];
  }
  for (const w of words) {
    for (const [de, en] of Object.entries(ICON_DE)) if (de.length >= 4 && w.startsWith(de)) return "mdi:" + en;
  }
  return null;
}

// 🏷️ Rezept-Gruppe aus dem Rezeptnamen raten („Lachs mit Reis“ → Fisch). Reihenfolge zählt:
// „Pfannkuchen“ ist herzhaft, nicht „Kuchen“.
const GROUP_WORDS = [
  ["herzhaft", ["pfannkuchen", "reibekuchen", "kartoffelpuffer", "flammkuchen", "zwiebelkuchen", "pizza", "quiche", "auflauf", "gratin", "toast", "wrap", "tarte flambée"]],
  ["fisch", ["lachs", "fisch", "thunfisch", "forelle", "garnele", "scampi", "kabeljau", "seelachs", "hering", "matjes", "dorsch", "backfisch", "zander", "shrimps"]],
  ["gefluegel", ["hähnchen", "haehnchen", "huhn", "hühner", "chicken", "pute", "puten", "ente", "gans", "geflügel", "nuggets"]],
  ["fleisch", ["schnitzel", "steak", "braten", "gulasch", "hack", "frikadelle", "bolognese", "rind", "schwein", "wurst", "kotelett", "roulade", "spareribs", "burger", "fleisch", "geschnetzeltes", "leberkäse", "speck", "lamm"]],
  ["suppen", ["suppe", "eintopf", "brühe", "chili", "gulaschsuppe"]],
  ["salate", ["salat"]],
  ["nudeln", ["nudel", "pasta", "spaghetti", "lasagne", "penne", "reis", "risotto", "tortellini", "maultasche", "spätzle", "gnocchi", "makkaroni"]],
  ["plaetzchen", ["plätzchen", "kekse", "keks", "cookies", "spekulatius", "makronen", "vanillekipferl"]],
  ["kuchen", ["kuchen", "torte", "tarte", "cheesecake", "brownie", "strudel"]],
  ["brot", ["brötchen", "brot", "baguette", "ciabatta", "semmel"]],
  ["gebaeck", ["croissant", "hefezopf", "waffel", "muffin", "berliner", "donut", "zimtschnecke", "gebäck", "crêpe", "crepe"]],
  ["desserts", ["pudding", "dessert", "mousse", "tiramisu", "eis", "creme", "grießbrei", "milchreis", "panna cotta", "kompott", "quarkspeise"]],
  ["fruehstueck", ["müsli", "porridge", "rührei", "frühstück", "pancake", "omelett", "spiegelei"]],
  ["sossen", ["soße", "sauce", "dip", "dressing", "pesto", "aioli", "marinade"]],
  ["getraenke", ["smoothie", "cocktail", "shake", "limonade", "punsch", "bowle", "glühwein", "kakao"]],
  ["vegetarisch", ["gemüse", "veggie", "vegan", "vegetarisch", "tofu", "falafel"]],
];
const WORD_START = new Set(["eis", "dip", "reis", "ente", "gans", "huhn", "lamm", "hack", "keks"]);
function guessRecipeGroup(name, groups) {
  const low = String(name || "").toLowerCase();
  if (!low.trim()) return null;
  const words = low.split(/[^a-zäöüß]+/).filter(Boolean);
  // diese kurzen Wörter nur am Wortanfang – sonst findet „eis“ auch „Fleisch“ und „reis“ den „Milchreis“
  const hit = (w) => (WORD_START.has(w) ? words.some((x) => x.startsWith(w)) : low.includes(w));
  const byName = (list) => {
    for (const g of list) {
      for (const w of String(g.name).toLowerCase().split(/[^a-zäöüß]+/)) {
        const stem = w.slice(0, Math.max(4, w.length - 2));
        if (w.length >= 4 && words.some((x) => x.startsWith(stem))) return g.id;
      }
    }
    return null;
  };
  const known = new Set(GROUP_WORDS.map(([gid]) => gid));
  const ids = new Set((groups || []).map((g) => g.id));
  // 1) eigene, selbst angelegte Gruppen („Grillen“ findet „Grillwürstchen“)
  const own = byName((groups || []).filter((g) => !known.has(g.id)));
  if (own) return own;
  // 2) Wörterbuch
  for (const [gid, list] of GROUP_WORDS) if (ids.has(gid) && list.some(hit)) return gid;
  // 3) Namen der mitgelieferten Gruppen (falls umbenannt)
  return byName((groups || []).filter((g) => known.has(g.id)));
}

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
    for (const h of hints) for (const w of h.en || []) { // 🌍 englische Wörter nur als ganzes Wort
      if (w.length < minLen || w.length <= len) continue;
      if (new RegExp(`(?<![a-zäöüß])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:s|es)?(?![a-zäöüß])`).test(t)) { len = w.length; id = h.id; }
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
  hint.textContent = elT("Tippen zum Schließen");
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

// „#fff“, „#1c1c1c“, „rgb(225, 225, 225)“ -> [r, g, b]
function elRgb(c) {
  const s = String(c || "").trim();
  let m = s.match(/^#([0-9a-f]{3})$/i);
  if (m) return [...m[1]].map((h) => parseInt(h + h, 16));
  m = s.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i);
  if (m) return m.slice(1, 4).map((h) => parseInt(h, 16));
  m = s.match(/^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i);
  return m ? m.slice(1, 4).map(Number) : null;
}

function makeOverlay() {
  const ov = document.createElement("div");
  Object.assign(ov.style, {
    position: "fixed", inset: "0", background: "rgba(0,0,0,.9)", zIndex: "10000",
    display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
    padding: "16px", boxSizing: "border-box", color: "#fff", font: "15px Roboto, sans-serif",
    touchAction: "none", colorScheme: "dark",
  });
  ov.dataset.elov = "1"; // ↩️ für die Zurück-Taste der Offline-App
  document.body.appendChild(ov);
  elWatch(ov, false);
  return ov;
}

function ovButton(label, main = false) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  b.style.cssText = main ? OV_BTN_MAIN : OV_BTN;
  return b;
}

// 📷 Woher kommt das Foto? Kamera · Galerie · Einfügen (Zwischenablage) – gibt "camera" | "gallery" | "paste" | null
const elCanPaste = () => !!(window.isSecureContext && navigator.clipboard?.read);
// 📱 Läuft die Karte in der HA-App (Android/iPhone)? Mehrere Wege, weil die Apps das je nach Version anders verraten
const elInHaApp = (hass) => !!(
  window.externalApp || window.externalAppV2 || window.webkit?.messageHandlers?.getExternalAuth
  || window.webkit?.messageHandlers?.externalBus
  || (hass?.auth?.external && !window.__elOfflineApp) // HA selbst weiß es (nicht in unserer Offline-App)
  || /Home ?Assistant\/|HomeAssistant\/|io\.homeassistant/i.test(navigator.userAgent || "")
);
// 🖥️ PC/Laptop mit Maus (kein Touch)
const elIsPc = () => !!window.matchMedia?.("(hover: hover) and (pointer: fine)").matches && !(navigator.maxTouchPoints > 0);

// 🖥️ Am PC: Fenster mit großer Fläche – Bild reinziehen, Strg + V oder klicken. Gibt eine Datei, "browse" oder null
function askPhotoDrop(title = "🖼️ Foto hinzufügen") {
  return new Promise((resolve) => {
    const ov = makeOverlay();
    ov.style.background = "rgba(0,0,0,.7)";
    ov.innerHTML = `<div style="width:100%;max-width:460px;background:#222;border-radius:18px;padding:18px;box-shadow:0 4px 24px rgba(0,0,0,.5);display:flex;flex-direction:column;gap:12px">
      <div style="font:600 17px Roboto,sans-serif;text-align:center">${esc(elT(title))}</div>
      <div data-zone style="border:2px dashed rgba(255,255,255,.45);border-radius:14px;padding:34px 16px;text-align:center;cursor:pointer;line-height:1.5;transition:background .15s">
        <div style="font-size:34px">📥</div>
        <div><b>Bild hier reinziehen</b></div>
        <div>oder <b>Strg + V</b> drücken (z. B. Screenshot)</div>
        <div style="opacity:.75;font-size:.92em;margin-top:4px">oder klicken zum Auswählen</div>
        <div data-msg style="color:#ffb74d;margin-top:8px;min-height:1.2em"></div>
      </div>
    </div>`;
    const box = ov.firstElementChild;
    const zone = ov.querySelector("[data-zone]");
    const msg = ov.querySelector("[data-msg]");
    const cancel = ovButton("Abbrechen");
    box.appendChild(cancel);
    let over = false;
    const done = (v) => {
      if (over) return;
      over = true;
      document.removeEventListener("paste", onPaste, true);
      document.removeEventListener("keydown", onKey, true);
      clearInterval(watch);
      ov.remove();
      resolve(v);
    };
    const pick = (files) => {
      const f = [...(files || [])].find((x) => x.type?.startsWith("image/"));
      if (f) done(f);
      else msg.textContent = elT("Das war kein Bild 🙈");
    };
    const onPaste = (e) => {
      const f = [...(e.clipboardData?.items || [])].filter((i) => i.kind === "file").map((i) => i.getAsFile()).filter(Boolean);
      e.preventDefault();
      e.stopPropagation();
      pick(f);
    };
    const onKey = (e) => { if (e.key === "Escape") done(null); };
    document.addEventListener("paste", onPaste, true);
    document.addEventListener("keydown", onKey, true);
    const watch = setInterval(() => { if (!ov.isConnected) done(null); }, 400);
    zone.onclick = () => done("browse");
    zone.ondragover = (e) => { e.preventDefault(); zone.style.background = "rgba(255,255,255,.08)"; };
    zone.ondragleave = () => { zone.style.background = ""; };
    zone.ondrop = (e) => { e.preventDefault(); zone.style.background = ""; pick(e.dataTransfer?.files); };
    ov.ondragover = (e) => e.preventDefault();
    ov.ondrop = (e) => { e.preventDefault(); pick(e.dataTransfer?.files); };
    cancel.onclick = () => done(null);
    ov.onclick = (e) => { if (e.target === ov) done(null); };
  });
}

function askPhotoSource(camera = true, heading = "Foto – woher?") {
  return new Promise((resolve) => {
    const ov = makeOverlay();
    ov.style.justifyContent = "flex-end";
    ov.style.background = "rgba(0,0,0,.7)";
    const box = document.createElement("div");
    box.style.cssText = "width:100%;max-width:420px;display:flex;flex-direction:column;gap:10px;padding:16px;margin-bottom:10px;background:#222;border-radius:18px;box-shadow:0 4px 24px rgba(0,0,0,.5)";
    const title = document.createElement("div");
    title.textContent = elT(heading);
    title.style.cssText = "font:600 16px Roboto,sans-serif;text-align:center;opacity:.85";
    box.appendChild(title);
    const done = (v) => { ov.remove(); resolve(v); };
    const opts = camera ? [["camera", "📷 Kamera"], ["gallery", "🖼️ Galerie"]] : [["gallery", "🖼️ Galerie"]];
    if (elCanPaste()) opts.push(["paste", "📋 Einfügen (Zwischenablage)"]);
    for (const [v, label] of opts) {
      const b = ovButton(label, v === "camera");
      b.style.width = "100%";
      b.onclick = (e) => { e.stopPropagation(); done(v); };
      box.appendChild(b);
    }
    const cancel = ovButton("Abbrechen");
    cancel.style.width = "100%";
    cancel.onclick = (e) => { e.stopPropagation(); done(null); };
    box.appendChild(cancel);
    ov.appendChild(box);
    ov.onclick = (e) => { if (e.target === ov) done(null); };
  });
}

// 📷 Eigene Kamera mitten in der Karte (Live-Bild + Auslöser). Gibt eine Datei zurück,
// null = abgebrochen, undefined = Kamera geht hier nicht (kein https / nicht erlaubt) -> Galerie nehmen
async function elCameraShot() {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) return undefined;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false,
    });
  } catch (_) {
    return undefined;
  }
  return new Promise((resolve) => {
    const ov = makeOverlay();
    Object.assign(ov.style, { background: "#000", padding: "0", justifyContent: "space-between" });
    const video = document.createElement("video");
    Object.assign(video, { playsInline: true, muted: true, autoplay: true, srcObject: stream });
    video.setAttribute("playsinline", "");
    video.style.cssText = "flex:1;width:100%;min-height:0;object-fit:contain;background:#000";
    const bar = document.createElement("div");
    bar.style.cssText = "width:100%;display:flex;align-items:center;justify-content:space-around;padding:18px 16px calc(22px + env(safe-area-inset-bottom));box-sizing:border-box";
    const cancel = ovButton("✖");
    cancel.title = "Abbrechen";
    cancel.style.minWidth = "56px";
    const shot = document.createElement("button");
    shot.type = "button";
    shot.title = "Foto machen";
    shot.style.cssText = "width:74px;height:74px;border-radius:50%;border:5px solid #fff;background:rgba(255,255,255,.35);cursor:pointer;padding:0";
    // 🔄 Vorder-/Rückkamera wechseln
    let facing = "environment";
    const flip = ovButton("🔄");
    flip.title = "Kamera wechseln";
    flip.style.minWidth = "56px";
    flip.onclick = async () => {
      flip.disabled = true;
      const res = await elNextCamera(stream, facing);
      flip.disabled = false;
      if (!res) { flip.textContent = "🚫"; setTimeout(() => { flip.textContent = "🔄"; }, 1500); return; }
      stream = res.stream;
      facing = res.facing;
      video.srcObject = stream;
      video.style.transform = facing === "user" ? "scaleX(-1)" : ""; // Selfie wie im Spiegel
      if (res.failed) { flip.textContent = "🚫"; setTimeout(() => { flip.textContent = "🔄"; }, 1500); }
    };
    bar.append(cancel, shot, flip);
    ov.append(video, bar);
    let over = false;
    const finish = (file) => {
      if (over) return;
      over = true;
      clearInterval(watch);
      stream.getTracks().forEach((t) => t.stop());
      ov.remove();
      resolve(file);
    };
    const watch = setInterval(() => { if (!ov.isConnected) finish(null); }, 300); // ↩️ Zurück-Taste hat es geschlossen
    cancel.onclick = () => finish(null);
    shot.onclick = () => {
      const w = video.videoWidth, h = video.videoHeight;
      if (!w || !h) return;
      navigator.vibrate?.(20);
      const cv = document.createElement("canvas");
      cv.width = w;
      cv.height = h;
      cv.getContext("2d").drawImage(video, 0, 0, w, h);
      cv.toBlob((blob) => finish(blob ? new File([blob], "kamera.jpg", { type: "image/jpeg" }) : null), "image/jpeg", 0.92);
    };
  });
}

// 🔄 Nächste Kamera: erst die laufende AUSschalten (viele Handys erlauben nur eine gleichzeitig),
// dann eine Kamera mit der anderen Blickrichtung suchen. Klappt nichts, geht die alte wieder an.
async function elNextCamera(oldStream, facing) {
  const md = navigator.mediaDevices;
  const oldId = oldStream?.getVideoTracks?.()[0]?.getSettings?.().deviceId;
  let cams = [];
  try { cams = (await md.enumerateDevices()).filter((d) => d.kind === "videoinput"); } catch (_) { /* egal */ }
  oldStream?.getTracks().forEach((t) => t.stop());
  const want = facing === "user" ? "environment" : "user";
  const isFront = (c) => /front|user|vorder|selfie|facing front/i.test(c.label || "");
  const tries = [{ facingMode: { exact: want } }];
  const other = cams.filter((c) => c.deviceId && c.deviceId !== oldId);
  const pick = other.find((c) => (want === "user" ? isFront(c) : c.label && !isFront(c))) || other[0];
  if (pick) tries.unshift({ deviceId: { exact: pick.deviceId } });
  tries.push({ facingMode: want });
  for (const video of tries) {
    try {
      const stream = await md.getUserMedia({ audio: false, video: { ...video, width: { ideal: 1920 }, height: { ideal: 1080 } } });
      const got = stream.getVideoTracks()[0]?.getSettings?.() || {};
      if (got.deviceId && got.deviceId === oldId && cams.length > 1) { stream.getTracks().forEach((t) => t.stop()); continue; } // wieder dieselbe
      return { stream, facing: got.facingMode || (pick && video.deviceId ? (isFront(pick) ? "user" : "environment") : want) };
    } catch (_) { /* nächster Versuch */ }
  }
  try { // nichts gefunden: die alte Kamera wieder an
    const stream = await md.getUserMedia({ audio: false, video: oldId ? { deviceId: { exact: oldId } } : { facingMode: facing } });
    return { stream, facing, failed: true };
  } catch (_) { return null; }
}

// ❓ Kleine Auswahl-Frage: gibt den Wert der gewählten Option zurück (oder null)
function askChoice(text, options) {
  return new Promise((resolve) => {
    const ov = makeOverlay();
    const box = document.createElement("div");
    box.style.cssText = "width:100%;max-width:380px;display:flex;flex-direction:column;gap:10px;padding:16px;background:#222;border-radius:18px";
    const t = document.createElement("div");
    t.textContent = elT(text);
    t.style.cssText = "font:600 16px Roboto,sans-serif;text-align:center;margin-bottom:4px";
    box.appendChild(t);
    const done = (v) => { ov.remove(); resolve(v); };
    options.forEach(([v, label], i) => { const b = ovButton(label, i === 0); b.onclick = () => done(v); box.appendChild(b); });
    const c = ovButton("Abbrechen");
    c.onclick = () => done(null);
    box.appendChild(c);
    ov.appendChild(box);
    ov.onclick = (e) => { if (e.target === ov) done(null); };
  });
}

// 📋 Bild aus der Zwischenablage holen (null = keins drin / nicht erlaubt)
async function elClipboardImage() {
  const items = await navigator.clipboard.read();
  for (const it of items) {
    const type = it.types.find((t) => t.startsWith("image/"));
    if (type) {
      const blob = await it.getType(type);
      return new File([blob], "eingefuegt." + (type.split("/")[1] || "png"), { type });
    }
  }
  return null;
}

// 🔒 PIN-Eingabe wie am Handy: gibt die getippte PIN zurück (oder null bei „Abbrechen“)
function askPin(title = "🔒 PIN eingeben") {
  return new Promise((resolve) => {
    const ov = makeOverlay();
    let pin = "";
    ov.innerHTML = `<div style="text-align:center;max-width:300px;width:100%">
      <div style="font:600 19px Roboto,sans-serif;margin-bottom:6px">${esc(elT(title))}</div>
      <div class="pdots" style="font-size:28px;letter-spacing:10px;min-height:40px;margin:10px 0 16px">&nbsp;</div>
      <div class="ppad" style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px"></div></div>`;
    const dots = ov.querySelector(".pdots"), pad = ov.querySelector(".ppad");
    const show = () => { dots.innerHTML = pin ? "●".repeat(pin.length) : "&nbsp;"; };
    const done = (v) => { ov.remove(); document.removeEventListener("keydown", onKey); resolve(v); };
    const press = (k) => {
      if (k === "⌫") pin = pin.slice(0, -1);
      else if (k === "✔") { if (pin.length >= 4) done(pin); return; }
      else if (pin.length < 8) pin += k;
      show();
    };
    for (const k of ["1", "2", "3", "4", "5", "6", "7", "8", "9", "⌫", "0", "✔"]) {
      const b = ovButton(k, k === "✔");
      Object.assign(b.style, { fontSize: "24px", padding: "16px 0", margin: "0", width: "100%" });
      b.onclick = () => press(k);
      pad.append(b);
    }
    const cancel = ovButton(elT("Abbrechen"));
    Object.assign(cancel.style, { marginTop: "18px" });
    cancel.onclick = () => done(null);
    ov.firstElementChild.append(cancel);
    const onKey = (e) => {
      if (/^\d$/.test(e.key)) press(e.key);
      else if (e.key === "Backspace") press("⌫");
      else if (e.key === "Enter") press("✔");
      else if (e.key === "Escape") done(null);
    };
    document.addEventListener("keydown", onKey);
  });
}
// ✍️ Kleines Eingabefenster (statt prompt(), das in der HA-App nicht überall geht)
function askText(title, placeholder = "", value = "") {
  return new Promise((resolve) => {
    const ov = makeOverlay();
    ov.innerHTML = `<div style="max-width:340px;width:100%">
      <div style="font:600 18px Roboto,sans-serif;margin-bottom:10px">${esc(elT(title))}</div>
      <input style="width:100%;box-sizing:border-box;font:16px Roboto,sans-serif;padding:12px;border-radius:10px;border:1px solid #555;background:#1e1e1e;color:#eee" placeholder="${esc(elT(placeholder))}">
      <div class="abtn" style="display:flex;gap:10px;justify-content:flex-end;margin-top:14px"></div></div>`;
    const inp = ov.querySelector("input");
    inp.value = value || "";
    const done = (v) => { ov.remove(); resolve(v); };
    const ok = ovButton("OK", true), cancel = ovButton(elT("Abbrechen"));
    ok.onclick = () => done(inp.value.trim() || null);
    cancel.onclick = () => done(null);
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") ok.onclick(); else if (e.key === "Escape") done(null); });
    ov.querySelector(".abtn").append(cancel, ok);
    setTimeout(() => inp.focus(), 50);
  });
}
const elAppTheme = () => { try { return localStorage.getItem("einkaufsliste_theme") || "auto"; } catch (_) { return "auto"; } };
const PIN_KEY = "einkaufsliste_pin_until";
const pinUnlocked = () => { try { return Number(localStorage.getItem(PIN_KEY) || 0) > Date.now(); } catch (_) { return false; } };
const pinRemember = () => { try { localStorage.setItem(PIN_KEY, String(Date.now() + 10 * 60000)); } catch (_) { /* egal */ } };

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
:host([dark]) { color-scheme:dark; }
:host([dark]) option, :host([dark]) optgroup { background-color:var(--card-background-color, #1c1c1c); color:var(--primary-text-color, #e1e1e1); }
ha-card { display:block; padding:12px 12px 8px; overflow:hidden; }
* { box-sizing:border-box; }
button { font:inherit; color:inherit; }
.head { display:flex; align-items:center; gap:4px; margin:0 2px 8px; min-height:36px; }
.title { display:flex; align-items:center; gap:8px; font-size:1.25em; font-weight:600; flex:1; min-width:0; }
.title span.t { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.live { width:9px; height:9px; border-radius:50%; background:var(--success-color,#43a047); flex:0 0 auto; box-shadow:0 0 0 3px color-mix(in srgb, var(--success-color,#43a047) 25%, transparent); }
.live.wait { background:var(--warning-color,#ffa600); box-shadow:0 0 0 3px color-mix(in srgb, var(--warning-color,#ffa600) 30%, transparent); animation: pulse 1.6s infinite; }
.qwait { font-size:.8em; margin-left:4px; }
.live.off { background:var(--error-color,#db4437); box-shadow:0 0 0 3px color-mix(in srgb, var(--error-color,#db4437) 25%, transparent); animation: pulse 1.2s infinite; }
.updbar { margin:0 2px 8px; padding:8px 10px; border-radius:12px; background:color-mix(in srgb, var(--primary-color,#03a9f4) 14%, transparent); font-size:.88em; display:flex; align-items:center; gap:8px; }
.updbar b { flex:1; }
.tipbtn { font:inherit; font-size:.95em; border:0; border-radius:10px; padding:6px 10px; cursor:pointer; background:color-mix(in srgb, var(--primary-color,#03a9f4) 25%, transparent); color:var(--primary-text-color); }
.guidebtn { margin-left:auto; font:inherit; font-size:1em; display:inline-flex; align-items:center; gap:4px; border:1px solid var(--divider-color, rgba(127,127,127,.3)); border-radius:10px; padding:5px 10px; background:none; color:var(--primary-text-color); cursor:pointer; }
.wizard { margin:0 2px 10px; padding:12px; border-radius:14px; border:1px solid color-mix(in srgb, var(--primary-color,#03a9f4) 45%, transparent); background:color-mix(in srgb, var(--primary-color,#03a9f4) 8%, transparent); }
.wizard h4 { margin:0 0 4px; font-size:1.05em; }
.wizard ol { list-style:none; margin:8px 0; padding:0; display:grid; gap:6px; counter-reset:wz; }
.wizard li { counter-increment:wz; display:flex; align-items:center; gap:8px; }
.wizard li::before { content:counter(wz); flex:none; width:24px; height:24px; border-radius:50%; background:var(--primary-color,#03a9f4); color:#fff; display:grid; place-items:center; font-weight:700; font-size:.85em; }
.wizard li span { flex:1; }
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
#btnOcrList { margin-left:auto; } /* 📋 ganz rechts; kommt das Radiergummi, rutscht es einen nach links */
.newrec { display:flex; align-items:center; justify-content:center; gap:10px; width:100%; box-sizing:border-box; margin:0 0 12px; padding:13px 16px; border:0; border-radius:14px; cursor:pointer; font:inherit; font-size:16px; font-weight:600; color:#fff; background:linear-gradient(135deg,#43a047,#2e7d32); box-shadow:0 2px 8px rgba(46,125,50,.35); --mdc-icon-size:24px; transition:transform .1s, box-shadow .1s; }
.newrec:hover { box-shadow:0 3px 12px rgba(46,125,50,.5); }
.newrec:active { transform:scale(.98); }
.tool.tclear { color:var(--error-color,#db4437); }
#btnScan { position:relative; }
/* 📝 Notiz am Artikel: dezent hervorgehoben – etwas kräftiger, zarter Farbhauch */
.item .meta .inote, .pickrow .inote { color:var(--primary-text-color); font-weight:500; background:color-mix(in srgb, #f9a825 16%, transparent); border-radius:6px; padding:0 6px; }
.item.done .meta .inote { background:none; font-weight:400; color:inherit; }
#btnScan.instore, .tool.instore { color:var(--success-color,#43a047); background:color-mix(in srgb, var(--success-color,#43a047) 14%, transparent); }
#btnScan.instore::after, .tool.instore::after { content:"✓"; position:absolute; right:3px; bottom:2px; font-size:10px; font-weight:700; line-height:1; }
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
.lastq { border-style:dashed; }
.lastq small { opacity:.7; font-size:.8em; }
.unitchips { margin-top:6px; padding-top:6px; border-top:1px dashed var(--divider-color, rgba(127,127,127,.35)); }
.unitchips .chip2 { padding:4px 10px; min-width:34px; font-size:.85em; }
.unitchips .ulabel { font-size:.8em; opacity:.7; align-self:center; margin-right:2px; }
@keyframes pulse { 50% { opacity:.3; } }

.photobtn .pcount { font-size:10px; font-weight:700; margin-left:1px; }
.photobtn { background:none; border:0; cursor:pointer; padding:0 2px; color:var(--primary-color,#03a9f4); line-height:0; --mdc-icon-size:17px; align-self:center; }
.photorow { display:flex; flex-wrap:wrap; gap:6px; }
.photorow .btn { padding:6px 10px; font-size:.85em; }
form.add .row2 { grid-column: 1 / -1; display:grid; grid-auto-flow:column; grid-auto-columns:1fr; gap:6px; }
/* Geschäft + Kategorie nebeneinander: etwas kompakter, damit „Welches Geschäft?“ ganz draufpasst */
form.add .row2 select { font-size:.88em; padding:9px 4px 9px 7px; letter-spacing:-.1px; }
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
/* 🏪 Unter dem Artikel: Geschäft-Name mit zartem Hintergrund in der Geschäft-Farbe (wie die Notiz),
   statt Punkt davor – spart Platz und ist nicht aufdringlich. */
.meta .chip, .pmeta .chip { color:var(--primary-text-color); font-weight:500; gap:0; border-radius:6px; padding:0 6px;
  background:color-mix(in srgb, var(--c) 20%, transparent); }
.item.done .meta .chip { background:color-mix(in srgb, var(--c) 10%, transparent); font-weight:400; }
.meta .chip::before, .pmeta .chip::before { display:none; }
.item { border-left:4px solid var(--cc, transparent); padding-left:0; }
.item[style*="--rc"] { box-shadow: inset -4px 0 0 var(--rc); }
.item .txt { -webkit-user-select:none; user-select:none; -webkit-touch-callout:none; }
.item .qty { border:0; font:inherit; font-size:.85em; cursor:pointer; color:inherit; }
.item.new { background:color-mix(in srgb, var(--primary-color,#03a9f4) 7%, transparent); }
.newbadge { font-size:.9em; cursor:pointer; padding:0 2px; }
.bubble { background:var(--error-color,#e53935); color:#fff; border-radius:999px; font-size:.72em; font-weight:700; padding:1px 6px; margin-left:2px; }
.menurow, .qtyrow { display:flex; flex-wrap:wrap; align-items:center; gap:6px; padding:4px 8px 8px 44px; }
.menubtn.has { color:color-mix(in srgb, var(--mc) 68%, var(--primary-text-color)); border-color:color-mix(in srgb, var(--mc) 55%, transparent); background:color-mix(in srgb, var(--mc) 13%, transparent); }
.menubtn { display:inline-flex; align-items:center; gap:4px; border:1px solid var(--divider-color, rgba(127,127,127,.35)); background:transparent; border-radius:999px; padding:6px 10px; cursor:pointer; font-size:.85em; --mdc-icon-size:18px; }
.qbtn { width:40px; height:40px; border-radius:50%; border:1.5px solid var(--primary-color,#03a9f4); background:transparent; color:var(--primary-color,#03a9f4); font-size:1.3em; cursor:pointer; }
.qbtn[disabled] { opacity:.3; }
.qval { min-width:44px; text-align:center; font-weight:600; font-size:1.1em; }
ha-card.shop form.add { display:none; }
ha-card.shop #btnRecipes, ha-card.shop #btnSettings { display:none; }
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
.lgroup { display:flex; align-items:center; width:100%; margin:6px 0 2px; padding:10px 8px; box-sizing:border-box; font:inherit; font-size:1em; color:var(--primary-text-color); font-weight:600; background:var(--secondary-background-color, rgba(127,127,127,.12)); border:0; border-radius:10px; cursor:pointer; text-align:left; }
.lgroup .chev { flex:none; color:var(--secondary-text-color); }
.lrow { display:flex; align-items:center; gap:10px; width:100%; text-align:left; padding:10px 12px; margin:3px 0; border-radius:12px; cursor:pointer; border:1px solid var(--divider-color, rgba(127,127,127,.25)); background:var(--secondary-background-color, rgba(127,127,127,.06)); color:var(--primary-text-color); font:inherit; }
.lrow:hover { border-color:var(--primary-color,#03a9f4); }
.lrow > ha-icon:first-child { color:var(--primary-color,#03a9f4); }
.lrow small, .swrow small { display:block; color:var(--secondary-text-color); font-size:.8em; font-weight:400; }
.lrow .grow, .swrow .grow { flex:1 1 auto; min-width:0; }
.lrow .chev { opacity:.5; flex:none; }
.lrow b, .swrow b { display:block; }
.swrow { display:flex; align-items:center; gap:10px; padding:10px 12px; margin:4px 0; border-radius:12px; border:1px solid var(--divider-color, rgba(127,127,127,.25)); background:var(--secondary-background-color, rgba(127,127,127,.06)); }
.swrow > ha-icon { color:var(--primary-color,#03a9f4); }
.sw { position:relative; flex:none; width:48px; height:28px; border-radius:14px; border:0; cursor:pointer; background:rgba(127,127,127,.45); transition:background .15s; padding:0; }
.sw i { position:absolute; top:3px; left:3px; width:22px; height:22px; border-radius:50%; background:#fff; transition:left .15s; box-shadow:0 1px 3px rgba(0,0,0,.35); }
.sw.on { background:var(--primary-color,#03a9f4); }
.sw.on i { left:23px; }
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
.misshint { margin:2px 0 10px; padding:10px 12px; border-radius:12px; background:color-mix(in srgb, var(--warning-color,#ffa600) 16%, transparent); }
.misshint .dbtns { display:flex; flex-wrap:wrap; gap:6px; margin-top:8px; }
.movewarn { flex-basis:100%; font-size:.9em; color:var(--warning-color,#ffa600); font-weight:600; }
.alsohere { display:flex; flex-wrap:wrap; gap:6px; align-items:center; margin:2px 0 10px; padding:8px 10px; border-radius:12px; background:color-mix(in srgb, var(--primary-color,#03a9f4) 8%, transparent); font-size:.92em; }
.pestores { display:flex; flex-wrap:wrap; gap:6px; align-items:center; font-size:.92em; }
.pestores .stck { display:inline-flex; align-items:center; gap:4px; border-radius:999px; padding:3px 10px 3px 6px; background:color-mix(in srgb, var(--c) 16%, transparent); cursor:pointer; }
.prodedit { display:grid; grid-template-columns:1fr 1fr; gap:6px; padding:8px; border-radius:12px; background:var(--secondary-background-color, rgba(127,127,127,.07)); margin:6px 0; }
.prodedit .btnrow, .prodedit .hint, .prodedit .pestores, .prodedit .bclist { grid-column:1/-1; }
.prodrow .btn.primary { white-space:nowrap; flex:0 0 auto; }
.ppers { display:flex; align-items:center; gap:6px; flex-wrap:wrap; padding:6px 4px 10px; border-bottom:1px solid var(--divider-color, rgba(127,127,127,.25)); margin-bottom:6px; }
.ppers > span { font-weight:600; }
.ppers b { min-width:26px; text-align:center; font-size:1.2em; }
.ppers small { opacity:.7; flex-basis:100%; }
.pscaled { color:var(--primary-color,#03a9f4); }
.pstore { display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin:-2px 0 6px 34px; font-size:.9em; }
.pstore select { width:auto; min-width:140px; }
.pstore.need span { color:var(--warning-color,#ff9800); font-weight:600; }
.pmiss { color:var(--warning-color,#ff9800); }
.rserv input { width:70px; text-align:center; }
.rserv select { width:auto; }
.servtag { font-weight:400; opacity:.75; }
.rgrouprow select { width:auto; min-width:150px; }
#titleIcon { cursor:pointer; }
#mascot { cursor:pointer; display:inline-flex; color:var(--primary-text-color); }
#mascot[hidden] { display:none; }
.mascot.full { animation: mwobble 1.6s ease-in-out infinite; transform-origin: 50% 90%; }
.mascot.hop { animation: mhop .6s ease-out 1; }
@keyframes mwobble { 0%,100% { transform: rotate(0); } 25% { transform: rotate(-4deg); } 75% { transform: rotate(4deg); } }
@keyframes mhop { 0% { transform: translateY(0); } 40% { transform: translateY(-6px); } 100% { transform: translateY(0); } }
@media (prefers-reduced-motion: reduce) { .mascot.full, .mascot.hop { animation: none; } }
.item .meta .iout { color:var(--primary-text-color); font-weight:500; background:color-mix(in srgb, var(--error-color, #db4437) 9%, transparent); border-radius:6px; padding:0 6px; font-weight:400; }
.moverow .outbtn { --c:var(--primary-color,#03a9f4); display:inline-flex; align-items:center; gap:4px; --mdc-icon-size:16px; }
/* 👨‍🍳 Knöpfe unter der Kochmütze: Foto blau, Kochen rot, Teilen grün (nur das Symbol) */
.rtools [data-act="photo-view"] ha-icon { color:var(--primary-color,#03a9f4); }
.rtools [data-act="recipe-cook"] ha-icon { color:var(--error-color,#e53935); }
.rtools [data-act="recipe-share"] ha-icon { color:var(--success-color,#43a047); }
.rbtns [data-act="recipe-apply"] { background:transparent; color:var(--primary-text-color); border:2px solid var(--primary-color,#03a9f4); } /* 🛒 Auf die Liste: blauer Rahmen, nicht gefüllt */
.rtools [data-act="recipe-apply"] ha-icon, [data-act="recipe-apply"] ha-icon { color:var(--success-color,#43a047); } /* 🛒 Wagen grün */
.bclist { display:flex; flex-wrap:wrap; gap:6px; }
.bcchip { display:inline-flex; align-items:center; gap:2px; font-size:.85em; padding:0 0 0 8px; border:1px solid var(--divider-color, rgba(127,127,127,.35)); border-radius:8px; --mdc-icon-size:18px; }
.chklist { display:flex; flex-direction:column; gap:6px; margin:8px 0; }
.chkrow { display:flex; gap:10px; align-items:flex-start; padding:8px 10px; border:1px solid var(--divider-color, rgba(127,127,127,.3)); border-radius:10px; cursor:pointer; }
.chkrow input.chk { margin-top:3px; width:18px; height:18px; flex:0 0 auto; }
.chkrow .ctxt { display:flex; flex-direction:column; gap:3px; min-width:0; flex:1; }
.chkrow .cwhat { font-weight:500; overflow-wrap:anywhere; }
.chkrow .chow { font-size:.85em; color:var(--secondary-text-color); }
.chkrow select { margin-top:2px; max-width:100%; }
.checklist { margin:4px 0 8px; padding-left:20px; font-size:.9em; }
.checklist li { margin:2px 0; }
.subtabs { display:flex; gap:6px; flex-wrap:wrap; margin:2px 0 8px; }
.subtabs .tab ha-icon { --mdc-icon-size:18px; }
.xferfmt { margin:4px 0 10px; padding-left:20px; }
.missed { background:color-mix(in srgb, var(--warning-color,#ffa600) 12%, transparent); border-radius:10px; padding:8px 12px; margin:4px 0 10px; }
.prodrow.marked { outline:2px solid var(--primary-color,#03a9f4); outline-offset:-2px; background:color-mix(in srgb, var(--primary-color,#03a9f4) 10%, transparent); }
.prodrow:focus { outline:2px solid var(--primary-color,#03a9f4); outline-offset:-2px; }
.offtag { cursor:pointer; }
.offgone { opacity:.75; }
.health { display:flex; align-items:center; gap:10px; width:100%; box-sizing:border-box; margin:0 0 10px; padding:10px 12px; border-radius:12px; border:1px solid var(--divider-color, rgba(127,127,127,.25)); border-left-width:5px; background:var(--secondary-background-color, rgba(127,127,127,.06)); color:var(--primary-text-color); font:inherit; text-align:left; cursor:pointer; }
.health.ok { border-left-color:#43a047; } .health.warn { border-left-color:#fb8c00; } .health.bad { border-left-color:#e53935; } .health.wait { border-left-color:#9e9e9e; }
.health small { display:block; color:var(--secondary-text-color); }
.errrow { padding:6px 8px; border-radius:10px; background:var(--secondary-background-color, rgba(127,127,127,.07)); margin:4px 0; font-size:.9em; word-break:break-word; }
.errrow small { color:var(--secondary-text-color); display:block; }
.sprow { display:flex; align-items:center; gap:6px; margin:4px 0; }
.sprow .sptxt { flex:1; font-size:.9em; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.pemerge { grid-column:1/-1; display:flex; flex-wrap:wrap; gap:6px; align-items:center; padding:8px; border-radius:10px; border:1px dashed var(--divider-color, rgba(127,127,127,.4)); }
.pemerge select { flex:1; min-width:140px; }
.iinstead { opacity:.8; font-style:italic; }
.offinfo { color:color-mix(in srgb, #e53935 70%, var(--primary-text-color)); font-weight:600; }
#btnNewBarcode.plus::before { content:"+"; position:absolute; top:1px; right:4px; font:700 13px/1 Roboto,sans-serif; }
.chip2.offsearch { border-style:dashed; }
.warnbox { background:color-mix(in srgb, var(--warning-color,#ffa600) 12%, transparent); border-radius:10px; padding:8px 12px; }
.stats { display:flex; flex-direction:column; gap:2px; }
.statrow { display:flex; align-items:center; gap:10px; padding:6px 8px; border-radius:8px; background:var(--secondary-background-color, rgba(127,127,127,.06)); }
.statrow .grow { flex:1; min-width:0; }
.elcredits { text-align:center; } .elcredits p { margin:8px 0; }
.ellogo { background:#fff; border-radius:14px; padding:10px; display:inline-block; max-width:100%; box-shadow:0 1px 4px rgba(0,0,0,.12); }
.ellogo img { display:block; max-width:100%; width:280px; height:auto; }
.elcbtns { display:flex; flex-wrap:wrap; gap:8px; justify-content:center; margin:12px 0; }
.elcbtn { color:var(--primary-text-color); background:var(--secondary-background-color, rgba(127,127,127,.12)); border-radius:12px; padding:10px 14px; text-decoration:none; font-weight:500; }
.elcsmall { opacity:.7; font-size:.9em; }
.catordlist { display:flex; flex-direction:column; gap:2px; margin:4px 0 6px; }
.catord { display:flex; align-items:center; gap:8px; padding:3px 6px; border-radius:8px; background:var(--secondary-background-color, rgba(127,127,127,.06)); }
.catord .con { min-width:1.6em; opacity:.6; font-variant-numeric:tabular-nums; }
.catord .grow { flex:1; min-width:0; }
.missed .mrow { margin-top:4px; display:flex; align-items:center; gap:6px; }
.missed .mtxt { flex:1; min-width:0; }
.missed .mx { flex:none; opacity:.6; --mdc-icon-size:18px; }
.missed .mn { display:inline-block; min-width:2.2em; font-weight:700; color:var(--warning-color,#ffa600); }
.xferfmt li { margin:3px 0; }
#xferText { width:100%; box-sizing:border-box; font:inherit; padding:8px; border-radius:8px; border:1px solid var(--divider-color,#ccc); background:var(--card-background-color); color:var(--primary-text-color); margin:4px 0 6px; }
label.btn { cursor:pointer; }
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
.recipe .rname b { display:block; word-break:normal; overflow-wrap:break-word; hyphens:auto; -webkit-hyphens:auto; }
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
.storetile { border-left:6px solid var(--sc); }
.storetile ha-icon { color:var(--sc); }
.storehead { display:flex; align-items:center; gap:8px; font-size:1.1em; margin:4px 2px 8px; }
.storehead ha-icon { color:var(--sc); }
.zonechips { display:flex; flex-wrap:wrap; gap:6px; align-items:center; }
.zchip { display:inline-flex; align-items:center; gap:2px; border-radius:999px; padding:2px 4px 2px 10px; font-size:.9em;
  background:color-mix(in srgb, var(--primary-color,#03a9f4) 14%, transparent); }
.zchip .zx { border:0; background:none; color:inherit; cursor:pointer; font:inherit; padding:2px 6px; opacity:.7; }
.zadd { flex:1 1 140px; min-width:0; }
.mascotprev { display:flex; gap:14px; align-items:center; margin:8px 0; color:var(--primary-text-color); }
.mascotprev svg { width:48px; height:43px; }
[hidden] { display:none !important; }
`;

// ⏲️ Gar-Zeiten-Spickzettel (Richtwerte). Je Zeile: [deutsch, englisch, Topf/Pfanne, Backofen, Heißluftfritteuse, Hinweis de, Hinweis en]
// Zeiten in Minuten; Backofen = Ober-/Unterhitze vorgeheizt.
const GAR = [
  ["🍝", "Nudeln & Reis", "Pasta & rice", [
    ["Spaghetti", "Spaghetti", "8–10", "", "", "sprudelnd, gut gesalzen", "rolling boil, well salted"],
    ["Penne, Fusilli", "Penne, fusilli", "10–12", "", "", "", ""],
    ["Frische Nudeln", "Fresh pasta", "2–4", "", "", "aus dem Kühlregal", "from the fridge"],
    ["Lasagne", "Lasagne", "", "180 °C · 35–45", "", "", ""],
    ["Reis (Langkorn)", "Rice (long grain)", "15–20", "", "", "1 Tasse Reis : 2 Tassen Wasser", "1 cup rice : 2 cups water"],
    ["Basmati-Reis", "Basmati rice", "10–12", "", "", "1 : 1,5 Wasser", "1 : 1.5 water"],
    ["Risotto-Reis", "Risotto rice", "18–20", "", "", "Brühe nach und nach", "add stock bit by bit"],
    ["Couscous", "Couscous", "5", "", "", "nur quellen: 1 : 1 kochendes Wasser", "just soak: 1 : 1 boiling water"],
    ["Quinoa", "Quinoa", "12–15", "", "", "1 : 2 Wasser", "1 : 2 water"],
  ]],
  ["🥔", "Kartoffeln", "Potatoes", [
    ["Pellkartoffeln", "Jacket potatoes (boiled)", "20–25", "", "", "je nach Größe", "depending on size"],
    ["Salzkartoffeln", "Boiled potatoes (quartered)", "15–20", "", "", "geschält, geviertelt", "peeled, quartered"],
    ["Kartoffelspalten", "Potato wedges", "", "200 °C · 30–40", "200 °C · 20–25", "", ""],
    ["Pommes (TK)", "Fries (frozen)", "", "220 °C · 20–25", "200 °C · 15–18", "zwischendurch wenden/schütteln", "turn/shake halfway"],
    ["Süßkartoffel-Spalten", "Sweet potato wedges", "", "200 °C · 25–30", "190 °C · 15–18", "", ""],
    ["Kroketten (TK)", "Croquettes (frozen)", "", "220 °C · 15–20", "200 °C · 10–12", "", ""],
  ]],
  ["🥚", "Eier", "Eggs", [
    ["Ei weich", "Egg soft", "5", "", "", "ab kochendem Wasser, Größe M", "from boiling water, size M"],
    ["Ei wachsweich", "Egg medium", "7", "", "", "", ""],
    ["Ei hart", "Egg hard", "10", "", "", "danach kalt abschrecken", "then rinse cold"],
    ["Spiegelei", "Fried egg", "3–4", "", "", "Pfanne, mittlere Hitze", "pan, medium heat"],
    ["Rührei", "Scrambled eggs", "2–3", "", "", "Pfanne, niedrige Hitze", "pan, low heat"],
  ]],
  ["🥦", "Gemüse", "Vegetables", [
    ["Brokkoli", "Broccoli", "4–6", "200 °C · 15–20", "180 °C · 8–10", "Röschen", "florets"],
    ["Blumenkohl", "Cauliflower", "8–12", "200 °C · 20–25", "180 °C · 12–15", "Röschen", "florets"],
    ["Möhren", "Carrots", "8–10", "200 °C · 25–30", "180 °C · 12–15", "in Scheiben", "sliced"],
    ["Grüne Bohnen", "Green beans", "8–10", "", "", "", ""],
    ["Erbsen (TK)", "Peas (frozen)", "3–5", "", "", "", ""],
    ["Spargel weiß", "White asparagus", "12–15", "", "", "je nach Dicke", "depending on thickness"],
    ["Spargel grün", "Green asparagus", "5–8", "200 °C · 12–15", "180 °C · 7–9", "", ""],
    ["Maiskolben", "Corn on the cob", "10–15", "", "200 °C · 10–12", "", ""],
    ["Zucchini", "Zucchini", "5–7", "200 °C · 15–20", "180 °C · 8–10", "Pfanne, in Scheiben", "pan, sliced"],
    ["Gemüse-Mix (TK)", "Mixed vegetables (frozen)", "8–10", "", "", "Pfanne", "pan"],
  ]],
  ["🍗", "Fleisch", "Meat", [
    ["Hähnchenbrust", "Chicken breast", "6–8", "180 °C · 20–25", "180 °C · 15–18", "Pfanne: pro Seite · innen 74 °C", "pan: per side · 74 °C inside"],
    ["Hähnchenschenkel", "Chicken legs", "", "200 °C · 40–45", "190 °C · 25–30", "", ""],
    ["Schnitzel (paniert)", "Schnitzel (breaded)", "3–4", "", "", "Pfanne: pro Seite", "pan: per side"],
    ["Steak (2–3 cm, medium)", "Steak (2–3 cm, medium)", "3–4", "", "", "pro Seite, dann 5 Min ruhen lassen", "per side, then rest 5 min"],
    ["Frikadellen", "Meatballs / patties", "10–12", "", "180 °C · 10–12", "Pfanne, öfter wenden", "pan, turn often"],
    ["Bratwurst", "Bratwurst", "10–12", "", "180 °C · 10–12", "", ""],
    ["Hackfleisch", "Minced meat", "8–10", "", "", "krümelig braten", "fry until crumbly"],
  ]],
  ["🐟", "Fisch", "Fish", [
    ["Lachsfilet", "Salmon fillet", "3–4", "180 °C · 12–15", "180 °C · 8–10", "Pfanne: pro Seite", "pan: per side"],
    ["Fischstäbchen", "Fish sticks", "3–4", "220 °C · 15–20", "200 °C · 8–10", "Pfanne: pro Seite", "pan: per side"],
    ["Garnelen", "Prawns", "2–3", "", "", "Pfanne, bis sie rosa sind", "pan, until pink"],
  ]],
  ["🍕", "TK & Aufbacken", "Frozen & bake-off", [
    ["TK-Pizza", "Frozen pizza", "", "220 °C · 10–15", "180 °C · 8–10", "Packung beachten", "check the package"],
    ["Chicken Nuggets", "Chicken nuggets", "", "200 °C · 15–20", "200 °C · 8–10", "", ""],
    ["Aufbackbrötchen", "Bake-off rolls", "", "200 °C · 6–8", "180 °C · 4–6", "", ""],
    ["Flammkuchen (TK)", "Tarte flambée (frozen)", "", "220 °C · 10–12", "", "", ""],
  ]],
];

// 🔎 Texterkennung (OCR): Tesseract läuft im Browser – das Foto verlässt das Gerät nicht.
// Die Dateien (ca. 5 MB) werden erst geladen, wenn jemand „Text aus Foto“ benutzt.
const elOcr = { T: null, worker: null, log: null, timer: 0 };
function elOcrLib() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  return (elOcr.T ||= new Promise((ok, fail) => {
    const sc = document.createElement("script");
    sc.src = `${EL_BASE}/ocr/tesseract.min.js?v=${EL_VERSION}`;
    sc.onload = () => (window.Tesseract ? ok(window.Tesseract) : fail(new Error("Texterkennung nicht gefunden")));
    sc.onerror = () => { elOcr.T = null; fail(new Error("Texterkennung konnte nicht geladen werden")); };
    document.head.append(sc);
  }));
}
async function elOcrRead(dataUrl, onProgress) {
  const T = await elOcrLib();
  elOcr.log = onProgress || null;
  clearTimeout(elOcr.timer);
  if (!elOcr.worker) {
    elOcr.worker = await T.createWorker("deu", 1, {
      workerPath: `${EL_BASE}/ocr/worker.min.js`,
      corePath: `${EL_BASE}/ocr/tesseract-core-simd-lstm.wasm.js`,
      langPath: `${EL_BASE}/ocr`, gzip: true, cacheMethod: "none", workerBlobURL: false,
      logger: (m) => elOcr.log?.(m),
    });
  }
  try {
    const { data } = await elOcr.worker.recognize(dataUrl);
    return String(data?.text || "");
  } finally {
    elOcr.timer = setTimeout(() => { elOcr.worker?.terminate?.().catch?.(() => {}); elOcr.worker = null; }, 120000); // Speicher wieder freigeben
  }
}

// 🧾 Kassenbon lesen: Betrag („zu zahlen“, „Summe“ …), Datum und Geschäft herausfischen
function elReceiptInfo(text, stores = [], today = new Date()) {
  const lines = String(text || "").split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const moneyRx = /(\d{1,3}(?:\.\d{3})+,\d{2}|\d+\s?[,.]\s?\d{2})(?!\d)/g;
  const money = (l) => [...l.replace(/\d{1,2}[.\-/]\d{1,2}[.\-/]\d{2,4}|\d{1,2}:\d{2}(?::\d{2})?/g, " ").matchAll(moneyRx)].map((m) => { // Datum und Uhrzeit sind keine Beträge
    let v = m[1].replace(/\s/g, "");
    v = v.includes(",") ? v.replace(/\./g, "").replace(",", ".") : v;
    return parseFloat(v);
  }).filter((n) => n > 0 && n < 10000);
  const strong = /(zu zahlen|zahlbetrag|gesamtbetrag|gesamtsumme|endbetrag|summe|total|gesamt|betrag)/i;
  const skip = /(gegeben|r[üu]e?ckgeld|zur[üu]ck|wechselgeld|mwst|mehrwertsteuer|\bust\b|steuer|netto|brutto|rabatt|ersparnis|gespart|pfand|punkte|payback)/i;
  const card = /(girocard|\bec\b|karte|visa|master|maestro|kreditkarte|bar\b)/i;
  const pickMax = (rx, notRx) => {
    const all = lines.filter((l) => rx.test(l) && !(notRx && notRx.test(l))).flatMap(money);
    return all.length ? Math.max(...all) : null;
  };
  // 🎯 Weitere Kandidaten zum Antippen: erst „Summe“-Zeilen, dann Kartenzeilen, dann die größten übrigen Beträge
  const cands = [];
  const addC = (arr) => arr.forEach((v) => { if (!cands.some((c) => Math.abs(c - v) < 0.005)) cands.push(v); });
  addC(lines.filter((l) => strong.test(l) && !skip.test(l)).flatMap(money).sort((a, b) => b - a));
  addC(lines.filter((l) => card.test(l) && !/(gegeben|r[üu]e?ckgeld|wechselgeld)/i.test(l)).flatMap(money).sort((a, b) => b - a));
  addC(lines.filter((l) => !skip.test(l)).flatMap(money).sort((a, b) => b - a).slice(0, 4));
  let amount = pickMax(strong, skip), sure = true;
  if (amount == null) amount = pickMax(card, /(gegeben|r[üu]e?ckgeld|wechselgeld)/i);
  if (amount == null) {
    const all = lines.filter((l) => !skip.test(l)).flatMap(money);
    amount = all.length ? Math.max(...all) : null;
    sure = false;
  }
  let day = null;
  const dm = String(text || "").match(/(\d{2})[.\-/](\d{2})[.\-/](\d{4}|\d{2})(?!\d)/);
  if (dm) {
    const y = dm[3].length === 2 ? 2000 + Number(dm[3]) : Number(dm[3]);
    const d = new Date(y, Number(dm[2]) - 1, Number(dm[1]), 12);
    const ago = (today - d) / 86400000;
    if (!Number.isNaN(d.getTime()) && ago >= 0 && ago <= 120) day = `${y}-${dm[2]}-${dm[1]}`;
  }
  const flat = String(text || "").toLowerCase().replace(/[^a-zäöüß0-9]/g, "");
  let store = null;
  for (const st of stores) {
    const n = String(st.name || "").toLowerCase().replace(/[^a-zäöüß0-9]/g, "");
    if (n.length >= 3 && flat.includes(n) && (!store || n.length > store.n)) store = { id: st.id, n: n.length };
  }
  return { amount, sure, day, store: store?.id || null, alts: cands.filter((v) => v !== amount && Math.abs(v - (amount ?? -1)) > 0.005).slice(0, 3) };
}

// 🍳 Rezept-Seite lesen: Name, Zutaten und Schritte trennen (an den Überschriften „Zutaten“ / „Zubereitung“)
function elOcrRecipeParts(text) {
  const raw = String(text || "").replace(/\r/g, "");
  const lines = raw.split("\n");
  const isIng = (l) => /^\W*zutaten\b/i.test(l.trim());
  const isSteps = (l) => /^\W*(zubereitung|zubereiten|anleitung|so geht'?s|arbeitsschritte)\b/i.test(l.trim());
  let ing = -1, st = -1;
  lines.forEach((l, n) => { if (ing < 0 && isIng(l)) ing = n; if (st < 0 && isSteps(l)) st = n; });
  const name = (lines.find((l) => l.trim() && !isIng(l) && !isSteps(l)) || "").trim().replace(/^[^A-Za-zÄÖÜäöü0-9]+|[^A-Za-zÄÖÜäöü0-9)!?.]+$/g, "");
  const cut = (from, to) => lines.slice(from, to < 0 ? undefined : to).filter((l) => l.trim());
  let ingLines = [], stepText = "";
  if (ing >= 0) ingLines = cut(ing + 1, st > ing ? st : -1);
  if (st >= 0) {
    const body = lines.slice(st + 1).join("\n").trim();
    const paras = body.split(/\n\s*\n/).map((p) => p.replace(/\s*\n\s*/g, " ").trim()).filter(Boolean);
    stepText = (paras.length > 1 ? paras : body.split(/(?<=[.!?])\s+(?=[A-ZÄÖÜ])/).map((x) => x.replace(/\s*\n\s*/g, " ").trim())).filter(Boolean).join("\n");
  }
  if (ing < 0 && st < 0) ingLines = lines.filter((l) => l.trim()).slice(1);
  return { name, ingredients: ingLines.map((l) => l.replace(/^[\s\-–—•*·|]+/, "").trim()).filter((l) => l.length > 1).join("\n"), steps: stepText };
}

// 📋 Text kopieren – mit Ersatzweg, falls das Handy die Zwischenablage sperrt (z. B. ohne https)
function elCopy(text, inp) {
  const old = () => {
    try {
      let tmp = null;
      if (!inp) { tmp = document.createElement("textarea"); tmp.value = text; tmp.style.cssText = "position:fixed;opacity:0;top:0;left:0"; document.body.appendChild(tmp); }
      (inp || tmp).select();
      document.execCommand?.("copy");
      tmp?.remove();
    } catch (_) { /* egal */ }
  };
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text).catch(old);
  old();
  return Promise.resolve();
}

// Die drei Geräte = die drei Reiter. col = Spalte in GAR, hint = Hinweis oben im Reiter
const GAR_DEV = [
  { col: 2, icon: "🍲", de: "Herd", en: "Stove", hintDe: "Topf oder Pfanne. Zeiten ab kochendem Wasser bzw. heißer Pfanne.", hintEn: "Pot or pan. Times from boiling water or a hot pan." },
  { col: 3, icon: "🔥", de: "Backofen", en: "Oven", hintDe: "Ober-/Unterhitze, vorgeheizt. Umluft: etwa 20 °C weniger.", hintEn: "Top/bottom heat, preheated. Fan: about 20 °C less." },
  { col: 4, icon: "💨", de: "Heißluft\u00adfritteuse", en: "Air fryer", hintDe: "Nicht zu voll machen, zwischendurch schütteln.", hintEn: "Don't overfill, shake halfway." },
];
// Hinweise, die nur zum Herd passen (Pfanne, Wasser …), im Backofen/in der Fritteuse weglassen
const GAR_STOVE_NOTE = /pfanne|\bpan\b|wasser|water|kochend|boil|brühe|stock|tasse|cup/i;

function showGarTable() {
  const en = EL_LANG !== "de";
  const ov = makeOverlay();
  Object.assign(ov.style, { background: "#111", justifyContent: "flex-start", overflowY: "auto", touchAction: "pan-y",
    paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 40px)" });
  const min = en ? "min" : "Min";
  let dev = 0;
  ov.innerHTML = `<style>
    .gar { width:100%; max-width:560px; color:#eee; font:15px/1.4 Roboto,sans-serif; }
    .gar h2 { font-size:20px; margin:4px 0 10px; }
    .gar .sub { color:#aaa; font-size:13px; margin:0 0 10px; }
    .gar input { width:100%; box-sizing:border-box; font:inherit; padding:10px 12px; border-radius:10px; border:1px solid #444; background:#1e1e1e; color:#eee; margin-bottom:10px; }
    .gar .gtabs { display:grid; grid-template-columns:repeat(3, 1fr); gap:6px; margin-bottom:8px; }
    .gar .gtabs button { font:inherit; font-size:14px; hyphens:manual; overflow-wrap:anywhere; color:#eee; background:#1e1e1e; border:1px solid #444; border-radius:12px; padding:8px 4px; cursor:pointer; line-height:1.2; }
    .gar .gtabs button b { display:block; font-size:22px; margin-bottom:2px; }
    .gar .gtabs button.on { background:#03a9f4; border-color:#03a9f4; color:#fff; }
    .gar .row { background:#1e1e1e; border:1px solid #2c2c2c; border-radius:12px; padding:9px 12px; margin:0 0 6px; }
    .gar .top { display:flex; align-items:baseline; gap:10px; }
    .gar .n { font-weight:600; font-size:16px; flex:1; }
    .gar .v { font-weight:700; white-space:nowrap; color:#fff; }
    .gar .note { color:#aaa; font-size:13px; margin-top:1px; }
    .gar .t { display:flex; flex-wrap:wrap; gap:6px 14px; margin-top:6px; font-size:15px; }
    .gar .t span { white-space:nowrap; }
    .gar h3 { font-size:13px; color:#aaa; margin:12px 0 5px; font-weight:600; }
  </style>
  <div class="gar" translate="no">
    <h2>⏲️ ${en ? "Cooking times" : "Gar-Zeiten"}</h2>
    <input type="search" placeholder="${en ? "Search, e.g. egg" : "Suchen, z. B. Ei"}">
    <div class="gtabs"></div>
    <p class="sub devhint"></p>
    <div class="garlist"></div>
    <p class="sub">${en ? "Guide values – always check the package." : "Richtwerte – im Zweifel gilt die Packung."}</p>
  </div>`;
  const list = ov.querySelector(".garlist"), inp = ov.querySelector("input"), tabs = ov.querySelector(".gtabs"), hint = ov.querySelector(".devhint");
  const name = (r) => esc(en ? r[1] : r[0]);
  const noteOf = (r, col) => {
    const n = en ? r[6] : r[5];
    return n && (col === 2 || !GAR_STOVE_NOTE.test(n)) ? n : "";
  };
  // eine Zeile im Geräte-Reiter: Name links, Zeit rechts
  const devRow = (r, col) => {
    const note = noteOf(r, col);
    return `<div class="row"><div class="top"><span class="n">${name(r)}</span><span class="v">${esc(r[col])} ${min}</span></div>${note ? `<div class="note">${esc(note)}</div>` : ""}</div>`;
  };
  // bei der Suche: alle Geräte auf einen Blick
  const fullRow = (r) => {
    const t = GAR_DEV.filter((d) => r[d.col]).map((d) => `<span>${d.icon} ${en ? d.en : d.de}: <b>${esc(r[d.col])} ${min}</b></span>`).join("");
    const note = en ? r[6] : r[5];
    return `<div class="row"><div class="n">${name(r)}</div>${note ? `<div class="note">${esc(note)}</div>` : ""}<div class="t">${t}</div></div>`;
  };
  const draw = () => {
    const q = inp.value.trim().toLowerCase();
    tabs.hidden = hint.hidden = !!q;
    tabs.innerHTML = GAR_DEV.map((d, i) => `<button class="${i === dev ? "on" : ""}" data-d="${i}"><b>${d.icon}</b>${en ? d.en : d.de}</button>`).join("");
    if (!q) {
      const d = GAR_DEV[dev];
      hint.textContent = en ? d.hintEn : d.hintDe;
      list.innerHTML = GAR.map(([icon, gde, gen, rows]) => {
        const hit = rows.filter((r) => r[d.col]);
        return hit.length ? `<h3>${icon} ${esc(en ? gen : gde)}</h3>${hit.map((r) => devRow(r, d.col)).join("")}` : "";
      }).join("");
      return;
    }
    list.innerHTML = GAR.map(([icon, gde, gen, rows]) => {
      const hit = rows.filter((r) => r[0].toLowerCase().includes(q) || r[1].toLowerCase().includes(q) || gde.toLowerCase().includes(q) || gen.toLowerCase().includes(q));
      return hit.length ? `<h3>${icon} ${esc(en ? gen : gde)}</h3>${hit.map(fullRow).join("")}` : "";
    }).join("") || `<p class="sub">${en ? "Nothing found." : "Nichts gefunden."}</p>`;
  };
  tabs.addEventListener("click", (e) => { const b = e.target.closest("[data-d]"); if (b) { dev = Number(b.dataset.d); draw(); ov.scrollTop = 0; } });
  inp.addEventListener("input", draw);
  draw();
  const bClose = ovButton(en ? "Close" : "Schließen", true);
  Object.assign(bClose.style, { marginTop: "16px" });
  ov.append(bClose);
  const close = () => { ov.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  bClose.onclick = close;
}

// 🛒😊 Maskottchen: ein kleiner Einkaufswagen mit Gesicht – seine Laune hängt an der Liste
function easterDate(y) { // Gauß'sche Osterformel
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(y, month - 1, day);
}
function mascotMood(open, now = new Date()) {
  const hr = now.getHours();
  if (hr >= 23 || hr < 6) return "sleep";
  if (open === 0) return "happy";
  if (open <= 5) return "ok";
  if (open <= 15) return "busy";
  return "full";
}
function mascotDeco(now = new Date()) {
  const m = now.getMonth() + 1, d = now.getDate();
  if ((m === 12 && d === 31) || (m === 1 && d === 1)) return "party";
  if (m === 12 && d <= 26) return "santa";
  const e = easterDate(now.getFullYear()), diff = Math.round((startOfDay(now) - startOfDay(e)) / DAY);
  if (diff >= -3 && diff <= 1) return "bunny";
  if (m === 10 && d >= 29) return "pumpkin";
  // 👗 Sonst das Kostüm der Jahreszeit: Frühling = Blume, Sommer = Sonnenbrille, Herbst = Blatt, Winter = Schal
  return m >= 3 && m <= 5 ? "spring" : m >= 6 && m <= 8 ? "summer" : m >= 9 && m <= 11 ? "autumn" : "winter";
}
function mascotSvg(mood, deco) {
  const eyes = mood === "sleep"
    ? `<path d="M12.5 13.5q1.5 1.2 3 0M19.5 13.5q1.5 1.2 3 0" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>`
    : mood === "full"
      ? `<path d="M12.6 12.2l2.6 2.6M15.2 12.2l-2.6 2.6M19.8 12.2l2.6 2.6M22.4 12.2l-2.6 2.6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>`
      : `<circle cx="14" cy="13.4" r="1.3" fill="currentColor"/><circle cx="21" cy="13.4" r="1.3" fill="currentColor"/>`;
  const mouth = {
    happy: `<path d="M13.6 16.4q3.9 3.6 7.8 0" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>`,
    ok: `<path d="M14.6 16.8q2.9 2 5.8 0" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>`,
    busy: `<path d="M14.8 17.4h5.4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>`,
    full: `<ellipse cx="17.5" cy="17.6" rx="1.6" ry="1.2" fill="currentColor"/>`,
    sleep: `<path d="M15.6 17.2q1.9 1 3.8 0" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>`,
  }[mood];
  const extra = mood === "busy" ? `<path d="M24.6 9.4q1.4 2.2 0 3.2q-1.4-1 0-3.2z" fill="#4fc3f7"/>`
    : mood === "sleep" ? `<text x="25" y="8" font-size="5.5" font-weight="700" fill="currentColor" opacity=".7">z</text><text x="28" y="4.6" font-size="4" font-weight="700" fill="currentColor" opacity=".5">z</text>`
      : mood === "happy" ? `<path d="M26.5 4.5l.7 1.6 1.6.7-1.6.7-.7 1.6-.7-1.6-1.6-.7 1.6-.7z" fill="#fdd835"/>` : "";
  const hat = {
    santa: `<path d="M10 9.2q6-7.4 14.6-1.4l-2 1.4z" fill="#e53935"/><rect x="9.4" y="8.6" width="16" height="2" rx="1" fill="#fff"/><circle cx="25.4" cy="7.4" r="1.4" fill="#fff"/>`,
    bunny: `<ellipse cx="14" cy="4.6" rx="1.5" ry="4" fill="#f8bbd0" stroke="currentColor" stroke-width=".7"/><ellipse cx="21" cy="4.6" rx="1.5" ry="4" fill="#f8bbd0" stroke="currentColor" stroke-width=".7"/>`,
    party: `<path d="M15 9.4l2.6-7.2 2.6 7.2z" fill="#ab47bc"/><circle cx="17.6" cy="2" r="1" fill="#fdd835"/>`,
    pumpkin: `<ellipse cx="29" cy="24.6" rx="2.6" ry="2.2" fill="#fb8c00"/><path d="M29 22.4v-1.2" stroke="#43a047" stroke-width=".9"/>`,
    spring: `<g transform="translate(9.6 6.6)"><circle cx="0" cy="-1.5" r="1.2" fill="#f48fb1"/><circle cx="1.5" cy="0" r="1.2" fill="#f48fb1"/><circle cx="0" cy="1.5" r="1.2" fill="#f48fb1"/><circle cx="-1.5" cy="0" r="1.2" fill="#f48fb1"/><circle cx="0" cy="0" r="1" fill="#fdd835"/></g>`,
    summer: `<rect x="11.2" y="11.6" width="5.6" height="3.4" rx="1.3" fill="#263238"/><rect x="18.2" y="11.6" width="5.6" height="3.4" rx="1.3" fill="#263238"/><path d="M16.8 12.8h1.4" stroke="#263238" stroke-width="1"/>`,
    autumn: `<path d="M8.6 7.4q3.2-4.2 6.4.2q-3.2 3.4-6.4-.2z" fill="#ef6c00"/><path d="M8.8 7.2l4.2-2.4" stroke="#8d4a00" stroke-width=".6"/>`,
    winter: `<path d="M7.4 9.2h23.2" stroke="#e53935" stroke-width="2.4" stroke-linecap="round"/><path d="M28 9.8v5.2" stroke="#e53935" stroke-width="2.3" stroke-linecap="round"/><path d="M11 9.2v.1M15 9.2v.1M19 9.2v.1M23 9.2v.1" stroke="#fff" stroke-width="1" stroke-linecap="round"/>`,
  }[deco] || "";
  return `<svg class="mascot ${mood}" viewBox="0 0 34 30" width="30" height="27" aria-hidden="true">
    <path d="M2 4.5h3.6l1.6 3.2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M7.2 7.7h23l-2.6 12.4q-.3 1.4-1.7 1.4H10.6q-1.4 0-1.7-1.4z" fill="color-mix(in srgb, var(--primary-color,#03a9f4) 18%, transparent)" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
    <circle cx="12" cy="25.6" r="2" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="24.6" cy="25.6" r="2" fill="none" stroke="currentColor" stroke-width="1.5"/>
    ${mood === "happy" || mood === "ok" ? `<circle cx="11.6" cy="15.6" r="1.3" fill="#f48fb1" opacity=".6"/><circle cx="23.4" cy="15.6" r="1.3" fill="#f48fb1" opacity=".6"/>` : ""}
    ${eyes}${mouth}${extra}${hat}</svg>`;
}

// 📍 Zonen eines Geschäfts (früher genau eine, jetzt beliebig viele)
const storeZones = (store) => (Array.isArray(store?.zones) ? store.zones : store?.zone ? [store.zone] : []);

// ⏳ Warteschlange für Funklöcher: wird im Handy gespeichert, damit auch ein Neustart der App nichts verliert
const QUEUE_TYPES = new Set(["einkaufsliste/item/toggle", "einkaufsliste/item/add", "einkaufsliste/item/update",
  "einkaufsliste/item/remove", "einkaufsliste/item/move", "einkaufsliste/item/out",
  "einkaufsliste/recipe/add", "einkaufsliste/recipe/update", "einkaufsliste/recipe/remove",
  "einkaufsliste/recipe/apply", "einkaufsliste/recipe/unapply", "einkaufsliste/barcode/assign",
  "einkaufsliste/photo/set"]); // 📸 Fotos werden vorgemerkt, wenn kein Netz da ist (siehe PHOTO_QUEUE_MAX)
const PHOTO_QUEUE_MAX = 3 * 1024 * 1024; // so viele Foto-Daten (Zeichen) dürfen höchstens vorgemerkt warten
const QUEUE_KEY = "einkaufsliste_queue";
const elQueue = (() => { try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]"); } catch (_) { return []; } })();
const elFlush = { busy: false };
const elQueueSave = () => {
  try { localStorage.setItem(QUEUE_KEY, JSON.stringify(elQueue)); } catch (_) { /* egal */ }
  try { window.dispatchEvent(new CustomEvent("einkaufsliste-queue", { detail: elQueue.slice() })); } catch (_) { /* egal */ }
};
// 📱 Für die Offline-App: Warteschlange von außen abgleichen (die App kann im Hintergrund nachschicken)
window.einkaufslisteQueue = {
  get: () => elQueue.slice(),
  replace(list) {
    if (!Array.isArray(list)) return;
    elQueue.length = 0;
    elQueue.push(...list);
    try { localStorage.setItem(QUEUE_KEY, JSON.stringify(elQueue)); } catch (_) { /* egal */ }
  },
};
// ▥ Barcode sofort am Produkt merken (auch ohne Netz), damit der nächste Scan ihn schon kennt
function rememberCode(data, name, note, code) {
  const c = String(code || "").replace(/\D/g, "");
  if (!c || !name) return;
  const n = String(name).trim().toLowerCase(), t = String(note || "").trim().toLowerCase();
  const key = t ? `${n}|${t}` : n;
  data.barcodes_by_name = data.barcodes_by_name || {};
  const list = data.barcodes_by_name[key] || (data.barcodes_by_name[key] = []);
  if (!list.includes(c)) list.push(c);
}
// Gemerkte Änderungen auf die Daten legen, damit man sofort sieht, was man getan hat
function applyQueued(data, list, hass) {
  const now = new Date().toISOString();
  const me = hass?.user?.name || "";
  for (const m of list) {
    const it = data.items.find((i) => i.id === m.item_id);
    switch (m.type) {
      case "einkaufsliste/barcode/assign":
        if (it) rememberCode(data, it.name, it.note, m.code);
        break;
      case "einkaufsliste/photo/set": { // 📸 vorgemerktes Foto schon anzeigen (steht noch in der Warteschlange)
        const k = String(m.name || "").toLowerCase();
        data.photos = { ...(data.photos || {}), [k]: (data.photos || {})[k] || "queued" };
        break;
      }
      case "einkaufsliste/item/add": {
        // gleicher Artikel schon da? Dann macht Home Assistant daraus keinen zweiten – hier genauso
        const low = (x) => String(x || "").trim().toLowerCase();
        const same = data.items.find((i) => i.id !== m._tmp && !i.recipe_id && low(i.name) === low(m.name) && low(i.note) === low(m.note)
          && low(i.for_whom) === low(m.for_whom) && (i.store_id || null) === (m.store_id || null));
        if (same) {
          if (same.checked) { same.checked = false; same.added_at = now; same.added_by = me; }
          if (m.quantity) same.quantity = m.quantity;
          same._queued = true;
        } else if (!data.items.some((i) => i.id === m._tmp)) {
          data.items.push({ id: m._tmp, name: String(m.name || "").replace(/^./, (c) => c.toUpperCase()), quantity: m.quantity || null, note: m.note || null, for_whom: m.for_whom || null,
            store_id: m.store_id || null, category_id: m.category_id || null, checked: false, added_by: me, added_at: now, _queued: true });
        }
        if (m.barcode) rememberCode(data, m.name, m.note, m.barcode);
        break;
      }
      case "einkaufsliste/item/toggle":
        if (it) {
          it.checked = typeof m.checked === "boolean" ? m.checked : !it.checked; it.checked_at = now; it.checked_by = me; it._queued = true;
          if (it.checked && !it.store_id && m.store_id) it.store_id = m.store_id; // 🤷 „Egal wo“ hier abgehakt
        }
        break;
      case "einkaufsliste/item/update":
        if (it) { for (const k of ["name", "quantity", "note", "for_whom", "store_id", "category_id"]) if (k in m) it[k] = m[k]; it._queued = true; }
        break;
      case "einkaufsliste/item/remove":
        data.items = data.items.filter((i) => i.id !== m.item_id);
        break;
      case "einkaufsliste/item/move":
        if (it) { it.store_id = m.store_id || null; it._queued = true; }
        break;
      case "einkaufsliste/item/out":
        if (it) { it.out_at = now; it._queued = true; }
        break;
      case "einkaufsliste/recipe/add":
        if (!(data.recipes || []).some((r) => r.id === m._tmp)) {
          data.recipes = [...(data.recipes || []), { id: m._tmp, name: m.name, icon: m.icon || null, items: m.items || [], steps: m.steps || null,
            heat: m.heat || [], servings: m.servings || null, servings_unit: m.servings_unit || "persons", group: m.group || null, _queued: true }];
        }
        break;
      case "einkaufsliste/recipe/update": {
        const r = (data.recipes || []).find((x) => x.id === m.recipe_id);
        if (r) { for (const k of ["name", "icon", "items", "steps", "heat", "servings", "servings_unit", "group"]) if (k in m) r[k] = m[k]; r._queued = true; }
        break;
      }
      case "einkaufsliste/recipe/remove":
        data.recipes = (data.recipes || []).filter((r) => r.id !== m.recipe_id);
        break;
      case "einkaufsliste/recipe/apply": {
        const r = (data.recipes || []).find((x) => x.id === m.recipe_id);
        if (!r) break;
        const pick = m.items || r.items.map((_, n) => n);
        pick.forEach((n) => {
          const ri = r.items[n];
          if (!ri) return;
          const tid = `tmp_${m._tmp || "r"}_${n}`;
          if (data.items.some((i) => i.id === tid)) return;
          const ov = (m.overrides || {})[String(n)] || {};
          data.items.push({ id: tid, name: ri.name, quantity: "quantity" in ov ? ov.quantity : ri.quantity || null, note: ri.note || null,
            for_whom: ri.for_whom || null, store_id: "store_id" in ov ? ov.store_id || null : ri.store_id || null, category_id: ri.category_id || null,
            recipe_id: r.id, checked: false, added_by: me, added_at: now, _queued: true });
        });
        break;
      }
      case "einkaufsliste/recipe/unapply":
        data.items = data.items.filter((i) => !(i.recipe_id === m.recipe_id && !i.checked));
        break;
    }
  }
  return data;
}

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
    elUseLang(hass, this._config, this.shadowRoot);
    if (!this._unsub && !this._subscribing && this.isConnected) this._subscribe();
    this._autoStore();
    this._updateLive();
    this._applyScheme(hass);
  }

  // 🌙 Dunkles Design: auch die Aufklapp-Listen (select) dunkel – der Browser malt sie sonst hell
  _applyScheme(hass) {
    const key = `${hass?.themes?.darkMode}|${hass?.themes?.theme}|${hass?.selectedTheme?.theme || ""}`;
    if (key === this._schemeKey) return;
    this._schemeKey = key;
    requestAnimationFrame(() => {
      let dark = hass?.themes?.darkMode;
      const col = getComputedStyle(this).getPropertyValue("--primary-text-color").trim();
      const rgb = elRgb(col);
      if (rgb) dark = (rgb[0] * 299 + rgb[1] * 587 + rgb[2] * 114) / 1000 > 128; // helle Schrift = dunkler Hintergrund
      this.toggleAttribute("dark", !!dark);
    });
  }

  // 🟢 Live-Anzeige: verbunden und Liste abonniert = grün, sonst rot
  _updateLive() {
    const dot = this.$("liveDot");
    if (!dot) return;
    const ok = this._hass?.connected !== false && !!this._unsub && !this._error;
    const wait = elQueue.length;
    dot.classList.toggle("off", !ok && !wait);
    dot.classList.toggle("wait", !!wait);
    dot.title = wait ? `⏳ ${wait} ${wait === 1 ? "Sache wartet" : "Sachen warten"} aufs Netz`
      : ok ? "Verbunden – alles ist aktuell" : "Keine Verbindung – Änderungen kommen gerade nicht an";
    if (ok && wait) this._flushQueue();
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
    const person = Object.values(this._hass.states || {}).find(
      (st) => st.entity_id.startsWith("person.") && st.attributes.user_id === uid
    );
    if (!person) return null;
    const { latitude: lat, longitude: lon } = person.attributes;
    let best = null;
    for (const store of this._data.stores) {
      for (const zid of storeZones(store)) { // 📍 ein Geschäft kann mehrere Zonen haben (z. B. mehrere Filialen)
        const zone = this._hass.states[zid];
        if (!zone) continue;
        const zname = zone.attributes.friendly_name || zid.slice(5);
        const inside = String(person.state).toLowerCase() === String(zname).toLowerCase();
        let dist = inside ? 0 : null;
        if (dist === null && lat != null && zone.attributes.latitude != null) {
          dist = distance(lat, lon, zone.attributes.latitude, zone.attributes.longitude);
          if (dist > (zone.attributes.radius || 100) + 200) dist = null; // noch zu weit weg
        }
        if (dist !== null && (!best || dist < best.dist)) best = { id: store.id, dist };
      }
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
      if (this._data?.settings?.auto_shop && !this._shopMode) { // 🛒 Opt-in: im Laden geht der Laden-Modus von selbst an
        this._shopMode = true;
        this._shopAuto = true;
        try { localStorage.setItem("einkaufsliste_shopmode", "1"); } catch (_) { /* egal */ }
        this._toast("🛒 Laden-Modus ist an – viel Spaß beim Einkaufen!");
      }
    } else if (prev && this._tab === prev) {
      this._tab = "all";
    }
    if (!near && this._shopAuto && this._shopMode) { // Laden verlassen: nur ausschalten, was von selbst anging
      this._shopMode = false;
      try { localStorage.setItem("einkaufsliste_shopmode", "0"); } catch (_) { /* egal */ }
      this._toast("✍️ Laden-Modus aus – bis zum nächsten Einkauf");
    }
    if (!near) this._shopAuto = false;
    this._renderAll();
  }

  connectedCallback() {
    clearInterval(this._clock);
    this._clock = setInterval(() => {
      if (this._view === "list" && !this._editing && this._data) this._renderList(); // „vor 5 Min“ aktuell halten
      this._updateLockBtn(); // 🔒 nach 10 Minuten verschwindet der Sperr-Knopf von selbst
    }, 60000);
    if (this._hass && !this._unsub && !this._subscribing) this._subscribe();
  }

  disconnectedCallback() {
    clearInterval(this._clock);
    if (this._unsub) { this._unsub(); this._unsub = null; }
  }

  getCardSize() { return 3 + Math.min(10, (this._data?.items?.filter((i) => !i.checked).length || 0)); }

  // 🧾 Liste komplett abgehakt (von mir, gerade eben) + Option an -> Protokoll anbieten
  _autoSpend(openBefore) {
    const s = this._data?.settings, t = this._myChecks;
    const open = this._data.items.filter((i) => !i.checked).length;
    if (open > 0) return;
    if (openBefore <= 0 || !t?.last || Date.now() - t.last > 15000) return; // nur direkt nach meinem Abhaken
    const stores = t.stores || {};
    const best = Object.keys(stores).sort((a, b) => stores[b] - stores[a])[0];
    this._myChecks = null;
    if (!s?.spend || !s?.spend_auto) return;
    if (Date.now() - (this._spendAutoAt || 0) < 600000) return; // höchstens alle 10 Minuten
    this._spendAutoAt = Date.now();
    if (best && this._store(best)) this._spendLastStore = best;
    this._spendAutoPrompt = true;
    setTimeout(() => this._showSpend(), 900);
  }

  async _subscribe() {
    this._subscribing = true;
    try {
      const unsub = await this._hass.connection.subscribeMessage(
        (data) => {
          if (elQueue.length) applyQueued(data, elQueue, this._hass); // Gemerktes gleich wieder drüberlegen
          const openBefore = this._data ? this._data.items.filter((i) => !i.checked).length : -1;
          this._data = data;
          this._autoSpend(openBefore);
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
    // ⏳ Funkloch im Laden? Abhaken & Co. wird gemerkt und nachgeschickt, sobald das Netz wieder da ist
    const offline = this._hass?.connected === false;
    const isItem = msg.type.startsWith("einkaufsliste/item/") || msg.type === "einkaufsliste/barcode/assign";
    if (QUEUE_TYPES.has(msg.type) && (offline || (isItem && elQueue.length))) return this._queueMsg(msg);
    return this._hass.callWS(msg).catch((err) => {
      if (QUEUE_TYPES.has(msg.type) && this._hass?.connected === false) return this._queueMsg(msg);
      this._toast(err?.message || "Da ist was schiefgelaufen 🙈");
      if (err?.code !== "invalid" && err?.code !== "error" && msg.type !== "einkaufsliste/errors/report") { // 🐞 Server hat es nicht gesehen: ins Fehler-Protokoll
        this._hass?.callWS?.({ type: "einkaufsliste/errors/report", where: "Karte: " + msg.type.replace("einkaufsliste/", ""), message: String(err?.message || err?.code || err).slice(0, 380) }).catch(() => {});
      }
      throw err;
    });
  }

  _queueMsg(msg) {
    const m = { ...msg };
    let result = {};
    if (m.type === "einkaufsliste/item/toggle" && typeof m.checked !== "boolean") {
      // gewünschten Zustand festhalten – so wird beim Nachschicken nichts doppelt umgeschaltet
      const it = this._data?.items.find((i) => i.id === m.item_id);
      if (it) m.checked = !it.checked;
    }
    if (m.type === "einkaufsliste/photo/set") {
      const used = elQueue.reduce((n, x) => n + (x.type === "einkaufsliste/photo/set" ? String(x.data || "").length : 0), 0);
      if (used + String(m.data || "").length > PHOTO_QUEUE_MAX) {
        this._toast("📴 Zu viele Fotos warten schon aufs Netz – bitte erst wieder online gehen.");
        return Promise.reject(new Error("photo queue full"));
      }
    }
    if (m.type === "einkaufsliste/item/add" || m.type === "einkaufsliste/recipe/add" || m.type === "einkaufsliste/recipe/apply") {
      m._tmp = "tmp_" + Math.random().toString(36).slice(2, 10);
      result = { id: m._tmp, name: m.name };
    }
    elQueue.push(m);
    elQueueSave();
    if (this._data) { applyQueued(this._data, [m], this._hass); this._renderAll(); }
    this._updateLive();
    if (this._hass?.connected !== false) setTimeout(() => this._flushQueue(), 0); // Netz da? Gleich der Reihe nach los
    else if (elQueue.length === 1) this._toast("⏳ Kein Netz – ich merke mir das und schicke es nach");
    return Promise.resolve(result);
  }

  async _flushQueue() {
    if (elFlush.busy || !elQueue.length || this._hass?.connected === false) return;
    elFlush.busy = true; // nur EINE Karte schickt nach – auch wenn mehrere auf dem Dashboard sind
    const gate = window.einkaufslisteFlushGate; // 📱 Offline-App: schickt vielleicht gerade im Hintergrund nach
    if (gate) {
      let ok = false;
      try { ok = await gate.acquire(); } catch (_) { ok = false; }
      if (!ok || !elQueue.length) {
        elFlush.busy = false;
        if (!ok) setTimeout(() => this._updateLive(), 5000); // später nochmal versuchen
        else { this._renderAll(); this._updateLive(); }
        return;
      }
    }
    const ids = {};
    let sent = 0;
    try {
      while (elQueue.length) {
        const m = { ...elQueue[0] };
        const tmp = m._tmp;
        delete m._tmp;
        for (const k of ["item_id", "recipe_id"]) if (m[k] && ids[m[k]]) m[k] = ids[m[k]];
        if (String(m.item_id || m.recipe_id || "").startsWith("tmp_")) { elQueue.shift(); continue; } // Eintrag ging nicht durch
        try {
          const res = await this._hass.callWS(m);
          if (tmp && res?.id) ids[tmp] = res.id;
        } catch (err) {
          if (this._hass?.connected === false) break; // Netz wieder weg – später weiter
          // echter Fehler (z. B. Artikel inzwischen gelöscht): diesen einen überspringen
        }
        elQueue.shift();
        elQueueSave();
        sent += 1;
      }
    } finally {
      elFlush.busy = false;
      try { gate?.release(); } catch (_) { /* egal */ }
      this._updateLive();
    }
    if (sent && !elQueue.length) this._toast(`✅ Wieder online – ${sent} ${sent === 1 ? "Änderung" : "Änderungen"} nachgeschickt`);
  }

  _toast(message) {
    this.dispatchEvent(new CustomEvent("hass-notification", { detail: { message: elT(message) }, bubbles: true, composed: true }));
  }

  $(id) { return this.shadowRoot.getElementById(id); }

  // ---------------------------------------------------------------- Aufbau
  _build() {
    this._built = true;
    this.shadowRoot.innerHTML = `
      <style>${STYLE}</style>
      <ha-card>
        <div class="head">
          <div class="title"><ha-icon id="titleIcon" icon="mdi:cart-variant" data-act="guide" title="📖 Anleitung – antippen"></ha-icon><span id="mascot" data-act="guide" title="📖 Anleitung – antippen" hidden></span><span class="live" id="liveDot" title="Verbindung"></span><span class="badge" id="count" hidden></span><span class="t" id="title" hidden></span><button class="iconbtn" id="btnScan" type="button" data-act="scan" title="Barcode scannen" hidden><ha-icon icon="mdi:barcode-scan"></ha-icon></button><button class="iconbtn" id="btnLock" type="button" data-act="pin-lock" title="Einstellungen jetzt sperren" hidden><ha-icon icon="mdi:lock-open-variant-outline"></ha-icon></button><button class="iconbtn" id="btnSpend" type="button" data-act="spend" title="Einkaufs-Protokoll" hidden><ha-icon icon="mdi:receipt-text-outline"></ha-icon></button></div>
          <button class="iconbtn" id="btnShop" data-act="shopmode" title="Laden-Modus"><ha-icon icon="mdi:cart-outline"></ha-icon></button>
          <button class="iconbtn" id="btnRecipes" data-act="view" data-view="recipes" title="Rezepte"><ha-icon icon="mdi:chef-hat"></ha-icon></button>
          <button class="iconbtn" id="btnSettings" data-act="view" data-view="settings" title="Geschäfte & Kategorien"><ha-icon icon="mdi:cog-outline"></ha-icon></button>
        </div>
        <div class="error" id="error" hidden></div>
        <div class="updbar" id="updBar" hidden></div>
        <div class="updbar" id="tipBar" hidden></div>
        <div class="wizard" id="wizard" hidden></div>
        <div id="listView">
          <div class="tabs" id="tabs"></div>
          <form class="add" id="addForm" autocomplete="off">
            <input id="inName" placeholder="Was brauchen wir/du?" enterkeyhint="done">
            <button class="primary addbtn" type="submit" title="Hinzufügen"><ha-icon icon="mdi:check-bold"></ha-icon></button>
            <div class="sugg" id="sugg" hidden></div>
            <div class="toolbar">
              <button class="tool" id="tQty" type="button" data-act="tool" data-field="qtyBox" title="Menge"><ha-icon icon="mdi:numeric"></ha-icon></button>
              <button class="tool" id="tNote" type="button" data-act="tool" data-field="inNote" title="Notiz"><ha-icon icon="mdi:note-text-outline"></ha-icon></button>
              <button class="tool" id="tFor" type="button" data-act="tool" data-field="forBox" title="Für wen?"><ha-icon icon="mdi:account-outline"></ha-icon></button>
              <button class="tool plus" id="btnNewBarcode" type="button" data-act="new-barcode" title="Barcode zum neuen Produkt" hidden><ha-icon icon="mdi:barcode-scan"></ha-icon></button>
              <button class="tool" id="btnNewPhoto" type="button" data-act="new-photo" title="Foto zum Artikel"><ha-icon icon="mdi:camera-plus-outline"></ha-icon></button>
              <button class="tool" id="tBasic" type="button" data-act="basic-toggle" title="🧂 Grundvorrat – haben wir immer (z. B. Salz, Öl)" hidden><ha-icon icon="mdi:shaker-outline"></ha-icon></button>
              <button class="tool" id="btnOcrList" type="button" data-act="ocr-list" title="Liste aus Foto einlesen"><ha-icon icon="mdi:clipboard-text-outline"></ha-icon></button>
              <button class="tool tclear" id="tClear" type="button" data-act="clear-form" title="Alles leeren" hidden><ha-icon icon="mdi:eraser"></ha-icon></button>
            </div>
            <div class="extras">
              <div class="chips" id="lastQty" hidden></div>
              <div id="qtyBox" class="chipbox" hidden>
                <div class="chips" id="qtyChips"></div>
                <div class="chips unitchips" id="unitChips"></div>
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
    this.$("inStore").addEventListener("change", () => { // 🧽 Radiergummi auch nach Geschäft-Wahl
      if (this.$("inStore").value === "~new") { this._newStoreFromForm(); return; }
      this._updateTools();
    });
    for (const id of ["inQty", "inNote", "inFor"]) {
      this.$(id).addEventListener("input", () => this._updateTools());
      this.$(id).addEventListener("change", () => this._updateTools());
    }
    this.$("photoFile").addEventListener("change", (e) => this._onPhotoFile(e));
    this.shadowRoot.addEventListener("paste", (e) => this._onPaste(e));
    this.$("inName").addEventListener("input", () => { if (!this.$("inName").value.trim()) this._pendingBarcode = null; this._onNameInput(); this._renderSuggest(); this._updateTools(); if (!this._editing) this._renderList(); });
    root.addEventListener("click", (e) => this._onClick(e), true);
    root.addEventListener("dblclick", (e) => { // 🖥️ Doppelklick im Katalog = bearbeiten
      const row = e.target.closest?.(".prodrow");
      if (!row) return;
      this._prodEdit = row.dataset.key;
      this._renderProducts();
      setTimeout(() => this.$("peName")?.focus(), 30);
    });
    root.addEventListener("keydown", (e) => { if (this._prodKey(e)) e.preventDefault(); });
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
    return item.store_id === t || !item.store_id; // 🤷 „Egal wo“ gibt es in jedem Geschäft
  }
  _autoCheckDate(item) {
    const s = this._data?.settings;
    if (!s || item.checked) return null;
    let d = new Date(s.next_cleanup);
    const added = new Date(Math.max(new Date(item.added_at || 0), new Date(item.out_at || 0))); // „war aus“ startet die Frist neu
    for (let i = 0; i < 60 && dayDiff(d, added) < s.min_age_days; i++) d = new Date(d.getTime() + 7 * DAY);
    return d;
  }
  _personOptions(selected) {
    const names = (this._data?.persons || []).map((p) => p.name);
    if (selected && !names.some((n) => n.toLowerCase() === selected.toLowerCase())) names.push(selected);
    return `<option value="">👤 Für wen?</option>` + names.map((n) => `<option value="${esc(n)}" ${selected && n.toLowerCase() === selected.toLowerCase() ? "selected" : ""}>👤 ${esc(n)}</option>`).join("");
  }
  // ➕ Neues Geschäft direkt beim Eintragen – nur der Name, alles andere später in ⚙️
  async _newStoreFromForm() {
    const sel = this.$("inStore");
    sel.value = this._defaultStore();
    const name = await askText("➕ Neues Geschäft", "z. B. Kaufland");
    if (!name) { this._updateTools(); return; }
    try {
      const st = await this._ws({ type: "einkaufsliste/group/add", kind: "stores", name });
      if (st?.id) {
        if (![...sel.options].some((o) => o.value === st.id)) sel.add(new Option(st.name, st.id), sel.querySelector('option[value="~none"]'));
        sel.value = st.id;
        this._toast(`🏪 „${st.name}“ angelegt – Farbe & Co. später in ⚙️ → Geschäfte`);
      }
    } catch (_) { /* Meldung kam schon */ }
    this._updateTools();
  }

  // 🏪 Icon eines Geschäfts: selbst ausgesucht, sonst das Icon der Zone, sonst der Einkaufswagen
  // 🏪 Icon: selbst ausgesucht > Icon der Zone > Start-Icon vom Einrichten (🛒, bei DM 🧴) > 🛒
  _storeIcon(store) {
    const own = store?.icon;
    if (own && !EL_START_STORE_ICONS.has(own)) return own;
    for (const zid of storeZones(store)) {
      const ic = this._hass?.states?.[zid]?.attributes?.icon;
      if (ic && ic !== "mdi:map-marker") return ic;
    }
    return own || "mdi:cart";
  }

  _selectOptions(list, selected, empty) {
    return `<option value="">${empty}</option>` + list.map((x) => `<option value="${x.id}" ${x.id === selected ? "selected" : ""}>${esc(x.name)}</option>`).join("");
  }

  // ---------------------------------------------------------------- Rendern
  // ↩️ Zurück-Taste (Offline-App): Ist die Karte ganz „oben“ (normale Liste, nichts offen)?
  einkaufslisteIsRoot() {
    return !document.querySelector("[data-elov]") && this._view === "list" && !this._shopMode
      && !this._menuId && !this._editing && !this._moving;
  }

  // ↩️ Einen Schritt zurück. Gibt false zurück, wenn es nichts mehr zurückzugehen gibt.
  einkaufslisteBack() {
    const ovs = document.querySelectorAll("[data-elov]");
    if (ovs.length) {
      const ov = ovs[ovs.length - 1];
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      if (ov.isConnected) {
        const btn = [...ov.querySelectorAll("button")].find((b) => /^\s*(✕|×)?\s*(Schließen|Abbrechen|Fertig|Beenden|Close|Cancel|Done|Finish)\b/i.test(b.textContent || ""));
        if (btn) btn.click(); else ov.remove();
      }
      return true;
    }
    if (this._menuId || this._editing || this._moving) {
      this._menuId = this._editing = this._moving = null;
      this._renderList();
      this._emitNav();
      return true;
    }
    if (this._view === "recipe") { this._draft = null; this._view = "settings"; this._renderAll(); return true; }
    if (this._view === "settings") {
      if (this._storeSel) this._storeSel = null;
      else if (this._setSec) {
        this._setSec = null; // Einstellungen sind nur eine Ebene tief: zurück = Übersicht
      } else this._view = "list";
      this._renderAll();
      return true;
    }
    if (this._view !== "list") { this._view = "list"; this._renderAll(); return true; }
    if (this._shopMode) {
      this._shopMode = false;
      try { localStorage.setItem("einkaufsliste_shopmode", "0"); } catch (_) { /* egal */ }
      this._renderAll();
      return true;
    }
    return false;
  }

  _emitNav() {
    try { window.dispatchEvent(new CustomEvent("einkaufsliste-nav")); } catch (_) { /* egal */ }
  }

  _renderAll() {
    if (!this._built || !this._config) return;
    queueMicrotask(() => this._emitNav());
    if (this._shopMode === undefined) {
      try { this._shopMode = localStorage.getItem("einkaufsliste_shopmode") === "1"; } catch (_) { this._shopMode = false; }
      try { this._dupIgnore = new Set(JSON.parse(localStorage.getItem("einkaufsliste_dup_ignore") || "[]")); } catch (_) { this._dupIgnore = new Set(); }
    }
    const d = this._data;
    const c = this._config;
    const titleText = this._fixedStore && this._store(this._fixedStore)
      ? `${c.title || ""}${c.title ? " · " : ""}${this._store(this._fixedStore).name}` : (c.title || "");
    const cardEl = this.shadowRoot.querySelector("ha-card");
    cardEl.classList.toggle("compact", !!c.compact);
    const shop = !!this._shopMode && this._view === "list";
    cardEl.classList.toggle("shop", shop);
    const btnShop = this.$("btnShop");
    btnShop.hidden = !d || this._view !== "list";
    btnShop.classList.toggle("on", shop);
    btnShop.title = shop ? "Laden-Modus beenden" : "Laden-Modus (große Zeilen, nur Abhaken)";
    btnShop.querySelector("ha-icon").setAttribute("icon", shop ? "mdi:cart-off" : "mdi:cart-outline");
    this.$("title").textContent = ""; // Titel-Text ist weg – der Einkaufswagen reicht
    this.$("titleIcon").hidden = c.show_title === false || !!d?.settings?.mascot;
    this.$("btnSpend").hidden = !d?.settings?.spend || this._view !== "list" || !!this._shopMode; // 🧾 nur wenn in ⚙️ eingeschaltet
    this.$("titleIcon").title = `📖 Anleitung – antippen${titleText ? ` · ${titleText}` : ""}`;
    this._renderUpdateBar();
    this._renderTip();
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

    const open = d.items.filter((i) => !i.checked && (this._fixedStore ? i.store_id === this._fixedStore || !i.store_id : true));
    const cnt = this.$("count");
    cnt.hidden = open.length === 0;
    cnt.textContent = open.length;
    this._updateLockBtn();
    this._renderMascot(open.length);

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
      parts.push(`<button class="tab ${active === s.id ? "active" : ""}" style="--c:${esc(s.color)}" data-act="tab" data-tab="${s.id}"><span class="dot"></span>${this._lastNear === s.id ? "📍 " : ""}${esc(s.name)} <span class="n">${openCount((i) => i.store_id === s.id || !i.store_id)}</span>${bubble((i) => i.store_id === s.id || !i.store_id, active === s.id)}</button>`);
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
    st.innerHTML = this._selectOptions(d.stores, null, this._formMode === "recipe" ? "🛒 Wie zuletzt" : "🛒 Welches Geschäft?")
      + `<option value="~none" ${this._formMode === "recipe" ? "hidden" : ""}>🤷 Egal wo</option>`
      + `<option value="~new">➕ Neues Geschäft …</option>`;
    ct.innerHTML = this._selectOptions(d.categories, null, "📦 Ohne Kategorie");
    const tab = this._activeTab;
    if (this._lastTab !== tab) {
      st.value = this._defaultStore();
      this._lastTab = tab;
    } else if (prevStore === "~none" || d.stores.some((s) => s.id === prevStore)) st.value = prevStore;
    if (d.categories.some((c) => c.id === prevCat)) ct.value = prevCat;
  }

  // 🔎 Eigene Vorschläge beim Tippen (datalist klappt in der HA-App am Handy nicht)
  // Jede Variante aus der Liste (Menge, Notiz, für wen, Geschäft) ist ein eigener Vorschlag –
  // antippen übernimmt alles davon ins Formular.
  // Vorschläge suchen (für das Eingabefeld oben und für Rezept-Zutaten)
  _suggestList(q, { recipe = false } = {}) {
    if (!q || !this._data) return [];
    recipe = recipe || this._formMode === "recipe";
    const score = (low) => (low.startsWith(q) || low.split(/\s+/).some((w) => w.startsWith(q)) ? 0 : low.includes(q) ? 1 : -1);
    // Name oder Notiz: „paprika“ findet auch „Gewürze · 📝 Paprika“ (Treffer in der Notiz etwas weiter hinten)
    const scoreNN = (name, note) => { const a = score(name.toLowerCase()); const b = note ? score(note.toLowerCase()) : -1;
      return a >= 0 ? a : b >= 0 ? b + 1 : -1; };
    // Ein Produkt = Name + Notiz („Gewürze“ und „Gewürze · Paprika“ sind zwei Produkte)
    const pkey = (name, note) => `${name.toLowerCase()}|${(note || "").toLowerCase()}`;
    const cands = [];
    const seenVariant = new Set();
    const names = new Set();
    // zuerst Artikel aus der Liste: aktueller Reiter vor anderen, abgehakt vor offen
    const items = [...this._data.items].sort((a, b) =>
      (recipe ? 0 : this._matchesTab(b) - this._matchesTab(a)) || (b.checked - a.checked)
      || String(b.added_at || "").localeCompare(String(a.added_at || "")));
    // 👤 Name einer Person getippt („max“)? Dann zuerst alles, was für sie auf der Liste steht
    let forPerson = null;
    if (!recipe && q.length >= 2) {
      const whoNames = [...(this._data.persons || []).map((p) => p.name), ...this._data.items.map((i) => i.for_whom).filter(Boolean)];
      forPerson = whoNames.find((n) => n.toLowerCase().startsWith(q))?.toLowerCase() || null;
      if (forPerson) for (const i of items) {
        if ((i.for_whom || "").toLowerCase() !== forPerson) continue;
        const key = pkey(i.name, i.note);
        if (seenVariant.has(key)) continue;
        seenVariant.add(key);
        names.add(i.name.toLowerCase());
        cands.push({ sc: -1, name: i.name, item: i, fromRecipe: this._recipe(i.recipe_id)?.name });
      }
    }
    for (const i of items) {
      if (i.recipe_id) continue;
      const sc = scoreNN(i.name, i.note);
      if (sc < 0) continue;
      const key = pkey(i.name, i.note);
      if (seenVariant.has(key)) continue; // 1 Vorschlag pro Produkt (der vom letzten Mal)
      seenVariant.add(key);
      names.add(i.name.toLowerCase());
      cands.push({ sc, name: i.name, item: i });
    }
    // 🏷️ Spitzname getippt („temp“ -> Tempos -> Taschentücher)
    if (q.length >= 2) for (const a of this._data.aliases || []) {
      if (!a.alias.startsWith(q) || seenVariant.has(pkey(a.name, a.note))) continue;
      const last = items.find((i) => !i.recipe_id && pkey(i.name, i.note) === pkey(a.name, a.note));
      seenVariant.add(pkey(a.name, a.note));
      names.add(a.name.toLowerCase());
      cands.push({ sc: 0, name: a.name, alias: a.alias, item: last || { name: a.name, note: a.note || null, checked: true } });
    }
    for (const h of this._data.history || []) {
      const low = h.name.toLowerCase();
      if (names.has(low)) continue;
      const sc = score(low);
      if (sc < 0) continue;
      names.add(low);
      cands.push({ sc, name: h.name, hist: h });
    }
    // 🍽️ Zutaten aus Rezepten – auch wenn sie noch nie auf der Liste waren
    for (const r of this._data.recipes || []) {
      for (const ri of r.items || []) {
        const key = pkey(ri.name, ri.note);
        if (seenVariant.has(key) || (!ri.note && names.has(ri.name.toLowerCase()))) continue;
        const sc = scoreNN(ri.name, ri.note);
        if (sc < 0) continue;
        seenVariant.add(key);
        names.add(ri.name.toLowerCase());
        cands.push({ sc: sc + 0.5, name: ri.name, fromRecipe: r.name,
          item: { name: ri.name, note: ri.note || null, store_id: ri.store_id || null, category_id: ri.category_id || null, checked: true } });
      }
    }
    // 🧠 Gelernter Tippfehler („Mlich“ wurde schon 2× zu Milch korrigiert) -> gleich als erster Vorschlag
    const learned = this._data.typos?.[q];
    if (learned && !names.has(learned.toLowerCase())) {
      const hist = (this._data.history || []).find((h) => h.name.toLowerCase() === learned.toLowerCase());
      names.add(learned.toLowerCase());
      cands.push({ sc: -1, name: learned, hist, learned: true });
    }
    // 🤓 Tippfehler-Hilfe: „Mlich“ -> „Meintest du Milch?“
    if (q.length >= 4 && !cands.some((c) => c.sc <= 0)) {
      const maxD = q.length > 6 ? 2 : 1;
      const pool = new Map();
      for (const h of this._data.history || []) pool.set(h.name.toLowerCase(), { name: h.name, hist: h });
      for (const i of this._data.items) if (!i.recipe_id && !pool.has(i.name.toLowerCase())) pool.set(i.name.toLowerCase(), { name: i.name, item: i });
      for (const r of this._data.recipes || []) for (const ri of r.items || []) {
        const low = ri.name.toLowerCase();
        if (!pool.has(low)) pool.set(low, { name: ri.name, fromRecipe: r.name, item: { name: ri.name, note: ri.note || null, store_id: ri.store_id || null, category_id: ri.category_id || null, checked: true } });
      }
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
    return cands.slice(0, recipe ? 8 : 2); // Einkaufsliste: höchstens 2 Vorschläge – sonst wird's zu viel
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
        if (c.fromRecipe) bits.push("🍽️ " + esc(c.fromRecipe));
      }
      if (c.alias) bits.unshift("🏷️ " + esc(c.alias));
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
    // 🏷️ Angebote beim Tippen: „Angebote für „Kaffee“ anzeigen“ (nur wenn in ⚙️ eingeschaltet)
    const typed = (splitQty(splitMany(this.$("inName").value).pop() || "").name || "").trim();
    const offChip = this._data?.settings?.offers?.enabled && this._formMode !== "recipe" && typed.length >= 3
      ? `<button type="button" class="chip2 offsearch" data-act="offers-search" data-q="${esc(typed)}">🏷️ <span>Angebote für</span> „<span translate="no">${esc(typed)}</span>“ <span>anzeigen</span></button>` : "";
    if (!list.length && !offChip) { box.hidden = true; box.innerHTML = ""; return; }
    box.innerHTML = (list.length ? this._suggestChips(list, q, "suggest") : "") + offChip;
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
      for (const g of grp) { const st = this._store(g.store_id); meta.push(st ? `<span class="chip" style="--c:${esc(st.color)}">${esc(st.name)}</span>` : EGAL_CHIP); }
    } else if (this._activeTab === "all" && store) meta.push(`<span class="chip" style="--c:${esc(store.color)}">${esc(store.name)}</span>`);
    else if (!item.store_id && this._activeTab !== "none") meta.push(EGAL_CHIP); // 🤷 überall zu haben
    // Reihenfolge unter dem Namen: Geschäft · Notiz · Barcode · wer eingetragen · wer abgehakt · (Rezept, Zeit)
    if (item.note) meta.push(`<span class="inote">📝 ${esc(item.note)}</span>`);
    if (!item.checked && item.from_offer && item.orig?.name) meta.push(`<span class="iinstead" title="Dein ursprüngliches Produkt ist abgehakt – es kommt zurück, wenn das Angebot ohne Kauf endet">↩️ <span>statt</span> <span translate="no">${esc(item.orig.name)}</span></span>`); // „statt Kaffee“
    if (!item.checked && item.out_at && Date.now() - new Date(item.out_at) < 3 * DAY)
      meta.push(`<span class="iout" title="Beim letzten Einkauf nicht bekommen">⇄ war aus (${WD_SHORT[pyWd(new Date(item.out_at))]})</span>`);
    const pk = this._pk(item.name, item.note);
    const codes = this._barcodesOf(pk);
    if (codes.length && !this._shopMode) meta.push(`<span class="bc" title="Barcode hinterlegt: ${esc(codes.join(", "))}">▥</span>`);
    const off = item.offer;
    if (!item.checked && off && off.p != null && !off.expired) meta.unshift(`<span class="offinfo" title="${esc(off.r || "")}">${this._offerLabel(off)}</span>`); // 🏷️ eigenes Feld: Preis und Tag, ganz vorn
    else if (!item.checked && this._offersFor(item).length) meta.unshift(`<span class="offtag" data-act="offers-show" data-id="${item.id}" title="Im Angebot – antippen für Details">🏷️</span>`); // 🏷️ ganz vorn, vor dem Geschäft
    else if (!item.checked && off?.expired && Date.now() - new Date(off.expired) < DAY) meta.unshift(`<span class="offgone" title="Das Angebot ist abgelaufen">⌛ Angebot vorbei</span>`);
    // ✍️ Wer & wann: „✍️ Anna, Mo.“ (heute: „vor 5 Min“)
    const when = c.show_dates && !item.checked && !this._shopMode && item.added_at ? fmtWhen(item.added_at) : "";
    if (c.show_added_by && item.added_by) meta.push(`<span title="Eingetragen von"><span translate="no">✍️ ${esc(this._who(item.added_by))}</span>${when ? `, <span>${when}</span>` : ""}</span>`);
    else if (when) meta.push(`<span>${when}</span>`);
    if (c.show_dates && item.checked) meta.push(`<span title="Abgehakt von">✓ ${item.checked_by ? esc(this._who(item.checked_by)) : "automatisch"}</span>`);
    const rgrp = recipe && this._rgroup(recipe.group);
    if (recipe) meta.push(rgrp?.color ? `<span class="chip" style="--c:${esc(rgrp.color)}">🍽️ ${esc(recipe.name)}</span>` : `<span>🍽️ ${esc(recipe.name)}</span>`);
    if (c.show_dates && !this._shopMode) { // 🛒 im Laden-Modus nur das Wichtigste
      if (item.checked) {
        // (wer abgehakt hat, steht schon oben)
      } else {
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
      <div class="item ${item.checked ? "done" : ""} ${this._pending.has(item.id) ? "pending" : ""} ${isNew ? "new" : ""} ${item.name.startsWith("❓") ? "unknown" : ""}" data-id="${item.id}" style="--cc:${esc(cat?.color || "transparent")}${recipe && this._rgroup(recipe.group)?.color ? `;--rc:${esc(this._rgroup(recipe.group).color)}` : ""}">
        <button class="iconbtn check" data-act="toggle" title="${item.checked ? "Wieder auf die Liste" : "Abhaken"}"><ha-icon icon="${icon}"></ha-icon></button>
        <div class="txt">
          <div class="line">${isNew ? `<span class="newbadge" data-act="new-ack" data-id="${item.id}" title="Neu – antippen, wenn du es gesehen hast">✨</span>` : ""}<span class="name">${esc(item.name)}</span>${item._queued ? `<span class="qwait" title="Wartet aufs Netz">⏳</span>` : ""}${qty}${who}${this._hasPhoto(pk) ? `<button class="photobtn" data-act="photo-view" data-name="${esc(pk)}" title="Foto ansehen"><ha-icon icon="mdi:camera"></ha-icon>${this._data.photo_counts?.[pk] > 1 ? `<small class="pcount">${this._data.photo_counts[pk]}</small>` : ""}</button>` : ""}</div>
          ${meta.length ? `<div class="meta">${meta.join("")}</div>` : ""}
        </div>
        ${!item.checked && this._data.stores.length > 1 ? `<div class="acts"><button class="iconbtn" data-act="move" title="War aus – in anderes Geschäft"><ha-icon icon="mdi:swap-horizontal"></ha-icon></button></div>` : ""}
      </div>`;
  }

  _menuHtml(item) {
    // 🎨 Ist etwas hinterlegt, hat der Knopf seine Farbe (Menge, Kategorie, Foto, Barcode, Infos, Angebote) – sonst bleibt er grau
    const b = (act, icon, label, color) => `<button class="menubtn${color ? " has" : ""}" data-act="${act}" data-id="${item.id}"${color ? ` style="--mc:${esc(color)}"` : ""}><ha-icon icon="${icon}"></ha-icon>${label}</button>`;
    const pk = this._pk(item.name, item.note), codes = this._barcodesOf(pk).length, cat = this._cat(item.category_id);
    return `
      <div class="menurow" data-id="${item.id}">
        ${b("menu-edit", "mdi:pencil-outline", "Bearbeiten")}
        ${!item.checked && this._data.stores.length > 1 ? b("menu-move", "mdi:swap-horizontal", "Verschieben") : ""}
        ${b("menu-qty", "mdi:numeric", "Menge", item.quantity ? "#1e88e5" : "")}
        ${b("menu-cat", "mdi:shape-outline", "Kategorie", cat ? (cat.color || "#43a047") : "")}
        ${b("menu-photo", "mdi:camera-plus-outline", this._hasPhoto(pk) ? "Fotos" : "Foto", this._hasPhoto(pk) ? "#00897b" : "")}
        ${this._hasAppScanner() ? b("barcode-assign", "mdi:barcode-scan", codes ? "Barcode ✓" : "Barcode", codes ? "#8e24aa" : "") : ""}
        ${codes ? b("menu-info", "mdi:information-outline", "Infos", "#00acc1") : ""}
        ${this._offersFor(item).length ? b("menu-offers", "mdi:tag-outline", "Angebote", "#e53935") : ""}
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
    return normQty(unit === "x" ? `${num}x` : `${num} ${unit}`); // 1 Dose -> 2 Dosen
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

  _inStore() {
    const v = this.$("inStore").value;
    return v && v !== "~none" ? v : null;
  }

  // Was steht im Geschäft-Feld, wenn man nichts anfasst? (für den Radiergummi)
  _defaultStore() {
    const tab = this._activeTab;
    return this._formMode === "recipe" ? "" : tab === "none" ? "~none" : tab !== "all" ? tab : "";
  }

  // ✅ Alles ok? – jeder Fund einzeln: was los ist, wie repariert wird, Haken zum Auswählen
  _runCheck() {
    const box = this.$("checkRes");
    if (!box) return;
    box.innerHTML = `<p class="hint">Prüfe … 🔍</p>`;
    this._ws({ type: "einkaufsliste/check" }).then((res) => {
      const items = res.items || [];
      if (!items.length) { box.innerHTML = `<p>✅ <b>Alles ok!</b> Nichts gefunden. 🎉</p>`; return; }
      const shown = items.slice(0, 150);
      box.innerHTML = `<p><b>⚠️ ${items.length} ${items.length === 1 ? "Sache gefunden" : "Sachen gefunden"}.</b> Anhaken, was repariert werden soll – und wie:</p>
        <div class="btnrow"><button class="btn" data-act="check-all">Alle an</button><button class="btn" data-act="check-none">Alle aus</button></div>
        <div class="chklist">${shown.map((e) => {
          const pick = e.options ? `<select title="So reparieren">${e.default ? "" : `<option value="">– bitte wählen –</option>`}
              ${e.options.map((o) => `<option value="${esc(o.value)}" ${o.value === e.default ? "selected" : ""}>${esc(o.label)}</option>`).join("")}
              ${e.empty ? `<option value="">${esc(e.empty)}</option>` : ""}</select>` : "";
          const on = !e.options || !!e.default;
          return `<label class="chkrow" data-id="${esc(e.id)}"><input type="checkbox" class="chk" ${on ? "checked" : ""}>
            <span class="ctxt"><span class="cwhat">${esc(e.text)}</span><span class="chow">🔧 ${esc(e.how)}</span>${pick}</span></label>`;
        }).join("")}</div>
        ${items.length > shown.length ? `<p class="hint">… und ${items.length - shown.length} weitere – nach dem Reparieren nochmal prüfen.</p>` : ""}
        <div class="btnrow"><button class="btn primary" data-act="check-fix" id="checkFixBtn"><ha-icon icon="mdi:wrench-outline"></ha-icon>Ausgewählte reparieren</button></div>`;
      box.onchange = (ev) => { // Auswahl geändert -> automatisch anhaken
        const sel = ev.target.closest("select");
        if (sel) sel.closest(".chkrow").querySelector("input.chk").checked = true;
        this._checkCount();
      };
      this._checkCount();
    }).catch(() => { box.innerHTML = ""; });
  }

  _checkCount() {
    const box = this.$("checkRes"), btn = this.$("checkFixBtn");
    if (!box || !btn) return;
    const n = box.querySelectorAll("input.chk:checked").length;
    btn.innerHTML = `<ha-icon icon="mdi:wrench-outline"></ha-icon>${n ? `${n} ${n === 1 ? "Sache" : "Sachen"} reparieren` : "Nichts ausgewählt"}`;
    btn.disabled = !n;
  }

  // 📦 Kategorie ändern (per langem Drücken → Kategorie)
  _catPickHtml(item) {
    return `
      <div class="moverow catrow" data-id="${item.id}">
        <span class="movetxt">Kategorie:</span>
        ${this._data.categories.map((c) => `<button class="tab ${c.id === item.category_id ? "active" : ""}" style="--c:${esc(c.color || "#888")}" data-act="cat-to" data-cat="${c.id}"><span class="dot"></span>${esc(c.name)}</button>`).join("")}
        <button class="iconbtn" data-act="cat-cancel" title="Abbrechen"><ha-icon icon="mdi:close"></ha-icon></button>
      </div>`;
  }

  _moveHtml(item) {
    const here = this._store(item.store_id);
    // 🏪 Wo gibt's das sonst noch? Die kommen zuerst (mit ✓)
    const known = this._prodStores(item.name);
    const targets = this._data.stores.filter((s) => s.id !== item.store_id)
      .sort((a, b) => (known.includes(b.id) ? 1 : 0) - (known.includes(a.id) ? 1 : 0));
    return `
      <div class="moverow" data-id="${item.id}">
        <span class="movetxt">${here ? `Bei ${esc(here.name)} nicht da?` : "Wo gibt's das?"}</span>
        ${here && this._missedAt(item.name, here.id) >= 2 ? `<span class="movewarn">⚠️ Schon ${this._missedAt(item.name, here.id) + 1}× nicht bekommen – lieber woanders?</span>` : ""}
        ${here ? `<button class="tab outbtn" data-act="move-out" title="Bleibt offen hier – alle sehen „war aus“"><ha-icon icon="mdi:refresh"></ha-icon>Nächstes Mal wieder hier</button><span class="movetxt">oder ab zu:</span>` : ""}
        ${targets.map((s) => `<button class="tab" style="--c:${esc(s.color)}" data-act="move-to" data-store="${s.id}"${known.includes(s.id) ? ` title="Gibt's da auch"` : ""}><span class="dot"></span>${esc(s.name)}${known.includes(s.id) ? " ✓" : ""}</button>`).join("")}
        ${item.store_id ? `<button class="tab" style="--c:#888" data-act="move-to" data-store="" title="Steht dann in jedem Geschäft – abgehakt wird's da, wo du es kaufst"><span class="dot"></span>🤷 Egal wo</button>` : ""}
        <button class="iconbtn" data-act="move-cancel" title="Abbrechen"><ha-icon icon="mdi:close"></ha-icon></button>
      </div>`;
  }

  _missedAt(name, storeId) {
    return (this._data?.missed || {})[`${String(name || "").toLowerCase()}|${storeId}`] || 0;
  }

  _missHintHtml() {
    const h = this._missHint;
    const item = h && this._data.items.find((i) => i.id === h.id && !i.checked && i.store_id === h.store);
    if (!item) { this._missHint = null; return ""; }
    const here = this._store(h.store);
    const known = this._prodStores(item.name);
    const others = this._data.stores.filter((st) => st.id !== h.store)
      .sort((a, b) => (known.includes(b.id) ? 1 : 0) - (known.includes(a.id) ? 1 : 0));
    return `<div class="misshint">⚠️ <b>${esc(item.name)}</b> gab's bei ${esc(here?.name || "")} schon <b>${h.n}×</b> nicht – lieber woanders?
      <div class="dbtns">${others.map((st) => `<button class="tab" style="--c:${esc(st.color)}" data-act="miss-move" data-store="${esc(st.id)}"><span class="dot"></span>${esc(st.name)}${known.includes(st.id) ? " ✓" : ""}</button>`).join("")}
      <button class="btn" data-act="miss-ok">Passt so</button></div></div>`;
  }

  _prodStores(name) {
    const h = (this._data.history || []).find((x) => x.name.toLowerCase() === String(name || "").toLowerCase());
    return h?.stores || [];
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
          <button type="button" class="btn" data-act="photo-take" data-name="${esc(this._pk(item.name, item.note))}" ${this._photoCount(this._pk(item.name, item.note)) >= 6 ? "disabled" : ""}><ha-icon icon="mdi:camera-plus-outline"></ha-icon>${this._photoCount(this._pk(item.name, item.note)) >= 6 ? "Fotos voll (6/6)" : this._hasPhoto(this._pk(item.name, item.note)) ? "Foto dazu" : "Foto"}</button>
          ${this._hasAppScanner() ? `<button type="button" class="btn" data-act="barcode-assign" data-id="${item.id}"><ha-icon icon="mdi:barcode-scan"></ha-icon>Barcode zuordnen</button>` : ""}
          ${this._hasPhoto(this._pk(item.name, item.note)) ? `<button type="button" class="btn" data-act="photo-view" data-name="${esc(this._pk(item.name, item.note))}"><ha-icon icon="mdi:image-outline"></ha-icon>Ansehen</button>` : ""}
        </div>
        <div class="btns">
          <button type="button" class="textbtn" data-act="edit-cancel">Abbrechen</button>
          <button type="submit" class="primary">Speichern</button>
        </div>
      </form>`;
  }

  // 🗺️ Kategorien in der Reihenfolge dieses Geschäfts (so wie der Laden aufgebaut ist) – sonst wie alle
  _storeCats(storeId) {
    const cats = this._data.categories;
    const order = this._store(storeId)?.cat_order;
    if (!Array.isArray(order) || !order.length) return cats;
    const pos = new Map(order.map((id, n) => [id, n]));
    return [...cats].sort((a, b) => (pos.has(a.id) ? pos.get(a.id) : 1e4 + cats.indexOf(a)) - (pos.has(b.id) ? pos.get(b.id) : 1e4 + cats.indexOf(b)));
  }

  _catOrderHtml(store) {
    const own = Array.isArray(store.cat_order);
    const cats = this._storeCats(store.id);
    return `<div class="catorder">
      <div class="srow"><ha-icon class="prev" icon="mdi:sort"></ha-icon>
        <select class="grow" id="catOrderMode" data-store="${esc(store.id)}" title="Reihenfolge der Kategorien in der Liste">
          <option value="std" ${own ? "" : "selected"}>🗺️ Kategorien wie überall</option>
          <option value="own" ${own ? "selected" : ""}>🗺️ Eigene Kategorien-Folge</option>
        </select></div>
      ${own ? `<div class="catordlist">${cats.map((c, i) => `<div class="catord"><span class="con">${i + 1}.</span><ha-icon icon="${esc(c.icon || "mdi:tag-outline")}"></ha-icon><span class="grow" translate="no">${esc(c.name)}</span>
        <button type="button" class="iconbtn" data-act="catord-up" data-store="${esc(store.id)}" data-cat="${esc(c.id)}" title="Nach oben" ${i ? "" : "disabled"}><ha-icon icon="mdi:arrow-up"></ha-icon></button>
        <button type="button" class="iconbtn" data-act="catord-down" data-store="${esc(store.id)}" data-cat="${esc(c.id)}" title="Nach unten" ${i < cats.length - 1 ? "" : "disabled"}><ha-icon icon="mdi:arrow-down"></ha-icon></button></div>`).join("")}</div>
      <p class="hint">🗺️ So wie du durch den Laden läufst – oben das, woran du zuerst vorbeikommst. Gilt nur im Reiter dieses Geschäfts.</p>` : ""}
    </div>`;
  }

  _groupedHtml(items, row, sortFn, collapsible = false, forceOpen = false) {
    const d = this._data;
    const groups = new Map();
    const here = this._fixedStore || (this._activeTab !== "all" && this._activeTab !== "none" ? this._activeTab : null);
    for (const c of here ? this._storeCats(here) : d.categories) groups.set(c.id, []);
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
    queueMicrotask(() => this._emitNav());
    const d = this._data;
    if (!d) return;
    const list = this.$("list");
    const items = d.items.filter((i) => this._matchesTab(i));
    const allView = this._activeTab === "all" && !this._fixedStore;
    this._grpMap = new Map();
    const rawOpen = items.filter((i) => !i.checked);
    const open = allView ? this._groupStores(rawOpen) : rawOpen;
    // 🔎 Was oben getippt wird, sucht unten in „Erledigt“ – nach Name, Notiz oder Person („max“).
    // Im Laden-Modus zählt das nicht (da soll immer die ganze Liste stehen).
    const typed = this._shopMode ? "" : splitMany(this.$("inName").value).pop() || "";
    const filter = (splitQty(typed).name || typed).trim().toLowerCase();
    const hit = (i) => i.name.toLowerCase().includes(filter) || (i.note || "").toLowerCase().includes(filter)
      || (filter.length >= 2 && (i.for_whom || "").toLowerCase().startsWith(filter));
    let done = items.filter((i) => i.checked);
    if (filter) done = done.filter(hit);
    if (allView) done = this._groupStores(done);
    const row = (i) => (this._editing === i.id ? this._editHtml(i) : this._itemHtml(i)
      + (this._wherePick?.id === i.id ? this._whereHtml(i) : "")
      + (this._menuId === i.id ? this._menuHtml(i) : "")
      + (this._qtyEdit === i.id ? this._qtyHtml(i) : "")
      + (this._moving === i.id ? this._moveHtml(i) : "")
      + (this._catPick === i.id ? this._catPickHtml(i) : ""));
    const byName = (a, b) => a.name.localeCompare(b.name, "de");
    const html = [];
    if (this._shopMode) {
      html.push(`<div class="shopbar"><ha-icon icon="mdi:cart"></ha-icon><b>Laden-Modus – einfach abhaken 🛒</b><button class="btn" data-act="shopmode">Beenden</button></div>`);
    }
    if (this._conflict) html.push(this._conflictHtml());
    if (this._missHint) html.push(this._missHintHtml());
    const dup = filter ? null : this._findDuplicate(rawOpen);
    if (dup) {
      const [a, b] = dup;
      const st = this._store(a.store_id);
      html.push(`<div class="dupbar" data-a="${a.id}" data-b="${b.id}">🔍 <b>„${esc(a.name)}“</b> und <b>„${esc(b.name)}“</b> stehen beide${st ? ` bei ${esc(st.name)}` : ""} auf der Liste. Zusammenlegen?
        <div class="dbtns"><button class="btn" data-act="dup-ignore">Passt so</button><button class="primary addbtn" data-act="dup-merge"><ha-icon icon="mdi:call-merge"></ha-icon>Zusammenlegen</button></div></div>`);
    }

    // 🏪 Gibt's auch hier: Artikel, die bei einem anderen Geschäft offen stehen, die es aber auch hier gibt
    const here = !allView ? (this._fixedStore || this._activeTab) : null;
    if (here && here !== "none" && !filter && this._store(here)) {
      const openHere = new Set(rawOpen.map((i) => i.name.toLowerCase())); // steht schon hier (z. B. 🤷 „Egal wo“)
      const also = d.items.filter((i) => !i.checked && i.store_id && i.store_id !== here && !i.recipe_id && !openHere.has(i.name.toLowerCase()) && this._prodStores(i.name).includes(here));
      if (also.length) {
        html.push(`<div class="alsohere"><b>🔁 Gibt's auch hier:</b> ${also.slice(0, 8).map((i) => {
          const st = this._store(i.store_id);
          return `<button class="tab" style="--c:${esc(st?.color || "#888")}" data-act="also-here" data-id="${esc(i.id)}" data-store="${esc(here)}" title="Hierher holen">${esc(i.name)}<span class="n">${esc(st?.name || "")}</span></button>`;
        }).join("")}</div>`);
      }
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
    // 🧾 Merken, wo ich abgehakt habe – für den automatischen Protokoll-Vorschlag
    if (it && !it.checked) {
      const t = this._myChecks ||= {};
      const s = it.store_id || this._fixedStore || (this._activeTab !== "all" && this._activeTab !== "none" ? this._activeTab : "");
      t.last = Date.now();
      t.stores = { ...(t.stores || {}), [s]: ((t.stores || {})[s] || 0) + 1 };
    }
    // 🤷 „Egal wo“ im Reiter eines Geschäfts abgehakt -> gehört ab jetzt zu diesem Geschäft
    const here = this._fixedStore || (this._activeTab !== "all" && this._activeTab !== "none" ? this._activeTab : null);
    const atStore = it && !it.checked && !it.store_id && here && this._store(here) ? here : null;
    this._ws({ type: "einkaufsliste/item/toggle", item_id: id, ...(atStore ? { store_id: atStore } : {}) })
      .catch(() => {})
      .finally(() => { this._pending.delete(id); this._renderAll(); });
  }

  _renderMascot(open) {
    const box = this.$("mascot");
    if (!box) return;
    const on = !!this._data?.settings?.mascot && this._config.show_title !== false; // 🛒😊 Schalter in ⚙️ – gilt für alle
    box.hidden = !on;
    this.$("titleIcon").hidden = on || this._config.show_title === false;
    if (!on) return;
    const mood = mascotMood(open), deco = mascotDeco();
    const key = mood + "|" + deco;
    if (box.dataset.k === key) return;
    const was = box.dataset.k;
    box.dataset.k = key;
    box.innerHTML = mascotSvg(mood, deco);
    if (was && mood === "happy") box.firstElementChild.classList.add("hop"); // Liste leer? Einmal kurz hüpfen 🎉
  }

  // 💡 Erster Start auf diesem Gerät: einmaliger Hinweis auf die Anleitung – und bei ganz neuer Liste ein kleiner Einrichtungs-Assistent
  _flag(key, set) {
    try {
      if (set) localStorage.setItem(key, "1");
      return localStorage.getItem(key) === "1";
    } catch (_) { return !!set; }
  }

  _renderTip() {
    const tip = this.$("tipBar"), wiz = this.$("wizard");
    if (!tip || !wiz) return;
    const d = this._data;
    const list = !!d && this._view === "list" && !this._shopMode;
    // 👋 Ganz neu (nichts eingetragen, nichts gelernt, keine Rezepte) und noch nicht weggeklickt: Assistent
    const fresh = list && !(d.items || []).length && !(d.history || []).length && !(d.recipes || []).length && !this._flag("einkaufsliste_wizard_done");
    wiz.hidden = !fresh;
    if (fresh) {
      wiz.innerHTML = `<h4>👋 Willkommen bei der Einkaufsliste!</h4>
        <div class="hint">Vier kleine Schritte – du kannst alles auch später machen:</div>
        <ol>
          <li><span>Deine Geschäfte ansehen und anpassen</span><button class="tipbtn" data-act="wizard-go" data-to="stores">🏪 Öffnen</button></li>
          <li><span>Ein Geschäft mit dem Standort verknüpfen (optional)</span><button class="tipbtn" data-act="wizard-go" data-to="stores">📍 Öffnen</button></li>
          <li><span>Das erste Produkt eintragen</span><button class="tipbtn" data-act="wizard-go" data-to="add">✍️ Los</button></li>
          <li><span>Die Anleitung durchblättern</span><button class="tipbtn" data-act="wizard-go" data-to="guide">📖 Lesen</button></li>
        </ol>
        <div class="btnrow"><button class="btn" data-act="wizard-done">Fertig – nicht mehr zeigen</button></div>`;
    }
    const showTip = list && !fresh && !this._flag("einkaufsliste_tip_guide");
    tip.hidden = !showTip;
    if (showTip) {
      tip.innerHTML = `<b>💡 Tipp: Oben links auf den Wagen 🛒 tippen – dort steht die Anleitung.</b><button class="tipbtn" data-act="tip-guide">📖 Zeig mir</button><button class="tipbtn" data-act="tip-ok">Okay</button>`;
    }
  }

  _renderFooter() {
    const f = this.$("footer");
    const s = this._data?.settings;
    if (!s || this._view !== "list") { f.hidden = true; return; }
    f.hidden = false;
    const next = new Date(s.next_cleanup);
    f.innerHTML = `<ha-icon icon="mdi:broom"></ha-icon><span>Nächstes Aufräumen: <b>${fmtDay(next)} ${s.cleanup_time}</b> – was ${s.min_age_days} Tage oder länger drauf steht, wird abgehakt</span>`
      + (window.__elOfflineApp ? "" : `<button class="guidebtn" type="button" data-act="guide" title="Anleitung fürs Einkaufen und die Rezepte"><ha-icon icon="mdi:book-open-page-variant-outline"></ha-icon>Anleitung</button>`); // 📖 fester Platz unten (in der Offline-App steht er neben „Abmelden“)
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
    queueMicrotask(() => this._emitNav());
    this._parkForm();
    const d = this._data;
    const s = d.settings;
    const row = (kind, e, i, len) => `
      <div class="srow" data-kind="${kind}" data-id="${e.id}">
        ${kind === "stores"
          ? `<input type="color" value="${esc(e.color || "#607d8b")}" data-field="color" title="Farbe">`
          : kind === "categories" || kind === "persons" || kind === "recipe_groups"
            ? `<input type="color" value="${esc(e.color || "#9e9e9e")}" data-field="color" title="Farbe">`
            : `<ha-icon class="prev" icon="${esc(kind === "persons" ? "mdi:account-outline" : e.icon || "mdi:tag-outline")}"></ha-icon>`}
        <input class="grow" value="${esc(e.name)}" data-field="name">
        ${kind === "categories" || kind === "recipe_groups" ? this._iconField(e.icon, 'data-field="icon"') : ""}
        <button class="iconbtn" data-act="up" ${i === 0 ? "disabled" : ""} title="Nach oben"><ha-icon icon="mdi:chevron-up"></ha-icon></button>
        <button class="iconbtn" data-act="down" ${i === len - 1 ? "disabled" : ""} title="Nach unten"><ha-icon icon="mdi:chevron-down"></ha-icon></button>
        <button class="iconbtn" data-act="group-remove" title="Löschen"><ha-icon icon="mdi:trash-can-outline"></ha-icon></button>
      </div>
      ${kind === "categories" || kind === "recipe_groups" ? `<div class="picker" hidden></div>` : ""}
      ${kind === "stores" && zones.length ? (() => {
        const mine = storeZones(e);
        const zname = (id) => zones.find((z) => z.id === id)?.name || id.slice(5);
        const free = zones.filter((z) => !mine.includes(z.id));
        return `
      <div class="srow zonerow" data-kind="stores" data-id="${e.id}">
        <ha-icon class="prev" icon="mdi:map-marker-outline"></ha-icon>
        <div class="grow zonechips">${mine.map((id) => `<span class="zchip">📍 ${esc(zname(id))}<button type="button" class="zx" data-act="zone-del" data-zone="${esc(id)}" title="Zone entfernen">✕</button></span>`).join("")}
        ${free.length ? `<select class="zadd" data-zadd="1" title="Zone für „Nächstes Geschäft“ – mehrere gehen, z. B. für mehrere Filialen">
          <option value="">${mine.length ? "📍 Noch eine Zone …" : "📍 Zone wählen …"}</option>
          ${free.map((z) => `<option value="${esc(z.id)}">📍 ${esc(z.name)}</option>`).join("")}
        </select>` : ""}</div>
      </div>`;
      })() : ""}
      ${kind === "stores" ? `
      <div class="srow zonerow" data-kind="stores" data-id="${e.id}">
        <ha-icon class="prev" icon="mdi:tag-outline"></ha-icon>
        <input class="grow" data-field="brands" value="${esc((e.brands || []).join(", "))}" placeholder="🏷️ Eigenmarken, z. B. Milsani, Moser Roth (mit Komma)" title="Beim Scannen landen diese Marken gleich bei diesem Geschäft">
      </div>` : ""}`;
    const zones = Object.values(this._hass.states)
      .filter((st) => st.entity_id.startsWith("zone.") && st.entity_id !== "zone.home")
      .map((st) => ({ id: st.entity_id, name: st.attributes.friendly_name || st.entity_id }))
      .sort((a, b) => a.name.localeCompare(b.name, "de"));
    const persons = d.persons || [];
    const recipes = [...(d.recipes || [])].sort((a, b) => a.name.localeCompare(b.name, "de", { sensitivity: "base" }));
    const sections = [
      { key: "stores", icon: "mdi:store-outline", title: "Geschäfte", info: d.stores.length === 1 ? "1 Geschäft" : `${d.stores.length} Geschäfte`, html: () => {
        // 🏪 Ein Geschäft angetippt? Dann nur dessen Einstellungen
        const k = d.stores.findIndex((x) => x.id === this._storeSel);
        if (k >= 0) {
          const e = d.stores[k];
          return `
        <div class="storehead" style="--sc:${esc(e.color || "#607d8b")}"><ha-icon icon="${esc(this._storeIcon(e))}"></ha-icon><b translate="no">${esc(e.name)}</b></div>
        ${row("stores", e, k, d.stores.length)}
        <div class="srow" data-kind="stores" data-id="${e.id}">
          <ha-icon class="prev" icon="${esc(this._storeIcon(e))}"></ha-icon>
          <input class="icon grow" data-field="icon" value="${esc(e.icon && !EL_START_STORE_ICONS.has(e.icon) ? stripMdi(e.icon) : "")}" placeholder="Icon, z. B. baguette" title="Leer lassen = Icon der Zone (wenn sie eins hat), sonst Einkaufswagen">
        </div>
        <div class="picker" hidden></div>
        ${this._catOrderHtml(e)}
        ${zones.length ? "" : `<p class="hint">📍 Noch keine Zonen in Home Assistant angelegt (Einstellungen → Bereiche, Beschriftungen & Zonen → Zonen).</p>`}
        <p class="hint">🖼️ Icon: Namen tippen (z. B. <b>baguette</b>, <b>pill</b>, <b>hammer</b>) und aus der Vorschau antippen. Leer lassen = Icon der Zone, sonst 🛒.</p>
        <p class="hint">📍 Zonen: Bist du in einer davon, springt die Liste auf dieses Geschäft – mehrere gehen, z. B. für mehrere Filialen. 🏷️ Eigenmarken: Beim Scannen landen diese Marken gleich hier.</p>`;
        }
        return `
        <div class="tiles storetiles">${d.stores.map((e) => {
          const nz = storeZones(e).length, nb = (e.brands || []).length;
          const info = [nz ? `📍 ${nz} ${nz === 1 ? "Zone" : "Zonen"}` : "", nb ? `🏷️ ${nb} ${nb === 1 ? "Marke" : "Marken"}` : "", Array.isArray(e.cat_order) ? "🗺️ eigene Reihenfolge" : ""].filter(Boolean).join(" · ") || "antippen zum Einstellen";
          return `<button class="tile storetile" data-act="store-sel" data-id="${e.id}" style="--sc:${esc(e.color || "#607d8b")}">
            <ha-icon icon="${esc(this._storeIcon(e))}"></ha-icon><b translate="no">${esc(e.name)}</b><small>${esc(info)}</small></button>`;
        }).join("")}</div>
        <form class="srow" data-addkind="stores">
          <input type="color" value="#607d8b" name="color" title="Farbe">
          <input class="grow" name="name" placeholder="Neues Geschäft, z. B. Kaufland">
          <button class="primary" type="submit" title="Hinzufügen"><ha-icon icon="mdi:plus"></ha-icon></button>
        </form>
        <p class="hint">Geschäft antippen = Name, Farbe, Reihenfolge, 📍 Zonen, 🏷️ Eigenmarken und 🗺️ Reihenfolge der Kategorien einstellen.</p>`;
      } },
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
      { key: "recipes", icon: "mdi:chef-hat", title: "Rezepte", info: `${recipes.length ? (recipes.length === 1 ? "1 Rezept" : `${recipes.length} Rezepte`) : "noch keine"} · ${(d.recipe_groups || []).length} Gruppen`, html: () => `
        ${this._recTab === "groups" ? "" : `<button class="newrec" type="button" data-act="recipe-new"><ha-icon icon="mdi:chef-hat"></ha-icon><span>Neues Rezept</span><ha-icon icon="mdi:plus-circle-outline"></ha-icon></button>`}
        <div class="subtabs">
          <button class="tab ${this._recTab !== "groups" ? "active" : ""}" data-act="rec-tab" data-tab="recipes"><ha-icon icon="mdi:chef-hat"></ha-icon>Rezepte</button>
          <button class="tab ${this._recTab === "groups" ? "active" : ""}" data-act="rec-tab" data-tab="groups"><ha-icon icon="mdi:tag-multiple-outline"></ha-icon>Rezept-Gruppen</button>
        </div>
        ${this._recTab === "groups" ? `
        ${(d.recipe_groups || []).map((e, i) => row("recipe_groups", e, i, d.recipe_groups.length)).join("")}
        <form class="srow" data-addkind="recipe_groups">
          <ha-icon class="prev" icon="mdi:tag-plus-outline"></ha-icon>
          <input class="grow" name="name" placeholder="Neue Gruppe, z. B. Grillen">
          ${this._iconField("", 'name="icon" data-newicon="1"')}
          <button class="primary" type="submit" title="Hinzufügen"><ha-icon icon="mdi:plus"></ha-icon></button>
        </form>
        <div class="picker" hidden></div>
        <p class="hint">Das Icon der Gruppe bekommen automatisch alle Rezepte dieser Gruppe. Icon: einfach den Namen tippen (z. B. <b>fish</b>, <b>pizza</b> oder <b>cake</b>) und aus der Vorschau antippen.</p>` : `
        ${recipes.length ? this._recipeSearchHtml("recipeSearchS") : ""}
        <div id="setRecipeList"></div>`}` },
      { key: "recipe_groups", parent: "recipes", alias: true },
      { key: "persons", icon: "mdi:account-group-outline", title: "Personen", info: persons.length ? `${persons.length} für „Für wen?“` : "noch keine", html: () => `
        ${persons.map((e, i) => row("persons", e, i, persons.length)).join("")}
        <form class="srow" data-addkind="persons">
          <ha-icon class="prev" icon="mdi:account-plus-outline"></ha-icon>
          <input class="grow" name="name" placeholder="Neue Person, z. B. Oma">
          <button class="primary" type="submit" title="Hinzufügen"><ha-icon icon="mdi:plus"></ha-icon></button>
        </form>
        <p class="hint">${persons.length ? "Diese Namen erscheinen als Schnellknöpfe bei 👤 „Für wen?“." : "Noch keine Personen – solange bleibt das Feld „Für wen?“ ausgeblendet."}</p>` },
      { key: "products", icon: "mdi:package-variant-closed", title: "Produkte", info: "alle Produkte, Fotos, Barcodes, löschen", html: () => `
        <div class="subtabs">
          <button class="tab ${!this._prodTab || this._prodTab === "catalog" ? "active" : ""}" data-act="prod-tab" data-tab="catalog"><ha-icon icon="mdi:package-variant-closed"></ha-icon>Alle Produkte</button>
          <button class="tab ${this._prodTab === "scanned" ? "active" : ""}" data-act="prod-tab" data-tab="scanned" style="--c:var(--warning-color,#ffa600)"><ha-icon icon="mdi:barcode-scan"></ha-icon>Neu gescannt${d.scanned_new ? ` (${d.scanned_new})` : ""}</button>
          <button class="tab ${this._prodTab === "delete" ? "active" : ""}" data-act="prod-tab" data-tab="delete" style="--c:var(--error-color,#db4437)"><ha-icon icon="mdi:delete-outline"></ha-icon>Einkaufsliste Produkte löschen</button>
        </div>
        ${this._prodTab === "delete" ? `
        <p class="hint">Hier verschwinden Artikel endgültig von der Einkaufsliste, auch aus „Erledigt“. Barcode und Vorschlag bleiben; das Foto kommt mit weg, wenn das Produkt sonst nirgends mehr steht. Ganz löschen geht unter „Alle Produkte“.</p>
        <div class="srow"><ha-icon class="prev" icon="mdi:magnify"></ha-icon><input class="grow" id="delSearch" placeholder="Artikel suchen …" value="${esc(this._delFilter || "")}"></div>
        <div id="delList"></div>` : `
        ${this._prodTab === "scanned"
          ? `<p class="hint">Hier stehen Produkte, die neu gescannt wurden. Kurz prüfen: Stimmt der Name? Dann <b>✔ Passt</b>. Sonst antippen und korrigieren – Speichern zählt auch als geprüft.</p>`
          : `<p class="hint">Alle Produkte, die die Liste kennt. Antippen = ändern oder ganz löschen. Umbenennen zieht Fotos, Barcodes, Artikel und Rezepte mit.</p>`}
        <div class="srow"><ha-icon class="prev" icon="mdi:magnify"></ha-icon><input class="grow" id="prodSearch" placeholder="Produkt suchen …" value="${esc(this._prodFilter || "")}"></div>
        ${this._prodTab === "scanned" ? "" : `<div class="srow"><ha-icon class="prev" icon="mdi:filter-variant"></ha-icon><select class="grow" id="prodFilterSel" title="Filter">${this._prodFilterOptions()}</select>
          <button class="btn" data-act="prod-add" title="Neues Produkt in den Katalog"><ha-icon icon="mdi:plus"></ha-icon>Neues Produkt</button>
          <button class="btn" data-act="prod-add-bc" title="Neues Produkt per Barcode in den Katalog"><ha-icon icon="mdi:barcode-scan"></ha-icon>Per Barcode</button></div>
        ${elIsPc() ? `<p class="hint">⌨️ Klick = markieren · Doppelklick oder Enter = bearbeiten · ↑↓ = blättern · Esc = zurück</p>` : ""}`}
        <div id="prodList"><p class="hint">Lade Produkte …</p></div>`}` },
      { key: "news", icon: "mdi:new-box", title: "Was ist neu", info: `Version ${EL_VERSION}`, html: () => this._newsHtml() },
      { key: "credits", icon: "mdi:hand-heart-outline", title: "Credits", info: `v${EL_VERSION} · von Mister-M`, html: () => this._creditsHtml() },
      { key: "offers", icon: "mdi:tag-outline", title: "Angebote", info: this._data.settings?.offers?.enabled ? (this._data.settings.offers.ok === false ? "⚠️ gerade nicht verfügbar" : "an · Marktguru") : "aus · inoffiziell", html: () => this._offersHtml() },
      { key: "stats", icon: "mdi:chart-donut", title: "Ressourcen", info: "Speicher & Umfang", html: () => `
        <p class="hint">So viel Platz braucht die Einkaufsliste in deinem Home Assistant.</p>
        <div id="statsBox"><p class="hint">Lade …</p></div>` },
      { key: "check", icon: "mdi:check-decagram-outline", title: "Alles ok?", info: "prüfen & reparieren", html: () => `
        <p class="hint">Sucht nach kaputten oder unvollständigen Einträgen: Produkte ohne Kategorie, Artikel ohne Geschäft, fehlende oder übrige Fotos, Barcodes ohne Produkt und Verweise auf Gelöschtes. Jeder Fund steht einzeln da – mit Haken und wie repariert wird. Repariert wird nur, was du anhakst.</p>
        <div class="btnrow"><button class="btn primary" data-act="check-run"><ha-icon icon="mdi:magnify"></ha-icon>Jetzt prüfen</button></div>
        <div id="checkRes"></div>` },
      { key: "errors", icon: "mdi:bug-outline", title: "Fehler-Protokoll", info: (this._data.settings?.errors || 0) ? `${this._data.settings.errors} Meldungen` : "keine Fehler 🎉", html: () => this._errorsHtml() },
      { key: "transfer", icon: "mdi:database-import-outline", title: "Import & Sicherung", info: "Rezepte, andere Apps, Backup", html: () => this._xferHtml() },
      { key: "app", icon: "mdi:cellphone-arrow-down", title: "Offline-App", info: "Liste auch ohne Netz", html: () => `
        <p class="hint">Eine eigene kleine App nur für die Einkaufsliste. Sie öffnet sich auch <b>ohne Netz</b> (z. B. im Funkloch im Geschäft), zeigt den letzten Stand, lässt dich abhaken und eintragen und schickt alles nach, sobald wieder Netz da ist.</p>
        <ol class="hint xferfmt">
          <li>Auf dem Handy im <b>Browser</b> (Chrome oder Safari, nicht in der HA-App) deine Home-Assistant-Adresse von unterwegs öffnen, z. B. die Nabu-Casa-Adresse, und <code>/einkaufsliste/app/</code> anhängen.</li>
          <li>Einmal mit deinem Home-Assistant-Benutzer <b>anmelden</b>.</li>
          <li>Im Browser-Menü <b>„Zum Startbildschirm hinzufügen“</b> – fertig, eigenes 🛒-Symbol.</li>
        </ol>
        <p class="hint">In der App steckt <b>genau diese Karte</b> – mit Rezepten, Koch-Modus, Gar-Zeiten und Einstellungen. Ohne Netz kannst du alles ansehen, abhaken, eintragen und Rezepte ändern; es wird nachgeschickt. Scannen geht mit der Handykamera (beim ersten Mal fragt das Handy, ob die Seite die Kamera nutzen darf); ohne Netz erkennt sie nur Barcodes, die die Liste schon kennt. Nur mit Netz: neue Barcodes nachschlagen, Produkt-Infos, Rezept-Links, neue Fotos, Sicherung. Wichtig: Es braucht eine <b>https</b>-Adresse (z. B. Nabu Casa).</p>
        ${d.settings?.app_url
          ? `<p class="hint"><b>Deine Adresse für die App:</b></p>
        <input class="full" id="appUrl" readonly value="${esc(d.settings.app_url)}" translate="no" style="width:100%;box-sizing:border-box">
        <div class="btnrow"><button class="btn primary" data-act="app-copy"><ha-icon icon="mdi:content-copy"></ha-icon>Kopieren</button></div>
        <p class="hint">Kopieren, im Handy-Browser einfügen, fertig. Die Adresse funktioniert zu Hause und unterwegs.</p>`
          : `<p class="hint">⚠️ Home Assistant kennt keine https-Adresse für unterwegs. Mit <b>Nabu Casa</b> (Einstellungen → Home Assistant Cloud → Fernzugriff) oder einer eigenen https-Adresse (Einstellungen → System → Netzwerk) klappt es.</p>`}` },
      { key: "mascot", icon: "mdi:emoticon-happy-outline", title: "Maskottchen", info: this._data.settings?.mascot ? "an – für alle" : "aus", html: () => `
        <p class="hint">Statt des Einkaufswagen-Symbols oben links sitzt dann ein kleiner Einkaufswagen mit Gesicht. Er strahlt bei leerer Liste, schwitzt bei vollem Wagen, schläft nachts und hat an Feiertagen Deko auf. Sonst trägt er das Kostüm der Jahreszeit: Blume im Frühling, Sonnenbrille im Sommer, Blatt im Herbst, Schal im Winter. Antippen öffnet wie gewohnt die Anleitung.</p>
        <div class="mascotprev">${mascotSvg("happy", null)}${mascotSvg("busy", null)}${mascotSvg("full", null)}${mascotSvg("sleep", null)}</div>
        <div class="mascotprev">${["spring", "summer", "autumn", "winter"].map((x) => mascotSvg("happy", x)).join("")}</div>
        <p><b>${this._data.settings?.mascot ? "🛒😊 Das Maskottchen ist an." : "Das Maskottchen ist aus."}</b> Der Schalter gilt für <b>alle</b> – auf allen Handys, im Dashboard und in der App.</p>
        <div class="btnrow"><button class="btn primary" data-act="mascot-toggle"><ha-icon icon="${this._data.settings?.mascot ? "mdi:emoticon-neutral-outline" : "mdi:emoticon-happy-outline"}"></ha-icon>${this._data.settings?.mascot ? "Ausschalten" : "Einschalten"}</button></div>` },
      { key: "autoshop", icon: "mdi:map-marker-radius-outline", title: "Laden-Modus automatisch", info: this._data.settings?.auto_shop ? "an – für alle" : "aus", html: () => `
        <p class="hint">Kommst du in die 📍 Zone eines Geschäfts, geht der Laden-Modus von selbst an – und wieder aus, sobald du den Laden verlässt. Was du selbst ein- oder ausschaltest, lässt die Automatik in Ruhe.</p>
        <p><b>${this._data.settings?.auto_shop ? "📍 Automatisch ist an." : "Automatisch ist aus."}</b> Der Schalter gilt für <b>alle</b> Geräte. Der Standort bleibt dabei bei jedem selbst: Der Laden-Modus geht nur an, wenn <b>dein</b> Handy in die Zone kommt.</p>
        <p class="hint">Es braucht eine 📍 Zone beim Geschäft (Geschäfte → Standort) und dein Handy als Person in Home Assistant.</p>
        <div class="btnrow"><button class="btn primary" data-act="autoshop-toggle"><ha-icon icon="mdi:map-marker-radius-outline"></ha-icon>${this._data.settings?.auto_shop ? "Ausschalten" : "Einschalten"}</button></div>` },
      { key: "spend", icon: "mdi:receipt-text-outline", title: "Einkaufs-Protokoll", info: this._data.settings?.spend ? "an – für alle" : "aus", html: () => `
        <p class="hint">Merkt sich nach jedem Einkauf, wer wann wo für wie viel eingekauft hat. Die Auswertung zeigt Summen pro Geschäft und pro Monat, mit Filtern nach Person, Geschäft und Datum. Unabhängig von den Listen – der Betrag wird von Hand eingetragen.</p>
        <p><b>${this._data.settings?.spend ? "🧾 Das Einkaufs-Protokoll ist an." : "Das Einkaufs-Protokoll ist aus."}</b></p>
        <p class="hint">Der Schalter gilt für alle. Ist es an, sehen und pflegen es alle in der Familie – den 🧾-Knopf oben in der Karte und hier im Verlauf.</p>
        <div class="btnrow"><button class="btn primary" data-act="spend-toggle"><ha-icon icon="mdi:receipt-text-outline"></ha-icon>${this._data.settings?.spend ? "Ausschalten" : "Einschalten"}</button>${this._data.settings?.spend ? `<button class="btn" data-act="spend"><ha-icon icon="mdi:open-in-new"></ha-icon>Öffnen</button>` : ""}</div>
        ${this._data.settings?.spend ? `<p><b>${this._data.settings?.spend_auto ? "🎉 Automatisch fragen: an" : "Automatisch fragen: aus"}</b></p>
        <p class="hint">Wenn alles auf der Liste abgehakt ist, geht der Einkauf-eintragen-Dialog von selbst auf – mit dem Geschäft schon ausgewählt. Gilt für alle.</p>
        <div class="btnrow"><button class="btn" data-act="spend-auto-toggle"><ha-icon icon="mdi:party-popper"></ha-icon>${this._data.settings?.spend_auto ? "Ausschalten" : "Einschalten"}</button></div>` : ""}
        <p class="hint">Ausschalten versteckt nur die Anzeige – die bisherigen Einträge bleiben gespeichert.</p>` },
      ...(window.__elOfflineApp ? [{ key: "theme", icon: "mdi:theme-light-dark", title: "Hell / Dunkel", info: { light: "☀️ Hell", dark: "🌙 Dunkel" }[elAppTheme()] || "🌓 Automatisch", html: () => `
        <p class="hint">Nur für die Offline-App auf diesem Gerät. „Automatisch“ richtet sich nach dem Handy – so wie Home Assistant auch.</p>
        <div class="btnrow themebtns">${[["auto", "🌓 Automatisch"], ["light", "☀️ Hell"], ["dark", "🌙 Dunkel"]].map(([v, l]) =>
          `<button class="btn ${elAppTheme() === v ? "primary" : ""}" data-act="app-theme" data-v="${v}">${l}</button>`).join("")}</div>` }] : []),
      { key: "pin", icon: this._data.settings?.pin ? "mdi:lock-outline" : "mdi:lock-open-variant-outline", title: "Schutz", info: this._data.settings?.pin ? "PIN ist an" : "PIN fürs Zahnrad", html: () => this._pinHtml() },
      { key: "log", icon: "mdi:history", title: "Verlauf", info: "wer, wann, was, wie", html: () => this._logSectionHtml() },
      { key: "cleanup", icon: "mdi:broom", title: "Aufräumen", info: `${WD_SHORT[s.cleanup_weekday]} ${s.cleanup_time} Uhr`, html: () => `
        <p>Jeden <b>${WD_LONG[s.cleanup_weekday]}</b> um <b>${s.cleanup_time} Uhr</b> werden alle offenen Artikel <b>abgehakt</b>, die mindestens <b>${s.min_age_days} Tage</b> auf der Liste stehen. Gelöscht wird nichts – so kannst du sie später mit einem Tipp wieder auf die Liste nehmen.</p>
        <p class="hint">Tag & Uhrzeit ändern: Einstellungen → Geräte & Dienste → Einkaufsliste → Konfigurieren</p>
        <div class="btnrow">
          <button class="btn" data-act="cleanup-now"><ha-icon icon="mdi:broom"></ha-icon>Jetzt aufräumen</button>
          <button class="btn" data-act="check-all"><ha-icon icon="mdi:checkbox-multiple-marked-circle-outline"></ha-icon>Alles abhaken</button>
        </div>` },
    ];
    if (this._setSec === "recipe_groups") { this._setSec = "recipes"; this._recTab = "groups"; } // alter Weg zu den Rezept-Gruppen
    const cur = sections.find((x) => x.key === this._setSec && !x.alias);
    if (!cur) {
      this.$("otherView").innerHTML = `
        <div class="sec">
          <h3><ha-icon icon="mdi:cog-outline"></ha-icon>Einstellungen</h3>
          <button class="health wait" id="healthBar" data-act="set-sec" data-sec="check"><span>⚪</span><span><b>Prüfe …</b></span></button>
          <div class="srow"><ha-icon class="prev" icon="mdi:magnify"></ha-icon><input class="grow" id="setSearch" placeholder="In den Einstellungen suchen …" value="${esc(this._setQ || "")}"></div>
          <div id="setList">${this._settingsListHtml(sections)}</div>
          <div class="btnrow" style="margin-top:14px"><button class="btn" data-act="guide-settings"><ha-icon icon="mdi:book-open-variant"></ha-icon>Anleitung Einstellungen</button></div>
        </div>
        <p class="hint" style="text-align:right">Einkaufsliste v${EL_VERSION}</p>`;
      this.$("setSearch").addEventListener("input", (ev) => {
        this._setQ = ev.target.value;
        this.$("setList").innerHTML = this._settingsListHtml(sections);
      });
      this._loadHealth();
      return;
    }
    const storeOpen = cur.key === "stores" && d.stores.some((x) => x.id === this._storeSel);
    const back = storeOpen
      ? `<button class="btn back" data-act="store-sel" data-id=""><ha-icon icon="mdi:arrow-left"></ha-icon>Alle Geschäfte</button>`
      : `<button class="btn back" data-act="set-sec" data-sec=""><ha-icon icon="mdi:arrow-left"></ha-icon>Übersicht</button>`;
    this.$("otherView").innerHTML = `
      <div class="sec">
        <div class="sechead">
          ${back}
          <h3><ha-icon icon="${cur.icon}"></ha-icon>${cur.title}</h3>
        </div>
        ${cur.html()}
      </div>`;
    if (cur.key === "log") { this._renderLogList(); this._loadLog(); }
    if (cur.key === "stats") this._loadStats();
    if (cur.key === "errors") this._loadErrors();
    if (cur.key === "products" && this._prodTab !== "delete") { this._renderProducts(); this._loadProducts(); }
    if (cur.key === "recipes" && this._recTab !== "groups") this._renderSetRecipeList();
    if (cur.key === "transfer" && this._xferTab === "apps") this._loadTodoLists();
    if (cur.key === "transfer" && this._xferTab === "mail") this._loadMailSources();
    this._renderDelList();
  }

  // 🗂️ Einstellungen als Liste: Überschriften nach Zweck, eine Ebene tief, mit Suche
  _settingsListHtml(sections) {
    const groups = [
      ["📋 Meine Liste", ["stores", "categories", "persons", "products", "recipes"]],
      ["🎛️ Extras", ["offers", "spend", "autoshop", "mascot"]],
      ["💾 Daten", ["transfer", "log", "cleanup"]],
      ["🩺 Gesundheit", ["check", "errors", "stats"]],
      ["📱 App & Info", ["app", "theme", "pin", "news", "credits"]],
    ];
    const kw = {
      stores: "laden markt zone standort icon eigenmarken", categories: "kategorie farbe reihenfolge", persons: "für wen namen familie",
      products: "katalog barcode foto löschen zusammenführen scan alt monate", recipes: "rezept gruppen kochen zutaten",
      offers: "angebote marktguru preise plz", spend: "protokoll bon kasse kosten einkauf",
      autoshop: "laden-modus automatisch zone", mascot: "maskottchen wagen gesicht", transfer: "import export sicherung backup mail e-mail alexa todo csv bring",
      log: "verlauf wer wann", cleanup: "aufräumen abhaken", check: "alles ok reparieren gesundheit ampel", errors: "fehler protokoll kopieren",
      stats: "ressourcen speicher verbrauch", app: "offline app startbildschirm", theme: "hell dunkel", pin: "pin schutz sperre", news: "neu version", credits: "über danke lizenz github",
    };
    const q = (this._setQ || "").trim().toLowerCase();
    const byKey = Object.fromEntries(sections.map((x) => [x.key, x]));
    const out = groups.map(([title, keys]) => {
      const rows = keys.map((k) => byKey[k]).filter(Boolean)
        .filter((x) => !q || `${x.title} ${x.info} ${kw[x.key] || ""}`.toLowerCase().includes(q))
        .map((x) => `<button class="lrow" data-act="set-sec" data-sec="${x.key}"><ha-icon icon="${x.icon}"></ha-icon><span class="grow"><b>${x.title}</b><small>${esc(x.info)}</small></span><ha-icon class="chev" icon="mdi:chevron-right"></ha-icon></button>`).join("");
      if (!rows) return "";
      const open = !!q || this._setOpen === title; // 🗂️ zugeklappt; bei der Suche klappen passende Überschriften von selbst auf
      return `<button class="lgroup" data-act="set-grp" data-grp="${esc(title)}" aria-expanded="${open}"><span class="grow">${title}</span><ha-icon class="chev" icon="mdi:chevron-${open ? "up" : "down"}"></ha-icon></button>${open ? rows : ""}`;
    }).join("");
    return out || `<p class="hint">Nichts gefunden zu „${esc(q)}“.</p>`;
  }

  // 🔒 PIN fürs Zahnrad
  // 🔒 Sofort-Sperren: nur da, wenn eine PIN vergeben ist und das Zahnrad gerade offen ist
  _updateLockBtn() {
    const btn = this.$("btnLock");
    if (btn) btn.hidden = !(this._data?.settings?.pin && pinUnlocked());
  }

  _lockNow() {
    try { localStorage.removeItem(PIN_KEY); } catch (_) { /* egal */ }
    if (this._view === "settings") { this._view = "list"; this._setSec = null; }
    this._toast("🔒 Gesperrt – das Zahnrad braucht jetzt wieder die PIN");
    this._renderAll();
  }

  async _unlockSettings() {
    const pin = await askPin();
    if (pin == null) return;
    const res = await this._ws({ type: "einkaufsliste/pin/check", pin }).catch(() => null);
    if (!res?.ok) { this._toast("🔒 Falsche PIN"); return; }
    pinRemember();
    this._view = "settings";
    this._setSec = null;
    this._draft = null;
    this._renderAll();
  }

  _pinHtml() {
    const on = !!this._data.settings?.pin;
    return `
      <p class="hint">Mit einer PIN geht das ⚙️-Zahnrad nur noch nach Eingabe der PIN auf. Die Liste selbst (eintragen, abhaken, Rezepte, Laden-Modus) bleibt für alle offen. Nach der Eingabe bleibt das Zahnrad auf diesem Gerät 10 Minuten offen.</p>
      <p><b>${on ? "🔒 PIN ist an." : "🔓 Keine PIN – das Zahnrad ist für alle offen."}</b></p>
      <div class="btnrow">
        <button class="btn primary" data-act="pin-set"><ha-icon icon="mdi:lock-outline"></ha-icon>${on ? "PIN ändern" : "PIN festlegen"}</button>
        ${on ? `<button class="btn" data-act="pin-off"><ha-icon icon="mdi:lock-open-variant-outline"></ha-icon>PIN ausschalten</button>` : ""}
      </div>
      <p class="hint">PIN vergessen? Ein Admin setzt sie in Home Assistant zurück: Einstellungen → Geräte & Dienste → Einkaufsliste → Konfigurieren → „PIN zurücksetzen“.<br>Ehrlich gesagt: Die PIN schützt vor versehentlichem Verstellen und neugierigen Kinderaugen – ein Tresor ist sie nicht.</p>`;
  }

  async _pinChange(off) {
    const on = !!this._data.settings?.pin;
    let old = null;
    if (on) { old = await askPin("🔒 Aktuelle PIN"); if (old == null) return; }
    let pin = null;
    if (!off) {
      pin = await askPin("🔢 Neue PIN (4–8 Ziffern)");
      if (pin == null) return;
      const again = await askPin("🔁 Neue PIN nochmal");
      if (again == null) return;
      if (again !== pin) { this._toast("Die beiden PINs sind unterschiedlich 🙈"); return; }
    }
    try {
      await this._ws({ type: "einkaufsliste/pin/set", pin, old });
      if (pin) pinRemember();
      this._toast(pin ? "🔒 PIN gespeichert" : "🔓 PIN ausgeschaltet");
      setTimeout(() => this._renderSettings(), 300);
    } catch (_) { /* Meldung kam schon */ }
  }

  // 📥 Import & Sicherung: Rezepte aus Datei, andere Apps, Backup
  _xferHtml() {
    const tab = this._xferTab || "recipes";
    const admin = !!this._hass?.user?.is_admin;
    const t = (k, icon, label) => `<button class="tab ${tab === k ? "active" : ""}" data-act="xfer-tab" data-tab="${k}"><ha-icon icon="${icon}"></ha-icon>${label}</button>`;
    const stores = this._selectOptions(this._data.stores, this._data.stores[0]?.id, "🛒 Welches Geschäft?");
    let body = "";
    if (tab === "recipes") {
      body = `
        <p class="hint">Eine Datei mit Rezepten einlesen – z. B. aus einer anderen Rezept-App oder selbst getippt. Amerikanische Maße (cup, oz, lb, tbsp, °F) werden dabei automatisch umgerechnet.</p>
        <ul class="hint xferfmt">
          <li><b>.txt / .md</b>: jedes Rezept beginnt mit <code># Name</code>, danach „Zutaten“ (eine pro Zeile) und „Zubereitung“.</li>
          <li><b>.csv</b>: Spalten <code>Rezept;Menge;Einheit;Zutat;Notiz;Zubereitung</code> – eine Zeile pro Zutat.</li>
          <li><b>.json</b>: Rezepte aus einer Sicherung oder im gleichen Aufbau.</li>
        </ul>
        ${admin ? `<div class="btnrow"><label class="btn primary"><ha-icon icon="mdi:file-upload-outline"></ha-icon>Datei auswählen<input type="file" id="xferRecipeFile" accept=".txt,.md,.csv,.json,text/*,application/json" hidden></label></div>` : `<p class="hint">🔒 Rezepte einlesen darf nur ein Admin.</p>`}
        <div id="xferRes"></div>`;
    } else if (tab === "apps") {
      const sync = this._data.settings?.todo_sync;
      const syncStore = sync?.store_id ? this._store(sync.store_id)?.name : null;
      body = `
        <div class="syncbox">
        <p class="hint"><b>🔁 Automatisch herüberholen</b>: Alles, was auf der gewählten Liste landet, wandert <b>sofort</b> in die Einkaufsliste – ganz ohne Automation. Unten auswählen: 🗑️ dort löschen · 🔗 bei beiden behalten (Abhaken wird in beide Richtungen abgeglichen) · 🔄 voller Abgleich (zusätzlich kommt alles aus der Einkaufsliste auch dorthin, ohne Geschäft und Notiz). Für <b>Alexa</b>: in Home Assistant die Integration „Alexa Devices“ einrichten und hier deren Einkaufsliste wählen. Dann reicht „Alexa, setz Milch auf die Einkaufsliste“.</p>
        ${sync ? `<p><b>✅ An:</b> <span translate="no">${esc(sync.name || sync.entity_id)}</span> → ${syncStore ? `<span translate="no">${esc(syncStore)}</span>` : "<span>Egal wo</span>"}<span> · ${{ move: "herüberholen & dort löschen", keep: "bei beiden behalten", sync: "voller Abgleich" }[sync.mode || "move"]}</span>${sync.count ? `<span> · schon ${sync.count}× herübergeholt</span>` : ""}${sync.ok === false ? `<br><span>⚠️ Die Liste ist gerade nicht erreichbar – es geht weiter, sobald sie wieder da ist.</span>` : ""}</p>` : ""}
        ${!admin ? `<p class="hint">🔒 Einschalten oder ändern kann das nur ein Admin – es verändert eine andere Liste in Home Assistant.</p>` : `
        <div class="srow"><ha-icon class="prev" icon="mdi:sync"></ha-icon><select class="grow" id="syncTodo"><option value="">Lade Listen …</option></select></div>
        <div class="srow"><ha-icon class="prev" icon="mdi:swap-horizontal"></ha-icon><select class="grow" id="syncMode" title="Wie abgeglichen wird">
          ${[["move", "🗑️ Holen & dort löschen"], ["keep", "🔗 Bei beiden behalten"], ["sync", "🔄 Voller Abgleich"]]
            .map(([v, l]) => `<option value="${v}" ${(sync?.mode || "move") === v ? "selected" : ""}>${l}</option>`).join("")}
        </select></div>
        <div class="srow"><ha-icon class="prev" icon="mdi:store-outline"></ha-icon><select class="grow" id="syncStore">${this._selectOptions(this._data.stores, sync?.store_id || null, "🛒 Egal wo")}</select></div>
        <div class="btnrow"><button class="btn primary" data-act="sync-on"><ha-icon icon="mdi:sync"></ha-icon>${sync ? "Ändern" : "Einschalten"}</button>${sync ? `<button class="btn" data-act="sync-off"><ha-icon icon="mdi:sync-off"></ha-icon>Ausschalten</button>` : ""}</div>
        `}
        </div>
        <p class="hint" style="margin-top:14px"><b>Einmal herüberholen</b>: Die Artikel einer anderen HA-Liste (z. B. der eingebauten Einkaufsliste oder einer Google-/Bring!-Liste, die in HA eingebunden ist) herüberholen. Die alte Liste bleibt, wie sie ist.</p>
        <div class="srow"><ha-icon class="prev" icon="mdi:format-list-checks"></ha-icon><select class="grow" id="xferTodo"><option value="">Lade Listen …</option></select></div>
        <div class="srow"><ha-icon class="prev" icon="mdi:store-outline"></ha-icon><select class="grow" id="xferTodoStore">${stores}</select></div>
        <div class="btnrow"><button class="btn primary" data-act="xfer-todo"><ha-icon icon="mdi:import"></ha-icon>Herüberholen</button></div>
        <p class="hint" style="margin-top:14px"><b>Text einfügen</b>: In Bring!, Google Keep & Co. die Liste „teilen“ oder kopieren und hier einfügen – ein Artikel pro Zeile. Aufzählungszeichen und Häkchen stören nicht, schon abgehakte (☑, [x]) bleiben draußen.</p>
        <textarea id="xferText" rows="6" placeholder="Milch&#10;2 Äpfel&#10;- Brot&#10;☐ Butter"></textarea>
        <div class="srow"><ha-icon class="prev" icon="mdi:store-outline"></ha-icon><select class="grow" id="xferTextStore">${stores}</select></div>
        <div class="btnrow"><button class="btn primary" data-act="xfer-text"><ha-icon icon="mdi:playlist-plus"></ha-icon>Auf die Liste</button></div>
        <div id="xferRes"></div>`;
    } else if (tab === "mail") {
      body = this._mailHtml();
    } else {
      body = admin ? `
        <p class="hint"><b>Sicherung herunterladen</b>: Alles in einer Datei (.zip) – Liste, Rezepte, Produkte, Barcodes, Fotos, Geschäfte, Personen, Verlauf. Gut für vor einem Umzug oder einfach so.</p>
        <div class="btnrow"><button class="btn primary" data-act="xfer-backup"><ha-icon icon="mdi:download"></ha-icon>Sicherung herunterladen</button></div>
        <p class="hint" style="margin-top:14px"><b>Sicherung einspielen</b>: Ersetzt <b>alles</b>, was jetzt da ist, durch den Stand aus der Datei. Vorher am besten selbst noch eine Sicherung ziehen 😉</p>
        <div class="btnrow"><label class="btn" style="--c:var(--error-color,#db4437)"><ha-icon icon="mdi:backup-restore"></ha-icon>Sicherung einspielen …<input type="file" id="xferRestore" accept=".zip,application/zip" hidden></label></div>
        <div id="xferRes"></div>` : `<p class="hint">🔒 Sicherungen darf nur ein Admin herunterladen oder einspielen.</p>`;
    }
    return `<div class="subtabs">${t("recipes", "mdi:file-document-outline", "Rezepte aus Datei")}${t("apps", "mdi:swap-horizontal-circle-outline", "Aus anderen Apps")}${t("mail", "mdi:email-outline", "E-Mail")}${t("backup", "mdi:content-save-outline", "Sicherung")}</div>${body}`;
  }

  // 📧 Per E-Mail auf die Liste (über die IMAP-Integration von Home Assistant)
  _mailHtml() {
    const mail = this._data.settings?.mail_import;
    const store = mail?.store_id ? this._store(mail.store_id)?.name : null;
    if (!this._hass?.user?.is_admin) {
      return `<div class="syncbox"><p class="hint"><b>📧 Per E-Mail</b>: Eine Mail an das Einkaufs-Postfach – jede Zeile wird ein Artikel.</p>
        ${mail ? `<p><b>✅ An:</b> <span translate="no">${esc(mail.name)}</span></p>` : ""}
        <p class="hint">🔒 Einrichten oder ändern kann das nur ein Admin – es liest und löscht Mails in einem Postfach.</p></div>`;
    }
    return `
        <div class="syncbox">
        <p class="hint"><b>📧 Per E-Mail</b>: Eine Mail an dein Einkaufs-Postfach – jede Zeile wird ein Artikel. Dafür in Home Assistant die Integration „IMAP“ mit einer eigenen Mail-Adresse einrichten. Nur Mails von den <b>erlaubten Absendern</b> zählen.</p>
        <ul class="hint xferfmt">
          <li><b>Geschäft im Betreff</b> (z. B. „Aldi“ oder „Einkauf bei Aldi“) → alles aus der Mail kommt dorthin.</li>
          <li><b>Geschäft als Überschrift</b> in der Mail (z. B. „Aldi:“, darunter die Artikel, dann „DM:“ …) → gilt bis zur nächsten Überschrift.</li>
          <li>Sonst gilt das Geschäft unten. Mengen wie „6 Eier“ oder „2 L Milch“ werden erkannt.</li>
          <li>Als gelesen markiert oder gelöscht werden nur Mails, aus denen wirklich etwas auf die Liste kam.</li>
        </ul>
        ${mail ? `<p><b>✅ An:</b> <span translate="no">${esc(mail.name)}</span> → ${store ? `<span translate="no">${esc(store)}</span>` : "<span>Egal wo</span>"}${mail.count ? `<span> · schon ${mail.count}× eingetragen</span>` : ""}${mail.ok === false ? `<br><span>⚠️ Das Postfach gibt es nicht mehr – bitte neu wählen.</span>` : ""}</p>` : ""}
        <div class="srow"><ha-icon class="prev" icon="mdi:email-outline"></ha-icon><select class="grow" id="mailSrc"><option value="">Lade Postfächer …</option></select></div>
        <div class="srow"><ha-icon class="prev" icon="mdi:store-outline"></ha-icon><select class="grow" id="mailStore">${this._selectOptions(this._data.stores, mail?.store_id || null, "🛒 Egal wo")}</select></div>
        <div class="srow"><ha-icon class="prev" icon="mdi:email-sync-outline"></ha-icon><select class="grow" id="mailAfter" title="Was danach mit der Mail passiert">
          ${[["keep", "📬 Mail danach liegen lassen"], ["seen", "👁️ Mail danach als gelesen markieren"], ["delete", "🗑️ Mail danach löschen"]]
            .map(([v, l]) => `<option value="${v}" ${(mail?.after || "keep") === v ? "selected" : ""}>${l}</option>`).join("")}
        </select></div>
        <div class="srow"><ha-icon class="prev" icon="mdi:account-check-outline"></ha-icon><input class="grow" id="mailSenders" value="${esc((mail?.senders || []).join(", "))}" placeholder="Erlaubte Absender, z. B. ich@mail.de, oma@mail.de" translate="no"></div>
        <div class="btnrow"><button class="btn primary" data-act="mail-on"><ha-icon icon="mdi:email-check-outline"></ha-icon>${mail ? "Ändern" : "Einschalten"}</button>${mail ? `<button class="btn" data-act="mail-off"><ha-icon icon="mdi:email-off-outline"></ha-icon>Ausschalten</button>` : ""}</div>
        </div>`;
  }

  async _loadMailSources() {
    if (!this._hass?.user?.is_admin) return; // 🔒 nur für Admins
    let list = [];
    try { list = await this._ws({ type: "einkaufsliste/mail/sources" }); } catch (_) { /* Meldung kam schon */ }
    const sel = this.$("mailSrc");
    if (!sel) return;
    const cur = this._data.settings?.mail_import?.entry_id;
    sel.innerHTML = list?.length
      ? (cur ? "" : `<option value="">📧 Welches Postfach?</option>`) + list.map((x) => `<option value="${esc(x.entry_id)}" ${x.entry_id === cur ? "selected" : ""}>${esc(x.name)}</option>`).join("")
      : `<option value="">Noch kein IMAP-Postfach in Home Assistant eingerichtet</option>`;
  }

  _xferResult(html) {
    const el = this.$("xferRes");
    if (el) el.innerHTML = html;
  }

  async _loadTodoLists() {
    let lists = [];
    try { lists = await this._ws({ type: "einkaufsliste/import/todo_lists" }); } catch (_) { /* Meldung kam schon */ }
    lists = lists?.lists || lists || [];
    const cur = this._data.settings?.todo_sync?.entity_id;
    for (const id of ["xferTodo", "syncTodo"]) {
      const sel = this.$(id);
      if (!sel) continue;
      sel.innerHTML = lists.length
        ? (id === "syncTodo" && !cur ? `<option value="">🔁 Welche Liste?</option>` : "")
          + lists.map((l) => `<option value="${esc(l.entity_id)}" ${id === "syncTodo" && l.entity_id === cur ? "selected" : ""}>${esc(l.name)}${l.open != null ? ` · ${l.open}` : ""}</option>`).join("")
        : `<option value="">Keine andere Liste in Home Assistant gefunden</option>`;
    }
  }

  _xferStore(id) {
    const v = this.$(id)?.value;
    return v && v !== "~none" ? v : null;
  }

  _xferImported(res) {
    const n = res?.added || 0;
    this._toast(n ? `📥 ${n} Artikel auf die Liste gesetzt` : "Nichts Neues gefunden 🤷");
    this._xferResult(`<p class="hint">✅ ${n} übernommen${res?.skipped ? `, ${res.skipped} übersprungen (schon abgehakt oder leer)` : ""}.</p>`);
  }

  async _xferBackup() {
    try {
      const r = await this._hass.fetchWithAuth("/api/einkaufsliste/sicherung");
      if (!r.ok) throw new Error(r.status === 401 || r.status === 403 ? "Nur für Admins 🔒" : `Fehler ${r.status}`);
      const blob = await r.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `einkaufsliste-sicherung-${new Date().toISOString().slice(0, 10)}.zip`;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
      this._toast("💾 Sicherung heruntergeladen");
    } catch (err) {
      this._toast(err?.message || "Sicherung ging nicht 🙈");
    }
  }

  async _xferRestore(file) {
    if (!elConfirm(`„${file.name}“ einspielen?\n\nDas ersetzt ALLES, was jetzt da ist (Liste, Rezepte, Produkte, Fotos …).`)) return;
    this._xferResult(`<p class="hint">⏳ Spiele ein …</p>`);
    try {
      const r = await this._hass.fetchWithAuth("/api/einkaufsliste/sicherung", { method: "POST", body: file, headers: { "Content-Type": "application/zip" } });
      const res = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(res.error || `Fehler ${r.status}`);
      this._toast("♻️ Sicherung eingespielt");
      this._xferResult(`<p class="hint">✅ Fertig: ${res.items} Artikel, ${res.recipes} Rezepte, ${res.photos} Fotos (Sicherung von Version ${esc(res.version || "?")}).</p>`);
    } catch (err) {
      this._toast(err?.message || "Einspielen ging nicht 🙈");
      this._xferResult(`<p class="hint">❌ ${esc(err?.message || "Einspielen ging nicht")}</p>`);
    }
  }

  async _xferRecipeFile(file) {
    const text = await file.text();
    try {
      const res = await this._ws({ type: "einkaufsliste/recipe/import_file", text, filename: file.name });
      const n = res.added || 0;
      this._toast(n ? `👨‍🍳 ${n} ${n === 1 ? "Rezept" : "Rezepte"} eingelesen` : "Keine Rezepte in der Datei gefunden 🤔");
      this._xferResult(n
        ? `<p class="hint">✅ Eingelesen:</p><ul class="hint">${res.names.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`
        : `<p class="hint">🤔 Keine Rezepte gefunden. Passt der Aufbau (siehe oben)?</p>`);
    } catch (_) { /* Meldung kam schon */ }
  }

  // 🚦 Daten-Gesundheit: Ampel oben in den Einstellungen (prüft im Hintergrund, repariert nichts)
  async _loadHealth(force) {
    if (this._healthBusy) return;
    if (!force && this._health && Date.now() - this._health.at < 5 * 60 * 1000) { this._paintHealth(); return; }
    this._healthBusy = true;
    try {
      const res = await this._hass.callWS({ type: "einkaufsliste/check", fix: false });
      this._health = { at: Date.now(), n: (res.items || []).length };
    } catch (_) {
      this._health = { at: Date.now(), n: -1 };
    }
    this._healthBusy = false;
    this._paintHealth();
  }

  _paintHealth() {
    const box = this.$("healthBar");
    if (!box || !this._health) return;
    const n = this._health.n;
    const recent = this._data?.settings?.errors_24h || 0;
    let cls = "ok", icon = "🟢", title = "Alles in Ordnung", sub = "Keine kaputten Einträge gefunden.", sec = "check";
    if (n < 0) { cls = "wait"; icon = "⚪"; title = "Konnte nicht prüfen"; sub = "Tippen, um es noch einmal zu versuchen."; }
    else if (n > 5) { cls = "bad"; icon = "🔴"; title = `${n} Sachen brauchen einen Blick`; sub = "Tippen – dort kannst du alles reparieren."; }
    else if (n > 0) { cls = "warn"; icon = "🟡"; title = n === 1 ? "1 kleine Sache gefunden" : `${n} kleine Sachen gefunden`; sub = "Tippen – dort kannst du es reparieren."; }
    else if (recent) { cls = "warn"; icon = "🟡"; title = recent === 1 ? "1 Fehlermeldung in den letzten 24 Stunden" : `${recent} Fehlermeldungen in den letzten 24 Stunden`; sub = "Tippen, um sie zu lesen."; sec = "errors"; }
    box.className = `health ${cls}`;
    box.dataset.sec = sec;
    box.innerHTML = `<span style="font-size:1.4em">${icon}</span><span><b>${title}</b><small>${sub}</small></span>`;
  }

  // 🐞 Fehler-Protokoll: technische Fehler lesen und kopieren
  _errorsHtml() {
    return `
      <p class="hint">Hier landet, was technisch schiefgegangen ist (z. B. Foto-Upload, E-Mail-Import, Nachschicken). Bei einem Problem: auf „Kopieren“ tippen und den Text weitergeben – dann lässt sich der Fehler viel schneller finden.</p>
      <div class="btnrow"><button class="btn primary" data-act="errors-copy"><ha-icon icon="mdi:content-copy"></ha-icon>Kopieren</button><button class="btn" data-act="errors-clear"><ha-icon icon="mdi:delete-sweep-outline"></ha-icon>Leeren</button></div>
      <div id="errBox"><p class="hint">Lade …</p></div>
      <p class="hint">Bitte vor dem Weitergeben kurz lesen – in den Texten können Artikelnamen stehen.</p>`;
  }

  async _loadErrors() {
    try {
      this._errData = await this._ws({ type: "einkaufsliste/errors/get" });
    } catch (_) { return; }
    const box = this.$("errBox");
    if (!box || this._setSec !== "errors") return;
    const list = this._errData.errors || [];
    box.innerHTML = list.length
      ? list.map((e) => `<div class="errrow"><small>${esc(new Date(e.t).toLocaleString())} · <span translate="no">${esc(e.w)}</span>${e.n > 1 ? ` · ${e.n}×` : ""}</small><span translate="no">${esc(e.m)}</span></div>`).join("")
      : `<p>✅ <b>Keine Fehler.</b> Alles läuft rund. 🎉</p>`;
  }

  _errorsText() {
    const d = this._errData || {};
    const lines = (d.errors || []).map((e) => `${new Date(e.t).toLocaleString()} [${e.w}]${e.n > 1 ? ` (${e.n}x)` : ""} ${e.m}`);
    return `Einkaufsliste v${d.version || EL_VERSION} (Karte v${EL_VERSION})\n${lines.length ? lines.join("\n") : "keine Fehler"}`;
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
      ${this._data.settings?.spend ? `<div class="btnrow"><button class="btn" data-act="spend"><ha-icon icon="mdi:receipt-text-outline"></ha-icon>🧾 Einkaufs-Protokoll öffnen</button></div>` : ""}
      <div id="logMissed"></div>
      <div id="logList"><p class="hint">Lade Verlauf …</p></div>
      <div class="srow" style="margin-top:12px">
        <ha-icon class="prev" icon="mdi:calendar-clock"></ha-icon>
        <span class="grow hint">Aufheben für</span>
        <select id="logDays" style="width:auto">${[7, 30, 90, 180, 365].map((n) => `<option value="${n}" ${n === days ? "selected" : ""}>${n} Tage</option>`).join("")}</select>
      </div>
      <div class="btnrow"><button class="btn" data-act="log-clear"><ha-icon icon="mdi:delete-sweep-outline"></ha-icon>Verlauf leeren</button></div>
      <p class="hint">Zeichen: ✍️ in der Karte · ▥ gescannt · 🍳 Rezept · 🔗 zusammengelegt · 🧹 automatisch aufgeräumt · 🔁 von einer anderen Liste geholt · 📧 per E-Mail · 🤖 Automation/Dienst</p>`;
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

  // 📈 Vergessen-Statistik: was gab's öfter nicht? („Butter 3× war aus bei Aldi – vielleicht woanders kaufen?“)
  _renderMissed() {
    const box = this.$("logMissed");
    if (!box || !this._logData) return;
    const count = new Map();
    const hidden = this._data?.missed_hidden || {};
    const byName = new Map(this._data.stores.map((st) => [st.name.trim().toLowerCase(), st]));
    for (const e of this._logData.entries) {
      if (!e.n || (e.a !== "out" && e.a !== "move")) continue;
      // ⇄ aus „Egal wo“ ist nur ein Umzug – das war nicht „nicht bekommen“
      const st = e.a === "out" ? this._store(e.s) : byName.get(String(e.d || "").split(" → ")[0].trim().toLowerCase());
      if (!st) continue;
      const key = e.n.toLowerCase() + "|" + st.id;
      if ((e.t || "") <= (hidden[key] || "")) continue; // ✖ weggeklickt: zählt ab da neu
      const c = count.get(key) || { name: e.n, st, n: 0 };
      c.n += 1;
      count.set(key, c);
    }
    const top = [...count.values()].filter((c) => c.n >= 2).sort((a, b) => b.n - a.n).slice(0, 5);
    box.innerHTML = top.length ? `<div class="missed"><b>📈 Oft nicht bekommen</b>${top.map((c) =>
      `<div class="mrow"><span class="mtxt"><span class="mn">${c.n}×</span> <b translate="no">${esc(c.name)}</b> <span>bei</span> <span translate="no">${esc(c.st.name)}</span> <span>– vielleicht woanders kaufen?</span></span><button type="button" class="iconbtn mx" data-act="missed-hide" data-name="${esc(c.name)}" data-store="${esc(c.st.id)}" title="Ausblenden – hab ich geregelt"><ha-icon icon="mdi:close"></ha-icon></button></div>`).join("")}</div>` : "";
  }

  _renderLogList() {
    const box = this.$("logList");
    if (!box || !this._logData) return;
    this._renderMissed();
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

  // 🔽 Filter im Katalog
  _prodFilterOptions() {
    const d = this._data, f = this._prodSel || "";
    const opt = (v, l) => `<option value="${esc(v)}" ${v === f ? "selected" : ""}>${l}</option>`;
    return opt("", "🔽 Alle Produkte") + opt("~nocat", "📦 Ohne Kategorie") + opt("~nostore", "🛒 Ohne Geschäft")
      + opt("~open", "🛍️ Steht auf der Liste") + opt("~photo", "📷 Mit Foto") + opt("~nophoto", "📷 Ohne Foto")
      + opt("~barcode", "▥ Mit Barcode") + opt("~nobarcode", "▥ Ohne Barcode") + opt("~old3m", "🗓️ Seit 3 Monaten nicht gekauft")
      + `<optgroup label="Geschäft">${d.stores.map((st) => opt(`s:${st.id}`, `🏪 ${esc(st.name)}`)).join("")}</optgroup>`
      + `<optgroup label="Kategorie">${d.categories.map((c) => opt(`c:${c.id}`, `🏷️ ${esc(c.name)}`)).join("")}</optgroup>`;
  }

  // 🗓️ Wann wurde das Produkt zuletzt gekauft? Zuletzt abgehakt, sonst zuletzt eingetragen
  _prodLast(p) {
    return p.last_bought || p.last_added || p.last_used || "";
  }

  _prodOld(p) {
    if (p.open || p.in_recipes) return false; // steht gerade auf der Liste oder in einem Rezept
    const last = this._prodLast(p);
    if (!last) return true; // nie gekauft, nie eingetragen
    const limit = new Date(); limit.setMonth(limit.getMonth() - 3);
    return new Date(last) < limit;
  }

  _prodAgo(p) {
    const last = this._prodLast(p);
    if (!last) return "noch nie";
    const days = Math.floor((Date.now() - new Date(last).getTime()) / 86400000);
    if (days < 60) return `vor ${days} Tagen`;
    return `vor ${Math.floor(days / 30)} Monaten`;
  }

  _prodFilterFn() {
    const f = this._prodSel || "";
    if (!f) return () => true;
    if (f.startsWith("s:")) { const id = f.slice(2); return (p) => p.store_id === id || (p.stores || []).includes(id); }
    if (f.startsWith("c:")) { const id = f.slice(2); return (p) => p.category_id === id; }
    return {
      "~nocat": (p) => !this._cat(p.category_id), "~nostore": (p) => !this._store(p.store_id), "~open": (p) => !!p.open,
      "~old3m": (p) => this._prodOld(p),
      "~photo": (p) => !!p.photos, "~nophoto": (p) => !p.photos, "~barcode": (p) => p.barcodes.length > 0, "~nobarcode": (p) => !p.barcodes.length,
    }[f] || (() => true);
  }

  // ⌨️ Katalog am PC: markieren, blättern, bearbeiten
  _prodMark(key, focus = true) {
    this._prodMarked = key;
    const box = this.$("prodList");
    if (!box) return;
    box.querySelectorAll(".prodrow").forEach((r) => r.classList.toggle("marked", r.dataset.key === key));
    const row = [...box.querySelectorAll(".prodrow")].find((r) => r.dataset.key === key);
    if (row && focus) { row.focus({ preventScroll: true }); row.scrollIntoView({ block: "nearest" }); }
  }

  _prodKey(e) {
    const box = this.$("prodList");
    if (!box || !box.isConnected || this._view !== "settings") return false;
    if (e.key === "Escape" && this._prodEdit) {
      const k = this._prodEdit;
      this._prodEdit = null;
      this._renderProducts();
      this._prodMark(k);
      return true;
    }
    const inRow = e.target?.classList?.contains("prodrow");
    if (!inRow && !(e.target === this.$("prodSearch") && e.key === "ArrowDown")) return false;
    const rows = [...box.querySelectorAll(".prodrow")];
    if (!rows.length) return false;
    const pos = rows.findIndex((r) => r.dataset.key === this._prodMarked);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const to = Math.max(0, Math.min(rows.length - 1, pos < 0 ? 0 : pos + (e.key === "ArrowDown" ? 1 : -1)));
      this._prodMark(rows[to].dataset.key);
      return true;
    }
    if (e.key === "Enter" && pos >= 0) {
      this._prodEdit = rows[pos].dataset.key;
      this._renderProducts();
      setTimeout(() => this.$("peName")?.focus(), 30);
      return true;
    }
    return false;
  }

  _renderProducts() {
    const box = this.$("prodList");
    if (!box || !this._products) return;
    const q = (this._prodFilter || "").trim().toLowerCase();
    const scannedTab = this._prodTab === "scanned";
    const ff = scannedTab ? () => true : this._prodFilterFn();
    let list = this._products.filter((p) => (!scannedTab || p.scanned) && ff(p) && (!q || `${p.name} ${p.note || ""}`.toLowerCase().includes(q)));
    if (scannedTab) list = list.sort((a, b) => String(b.scanned_at || "").localeCompare(String(a.scanned_at || "")));
    if (!list.length) { this._oldKeys = null; box.innerHTML = `<p class="hint">${q ? `Nichts gefunden zu „${esc(q)}“.` : this._prodSel === "~old3m" ? "Nichts Altes – alles wurde in den letzten 3 Monaten gekauft. 👍" : scannedTab ? "Alles geprüft – nichts Neues gescannt. 👍" : "Noch keine Produkte."}</p>`; return; }
    const shown = list.slice(0, 80);
    this._oldKeys = this._prodSel === "~old3m" && !scannedTab ? list.map((p) => p.key) : null;
    const bulk = this._oldKeys ? `<p class="hint">🗓️ Diese ${list.length} Produkte hast du seit 3 Monaten nicht gekauft (gezählt ab dem letzten Abhaken, sonst ab dem Eintragen; Produkte aus Rezepten fehlen hier). Antippen = ansehen oder ganz löschen – oder alle auf einmal:</p><div class="btnrow"><button class="btn danger" data-act="prod-old-del"><ha-icon icon="mdi:delete-sweep-outline"></ha-icon>Alle ${list.length} löschen</button></div>` : "";
    box.innerHTML = bulk + shown.map((p) => {
      const cat = this._cat(p.category_id), st = this._store(p.store_id);
      const bits = [
        st ? `<span class="chip" style="--c:${esc(st.color)}">${esc(st.name)}</span>` : "",
        cat ? `<span>${esc(cat.name)}</span>` : "",
        (p.aliases || []).length ? `<span title="Spitznamen">🏷️ ${esc(p.aliases.join(", "))}</span>` : "",
        p.barcodes.length ? `<span>▥ ${p.barcodes.length}</span>` : "",
        p.photos ? `<span>📷 ${p.photos}${p.photos >= 6 ? " (voll)" : ""}</span>` : "",
        p.open ? `<span>🛒 steht drauf</span>` : "",
        this._prodSel === "~old3m" ? `<span>🗓️ ${p.last_bought ? "zuletzt gekauft" : "zuletzt eingetragen"} ${this._prodAgo(p)}</span>` : "",
      ].filter(Boolean).join("");
      if (this._prodEdit === p.key) {
        return `<div class="prodedit" data-key="${esc(p.key)}">
          <input id="peName" value="${esc(p.name)}" placeholder="Name">
          <input id="peNote" value="${esc(p.note || "")}" placeholder="📝 Notiz / Sorte">
          <input id="peAliases" value="${esc((p.aliases || []).join(", "))}" data-orig="${esc((p.aliases || []).join(", "))}" placeholder="🏷️ Spitznamen, z. B. Tempos, Tempo (mit Komma)" title="Wer so etwas eintippt, landet bei diesem Produkt">
          <select id="peCat">${this._selectOptions(this._data.categories, p.category_id, "📦 Ohne Kategorie")}</select>
          <select id="peStore">${this._selectOptions(this._data.stores, p.store_id, "🛒 Kein Standard-Geschäft")}</select>
          ${this._data.stores.length > 1 ? `<div class="pestores" title="In welchen Geschäften gibt es das? Lernt sich beim Abhaken auch von selbst.">🏪 Gibt's bei: ${this._data.stores.map((st) =>
            `<label class="stck" style="--c:${esc(st.color || "#888")}"><input type="checkbox" class="pestore" value="${esc(st.id)}" ${(p.stores || []).includes(st.id) || st.id === p.store_id ? "checked" : ""}>${esc(st.name)}</label>`).join("")}</div>` : ""}
          ${(() => { const t = Object.entries(this._data.typos || {}).filter(([, r]) => r.toLowerCase() === p.name.toLowerCase()).map(([w]) => w);
            return t.length ? `<div class="bclist" title="Diese Tippfehler korrigiert die Liste von selbst">${t.map((w) => `<span class="bcchip">🧠 ${esc(w)}<button type="button" class="iconbtn" data-act="typo-forget" data-w="${esc(w)}" title="Vergessen"><ha-icon icon="mdi:close"></ha-icon></button></span>`).join("")}</div>` : ""; })()}
          ${p.barcodes.length ? `<div class="bclist">${p.barcodes.map((code) => `<span class="bcchip">▥ ${esc(code)}<button type="button" class="iconbtn" data-act="bc-remove" data-code="${esc(code)}" title="Diesen Barcode löschen"><ha-icon icon="mdi:delete-outline"></ha-icon></button></span>`).join("")}</div>` : ""}
          ${this._prodMerge === p.key ? `<div class="pemerge">
            <span class="hint" style="width:100%">🧲 „${esc(p.name)}${p.note ? ` · ${esc(p.note)}` : ""}“ geht in diesem Produkt auf – Artikel, Rezepte, Fotos und Barcodes ziehen mit um, der alte Name wird ein Spitzname:</span>
            <select id="peMerge">${this._products.filter((x) => x.key !== p.key).map((x) => `<option value="${esc(x.key)}">${esc(x.name)}${x.note ? ` · ${esc(x.note)}` : ""}</option>`).join("")}</select>
            <button class="btn primary" data-act="prod-merge-go"><ha-icon icon="mdi:call-merge"></ha-icon>Jetzt zusammenführen</button></div>` : ""}
          <div class="btnrow">
            ${p.photos ? `<button class="btn" data-act="prod-photos"><ha-icon icon="mdi:image-multiple-outline"></ha-icon>Fotos</button>` : ""}
            <button class="btn" data-act="prod-merge" title="Dieses Produkt in ein anderes aufgehen lassen (z. B. Tomaten → Tomate)"><ha-icon icon="mdi:call-merge"></ha-icon>Zusammenführen</button>
            <button class="btn danger" data-act="prod-forget" title="Produkt mit Fotos, Barcodes und Vorschlag löschen – auch von der Einkaufsliste"><ha-icon icon="mdi:delete-outline"></ha-icon>Ganz löschen</button>
            <span style="flex:1"></span>
            <button class="btn" data-act="prod-cancel">Abbrechen</button>
            <button class="btn primary" data-act="prod-save"><ha-icon icon="mdi:content-save-outline"></ha-icon>Speichern</button>
          </div>
        </div>`;
      }
      return `<div class="srow delrow prodrow ${this._prodMarked === p.key ? "marked" : ""}" tabindex="0" data-act="prod-edit" data-key="${esc(p.key)}">
        <div class="grow delname"><b>${esc(p.name)}${p.note ? ` · ${esc(p.note)}` : ""}</b><small class="pmeta">${p.scanned && !scannedTab ? "<span>📷 neu gescannt</span>" : ""}${bits || "–"}</small></div>
        ${scannedTab ? `<button class="btn primary" data-act="prod-confirm" data-key="${esc(p.key)}" title="Name stimmt">✔ Passt</button>` : `<ha-icon icon="mdi:chevron-right"></ha-icon>`}
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
      ov.innerHTML = `<div class="sec"><h3><ha-icon icon="mdi:chef-hat"></ha-icon>Rezepte<span style="flex:1"></span><button class="btn" data-act="gar" title="Gar-Zeiten"><ha-icon icon="mdi:timer-outline"></ha-icon>Gar-Zeiten</button></h3>${
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
      const sub = fuzzy ? "🤓 Meintest du das?"
        : via ? `🥕 enthält ${this._markHit(via, q)}`
        : ""; // nur bei der Suche: warum gefunden
      html.push(`
        <div class="recipe" data-id="${r.id}">
          <ha-icon icon="${esc(this._recipeIcon(r))}"></ha-icon>
          <div class="rname" lang="de"><b>${via || fuzzy ? esc(r.name) : this._markHit(r.name, q)}${this._servTag(r)}</b>${sub ? `<small>${sub}</small>` : ""}</div>
          <div class="rbtns">
            <button class="primary" data-act="recipe-apply" title="Zutaten auswählen"><ha-icon icon="mdi:cart-plus"></ha-icon>Auf die Liste</button>
            ${onList(r) ? `<button class="btn" data-act="recipe-unapply" title="Alle offenen Zutaten dieses Rezepts von der Liste nehmen"><ha-icon icon="mdi:cart-remove"></ha-icon>Von der Liste (${onList(r)})</button>` : ""}
          </div>
        </div>
        <div class="rtools" data-id="${r.id}">
          ${this._recipePhotoToolBtn(r)}
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
        <ha-icon icon="${esc(this._recipeIcon(r))}"></ha-icon>
        <div class="rname" lang="de"><b>${via || fuzzy ? esc(r.name) : this._markHit(r.name, q)}${this._servTag(r)}${this._recipePhotoBtn(r)}</b><small>${
          fuzzy ? "🤓 Meintest du das? · " : via ? `🥕 enthält ${this._markHit(via, q)} · ` : ""}${this._rgroup(r.group) ? esc(this._rgroup(r.group).name) + " · " : "ohne Gruppe · "}${r.items.length} Zutaten${r.steps ? " · 📖 Anleitung" : " · ohne Anleitung"}${(r.heat || []).length ? " · 🔥 Backofen & Co." : ""}</small></div>
        <button class="iconbtn" data-act="recipe-edit" title="Bearbeiten"><ha-icon icon="mdi:pencil-outline"></ha-icon></button>
      </div>`).join("");
  }

  // 🍳 Erst fragen: Welche Zutaten sollen auf die Liste?
  // 🛒 Wurde diese Zutat schon mal gekauft? Sonst gibt es kein „Wie zuletzt“-Geschäft.
  _pickNeedsStore(it) {
    if (it.store_id && this._store(it.store_id)) return false;
    const low = it.name.toLowerCase();
    const h = (this._data.history || []).find((x) => x.name.toLowerCase() === low);
    if (h?.store_id && this._store(h.store_id)) return false;
    return !this._data.items.some((i) => i.name.toLowerCase() === low && i.store_id && this._store(i.store_id));
  }

  _pickFactor(r) {
    return r.servings && this._pickPers ? this._pickPers / r.servings : 1;
  }

  _pickMissingStore(r) {
    return [...this._pickSel].some((n) => r.items[n] && this._pickNeedsStore(r.items[n]) && !(String(n) in this._pickStores));
  }

  _pickHtml(r) {
    const open = new Set(this._data.items.filter((i) => !i.checked).map((i) => i.name.toLowerCase()));
    const sel = this._pickSel;
    const f = this._pickFactor(r);
    const stores = this._data.stores || [];
    const rows = r.items.map((it, n) => {
      const on = sel.has(n);
      const qty = scaleQty(it.quantity, f);
      const info = [qty ? (qty !== (it.quantity || null) ? `<b class="pscaled">${esc(qty)}</b>` : esc(qty)) : "",
        it.note ? `<span class="inote">📝 ${esc(it.note)}</span>` : "", it.for_whom ? esc("für " + it.for_whom) : ""].filter(Boolean).join(" · ");
      const ask = on && stores.length && this._pickNeedsStore(it);
      const chosen = this._pickStores[String(n)];
      return `<div class="pickrow ${on ? "on" : ""} ${it.basic ? "basic" : ""}" data-act="pick-toggle" data-n="${n}">
        <ha-icon icon="${on ? "mdi:checkbox-marked" : "mdi:checkbox-blank-outline"}"></ha-icon>
        <span class="pname">${esc(it.name)}${info ? `<small>${info}</small>` : ""}</span>
        ${open.has(it.name.toLowerCase()) ? `<span class="phint">steht schon drauf</span>` : it.basic ? `<span class="pbasic">🧂 haben wir immer</span>` : ""}
      </div>${ask ? `<div class="pstore ${chosen === undefined ? "need" : ""}">
        <span>🛒 Noch nie gekauft – wo kaufen?</span>
        <select data-act="pick-store" data-n="${n}">
          <option value="__" ${chosen === undefined ? "selected" : ""} disabled>Bitte wählen …</option>
          ${stores.map((st) => `<option value="${esc(st.id)}" ${chosen === st.id ? "selected" : ""}>${esc(st.name)}</option>`).join("")}
          <option value="" ${chosen === "" ? "selected" : ""}>Egal wo</option>
        </select></div>` : ""}`;
    }).join("");
    const pers = r.servings ? `<div class="ppers">
        <span>${r.servings_unit === "trays" ? "🍕🍰 Wie viele Bleche?" : "👥 Für wie viele Personen?"}</span>
        <button class="iconbtn" data-act="pick-pers" data-d="-1" ${this._pickPers <= 1 ? "disabled" : ""} title="Weniger"><ha-icon icon="mdi:minus"></ha-icon></button>
        <b>${this._pickPers}</b>
        <button class="iconbtn" data-act="pick-pers" data-d="1" ${this._pickPers >= 99 ? "disabled" : ""} title="Mehr"><ha-icon icon="mdi:plus"></ha-icon></button>
        <small>${this._pickPers === r.servings ? "wie im Rezept" : `Rezept ist für ${r.servings} ${servLabel(r.servings_unit, r.servings)} – Mengen umgerechnet`}</small>
      </div>` : "";
    const missing = this._pickMissingStore(r);
    return `<div class="rpick" data-id="${r.id}">
      ${pers}
      <div class="phead">Was davon brauchst du?<span>
        <button class="linkbtn" data-act="pick-all">Alle</button> · <button class="linkbtn" data-act="pick-none">Keine</button></span></div>
      ${rows}
      <div class="pbtns">
        <button class="btn" data-act="pick-cancel">Abbrechen</button>
        <button class="primary addbtn" data-act="pick-go" ${sel.size && !missing ? "" : "disabled"}><ha-icon icon="mdi:check-bold"></ha-icon>${sel.size} auf die Liste</button>
      </div>
      ${missing ? `<p class="hint pmiss">🛒 Bitte erst bei allen neuen Zutaten das Geschäft wählen.</p>` : ""}
    </div>`;
  }

  _openRecipe(recipe) {
    this._draft = recipe
      ? { id: recipe.id, name: recipe.name, group: recipe.group || null, steps: recipe.steps || "", servings: recipe.servings || null, servings_unit: recipe.servings_unit || "persons", heat: (recipe.heat || []).map((h) => ({ ...h })), items: abcSort(recipe.items.map((i) => ({ ...i }))) }
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
          <ha-icon class="prev" id="rIconPrev" icon="${esc(this._recipeIcon(dr))}"></ha-icon>
          <input class="grow" id="rName" value="${esc(dr.name)}" placeholder="Name, z. B. Freitags Fisch">
        </div>
        <div class="srow rgrouprow">
          <ha-icon class="prev" icon="mdi:tag-outline"></ha-icon>
          <span class="grow">🏷️ Gruppe</span>
          <small id="rGroupHint" class="hint" hidden>✨ vorgeschlagen</small>
          <select id="rGroup">
            <option value="">– keine –</option>
            ${(this._data.recipe_groups || []).map((g) => `<option value="${esc(g.id)}" ${dr.group === g.id ? "selected" : ""}>${esc(g.name)}</option>`).join("")}
          </select>
        </div>
        <div class="picker" hidden></div>
        <div class="srow rserv">
          <ha-icon class="prev" icon="${dr.servings_unit === "trays" ? "mdi:tray" : "mdi:account-group-outline"}"></ha-icon>
          <span class="grow">Die Mengen sind für</span>
          <input id="rServings" type="number" inputmode="numeric" min="1" max="99" value="${dr.servings || ""}" placeholder="?">
          <select id="rServUnit">
            <option value="persons" ${dr.servings_unit !== "trays" ? "selected" : ""}>👥 Personen</option>
            <option value="trays" ${dr.servings_unit === "trays" ? "selected" : ""}>🍕🍰 Bleche</option>
          </select>
        </div>
        <div class="photorow" id="rPhotoRow"></div>
        <h3 class="rsub"><ha-icon icon="mdi:food-apple-outline"></ha-icon>Zutaten
          <button class="btn rimportbtn" data-act="rimport-toggle"><ha-icon icon="mdi:clipboard-text-outline"></ha-icon>Rezept einfügen</button></h3>
        <div class="rimport" id="rImport" hidden>
          <textarea id="rImportText" rows="6" placeholder="Zutaten-Liste hier einfügen – eine Zutat pro Zeile, z. B.&#10;200 g Mehl&#10;3 Eier&#10;½ l Milch&#10;&#10;…oder einfach einen Rezept-Link (z. B. von Chefkoch)."></textarea>
          <div class="btnrow"><button class="btn" data-act="rimport-photo"><ha-icon icon="mdi:camera-outline"></ha-icon>📷 Aus Foto</button><button class="btn" data-act="rimport-toggle">Abbrechen</button><button class="primary addbtn btn" data-act="rimport-go"><ha-icon icon="mdi:check-bold"></ha-icon>Übernehmen</button></div>
        </div>
        <div class="redithint" id="rEditHint" hidden>✏️ Du bearbeitest eine Zutat – ✔ speichert sie. <button class="linkbtn" data-act="ritem-edit-cancel">Abbrechen</button></div>
        <div id="rFormSlot"></div>
        <div id="rItems"></div>
        <h3 class="rsub"><ha-icon icon="mdi:stove"></ha-icon>Backofen &amp; Co.</h3>
        <div id="rHeat"></div>
        <div class="btnrow"><button class="btn" data-act="heat-add"><ha-icon icon="mdi:plus"></ha-icon>Einstellung (Grad, Minuten …)</button></div>
        <h3 class="rsub"><ha-icon icon="mdi:chef-hat"></ha-icon>Zubereitung</h3>
        <textarea id="rSteps" class="rsteps" rows="5" placeholder="Ein Schritt pro Zeile, z. B.&#10;Nudeln 10 Minuten kochen&#10;Soße anrühren">${esc(dr.steps || "")}</textarea>
        <div id="rStepPhotos"></div>
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
    this._renderStepPhotos();
    this.$("rSteps")?.addEventListener("input", () => { clearTimeout(this._spT); this._spT = setTimeout(() => this._renderStepPhotos(), 400); });
    this._groupAuto = !dr.group; // ohne Gruppe: aus dem Namen vorschlagen
    this._autoGroup();
  }

  // 📷 Foto vom Rezept (fertiges Gericht, Kochbuch-Seite …)
  _recipePhotoKey(id) { return `rezept#${id}`.toLowerCase(); }

  // 📷 Fotos je Kochschritt: Schritt n (0 = erster) – gezählt wie im Koch-Modus (eine Zeile = ein Schritt)
  _stepPhotoKey(id, n) { return `rezept#${id}#s${n}`.toLowerCase(); }
  _stepLines(text) { return String(text || "").split(/\n+/).map((x) => x.trim()).filter(Boolean); }

  _renderStepPhotos() {
    const box = this.$("rStepPhotos");
    const dr = this._draft;
    if (!box || !dr) return;
    const lines = this._stepLines(this.$("rSteps")?.value);
    if (!lines.length) { box.innerHTML = ""; return; }
    if (!dr.id) { box.innerHTML = `<p class="hint">📷 Fotos zu einzelnen Schritten gehen, sobald das Rezept einmal gespeichert ist.</p>`; return; }
    box.innerHTML = `<p class="hint">📷 Fotos zu den Schritten (erscheinen im Koch-Modus):</p>` + lines.map((t, n) => {
      const key = this._stepPhotoKey(dr.id, n);
      const has = this._hasPhoto(key);
      const cnt = this._photoCount(key);
      return `<div class="sprow"><span class="sptxt" translate="no">${n + 1}. ${esc(t.length > 60 ? t.slice(0, 60) + "…" : t)}</span>
        ${has ? `<button type="button" class="btn" data-act="sphoto-view" data-n="${n}"><ha-icon icon="mdi:image-outline"></ha-icon>${cnt}</button>` : ""}
        <button type="button" class="btn" data-act="sphoto-take" data-n="${n}" ${cnt >= 6 ? "disabled" : ""}><ha-icon icon="mdi:camera-plus-outline"></ha-icon>${has ? "Dazu" : "Foto"}</button></div>`;
    }).join("") + `<p class="hint">Die Fotos hängen an der Schrittnummer – ändert sich die Reihenfolge, bitte kurz prüfen.</p>`;
  }

  _recipePhotoBtn(r) {
    const key = this._recipePhotoKey(r.id);
    return this._hasPhoto(key)
      ? ` <button class="photobtn" data-act="photo-view" data-name="${esc(key)}" data-title="${esc(r.name)}" title="Rezept-Fotos ansehen"><ha-icon icon="mdi:camera"></ha-icon>${this._data.photo_counts?.[key] > 1 ? `<small class="pcount">${this._data.photo_counts[key]}</small>` : ""}</button>` : "";
  }

  // 🏷️ Rezept-Gruppe und Icon (das Icon kommt immer von der Gruppe)
  _rgroup(id) { return (this._data?.recipe_groups || []).find((g) => g.id === id) || null; }

  _recipeIcon(r) { return this._rgroup(r?.group)?.icon || "mdi:silverware-fork-knife"; }

  // „Pizza – 1 Blech“ / „Lasagne – 4 Personen“ hinter dem Rezeptnamen
  _servTag(r) {
    return r.servings ? `<span class="servtag"> – ${r.servings} ${servLabel(r.servings_unit, r.servings)}</span>` : "";
  }

  _recipeSavedPhotos() {
    const dr = this._draft;
    if (!dr?.id) return 0;
    const key = this._recipePhotoKey(dr.id);
    return this._data?.photo_counts?.[key] || (this._hasPhoto(key) ? 1 : 0);
  }

  // 📷 Foto-Knopf in der Knopf-Reihe (neben „Kochen“), mit Anzahl bei mehreren Fotos
  _recipePhotoToolBtn(r) {
    const key = this._recipePhotoKey(r.id);
    if (!this._hasPhoto(key)) return "";
    const n = this._data.photo_counts?.[key] || 1;
    return `<button class="btn" data-act="photo-view" data-name="${esc(key)}" data-title="${esc(r.name)}" title="Rezept-Fotos ansehen"><ha-icon icon="mdi:camera"></ha-icon>${n > 1 ? n : ""}</button>`;
  }

  _renderRecipePhoto() {
    const box = this.$("rPhotoRow");
    const dr = this._draft;
    if (!box || !dr) return;
    const saved = this._recipeSavedPhotos();
    const fresh = (dr.newPhotos || []).length;
    const total = saved + fresh;
    box.innerHTML = `
      <button type="button" class="btn ${total ? "on" : ""}" data-act="rphoto-take" ${total >= 6 ? "disabled" : ""}><ha-icon icon="mdi:camera-plus-outline"></ha-icon>${total ? "Foto dazu" : "Rezept-Foto"}</button>
      ${saved ? `<button type="button" class="btn" data-act="rphoto-view"><ha-icon icon="mdi:image-multiple-outline"></ha-icon>Ansehen (${saved})</button>` : ""}
      ${fresh ? `<button type="button" class="btn" data-act="rphoto-view-new"><ha-icon icon="mdi:image-outline"></ha-icon>${fresh} neu</button>
      <button type="button" class="btn danger" data-act="rphoto-remove"><ha-icon icon="mdi:image-remove-outline"></ha-icon>Neue verwerfen</button>` : ""}
      ${total ? `<span class="hint">${total} / 6 Fotos${fresh ? " · neue werden beim Speichern gespeichert" : ""}${saved ? " · löschen geht beim Ansehen" : ""}</span>` : ""}`;
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
      abcSort(dr.items);
      const nameEl = this.$("rName");
      if (res.name && !nameEl.value.trim()) { nameEl.value = res.name; this._autoGroup(); }
      const stepsEl = this.$("rSteps");
      if (res.steps && stepsEl && !stepsEl.value.trim()) stepsEl.value = res.steps;
      const hasPhoto = (dr.newPhotos || []).length || this._recipeSavedPhotos();
      if (res.image && !hasPhoto) dr.newPhotos = [res.image];
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
    const none = this.$("inStore").querySelector('option[value="~none"]');
    if (none) none.hidden = true;
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
    this.$("inName").placeholder = "Was brauchen wir/du?";
    const none = this.$("inStore").querySelector('option[value="~none"]');
    if (none) none.hidden = false;
    this.$("inStore").options[0].textContent = "🛒 Welches Geschäft?";
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
        it.note ? `<span class="inote">📝 ${esc(it.note)}</span>` : "",
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
    let bare = isBareQty(qty);
    if (!qty) { const sp = splitQty(raw); raw = sp.name; qty = sp.qty; bare = !!sp.bare; } // „250g nudeln“ -> Nudeln · 250 g
    // 📏 Nur eine Zahl („200 milch“)? Selbst gewählte Einheit, sonst die aus deinen Rezepten (Milch -> ml)
    const unit = this._qtyUnit && (bare || unitOf(qty) === "x") ? this._qtyUnit : bare ? this._recipeUnit(raw) : null;
    if (qty && unit) qty = applyUnit(qty, unit);
    const name = raw.charAt(0).toUpperCase() + raw.slice(1);
    const ing = {
      name,
      quantity: normQty(qty),
      note: val("inNote") ? val("inNote").charAt(0).toUpperCase() + val("inNote").slice(1) : null,
      for_whom: this.$("inFor").value || null,
      store_id: this._inStore(),
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
    abcSort(dr.items);
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
    if (this.$("rGroup")) dr.group = this.$("rGroup").value || null;
    if (this.$("rSteps")) dr.steps = this.$("rSteps").value;
    if (this.$("rServings")) { const n = parseInt(this.$("rServings").value, 10); dr.servings = n >= 1 && n <= 99 ? n : null; }
    if (this.$("rServUnit")) dr.servings_unit = this.$("rServUnit").value === "trays" ? "trays" : "persons";
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
    if (this.$("inName").value.trim() && !elConfirm("Oben steht noch eine Zutat, die nicht mit ✔ übernommen wurde. Trotzdem speichern?")) return;
    const heat = (dr.heat || []).filter((h) => h.mode || h.temp || h.minutes || h.note)
      .map((h) => ({ device: h.device || "Backofen", mode: h.mode || null, temp: h.temp ? Number(h.temp) : null,
        minutes: h.minutes ? Number(h.minutes) : null, minutes_to: h.minutes_to ? Number(h.minutes_to) : null, preheat: !!h.preheat, note: h.note || null }));
    const msg = { name: dr.name.trim(), group: dr.group || null, items, steps: (dr.steps || "").trim() || null, heat, servings: dr.servings || null, servings_unit: dr.servings_unit || "persons" };
    if (!msg.name) { this.$("rName").classList.add("shake"); return; }
    try {
      const saved = dr.id
        ? await this._ws({ type: "einkaufsliste/recipe/update", recipe_id: dr.id, ...msg })
        : await this._ws({ type: "einkaufsliste/recipe/add", ...msg });
      const rid = saved?.id || dr.id;
      if (rid && (dr.newPhotos || []).length) {
        const key = this._recipePhotoKey(rid);
        let add = this._hasPhoto(key);
        for (const data of dr.newPhotos) {
          await this._ws({ type: "einkaufsliste/photo/set", name: key, data, add }).catch(() => {});
          add = true;
        }
        for (const k of [...this._photoCache.keys()]) if (k.startsWith(key + "#")) this._photoCache.delete(k);
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

  // ✨ Neu: Artikel von jemand anderem, höchstens 24 Stunden alt – bleibt, bis du ihn abhakst oder das ✨ antippst
  // (egal wie oft du die Liste öffnest oder den Reiter wechselst). „Angetippt“ merkt sich Home Assistant – auf allen deinen Geräten.
  _newBase() {
    // Ab wann zählt etwas als neu? Beim ersten Mal auf diesem Gerät: ab dem letzten Blick (sonst ab jetzt) – nie rückwirkend
    const uid = this._hass?.user?.id || "x";
    const key = "einkaufsliste_new_base_" + uid;
    try {
      let v = localStorage.getItem(key);
      if (!v) {
        v = this._mySeen()?.all || new Date().toISOString();
        localStorage.setItem(key, v);
      }
      return v;
    } catch (_) { return this._mySeen()?.all || ""; }
  }

  _isNew(item) {
    if (item.checked || !this._data) return false;
    const me = this._hass?.user;
    if (item.added_by_id ? item.added_by_id === me?.id : item.added_by && item.added_by === this._myName()) return false;
    if (Date.now() - Date.parse(item.added_at || 0) > 864e5) return false;
    const seen = this._mySeen();
    if (!seen || !(item.added_at > this._newBase())) return false;
    return !seen["n:" + item.id] && !this._ackLocal?.has(item.id);
  }

  _ackNew(id) {
    (this._ackLocal ||= new Set()).add(id); // sofort weg – Home Assistant merkt es sich für alle Geräte
    this._ws({ type: "einkaufsliste/seen", store: "n:" + id }).catch(() => {});
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
    // 🤷 „Egal wo“ steht in jedem Geschäft mit drin – also dort auch gleich als gesehen merken
    if (tab !== "all" && tab !== "none") {
      const none = (i) => !i.store_id;
      if (this._data.items.some((i) => none(i) && this._isNewFor(i, seen))) sendSeen("none");
      if (this._newCount(none)) sendSeen("b:none");
    }
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

  // 📷 Foto holen: erst fragen woher (Kamera, Galerie, Einfügen), dann wie gewohnt weiter
  async _pickFile(id, heading) {
    const input = this.$(id);
    const browse = () => { input.removeAttribute("capture"); input.value = ""; input.click(); };
    if (elIsPc()) { // 🖥️ PC: Fenster zum Reinziehen / Strg + V / Auswählen
      const r = await askPhotoDrop(heading || undefined);
      if (r === "browse") browse();
      else if (r) this._photoFromFile(id, r);
      return;
    }
    // 📱 HA-App über http (zu Hause im WLAN): Kamera geht da nicht – also gleich die Galerie, ohne Menü
    const camera = window.isSecureContext || !elInHaApp(this._hass);
    if (!camera && !elCanPaste()) { browse(); return; }
    const how = await askPhotoSource(camera, heading || undefined);
    if (!how) return;
    if (how === "paste") {
      let file = null;
      try { file = await elClipboardImage(); } catch (_) { /* nicht erlaubt */ }
      if (!file) { this._toast("📋 In der Zwischenablage ist kein Bild (oder das Einfügen wurde nicht erlaubt)"); return; }
      this._photoFromFile(id, file);
      return;
    }
    if (how === "camera") {
      const file = await elCameraShot(); // 📷 eigene Kamera (geht nur über https)
      if (file) { this._photoFromFile(id, file); return; }
      if (file === null) return; // abgebrochen
      input.setAttribute("capture", "environment"); // sonst: das Handy fragen (HA-App: meist Galerie)
    } else input.removeAttribute("capture");
    input.value = "";
    input.click();
  }

  _photoFromFile(id, file) {
    const e = { target: { files: [file] } };
    if (id === "newPhotoFile") this._onNewPhotoFile(e);
    else this._onPhotoFile(e);
  }

  // ⌨️ Strg + V mit einem Bild: in der Liste = Foto fürs Eintragen, im Rezept-Editor = Rezept-Foto
  _onPaste(e) {
    if (document.querySelector("[data-elov]")) return; // ein Fenster (z. B. Foto hinzufügen) kümmert sich selbst
    const item = [...(e.clipboardData?.items || [])].find((i) => i.kind === "file" && i.type.startsWith("image/"));
    const file = item?.getAsFile();
    if (!file) return;
    if (this._view === "recipe" && this._draft) {
      e.preventDefault();
      this._photoTarget = { recipeDraft: true };
      this._photoFromFile("photoFile", file);
    } else if (this._view === "list" && !this.$("listView").hidden) {
      e.preventDefault();
      this._photoFromFile("newPhotoFile", file);
    }
  }

  // 🔎 „Text aus Foto“: Foto machen/wählen (mit Drehen & Zuschneiden) → Text lesen → weiter mit onText(text, foto)
  _ocrStart(title, onText, heading) {
    this._photoTarget = { ocr: async (data) => {
      const text = await this._ocrText(data, title);
      if (text != null) onText(text, data);
    } };
    this._pickFile("photoFile", heading);
  }

  async _ocrText(data, title) {
    const ov = makeOverlay();
    ov.innerHTML = `<div style="max-width:340px;width:100%;text-align:center"><div style="font:600 18px Roboto,sans-serif;margin-bottom:10px">${esc(elT(title))}</div>
      <div class="ocrstat" style="color:#ccc;margin-bottom:10px">${esc(elT("Einen Moment …"))}</div>
      <div style="background:#333;border-radius:8px;height:10px;overflow:hidden"><i class="ocrbar" style="display:block;height:100%;width:3%;background:#43a047"></i></div>
      <div style="color:#999;font-size:13px;margin-top:10px">${esc(elT("Das Foto bleibt auf deinem Gerät – die Texterkennung läuft direkt hier."))}</div></div>`;
    const stat = ov.querySelector(".ocrstat"), bar = ov.querySelector(".ocrbar");
    const names = { "loading tesseract core": "Texterkennung wird geladen …", "initializing tesseract": "Wird vorbereitet …", "initializing api": "Wird vorbereitet …",
      "loading language traineddata": "Sprache wird geladen …", "initializing": "Wird vorbereitet …", "recognizing text": "Text wird gelesen …" };
    try {
      return await elOcrRead(data, (m) => {
        if (!ov.isConnected) return;
        stat.textContent = elT(names[m.status] || "Einen Moment …") + (m.status === "recognizing text" ? ` ${Math.round((m.progress || 0) * 100)} %` : "");
        bar.style.width = `${Math.max(3, Math.round((m.progress || 0) * 100))}%`;
      });
    } catch (err) {
      this._toast("🔎 Die Texterkennung hat nicht geklappt 🙈");
      this._hass?.callWS?.({ type: "einkaufsliste/errors/report", where: "Karte: Text aus Foto", message: String(err?.message || err).slice(0, 380) }).catch(() => {});
      return null;
    } finally {
      ov.remove();
    }
  }

  // 🛒 Liste aus einem Foto (handgeschrieben oder gedruckt): Text prüfen, dann auf die Liste
  _ocrList() {
    this._ocrStart("🔎 Liste wird gelesen", (raw) => {
      const text = String(raw).split("\n").map((l) => l.replace(/^[\s\-–—•*·|_~=\\/\[\]()]+/, "").replace(/[|_~=\\]+/g, " ").trim())
        .filter((l) => /[A-Za-zÄÖÜäöüß0-9]/.test(l) && l.length >= 2).join("\n");
      const ov = makeOverlay();
      Object.assign(ov.style, { overflowY: "auto", justifyContent: "flex-start", touchAction: "pan-y" });
      const tab = this._activeTab;
      const cur = this._fixedStore || (tab !== "all" && tab !== "none" && this._store(tab) ? tab : "");
      ov.innerHTML = `<div style="max-width:460px;width:100%"><div style="font:600 19px Roboto,sans-serif;margin-bottom:6px">${esc(elT("🛒 Das habe ich gelesen"))}</div>
        <div style="color:#bbb;font-size:14px;margin-bottom:8px">${esc(elT("Eine Zeile = ein Artikel. Steht eine Zeile wie „Aldi“ oder „Aldi:“ davor, gehören die Artikel darunter zu diesem Geschäft. Bitte kurz prüfen und verbessern – Handschrift ist für die Texterkennung schwer."))}</div>
        <textarea rows="10" style="width:100%;box-sizing:border-box;font:16px Roboto,sans-serif;padding:10px;border-radius:10px;border:1px solid #555;background:#1e1e1e;color:#eee">${esc(text)}</textarea>
        <select style="width:100%;box-sizing:border-box;font:16px Roboto,sans-serif;padding:10px;border-radius:10px;border:1px solid #555;background:#1e1e1e;color:#eee;margin-top:8px">
          <option value="">${esc(elT("🤷 Egal wo"))}</option>${this._data.stores.map((st) => `<option value="${esc(st.id)}" ${st.id === cur ? "selected" : ""}>${esc(st.name)}</option>`).join("")}</select>
        <div class="abtn" style="display:flex;gap:10px;justify-content:flex-end;margin-top:14px"></div></div>`;
      const ta = ov.querySelector("textarea"), sel = ov.querySelector("select");
      const cancel = ovButton(elT("Abbrechen")), ok = ovButton(elT("➕ Auf die Liste"), true);
      cancel.onclick = () => ov.remove();
      ok.onclick = async () => {
        if (!ta.value.trim()) return;
        try {
          const res = await this._ws({ type: "einkaufsliste/import/text", text: ta.value, store_id: sel.value || null, by_store: true }); // 🏪 „Aldi:“ als Überschrift beachten
          this._toast(`✅ ${res.added} ${res.added === 1 ? "Artikel" : "Artikel"} eingetragen`);
          ov.remove();
        } catch (_) { /* Meldung kam schon */ }
      };
      ov.querySelector(".abtn").append(cancel, ok);
    }, "📋 Einkaufsliste abfotografieren");
  }

  // 🏷️ Überschrift im Foto-Menü – damit klar ist, WOFÜR das Foto ist
  _photoHeading(key, more = false) {
    const k = String(key || "");
    let m = k.match(/^rezept#.+#s(\d+)$/);
    if (m) return `🍳 Foto zu Schritt ${Number(m[1]) + 1}`;
    if (k.startsWith("rezept#")) return more ? "🍳 Weiteres Foto zum Rezept" : "🍳 Foto zum Rezept";
    if (k.startsWith("bon#")) return "🧾 Foto vom Kassenbon";
    return more ? "📷 Weiteres Foto zum Produkt" : "📷 Foto zum Produkt";
  }

  _takePhoto(name, button) {
    this._photoTarget = { name, button };
    this._pickFile("photoFile", this._photoHeading(name));
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
    this.$("inStore").value = tab === "none" ? "~none" : tab !== "all" ? tab : "";
    this._newPhoto = null;
    this._pendingBarcode = null;
    this._catManual = false;
    this._qtyUnit = null;
    this._unitMore = false;
    this._updateNewPhotoBtn();
    this._updateTools();
    this._renderList();
  }

  // 📏 Welche Einheit gilt gerade? Selbst gewählt > aus der eingetippten Menge > gemerkt beim Produkt > x
  // Name ohne Zahl davor/dahinter („200 milch“ -> „milch“)
  _typedName() {
    return (splitQty(this.$("inName")?.value || "").name || "").trim().toLowerCase();
  }

  // 🍳 Häufigste Einheit/Menge dieses Produkts in deinen Rezepten
  _recipeStats(name) {
    const low = String(name || "").trim().toLowerCase();
    const units = new Map(), qtys = new Map();
    if (low) for (const r of this._data?.recipes || []) for (const ri of r.items || []) {
      if (ri.name.toLowerCase() !== low || !ri.quantity) continue;
      qtys.set(ri.quantity, (qtys.get(ri.quantity) || 0) + 1);
      const u = unitOf(ri.quantity);
      if (u) units.set(u, (units.get(u) || 0) + 1);
    }
    const top = (m) => [...m].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    return { unit: top(units), qty: top(qtys) };
  }

  _recipeUnit(name) {
    return this._recipeStats(name).unit;
  }

  // 📏 Gemerkte Einheit: im Rezept-Editor aus deinen Rezepten, auf der Liste vom direkten Eintragen
  _learnedUnit() {
    const low = this._typedName();
    if (!low) return null;
    if (this._formMode === "recipe") return this._recipeUnit(low);
    const h = (this._data?.history || []).find((x) => x.name.toLowerCase() === low);
    return h?.unit && QTY_DEFS.some((d) => d[0] === h.unit) ? h.unit : null;
  }

  // 🔁 „wie zuletzt“: ganze Menge als Knopf (Rezept: häufigste aus deinen Rezepten, Liste: zuletzt selbst eingetragen)
  _lastQty() {
    const low = this._typedName();
    if (!low) return null;
    if (this._formMode === "recipe") return this._recipeStats(low).qty;
    const mine = (this._data?.items || [])
      .filter((i) => !i.recipe_id && i.quantity && i.name.toLowerCase() === low)
      .sort((a, b) => String(b.added_at || "").localeCompare(String(a.added_at || "")));
    if (mine[0]) return mine[0].quantity;
    return (this._data?.history || []).find((x) => x.name.toLowerCase() === low)?.qty || null;
  }

  _renderLastQty() {
    const box = this.$("lastQty");
    if (!box) return;
    const q = this._formMode === "recipe" ? this._lastQty() : null; // auf der Liste reicht der Vorschlag beim Tippen
    const typed = this.$("inQty").value.trim() || splitQty(this.$("inName").value).qty;
    if (!q || typed) { box.hidden = true; box.innerHTML = ""; return; }
    box.innerHTML = `<button type="button" class="chip2 lastq" data-act="last-qty" data-v="${esc(q)}">🔁 ${esc(q)} <small>${this._formMode === "recipe" ? "wie sonst" : "wie zuletzt"}</small></button>`;
    box.hidden = false;
  }

  _curUnit() {
    return this._qtyUnit || unitOf(this.$("inQty").value) || this._learnedUnit() || "x";
  }

  _renderQtyChips() {
    const val = normQty(this.$("inQty").value) || "";
    const unit = this._curUnit();
    const quick = (QTY_PRESETS[unit] || [1, 2, 3, 4, 6, 10]).map((n) => qtyFmt(String(n).replace(".", ","), unit));
    const custom = val && !quick.includes(val);
    this.$("qtyChips").innerHTML =
      quick.map((q) => `<button type="button" class="chip2 ${q === val ? "sel" : ""}" data-act="qty-chip" data-v="${esc(q)}">${esc(q)}</button>`).join("") +
      `<button type="button" class="chip2 ${custom ? "sel" : ""}" data-act="qty-custom" title="Andere Menge">✏️${custom ? " " + esc(val) : ""}</button>`;
    const uc = this.$("unitChips");
    uc.hidden = this._formMode !== "recipe"; // 📏 Einheiten-Reihe nur im Rezept-Editor
    if (uc.hidden) { uc.innerHTML = ""; this.$("inQty").hidden = !custom && this.$("inQty").hidden; return; }
    const more = this._unitMore || UNIT_MORE.includes(unit);
    const units = more ? [...UNIT_MAIN, ...UNIT_MORE] : UNIT_MAIN;
    this.$("unitChips").innerHTML = `<span class="ulabel">📏 Einheit:</span>` +
      units.map((u) => `<button type="button" class="chip2 ${u === unit ? "sel" : ""}" data-act="unit-chip" data-v="${esc(u)}">${esc(u)}</button>`).join("") +
      (more ? "" : `<button type="button" class="chip2" data-act="unit-more" title="Weitere Einheiten">mehr …</button>`);
    this.$("inQty").hidden = !custom && this.$("inQty").hidden;
  }

  _renderForChips() {
    const val = this.$("inFor").value;
    this.$("forChips").innerHTML = (this._data?.persons || [])
      .map((p) => `<button type="button" class="chip2 pchip ${p.name === val ? "sel" : ""}" style="--pc:${esc(p.color || "#9e9e9e")}" data-act="for-chip" data-v="${esc(p.name)}"><span class="pdot"></span>${esc(p.name)}</button>`)
      .join("");
  }

  _updateTools() {
    this._renderLastQty();
    this._renderNoteChips();
    const clear = this.$("tClear");
    if (clear) {
      const any = ["inName", "inQty", "inNote", "inFor"].some((id) => this.$(id)?.value.trim())
        || this._newPhoto || this._pendingBarcode || this._catManual
        || (!this._fixedStore && (this.$("inStore")?.value || "") !== this._defaultStore());
      clear.hidden = !any;
    }
    const nb = this.$("btnNewBarcode");
    if (nb) {
      nb.hidden = !this._hasAppScanner();
      nb.classList.toggle("on", !!this._pendingBarcode);
      nb.classList.toggle("filled", !!this._pendingBarcode);
      nb.title = this._pendingBarcode ? "Barcode ist dabei – antippen zum Entfernen" : "Barcode zum neuen Produkt";
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
      data = await editImage(file, target.ocr ? 1800 : 900, target.ocr ? 0.9 : 0.8);
    } catch (_) {
      this._toast("Das Foto konnte nicht gelesen werden 🙈");
      return;
    }
    if (!data) return; // abgebrochen
    if (target.ocr) { this._photoTarget = null; target.ocr(data); return; } // 🔎 „Text aus Foto“: das Foto geht an die Texterkennung
    if (target.recipeDraft && this._draft) {
      // Rezept-Foto: wird beim Speichern mitgespeichert
      (this._draft.newPhotos ||= []).push(data);
      this._renderRecipePhoto();
      this._toast("📷 Foto dazu – wird beim Speichern mitgespeichert");
      return;
    }
    this._savePhoto(target, data);
  }

  async _savePhoto(target, data) {
    try {
      this._toast("📸 Foto wird gespeichert …");
      const add = target.add ?? this._hasPhoto(target.name); // nie ersetzen, immer dazu
      if (add && this._photoCount(target.name) >= 6) {
        this._toast("📷 Schon 6 Fotos – voll. Erst eins in den ⚙️ Einstellungen löschen.");
        return;
      }
      await this._ws({ type: "einkaufsliste/photo/set", name: target.name, data, add: !!add });
      for (const k of [...this._photoCache.keys()]) if (k.startsWith(target.name.toLowerCase())) this._photoCache.delete(k);
      if (this._hass?.connected === false) this._toast("📴 Foto vorgemerkt – wird hochgeladen, sobald wieder Netz da ist");
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

  _photoCount(name) {
    const key = String(name || "").toLowerCase();
    return this._data?.photo_counts?.[key] || (this._data?.photos?.[key] ? 1 : 0);
  }

  async _photoData(key, index) {
    const updated = this._data?.photos?.[key];
    if (updated === "queued") { // 📸 noch nicht hochgeladen: das Foto steckt in der Warteschlange
      const q = elQueue.find((x) => x.type === "einkaufsliste/photo/set" && String(x.name).toLowerCase() === key);
      if (q) return q.data.includes(",") ? q.data : `data:image/jpeg;base64,${q.data}`;
    }
    const ck = `${key}#${index}`;
    const cached = this._photoCache.get(ck);
    if (cached && cached.updated === updated) return cached.data;
    // 📷 Antwort kommt manchmal nie an: nach 5 Sekunden neu fragen (bis zu 3 Versuche), statt ewig zu warten
    let lastErr = null;
    for (let n = 0; n < 3; n++) {
      try {
        const res = await Promise.race([
          this._hass.callWS({ type: "einkaufsliste/photo/get", name: key, index }),
          new Promise((_, rej) => setTimeout(() => rej(new Error("keine Antwort nach 5 Sekunden")), 5000)),
        ]);
        this._photoCache.set(ck, { updated, data: res.data });
        return res.data;
      } catch (err) {
        lastErr = err;
        if (err?.code === "invalid" || err?.code === "error" || err?.code === "not_found") break; // der Server hat geantwortet: nochmal fragen hilft nicht
      }
    }
    this._hass?.callWS?.({ type: "einkaufsliste/errors/report", where: "Karte: photo/get (Foto lädt nicht)", message: String(lastErr?.message || lastErr?.code || lastErr).slice(0, 380) }).catch(() => {});
    throw lastErr;
  }

  // 📷 Foto-Galerie: blättern, weitere Fotos dazu, einzelne löschen
  async _openPhoto(name, title, start = 0, onClose = null) {
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
    // 🗑️ Löschen nur in ⚙️ Einstellungen und im Rezept-Editor – nicht in der Liste und nicht bei der Kochmütze
    const canDelete = this._view === "settings" || this._view === "recipe";
    // ↔️ Reihenfolge und ⭐ Hauptfoto – auch nur dort, wo man ändern darf
    const bLeft = ovButton("◀ nach vorne"), bMain = ovButton("⭐ Als Hauptfoto"), bRight = ovButton("nach hinten ▶");
    const sort = document.createElement("div");
    Object.assign(sort.style, { display: canDelete ? "flex" : "none", gap: "8px", flexWrap: "wrap", justifyContent: "center", marginBottom: "8px" });
    sort.append(bLeft, bMain, bRight);
    const full = document.createElement("div");
    Object.assign(full.style, { color: "#ffcc80", fontSize: "14px", margin: "0 0 8px", textAlign: "center" });
    row.append(bAdd, ...(canDelete ? [bDel] : []), bClose);
    let loadId = 0;
    const note = document.createElement("div"); // 📷 „lädt …“ bzw. Fehlermeldung statt leerer Fläche
    Object.assign(note.style, { font: "500 16px Roboto, sans-serif", margin: "24px 0", textAlign: "center" });
    const retry = ovButton("🔄 Nochmal");
    retry.style.display = "none";
    ov.append(note, retry, img, cap, nav, full, sort, row);
    const show = async () => {
      const n = count();
      if (!n) { close(); return; }
      idx = Math.max(0, Math.min(idx, n - 1));
      pos.textContent = `${idx + 1} / ${n}`;
      nav.style.visibility = n > 1 ? "visible" : "hidden";
      cap.textContent = label + (idx === 0 && n > 1 ? " · ⭐ Hauptfoto" : "");
      bAdd.style.display = n >= 6 ? "none" : "";
      // 📷 Foto-Grenze sichtbar machen
      full.textContent = n >= 6 ? `📷 ${n}/6 – voll. Für ein neues Foto erst eins löschen${canDelete ? "" : " (in den ⚙️ Einstellungen)"}.` : "";
      full.style.display = n >= 6 ? "" : "none";
      sort.style.display = canDelete && n > 1 ? "flex" : "none";
      bLeft.style.display = idx > 0 ? "" : "none";
      bMain.style.display = idx > 0 ? "" : "none";
      bRight.style.display = idx < n - 1 ? "" : "none";
      const my = ++loadId;
      img.style.display = "none";
      note.style.display = "";
      note.textContent = "📷 Foto lädt …";
      retry.style.display = "none";
      try {
        const src = await this._photoData(key, idx);
        if (my !== loadId) return; // inzwischen weitergeblättert
        img.src = src;
        img.style.display = "";
        note.style.display = "none";
      } catch (err) {
        if (my !== loadId) return;
        note.textContent = err?.message && !/keine Antwort/.test(err.message) ? `😕 ${err.message}` : "😕 Foto nicht ladbar";
        retry.style.display = "";
      }
    };
    const close = () => { ov.remove(); document.removeEventListener("keydown", onKey); onClose?.(); };
    const onKey = (e) => {
      if (e.key === "Escape") close();
      if (e.key === "ArrowLeft") { idx--; show(); }
      if (e.key === "ArrowRight") { idx++; show(); }
    };
    document.addEventListener("keydown", onKey);
    retry.onclick = () => show();
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
      if (!elConfirm("Dieses Foto löschen?")) return;
      try {
        await this._ws({ type: "einkaufsliste/photo/remove", name: key, index: idx });
        for (const k of [...this._photoCache.keys()]) if (k.startsWith(key + "#")) this._photoCache.delete(k);
        this._toast("Foto gelöscht 🗑️");
        setTimeout(show, 300);
      } catch (_) { /* Meldung kam schon */ }
    };
    const move = async (to) => {
      try {
        await this._ws({ type: "einkaufsliste/photo/move", name: key, index: idx, to });
        for (const k of [...this._photoCache.keys()]) if (k.startsWith(key + "#")) this._photoCache.delete(k);
        idx = to;
        this._toast(to === 0 ? "⭐ Ist jetzt das Hauptfoto" : "↔️ Verschoben");
        setTimeout(show, 300);
      } catch (_) { /* Meldung kam schon */ }
    };
    bLeft.onclick = () => move(idx - 1);
    bRight.onclick = () => move(idx + 1);
    bMain.onclick = () => move(0);
    bAdd.onclick = () => {
      this._photoTarget = { name: key, add: true, onDone: () => { this._toast("📸 Foto dazu gespeichert"); idx = count(); setTimeout(show, 400); } };
      this._pickFile("photoFile", this._photoHeading(key, true));
    };
    show();
  }

  // 📖 Anleitung – öffnet sich über den Einkaufswagen oben links (ohne Namen, für alle in der Familie)
  // 🧾 Einkaufs-Protokoll: wer hat wann wo wie viel bezahlt – nur da, wenn es in ⚙️ eingeschaltet ist
  async _showSpend(tab = "add") {
    if (!this._data?.settings?.spend) return;
    const autoAsk = !!this._spendAutoPrompt; this._spendAutoPrompt = false; // 🎉 von selbst aufgegangen?
    const ov = makeOverlay();
    Object.assign(ov.style, { background: "#111", justifyContent: "flex-start", overflowY: "auto", touchAction: "pan-y",
      paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 40px)" });
    const loc = EL_LANG === "de" ? "de-DE" : "en-GB";
    const eur = (n) => n.toLocaleString(loc, { style: "currency", currency: "EUR" });
    const cnt = (n) => EL_LANG === "de" ? `${n} ${n === 1 ? "Einkauf" : "Einkäufe"}` : `${n} ${n === 1 ? "purchase" : "purchases"}`;
    const two = (n) => String(n).padStart(2, "0");
    const iso = (d) => `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
    const f = (this._spendF ||= { who: "", store: "", quick: "month", from: "", to: "" });
    const stores = this._data.stores;
    const start = this._tab && this._tab !== "all" && this._store(this._tab) ? this._tab : (this._spendLastStore || stores[0]?.id || "");
    let cur = tab, entries = [], loaded = false, bon = this._spendBon || null; // 🧾📷 Bon-Foto, das mitgespeichert wird
    const range = () => {
      const now = new Date();
      if (f.quick === "month") return [iso(new Date(now.getFullYear(), now.getMonth(), 1)), iso(now)];
      if (f.quick === "last") return [iso(new Date(now.getFullYear(), now.getMonth() - 1, 1)), iso(new Date(now.getFullYear(), now.getMonth(), 0))];
      if (f.quick === "all") return ["", ""];
      return [f.from, f.to];
    };
    const monthName = (ym) => { const [y, m] = ym.split("-").map(Number); return new Date(y, m - 1, 1).toLocaleDateString(loc, { month: "long", year: "numeric" }); };
    const dayName = (t) => { const d = new Date(t.slice(0, 10) + "T12:00:00"); return d.toLocaleDateString(loc, { weekday: "short", day: "2-digit", month: "2-digit", year: "numeric" }); };
    const filtered = () => {
      const [from, to] = range();
      return entries.filter((e) => (!f.who || e.w === f.who) && (!f.store || e.s === f.store)
        && (!from || e.t.slice(0, 10) >= from) && (!to || e.t.slice(0, 10) <= to));
    };
    const draw = () => {
      const opt = (v, label, c) => `<option value="${esc(v)}" ${v === c ? "selected" : ""}>${esc(label)}</option>`;
      const names = [...new Set(entries.map((e) => e.w).filter(Boolean))].sort((a, b) => a.localeCompare(b, "de"));
      const [from, to] = range();
      let body;
      if (cur === "add") {
        body = `${autoAsk ? `<p class="sp-hint"><b>🎉 Alles abgehakt – Einkauf eintragen?</b></p>` : ""}<p class="sp-hint">Nach dem Einkauf: Wo warst du und wie viel hat es gekostet? Wer und wann trägt die Liste selbst ein.</p>
          <label class="sp-l">Geschäft</label>
          <select id="spStore">${stores.map((st) => opt(st.id, st.name, start)).join("")}</select>
          <label class="sp-l">Betrag in €</label>
          <input id="spAmount" inputmode="decimal" placeholder="z. B. 23,40" autocomplete="off">
          <div class="sp-row" style="margin-top:8px"><button class="sp-q" data-sp="scan" style="flex:1">📷 Kassenbon lesen</button></div>
          <div class="sp-row" id="spAlts" style="margin-top:6px" hidden></div>
          <div class="sp-hint" id="spBon">${bon ? "📎 Bon-Foto ist dabei – wird mitgespeichert." : "Tipp: Bon fotografieren – Betrag, Datum und Geschäft werden vorgeschlagen."}</div>
          <label class="sp-l">Datum</label>
          <input id="spDay" type="date" value="${iso(new Date())}" max="${iso(new Date())}">
          <div class="sp-err" id="spErr" hidden></div>
          <button class="sp-main" data-sp="save">✔ Speichern</button>`;
      } else if (!loaded) {
        body = `<p class="sp-hint">Lade …</p>`;
      } else {
        const list = filtered();
        const total = list.reduce((s, e) => s + e.a, 0);
        const byStore = new Map();
        for (const e of list) { const c = byStore.get(e.s) || { name: e.sn, sum: 0, n: 0 }; c.sum += e.a; c.n += 1; c.name = this._store(e.s)?.name || e.sn; byStore.set(e.s, c); }
        const max = Math.max(1, ...[...byStore.values()].map((c) => c.sum));
        const byMonth = new Map();
        for (const e of list) { const m = e.t.slice(0, 7); const c = byMonth.get(m) || { sum: 0, n: 0, st: new Map() }; c.sum += e.a; c.n += 1; c.st.set(e.s, (c.st.get(e.s) || 0) + e.a); byMonth.set(m, c); }
        const stName = (id) => this._store(id)?.name || list.find((e) => e.s === id)?.sn || "?";
        const q = (k, label) => `<button class="sp-q ${f.quick === k ? "on" : ""}" data-sp="quick" data-q="${k}">${label}</button>`;
        body = `<div class="sp-q-row">${q("month", "Dieser Monat")}${q("last", "Letzter Monat")}${q("all", "Alles")}</div>
          <div class="sp-row"><input id="spFrom" type="date" value="${esc(from)}" title="Datum von"><span>–</span><input id="spTo" type="date" value="${esc(to)}" title="Datum bis"></div>
          <div class="sp-row"><select id="spWho" title="Person">${opt("", "👤 Alle", f.who)}${names.map((n) => opt(n, n, f.who)).join("")}</select>
          <select id="spSt" title="Geschäft">${opt("", "🏪 Alle", f.store)}${stores.map((st) => opt(st.id, st.name, f.store)).join("")}</select></div>
          <div class="sp-total"><span>Zusammen</span><b>${eur(total)}</b><small translate="no">${cnt(list.length)}${list.length ? ` · Ø ${eur(total / list.length)}` : ""}</small></div>
          ${byStore.size ? `<h3>🏪 Pro Geschäft</h3>${[...byStore.entries()].sort((a, b) => b[1].sum - a[1].sum).map(([id, c]) => {
            const st = this._store(id);
            return `<div class="sp-bar"><div class="sp-bt"><span translate="no">${esc(c.name)}</span><b>${eur(c.sum)}</b></div><div class="sp-b"><i style="width:${Math.round(c.sum / max * 100)}%;background:${esc(st?.color || "#1e88e5")}"></i></div><small translate="no">${cnt(c.n)} · Ø ${eur(c.sum / c.n)}</small></div>`;
          }).join("")}` : ""}
          ${byMonth.size ? `<h3>📅 Pro Monat</h3>${[...byMonth.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([m, c]) =>
            `<div class="sp-month"><div class="sp-bt"><span>${esc(monthName(m))}</span><b>${eur(c.sum)}</b></div><small translate="no">${[...c.st.entries()].sort((a, b) => b[1] - a[1]).map(([id, v]) => `${esc(stName(id))} ${eur(v)}`).join(" · ")}</small></div>`).join("")}` : ""}
          <h3>🧾 Einkäufe</h3>
          ${list.length ? list.map((e) => `<div class="sp-e"><div><b translate="no">${esc(this._store(e.s)?.name || e.sn)}</b><br><small>${esc(dayName(e.t))}${e.w ? ` · <span translate="no">${esc(e.w)}</span>` : ""}</small></div><span>${eur(e.a)}</span><button class="sp-x" data-sp="bon" data-id="${esc(e.id)}" title="${this._hasPhoto("bon#" + e.id) ? "Bon-Foto ansehen" : "Bon-Foto dazu"}">${this._hasPhoto("bon#" + e.id) ? "📷" : "➕📷"}</button><button class="sp-x" data-sp="del" data-id="${esc(e.id)}" title="Löschen">✖</button></div>`).join("") : `<p class="sp-hint">Nichts gefunden – ändere den Filter oder trag einen Einkauf ein.</p>`}`;
      }
      ov.innerHTML = `<style>
        .sp { width:100%; max-width:560px; color:#eee; font:15px/1.5 Roboto, sans-serif; }
        .sp .sp-top { display:flex; justify-content:space-between; align-items:center; gap:10px; }
        .sp h2 { font-size:21px; margin:6px 0; } .sp h3 { font-size:16px; margin:16px 0 6px; }
        .sp-tabs { display:grid; grid-template-columns:1fr 1fr; gap:6px; margin:8px 0 12px; }
        .sp-tabs button, .sp-q { background:#1e1e1e; color:#eee; border:1px solid #333; border-radius:10px; padding:10px; font:inherit; cursor:pointer; }
        .sp-tabs button.on, .sp-q.on { background:#1e88e5; border-color:#1e88e5; color:#fff; font-weight:600; }
        .sp-q-row { display:flex; gap:6px; margin-bottom:8px; } .sp-q { flex:1; padding:8px 6px; }
        .sp select, .sp input { width:100%; box-sizing:border-box; font:inherit; padding:10px 12px; border-radius:10px; border:1px solid #444; background:#1e1e1e; color:#eee; color-scheme:dark; }
        .sp-row { display:flex; gap:8px; align-items:center; margin-bottom:8px; }
        .sp-l { display:block; margin:10px 0 4px; color:#aaa; font-size:14px; }
        .sp-hint { color:#aaa; } .sp small { color:#aaa; }
        .sp-main { width:100%; margin-top:14px; background:#43a047; color:#fff; border:0; border-radius:12px; padding:13px; font:600 16px Roboto,sans-serif; cursor:pointer; }
        .sp-err { color:#ff8a80; margin-top:8px; }
        .sp-total { background:#1e1e1e; border:1px solid #333; border-radius:12px; padding:12px 14px; margin:6px 0; display:grid; grid-template-columns:1fr auto; gap:0 10px; }
        .sp-total b { font-size:24px; } .sp-total small { grid-column:1 / -1; }
        .sp-bt { display:flex; justify-content:space-between; gap:10px; }
        .sp-b { background:#2a2a2a; border-radius:6px; height:10px; margin:4px 0 2px; overflow:hidden; } .sp-b i { display:block; height:100%; border-radius:6px; }
        .sp-bar, .sp-month { margin:8px 0; }
        .sp-e { display:grid; grid-template-columns:1fr auto auto auto; gap:10px; align-items:center; padding:8px 0; border-bottom:1px solid #2a2a2a; }
        .sp-x { background:none; border:0; color:#888; cursor:pointer; font-size:15px; padding:6px; }
      </style>
      <div class="sp">
        <div class="sp-top"><h2>🧾 Einkaufs-Protokoll</h2><button class="sp-x" data-sp="close" title="Schließen" style="font-size:22px">✕</button></div>
        <div class="sp-tabs"><button class="${cur === "add" ? "on" : ""}" data-sp="tab" data-t="add">➕ Eintragen</button><button class="${cur === "stats" ? "on" : ""}" data-sp="tab" data-t="stats">📊 Auswertung</button></div>
        ${body}
      </div>`;
    };
    const load = async () => {
      try { entries = (await this._ws({ type: "einkaufsliste/purchases/get" })).entries || []; } catch (_) { /* Meldung kam schon */ }
      loaded = true;
      if (ov.isConnected) draw();
    };
    ov.addEventListener("click", async (ev) => {
      const b = ev.target.closest("[data-sp]");
      if (!b) return;
      const act = b.dataset.sp;
      if (act === "close") ov.remove();
      else if (act === "tab") { cur = b.dataset.t; draw(); if (cur === "stats") load(); }
      else if (act === "quick") { f.quick = b.dataset.q; draw(); }
      else if (act === "alt") { const a = ov.querySelector("#spAmount"); if (a) a.value = b.dataset.v; }
      else if (act === "scan") {
        this._ocrStart("🔎 Kassenbon wird gelesen", (text, data) => {
          const info = elReceiptInfo(text, stores);
          bon = this._spendBon = data;
          const q = (id) => ov.querySelector(id);
          if (info.amount != null && q("#spAmount")) q("#spAmount").value = info.amount.toFixed(2).replace(".", ",");
          if (info.store && q("#spStore")) q("#spStore").value = info.store;
          if (info.day && q("#spDay")) q("#spDay").value = info.day;
          if (q("#spBon")) q("#spBon").textContent = info.amount == null
            ? "📎 Bon-Foto ist dabei. Den Betrag konnte ich nicht lesen – bitte selbst eintragen."
            : `📎 Bon-Foto ist dabei. Erkannt: ${info.amount.toFixed(2).replace(".", ",")} €${info.sure ? "" : " (unsicher)"} – bitte kurz prüfen.`;
          const alts = q("#spAlts"); // 🎯 war es vielleicht einer von diesen?
          if (alts) {
            const fmt = (v) => v.toFixed(2).replace(".", ",");
            alts.hidden = !info.alts?.length;
            alts.innerHTML = info.alts?.length ? `<span style="align-self:center;font-size:13px;opacity:.75">${esc(elT("Oder war es:"))}</span>` + info.alts.map((v) => `<button class="sp-q" type="button" data-sp="alt" data-v="${fmt(v)}">${fmt(v)} €</button>`).join("") : "";
          }
        }, "🧾 Kassenbon abfotografieren");
      } else if (act === "bon") {
        const key = "bon#" + b.dataset.id;
        if (this._hasPhoto(key)) this._openPhoto(key, "🧾 Kassenbon");
        else {
          this._photoTarget = { name: key, keepEdit: true, onDone: () => { this._toast("📸 Bon-Foto gespeichert"); setTimeout(() => draw(), 600); } };
          this._pickFile("photoFile", this._photoHeading(key));
        }
      } else if (act === "save") {
        const store = ov.querySelector("#spStore").value, amount = ov.querySelector("#spAmount").value, day = ov.querySelector("#spDay").value;
        const err = ov.querySelector("#spErr");
        try {
          const entry = await this._hass.callWS({ type: "einkaufsliste/purchases/add", store_id: store, amount, day });
          if (bon && entry?.id) await this._ws({ type: "einkaufsliste/photo/set", name: "bon#" + entry.id, data: bon }).catch(() => {});
          bon = this._spendBon = null;
        } catch (e) { err.textContent = e?.message || "Das hat nicht geklappt."; err.hidden = false; return; }
        this._spendLastStore = store;
        this._toast("🧾 Eingetragen");
        cur = "stats"; f.quick = "month"; f.who = ""; f.store = ""; loaded = false; draw(); load();
      } else if (act === "del") {
        if (!elConfirm("Diesen Einkauf aus dem Protokoll löschen?")) return;
        try { await this._ws({ type: "einkaufsliste/purchases/remove", id: b.dataset.id }); } catch (_) { return; }
        entries = entries.filter((e) => e.id !== b.dataset.id);
        draw();
      }
    });
    ov.addEventListener("change", (ev) => {
      const id = ev.target.id;
      if (id === "spWho") f.who = ev.target.value;
      else if (id === "spSt") f.store = ev.target.value;
      else if (id === "spFrom" || id === "spTo") {
        const [from, to] = range();
        f.quick = "own"; f.from = id === "spFrom" ? ev.target.value : from; f.to = id === "spTo" ? ev.target.value : to;
      } else return;
      draw();
    });
    draw();
    if (cur === "stats") load();
  }

  _showGuide(kind = "user") {
    const ov = makeOverlay();
    Object.assign(ov.style, { background: "#111", justifyContent: "flex-start", overflowY: "auto", touchAction: "pan-y",
      paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 40px)" });
    const sec = (icon, title, body, open = false) => `<details class="elg-sec" ${open ? "open" : ""}><summary>${icon} ${title}</summary><div>${body}</div></details>`;
    const appSec = kind === "settings" ? "" : this._guideAppSec(sec);
    ov.innerHTML = `<style>
      .elg { width:100%; max-width:640px; color:#eee; font:15px/1.5 Roboto, sans-serif; }
      .elg h2 { font-size:21px; margin:6px 0 4px; display:flex; align-items:center; gap:8px; }
      .elg .elg-top { display:flex; justify-content:space-between; align-items:center; gap:10px; }
      .elg .elg-sub { color:#aaa; margin:0 0 12px; font-size:14px; }
      .elg-sec { background:#1e1e1e; border:1px solid #333; border-radius:12px; margin:8px 0; overflow:hidden; }
      .elg-sec summary { cursor:pointer; padding:12px 14px; font-weight:600; font-size:16px; list-style:none; }
      .elg-sec summary::-webkit-details-marker { display:none; }
      .elg-sec summary::after { content:"＋"; float:right; opacity:.6; }
      .elg-sec[open] summary::after { content:"－"; }
      .elg-sec > div { padding:0 14px 12px; }
      .elcredits { text-align:center; } .elcredits p { margin:8px 0; }
      .ellogo { background:#fff; border-radius:14px; padding:10px; display:inline-block; max-width:100%; }
      .ellogo img { display:block; max-width:100%; width:280px; height:auto; }
      .elcbtns { display:flex; flex-wrap:wrap; gap:8px; justify-content:center; margin:10px 0; }
      .elcbtn { color:#fff; background:rgba(255,255,255,.14); border-radius:12px; padding:10px 14px; text-decoration:none; font-weight:500; }
      .elcsmall { opacity:.7; font-size:.9em; }
      .elg-sec ul, .elg-sec ol { margin:4px 0; padding-left:20px; }
      .elg-sec li { margin:4px 0; }
      .elg b { color:#fff; }
      .elg .elg-k { display:inline-block; background:#333; border-radius:6px; padding:0 6px; }
      .elg .elg-url { width:100%; box-sizing:border-box; font:14px monospace; padding:9px 10px; border-radius:10px; border:1px solid #444; background:#111; color:#eee; margin:6px 0; }
      .elg .elg-copy { font:inherit; font-weight:600; color:#fff; background:#03a9f4; border:0; border-radius:10px; padding:9px 16px; cursor:pointer; }
    </style>
    ${kind === "settings" ? this._guideSettings(sec) : EL_LANG !== "de" ? this._guideEn(sec, appSec) : `<div class="elg">
      <div class="elg-top"><h2>🛒 So funktioniert die Einkaufsliste</h2></div>
      <p class="elg-sub">Tipp auf eine Überschrift klappt sie auf. Diese Anleitung findest du immer über den <b>Einkaufswagen ganz oben links</b>.</p>
      ${sec("🆕", "Was ist neu", this._newsHtml(false))}
      ${sec("✍️", "Etwas eintragen", `<ul>
        <li>Oben ins Feld tippen, z. B. <b>Milch</b>, dann den grünen Haken <span class="elg-k">✔</span>.</li>
        <li>Beim Tippen kommen bis zu <b>2 Vorschläge</b>. Antippen übernimmt alles vom letzten Mal (Menge, Notiz, für wen, Geschäft).</li>
        <li>Die Menge geht auch direkt: <b>3 Milch</b> oder <b>500 g Mehl</b>. Die Liste merkt sich die Einheit: <b>2 Backpulver</b> wird zu 2 Pck.</li>
        <li><b>Mehrere auf einmal:</b> <b>Milch, 6 Eier, Brot</b> → ✔ → 3 Sachen auf der Liste.</li>
        <li>Die Knöpfe darunter: 🔢 Menge · 📝 Notiz (z. B. Sorte) · 👤 Für wen · 📷 Foto · 📋 Liste aus Foto einlesen · 🧽 alles leeren.</li>
        <li>Darunter <b>„Welches Geschäft?“</b> – oder „Egal wo“. Meist ist es schon richtig ausgewählt (so wie zuletzt).</li>
        <li>Daneben die <b>Kategorie</b> – die sucht sich die Liste meist selbst aus. Passt sie nicht, einfach ändern.</li>
        <li>Einen <b>Namen</b> tippen (z. B. von dir) zeigt, was für diese Person auf der Liste steht.</li>
        <li>Vertippt? Die Liste fragt „Meintest du …?“ 😉</li></ul>`, true)}
      ${appSec}
      ${sec("✅", "Abhaken & wieder draufsetzen", `<ul>
        <li><b>Kreis antippen</b> = gekauft. Das Handy vibriert kurz.</li>
        <li>Gekauftes rutscht nach unten zu <b>„Erledigt – schon mal gekauft“</b>.</li>
        <li>Dort den Kreis antippen = <b>wieder auf der Liste</b>. So musst du nichts neu tippen.</li>
        <li>Einmal pro Woche wird automatisch aufgeräumt: Alte Sachen werden abgehakt, <b>gelöscht wird nichts</b>.</li></ul>`)}
      ${sec("📸", "Text aus Foto & neue Helfer", `<ul>
        <li><b>📋 unter dem Eingabefeld:</b> liest <b>nur einen Einkaufszettel</b>: fotografieren, Text prüfen, auf die Liste. Gedruckt klappt gut, Handschrift nur mit Glück – darum kannst du den Text vorher korrigieren.</li>
        <li><b>Kassenbon:</b> nicht über das 📋, sondern im Einkaufs-Protokoll mit „📷 Kassenbon lesen“ – Betrag, Geschäft und Tag werden vorgeschlagen.</li>
        <li><b>🧲 Zusammenführen:</b> im Produkt-Editor zwei gleiche Produkte zu einem machen.</li>
        <li><b>🩺 Ampel &amp; 🐞 Fehler-Protokoll:</b> in den Einstellungen – zeigt, ob alles läuft.</li>
        <li><b>🛍️ Laden-Modus automatisch:</b> schaltet sich beim Betreten eines Geschäfts ein (gilt für alle Geräte, optional – der Standort bleibt bei jedem selbst).</li>
        <li><b>Rezepte:</b> Fotos pro Schritt im Kochmodus. Ein Rezept von einer Kochbuch-Seite liest du <b>im Rezept-Editor</b> mit „📷 Aus Foto“ ein – nicht über das 📋.</li>
        <li><b>Offline:</b> Fotos, die du ohne Netz machst, werden später nachgeschickt.</li>
      </ul>`)}
      ${sec("🏪", "Geschäfte & Reiter", `<ul>
        <li>Oben die Reiter: <b>Alle</b>, Aldi, Netto … Die Zahl zeigt, wie viel dort offen ist.</li>
        <li>Die <b>rote Blase</b> heißt: Da ist was Neues dazugekommen, seit du zuletzt geschaut hast.</li>
        <li><b>✨</b> am Artikel = neu von jemand anderem. Es bleibt, bis du den Artikel <b>abhakst</b> oder das <b>✨ antippst</b> – höchstens 24 Stunden.</li>
        <li><b>⇄</b> am Artikel = war aus: <b>„Nächstes Mal wieder hier“</b> (bleibt offen, alle sehen „war aus“) oder gleich in ein anderes Geschäft schieben. Geschäfte mit ✓ führen das Produkt auch.</li>
        <li><b>🤷 „Egal wo“</b> = kein festes Geschäft: steht in jedem Geschäfts-Reiter mit drin. Mit ⇄ in ein Geschäft schieben = zieht einfach um.</li>
        <li><b>🔁 Gibt's auch hier</b> (im Reiter eines Geschäfts): Sachen, die bei einem anderen Geschäft stehen, die es aber auch hier gibt. Antippen holt sie her.</li>
        <li>Kein Netz im Laden? Einfach weiter abhaken. Der Punkt oben wird <b>orange ⏳</b>, und alles wird nachgeschickt, sobald wieder Netz da ist.</li></ul>`)}
      ${sec("👆", "Ändern & lange drücken", `<ul>
        <li>Artikel <b>lange drücken</b> = Menü: Bearbeiten, Verschieben, Menge, Kategorie, Foto, Barcode.</li>
        <li>Menge direkt ändern: auf die Menge tippen, dann <span class="elg-k">−</span> und <span class="elg-k">＋</span>.</li>
        <li>Unter dem Artikel steht klein: das <b>Geschäft in seiner Farbe</b>, die <b>📝 Notiz</b> (gelb hinterlegt), ▥ (Barcode da), wer eingetragen und wer abgehakt hat.</li>
        <li><b>🏷️</b> vorn am Artikel = gerade im Angebot (nur wenn in den Einstellungen eingeschaltet). Antippen oder lange drücken → <b>Angebote</b>: Geschäft, Preis, wie lange. <b>🛒 Hier kaufen</b> legt den Angebots-Artikel in diesem Geschäft an (mit Name und „🏷️ Preis bis Tag“ in einem eigenen Feld) und hakt das ursprüngliche Produkt ab. Artikel aus Angeboten sind danach beim Abhaken ganz weg.</li>
        <li><b>Angebote suchen:</b> Einfach das Produkt oben eintippen (z. B. „Kaffee“) – unter den Vorschlägen steht <b>🏷️ Angebote für „Kaffee“ anzeigen</b>. Dort mit <b>➕ Auf die Liste</b> gleich beim richtigen Geschäft eintragen.</li>
        <li><b>⌛ Angebot vorbei</b> = das Angebot ist abgelaufen. Der Artikel bleibt auf der Liste, nur der Angebotspreis ist weg; der Hinweis steht 1 Tag. Ein Artikel, der erst durch das Angebot entstanden ist, wird dann gelöscht und dein ursprüngliches Produkt kommt wieder auf die Liste.</li>
        <li>Ehrlich gesagt: Die Angebote kommen inoffiziell von Marktguru und können jederzeit aufhören zu funktionieren.</li></ul>`)}
      ${sec("🛍️", "Im Laden", `<ul>
        <li>Der <b>Wagen oben rechts</b> schaltet den <b>Laden-Modus</b> ein: große Zeilen, nur Abhaken, nur das Wichtigste.</li>
        <li>Nochmal antippen (oder <b>Beenden</b>) = wieder normal.</li>
        <li>Bist du laut Standort im Geschäft, hakt <b>▥</b> (oben neben dem grünen Punkt) das gescannte Produkt gleich ab – falls es auf der Liste steht.</li></ul>`)}
      ${sec("🧾", "Einkaufs-Protokoll", `<ul>
        <li>Nur da, wenn es in ⚙️ → <b>Extras</b> → <b>Einkaufs-Protokoll</b> eingeschaltet ist (gilt für alle).</li>
        <li>Der <b>🧾-Knopf</b> oben in der Karte (und im Verlauf) öffnet es. <b>➕ Eintragen</b>: Geschäft, Betrag, Datum – wer und wann setzt die Liste selbst.</li>
        <li><b>📊 Auswertung</b>: zusammengerechnet, pro Geschäft und pro Monat. Filter für Person, Geschäft und Datum, Schnellwahl <b>Dieser Monat / Letzter Monat / Alles</b>.</li>
        <li>Falsch eingetragen? Beim Einkauf auf <b>✖</b> tippen.</li></ul>`)}
      ${sec("📷", "Fotos", `<ul>
        <li><b>Produkt-Foto:</b> Beim Eintragen auf das <b>📷</b> unter dem Eingabefeld tippen – oder später den Artikel <b>lange drücken → Foto</b>. Das Foto gehört zum Produkt und ist beim nächsten Mal wieder da. Am Artikel zeigt das kleine <b>📷</b> es groß; wischen = blättern. Bis zu <b>6 Fotos</b> pro Produkt, ein neues ersetzt nie ein altes.</li>
        <li><b>Woher kommt das Foto?</b> Am Handy fragt die Karte: <b>📷 Kamera</b> · <b>🖼️ Galerie</b> · <b>📋 Einfügen</b> (ein kopiertes Bild). Am PC öffnet sich ein Fenster: Bild <b>reinziehen</b>, <b>Strg + V</b> drücken oder klicken. In der HA-App im WLAN (lokale http-Adresse) gibt es die Kamera nicht – dort geht gleich die Galerie auf.</li>
        <li><b>Drehen &amp; zuschneiden:</b> Vor dem Speichern kannst du das Foto drehen und den Ausschnitt wählen.</li>
        <li><b>Rezept-Fotos:</b> Im Rezept-Editor Fotos zum Rezept hinzufügen. In der Rezeptliste öffnet das <b>📷</b> neben dem Namen die Fotos.</li>
        <li><b>Foto zu einem Koch-Schritt:</b> Im Rezept-Editor stehen unter der Zubereitung alle Schritte. Bei jedem Schritt <b>„Foto“</b> bzw. <b>„Dazu“</b> tippen (geht, sobald das Rezept einmal gespeichert ist). Im <b>Koch-Modus</b> erscheint das Foto bei genau diesem Schritt. Die Fotos hängen an der Schrittnummer – ändert sich die Reihenfolge, bitte kurz prüfen.</li>
        <li><b>Kassenbon-Foto:</b> Im Einkaufs-Protokoll hängt beim Eintragen „📷 Kassenbon lesen“ das Bon-Foto automatisch an. Bei einem Eintrag ohne Foto gibt es das Symbol <b>➕📷</b>, mit Foto öffnet das <b>📷</b> es.</li>
        <li><b>🎉 Automatisch fragen (Option):</b> In den Einstellungen beim Einkaufs-Protokoll einschaltbar (gilt für alle). Ist alles auf der Liste abgehakt, geht „Einkauf eintragen“ von selbst auf – mit dem Geschäft schon ausgewählt. Höchstens alle 10 Minuten.</li>
        <li><b>Ohne Netz:</b> Fotos, die du in der Offline-App ohne Netz machst, werden vorgemerkt („📴 Foto vorgemerkt“) und hochgeladen, sobald wieder Netz da ist. Sehr große Fotos (über ca. 3 MB) gehen nur mit Netz.</li>
        <li><b>Verwalten &amp; löschen:</b> Nur in ⚙️ → <b>Produkte</b> (Reihenfolge, Hauptfoto, einzeln löschen) und im Rezept-Editor – nicht in der Einkaufsliste selbst.</li>
        <li><b>Foto einlesen (Text):</b> Das ist etwas anderes als ein Foto ablegen. Dazu siehe „Text aus Foto &amp; neue Helfer“.</li></ul>`)}
      ${sec("▥", "Barcodes", `<ul>
        <li><b>▥</b> oben neben dem grünen Punkt = Barcode scannen (in der HA-App und in der Offline-App): Das Produkt wird erkannt und eingetragen.</li>
        <li>Einen Barcode nachträglich zuordnen: Artikel lange drücken → <b>Barcode</b>.</li>
        <li>Neues Produkt mit eigenem Namen? Beim Eintragen das <b>▥ mit Plus</b> (neben dem Foto-Symbol) antippen, scannen, Namen tippen, ✔ – der Barcode gehört dann gleich dazu.</li></ul>`)}
      ${sec("👨‍🍳", "Rezepte", `<ul>
        <li>Die <b>Kochmütze</b> oben öffnet die Rezepte. Das Suchfeld findet auch Zutaten (z. B. „Zucchini“).</li>
        <li><b>Auf die Liste</b>: Anhaken, was du brauchst. Was schon draufsteht oder „haben wir immer“ ist (🧂), ist nicht angehakt.</li>
        <li><b>👥 Für wie viele?</b> bzw. <b>🍕🍰 Wie viele Bleche?</b> Mit − / ＋ rechnen sich die Mengen mit.</li>
        <li>Steht <b>„Noch nie gekauft – wo kaufen?“</b>, einfach das Geschäft wählen.</li>
        <li><b>Von der Liste (3)</b> nimmt die Zutaten dieses Rezepts wieder runter.</li>
        <li>📷 = Rezept-Fotos · <b>🔥 Kochen</b> = Schritt für Schritt in großer Schrift · <b>Teilen</b> = z. B. per WhatsApp.</li>
        <li>Abgehakte Rezept-Zutaten verschwinden ganz (nicht bei „Erledigt“).</li>
        <li><b>⏲️ Gar-Zeiten</b> (oben bei den Rezepten und im Koch-Modus): Spickzettel nach Gerät: 🍲 Herd, 🔥 Backofen, 💨 Heißluftfritteuse.</li></ul>`)}
      ${sec("🟢", "Was bedeuten die Zeichen oben?", `<ul>
        <li>Von links: <b>🛒 Einkaufswagen</b> = diese Anleitung · <b>🟢 Punkt</b> · <b>Zahl</b> · <b>▥ Barcode</b>.</li>
        <li><b>🟢 Grüner Punkt</b> = verbunden, alles ist live auf allen Handys. <b>🔴 Rot</b> = gerade keine Verbindung.</li>
        <li>Die <b>Zahl</b> = so viele Sachen sind noch offen.</li>
        <li>Rechts: <b>Wagen</b> = Laden-Modus · <b>Kochmütze</b> = Rezepte.</li>
        <li>Ein <b>blauer Balken</b> oben = es gibt ein Update, das muss jemand mit Admin-Zugang in Home Assistant fertig machen.</li></ul>`)}
      ${sec("🙏", "Credits", this._creditsHtml(false))}
    </div>`}`;
    // 📖 Alle Kapitel zu – geht eins auf, klappt das vorige zu
    ov.querySelectorAll("details.elg-sec").forEach((d) => {
      d.open = false;
      d.addEventListener("toggle", () => {
        if (d.open) ov.querySelectorAll("details.elg-sec[open]").forEach((o) => { if (o !== d) o.open = false; });
      });
    });
    ov.querySelector(".elg-copy")?.addEventListener("click", () => {
      const inp = ov.querySelector(".elg-url");
      const btn = ov.querySelector(".elg-copy");
      elCopy(inp.value, inp).then(() => {
        btn.textContent = EL_LANG !== "de" ? "✅ Copied!" : "✅ Kopiert!";
        setTimeout(() => { btn.textContent = EL_LANG !== "de" ? "📋 Copy" : "📋 Kopieren"; }, 2500);
      });
    });
    const bClose = ovButton("Schließen", true);
    Object.assign(bClose.style, { marginTop: "14px" });
    ov.append(bClose);
    const close = () => { ov.remove(); document.removeEventListener("keydown", onKey); };
    const onKey = (e) => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", onKey);
    bClose.onclick = close;
    ov.addEventListener("click", (e) => { if (e.target === ov) close(); });
  }

  // 📖 Anleitung für die Einstellungen (⚙️) – nur für alle, die ins Zahnrad kommen
  _guideSettings(sec) {
    const en = EL_LANG !== "de";
    if (en) {
      return `<div class="elg" translate="no">
      <div class="elg-top"><h2>⚙️ How the settings work</h2></div>
      <p class="elg-sub">Tap a heading to open it. This guide is only for people who can open the settings. The guide for shopping and recipes is behind the <b>shopping cart at the top left</b>.</p>
      ${sec("🔍", "Finding things", `<ul>
        <li>The settings are a <b>list with headings</b>, only one level deep: tap a heading (it opens, the previous one closes), tap a row, change something, tap <b>Overview</b> to go back.</li>
        <li>The <b>search field</b> at the top finds rows by their name or topic, e.g. “photo”, “mail”, “backup” or “sensor”.</li>
        <li>The bar at the top shows the <b>health light</b> 🟢🟡🔴. Tap it to open “All OK?”.</li></ul>`, true)}
      ${sec("📋", "My list", `<ul>
        <li><b>Stores:</b> one row per store: colour, icon, 📍 zone(s) for “Next store first”, own brands and the order of the categories. Several zones per store work too (e.g. several branches).</li>
        <li><b>Categories:</b> name, colour, icon, order.</li>
        <li><b>People:</b> the names for the quick buttons at “For whom?”.</li>
        <li><b>Products:</b> <b>All products</b> (tap = change or delete completely, rename moves photos, barcodes and recipes along), <b>Newly scanned</b> (check the name, then ✔ OK) and <b>Delete shopping-list items</b>.</li>
        <li><b>Filter “🗓️ Not bought for 3 months”:</b> shows products that were last checked off more than 3 months ago (never checked off: counted from when they were added). Products on the list or in a recipe are not shown. Tap one to look at it, or <b>Delete all</b> in one go.</li>
        <li><b>➕ New product / ▥ By barcode:</b> adds a product to the catalog. By barcode: scan, confirm the name, done – the barcode belongs to it right away.</li>
        <li><b>🧲 Merge:</b> inside a product, turns two names into one (photos, barcodes, items and recipes move along).</li>
        <li><b>Recipes:</b> a recipe tab and a groups tab (Fish, Meat, Pastry …).</li></ul>`)}
      ${sec("🎛️", "Extras", `<ul>
        <li>Each row has its <b>own page</b> with an on/off button: 🏷️ offers, 🧾 purchase log, 📍 shop mode automatic, 🛒😊 mascot.</li>
        <li><b>Applies to all devices:</b> purchase log, auto-ask, shop mode automatic and mascot. For shop mode the location stays personal – it only turns on when <b>your</b> phone enters the zone.</li>
        <li><b>🏷️ Offers</b> need a postcode (admins only). They come unofficially from Marktguru and can stop working at any time.</li></ul>`)}
      ${sec("💾", "Data", `<ul>
        <li><b>Import &amp; backup:</b> recipes from a file · other apps (Bring!/AnyList tables as CSV, and an Alexa/to-do list) · 📧 e-mail · backup. Admins only.</li>
        <li><b>History:</b> who did what and when, with filters and search. How many days it is kept is set there.</li>
        <li><b>Tidy up:</b> once a week old open items are <b>checked off</b> – nothing is deleted. Day and time: Settings → Devices &amp; services → Shopping list → Configure.</li></ul>`)}
      ${sec("🩺", "Health", `<ul>
        <li><b>All OK?</b> looks for broken entries (photos, barcodes, recipes). It only repairs what you tick.</li>
        <li><b>Error log:</b> technical errors with a “Copy” button – handy if you need help.</li>
        <li><b>Sensor:</b> <code>sensor.einkaufsliste_gesundheit</code> shows the health light in Home Assistant (ok / hinweis / problem) – you can use it in automations, e.g. a message to your phone.</li>
        <li><b>Resources:</b> how big the data and photos are.</li></ul>`)}
      ${sec("📱", "App & info", `<ul>
        <li><b>Offline app:</b> your own address with “Copy”. Open it in the phone browser and add it to the home screen.</li>
        <li><b>Light / dark:</b> only in the offline app.</li>
        <li><b>Protection (PIN):</b> with a PIN the ⚙️ only opens after entering it (4–8 digits, remembered for 10 minutes on this device). The 🔓 button locks at once. Forgot it? An admin resets it in Settings → Devices &amp; services → Shopping list → Configure. The PIN protects against accidents, it is not a safe.</li>
        <li><b>What's new</b> and <b>Credits</b> are at the end of the list.</li></ul>`)}
    </div>`;
    }
    return `<div class="elg">
      <div class="elg-top"><h2>⚙️ So funktionieren die Einstellungen</h2></div>
      <p class="elg-sub">Tipp auf eine Überschrift klappt sie auf. Diese Anleitung ist nur für alle, die ins Zahnrad kommen. Die Anleitung fürs Einkaufen und die Rezepte steht hinter dem <b>Einkaufswagen oben links</b>.</p>
      ${sec("🔍", "Wie finde ich etwas?", `<ul>
        <li>Die Einstellungen sind eine <b>Liste mit Überschriften</b> und nur eine Ebene tief: Überschrift antippen (sie klappt auf, die vorherige zu), Zeile antippen, etwas ändern, mit <b>Übersicht</b> wieder zurück.</li>
        <li>Das <b>Suchfeld</b> oben findet Zeilen nach Name oder Thema, z. B. „Foto“, „Mail“, „Sicherung“ oder „Sensor“.</li>
        <li>Der Balken ganz oben zeigt die <b>Gesundheits-Ampel</b> 🟢🟡🔴. Antippen öffnet „Alles ok?“.</li></ul>`, true)}
      ${sec("📋", "Meine Liste", `<ul>
        <li><b>Geschäfte:</b> pro Geschäft eine Zeile: Farbe, Icon, 📍 Zone(n) für „Nächstes Geschäft zuerst“, Eigenmarken und die Reihenfolge der Kategorien. Auch mehrere Zonen pro Geschäft gehen (z. B. mehrere Filialen).</li>
        <li><b>Kategorien:</b> Name, Farbe, Icon, Reihenfolge.</li>
        <li><b>Personen:</b> die Namen für die Schnellknöpfe bei „Für wen?“.</li>
        <li><b>Produkte:</b> <b>Alle Produkte</b> (antippen = ändern oder ganz löschen, Umbenennen zieht Fotos, Barcodes und Rezepte mit), <b>Neu gescannt</b> (Name prüfen, dann ✔ Passt) und <b>Einkaufsliste Produkte löschen</b>.</li>
        <li><b>Filter „🗓️ Seit 3 Monaten nicht gekauft“:</b> zeigt Produkte, die vor mehr als 3 Monaten zuletzt abgehakt wurden (nie abgehakt: gezählt ab dem Eintragen). Produkte, die auf der Liste oder in einem Rezept stehen, fehlen hier. Antippen zum Ansehen, oder <b>Alle löschen</b> auf einmal.</li>
        <li><b>➕ Neues Produkt / ▥ Per Barcode:</b> legt ein Produkt im Katalog an. Per Barcode: scannen, Namen bestätigen, fertig – der Barcode gehört gleich dazu.</li>
        <li><b>🧲 Zusammenführen:</b> im Produkt macht aus zwei Namen einen (Fotos, Barcodes, Artikel und Rezepte ziehen mit).</li>
        <li><b>Rezepte:</b> ein Reiter für die Rezepte, einer für die Gruppen (Fisch, Fleisch, Gebäck …).</li></ul>`)}
      ${sec("🎛️", "Extras", `<ul>
        <li>Jede Zeile hat ihre <b>eigene Seite</b> mit einem Ein/Ausschalten-Knopf: 🏷️ Angebote, 🧾 Einkaufs-Protokoll, 📍 Laden-Modus automatisch, 🛒😊 Maskottchen.</li>
        <li><b>Gilt für alle Geräte:</b> Protokoll, automatisch fragen, Laden-Modus automatisch und Maskottchen. Beim Laden-Modus bleibt der Standort bei jedem selbst – er geht nur an, wenn <b>dein</b> Handy in die Zone kommt.</li>
        <li><b>🏷️ Angebote</b> brauchen eine Postleitzahl (nur Admins). Sie kommen inoffiziell von Marktguru und können jederzeit aufhören zu funktionieren.</li></ul>`)}
      ${sec("💾", "Daten", `<ul>
        <li><b>Import &amp; Sicherung:</b> Rezepte aus Datei · andere Apps (Bring!/AnyList-Tabellen als CSV und eine Alexa-/To-do-Liste) · 📧 E-Mail · Sicherung. Nur für Admins.</li>
        <li><b>Verlauf:</b> wer hat wann was gemacht, mit Filtern und Suche. Wie viele Tage er bleibt, stellst du dort ein.</li>
        <li><b>Aufräumen:</b> einmal pro Woche werden alte offene Sachen <b>abgehakt</b> – gelöscht wird nichts. Tag und Uhrzeit: Einstellungen → Geräte &amp; Dienste → Einkaufsliste → Konfigurieren.</li></ul>`)}
      ${sec("🩺", "Gesundheit", `<ul>
        <li><b>Alles ok?</b> sucht kaputte Einträge (Fotos, Barcodes, Rezepte). Repariert wird nur, was du anhakst.</li>
        <li><b>Fehler-Protokoll:</b> technische Fehler mit „Kopieren“-Knopf – praktisch, wenn du Hilfe brauchst.</li>
        <li><b>Sensor:</b> <code>sensor.einkaufsliste_gesundheit</code> zeigt die Ampel in Home Assistant (ok / hinweis / problem) – nutzbar in Automationen, z. B. für eine Meldung aufs Handy.</li>
        <li><b>Ressourcen:</b> wie groß Daten und Fotos sind.</li></ul>`)}
      ${sec("📱", "App & Info", `<ul>
        <li><b>Offline-App:</b> deine eigene Adresse mit „Kopieren“. Im Handy-Browser öffnen und zum Startbildschirm hinzufügen.</li>
        <li><b>Hell / Dunkel:</b> nur in der Offline-App.</li>
        <li><b>Schutz (PIN):</b> mit PIN geht das ⚙️ erst nach Eingabe auf (4–8 Ziffern, auf diesem Gerät 10 Minuten gemerkt). Der 🔓-Knopf sperrt sofort. Vergessen? Ein Admin setzt sie zurück: Einstellungen → Geräte &amp; Dienste → Einkaufsliste → Konfigurieren. Die PIN schützt vor Versehen, ein Tresor ist sie nicht.</li>
        <li><b>Was ist neu</b> und <b>Credits</b> stehen am Ende der Liste.</li></ul>`)}
    </div>`;
  }

  // 📊 Ressourcen: Dateigrößen und wie viel drinsteht
  async _loadStats() {
    let st;
    try { st = await this._ws({ type: "einkaufsliste/stats" }); } catch (_) { return; }
    const box = this.$("statsBox");
    if (!box || !st) return;
    const mb = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(1).replace(".", ",")} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
    const row = (icon, label, val) => `<div class="statrow"><ha-icon icon="${icon}"></ha-icon><span class="grow">${label}</span><b translate="no">${val}</b></div>`;
    box.innerHTML = `<div class="stats">
      ${row("mdi:database-outline", "Daten (Liste, Produkte, Rezepte, Verlauf)", mb(st.data_bytes))}
      ${row("mdi:image-multiple-outline", `Fotos (${st.photo_files})`, mb(st.photo_bytes))}
      ${row("mdi:harddisk", "Zusammen", mb(st.data_bytes + st.photo_bytes))}
      ${row("mdi:format-list-checks", "Artikel auf der Liste (offen)", `${st.items} (${st.open})`)}
      ${row("mdi:package-variant-closed", "Bekannte Produkte", st.products)}
      ${row("mdi:chef-hat", "Rezepte", st.recipes)}
      ${row("mdi:barcode", "Barcodes", st.barcodes)}
      ${row("mdi:history", `Verlauf (${st.log_days} Tage)`, st.log)}
    </div>
    <p class="hint">Rechenleistung braucht die Einkaufsliste nur kurz, wenn jemand etwas ändert – sonst schläft sie. Viel Platz belegen fast nur die Fotos; der Verlauf räumt sich nach ${st.log_days} Tagen selbst auf.</p>`;
  }

  // 🙏 Credits – in ⚙️ und in der Anleitung (dort dunkel)
  _newsHtml(en = EL_LANG !== "de") {
    return `<div ${en ? 'translate="no"' : ""}><p class="hint">${en ? "This is what changed in version" : "Das hat sich in Version"} <b>${EL_VERSION}</b>${en ? ":" : " geändert:"}</p><ul>${EL_NEWS.map((n) => `<li>${en ? n[1] : n[0]}</li>`).join("")}</ul></div>`;
  }

  _creditsHtml(en = EL_LANG !== "de") {
    const repo = "https://github.com/misterm2310/einkaufslisten-card";
    const t = (de, eng) => (en ? eng : de);
    return `<div class="elcredits" translate="no">
      <div class="ellogo"><img src="${EL_BASE}/mister-m.webp?v=${EL_VERSION}" alt="Mister-M" loading="lazy"></div>
      <p class="elcv"><b>${t("Einkaufsliste", "Shopping list")}</b> v${EL_VERSION}</p>
      <p>${t("Gemacht von <b>Mister-M</b> – mit Hilfe von Claude 🤖", "Made by <b>Mister-M</b> – with help from Claude 🤖")}</p>
      <p>${t("Ich versuche, Updates und Fehler-Korrekturen zeitnah zu erledigen.", "I try to ship updates and fixes promptly.")}</p>
      <div class="elcbtns">
        <a class="elcbtn" href="${repo}" target="_blank" rel="noopener">🐙 GitHub</a>
        <a class="elcbtn" href="${repo}/issues" target="_blank" rel="noopener">🐞 ${t("Fehler melden / Wunsch äußern", "Report a bug / request a feature")}</a>
      </div>
      <p>🔒 ${t("Alle Daten bleiben in deinem Home Assistant. Ins Internet geht nur, was du selbst anstößt: ein gescannter Barcode (Nachschlagen bei Open Food Facts) oder ein Rezept-Link.",
        "All data stays in your Home Assistant. Only what you trigger yourself goes to the internet: a scanned barcode (looked up at Open Food Facts) or a recipe link.")}</p>
      <p class="elcsmall">${t("Lizenz", "License")}: MIT</p>
    </div>`;
  }

  // 📱 Abschnitt „Als App aufs Handy“ – mit Adresse zum Kopieren (auch für alle ohne Zahnrad)
  _guideAppSec(sec) {
    if (location.pathname.startsWith("/einkaufsliste/app/")) return ""; // wir sind schon in der App 😉
    const en = EL_LANG !== "de";
    const url = this._data?.settings?.app_url;
    const box = url
      ? `<input class="elg-url" readonly value="${esc(url)}"><button type="button" class="elg-copy">📋 ${en ? "Copy" : "Kopieren"}</button>`
      : `<p>${en ? "⚠️ Home Assistant has no https address yet (e.g. Nabu Casa). Ask whoever set it up."
        : "⚠️ Home Assistant hat noch keine https-Adresse (z. B. Nabu Casa). Frag den, der Home Assistant eingerichtet hat."}</p>`;
    return en
      ? sec("📱", "As an app on your phone", `<ul>
        <li>The shopping list also comes as its <b>own app</b> on your home screen. It even opens <b>without a connection</b>.</li></ul>
        <ol><li>Copy the address</li><li>Paste it into your phone's <b>browser</b> (Chrome/Safari, not the HA app)</li>
        <li>Log in with your Home Assistant user</li><li>Browser menu → <b>“Add to Home screen”</b></li></ol>${box}`)
      : sec("📱", "Als App aufs Handy", `<ul>
        <li>Die Einkaufsliste gibt's auch als <b>eigene App</b> auf dem Startbildschirm. Die öffnet sogar <b>ohne Netz</b>.</li></ul>
        <ol><li>Adresse kopieren</li><li>Im Handy-<b>Browser</b> einfügen (Chrome/Safari, nicht die HA-App)</li>
        <li>Mit deinem Home-Assistant-Benutzer anmelden</li><li>Browser-Menü → <b>„Zum Startbildschirm hinzufügen“</b></li></ol>${box}`);
  }

  // 📖 Die Anleitung auf Englisch (für alle, deren Home Assistant nicht auf Deutsch läuft)
  _guideEn(sec, appSec = "") {
    return `<div class="elg" translate="no">
      <div class="elg-top"><h2>🛒 How the shopping list works</h2></div>
      <p class="elg-sub">Tap a heading to open it. You can always find this guide via the <b>shopping cart at the top left</b>.</p>
      ${sec("🆕", "What's new", this._newsHtml(true))}
      ${sec("✍️", "Adding things", `<ul>
        <li>Type into the field at the top, e.g. <b>milk</b>, then tap the green check mark <span class="elg-k">✔</span>.</li>
        <li>While typing you get up to <b>2 suggestions</b>. Tapping one takes over everything from last time (quantity, note, for whom, store).</li>
        <li>Quantities work directly too: <b>3 milk</b> or <b>500 g flour</b>. The list remembers the unit: <b>2 baking powder</b> becomes 2 packs.</li>
        <li><b>Several at once:</b> <b>milk, 6 eggs, bread</b> → ✔ → 3 things on the list.</li>
        <li>The buttons below: 🔢 quantity · 📝 note (e.g. variety) · 👤 for whom · 📷 photo · 📋 read a list from a photo · 🧽 clear everything.</li>
        <li>Below that <b>“Which store?”</b> – or “Anywhere”. Usually it's already picked correctly (like last time).</li>
        <li>Next to it the <b>category</b> – the list usually picks it itself. If it's wrong, just change it.</li>
        <li>Typing a <b>name</b> (e.g. yours) shows what's on the list for that person.</li>
        <li>Typo? The list asks “Did you mean …?” 😉</li></ul>`, true)}
      ${appSec}
      ${sec("✅", "Checking off & adding again", `<ul>
        <li><b>Tap the circle</b> = bought. The phone vibrates briefly.</li>
        <li>Bought things slide down to <b>“Done – bought before”</b>.</li>
        <li>Tap the circle there = <b>back on the list</b>. No need to type anything again.</li>
        <li>Once a week the list tidies itself up: old things get checked off, <b>nothing gets deleted</b>.</li></ul>`)}
      ${sec("📸", "Text from photo & new helpers", `<ul>
        <li><b>📋 below the input field:</b> reads <b>a shopping note only</b>: photograph it, check the text, add it to the list. Printed text works well, handwriting only with luck – so you can correct the text first.</li>
        <li><b>Receipt:</b> not via the 📋, but in the purchase log with “📷 Read receipt” – amount, store and day are suggested.</li>
        <li><b>🧲 Merge:</b> in the product editor turn two identical products into one.</li>
        <li><b>🩺 Health light &amp; 🐞 error log:</b> in the settings – shows whether everything runs.</li>
        <li><b>🛍️ Automatic shop mode:</b> switches on when you enter a store (applies to all devices, optional – location stays personal).</li>
        <li><b>Recipes:</b> a photo per step in cooking mode. To read a recipe from a cookbook page use “📷 From photo” <b>in the recipe editor</b> – not the 📋.</li>
        <li><b>Offline:</b> photos taken without network are sent later.</li>
      </ul>`)}
      ${sec("🏪", "Stores & tabs", `<ul>
        <li>At the top the tabs: <b>All</b> and your stores. The number shows how much is still open there.</li>
        <li>The <b>red bubble</b> means: something new was added since you last looked.</li>
        <li><b>✨</b> on the item = new from someone else. It stays until you <b>check the item off</b> or <b>tap the ✨</b> – 24 hours at most.</li>
        <li><b>⇄</b> on the item = was out: <b>“Here again next time”</b> (stays open, everyone sees “was out”) or move it straight to another store. Stores with ✓ carry the product too.</li>
        <li><b>🔁 Also available here</b> (in a store's tab): things listed at another store that this store has too. Tap to bring them here.</li>
        <li>No connection in the store? Just keep checking things off. The dot at the top turns <b>orange ⏳</b> and everything is sent once there's a connection again.</li></ul>`)}
      ${sec("👆", "Changing & long-press", `<ul>
        <li><b>Long-press</b> an item = menu: edit, move, quantity, category, photo, barcode.</li>
        <li>Change the quantity directly: tap the quantity, then <span class="elg-k">−</span> and <span class="elg-k">＋</span>.</li>
        <li>Below the item in small print: the <b>store in its color</b>, the <b>📝 note</b> (yellow background), ▥ (has a barcode), who added it and who checked it off.</li>
        <li><b>🏷️</b> at the front of an item = on offer right now (only if turned on in the settings). Tap or long-press → <b>Offers</b>: store, price, how long. <b>🛒 Buy here</b> creates the offer item at that store (with its name and “🏷️ price until day” in its own field) and checks off the original product. Items from offers are gone completely when you check them off.</li>
        <li><b>Searching offers:</b> just type the product at the top (e.g. “coffee”) – below the suggestions there's <b>🏷️ Show offers for “coffee”</b>. Use <b>➕ Add to list</b> to put it on the list at the right store.</li>
        <li><b>⌛ Offer over</b> = the offer has expired. The item stays on the list, only the offer price is gone; the note shows for 1 day. An item that was created by the offer is then deleted and your original product goes back on the list.</li>
        <li>Honestly: the offers come unofficially from Marktguru and may stop working at any time.</li></ul>`)}
      ${sec("🛍️", "In the store", `<ul>
        <li>The <b>cart at the top right</b> switches on <b>shop mode</b>: big rows, checking off only, just the essentials.</li>
        <li>Tap again (or <b>Finish</b>) = back to normal.</li>
        <li>If your location says you are in the store, <b>▥</b> (top, next to the green dot) checks off the scanned product right away – if it is on the list.</li></ul>`)}
      ${sec("🧾", "Purchase log", `<ul>
        <li>Only there if it is switched on in ⚙️ → App &amp; appearance → <b>Purchase log</b> (applies to everyone).</li>
        <li>The <b>🧾 button</b> at the top of the card (and in the history) opens it. <b>➕ Add</b>: store, amount, date – the list fills in who and when.</li>
        <li><b>📊 Overview</b>: in total, per store and per month. Filters for person, store and date, quick buttons <b>This month / Last month / All</b>.</li>
        <li>Entered something wrong? Tap <b>✖</b> on the purchase.</li></ul>`)}
      ${sec("📷", "Photos", `<ul>
        <li><b>Product photo:</b> When adding, tap the <b>📷</b> below the input field – or later <b>long-press the item → Photo</b>. The photo belongs to the product and is there again next time. On the item the small <b>📷</b> shows it large; swipe = browse. Up to <b>6 photos</b> per product, a new one never replaces an old one.</li>
        <li><b>Where does the photo come from?</b> On a phone the card asks: <b>📷 Camera</b> · <b>🖼️ Gallery</b> · <b>📋 Paste</b> (a copied image). On a PC a window opens: <b>drag in</b> an image, press <b>Ctrl + V</b> or click. In the HA app on Wi-Fi (local http address) there is no camera – the gallery opens right away.</li>
        <li><b>Rotate &amp; crop:</b> Before saving you can rotate the photo and choose the crop.</li>
        <li><b>Recipe photos:</b> Add photos to a recipe in the recipe editor. In the recipe list the <b>📷</b> next to the name opens them.</li>
        <li><b>Photo for a cooking step:</b> In the recipe editor all steps are listed below the instructions. Tap <b>“Photo”</b> or <b>“Add”</b> at a step (works once the recipe has been saved). In <b>cooking mode</b> the photo shows up at exactly that step. The photos are tied to the step number – if you change the order, please check them.</li>
        <li><b>Receipt photo:</b> In the purchase log “📷 Read receipt” attaches the receipt photo automatically. An entry without a photo has a <b>➕📷</b> symbol; with a photo the <b>📷</b> opens it.</li>
        <li><b>🎉 Ask automatically (option):</b> can be switched on in the settings under the purchase log (applies to everyone). Once everything on the list is checked off, “log purchase” opens by itself – with the store already chosen. At most every 10 minutes.</li>
        <li><b>Without network:</b> Photos you take in the offline app without network are queued (“📴 Photo queued”) and uploaded as soon as the network is back. Very large photos (over about 3 MB) need a connection.</li>
        <li><b>Manage &amp; delete:</b> Only in ⚙️ → <b>Products</b> (order, main photo, delete one) and in the recipe editor – not in the shopping list itself.</li>
        <li><b>Reading text from a photo:</b> That is something different from storing a photo. See “Text from photo &amp; new helpers”.</li></ul>`)}
      ${sec("▥", "Barcodes", `<ul>
        <li><b>▥</b> at the top next to the green dot = scan a barcode (in the HA app and the offline app): the product is recognized and added.</li>
        <li>Assign a barcode later: long-press the item → <b>Barcode</b>.</li>
        <li>New product with your own name? When adding, tap the <b>▥ with a plus</b> (next to the photo icon), scan, type the name, ✔ – the barcode belongs to it right away.</li></ul>`)}
      ${sec("👨‍🍳", "Recipes", `<ul>
        <li>The <b>chef's hat</b> at the top opens the recipes. The search also finds ingredients (e.g. “zucchini”).</li>
        <li><b>Add to list</b>: tick what you need. Whatever is already on the list or “we always have it” (🧂) is not ticked.</li>
        <li><b>👥 For how many?</b> or <b>🍕🍰 How many trays?</b> With − / ＋ the quantities are recalculated.</li>
        <li>If it says <b>“Never bought – where to buy?”</b>, just pick the store.</li>
        <li><b>Off the list (3)</b> takes this recipe's ingredients off again.</li>
        <li>📷 = recipe photos · <b>🔥 Cook</b> = step by step in large print · <b>Share</b> = e.g. via WhatsApp.</li>
        <li>Checked recipe ingredients disappear completely (not under “Done”).</li>
        <li><b>⏲️ Cooking times</b> (at the top of the recipes and in cook mode): cheat sheet by appliance: 🍲 stove, 🔥 oven, 💨 air fryer.</li></ul>`)}
      ${sec("🟢", "What do the symbols at the top mean?", `<ul>
        <li>From the left: <b>🛒 shopping cart</b> = this guide · <b>🟢 dot</b> · <b>number</b> · <b>▥ barcode</b>.</li>
        <li><b>🟢 Green dot</b> = connected, everything is live on all phones. <b>🔴 Red</b> = no connection right now.</li>
        <li>The <b>number</b> = this many things are still open.</li>
        <li>Right: <b>cart</b> = shop mode · <b>chef's hat</b> = recipes.</li>
        <li>A <b>blue bar</b> at the top = there's an update that someone with admin access has to finish in Home Assistant.</li></ul>`)}
      ${sec("🙏", "Credits", this._creditsHtml(true))}
    </div>`;
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
    const bIng = ovButton("🥕 Zutaten"), bGar = ovButton("⏲️"), bClose = ovButton("✕");
    bGar.title = elT("Gar-Zeiten");
    bGar.onclick = () => showGarTable();
    head.append(title, bIng, bGar, bClose);
    const heatBox = document.createElement("div");
    Object.assign(heatBox.style, { ...wrapW, display: heat.length ? "flex" : "none", flexDirection: "column", gap: "6px", marginTop: "14px" });
    heatBox.innerHTML = heat.map((h) => `<div style="background:#3a1f0f;border:1px solid #a64b12;color:#ffd7b5;border-radius:12px;padding:10px 12px;font:600 17px Roboto,sans-serif">${esc(heatText(h))}</div>`).join("");
    const pos = document.createElement("div");
    Object.assign(pos.style, { ...wrapW, color: "#aaa", font: "600 16px Roboto,sans-serif", margin: "28px 0 10px" });
    const text = document.createElement("div");
    Object.assign(text.style, { ...wrapW, font: "500 clamp(22px, 6vw, 34px)/1.35 Roboto,sans-serif", whiteSpace: "pre-wrap", minHeight: "4.2em" });
    const pic = document.createElement("div"); // 📷 Foto zum Schritt (falls eins da ist)
    Object.assign(pic.style, { ...wrapW, display: "none", marginTop: "14px", textAlign: "center" });
    const nav = document.createElement("div");
    Object.assign(nav.style, { ...wrapW, display: "flex", gap: "10px", marginTop: "22px" });
    const bPrev = ovButton("‹ Zurück"), bNext = ovButton("Weiter ›", true);
    for (const b of [bPrev, bNext]) Object.assign(b.style, { flex: "1", padding: "16px", fontSize: "18px" });
    nav.append(bPrev, bNext);
    const ing = document.createElement("div");
    Object.assign(ing.style, { ...wrapW, display: "none", font: "17px/1.6 Roboto,sans-serif", color: "#ddd", marginTop: "22px" });
    ing.innerHTML = r.items.map((i) => `• ${esc([i.quantity, i.name].filter(Boolean).join(" "))}${i.note ? ` <span style="background:rgba(249,168,37,.22);border-radius:6px;padding:0 6px;">📝 ${esc(i.note)}</span>` : ""}`).join("<br>");
    ov.append(head, heatBox, pos, text, pic, nav, ing);
    const show = () => {
      pos.textContent = `Schritt ${idx + 1} von ${steps.length}`;
      text.textContent = steps[idx];
      pic.style.display = "none";
      pic.innerHTML = "";
      const skey = r.id && r.steps ? this._stepPhotoKey(r.id, idx) : "";
      if (skey && this._hasPhoto(skey)) {
        const at = idx;
        this._photoData(skey, 0).then((src) => {
          if (at !== idx) return; // inzwischen weitergeblättert
          const img = document.createElement("img");
          img.src = src;
          Object.assign(img.style, { maxWidth: "100%", maxHeight: "40vh", borderRadius: "14px" });
          pic.append(img);
          pic.style.display = "block";
        }).catch(() => { /* kein Foto – kein Problem */ });
      }
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
    const lines = [`🍳 ${r.name}`, "", r.servings ? `Zutaten (für ${r.servings} ${servLabel(r.servings_unit, r.servings)}):` : "Zutaten:"];
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
  // 🏷️ Angebote (Marktguru) zu einem Artikel
  _offersFor(item) {
    return (this._data?.offers || {})[String(item?.name || "").toLowerCase()] || [];
  }

  // 🏷️ „🏷️ 1,19 € bis Sa.“ – liegt der Start in der Zukunft: „ab Mo.“
  _offerLabel(off) {
    const day = (iso) => { const d = new Date(iso); return `${WD_SHORT[pyWd(d)]}.`; };
    const price = `${Number(off.p).toFixed(2).replace(".", ",")} €`;
    let when = "";
    if (off.from && new Date(off.from) > new Date()) when = ` <span>ab</span> ${day(off.from)}`;
    else if (off.to) when = ` <span>bis</span> ${day(off.to)}`;
    return `🏷️ ${price}${when}`;
  }

  _showOffers(item) {
    const list = this._offersFor(item);
    if (!list.length) return;
    this._offersOverlay(`🏷️ <span translate="no">${esc(item.name)}</span> <span>im Angebot</span>`, list, "🛒 Hier kaufen",
      (o, close) => this._takeOffer(o, { item }).then((ok) => ok && close()));
  }

  // 🔎 Angebote zu einem getippten Produkt
  async _searchOffers(q) {
    this._toast(`🏷️ Suche Angebote für „${q}“ …`);
    let list;
    try { list = await this._ws({ type: "einkaufsliste/offers/search", q }); } catch (_) { return; }
    if (!list?.length) { this._toast(`🏷️ Gerade keine Angebote für „${q}“ gefunden`); return; }
    this._offersOverlay(`🏷️ <span>Angebote für</span> „<span translate="no">${esc(q)}</span>“`, list, "➕ Auf die Liste",
      (o, close) => this._takeOffer(o, { name: q }).then((ok) => {
        if (!ok) return;
        close();
        const inp = this.$("inName");
        if (inp) { inp.value = ""; this._renderSuggest(); this._updateTools?.(); }
      }));
  }

  _offersOverlay(titleHtml, list, btnLabel, onTake) {
    const eur = (n) => `${Number(n).toFixed(2).replace(".", ",")} €`;
    const day = (iso) => { if (!iso) return ""; const d = new Date(iso); return `${WD_SHORT[pyWd(d)]}. ${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}.`; };
    const ov = makeOverlay();
    Object.assign(ov.style, { justifyContent: "flex-start", overflowY: "auto", touchAction: "auto" });
    const card = document.createElement("div");
    Object.assign(card.style, { background: "#1e1e1e", borderRadius: "16px", padding: "18px", maxWidth: "460px", width: "100%", marginTop: "4vh", lineHeight: "1.45" });
    card.innerHTML = `<div style="font:600 19px Roboto,sans-serif;margin-bottom:10px">${titleHtml}</div>
      ${list.map((o, n) => `<div style="padding:10px 0;border-top:1px solid #333"><div style="display:flex;gap:12px;align-items:center">
        ${o.img ? `<img src="${esc(o.img)}" alt="" loading="lazy" style="width:64px;height:64px;object-fit:contain;background:#fff;border-radius:8px;flex:none" onerror="this.remove()">` : ""}
        <div style="flex:1;min-width:0">
          <div><b translate="no">${esc(o.r)}</b></div>
          <div style="color:#ccc;font-size:13px" translate="no">${esc(o.d || "")}${o.q ? ` · ${esc(o.q)}` : ""}</div>
          <div style="font-size:13px;color:#aaa">${o.from ? `<span>ab</span> ${esc(day(o.from))} ` : ""}${o.to ? `<span>bis</span> ${esc(day(o.to))}` : ""}</div>
        </div>
        <div style="text-align:right;flex:none"><div style="font:700 18px Roboto,sans-serif;color:#81c784">${eur(o.p)}</div>${o.op ? `<div style="color:#999;text-decoration:line-through;font-size:13px">${eur(o.op)}</div>` : ""}</div>
      </div><div style="text-align:right;margin-top:6px"><button type="button" data-take="${n}" style="${OV_BTN_MAIN}padding:7px 12px">${esc(elT(btnLabel))}</button></div></div>`).join("")}
      <div style="color:#888;font-size:12px;margin-top:10px">Quelle: Marktguru (inoffiziell) · Angaben ohne Gewähr · kann jederzeit aufhören zu funktionieren</div>`;
    const close = () => ov.remove();
    card.querySelectorAll("[data-take]").forEach((b) => { b.onclick = () => onTake(list[Number(b.dataset.take)], close); });
    const b = ovButton("Schließen", true);
    b.style.marginTop = "14px";
    b.onclick = close;
    card.appendChild(b);
    ov.appendChild(card);
    ov.addEventListener("click", (e) => { if (e.target === ov) close(); });
  }

  // 🏪 „ALDI SÜD“ -> dein Geschäft „Aldi“
  _storeForRetailer(r) {
    const norm = (x) => String(x || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    const rn = norm(r);
    if (!rn) return null;
    return this._data.stores.find((st) => { const n = norm(st.name); return n && (n === rn || rn.split(" ").includes(n) || rn.startsWith(n + " ") || n.startsWith(rn + " ")); }) || null;
  }

  // 🛒 Angebot übernehmen: Geschäft zuordnen (sonst fragen: anlegen oder „Egal wo“), Preis als Notiz
  async _takeOffer(o, { item = null, name = null } = {}) {
    let store = this._storeForRetailer(o.r);
    if (!store) {
      const how = await askChoice(`„${o.r}“ gibt es bei dir noch nicht als Geschäft.`, [["new", `➕ „${o.r}“ anlegen`], ["none", "🤷 Egal wo"]]);
      if (!how) return false;
      if (how === "new") {
        try { store = await this._ws({ type: "einkaufsliste/group/add", kind: "stores", name: o.r }); } catch (_) { return false; }
      }
    }
    try {
      const res = await this._ws({ type: "einkaufsliste/offers/take", offer: { p: o.p, to: o.to || null, from: o.from || null, r: o.r, d: o.d || null },
        ...(item ? { item_id: item.id } : { name }), store_id: store?.id || null });
      this._toast(`🛒 ${res?.name || item?.name || name}: ${store ? store.name : "Egal wo"} · ${Number(o.p).toFixed(2).replace(".", ",")} €`);
      return true;
    } catch (_) { return false; }
  }

  _offersHtml() {
    const o = this._data.settings?.offers;
    const on = !!o?.enabled;
    const admin = !!this._hass?.user?.is_admin;
    const last = o?.last ? new Date(o.last) : null;
    const status = !on ? "" : o.ok === false ? `<p><b>⚠️ Angebote gerade nicht verfügbar.</b> <span>${esc(o.error || "")}</span></p>`
      : last ? `<p><b>✅ An</b> <span>· zuletzt</span> ${WD_SHORT[pyWd(last)]}. ${String(last.getHours()).padStart(2, "0")}:${String(last.getMinutes()).padStart(2, "0")} <span>·</span> ${o.count || 0} <span>Angebote gefunden</span></p>`
      : `<p><b>✅ An</b> <span>– die ersten Angebote kommen in ein paar Minuten.</span></p>`;
    return `
      <p class="hint"><b>🏷️ Angebote aus den Prospekten</b>: Steht etwas von deiner Liste gerade im Angebot, bekommt der Artikel ein kleines 🏷️. Lange drücken → <b>Angebote</b> zeigt Geschäft, Preis und wie lange es gilt.</p>
      <p class="hint warnbox">⚠️ <b>Inoffiziell.</b> Die Angebote kommen von Marktguru – ohne Absprache mit Marktguru, so wie die Webseite sie auch jedem Browser zeigt. Das kann <b>jederzeit ohne Vorwarnung aufhören</b> zu funktionieren. Die Einkaufsliste selbst läuft dann ganz normal weiter. Nachgeschaut werden nur die Namen offener Artikel und deine Postleitzahl – sonst nichts.</p>
      ${status}
      ${admin ? `
      <div class="srow"><ha-icon class="prev" icon="mdi:map-marker-outline"></ha-icon><input class="grow" id="offZip" inputmode="numeric" maxlength="5" placeholder="Postleitzahl, z. B. 48565" value="${esc(o?.zip || "")}"></div>
      <div class="pestores">🏪 <span>Nur diese Geschäfte (leer = alle):</span> ${this._data.stores.map((st) =>
        `<label class="stck" style="--c:${esc(st.color || "#888")}"><input type="checkbox" class="offstore" value="${esc(st.id)}" ${(o?.stores || []).includes(st.id) ? "checked" : ""}><span translate="no">${esc(st.name)}</span></label>`).join("")}</div>
      <div class="srow"><ha-icon class="prev" icon="mdi:timer-outline"></ha-icon><select class="grow" id="offHours" title="Wie oft nachschauen">${[3, 6, 12, 24].map((h) =>
        `<option value="${h}" ${(o?.hours || 6) === h ? "selected" : ""}>🕒 alle ${h} Std.</option>`).join("")}</select></div>
      <div class="btnrow">
        <button class="btn primary" data-act="${on ? "offers-save" : "offers-on"}"><ha-icon icon="mdi:tag-outline"></ha-icon>${on ? "Speichern" : "Einschalten"}</button>
        ${on ? `<button class="btn" data-act="offers-refresh"><ha-icon icon="mdi:refresh"></ha-icon>Jetzt nachschauen</button><button class="btn" data-act="offers-off"><ha-icon icon="mdi:close"></ha-icon>Ausschalten</button>` : ""}
      </div>` : `<p class="hint">🔒 Einschalten oder ändern kann das nur ein Admin.</p>`}`;
  }

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
  _startAppScan(onCode = (code) => this._handleCode(code), title = "🛒 Barcode scannen", description) {
    this._appScan({ title, description, altLabel: "Abbrechen", onCode });
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
    const clean = String(code || "").replace(/\D/g, "");
    const offline = () => this._hass?.connected === false;
    if (offline()) return this._localLookup(clean) || { code: clean, found: false, offline: true };
    try {
      return await this._hass.callWS({ type: "einkaufsliste/barcode/lookup", code });
    } catch (_) {
      return this._localLookup(clean) || { code: clean, found: false, offline: offline() };
    }
  }

  // 📴 Ohne Netz: Barcodes, die die Liste schon kennt, direkt im Handy nachschlagen
  _localLookup(code) {
    const d = this._data;
    if (!code || !d?.barcodes_by_name) return null;
    const bare = (x) => String(x).replace(/^0+/, "");
    const key = Object.keys(d.barcodes_by_name).find((k) => d.barcodes_by_name[k].some((c) => c === code || bare(c) === bare(code)));
    if (!key) return null;
    const [n, t = ""] = key.split("|");
    const low = (x) => String(x || "").trim().toLowerCase();
    const all = [...(d.items || []), ...(d.history || [])];
    const src = all.find((x) => this._pk(x.name, x.note) === key) || all.find((x) => low(x.name) === n);
    const cap = (x) => x.replace(/^./, (c) => c.toUpperCase());
    return {
      code, found: true, source: "gemerkt", offline: true,
      name: src?.name || cap(n),
      note: t ? (src && low(src.note) === t ? src.note : cap(t)) : null,
      store_id: src?.store_id && this._store(src.store_id) ? src.store_id : null,
      category_id: src?.category_id && this._cat(src.category_id) ? src.category_id : null,
    };
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
          await this._ws({
            type: "einkaufsliste/item/add",
            via: "scan",
            name,
            ...(res.found && res.note ? { note: res.note } : {}),
            store_id: (res.store_id && this._store(res.store_id) ? res.store_id : defaultStore) || null,
            category_id: guess && this._cat(guess) ? guess : null,
            barcode: res.code || code,
          });
          stats.added++;
          return res.found ? `✅ ${name} ist drauf${res.private_label ? ` · 🏷️ Eigenmarke von ${res.private_label}` : ""}` : `❓ Unbekannt – später umbenennen`;
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
        if (!res.found) return res.offline ? "📴 Ohne Netz kenne ich nur schon gemerkte Barcodes" : "🤔 Diesen Barcode kenne ich noch nicht";
        const want = this._pk(res.name, res.note);
        let open = this._data.items.filter((i) => !i.checked && this._pk(i.name, i.note) === want);
        if (!open.length && !res.note) open = this._data.items.filter((i) => !i.checked && i.name.toLowerCase() === res.name.toLowerCase());
        const item = open.find((i) => i.store_id === store.id) || open[0];
        if (!item) return `ℹ️ ${res.name} steht nicht auf der Liste`;
        try {
          await this._ws({ type: "einkaufsliste/item/toggle", item_id: item.id, checked: true, via: "scan", ...(!item.store_id ? { store_id: store.id } : {}) });
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
      const res = await this._lookup(code);
      this._pendingBarcode = res.code || String(code).replace(/\D/g, "");
      const nameEl = this.$("inName");
      if (res.found) {
        nameEl.value = res.name;
        if (res.note) { this.$("inNote").value = res.note; this.$("inNote").hidden = false; }
        this._catManual = false;
        if (res.category_id && this._cat(res.category_id)) this.$("inCat").value = res.category_id;
        else this._onNameInput();
        if (res.store_id && !this._fixedStore && (this._activeTab === "all" || res.private_label) && this._store(res.store_id)) this.$("inStore").value = res.store_id;
        this._toast(res.source === "gemerkt"
          ? `🔍 Kenn ich: „${res.name}${res.note ? ` · ${res.note}` : ""}“ – tippe ✅ zum Hinzufügen`
          : `🔍 Gefunden: „${res.name}“ – Name passt? Dann ✅ tippen${res.private_label ? ` · 🏷️ Eigenmarke von ${res.private_label}` : ""}`);
      } else {
        nameEl.value = "";
        this._toast(res.offline
          ? `📴 Ohne Netz kann ich neue Barcodes nicht nachschlagen – tipp den Namen ein, ich merk mir den Barcode!`
          : `🤔 Diesen Barcode kenne ich noch nicht – tipp den Namen ein, ich merk ihn mir!`);
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
    if (!this.$("qtyBox").hidden) this._renderQtyChips(); // 📏 gemerkte Einheit vom Produkt zeigen
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
    // 🧠 Bevorzugt dort, wo du es meist wirklich abhakst – sonst wie beim letzten Mal
    const usual = h.usual && this._store(h.usual) ? h.usual : h.store_id && this._store(h.store_id) ? h.store_id : null;
    if (!this._fixedStore && this._activeTab === "all" && usual) this.$("inStore").value = usual;
  }

  // 🏷️ Gruppe aus dem Namen vorschlagen – nur solange keine Gruppe selbst gewählt wurde
  _autoGroup() {
    const sel = this.$("rGroup");
    if (!sel || !this._groupAuto) return;
    const gid = guessRecipeGroup(this.$("rName")?.value, this._data.recipe_groups) || "";
    sel.value = gid;
    this.$("rGroupHint").hidden = !gid;
    this.$("rIconPrev")?.setAttribute("icon", this._rgroup(gid)?.icon || "mdi:silverware-fork-knife");
  }

  _onInput(e) {
    const t = e.target;
    if (t.id === "rName") { this._autoGroup(); return; }
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
    if (t.id === "prodFilterSel") {
      this._prodSel = t.value;
      this._renderProducts();
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
    // 📋 Mehrere auf einmal: „milch, 6 eier, brot“ -> 3 Artikel (Komma in „1,5 l“ trennt nicht)
    const parts = splitMany(name);
    if (parts.length > 1) { await this._addMany(parts); return; }
    const msg = {
      type: "einkaufsliste/item/add",
      name,
      store_id: this._fixedStore || this._inStore(),
      category_id: this.$("inCat").value || null,
    };
    for (const [key, id] of [["quantity", "inQty"], ["note", "inNote"], ["for_whom", "inFor"]]) {
      const v = this.$(id).value.trim();
      if (v) msg[key] = v;
    }
    if (this._pendingBarcode) { msg.barcode = this._pendingBarcode; msg.via = "scan"; }
    if (!msg.quantity) { const sp = splitQty(name); if (sp.qty) { msg.name = sp.name; msg.quantity = sp.bare ? sp.num : sp.qty; } }
    // 📏 Nur eine Zahl? Selbst gewählte Einheit dran – sonst nimmt Home Assistant die gemerkte Einheit (oder x)
    if (msg.quantity && isBareQty(msg.quantity) && this._qtyUnit) msg.quantity = qtyFmt(msg.quantity, this._qtyUnit);
    // Steht das schon bei einem anderen Geschäft offen? Dann erst fragen: verschieben oder zusätzlich?
    const other = this._openElsewhere({ name: msg.name, note: msg.note, for_whom: msg.for_whom }, msg.store_id);
    if (other) {
      this._conflict = { kind: "add", other: other.id, store: msg.store_id, msg };
      this._renderList();
      return;
    }
    await this._doAdd(msg);
  }

  // Jeder Artikel bekommt sein eigenes Geschäft (Reiter > Gedächtnis > Auswahl), seine Kategorie und Menge
  async _addMany(parts) {
    if (this._newPhoto) { this._toast("📷 Mit Foto bitte einzeln eintragen – das Foto gehört ja zu einem Produkt."); return; }
    if (this._pendingBarcode) { this._toast("▥ Mit Barcode bitte einzeln eintragen – der Barcode gehört ja zu einem Produkt."); return; }
    const tab = this._activeTab;
    const tabStore = this._fixedStore || (tab !== "all" && tab !== "none" && this._store(tab) ? tab : null);
    const chosen = this._inStore();
    const forWhom = this.$("inFor").value || null;
    let added = 0;
    for (const raw of parts) {
      const sp = splitQty(raw);
      const name = (sp.qty ? sp.name : raw).trim();
      if (!name) continue;
      const low = name.toLowerCase();
      const h = (this._data.history || []).find((x) => x.name.toLowerCase() === low);
      const cat = (h?.category_id && this._cat(h.category_id) ? h.category_id : null) || guessCategory(low, this._data.category_hints);
      const msg = {
        type: "einkaufsliste/item/add", name,
        store_id: tabStore || (h?.usual && this._store(h.usual) ? h.usual : null) || (h?.store_id && this._store(h.store_id) ? h.store_id : null) || chosen,
        category_id: cat && this._cat(cat) ? cat : null,
      };
      if (sp.qty) msg.quantity = sp.bare ? sp.num : sp.qty; // nur Zahl -> Home Assistant nimmt die gemerkte Einheit
      if (forWhom) msg.for_whom = forWhom;
      try { await this._ws(msg); added++; } catch (_) { /* Meldung kam schon */ }
    }
    if (added) this._toast(`✅ ${added} Artikel eingetragen`);
    this._clearForm();
    this.$("inName").focus();
  }

  async _doAdd(msg) {
    const name = msg.name;
    try {
      const item = await this._ws(msg);
      // 📈 Gab's das hier schon 3× nicht? Dann kurz Bescheid sagen
      const sid = item?.store_id ?? msg.store_id;
      const miss = item?.id && sid ? this._missedAt(item.name || name, sid) : 0;
      if (miss >= 3) this._missHint = { id: item.id, name: item.name || name, store: sid, n: miss };
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
      this._qtyUnit = null;
      this._unitMore = false;
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
        this._shopAuto = false; // von Hand geschaltet: die Automatik lässt es in Ruhe
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
        if (v === "settings" && current !== "settings" && this._data?.settings?.pin && !pinUnlocked()) {
          this._unlockSettings(); // 🔒 erst die PIN, dann das Zahnrad
          break;
        }
        this._view = current === v ? "list" : v;
        if (this._view === "settings" && current !== "settings") this._setSec = null;
        this._draft = null;
        this._renderAll();
        break;
      }
      case "new-ack":
        this._ackNew(el.dataset.id);
        this._renderList();
        break;
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
        if (!item || !elConfirm(`„${item.name}“ endgültig löschen? Dann ist es auch aus „Erledigt“ weg.`)) return;
        this._ws({ type: "einkaufsliste/item/remove", item_id: itemId })
          .then(() => { this._toast(`🗑️ „${item.name}“ gelöscht`); setTimeout(() => this._renderDelList(), 50); })
          .catch(() => {});
        break;
      }
      case "edit":
        this._editing = id;
        this._renderList();
        break;
      case "app-theme": { // 🌓 Offline-App: Hell / Dunkel / Automatisch
        try { localStorage.setItem("einkaufsliste_theme", el.dataset.v); } catch (_) { /* egal */ }
        window.dispatchEvent(new CustomEvent("einkaufsliste-theme", { detail: el.dataset.v }));
        this._schemeKey = null;
        setTimeout(() => { this._applyScheme(this._hass); this._renderSettings(); }, 50);
        break;
      }
      case "pin-lock":
        this._lockNow();
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
      case "unit-chip": { // 📏 Einheit wählen – die Zahl bleibt, die Box bleibt offen
        this._qtyUnit = el.dataset.v;
        const q = this.$("inQty");
        if (q.value.trim()) q.value = applyUnit(q.value, this._qtyUnit);
        this._renderQtyChips();
        this._updateTools();
        break;
      }
      case "last-qty": {
        this.$("inQty").value = el.dataset.v;
        this._qtyUnit = null;
        this._renderQtyChips();
        this._updateTools();
        break;
      }
      case "unit-more":
        this._unitMore = true;
        this._renderQtyChips();
        break;
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
      case "new-barcode": {
        if (this._pendingBarcode) {
          this._pendingBarcode = null;
          this._updateTools();
          this._toast("▥ Barcode wieder entfernt");
          break;
        }
        this._startAppScan(async (code) => {
          const res = await this._lookup(code).catch(() => null);
          if (res?.found) { this._handleCode(code); return; } // kennt die Liste schon: wie beim normalen Scan
          this._pendingBarcode = (res?.code || String(code).replace(/\D/g, "")) || null;
          this._updateTools();
          this._toast(`▥ Barcode ist dabei – tipp den Namen ein und tippe ✅, dann merke ich ihn mir!`);
          this.$("inName").focus();
        }, "▥ Barcode für das neue Produkt", "Packung scannen, dann den Namen tippen und ✅ drücken.");
        break;
      }
      case "barcode-assign": {
        const item = this._data.items.find((i) => i.id === el.dataset.id);
        this._menuId = null;
        this._startAppScan((code) => {
          this._ws({ type: "einkaufsliste/barcode/assign", item_id: item.id, code })
            .then(() => this._toast(`▥ Barcode gespeichert – beim nächsten Scan erkenne ich „${item.name}“ sofort!`))
            .catch(() => {});
        }, `▥ Barcode für „${item.name}“`, "Packung scannen – beim nächsten Mal erkenne ich sie sofort.");
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
      case "menu-cat":
        this._menuId = null;
        this._catPick = el.dataset.id;
        this._renderList();
        break;
      case "cat-cancel":
        this._catPick = null;
        this._renderList();
        break;
      case "cat-to": {
        const itemId = el.closest(".catrow").dataset.id;
        this._catPick = null;
        this._ws({ type: "einkaufsliste/item/update", item_id: itemId, category_id: el.dataset.cat })
          .then(() => this._toast("📦 Kategorie geändert")).catch(() => {});
        this._renderList();
        break;
      }
      case "menu-qty":
        this._menuId = null;
        this._qtyEdit = el.dataset.id;
        this._renderList();
        break;
      case "offers-search":
        this._searchOffers(el.dataset.q);
        break;
      case "menu-offers":
      case "offers-show": {
        const item = this._data.items.find((i) => i.id === (el.dataset.id || el.closest(".item")?.dataset.id));
        this._menuId = null;
        this._renderList();
        if (item) this._showOffers(item);
        break;
      }
      case "offers-on":
      case "offers-save": {
        const zip = this.$("offZip")?.value || "";
        const stores = [...this.shadowRoot.querySelectorAll(".offstore:checked")].map((x) => x.value);
        const hours = Number(this.$("offHours")?.value || 6);
        this._ws({ type: "einkaufsliste/offers/set", enabled: true, zip, stores, hours })
          .then(() => { this._toast("🏷️ Angebote sind an – die ersten kommen in ein paar Minuten"); setTimeout(() => this._renderSettings(), 150); })
          .catch(() => {});
        break;
      }
      case "offers-off":
        this._ws({ type: "einkaufsliste/offers/set", enabled: false })
          .then(() => { this._toast("🏷️ Angebote sind aus"); setTimeout(() => this._renderSettings(), 150); }).catch(() => {});
        break;
      case "offers-refresh":
        this._toast("🏷️ Ich schaue nach … (dauert etwa eine Sekunde pro Artikel)");
        this._ws({ type: "einkaufsliste/offers/refresh" })
          .then((r) => { this._toast(r?.ok ? `🏷️ Fertig: ${r.offers} Angebote zu ${r.items} Artikeln` : "⚠️ Angebote gerade nicht verfügbar"); setTimeout(() => this._renderSettings(), 150); })
          .catch(() => {});
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
      case "move-out": { // ⇄ war aus, bleibt hier offen
        const itemId = el.closest(".moverow").dataset.id;
        this._moving = null;
        this._ws({ type: "einkaufsliste/item/out", item_id: itemId })
          .then(() => this._toast("👍 Bleibt auf der Liste – alle sehen „war aus“")).catch(() => {});
        this._renderList();
        break;
      }
      case "move-cancel":
        this._moving = null;
        this._renderList();
        break;
      case "gar":
        showGarTable();
        break;
      case "ocr-list":
        this._ocrList();
        break;
      case "rimport-photo":
        this._ocrStart("🔎 Rezept wird gelesen", (text) => {
          const parts = elOcrRecipeParts(text);
          const nameEl = this.$("rName"), stepsEl = this.$("rSteps"), ta = this.$("rImportText");
          if (nameEl && parts.name && !nameEl.value.trim()) { nameEl.value = parts.name; this._autoGroup?.(); }
          if (stepsEl && parts.steps && !stepsEl.value.trim()) { stepsEl.value = parts.steps; this._renderStepPhotos?.(); }
          if (ta) { this.$("rImport").hidden = false; ta.value = parts.ingredients; ta.focus(); }
          this._toast("📷 Gelesen – bitte die Zutaten prüfen und auf „Übernehmen“ tippen");
        }, "🍳 Rezept abfotografieren");
        break;
      case "errors-copy":
        elCopy(this._errorsText(), null).then(() => this._toast("📋 Fehler-Protokoll kopiert"));
        break;
      case "errors-clear":
        if (!elConfirm("Das Fehler-Protokoll leeren?")) break;
        this._ws({ type: "einkaufsliste/errors/clear" }).then((res) => { this._errData = res; this._loadErrors(); this._toast("🧹 Fehler-Protokoll geleert"); }).catch(() => {});
        break;
      case "app-copy": {
        const inp = this.$("appUrl");
        const url = inp?.value || "";
        elCopy(url, inp).then(() => this._toast("📋 Adresse kopiert – jetzt im Handy-Browser einfügen"));
        break;
      }
      case "miss-ok":
        this._missHint = null;
        this._renderList();
        break;
      case "miss-move": {
        const h = this._missHint;
        this._missHint = null;
        const target = this._store(el.dataset.store);
        if (!h || !target) { this._renderList(); break; }
        this._ws({ type: "einkaufsliste/item/move", item_id: h.id, store_id: target.id })
          .then(() => this._toast(`🔁 ${h.name}: jetzt bei ${target.name}`)).catch(() => this._renderList());
        break;
      }
      case "also-here": {
        const item = this._data.items.find((i) => i.id === el.dataset.id);
        const target = this._store(el.dataset.store);
        if (!item || !target) break;
        const from = this._store(item.store_id);
        this._ws({ type: "einkaufsliste/item/move", item_id: item.id, store_id: target.id })
          .then(() => this._toast(`🔁 ${item.name}: ${from ? `bei ${from.name} abgehakt, ` : ""}jetzt bei ${target.name} offen`)).catch(() => {});
        break;
      }
      case "move-to": {
        const itemId = el.closest(".moverow").dataset.id;
        const item = this._data.items.find((i) => i.id === itemId);
        const target = this._store(el.dataset.store);
        this._moving = null;
        const from = this._store(item?.store_id);
        if (!target) { // 🤷 nach „Egal wo“
          this._ws({ type: "einkaufsliste/item/move", item_id: itemId, store_id: null })
            .then(() => this._toast(`🤷 ${item?.name || "Artikel"} steht jetzt bei „Egal wo“ – also in jedem Geschäft`))
            .catch(() => this._renderList());
          break;
        }
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
          this._pickFile("newPhotoFile", "📷 Foto zum neuen Produkt");
        }
        break;
      case "photo-view":
        this._openPhoto(el.dataset.name, el.dataset.title);
        break;
      case "photo-take":
        this._takePhoto(el.dataset.name, null);
        break;
      case "photo-remove":
        if (!elConfirm(`Foto von „${this._pkLabel(el.dataset.name)}“ löschen?`)) return;
        this._ws({ type: "einkaufsliste/photo/remove", name: el.dataset.name })
          .then(() => { this._toast("Foto gelöscht 🗑️"); this._editing = null; this._renderList(); }).catch(() => {});
        break;
      case "edit-cancel":
        this._editing = null;
        this._renderList();
        break;
      case "toggle-donecat": {
        const key = el.dataset.cat;
        // Immer nur eine Kategorie offen: eine aufmachen schließt die anderen
        const wasOpen = this._openDoneCats.has(key);
        this._openDoneCats.clear();
        if (!wasOpen) this._openDoneCats.add(key);
        this._renderList();
        break;
      }
      case "suggest": {
        const inp = this.$("inName");
        const c = this._suggMap?.get(el.dataset.n);
        if (!c) break;
        if (c.fuzzy) { // 🧠 Tippfehler merken – ab dem 2. Mal korrigiert die Liste von selbst
          const wrong = splitQty(inp.value).name;
          if (wrong) this._hass.callWS({ type: "einkaufsliste/typo/learn", wrong, right: c.name }).catch(() => {});
        }
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
      case "store-sel":
        this._storeSel = el.dataset.id || null;
        this._renderSettings();
        this.$("otherView").scrollIntoView?.({ block: "nearest" });
        break;
      case "rec-tab":
        this._recTab = el.dataset.tab;
        this._renderSettings();
        break;
      case "set-grp": // 🗂️ eine Überschrift auf = die vorherige zu
        this._setOpen = this._setOpen === el.dataset.grp ? null : el.dataset.grp;
        this._renderSettings();
        break;
      case "set-sec":
        if (el.dataset.sec !== "stores") this._storeSel = null;
        this._setSec = el.dataset.sec || null;
        this._renderSettings();
        this.$("otherView").scrollIntoView?.({ block: "nearest" });
        break;
      case "prod-edit":
        if (elIsPc() && this._prodTab !== "scanned" && e.detail < 2) { this._prodMark(el.dataset.key); break; } // 🖥️ 1× Klick = markieren
        this._prodEdit = el.dataset.key;
        this._renderProducts();
        break;
      case "prod-add": {
        const f = this._prodSel || "";
        askText("📦 Neues Produkt", "Wie heißt das Produkt?").then((name) => name && this._ws({ type: "einkaufsliste/product/add", name, store_id: f.startsWith("s:") ? f.slice(2) : null, category_id: f.startsWith("c:") ? f.slice(2) : null })
          .then(async (p) => {
            this._toast(`📦 „${p.name}“ ist im Katalog`);
            await this._loadProducts();
            this._prodEdit = p.key;
            this._renderProducts();
          })).catch(() => {});
        break;
      }
      case "prod-add-bc": {
        const f = this._prodSel || "";
        this._startAppScan(async (code) => {
          const res = await this._lookup(code).catch(() => null);
          const clean = (res?.code || String(code).replace(/\D/g, "")) || "";
          if (!clean) { this._toast("🤔 Den Barcode konnte ich nicht lesen"); return; }
          if (res?.found && res.source === "gemerkt") { this._toast(`ℹ️ Kenn ich schon: „${res.name}${res.note ? ` · ${res.note}` : ""}“`); return; }
          const name = await askText("📦 Neues Produkt per Barcode", "Wie heißt das Produkt?", res?.found ? res.name : "");
          if (!name) return;
          this._ws({ type: "einkaufsliste/product/add", name, barcode: clean,
            store_id: f.startsWith("s:") ? f.slice(2) : null, category_id: f.startsWith("c:") ? f.slice(2) : (res?.category_id || null) })
            .then(async (p) => {
              this._toast(`📦▥ „${p.name}“ ist im Katalog – mit Barcode`);
              await this._loadProducts();
              this._prodEdit = p.key;
              this._renderProducts();
            }).catch(() => {});
        }, "▥ Neues Produkt per Barcode", "Packung scannen, dann den Namen bestätigen.");
        break;
      }
      case "prod-old-del": {
        const keys = this._oldKeys || [];
        if (!keys.length) break;
        if (!elConfirm(`${keys.length} Produkte ganz löschen?\n\nWeg sind dann: Fotos, Barcodes und Vorschläge dieser Produkte. Sie stehen weder auf der Einkaufsliste noch in einem Rezept.`)) break;
        (async () => {
          let n = 0;
          for (const key of keys) {
            try { await this._ws({ type: "einkaufsliste/product/remove", key }); n++; } catch (_) { /* weiter */ }
          }
          this._toast(`🗑️ ${n} Produkte gelöscht`);
          this._prodEdit = null;
          this._loadProducts();
        })();
        break;
      }
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
        const boxes = [...this.shadowRoot.querySelectorAll(".prodedit input.pestore")];
        if (boxes.length) msg.stores = boxes.filter((b) => b.checked).map((b) => b.value);
        const pa = this.$("peAliases");
        if (pa && pa.value.trim() !== pa.dataset.orig) msg.aliases = pa.value.split(/[,;]/).map((x) => x.trim()).filter(Boolean);
        if (!msg.name) { this.$("peName").classList.add("shake"); break; }
        this._ws(msg).then(() => { this._toast("📦 Produkt gespeichert"); this._prodEdit = null; this._loadProducts(); }).catch(() => {});
        break;
      }
      case "prod-merge":
        this._prodMerge = this._prodMerge === el.closest(".prodedit").dataset.key ? null : el.closest(".prodedit").dataset.key;
        this._renderProducts();
        break;
      case "prod-merge-go": {
        const from = el.closest(".prodedit").dataset.key;
        const into = this.$("peMerge")?.value;
        const a = (this._products || []).find((x) => x.key === from), b = (this._products || []).find((x) => x.key === into);
        if (!a || !b) break;
        const an = a.name + (a.note ? ` · ${a.note}` : ""), bn = b.name + (b.note ? ` · ${b.note}` : "");
        if (!elConfirm(`„${an}“ in „${bn}“ aufgehen lassen?\n\nArtikel, Rezepte, Fotos und Barcodes ziehen um. Das lässt sich nicht rückgängig machen.`)) break;
        this._ws({ type: "einkaufsliste/product/merge", from_key: from, into_key: into })
          .then(() => { this._toast(`🧲 „${an}“ ist jetzt bei „${bn}“`); this._prodMerge = null; this._prodEdit = null; this._loadProducts(); }).catch(() => {});
        break;
      }
      case "prod-forget": {
        const key = el.closest(".prodedit").dataset.key;
        const prod = (this._products || []).find((x) => x.key === key);
        const label = prod ? prod.name + (prod.note ? ` · ${prod.note}` : "") : key;
        const where = (this._data.recipes || []).filter((r) => r.items.some((ri) => this._pk(ri.name, ri.note) === key)).map((r) => r.name);
        const onList = this._data.items.filter((i) => !i.recipe_id && this._pk(i.name, i.note) === key).length;
        if (!elConfirm(`„${label}“ ganz löschen?\n\nWeg sind dann: Fotos, Barcodes, Vorschlag${onList ? ` und ${onList}× auf der Einkaufsliste` : ""}.`
          + (where.length ? `\n\n⚠️ Steht noch in: ${where.join(", ")}. Dort bleibt es stehen, bis du das Rezept änderst.` : ""))) break;
        this._ws({ type: "einkaufsliste/product/remove", key })
          .then(() => { this._toast(`🗑️ „${label}“ gelöscht`); this._prodEdit = null; this._loadProducts(); }).catch(() => {});
        break;
      }
      case "prod-confirm":
        e.stopPropagation?.();
        this._ws({ type: "einkaufsliste/product/confirm", key: el.dataset.key })
          .then(() => { this._toast("✔ Geprüft"); this._loadProducts(); }).catch(() => {});
        break;
      case "typo-forget":
        this._ws({ type: "einkaufsliste/typo/forget", wrong: el.dataset.w })
          .then(() => { this._toast("🧠 Tippfehler vergessen"); setTimeout(() => this._renderProducts(), 300); }).catch(() => {});
        break;
      case "bc-remove": {
        const code = el.dataset.code;
        if (!elConfirm(`Barcode ${code} löschen? Das Produkt bleibt.`)) break;
        this._ws({ type: "einkaufsliste/barcode/remove", code })
          .then(() => { this._toast("▥ Barcode gelöscht"); this._loadProducts(); }).catch(() => {});
        break;
      }
      case "log-more":
        this._logMax = (this._logMax || 150) + 150;
        this._renderLogList();
        break;
      case "catord-up":
      case "catord-down": {
        const ids = this._storeCats(el.dataset.store).map((c) => c.id);
        const pos = ids.indexOf(el.dataset.cat);
        const to = act === "catord-up" ? pos - 1 : pos + 1;
        if (pos < 0 || to < 0 || to >= ids.length) return;
        [ids[pos], ids[to]] = [ids[to], ids[pos]];
        this._ws({ type: "einkaufsliste/group/update", kind: "stores", group_id: el.dataset.store, cat_order: ids })
          .then(() => this._renderSettings()).catch(() => {});
        break;
      }
      case "missed-hide":
        this._ws({ type: "einkaufsliste/missed/hide", name: el.dataset.name, store_id: el.dataset.store })
          .then(() => { this._toast("✖ Ausgeblendet – kommt nur wieder, wenn es erneut fehlt"); setTimeout(() => this._renderMissed(), 150); })
          .catch(() => {});
        break;
      case "log-clear":
        if (!elConfirm("Den ganzen Verlauf löschen? Das geht nicht rückgängig.")) break;
        this._ws({ type: "einkaufsliste/log/clear" }).then(() => { this._toast("🧽 Verlauf geleert"); this._loadLog(); }).catch(() => {});
        break;
      case "cleanup-now":
        this._ws({ type: "einkaufsliste/cleanup" })
          .then((r) => this._toast(r.checked ? `${r.checked} alte Artikel abgehakt 🧹` : "Nix zu tun – alles noch frisch! ✨")).catch(() => {});
        break;
      case "check-all":
        if (!elConfirm("Wirklich ALLE offenen Artikel abhaken?")) return;
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
        } else if (kind === "recipe_groups") {
          const used = (this._data.recipes || []).filter((r) => r.group === entry.id).length;
          if (used) txt += ` ${used} ${used === 1 ? "Rezept hat" : "Rezepte haben"} dann keine Gruppe mehr (die Rezepte bleiben).`;
        } else {
          const field = kind === "stores" ? "store_id" : "category_id";
          const used = this._data.items.filter((i) => i[field] === entry.id).length;
          if (used) txt += ` ${used} Artikel landen dann bei „${kind === "stores" ? "Egal wo" : "Ohne Kategorie"}“.`;
        }
        if (!elConfirm(txt)) return;
        this._ws({ type: "einkaufsliste/group/remove", kind, group_id: entry.id }).then(() => this._renderSettings()).catch(() => {});
        break;
      }
      case "recipe-new":
        this._openRecipe(null);
        break;
      case "autoshop-toggle": {
        const on = !this._data.settings?.auto_shop; // 📍 gilt für alle Geräte (wie das Maskottchen)
        this._ws({ type: "einkaufsliste/autoshop/set", on })
          .then(() => { this._toast(on ? "📍 Laden-Modus automatisch: an – für alle" : "Laden-Modus automatisch: aus"); setTimeout(() => this._renderSettings(), 150); }).catch(() => {});
        break;
      }
      case "tip-guide":
        this._flag("einkaufsliste_tip_guide", true);
        this._renderTip();
        this._showGuide();
        break;
      case "tip-ok":
        this._flag("einkaufsliste_tip_guide", true);
        this._renderTip();
        break;
      case "wizard-done":
        this._flag("einkaufsliste_wizard_done", true);
        this._flag("einkaufsliste_tip_guide", true);
        this._renderTip();
        break;
      case "wizard-go":
        if (el.dataset.to === "guide") { this._flag("einkaufsliste_tip_guide", true); this._showGuide(); }
        else if (el.dataset.to === "add") { this.$("inName")?.focus(); this.$("inName")?.scrollIntoView({ block: "center" }); }
        else {
          if (this._data?.settings?.pin && !pinUnlocked()) { this._unlockSettings(); break; } // 🔒 erst die PIN
          this._view = "settings"; this._setSec = "stores"; this._renderAll();
        }
        break;
      case "guide":
        this._showGuide();
        break;
      case "guide-settings":
        this._showGuide("settings");
        break;
      case "spend":
        this._showSpend();
        break;
      case "spend-toggle":
        this._ws({ type: "einkaufsliste/spend/set", on: !this._data.settings?.spend })
          .then(() => setTimeout(() => this._renderSettings(), 150)).catch(() => {});
        break;
      case "spend-auto-toggle":
        this._ws({ type: "einkaufsliste/spend/auto", on: !this._data.settings?.spend_auto })
          .then(() => setTimeout(() => this._renderSettings(), 150)).catch(() => {});
        break;
      case "check-run":
        this._runCheck();
        break;
      case "check-all":
      case "check-none":
        this.$("checkRes")?.querySelectorAll("input.chk").forEach((c) => { c.checked = act === "check-all"; });
        this._checkCount();
        break;
      case "check-fix": { // 🔧 nur die angehakten, mit der gewählten Reparatur
        const box = this.$("checkRes");
        const fixes = {};
        box?.querySelectorAll(".chkrow").forEach((row) => {
          if (!row.querySelector("input.chk").checked) return;
          fixes[row.dataset.id] = row.querySelector("select")?.value || "";
        });
        const n = Object.keys(fixes).length;
        if (!n) { this._toast("Erst anhaken, was repariert werden soll 😉"); break; }
        if (!elConfirm(`${n} ${n === 1 ? "Sache" : "Sachen"} so reparieren, wie ausgewählt?`)) break;
        this._ws({ type: "einkaufsliste/check", fixes }).then((res) => {
          this._toast(`🛠️ ${res.fixed} ${res.fixed === 1 ? "Sache" : "Sachen"} repariert`);
          this._runCheck();
        }).catch(() => {});
        break;
      }
      case "prod-tab":
        this._prodTab = el.dataset.tab;
        this._renderSettings();
        break;
      case "pin-set":
      case "pin-off":
        this._pinChange(act === "pin-off");
        break;
      case "mascot-toggle":
        this._ws({ type: "einkaufsliste/mascot/set", on: !this._data.settings?.mascot })
          .then(() => setTimeout(() => this._renderSettings(), 150)).catch(() => {});
        break;
      case "zone-del": {
        const srow = el.closest(".srow[data-kind]");
        const store = this._data.stores.find((x) => x.id === srow?.dataset.id);
        if (!store) break;
        this._ws({ type: "einkaufsliste/group/update", kind: "stores", group_id: store.id, zones: storeZones(store).filter((z) => z !== el.dataset.zone) })
          .then(() => setTimeout(() => this._renderSettings(), 150)).catch(() => {});
        break;
      }
      case "sync-on": {
        const entity_id = this.$("syncTodo")?.value;
        if (!entity_id) { this._toast("Erst eine Liste auswählen 😉"); break; }
        this._ws({ type: "einkaufsliste/todo_sync/set", entity_id, store_id: this._xferStore("syncStore"), mode: this.$("syncMode")?.value || "move" })
          .then(() => { this._toast("🔁 Ab jetzt wird automatisch herübergeholt"); setTimeout(() => this._renderSettings(), 300); }).catch(() => {});
        break;
      }
      case "mail-on": {
        const entry_id = this.$("mailSrc")?.value;
        if (!entry_id) { this._toast("Erst ein Postfach auswählen 😉"); break; }
        const senders = (this.$("mailSenders")?.value || "").split(/[,;\s]+/).filter(Boolean);
        this._ws({ type: "einkaufsliste/mail/set", entry_id, store_id: this._xferStore("mailStore"), senders, after: this.$("mailAfter")?.value || "keep" })
          .then(() => { this._toast("📧 Ab jetzt kommen Mails auf die Liste"); setTimeout(() => this._renderSettings(), 300); }).catch(() => {});
        break;
      }
      case "mail-off":
        this._ws({ type: "einkaufsliste/mail/set", entry_id: null })
          .then(() => { this._toast("📧 Per E-Mail ist aus"); setTimeout(() => this._renderSettings(), 150); }).catch(() => {});
        break;
      case "sync-off":
        this._ws({ type: "einkaufsliste/todo_sync/set", entity_id: null })
          .then(() => { this._toast("🔁 Automatisch herüberholen ist aus"); setTimeout(() => this._renderSettings(), 150); }).catch(() => {});
        break;
      case "xfer-tab":
        this._xferTab = el.dataset.tab;
        this._renderSettings();
        break;
      case "xfer-backup":
        this._xferBackup();
        break;
      case "xfer-todo": {
        const entity_id = this.$("xferTodo")?.value;
        if (!entity_id) { this._toast("Erst eine Liste auswählen 😉"); break; }
        this._ws({ type: "einkaufsliste/import/todo", entity_id, store_id: this._xferStore("xferTodoStore") })
          .then((res) => this._xferImported(res)).catch(() => {});
        break;
      }
      case "xfer-text": {
        const text = this.$("xferText")?.value || "";
        if (!text.trim()) { this._toast("Erst etwas einfügen 😉"); break; }
        this._ws({ type: "einkaufsliste/import/text", text, store_id: this._xferStore("xferTextStore") })
          .then((res) => { this._xferImported(res); if (res?.added) this.$("xferText").value = ""; }).catch(() => {});
        break;
      }
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
        this._pickPers = r.servings || null; // 👥 Standard: immer erst wie im Rezept
        this._pickStores = {};
        this._pickSel = new Set(r.items.map((it, n) => (open.has(it.name.toLowerCase()) || it.basic ? -1 : n)).filter((n) => n >= 0));
        this._renderRecipes();
        break;
      }
      case "recipe-unapply": {
        const r = this._recipe(el.closest(".recipe").dataset.id);
        if (!r || !elConfirm(`Alle offenen Zutaten von „${r.name}“ von der Liste nehmen?`)) break;
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
      case "pick-store":
        break; // Auswahl läuft über „change“
      case "pick-pers": {
        const r = this._recipe(this._pickRecipe);
        if (!r?.servings) break;
        this._pickPers = Math.max(1, Math.min(99, (this._pickPers || r.servings) + Number(el.dataset.d)));
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
        if (this._pickMissingStore(r)) { this._toast("🛒 Bitte erst das Geschäft wählen"); break; }
        const items = [...this._pickSel].sort((a, b) => a - b);
        const f = this._pickFactor(r);
        const overrides = {};
        for (const n of items) {
          const it = r.items[n];
          const o = {};
          if (f !== 1 && it.quantity) o.quantity = scaleQty(it.quantity, f);
          if (String(n) in this._pickStores) o.store_id = this._pickStores[String(n)];
          if (Object.keys(o).length) overrides[String(n)] = o;
        }
        this._pickRecipe = null;
        this._ws({ type: "einkaufsliste/recipe/apply", recipe_id: r.id, items, ...(Object.keys(overrides).length ? { overrides } : {}) })
          .then((res) => {
            this._toast(res.added
              ? `🍽️ ${res.added} Zutaten für „${r.name}“ auf der Liste${res.already ? ` (${res.already} standen schon drauf)` : ""}`
              : `Alles für „${r.name}“ steht schon auf der Liste 👍`);
            this._view = "list";
            this._renderAll();
          }).catch(() => {});
        break;
      }
      case "sphoto-take": {
        const dr = this._draft;
        if (!dr?.id) break;
        this._photoTarget = { name: this._stepPhotoKey(dr.id, el.dataset.n), keepEdit: true,
          onDone: () => { this._toast("📸 Foto zum Schritt gespeichert"); setTimeout(() => this._renderStepPhotos(), 500); } };
        this._pickFile("photoFile", this._photoHeading(this._photoTarget.name));
        break;
      }
      case "sphoto-view": {
        const dr = this._draft;
        if (dr?.id) this._openPhoto(this._stepPhotoKey(dr.id, el.dataset.n), `${dr.name || "Rezept"} – Schritt ${Number(el.dataset.n) + 1}`, 0, () => this._renderStepPhotos());
        break;
      }
      case "rphoto-take":
        this._photoTarget = { recipeDraft: true };
        this._pickFile("photoFile", "🍳 Foto zum Rezept");
        break;
      case "rphoto-view": {
        const dr = this._draft;
        if (dr?.id) this._openPhoto(this._recipePhotoKey(dr.id), this.$("rName")?.value || dr.name, 0, () => this._renderRecipePhoto());
        break;
      }
      case "rphoto-view-new": {
        const dr = this._draft;
        const list = dr?.newPhotos || [];
        if (list.length) showPhotoOverlay(list[list.length - 1], `${this.$("rName")?.value || dr.name || "Rezept"} (neu, ${list.length})`);
        break;
      }
      case "rphoto-remove":
        if (!this._draft || !elConfirm("Die neuen, noch nicht gespeicherten Fotos verwerfen?")) break;
        this._draft.newPhotos = [];
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
        if (!elConfirm(`Rezept „${this._draft.name}“ wirklich löschen?`)) return;
        this._ws({ type: "einkaufsliste/recipe/remove", recipe_id: this._draft.id })
          .then(() => { this._draft = null; this._view = "settings"; this._renderAll(); }).catch(() => {});
        break;
      }
    }
  }

  _onChange(e) {
    const t = e.target;
    if (t.id === "xferRecipeFile" || t.id === "xferRestore") {
      const file = t.files?.[0];
      t.value = "";
      if (file) (t.id === "xferRestore" ? this._xferRestore(file) : this._xferRecipeFile(file));
      return;
    }
    if (t.id === "rGroup") {
      this._groupAuto = false; // selbst gewählt – nicht mehr überschreiben
      if (this.$("rGroupHint")) this.$("rGroupHint").hidden = true;
      this.$("rIconPrev")?.setAttribute("icon", this._rgroup(t.value)?.icon || "mdi:silverware-fork-knife");
      return;
    }
    if (t.id === "rServUnit") {
      t.closest(".srow")?.querySelector(".prev")?.setAttribute("icon", t.value === "trays" ? "mdi:tray" : "mdi:account-group-outline");
      return;
    }
    if (t.dataset?.act === "pick-store") {
      this._pickStores[t.dataset.n] = t.value;
      this._renderRecipes();
      return;
    }
    if (t.dataset?.hf === "device") { this._readHeat(); const n = Number(t.closest(".heatrow").dataset.n); this._draft.heat[n].mode = HEAT_DEVICES[t.value]?.modes[0] || null; this._renderHeat(); return; }
    const logKey = { logWho: "who", logStore: "store", logAct: "act" }[t.id];
    if (logKey) {
      this._logF[logKey] = t.value;
      this._logMax = 150;
      this._renderLogList();
      return;
    }
    if (t.id === "catOrderMode") { // 🗺️ eigene Kategorien-Reihenfolge an/aus
      const own = t.value === "own";
      this._ws({ type: "einkaufsliste/group/update", kind: "stores", group_id: t.dataset.store,
        cat_order: own ? this._data.categories.map((c) => c.id) : null })
        .then(() => { this._toast(own ? "🗺️ Jetzt mit ↑↓ so sortieren, wie der Laden aufgebaut ist" : "🗺️ Wieder wie bei allen Geschäften"); this._renderSettings(); }).catch(() => {});
      return;
    }
    if (t.id === "logDays") {
      this._ws({ type: "einkaufsliste/log/settings", days: Number(t.value) })
        .then(() => { this._toast(`📋 Verlauf wird ${t.value} Tage aufgehoben`); this._loadLog(); }).catch(() => {});
      return;
    }
    const srow = t.closest(".srow[data-kind]");
    if (srow && t.dataset.zadd && t.value) { // 📍 noch eine Zone für dieses Geschäft
      const store = this._data.stores.find((x) => x.id === srow.dataset.id);
      const zones = [...storeZones(store), t.value];
      this._ws({ type: "einkaufsliste/group/update", kind: "stores", group_id: srow.dataset.id, zones })
        .then(() => setTimeout(() => this._renderSettings(), 150)).catch(() => this._renderSettings());
      return;
    }
    if (!srow || !t.dataset.field) return;
    const msg = { type: "einkaufsliste/group/update", kind: srow.dataset.kind, group_id: srow.dataset.id };
    if (srow.dataset.kind === "recipe_groups" && t.dataset.field === "name") {
      const icon = suggestIcon(t.value); // 💡 neuer Name → passendes Icon gleich mit
      if (icon) {
        msg.icon = stripMdi(icon);
        const inp = srow.querySelector('input[data-field="icon"]');
        if (inp) inp.value = stripMdi(icon);
        srow.querySelector(".prev")?.setAttribute("icon", icon);
      }
    }
    msg[t.dataset.field] = t.dataset.field === "icon" ? stripMdi(t.value).trim() || null
      : t.dataset.field === "zone" ? (t.value || null) : t.value;
    if (t.dataset.field === "icon" && !msg.icon && srow.dataset.kind !== "stores") return;
    if (t.dataset.field === "icon" && srow.dataset.kind === "stores") setTimeout(() => this._renderSettings(), 300);
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
    else if (kind === "recipe_groups" && suggestIcon(name)) msg.icon = stripMdi(suggestIcon(name));
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
  language: "🌍 Sprache / Language",
};

class EinkaufslisteCardEditor extends HTMLElement {
  setConfig(config) { this._config = { store: "all", ...config }; this._render(); }
  set hass(hass) {
    this._hass = hass;
    elUseLang(hass, this._config, null);
    if (EL_LANG !== "de" && !EL_DICT) elLoadDict().then(() => { if (this._form) this._form.schema = this._schema(); });
    if (!this._stores && !this._loading) {
      this._loading = true;
      hass.callWS({ type: "einkaufsliste/get" })
        .then((d) => { this._stores = d.stores; this._render(); })
        .catch(() => { this._stores = []; this._render(); });
    }
    this._render();
  }
  _schema() {
    const stores = (this._stores || []).map((s) => ({ value: s.id, label: elT(`Nur ${s.name}`) }));
    const L = (list) => list.map((o) => ({ ...o, label: elT(o.label) }));
    return [
      { name: "show_title", selector: { boolean: {} } },
      { name: "title", selector: { text: {} } },
      { name: "store", selector: { select: { mode: "dropdown", options: [...L([{ value: "all", label: "Alle (mit Reitern oben)" }]), ...stores] } } },
      { name: "show_added_by", selector: { boolean: {} } },
      { name: "added_by_style", selector: { select: { mode: "dropdown", options: L([
        { value: "name", label: "Ganzer Name (Max Mustermann)" },
        { value: "first", label: "Vorname (Max)" },
        { value: "initials", label: "Kürzel (MM)" },
      ]) } } },
      { name: "show_checked", selector: { boolean: {} } },
      { name: "show_dates", selector: { boolean: {} } },
      { name: "show_recipes", selector: { boolean: {} } },
      { name: "auto_store", selector: { boolean: {} } },
      { name: "compact", selector: { boolean: {} } },
      { name: "show_settings", selector: { boolean: {} } },
      { name: "language", selector: { select: { mode: "dropdown", options: [
        { value: "auto", label: elT("Automatisch") + " (Home Assistant)" }, { value: "de", label: "Deutsch" }, { value: "en", label: "English" },
      ] } } },
    ];
  }
  _render() {
    if (!this._hass || !this._config) return;
    if (!this._form) {
      this._form = document.createElement("ha-form");
      this._form.computeLabel = (s) => elT(EDITOR_LABELS[s.name] || s.name);
      this._form.addEventListener("value-changed", (ev) => {
        this._config = ev.detail.value;
        this.dispatchEvent(new CustomEvent("config-changed", { detail: { config: this._config }, bubbles: true, composed: true }));
      });
      this.appendChild(this._form);
    }
    this._form.hass = this._hass;
    this._form.data = {
      title: "Einkaufsliste", show_title: true, show_checked: true, show_added_by: true, added_by_style: "name",
      show_dates: true, show_recipes: true, show_settings: true, auto_store: true, language: "auto", ...this._config,
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
