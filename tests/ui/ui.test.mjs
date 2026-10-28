// 🧪 Oberflächen-Test der Karte (Browser, ohne Home Assistant). Start: node tests/ui/ui.test.mjs
// Prüft vor allem das, was beim Bauen leicht kaputtgeht: einheitliche Symbole, Seitenköpfe nur einmal, Aufräum-Zeile.
import { chromium } from "playwright";
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const srv = http.createServer((q, r) => {
  const url = q.url.split("?")[0];
  const f = url === "/" ? path.join(root, "tests/ui/harness.html") : path.join(root, url);
  r.setHeader("content-type", f.endsWith(".js") ? "text/javascript" : f.endsWith(".json") ? "application/json" : "text/html");
  try { r.end(fs.readFileSync(f)); } catch (e) { r.statusCode = 404; r.end(); }
}).listen(0);
const port = srv.address().port;
const exe = process.env.PLAYWRIGHT_CHROMIUM || (fs.existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined);
const b = await chromium.launch(exe ? { executablePath: exe } : {});
const p = await b.newPage({ viewport: { width: 700, height: 700 } });
const errs = [];
p.on("pageerror", (e) => errs.push(String(e)));
await p.goto(`http://localhost:${port}/`);
await p.waitForFunction(() => window.__ready);
await p.waitForTimeout(300);

let fails = 0;
const check = (name, ok, info = "") => { console.log(`${ok ? "✅" : "❌"} ${name}${ok ? "" : " – " + info}`); if (!ok) fails++; };
const card = "document.querySelector('#c1')";
const wait = (ms) => p.waitForTimeout(ms);
const press = () => p.evaluate(`(${card}).shadowRoot.querySelector("ha-card").dispatchEvent(new PointerEvent("pointerdown",{bubbles:true,composed:true}))`);
const back = () => p.evaluate(`(() => { const c=${card}; let n=0; while(c._page && n++<6) c._pageBack(); document.querySelectorAll("[data-elov]").forEach(e=>e.remove()); })()`);
await press();

// 1) Gar-Zeiten als Seite: ein Kopf, Topf-Symbol, Timer-Knopf mit Stoppuhr
await p.evaluate(`(() => { const c=${card}; const bt=document.createElement("button"); bt.dataset.act="gar"; c.shadowRoot.querySelector("ha-card").append(bt); bt.click(); })()`);
await wait(500);
let r = await p.evaluate(`(() => { const c=${card}; const h=c.shadowRoot; return { heads:h.querySelectorAll(".pagehost .sechead").length, title:h.querySelector(".pagehost h3")?.textContent, icon:h.querySelector(".pagehost .ic ha-icon")?.getAttribute("icon"), tbtn:h.querySelector(".gtbtn ha-icon")?.getAttribute("icon") }; })()`);
check("Gar-Zeiten: ein Seitenkopf", r.heads === 1, JSON.stringify(r));
check("Gar-Zeiten: Topf-Symbol", r.icon === "mdi:pot-steam-outline", r.icon);
check("Gar-Zeiten: Timer-Knopf mit Stoppuhr", r.tbtn === "mdi:timer-outline", r.tbtn);

// 2) Timer aus den Gar-Zeiten: Kopf nur einmal, Stoppuhr-Symbol
await p.evaluate(`${card}.shadowRoot.querySelector(".gtbtn").click()`);
await wait(500);
r = await p.evaluate(`(() => { const h=${card}.shadowRoot; return { heads:h.querySelectorAll(".pagehost .sechead").length, own:h.querySelectorAll(".tmw .gh").length, title:h.querySelector(".pagehost h3")?.textContent, icon:h.querySelector(".pagehost .ic ha-icon")?.getAttribute("icon") }; })()`);
check("Timer-Seite: Kopf nur einmal", r.heads === 1 && r.own === 0, JSON.stringify(r));
check("Timer-Seite: Titel und Stoppuhr", r.title === "Timer" && r.icon === "mdi:timer-outline", JSON.stringify(r));
await back();

// 3) Foto-Seite: Galerie-Symbol
await p.evaluate(`(() => { const c=${card}; c._photoData=async()=>"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='10'/>"; c._openPhoto("Milch","Milch"); })()`);
await wait(500);
r = await p.evaluate(`${card}.shadowRoot.querySelector(".pagehost .ic ha-icon")?.getAttribute("icon")`);
check("Foto-Seite: Galerie-Symbol", r === "mdi:image-multiple-outline", r);
const btns = await p.evaluate(`[...${card}.shadowRoot.querySelectorAll(".pagehost button")].filter(b=>/Foto dazu|Dieses löschen/.test(b.textContent)).map(b=>({t:b.textContent.trim(), i:b.querySelector("ha-icon")?.getAttribute("icon")}))`);
check("Foto-Knöpfe: Symbol statt Emoji", btns.length >= 1 && btns.every((x) => x.i && !/[➕🗑]/u.test(x.t)), JSON.stringify(btns));
await back();

// 4) Kochansicht: Symbol-Knöpfe oben, Koch-Symbol im Titel
await p.evaluate(`(() => { const c=${card}; const r={id:"r1",name:"Lasagne",items:[{name:"Mehl",quantity:"200 g"}],steps:"Tomaten 30 Minuten köcheln lassen.",heat:[],servings:4,servings_unit:"persons"}; c._data.recipes=[r]; c._ws=async()=>({}); c._cookMode(r); })()`);
await wait(500);
r = await p.evaluate(`(() => { const ov=document.querySelector("[data-elcook]"); const ic=[...ov.querySelectorAll("button ha-icon")].map(i=>i.getAttribute("icon")); return { ic, title:ov.querySelector("span")?.textContent }; })()`);
check("Kochansicht: Timer-, Gar-Zeiten- und Schließen-Symbol", ["mdi:timer-outline", "mdi:pot-steam-outline", "mdi:close"].every((i) => r.ic.includes(i)), JSON.stringify(r));
check("Kochansicht: Rezeptname im Titel", r.title === "Lasagne", r.title);
await back();

// 5) Aufräum-Zeile: bei ausgenommenem Geschäft weg, sonst da
const foot = (tab) => p.evaluate(`(() => { const c=${card}; c._tab=${JSON.stringify(tab)}; c._renderAll(); return [...c.shadowRoot.querySelectorAll("span")].some(e=>/Nächstes Aufräumen/.test(e.textContent) && e.offsetParent!==null); })()`);
const ids = await p.evaluate("window.__data.stores.map(s=>s.id)");
check("Aufräum-Zeile steht bei „Alle“", await foot("all") === true);
check("Aufräum-Zeile steht bei einem Geschäft ohne Ausnahme", await foot(ids[1]) === true);
check("Aufräum-Zeile fehlt beim ausgenommenen Geschäft", await foot(ids[0]) === false);

// 6) Emojis vorn an Knöpfen/Überschriften werden zu Linien-Symbolen, Rückfragen sind ein eigenes Fenster
await p.evaluate(`(() => { const c=${card}; c._view="settings"; c._renderAll(); })()`);
await wait(600);
r = await p.evaluate(`(() => { const sr=${card}.shadowRoot; const left=[]; const w=document.createTreeWalker(sr,4); let n; while((n=w.nextNode())){ const p=n.parentElement; if(!p||p.closest("style,script,option,select,textarea")) continue; if(/^\\s*[📋🎛💾🩺👁📱🏷✏📷📖➕📍🛒🔄⚠📊✔🧂🏪📧🧹🔧]/u.test(n.data) && p.matches("button,h3,h4,summary,b,span,li,a,p,label")) left.push(p.tagName+": "+n.data.trim().slice(0,20)); } return { left, icons: sr.querySelectorAll("ha-icon[data-eli]").length }; })()`);
check("Einstellungen: keine Emojis mehr vorn an Knöpfen und Gruppen", r.left.length === 0, JSON.stringify(r.left));
check("Einstellungen: Emojis wurden zu Symbolen", r.icons >= 4, String(r.icons));
let native = 0; p.on("dialog", (d) => { native++; d.dismiss(); });
await p.evaluate(`(() => { const c=${card}; const bt=document.createElement("button"); bt.dataset.act="log-clear"; c.shadowRoot.querySelector("ha-card").append(bt); bt.click(); bt.remove(); })()`);
await wait(300);
check("Rückfrage: eigenes Fenster statt Browser-Dialog", (await p.evaluate("!!document.querySelector('[data-elconfirm]')")) && native === 0, `native=${native}`);
await p.keyboard.press("Escape"); await wait(200);
check("Rückfrage: Esc schließt", await p.evaluate("!document.querySelector('[data-elconfirm]')"));

// 7) Abgelaufener Timer: „+1 Min“ beendet den alten und startet einen neuen mit 1 Minute und gleichem Namen
r = await p.evaluate(`(async () => { const c=${card}; const calls=[]; c._ws=async(m)=>{calls.push(m); return {};};
  const chip=c._timerChip({id:"t1",label:"Nudeln",recipe_id:null,step:2,done:true,end:new Date(Date.now()-5000).toISOString()});
  document.body.append(chip); const plus=[...chip.querySelectorAll("button")].find(b=>/\\+1/.test(b.textContent)); const has=!!plus; plus?.click(); await new Promise(r=>setTimeout(r,100)); chip.remove(); return {has, types:calls.map(m=>m.type), start:calls.find(m=>m.type.endsWith("timer/start")), laufend: !![...c._timerChip({id:"t2",label:"x",end:new Date(Date.now()+60000).toISOString()}).querySelectorAll("button")].find(b=>/\\+1/.test(b.textContent))}; })()`);
check("Abgelaufener Timer hat „+1 Min“", r.has === true, JSON.stringify(r));
check("+1 Min: alter Timer weg, neuer mit 60 s und gleichem Namen", JSON.stringify(r.types) === JSON.stringify(["einkaufsliste/timer/cancel", "einkaufsliste/timer/start"]) && r.start?.seconds === 60 && r.start?.label === "Nudeln" && r.start?.step === 2, JSON.stringify(r));
check("Laufender Timer hat kein „+1 Min“", r.laufend === false, JSON.stringify(r));

// 8) ⚠️ Rückruf-Warnung in ⚙️ → Extras: Treffer mit Link, ✔ klickt weg
r = await p.evaluate(`(async () => { const c=${card}; const calls=[]; c._ws=async(m)=>{calls.push(m); return {};}; c._hass={...c._hass, user:{...c._hass.user, is_admin:true}};
  c._data.settings.recalls={enabled:true, ok:true, last:new Date().toISOString(), checked:42, hits:[{id:"w1", title:"Gemahlener Kaffee, 250 Gramm", link:"https://www.lebensmittelwarnung.de/x.html", date:new Date().toISOString(), products:["Kaffee"]}]};
  const host=document.createElement("div"); host.innerHTML=c._recallsHtml(); const a=host.querySelector(".recallhit a");
  const bt=document.createElement("button"); bt.dataset.act="recall-dismiss"; bt.dataset.id="w1"; c.shadowRoot.querySelector("ha-card").append(bt); bt.click(); bt.remove();
  await new Promise(r=>setTimeout(r,100));
  return { href:a?.getAttribute("href"), rel:a?.getAttribute("rel"), prod:host.querySelector(".recallhit b")?.textContent, check:!!host.querySelector('[data-act="recalls-check"]'), calls }; })()`);
check("Rückruf-Warnung: Treffer mit sicherem Link", r.href === "https://www.lebensmittelwarnung.de/x.html" && /noopener/.test(r.rel) && r.prod === "Kaffee" && r.check, JSON.stringify(r));
check("Rückruf-Warnung: ✔ schickt „dismiss“", r.calls.some((m) => m.type === "einkaufsliste/recalls/dismiss" && m.recall_id === "w1"), JSON.stringify(r.calls));
r = await p.evaluate(`(() => { const c=${card}; const was=c._data.settings.privacy; c._data.settings.privacy=true; const blocked=/Gesperrt/.test(c._recallsHtml()); const priv=/Rückruf-Warnung/.test(c._privacyHtml(false)) && /Recall warning/.test(c._privacyHtml(true)); c._data.settings.privacy=was; return { blocked, priv, privOn: c._privacyOn.toString().slice(0,80) }; })()`);
check("Rückruf-Warnung: Datenschutz an = „🔒 Gesperrt“, und sie steht auf der Datenschutz-Seite", r.blocked && r.priv, JSON.stringify(r));

// 9) ❗ Rotes Ausrufezeichen in der Liste beim passenden Artikel – antippen öffnet die Warnung (nur lebensmittelwarnung.de)
r = await p.evaluate(`(async () => { const c=${card}; const opened=[]; const wo=window.open; window.open=(u)=>{opened.push(u); return null;};
  c._data.settings.recalls={enabled:true, ok:true, hits:[{id:"w2", title:"Brot, 500 Gramm", link:"https://www.lebensmittelwarnung.de/m.html", products:["brot"]}]};
  const brot=c._data.items.find(i=>i.name==="Brot"); c._data.items.push({...brot, id:"butter1", name:"Butter"});
  c._data.offers={ brot:[{p:0.99, s:"Aldi", to:new Date(Date.now()+2*864e5).toISOString()}] };
  c._renderList(); await new Promise(r=>setTimeout(r,100));
  const rows=[...c.shadowRoot.querySelectorAll(".item")].map(it=>({ name:it.querySelector(".name")?.textContent, acts:[...it.querySelectorAll(".acts > button")].map(b=>b.dataset.act) }));
  c.shadowRoot.querySelector(".recalltag")?.click();
  const fake=document.createElement("button"); fake.dataset.act="recall-open"; fake.dataset.link="https://evil.example/x"; c.shadowRoot.querySelector("ha-card").append(fake); fake.click(); fake.remove();
  c._data.settings.recalls.enabled=false; c._renderList(); const offHides=!c.shadowRoot.querySelector(".recalltag");
  window.open=wo; c._data.offers={}; c._data.items=c._data.items.filter(i=>i.id!=="butter1"); return { rows, opened, offHides }; })()`);
const brot = r.rows.find((x) => x.name === "Brot"), butter = r.rows.find((x) => x.name === "Butter");
check("❗ steht bei „Brot“ links neben dem Angebotszeichen", brot && brot.acts[0] === "recall-open" && brot.acts[1] === "offers-show", JSON.stringify(r.rows));
check("❗ nicht bei „Butter“", butter && !butter.acts.includes("recall-open"), JSON.stringify(r.rows));
check("❗ antippen öffnet nur lebensmittelwarnung.de", r.opened.length === 1 && r.opened[0] === "https://www.lebensmittelwarnung.de/m.html", JSON.stringify(r.opened));
check("❗ weg, wenn die Rückruf-Warnung aus ist", r.offHides, "");

// 10) 👉 Mengen-Zeile: auf der Zahl wischen, rechts = mehr, links = weniger, Loslassen speichert, vibriert dabei
r = await p.evaluate(`(async () => { const c=${card}; const calls=[]; c._ws=async(m)=>{calls.push(m); return {};}; const vib=[]; const nv=navigator.vibrate; navigator.vibrate=(x)=>{vib.push(x); return true;};
  const brot=c._data.items.find(i=>i.name==="Brot"); brot.quantity="2x"; c._tab="all"; c._renderList(); await new Promise(r=>setTimeout(r,50));
  c.shadowRoot.querySelector('.item[data-id="'+brot.id+'"] button.qty[data-act="qty-edit"]').click(); await new Promise(r=>setTimeout(r,50));
  const zone=c.shadowRoot.querySelector('.qtyrow[data-id="'+brot.id+'"] .qswipe'); if(!zone) return {nozone:true};
  const arrows=[...zone.querySelectorAll(".qarr")].map(a=>a.textContent).join(""), hasBtns=c.shadowRoot.querySelectorAll('.qtyrow [data-act="qty-minus"], .qtyrow [data-act="qty-plus"]').length;
  const b=zone.getBoundingClientRect(), x=b.left+b.width/2, y=b.top+b.height/2;
  const ev=(t,xx)=>zone.dispatchEvent(new PointerEvent(t,{bubbles:true,composed:true,clientX:xx,clientY:y,pointerId:7,pointerType:"touch"}));
  ev("pointerdown",x); ev("pointermove",x+20); ev("pointermove",x+36); const mid=zone.querySelector(".qval").textContent; ev("pointerup",x+36); await new Promise(r=>setTimeout(r,20));
  const right=[...calls];
  ev("pointerdown",x); ev("pointermove",x-200); const low=zone.querySelector(".qval").textContent; ev("pointercancel",x-200); await new Promise(r=>setTimeout(r,20));
  const left=calls.slice(right.length);
  ev("pointerdown",x); ev("pointerup",x); await new Promise(r=>setTimeout(r,20)); const tapNoCall=calls.length===right.length+left.length;
  const wheel=!!c.shadowRoot.querySelector(".qtywheel");
  navigator.vibrate=nv; brot.quantity=null; c._qtyEdit=null; c._renderList(); return { arrows, hasBtns, mid, right, low, left, tapNoCall, vib, wheel }; })()`);
check("Mengen-Zeile: ‹ › Pfeile und − ＋ Knöpfe im Wisch-Feld", r.arrows === "‹›" && r.hasBtns === 2, JSON.stringify(r));
check("Mengen-Zeile: nach rechts wischen = mehr, Loslassen speichert", /^4/.test(r.mid || "") && r.right?.length === 1 && r.right[0].type === "einkaufsliste/item/update" && /^4/.test(r.right[0].quantity), JSON.stringify(r));
check("Mengen-Zeile: nach links wischen = weniger (nie unter 1 Schritt), auch bei Abbruch gespeichert", /^1/.test(r.low || "") && r.left?.length === 1 && /^1/.test(r.left[0].quantity), JSON.stringify(r));
check("Mengen-Zeile: vibriert bei jedem Schritt", r.vib.length >= 3, JSON.stringify(r.vib));
check("Mengen-Zeile: nur tippen ändert nichts, kein Zahlenrad mehr", r.tapNoCall && !r.wheel, JSON.stringify(r));

// 10b) 👉 Mit echter Maus: auf ＋ tippen zählt (mit Brummen), vom ＋ aus nach links wischen geht auch
await p.evaluate(`(async () => { const c=${card}; window.__calls=[]; c._ws=async(m)=>{window.__calls.push(m); return {};}; window.__vib=[]; navigator.vibrate=(x)=>{window.__vib.push(x); return true;};
  const brot=c._data.items.find(i=>i.name==="Brot"); brot.quantity="5x"; c._qtyEdit=brot.id; c._qtyStep={}; c._qtyPending={}; c._view="list"; c._tab="all"; c._renderAll(); await new Promise(r=>setTimeout(r,100)); })()`);
let bx = await p.evaluate(`(() => {  const r=${card}.shadowRoot.querySelector('.qtyrow [data-act="qty-plus"]').getBoundingClientRect(); return {x:r.left+r.width/2, y:r.top+r.height/2, w:${card}.shadowRoot.querySelector(".qswipe").getBoundingClientRect().width}; })()`);
await wait(450); await p.mouse.click(bx.x, bx.y); await wait(50);
let tapCalls = await p.evaluate("window.__calls.slice()"), tapVib = await p.evaluate("window.__vib.length");
await p.mouse.move(bx.x, bx.y); await p.mouse.down(); for (let k = 1; k <= 4; k++) await p.mouse.move(bx.x - k * 14, bx.y); await p.mouse.up(); await wait(50);
let swCalls = await p.evaluate("window.__calls.slice()");
await p.evaluate(`(() => { const c=${card}; const brot=c._data.items.find(i=>i.name==="Brot"); brot.quantity=null; c._qtyEdit=null; c._renderList(); })()`);
check("Wisch-Feld ist groß (über die ganze Zeile)", bx.w >= 200, JSON.stringify(bx));
check("＋ antippen zählt einen Schritt und brummt", tapCalls.length === 1 && tapCalls[0].quantity === "6x" && tapVib >= 1, JSON.stringify({ tapCalls, tapVib }));
check("Vom ＋ aus nach links wischen = weniger, kein zusätzlicher ＋-Klick", swCalls.length === 2 && /^[23]x$/.test(swCalls[1].quantity), JSON.stringify(swCalls));

// 10c) ⚡ − / ＋ reagieren sofort, auch wenn Home Assistant langsam antwortet; schnelles Tippen zählt jedes Mal
r = await p.evaluate(`(async () => { const c=${card}; const calls=[]; c._ws=(m)=>{calls.push(m); return new Promise(r=>setTimeout(()=>r({}),1500));};
  const brot=c._data.items.find(i=>i.name==="Brot"); brot.quantity="5x"; c._qtyPending={}; c._qtyStep={}; c._qtyEdit=brot.id; c._qtySwiped=0; c._view="list"; c._tab="all"; c._renderAll(); await new Promise(r=>setTimeout(r,50));
  const plus=()=>c.shadowRoot.querySelector('.qtyrow [data-act="qty-plus"]');
  plus().click(); const v1=c.shadowRoot.querySelector(".qtyrow .qval").textContent; plus().click(); plus().click();
  const v3=c.shadowRoot.querySelector(".qtyrow .qval").textContent, chip=c.shadowRoot.querySelector('.item[data-id="'+brot.id+'"] button.qty').textContent;
  c._renderList(); const afterRender=c.shadowRoot.querySelector(".qtyrow .qval").textContent;
  brot.quantity=null; c._qtyPending={}; c._qtyEdit=null; c._renderList(); return { v1, v3, chip, afterRender, q: calls.map(m=>m.quantity) }; })()`);
check("＋ zeigt die neue Zahl sofort", r.v1 === "6x" && r.v3 === "8x" && r.chip === "8x", JSON.stringify(r));
check("Schnell dreimal ＋ = 6x, 7x, 8x (kein Tipp geht verloren)", JSON.stringify(r.q) === JSON.stringify(["6x", "7x", "8x"]) && r.afterRender === "8x", JSON.stringify(r));

// 11) 🏷️ Marken-Check: Zeile in den Einstellungen und oranges ❗ bei „vielleicht andere Marke“
r = await p.evaluate(`(async () => { const c=${card};
  const m=c._recallBrandHtml({brand:"match"}), o=c._recallBrandHtml({brand:"other", notes:["Milsani"]}), n=c._recallBrandHtml({});
  c._data.settings.recalls={enabled:true, ok:true, hits:[{id:"w3", title:"Brot", link:"https://www.lebensmittelwarnung.de/b.html", products:["brot"], brand:"other", notes:["Milsani"]}]};
  c._renderList(); await new Promise(r=>setTimeout(r,50)); const tag=c.shadowRoot.querySelector(".recalltag");
  const res={ m, o, n, maybe: tag?.classList.contains("maybe"), title: tag?.title }; c._data.settings.recalls={enabled:false}; c._renderList(); return res; })()`);
check("Marken-Check: „Eure Marke steht in der Warnung“", /recallbrand hit/.test(r.m) && /Eure Marke steht in der Warnung/.test(r.m), r.m);
check("Marken-Check: andere Marke zeigt die Notiz", /Milsani/.test(r.o) && /vielleicht eine andere Marke/.test(r.o) && r.n === "", JSON.stringify(r));
check("Marken-Check: ❗ wird orange", r.maybe === true && /andere Marke/.test(r.title || ""), JSON.stringify(r));

// 12) ➕ Zwei Rezepte gleichzeitig: Reiter, Tipp mit dem längsten zuerst, 📝 Notiz oben
r = await p.evaluate(`(async () => { const c=${card}; const calls=[]; c._ws=async(m)=>{calls.push(m); return {};};
  const a={id:"ra",name:"Nudeln",items:[{name:"Nudeln"}],steps:"Wasser 10 Minuten kochen.",heat:[],servings:2,servings_unit:"persons"};
  const g={id:"rg",name:"Gulasch",items:[{name:"Rind"}],steps:"Anbraten.\\nZwei Stunden schmoren.",heat:[{type:"oven",temp:160,minutes:90}],servings:4,servings_unit:"persons",cook_note:"weniger Salz"};
  c._data.recipes=[a,g]; c._cookMode(a); await new Promise(r=>setTimeout(r,200)); const one=[...document.querySelectorAll("[data-elcooktab]")].filter(b=>b.offsetParent).length;
  c._cookMode(g); await new Promise(r=>setTimeout(r,200));
  const vis=[...document.querySelectorAll("[data-elcook]")].filter(o=>o.style.display!=="none");
  const ov=vis[0]; const tabs=[...ov.querySelectorAll("[data-elcooktab]")].map(b=>b.textContent); const hint=[...ov.querySelectorAll("div")].map(d=>d.textContent).find(t=>/Fang mit/.test(t))||""; const hs=ov.querySelector("[data-elhint]"); const hintStyle=hs?getComputedStyle(hs).color+"|"+getComputedStyle(hs).backgroundColor:"";
  const note=ov.querySelector("[data-elnote]")?.textContent;
  [...ov.querySelectorAll("[data-elcooktab]")].find(b=>b.textContent==="Nudeln").click(); await new Promise(r=>setTimeout(r,100));
  const front=[...document.querySelectorAll("[data-elcook]")].filter(o=>o.style.display!=="none").map(o=>o.querySelector("[data-elcooktab][style*='solid rgb']")?.textContent || o.querySelector("span")?.textContent);
  return { one, count: vis.length, all: document.querySelectorAll("[data-elcook]").length, tabs, hint, hintStyle, note, front }; })()`);
check("Mehrere Rezepte: bei einem Rezept keine Reiter", r.one === 0, JSON.stringify(r));
check("Mehrere Rezepte: zwei Reiter, nur eins vorn", r.all === 2 && r.count === 1 && JSON.stringify(r.tabs) === JSON.stringify(["Nudeln", "Gulasch"]), JSON.stringify(r));
check("Mehrere Rezepte: Tipp fängt mit dem längsten an", /Fang mit „Gulasch“ an/.test(r.hint) && /„Nudeln“ ca\. 10 Min/.test(r.hint), r.hint);
check("Mehrere Rezepte: Tipp gut lesbar (helle Schrift auf dunklem Kasten)", r.hintStyle === "rgb(255, 243, 176)|rgb(59, 53, 16)", r.hintStyle);
check("Mehrere Rezepte: Reiter antippen holt das Rezept nach vorn", r.front.length === 1 && /Nudeln/.test(r.front[0] || ""), JSON.stringify(r.front));
check("📝 Notiz vom letzten Mal steht oben", /weniger Salz/.test(r.note || ""), r.note);

// 13) 📝 Nach dem letzten „Fertig“ fragt die Liste nach einer Notiz und speichert sie; das andere Rezept bleibt offen
r = await p.evaluate(`(async () => { const c=${card}; const calls=[]; c._ws=async(m)=>{calls.push(m); return {};};
  const ov=[...document.querySelectorAll("[data-elcook]")].find(o=>o.style.display!=="none");
  [...ov.querySelectorAll("[data-elintro] button")].find(b=>/Los geht/.test(b.textContent))?.click(); await new Promise(r=>setTimeout(r,100)); // erst die Personenzahl bestätigen
  for (let k=0; k<5 && ![...ov.querySelectorAll("button")].some(b=>/Fertig/.test(b.textContent)); k++) [...ov.querySelectorAll("button")].find(b=>/Weiter/.test(b.textContent))?.click();
  const fertig=[...ov.querySelectorAll("button")].find(b=>/Fertig/.test(b.textContent)); fertig?.click(); await new Promise(r=>setTimeout(r,150));
  const left=document.querySelectorAll("[data-elcook]").length; const shown=[...document.querySelectorAll("[data-elcook]")].filter(o=>o.style.display!=="none").length;
  const inp=[...document.querySelectorAll("[data-elov] input")].pop(); const q=inp?.closest("[data-elov]")?.textContent||"";
  if (inp) { inp.value="mehr Wasser"; inp.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter"})); }
  await new Promise(r=>setTimeout(r,100));
  document.querySelectorAll("[data-elcook]").forEach(o=>o._elClose?.()); document.querySelectorAll("[data-elov]").forEach(e=>e.remove());
  return { hasFertig: !!fertig, left, shown, q, calls }; })()`);
check("📝 „Fertig“ fragt „Notiz fürs nächste Mal?“", r.hasFertig && /Notiz fürs nächste Mal/.test(r.q), JSON.stringify(r));
check("📝 Notiz wird gespeichert", r.calls.some((m) => m.type === "einkaufsliste/recipe/update" && m.recipe_id === "ra" && m.cook_note === "mehr Wasser"), JSON.stringify(r.calls));
check("📝 Das andere Rezept bleibt offen und kommt nach vorn", r.left === 1 && r.shown === 1, JSON.stringify(r));

// 12b) 👥 Personen-Auswahl: kein Geräte-Kasten von Schritt 1; 💡 Tipp nur, solange beide Rezepte noch bei der Personen-Auswahl sind
r = await p.evaluate(`(async () => { const c=${card}; c._ws=async()=>({}); document.querySelectorAll("[data-elcook]").forEach(o=>o._elClose?.());
  const vis=()=>[...document.querySelectorAll("[data-elcook]")].find(o=>o.style.display!=="none");
  const heatShown=(ov)=>[...ov.querySelectorAll("div")].some(d=>d.style.background==="rgb(58, 31, 15)" && d.offsetParent);
  const hintShown=(ov)=>!!ov.querySelector("[data-elhint]");
  const go=(ov)=>[...ov.querySelectorAll("[data-elintro] button")].find(b=>/Los geht/.test(b.textContent))?.click();
  const g={id:"gy",name:"BBQ Gyros Overload",items:[{name:"Gyros"}],steps:"Backofen vorheizen.\\nGyros 25 Minuten backen.",heat:[{device:"Backofen",mode:"Umluft",temp:200,minutes:25,steps:[1]}],servings:4,servings_unit:"persons"};
  const n={id:"nu",name:"Reis",items:[{name:"Reis"}],steps:"Reis 15 Minuten kochen.",heat:[],servings:4,servings_unit:"persons"};
  c._data.recipes=[g,n];
  c._cookMode(g); await new Promise(r=>setTimeout(r,200)); const introHeat=heatShown(vis()); go(vis()); await new Promise(r=>setTimeout(r,150)); const afterHeat=heatShown(vis());
  c._cookMode(n); await new Promise(r=>setTimeout(r,200)); const hintLate=hintShown(vis()); const tabsLate=vis().querySelectorAll("[data-elcooktab]").length;
  document.querySelectorAll("[data-elcook]").forEach(o=>o._elClose?.());
  c._cookMode(g); await new Promise(r=>setTimeout(r,200)); c._cookMode(n); await new Promise(r=>setTimeout(r,200)); const hintBoth=hintShown(vis());
  go(vis()); await new Promise(r=>setTimeout(r,150)); const hintAfterGo=[...document.querySelectorAll("[data-elcook]")].some(hintShown);
  document.querySelectorAll("[data-elcook]").forEach(o=>o._elClose?.()); document.querySelectorAll("[data-elov]").forEach(e=>e.remove());
  return { introHeat, afterHeat, hintLate, tabsLate, hintBoth, hintAfterGo }; })()`);
check("Personen-Auswahl: kein Geräte-Kasten von Schritt 1", r.introHeat === false && r.afterHeat === true, JSON.stringify(r));
check("Tipp nur, wenn beide Rezepte noch bei der Personen-Auswahl sind", r.hintBoth === true && r.hintLate === false && r.tabsLate === 2, JSON.stringify(r));
check("Tipp verschwindet nach „Los geht’s“", r.hintAfterGo === false, JSON.stringify(r));

// 13b) 📝 Notizen stehen auch bei „Wartet auf OK“: ✏️ öffnet das Rezept, 🗑️ löscht die Notiz überall
r = await p.evaluate(`(async () => { const c=${card}; const calls=[]; c._ws=async(m)=>{calls.push(m); return {};};
  c._data.recipes=[{id:"rn",name:"Gulasch",items:[{name:"Rind"}],steps:"Schmoren.",heat:[],cook_note:"weniger Salz"},{id:"ro",name:"Salat",items:[{name:"Gurke"}],steps:"Schneiden."}]; c._data.proposals=[];
  const host=document.createElement("div"); host.innerHTML=c._recWaitHtml(); const rows=[...host.querySelectorAll(".prop.note")].map(x=>x.textContent.replace(/\\s+/g," ").trim());
  const box=c._recBoxes(""); const sub=/1 Notiz/.test(box);
  const bt=document.createElement("button"); bt.dataset.act="cook-note-del"; bt.dataset.id="rn"; c.shadowRoot.querySelector("ha-card").append(bt); bt.click(); bt.remove();
  await new Promise(r=>setTimeout(r,200)); const conf=!!document.querySelector("[data-elconfirm]");
  const yes=[...document.querySelectorAll("[data-elconfirm] button")].pop(); yes?.click(); await new Promise(r=>setTimeout(r,100));
  const none=(() => { c._data.recipes[0].cook_note=null; const h=document.createElement("div"); h.innerHTML=c._recWaitHtml(); return /wartet nichts/.test(h.textContent); })();
  return { rows, sub, conf, calls, none }; })()`);
check("📝 „Wartet auf OK“ zeigt die Notiz mit Rezeptname", r.rows.length === 1 && /Gulasch/.test(r.rows[0]) && /weniger Salz/.test(r.rows[0]) && r.sub, JSON.stringify(r));
check("📝 🗑️ fragt nach und löscht die Notiz am Rezept", r.conf && r.calls.some((m) => m.type === "einkaufsliste/recipe/update" && m.recipe_id === "rn" && m.cook_note === ""), JSON.stringify(r));
check("📝 ohne Notizen und Vorschläge: „wartet nichts“", r.none, JSON.stringify(r));

// 14) 🛒 Laden-Modus nach dem Neuladen mitten im Einkauf: springt zum ersten offenen Artikel (nur einmal)
r = await p.evaluate(`(async () => { const c=${card}; const seen=[]; const siv=Element.prototype.scrollIntoView; Element.prototype.scrollIntoView=function(){ seen.push(this.className+"|"+(this.querySelector(".name")?.textContent||"")); };
  const milch=c._data.items.find(i=>i.name==="Milch"); const was={...milch}; Object.assign(milch,{checked:true, checked_at:new Date(Date.now()-5*60e3).toISOString()});
  const sm=c._shopMode; c._shopMode=true; c._shopResume=true; c._tab="all"; c._renderList(); await new Promise(r=>setTimeout(r,450));
  const first=[...seen]; c._renderList(); await new Promise(r=>setTimeout(r,450)); const again=seen.length;
  Object.assign(milch,{checked:false, checked_at:null}); c._shopResume=true; c._renderList(); await new Promise(r=>setTimeout(r,450)); const idle=seen.length;
  Object.assign(milch,was); c._shopMode=sm; c._renderList(); Element.prototype.scrollIntoView=siv; return { first, again, idle }; })()`);
check("Laden-Modus: springt zum ersten offenen Artikel", r.first.length === 1 && /item/.test(r.first[0]) && !/done/.test(r.first[0]), JSON.stringify(r));
check("Laden-Modus: springt nur einmal und nicht ohne frischen Einkauf", r.again === 1 && r.idle === 1, JSON.stringify(r));

// 15) 📦 Produktkatalog: Getipptes bleibt nach Foto/Neu-Laden stehen; neues Produkt landet im Suchfeld (Meldung eines Nutzers)
r = await p.evaluate(`(async () => { const c=${card}; c._view="list"; c._renderAll(); await new Promise(r=>setTimeout(r,50));
  const cat=c._data.categories[0].id;
  const mk=(o)=>({key:o.name.toLowerCase(), note:null, own_note:"", aliases:[], barcodes:[], photos:0, store_id:null, category_id:null, ...o});
  let prods=[mk({name:"Milch"})];
  c._ws=async(m)=>{ if(m.type==="einkaufsliste/products") return prods.map(x=>({...x})); if(m.type==="einkaufsliste/product/add"){ const n=mk({name:m.name}); prods.push(n); return n; } return {}; };
  const host=document.createElement("div"); host.id="__prodhost"; host.innerHTML='<div class="srow"><input id="prodSearch"><button class="iconbtn serase" data-act="search-erase" data-for="prodSearch" hidden></button></div><div id="prodList"></div>';
  c.shadowRoot.querySelector("ha-card").append(host);
  c._prodFilter=""; c._prodSel=""; c._prodTab="all"; await c._loadProducts(); c._prodEdit="milch"; c._renderProducts();
  const $=(id)=>c.shadowRoot.getElementById(id);
  $("peOwn").value="Weidemilch"; $("peAliases").value="Milli"; $("peCat").value=cat; $("peFav").checked=true;
  prods[0].photos=1; await c._loadProducts();
  const kept={ own:$("peOwn")?.value, al:$("peAliases")?.value, cat:$("peCat")?.value===cat, fav:$("peFav")?.checked, photo:!!c.shadowRoot.querySelector(".prodrow .pphotos") };
  c._prodEdit=null; c._renderProducts(); c._prodEdit="milch"; c._renderProducts(); const fresh=$("peOwn")?.value;
  c._prodEdit=null; c._prodFilter="Hafermilch"; $("prodSearch").value="Hafermilch"; c._renderProducts();
  const bt=document.createElement("button"); bt.dataset.act="prod-add"; host.append(bt); bt.click(); await new Promise(r=>setTimeout(r,100));
  const inp=[...document.querySelectorAll("[data-elov] input"), ...c.shadowRoot.querySelectorAll("[data-elov] input, .pagehost input")].filter(i=>!i.closest("#__prodhost")).pop();
  const pre=inp?.value; if(inp) inp.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter"}));
  await new Promise(r=>setTimeout(r,300)); while (c._page) c._pageBack(); document.querySelectorAll("[data-elov]").forEach(e=>e.remove());
  const after={ search:$("prodSearch").value, edit:c.shadowRoot.querySelector(".prodedit")?.dataset.key, rows:[...c.shadowRoot.querySelectorAll(".prodrow b")].map(b=>b.textContent), eraser:!c.shadowRoot.querySelector('#__prodhost [data-act="search-erase"]').hidden };
  c._prodFilter=""; c._prodEdit=null; host.remove(); return { kept, fresh, pre, after }; })()`);
check("Produkt: getippte Felder bleiben nach dem Foto stehen", r.kept.own === "Weidemilch" && r.kept.al === "Milli" && r.kept.cat && r.kept.fav && r.kept.photo, JSON.stringify(r));
check("Produkt: nach Abbrechen und neu öffnen steht wieder der gespeicherte Stand", r.fresh === "", JSON.stringify(r));
check("Neues Produkt: Suchtext steht schon als Name drin", r.pre === "Hafermilch", JSON.stringify(r));
check("Neues Produkt: Name im Suchfeld, Produkt offen zum Ausfüllen", r.after.search === "Hafermilch" && r.after.edit === "hafermilch" && JSON.stringify(r.after.rows) === JSON.stringify(["Hafermilch"]) && r.after.eraser, JSON.stringify(r));

// 16) 🟠 Punkt an der Kochmütze: Zahl der wartenden Vorschläge, nur mit Zahnrad; nur Anzeige, Tippen öffnet die Kochmütze
r = await p.evaluate(`(async () => { const c=${card}; const cfg=c._config; c._view="list"; c._page=null;
  c._data.proposals=[{id:"p1",name:"Pizza",status:"open",by:"Joy"},{id:"p2",name:"Suppe",status:"open"},{id:"p3",name:"Alt",status:"rejected",rejected_at:new Date().toISOString()}];
  c._config={...cfg, show_recipes:true, show_settings:true}; c._renderAll(); await new Promise(r=>setTimeout(r,50));
  const dot=c.shadowRoot.getElementById("recDot"); const shown={ hidden:dot.hidden, txt:dot.textContent, inBtn:!!dot.closest("#btnRecipes") };
  c._config={...cfg, show_recipes:true, show_settings:false}; c._renderAll(); const noCog=dot.hidden;
  c._config={...cfg, show_recipes:true, show_settings:true}; c._data.proposals=[]; c._renderAll(); const none=dot.hidden;
  c._data.proposals=[{id:"p1",name:"Pizza",status:"open"}]; c._renderAll(); dot.click(); await new Promise(r=>setTimeout(r,100));
  const went={ view:c._view, sec:c._setSec, pe:getComputedStyle(dot).pointerEvents, dotHidden:dot.hidden };
  c._data.proposals=[]; c._recTab="none"; c._view="list"; c._setSec=null; c._config=cfg; c._renderAll(); return { shown, noCog, none, went }; })()`);
check("Kochmütze: Punkt zeigt 2 wartende Vorschläge (abgelehnte zählen nicht)", !r.shown.hidden && r.shown.txt === "2" && r.shown.inBtn, JSON.stringify(r));
check("Kochmütze: kein Punkt ohne Zahnrad und ohne Vorschläge", r.noCog && r.none, JSON.stringify(r));
check("Kochmütze: Punkt ist nur Anzeige, Tippen öffnet ganz normal die Kochmütze", r.went.view === "recipes" && r.went.pe === "none" && r.went.dotHidden, JSON.stringify(r));

// 17) ℹ️ Steckbrief: kein ℹ️ im Reiter; im Öffnungszeiten-Fenster (gedrückt halten) neben dem Namen, Antippen klappt auf/zu (Idee 621)
r = await p.evaluate(`(async () => { const c=${card}; c._view="list"; c._page=null; const [netto, aldi]=c._data.stores; const keep={...aldi};
  Object.assign(aldi,{address:"Hauptstr. 1, 48565 Steinfurt", phone:"02552 1234", website:"https://www.aldi-nord.de", tips:"Parkplatz hinten ist frei"});
  c._tab=aldi.id; c._renderAll(); await new Promise(r=>setTimeout(r,50)); const q=(s)=>c.shadowRoot.querySelector(s);
  const tabClean=!q('.tab .hitog, .tab [data-hinfo]') && !/ℹ️/.test(q('.tab[data-tab="'+aldi.id+'"]').textContent);
  c._showHours(aldi.id); const pop=q(".hourspop"); pop.style.pointerEvents="";
  const head=pop.querySelector(".hbox > b"); const tg=head.querySelector('[data-hinfo="s"]'); const bx=pop.querySelector('[data-hfor="s"]');
  const closed={ inHead:!!tg, hidden:bx?.hidden };
  tg.click(); const opened={ shown:!bx.hidden, still:!!q(".hourspop"), exp:tg.getAttribute("aria-expanded"),
    tel:bx.querySelector('a[href="tel:025521234"]')?.textContent, map:!!bx.querySelector('a[href*="openstreetmap.org/search"]'), web:bx.querySelector('a[href="https://www.aldi-nord.de"]')?.textContent, tips:bx.querySelector(".htips")?.textContent };
  bx.querySelector(".htips").click(); const tipsStay=!!q(".hourspop");
  tg.click(); const again=bx.hidden; pop.remove();
  aldi.branches=[{id:"b1",name:"Borghorst",hours:null,address:"Markt 2",phone:"02552 1"},{id:"b2",name:"Ohne",hours:null}];
  c._showHours(aldi.id); const p2=q(".hourspop"); const brs=[...p2.querySelectorAll(".hbr")];
  const br={ t0:!!brs[0]?.querySelector('b [data-hinfo="b0"]'), t1:!!brs[1]?.querySelector("[data-hinfo]"), hid:brs[0]?.querySelector('[data-hfor="b0"]')?.hidden };
  brs[0].querySelector('[data-hinfo="b0"]').click(); br.open=!brs[0].querySelector('[data-hfor="b0"]').hidden && !!brs[0].querySelector('a[href="tel:025521"]'); p2.remove();
  delete aldi.address; delete aldi.phone; delete aldi.website; delete aldi.tips; aldi.branches=null; c._showHours(aldi.id); const none=!q('.hourspop [data-hinfo]'); q(".hourspop")?.remove();
  c._view="settings"; c._setSec="stores"; c._storeSel=aldi.id; Object.assign(aldi,{address:"Hauptstr. 1, 48565 Steinfurt", phone:"02552 1234", website:"https://www.aldi-nord.de", tips:"Parkplatz hinten ist frei"}); c._renderAll(); await new Promise(r=>setTimeout(r,50));
  const f=(n)=>q('.srow[data-id="'+aldi.id+'"] [data-field="'+n+'"]')?.value;
  const fields={ address:f("address"), phone:f("phone"), website:f("website"), tips:f("tips") };
  const sent=[]; const ws=c._ws; c._ws=async(m)=>{ sent.push(m); return {}; };
  const ta=q('.srow[data-id="'+aldi.id+'"] [data-field="tips"]'); ta.value="Neu"; ta.dispatchEvent(new Event("change",{bubbles:true,composed:true}));
  c._ws=ws; Object.keys(aldi).forEach(k=>delete aldi[k]); Object.assign(aldi,keep); c._storeSel=null; c._setSec=null; c._view="list"; c._tab="all"; c._renderAll();
  return { tabClean, closed, opened, tipsStay, again, br, none, fields, sent:sent.map(m=>m.type+"|"+m.group_id+"|"+m.tips) }; })()`);
check("Steckbrief: kein ℹ️ im Reiter, im Fenster neben dem Namen, zuerst zugeklappt", r.tabClean && r.closed.inHead && r.closed.hidden === true && r.none, JSON.stringify(r));
check("Steckbrief: ℹ️ klappt Adresse, Telefon, Webseite und Tipps auf und wieder zu, Fenster bleibt offen", r.opened.shown && r.opened.still && r.opened.exp === "true" && r.opened.tel === "📞 02552 1234" && r.opened.map && /aldi-nord\.de$/.test(r.opened.web || "") && r.opened.tips === "💡 Parkplatz hinten ist frei" && r.tipsStay && r.again, JSON.stringify(r));
check("Steckbrief: Filiale mit Adresse/Telefon hat ihr eigenes ℹ️, ohne Infos keins", r.br.t0 && !r.br.t1 && r.br.hid === true && r.br.open, JSON.stringify(r));
check("Steckbrief: Felder in ⚙️ → Geschäfte, Tipps werden gespeichert", r.fields.address === "Hauptstr. 1, 48565 Steinfurt" && r.fields.phone === "02552 1234" && r.fields.website === "https://www.aldi-nord.de" && r.fields.tips === "Parkplatz hinten ist frei" && r.sent.length === 1 && /group\/update\|.+\|Neu$/.test(r.sent[0]), JSON.stringify(r));

// 18) 🎨 Neues Geschäft: bekannte Kette bekommt beim Tippen ihre Logo-Farbe, selbst gewählte Farbe bleibt (Idee 632)
r = await p.evaluate(`(async () => { const c=${card}; c._view="settings"; c._setSec="stores"; c._storeSel=null; c._renderAll(); await new Promise(r=>setTimeout(r,50));
  let form, nm, col; const grab=()=>{ form=c.shadowRoot.querySelector('form[data-addkind="stores"]'); nm=form.elements.name; col=form.elements.color; }; grab();
  const type=(v)=>{ nm.value=v; nm.dispatchEvent(new Event("input",{bubbles:true,composed:true})); return col.value; };
  const lidl=type("Lidl Borghorst"), rewe=type("REWE"), other=type("Bäcker Krimphove");
  const sent=[]; const ws=c._ws; c._ws=async(m)=>{ sent.push(m); return {}; };
  type("Edeka"); form.requestSubmit(); await new Promise(r=>setTimeout(r,30));
  grab(); col.value="#123456"; col.dispatchEvent(new Event("input",{bubbles:true,composed:true})); const manual=type("Aldi Süd");
  form.requestSubmit(); await new Promise(r=>setTimeout(r,30));
  c._ws=ws; c._setSec=null; c._view="list"; c._renderAll();
  return { lidl, rewe, other, manual, sent:sent.filter(m=>m.type==="einkaufsliste/group/add").map(m=>m.name+"|"+m.color) }; })()`);
check("Ketten-Farbe: Lidl blau, Rewe rot, unbekannt grau", r.lidl === "#0050aa" && r.rewe === "#cc071e" && r.other === "#607d8b", JSON.stringify(r));
check("Ketten-Farbe: wird mitgespeichert, selbst gewählte Farbe bleibt", r.manual === "#123456" && JSON.stringify(r.sent) === JSON.stringify(["Edeka|#ffd400", "Aldi Süd|#123456"]), JSON.stringify(r));

check("keine JavaScript-Fehler", errs.length === 0, errs.join(" | "));
await b.close(); srv.close();
if (fails) { console.log(`\n${fails} Prüfung(en) fehlgeschlagen`); process.exit(1); }
console.log("\nAlles ok 🎉");
