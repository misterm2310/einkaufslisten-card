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

// 19) 🔁 Umbenennen mit Folgen: nur auf der Liste = ohne Frage überall; steht es auch im Rezept = Frage „Überall / Nur hier“ (Idee 810)
r = await p.evaluate(`(async () => { const c=${card}; c._view="list"; c._page=null; c._tab="all"; const d=c._data; const keepI=d.items, keepR=d.recipes, keepF=d.favorites;
  const it=d.items.find(i=>!i.checked); const iid=it.id, nm=it.name; d.recipes=[]; d.favorites=[];
  const sent=[]; const ws=c._ws; c._ws=async(m)=>{ sent.push(m); return {}; };
  const edit=async(name)=>{ c._editing=iid; c._renderAll(); c._renderList(); await new Promise(r=>setTimeout(r,30)); c.shadowRoot.getElementById("edName").value=name; const pr=c._saveEdit(); await new Promise(r=>setTimeout(r,60)); return { pr }; };
  await (await edit("Naturjoghurt")).pr;
  const alone=sent.find(m=>m.type==="einkaufsliste/item/update"); sent.length=0;
  d.recipes=[{id:"r1",name:"Müsli",items:[{name:nm}]}];
  const { pr }=await edit("Skyr"); const pageTxt=c.shadowRoot.querySelector(".pagehost")?.textContent || document.body.textContent;
  const asked=/Wo umbenennen/.test(pageTxt);
  const btn=[...c.shadowRoot.querySelectorAll(".pagehost button"), ...document.querySelectorAll("[data-elov] button")].find(b=>/Nur hier/.test(b.textContent)); btn?.click(); await pr; await new Promise(r=>setTimeout(r,30));
  const here=sent.find(m=>m.type==="einkaufsliste/item/update");
  c._ws=ws; d.recipes=keepR; d.favorites=keepF; c._editing=null; c._renderAll();
  return { alone:alone && {name:alone.name, ev:alone.everywhere}, asked, here:here && {name:here.name, ev:here.everywhere ?? false} }; })()`);
check("Umbenennen: nur auf der Liste = Katalog zieht ohne Frage mit", r.alone?.name === "Naturjoghurt" && r.alone.ev === true, JSON.stringify(r));
check("Umbenennen: steht auch im Rezept = Frage, „Nur hier“ ändert nur den Artikel", r.asked && r.here?.name === "Skyr" && r.here.ev === false, JSON.stringify(r));
await back();

// 20) 🧠 Kategorie lernt mit: gelernte Wortteile gehen vor dem Wörterbuch (Idee 811)
r = await p.evaluate(`(async () => { const c=${card}; c._view="list"; c._page=null; c._renderAll(); const d=c._data; const keepC=d.categories; d.categories=[...keepC, {id:"tA",name:"Test A",color:"#111"},{id:"tB",name:"Test B",color:"#222"}]; c._renderAll(); const a=d.categories.at(-2), b2=d.categories.at(-1); const keepH=d.category_hints, keepL=d.category_learned;
  d.category_hints=[{id:a.id,words:["tofu"]}]; c._catManual=false; const inp=c.shadowRoot.getElementById("inName");
  const guess=(learned)=>{ d.category_learned=learned; inp.value="Räuchertofu"; c._onNameInput(); return c.shadowRoot.getElementById("inCat").value; };
  const res={ learned:guess({tofu:b2.id})===b2.id, dict:guess({})===a.id, longest:guess({tofu:a.id, "räuchertofu":b2.id})===b2.id };
  inp.value=""; d.category_hints=keepH; d.category_learned=keepL; d.categories=keepC; c._renderAll(); c._onNameInput(); return res; })()`);
check("Kategorie lernt mit: „Räuchertofu“ nimmt den gelernten Wortteil, der längste gewinnt", r.learned && r.dict && r.longest, JSON.stringify(r));

// 21) 📤 Drucken & Teilen: Link heißt neu, fragt Drucken oder QR; QR enthält die Liste als Text; Ausdruck mit Adresse + Zeiten (Ideen 829, 972)
r = await p.evaluate(`(async () => { const c=${card}; c._view="list"; c._page=null; c._tab="all"; const d=c._data; const keepI=d.items; const st=d.stores[1]; const keepS={...st};
  d.items=[{id:"a",name:"Milch",quantity:"2 L",checked:false,store_id:st.id},{id:"b",name:"Brot",checked:false,store_id:st.id,note:"Dinkel"}];
  Object.assign(st,{address:"Hauptstr. 1, 48565 Steinfurt", hours:[[["08:00","20:00"]],[["08:00","20:00"]],[["08:00","20:00"]],[["08:00","20:00"]],[["08:00","20:00"]],[["08:00","18:00"]],null]});
  c._renderAll(); await new Promise(r=>setTimeout(r,30)); const link=c.shadowRoot.querySelector('[data-act="print-list"]');
  const lab=link?.textContent.trim(); link.click(); await new Promise(r=>setTimeout(r,50));
  const pg=()=>c.shadowRoot.querySelector(".pagehost"); const title=pg().querySelector("h3")?.textContent;
  const hows=[...pg().querySelectorAll("[data-how]")].map(b=>b.textContent.trim());
  pg().querySelector('[data-how="qr"]').click(); await new Promise(r=>setTimeout(r,30)); pg().querySelector('[data-pr="'+st.id+'"]').click(); await new Promise(r=>setTimeout(r,30));
  const qr={ svg:pg().querySelectorAll(".prqrc svg path").length, txt:pg().querySelector(".prqrt")?.textContent };
  d.items=Array.from({length:30},(_, k)=>({id:"x"+k,name:"Produkt Nummer "+k,checked:false,store_id:st.id})); const mid=c._shareText(st.id);
  d.items=Array.from({length:150},(_, k)=>({id:"x"+k,name:"Produkt Nummer "+k,checked:false,store_id:st.id})); const many=c._shareText(st.id);
  const all150=Array.from({length:150},(_, k)=>"Produkt Nummer "+k).every(n=>many.parts.some(t=>t.split("\\n").includes("☐ "+n)));
  d.items=[{id:"a",name:"Milch",quantity:"2 L",checked:false,store_id:st.id}];
  const sheet=c._printSheet(st.id).html; const sheetAll=c._printSheet("all").html;
  c._pageBack(); c._pageBack(); c._pageBack();
  d.items=keepI; Object.keys(st).forEach(k=>delete st[k]); Object.assign(st,keepS); c._renderAll();
  return { lab, title, hows, qr, mid:{n:mid.parts.length}, many:{n:many.parts.length, all:all150, max:Math.max(...many.parts.map(t=>new TextEncoder().encode(t).length)), head:many.parts[1]?.split("\\n")[0]}, addr:/Hauptstr\. 1/.test(sheet), hrs:(sheet.match(/Mo–Fr 08:00 – 20:00 · Sa 08:00 – 18:00 · So zu/)||[])[0], allNoAddr:!/Hauptstr/.test(sheetAll) }; })()`);
check("Drucken & Teilen: Link heißt neu und fragt Drucken oder QR-Code", r.lab === "Drucken & Teilen" && r.title === "Drucken & Teilen" && r.hows.length === 2 && /Drucken/.test(r.hows[0]) && /QR-Code/.test(r.hows[1]), JSON.stringify(r));
check("QR-Code: Bild da, Text mit Kästchen, Menge und Notiz", r.qr.svg === 1 && /☐ 2 L Milch/.test(r.qr.txt) && /☐ Brot \(Dinkel\)/.test(r.qr.txt), JSON.stringify(r.qr));
check("QR-Code: immer ALLE Artikel – 30 in einem Code, 150 in mehreren Teilen „(2/n)“", r.mid.n === 1 && r.many.n > 1 && r.many.all && r.many.max <= 900 && /\(2\/\d+\)$/.test(r.many.head || ""), JSON.stringify({mid:r.mid, many:r.many}));
check("Ausdruck: ein Geschäft zeigt Adresse und Öffnungszeiten oben, „Alle“ nicht", r.addr && !!r.hrs && r.allNoAddr, JSON.stringify(r));

// 22) 🧘 Ruhiger Modus: Schalter in 👁️ Ansicht, Klasse an der Karte, keine Animationen (Idee 969)
r = await p.evaluate(`(async () => { const c=${card}; c._view="list"; c._page=null; const d=c._data; d.settings=d.settings||{}; const keep=d.settings.view_prefs; const me=c._hass?.user?.id || "u1";
  d.settings.view_prefs={...(keep||{}), [me]:{calm:true}}; c._renderAll(); await new Promise(r=>setTimeout(r,30)); const card=c.shadowRoot.querySelector("ha-card");
  const on=card.classList.contains("calm"); const tab=c.shadowRoot.querySelector(".tab"); const anim=tab ? getComputedStyle(tab).transitionDuration : "0s"; const filt=tab ? getComputedStyle(tab).filter : "";
  const cardFilter=getComputedStyle(card).filter;
  const html=c._myViewHtml ? "" : ""; d.settings.view_prefs=keep; c._renderAll(); const off=!card.classList.contains("calm");
  return { on, anim, filt, cardFilter, off }; })()`);
check("Ruhiger Modus: Karte bekommt „calm“, Farben gedämpft, keine Übergänge, kein Filter auf der ganzen Karte", r.on && r.off && /saturate/.test(r.filt) && /^0s/.test(r.anim) && r.cardFilter === "none", JSON.stringify(r));
r = await p.evaluate(`(() => { const s=document.querySelector("script[src*='einkaufsliste-card']")?.src; return [...document.querySelectorAll("*")].length>0; })()`);

// 23) ⌨️ Fenster per Tastatur: Öffnungszeiten mit „i“ am Reiter, Tab bleibt drin, Enter klappt ℹ️ auf, Escape schließt; Rückfrage mit Escape = Abbrechen (Idee 980)
r = await p.evaluate(`(async () => { const c=${card}; c._view="list"; c._page=null; const st=c._data.stores[1]; const keep={...st}; Object.assign(st,{address:"Markt 1", hours:[[["08:00","20:00"]],null,null,null,null,null,null]}); c._tab="all"; c._renderAll(); await new Promise(r=>setTimeout(r,30));
  const sr=c.shadowRoot; const tab=sr.querySelector('.tab[data-tab="'+st.id+'"]'); tab.focus(); tab.dispatchEvent(new KeyboardEvent("keydown",{key:"i",bubbles:true,composed:true}));
  await new Promise(r=>setTimeout(r,30)); const pop=sr.querySelector(".hourspop"); const opened=!!pop; const role=pop?.getAttribute("role"); const f0=sr.activeElement?.textContent;
  const key=(k,sh=false)=>document.dispatchEvent(new KeyboardEvent("keydown",{key:k,shiftKey:sh,bubbles:true}));
  const seen=[]; for (let i=0;i<4;i++){ key("Tab"); seen.push(sr.activeElement?.className || sr.activeElement?.tagName); }
  const inside=seen.every((x,i)=>{ return true; }) && pop.contains(sr.activeElement);
  const tg=pop.querySelector("[data-hinfo]"); tg.focus(); key("Enter"); const unfolded=!pop.querySelector('[data-hfor="s"]').hidden;
  key("Escape"); const closed=!sr.querySelector(".hourspop"); const backFocus=sr.activeElement===tab;
  const d=c._data; const it=d.items.find(i=>!i.checked); const keepR=d.recipes; d.recipes=[{id:"r1",name:"X",items:[{name:it.name}]}]; const sent=[]; const ws=c._ws; c._ws=async(m)=>{ sent.push(m); return {}; };
  c._editing=it.id; c._renderAll(); c._renderList(); await new Promise(r=>setTimeout(r,30)); sr.getElementById("edName").value=it.name+" Neu"; const pr=c._saveEdit(); await new Promise(r=>setTimeout(r,60));
  let fe=sr.activeElement; const focusBtn=fe?.textContent?.trim();
  key("Escape"); await Promise.race([pr, new Promise(r=>setTimeout(r,300))]); const res=sent.length===0 && c._editing===it.id ? null : "sent";
  c._ws=ws; d.recipes=keepR; c._editing=null; c._renderAll();
  Object.keys(st).forEach(k=>delete st[k]); Object.assign(st,keep); c._renderAll();
  return { opened, role, f0, seen, inside, unfolded, closed, backFocus, focusBtn, res }; })()`);
check("Tastatur: „i“ am Reiter öffnet die Öffnungszeiten als Dialog, Fokus auf OK", r.opened && r.role === "dialog" && r.f0 === "OK", JSON.stringify(r));
check("Tastatur: Tab bleibt im Fenster, Enter klappt ℹ️ auf, Escape schließt und gibt den Fokus zurück", r.inside && r.unfolded && r.closed && r.backFocus, JSON.stringify(r));
check("Tastatur: Rückfrage hat den Fokus auf der ersten Antwort, Escape = Abbrechen", /Überall umbenennen/.test(r.focusBtn || "") && r.res === null, JSON.stringify(r));
await back();

// 24) 🛒 Einkaufswagen oben auf der Liste: schiebt die Liste nicht nach oben (Kopf sichtbar = nichts passiert)
r = await p.evaluate(`(async () => { const c=${card}; c._view="list"; c._page=null; c._renderAll(); const sp=document.createElement("div"); sp.style.height="3000px"; document.body.append(sp);
  window.scrollTo(0, 0); const ic=c.shadowRoot.getElementById("titleIcon"); const y0=window.scrollY; ic.click(); await new Promise(r=>setTimeout(r,80)); const y1=window.scrollY;
  sp.remove(); return { y0, y1, view:c._view }; })()`);
check("Einkaufswagen auf der Liste: Liste springt nicht", r.y0 === r.y1 && r.view === "list", JSON.stringify(r));

// 25) ⚡ Aus „Erledigt“ zurückholen: steht sofort wieder auf der Liste, ohne auf Home Assistant zu warten
r = await p.evaluate(`(async () => { const c=${card}; c._view="list"; c._page=null; c._tab="all"; const it=c._data.items[0]; const keep={...it};
  Object.assign(it,{checked:true, checked_at:new Date().toISOString()}); c._doneOpen=true; c._renderAll(); await new Promise(r=>setTimeout(r,30));
  const ws=c._ws; let release; c._ws=()=>new Promise((ok)=>{ release=ok; });
  const wasDone=it.checked===true;
  c._readd(it); await new Promise(r=>setTimeout(r,20));
  const now={ checked:it.checked, row:!!c.shadowRoot.querySelector('.item[data-id="'+it.id+'"]'), openRows:[...c.shadowRoot.querySelectorAll(".item")].filter(e=>e.dataset.id===it.id).length };
  release({}); await new Promise(r=>setTimeout(r,20)); c._ws=ws; Object.assign(it, keep); c._doneOpen=false; c._renderAll();
  return { wasDone, now }; })()`);
check("Zurückholen: sofort wieder offen, noch bevor Home Assistant antwortet", r.wasDone && r.now.checked === false && r.now.row, JSON.stringify(r));

// 26) 🏬 Filialen: pro Filiale eine Zeile mit ✏️, Bearbeiten im eigenen Fenster (Speichern/Abbrechen/Löschen); ohne Filialen wie bisher
r = await p.evaluate(`(async () => { const c=${card}; const st=c._data.stores[1]; const keep={...st}; const q=(x)=>c.shadowRoot.querySelector(x); const w=()=>new Promise(r=>setTimeout(r,40));
  Object.assign(st,{address:null, phone:null, branches:[{id:"b1",name:"Borghorst",hours:null,address:"Markt 2"},{id:"b2",name:"Burgsteinfurt",hours:null}]});
  c._view="settings"; c._setSec="stores"; c._storeSel=st.id; c._hoursOpenFor=null; c._renderAll(); await w();
  const closedLbl=q('[data-act="hours-toggle"]')?.textContent.trim(); const stAddr=!!q('.srow[data-id="'+st.id+'"] [data-field="address"]'); const hint=/Adresse, Telefon und Tipps stehen bei jeder Filiale/.test(c.shadowRoot.textContent);
  c._hoursOpenFor=st.id; c._renderAll(); await w();
  const openLbl=q('[data-act="hours-toggle"]')?.textContent.trim(); const rows=c.shadowRoot.querySelectorAll(".brrow").length; const row1=q(".brrow")?.textContent; const noInputs=!q(".brrow input, .brrow textarea");
  const sent=[]; const ws=c._ws; c._ws=async(m)=>{ sent.push(m); return {}; };
  // ✏️ Burgsteinfurt bearbeiten: Fenster mit den Feldern, Zeiten werden erst mit Speichern geschickt
  q('[data-act="hours-bredit"][data-bid="b2"]').click(); await w(); let pop=q(".brpop");
  const popName=pop?.querySelector('[data-bf="name"]').value; const focus=c.shadowRoot.activeElement?.dataset?.bf;
  pop.querySelector('[data-bf="phone"]').value="02551 99"; pop.querySelector('[data-bf="address"]').value="Bahnhofstr. 1"; pop.querySelector('[data-bf="tips"]').value="Parkplatz hinten";
  const day=pop.querySelector('.hd[data-wd="0"]'); day.querySelector('[data-hf="from"]').value="08:00"; day.querySelector('[data-hf="to"]').value="20:00"; day.querySelector('[data-hf="to"]').dispatchEvent(new Event("change",{bubbles:true,composed:true}));
  const sentBeforeSave=sent.length;
  pop.querySelector('[data-bact="save"]').click(); await w();
  const saved=sent.at(-1)?.branches; const popGone=!q(".brpop");
  // Abbrechen schickt nichts
  q('[data-act="hours-bredit"][data-bid="b1"]').click(); await w(); pop=q(".brpop"); pop.querySelector('[data-bf="name"]').value="Weg damit"; const n0=sent.length; pop.querySelector('[data-bact="cancel"]').click(); const cancelOk=sent.length===n0 && !q(".brpop");
  // Löschen braucht zwei Tipper
  q('[data-act="hours-bredit"][data-bid="b1"]').click(); await w(); pop=q(".brpop"); const del=pop.querySelector('[data-bact="del"]'); del.click(); const n1=sent.length; const sure=/Wirklich/.test(del.textContent); del.click(); await w(); const delOk=sure && n1===n0 && sent.at(-1)?.branches?.length===1 && sent.at(-1).branches[0].id==="b2";
  // ＋ Filiale öffnet ein leeres Fenster, ohne Namen wird nichts gespeichert
  q('[data-act="hours-bradd"]').click(); await w(); pop=q(".brpop"); const newEmpty=pop.querySelector('[data-bf="name"]').value==="" && !pop.querySelector('[data-bact="del"]'); const n2=sent.length; pop.querySelector('[data-bact="save"]').click(); const noName=sent.length===n2 && !!q(".brpop");
  pop.querySelector('[data-bf="name"]').value="Neuenkirchen"; pop.querySelector('[data-bact="save"]').click(); await w(); const added=sent.at(-1)?.branches?.at(-1)?.name==="Neuenkirchen" && sent.at(-1).branches.length===3;
  const stTips=!!q('.srow[data-id="'+st.id+'"] [data-field="tips"]'), stWeb=!!q('.srow[data-id="'+st.id+'"] [data-field="website"]');
  st.branches=saved; c._view="list"; c._renderAll(); c._showHours(st.id); const hp=c.shadowRoot.querySelector(".hourspop"); hp.querySelector('[data-hinfo="b1"]')?.click(); const popTips=hp.querySelector('[data-hfor="b1"] .htips')?.textContent; hp.remove(); c._view="settings"; c._renderAll();
  st.branches=null; c._hoursOpenFor=null; c._renderAll(); await w();
  const plainLbl=q('[data-act="hours-toggle"]')?.textContent.trim(); const plainAddr=!!q('.srow[data-id="'+st.id+'"] [data-field="address"]');
  c._ws=ws; Object.keys(st).forEach(k=>delete st[k]); Object.assign(st,keep); c._storeSel=null; c._setSec=null; c._view="list"; c._renderAll();
  return { closedLbl, stAddr, hint, openLbl, rows, row1, noInputs, popName, focus, sentBeforeSave, saved, popGone, cancelOk, delOk, newEmpty, noName, added, stTips, stWeb, popTips, plainLbl, plainAddr }; })()`);
check("Filialen: Knopf heißt „🏬 Filialen ändern“, Adresse/Telefon des Geschäfts weg, Hinweis da", r.closedLbl === "🏬 Filialen ändern" && !r.stAddr && r.hint && /^🏬 Filialen/.test(r.openLbl), JSON.stringify(r));
check("Filialen: pro Filiale nur eine kurze Zeile mit Adresse, ohne Eingabefelder", r.rows === 2 && /Borghorst/.test(r.row1) && /Markt 2/.test(r.row1) && r.noInputs, JSON.stringify(r));
check("Filialen-Fenster: ✏️ öffnet die Filiale, Name hat den Fokus, Zeiten gehen erst mit Speichern raus", r.popName === "Burgsteinfurt" && r.focus === "name" && r.sentBeforeSave === 0 && r.popGone && r.saved?.[1]?.phone === "02551 99" && r.saved?.[1]?.address === "Bahnhofstr. 1" && r.saved?.[1]?.tips === "Parkplatz hinten" && JSON.stringify(r.saved?.[1]?.hours?.[0]) === '[["08:00","20:00"]]' && r.saved?.[0]?.address === "Markt 2", JSON.stringify(r));
check("Filialen-Fenster: Abbrechen schickt nichts, Löschen braucht zwei Tipper", r.cancelOk && r.delOk, JSON.stringify(r));
check("Filialen-Fenster: ＋ Filiale öffnet leeres Fenster, ohne Namen kein Speichern", r.newEmpty && r.noName && r.added, JSON.stringify(r));
check("Filialen: Tipps pro Filiale im ℹ️ des Zeiten-Fensters, beim Geschäft nur noch die Webseite", !r.stTips && r.stWeb && r.popTips === "💡 Parkplatz hinten", JSON.stringify(r));
check("Ohne Filialen: Öffnungszeiten-Knopf und Adresse wie bisher", /Öffnungszeiten eintragen/.test(r.plainLbl) && r.plainAddr, JSON.stringify(r));

// 26b) 🎌 Feiertage pro Geschäft: Auswahl Automatisch / Kalender / Keine – „Keine“ = an Feiertagen offen
r = await p.evaluate(`(async () => { const c=${card}; const q=(x)=>c.shadowRoot.querySelector(x); const w=()=>new Promise(r=>setTimeout(r,40));
  const today=new Date(); const k=today.getFullYear()+"-"+String(today.getMonth()+1).padStart(2,"0")+"-"+String(today.getDate()).padStart(2,"0");
  const orig=structuredClone(c._data); const nd=structuredClone(c._data); const conn=c._hass.connection; const sub=conn.subscribeMessage;
  Object.assign(nd,{holidays:{[k]:"Testtag"},holidays_by_cal:{"calendar.de":{[k]:"Testtag"},"calendar.ch":{}},holiday_cals:["calendar.ch","calendar.de"]});
  const st=nd.stores[1]; st.hours=Array(7).fill([["00:00","23:59"]]); st.branches=null;
  const feed=async(d)=>{ conn.subscribeMessage=async(cb)=>{ cb(structuredClone(d)); return ()=>{}; }; await c._subscribe(); conn.subscribeMessage=sub; await w(); };
  const closed=async(v)=>{ st.holiday_cal=v; await feed(nd); c._renderAll(); await w(); return !!q('.tab.closed[data-tab="'+st.id+'"]'); };
  const auto=await closed(null), none=await closed("none"), ch=await closed("calendar.ch"), de=await closed("calendar.de");
  st.holiday_cal=null; await feed(nd);
  c._view="settings"; c._setSec="stores"; c._lastSetSec="stores"; c._storeSel=st.id; c._hoursOpenFor=st.id; c._renderAll(); await w();
  const sel=q('select[data-act="holcal"]'); const opts=sel?[...sel.options].map(o=>o.value):[];
  const sent=[]; const ws=c._ws; c._ws=async(m)=>{ sent.push(m); return {}; };
  if (sel) { sel.value="none"; sel.dispatchEvent(new Event("change",{bubbles:true,composed:true})); await w(); }
  c._ws=ws; c._hoursOpenFor=null; c._storeSel=null; c._setSec=null; c._view="list"; await feed(orig); c._renderAll();
  return { auto, none, ch, de, opts, msg: sent[0] }; })()`);
check("Feiertage pro Geschäft: Automatisch zu, Keine offen, nur Schweiz offen, nur DE zu", r.auto === true && r.none === false && r.ch === false && r.de === true, JSON.stringify(r));
check("Feiertage pro Geschäft: Auswahl mit Automatisch, Kalendern, Keine – schickt holiday_cal", JSON.stringify(r.opts) === '["","calendar.ch","calendar.de","none"]' && r.msg?.holiday_cal === "none" && r.msg?.type === "einkaufsliste/group/update", JSON.stringify(r));

// 27) 📂 Kategorien in der Liste: Standard offen, antippen klappt zu (Zahl bleibt), nochmal auf
r = await p.evaluate(`(async () => { const c=${card}; c._view="list"; c._page=null; c._tab="all"; c._closedCats=null; c._renderAll(); await new Promise(r=>setTimeout(r,30));
  const q=(x)=>c.shadowRoot.querySelector(x); const head=q("#list .cathead"); const key=head?.dataset.cat; const grp=()=>q('#list .cathead[data-cat="'+key+'"]').closest(".group");
  const before={ open:head.getAttribute("aria-expanded"), rows:grp().querySelectorAll(".item").length };
  head.click(); await new Promise(r=>setTimeout(r,30)); const closed={ open:q('#list .cathead[data-cat="'+key+'"]').getAttribute("aria-expanded"), rows:grp().querySelectorAll(".item").length, n:grp().querySelector(".n")?.textContent };
  q('#list .cathead[data-cat="'+key+'"]').click(); await new Promise(r=>setTimeout(r,30)); const again=grp().querySelectorAll(".item").length;
  return { before, closed, again }; })()`);
check("Kategorien: Standard offen, antippen klappt zu (Anzahl bleibt sichtbar), nochmal = auf", r.before.open === "true" && r.before.rows > 0 && r.closed.open === "false" && r.closed.rows === 0 && r.closed.n === String(r.before.rows) && r.again === r.before.rows, JSON.stringify(r));

// 28) 📄 PDF: echte Datei mit allen Artikeln (Umlaute bleiben, Emojis fallen weg); iPhone = nur PDF-Knopf, HA-App = Link über Home Assistant
r = await p.evaluate(async () => { const c=document.querySelector('#c1'); const it=c._data.items[0]; const keep={name:it.name, note:it.note, checked:it.checked};
  it.name="Brötchen 🥐 (Süß)"; it.note="für Käse"; it.checked=false;
  let blob=null, a=null; const o=URL.createObjectURL; URL.createObjectURL=(x)=>{ blob=x; return "blob:x"; };
  const oc=HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click=function(){ a=this; };
  await c._pdfShare("all"); URL.createObjectURL=o; HTMLAnchorElement.prototype.click=oc;
  const buf=new Uint8Array(await blob.arrayBuffer()); let raw=""; for (const x of buf) raw+=String.fromCharCode(x);
  const head=raw.slice(0,8), eof=/%%EOF\n$/.test(raw), name=a?.download, pages=(raw.match(/\/Type \/Page /g)||[]).length;
  const hasName=raw.includes("(Br\\366tchen \\(S\\374\\337\\))"), noEmoji=![...raw].some((ch)=>ch.charCodeAt(0)>255);
  const xref=+raw.match(/startxref\n(\d+)/)[1]; const xrefOk=raw.slice(xref, xref+4)==="xref";
  // 📱 HA-App: PDF geht per Websocket an Home Assistant, dann wird der Link geöffnet
  const sent=[]; const ws=c._ws; c._ws=async(m)=>{ sent.push(m); return { url:"/api/einkaufsliste/pdf/tok/x.pdf" }; };
  const ia=c._inHaApp; c._inHaApp=()=>true; const wo=window.open; let opened=null; window.open=(u)=>{ opened=u; return null; };
  await c._pdfShare("all"); c._inHaApp=ia; window.open=wo; c._ws=ws;
  const appOk=sent[0]?.type==="einkaufsliste/pdf/store" && atob(sent[0].data).startsWith("%PDF-") && /\/api\/einkaufsliste\/pdf\/tok\/x\.pdf$/.test(opened||"");
  // 🍏 iPhone: im Drucken-Fenster nur der PDF-Knopf
  Object.defineProperty(navigator,"userAgent",{configurable:true,get:()=>"Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)"});
  c._printPage(); await new Promise(r=>setTimeout(r,60)); const host=c.shadowRoot;
  host.querySelector('[data-how="print"]')?.click(); await new Promise(r=>setTimeout(r,40));
  const st=[...host.querySelectorAll("button")].find(b=>/Alle Geschäfte/.test(b.textContent)); st?.click(); await new Promise(r=>setTimeout(r,40));
  const iphone={ go:!!host.querySelector("[data-prgo]"), pdf:host.querySelector("[data-prpdf]")?.textContent.trim(), st:!!st };
  delete navigator.userAgent;
  Object.assign(it,keep); let n=0; while (c._page && n++<6) c._pageBack(); c._renderAll();
  return { head, eof, name, pages, hasName, noEmoji, xrefOk, appOk, opened, iphone }; });
check("PDF: echte Datei (Kopf, Ende, Verzeichnis stimmt), Name mit Datum", r.head.startsWith("%PDF-1.4") && r.eof && r.xrefOk && /^Einkaufsliste-\d{4}-\d\d-\d\d\.pdf$/.test(r.name) && r.pages >= 1, JSON.stringify(r));
check("PDF: Umlaute bleiben, Emojis fallen weg", r.hasName && r.noEmoji, JSON.stringify(r));
check("PDF in der HA-App: geht an Home Assistant, Link wird geöffnet", r.appOk, JSON.stringify(r));
check("PDF auf dem iPhone: nur „PDF drucken / teilen“, kein Browser-Drucken", r.iphone.go === false && /PDF drucken \/ teilen/.test(r.iphone.pdf || ""), JSON.stringify(r));

// 29) 🔨 Nicht unter „Alle“ zeigen: Artikel nur im eigenen Reiter, Zahl bei „Alle“ ohne sie (Issue #23)
r = await p.evaluate(async () => { const c=document.querySelector('#c1'); const st=c._data.stores[1]; const keep=st.not_in_all; const q=(x)=>c.shadowRoot.querySelector(x);
  const mine=c._data.items.filter((i)=>!i.checked && i.store_id===st.id).length; const total=c._data.items.filter((i)=>!i.checked).length;
  c._tab="all"; c._view="list"; c._renderAll(); await new Promise(r=>setTimeout(r,40));
  const before=+q('.tab[data-tab="all"] .n')?.textContent;
  st.not_in_all=true; c._renderAll(); await new Promise(r=>setTimeout(r,40));
  const after=+q('.tab[data-tab="all"] .n')?.textContent; const inAllList=c._data.items.filter((i)=>c._matchesTab(i) && i.store_id===st.id).length;
  c._tab=st.id; const inOwn=c._data.items.filter((i)=>!i.checked && c._matchesTab(i) && i.store_id===st.id).length; c._tab="all";
  c._view="settings"; c._setSec="stores"; c._lastSetSec="stores"; c._storeSel=st.id; c._renderAll(); await new Promise(r=>setTimeout(r,40));
  const sw=q('[data-act="store-notinall"]')?.getAttribute("aria-pressed");
  st.not_in_all=keep; c._storeSel=null; c._setSec=null; c._view="list"; c._renderAll();
  return { mine, total, before, after, inAllList, inOwn, sw }; });
check("Nicht unter „Alle“: Zahl bei „Alle“ ohne das Geschäft, Artikel nur im eigenen Reiter, Schalter da", r.mine > 0 && r.before === r.total && r.after === r.total - r.mine && r.inAllList === 0 && r.inOwn === r.mine && r.sw === "true", JSON.stringify(r));

// 30) ❌ War nicht da: Knopf im ⇄-Fenster (abschaltbar), Artikel grau mit „war nicht da“, unter „Erledigt“ mit ❌ statt ✔
r = await p.evaluate(async () => { const c=document.querySelector('#c1'); const q=(x)=>c.shadowRoot.querySelector(x);
  c._tab="all"; c._view="list"; c._renderAll(); await new Promise(r=>setTimeout(r,40));
  const it=c._data.items.find((i)=>!i.checked && i.store_id); const keep={ gone_at:it.gone_at, out_at:it.out_at, checked:it.checked, checked_at:it.checked_at, checked_by:it.checked_by };
  const sent=[]; const ws=c._ws; c._ws=async(m)=>{ sent.push(m); return {}; };
  c._moving=it.id; c._renderList(); await new Promise(r=>setTimeout(r,30));
  const btn=q('.moverow [data-act="move-gone"]'); const label=btn?.textContent.trim(); btn?.click(); await new Promise(r=>setTimeout(r,30));
  const msg=sent[0];
  it.gone_at=new Date().toISOString(); it.out_at=null; c._renderList(); await new Promise(r=>setTimeout(r,30));
  const row=()=>q('.item[data-id="'+it.id+'"]');
  const open={ cls:row()?.classList.contains("gone"), txt:row()?.querySelector(".igone")?.textContent, out:!!row()?.querySelector(".iout:not(.igone)") };
  it.checked=true; it.checked_by=null; it.checked_at=new Date().toISOString(); const tmp=document.createElement("div"); tmp.innerHTML=c._itemHtml(it);
  const done={ icon:tmp.querySelector(".check ha-icon")?.getAttribute("icon"), txt:tmp.querySelector(".igone")?.textContent, auto:/automatisch/.test(tmp.textContent||"") };
  // 🎚️ abgeschaltet: kein Knopf mehr
  Object.assign(it, keep); delete it.gone_at; const vp=c._data.settings.view_prefs||{}; const keepVp=vp._all; c._data.settings.view_prefs={...vp, _all:{...(vp._all||{}), gone:false}}; c._viewKey=null;
  c._moving=it.id; c._renderList(); await new Promise(r=>setTimeout(r,30)); const off=!q('.moverow [data-act="move-gone"]');
  c._data.settings.view_prefs={...vp, _all:keepVp}; if (keepVp===undefined) delete c._data.settings.view_prefs._all; c._viewKey=null;
  c._moving=null; c._ws=ws; Object.assign(it, keep); if (!keep.gone_at) delete it.gone_at; c._renderAll();
  return { label, msg, open, done, off }; });
check("War nicht da: Knopf im ⇄-Fenster schickt item/gone", r.label === "War nicht da" && r.msg?.type === "einkaufsliste/item/gone", JSON.stringify(r));
check("War nicht da: Artikel grau mit „❌ war nicht da (Tag)“, kein „war aus“", r.open.cls && /❌ war nicht da \(/.test(r.open.txt || "") && !r.open.out, JSON.stringify(r));
check("War nicht da: unter „Erledigt“ mit normalem ✔ und „❌ war nicht da“, kein „automatisch“", r.done.icon === "mdi:check-circle" && /❌ war nicht da/.test(r.done.txt || "") && !r.done.auto, JSON.stringify(r));
check("War nicht da: in der Listenansicht abschaltbar", r.off, JSON.stringify(r));

// 31) 📅 „Abgehakt von“ zeigt auch Tag und Uhrzeit
r = await p.evaluate(() => { const c=document.querySelector('#c1'); const it={ ...c._data.items[0], checked:true, checked_by:"Marco", checked_at:new Date(2026,9,30,20,15).toISOString() };
  const t=document.createElement("div"); t.innerHTML=c._itemHtml(it); const a=[...t.querySelectorAll(".meta span[title]")].map((x)=>x.getAttribute("title")).find((x)=>/bgehakt/.test(x));
  const t2=document.createElement("div"); t2.innerHTML=c._itemHtml({ ...it, checked_by:null }); const b=[...t2.querySelectorAll(".meta span[title]")].map((x)=>x.getAttribute("title")).find((x)=>/bgehakt/.test(x));
  return { a, b }; });
check("Abgehakt von: mit Tag und Uhrzeit (auch bei automatisch)", r.a === "Abgehakt von Marco am Fr 30.10. um 20:15" && r.b === "Automatisch abgehakt am Fr 30.10. um 20:15", JSON.stringify(r));

// 32) 📬 Gemeldete Angebote (eigene Automation, CHF): Preis mit Währung, Quelle unten
r = await p.evaluate(async () => { const c=document.querySelector('#c1'); const root=c.shadowRoot;
  const it=c._data.items.find((i)=>!i.checked); const keepOff=c._data.offers;
  const o={ id:"ext-1", r:"Denner", p:2.95, op:3.95, to:new Date(Date.now()+3*864e5).toISOString().slice(0,10), d:"Pink Lady 1 kg", cur:"CHF", src:"denner", img:null };
  c._data.offers={ [it.name.toLowerCase()]: [o] };
  const label=c._offerLabel(o); const eurLabel=c._offerLabel({ p:1.19 });
  c._showOffers(it); await new Promise(r=>setTimeout(r,60));
  const txt=(root.textContent||"") + (document.body.textContent||"");
  const page={ price:/2,95 CHF/.test(txt), old:/3,95 CHF/.test(txt), src:/eigenen Automation/.test(txt) && /denner/.test(txt), mg:/Marktguru \(inoffiziell\)/.test(txt) };
  c._closePage?.(); document.querySelectorAll("body > div").forEach((d)=>{ if (/Pink Lady/.test(d.textContent||"")) d.remove(); });
  const tmp=document.createElement("div"); tmp.innerHTML=c._itemHtml({ ...it, offer:{ p:2.95, r:"Denner", cur:"CHF", to:o.to } });
  const tag=tmp.querySelector(".offinfo")?.textContent||"";
  c._data.offers=keepOff; c._renderAll();
  return { label, eurLabel, page, tag }; });
check("Gemeldete Angebote: Preis in CHF (Etikett, Fenster, am Artikel), sonst €", /2,95 CHF/.test(r.label) && /1,19 €/.test(r.eurLabel) && r.page.price && r.page.old && /2,95 CHF/.test(r.tag), JSON.stringify(r));
check("Gemeldete Angebote: Quelle „eigene Automation“ statt Marktguru", r.page.src && !r.page.mg, JSON.stringify(r));

// 33) 🔗 Link zum Angebot: Knopf im Fenster, kleines 🔗 am Artikel, nur https, Tippen hakt nicht ab
r = await p.evaluate(async () => { const c=document.querySelector('#c1'); const root=c.shadowRoot;
  const it=c._data.items.find((i)=>!i.checked); const keepOff=c._data.offers;
  const o={ id:"ext-2", r:"Coop", p:31.5, d:"Prosecco", cur:"CHF", src:"coop", url:"https://www.coop.ch/de/p/4922122" };
  c._data.offers={ [it.name.toLowerCase()]: [o, { ...o, id:"ext-3", url:"javascript:alert(1)" }] };
  c._showOffers(it); await new Promise(r=>setTimeout(r,60));
  const links=[...root.querySelectorAll("a.offlink"), ...document.querySelectorAll("a.offlink")].filter((a)=>a.offsetParent || a.isConnected);
  const win={ n:links.length, href:links[0]?.getAttribute("href"), target:links[0]?.getAttribute("target"), rel:links[0]?.getAttribute("rel"), txt:links[0]?.textContent.trim() };
  c._closePage?.(); document.querySelectorAll("body > div").forEach((d)=>{ if (/Prosecco/.test(d.textContent||"")) d.remove(); });
  c._data.offers=keepOff;
  const keep=it.offer; it.offer={ p:31.5, r:"Coop", cur:"CHF", url:o.url }; c._renderList(); await new Promise(r=>setTimeout(r,30));
  const a=root.querySelector('.item[data-id="'+it.id+'"] a.offlink');
  const sent=[]; const ws=c._ws; c._ws=async(m)=>{ sent.push(m); return {}; };
  a?.addEventListener("click",(e)=>e.preventDefault(),{ once:true }); a?.click(); await new Promise(r=>setTimeout(r,40));
  c._ws=ws; const stillOpen=!it.checked; if (keep===undefined) delete it.offer; else it.offer=keep; c._renderAll();
  return { win, item:{ has:!!a, href:a?.getAttribute("href") }, sent:sent.map((m)=>m.type), stillOpen }; });
check("Link zum Angebot: „🔗 Zum Angebot“ im Fenster (nur https, neues Fenster)", r.win.n === 1 && r.win.href === "https://www.coop.ch/de/p/4922122" && r.win.target === "_blank" && /noopener/.test(r.win.rel || "") && /Zum Angebot/.test(r.win.txt || ""), JSON.stringify(r));
check("Link zum Angebot: kleines 🔗 am Artikel, Tippen hakt nicht ab", r.item.has && r.item.href === "https://www.coop.ch/de/p/4922122" && r.stillOpen && !r.sent.some((t)=>/check|toggle/.test(t)), JSON.stringify(r));

// 34) ✔️ „Erledigt“: unter 👁️ Ansicht ausblenden / eingeklappt starten, Gerät merkt sich Auf/Zu
r = await p.evaluate(async () => { const c=document.querySelector('#c1'); const q=(x)=>c.shadowRoot.querySelector(x);
  const it=c._data.items.find((i)=>!i.checked); const keep={ checked:it.checked, checked_at:it.checked_at, checked_by:it.checked_by };
  it.checked=true; it.checked_at=new Date(Date.now()-864e5).toISOString(); c._tab="all"; c._view="list";
  const vp=c._data.settings.view_prefs||{}; const keepAll=vp._all; const setAll=(x)=>{ c._data.settings.view_prefs={ ...vp, _all:{ ...(keepAll||{}), ...x } }; c._viewKey=null; };
  try { localStorage.removeItem("einkaufsliste_done_open"); } catch (_) {}
  const head=()=>q(".donebox:not(.justbox) .donehead");
  c._doneOpen=null; c._renderAll(); await new Promise(r=>setTimeout(r,40)); const std={ there:!!head(), open:head()?.getAttribute("aria-expanded") };
  setAll({ done_open:false }); c._doneOpen=null; c._renderList(); await new Promise(r=>setTimeout(r,30)); const folded=head()?.getAttribute("aria-expanded");
  head()?.click(); await new Promise(r=>setTimeout(r,30)); let saved=null; try { saved=localStorage.getItem("einkaufsliste_done_open"); } catch (_) {}
  c._doneOpen=null; c._renderList(); await new Promise(r=>setTimeout(r,30)); const remembered=head()?.getAttribute("aria-expanded"); // wie nach dem Neuladen
  setAll({ done:false }); c._renderList(); await new Promise(r=>setTimeout(r,30)); const hidden=!head();
  // Einstellungs-Seite: eigener Aufklapper „Erledigt“ mit zwei Häkchen
  const tmp=document.createElement("div"); tmp.innerHTML=c._viewHtml(); const keys=[...tmp.querySelectorAll('[data-act="view-toggle"]')].map((b)=>b.dataset.key);
  const page={ done:keys.includes("done"), open:keys.includes("done_open"), title:/Erledigt/.test(tmp.textContent||"") };
  c._data.settings.view_prefs={ ...vp }; if (keepAll===undefined) delete c._data.settings.view_prefs._all; c._viewKey=null;
  try { localStorage.removeItem("einkaufsliste_done_open"); } catch (_) {}
  Object.assign(it, keep); c._doneOpen=null; c._renderAll();
  return { std, folded, saved, remembered, hidden, page }; });
check("Erledigt: Standard sichtbar und offen", r.std.there && r.std.open === "true", JSON.stringify(r));
check("Erledigt: „startet aufgeklappt“ aus = eingeklappt", r.folded === "false", JSON.stringify(r));
check("Erledigt: Antippen merkt sich das Gerät (auch nach Neuladen)", r.saved === "1" && r.remembered === "true", JSON.stringify(r));
check("Erledigt: Bereich ganz ausblendbar", r.hidden, JSON.stringify(r));
check("Erledigt: eigener Aufklapper unter 👁️ Ansicht mit beiden Häkchen", r.page.done && r.page.open && r.page.title, JSON.stringify(r));

// 35) 📍 Geschäft ohne Zone: Adress-Punkt + Umkreis zählt wie eine Zone (nächstes Geschäft, dicker Rand); neue Ordner in ⚙️ → Geschäfte
r = await p.evaluate(async () => { const c=document.querySelector('#c1'); const d=c._data; const st=d.stores[1]; const keepGeo=d.geo; const keepSt={...st}; const keepRad=d.settings.geo_radius;
  const states=c._hass.states; const uid=c._hass.user?.id || "u1"; c._hass.user = c._hass.user || { id: uid };
  states["person.test"]={entity_id:"person.test", state:"not_home", attributes:{user_id:uid, latitude:52.10030, longitude:7.30000}}; // ~33 m vom Punkt
  st.zones=[]; st.zone=null; d.geo={ [st.id]:{ points:[{b:null, lat:52.1, lon:7.3}], missing:[], waiting:[] } }; d.settings.geo_radius=50;
  const near50=c._nearStore(); const vp=c._viewPrefs; const here50=c._someoneAt(st);
  d.settings.geo_radius=30; const near30=c._nearStore();
  d.settings.geo_radius=50; c._view="settings"; c._setSec="stores"; c._lastSetSec="stores"; c._storeSel=st.id; c._accOpen={...(c._accOpen||{}), store:"place"}; c._renderAll(); await new Promise(r=>setTimeout(r,60));
  const sr=c.shadowRoot; const groups=[...sr.querySelectorAll(".storeset .xacc")].map(x=>x.dataset.k); const line=sr.querySelector(".geoline")?.textContent||""; const rad=sr.querySelector("[data-georadius]")?.value;
  const labels=[...sr.querySelectorAll(".storeset .flab span")].map(x=>x.textContent);
  delete states["person.test"]; d.geo=keepGeo; Object.assign(st,keepSt); d.settings.geo_radius=keepRad; c._storeSel=null; c._view="list"; c._renderAll();
  return { near50: near50===st.id, here50, near30, groups, line, rad, labels }; });
check("Ohne Zone: im Umkreis 50 m wird das Geschäft erkannt (auch „Jemand ist gerade dort“)", r.near50 && r.here50 === true, JSON.stringify(r));
check("Ohne Zone: bei 30 m Umkreis zu weit weg", r.near30 === null, JSON.stringify(r));
check("Geschäfte-Einstellungen: fünf Ordner, Feld-Überschriften, Ort gefunden, Umkreis-Auswahl", JSON.stringify(r.groups) === '["look","place","hours","list","scan"]' && /Ort gefunden/.test(r.line) && r.rad === "50" && r.labels.includes("Adresse") && r.labels.includes("Telefon"), JSON.stringify(r));

// 36) 🌐 OpenStreetMap-Suche (Issue #30): „Suche läuft“ bleibt als Seite stehen, Treffer auf derselben Seite, Antippen übernimmt
r = await p.evaluate(async () => { const c=document.querySelector('#c1'); const d=c._data; const st=d.stores[1]; const keep={...st}; const ws=c._ws; const calls=[]; let release;
  c._ws=async(m)=>{ calls.push(m); if (m.type==="einkaufsliste/hours/search") { await new Promise(r=>{release=r;}); return { results:[{name:"Coop",place:"Lugano",address:"Via Nassa 22, 6900 Lugano",distance_km:0,raw:"Mo-Sa 08:00-18:30; Su,PH off",hours:[[["08:00","18:30"]],[["08:00","18:30"]],[["08:00","18:30"]],[["08:00","18:30"]],[["08:00","18:30"]],[["08:00","18:30"]],null]}] }; } return {}; };
  st.branches=[]; c._view="settings"; c._setSec="stores"; c._lastSetSec="stores"; c._storeSel=st.id; c._accOpen={...(c._accOpen||{}), store:"hours"}; c._renderAll(); await new Promise(r=>setTimeout(r,60));
  c.shadowRoot.querySelector('[data-act="hours-toggle"]')?.click(); await new Promise(r=>setTimeout(r,120));
  c.shadowRoot.querySelector('[data-act="hours-osm"]')?.click(); await new Promise(r=>setTimeout(r,120));
  const inp=c.shadowRoot.querySelector(".pagehost input"); if (inp) inp.value="N6698847448";
  [...c.shadowRoot.querySelectorAll(".pagehost button")].find(b=>/OK/.test(b.textContent))?.click(); await new Promise(r=>setTimeout(r,150));
  const txt=()=>c.shadowRoot.querySelector(".pagehost")?.textContent||"";
  const waiting=/Suche läuft/.test(txt()) && !!c._page; release(); await new Promise(r=>setTimeout(r,150));
  const found=/Coop/.test(txt()) && /Gefunden bei OpenStreetMap/.test(txt()); const sent=calls.find(x=>x.type==="einkaufsliste/hours/search");
  [...c.shadowRoot.querySelectorAll('.pagehost button[data-mode="store"]')][0]?.click(); await new Promise(r=>setTimeout(r,250));
  const upd=calls.find(x=>x.type==="einkaufsliste/group/update"); const closed=!c._page;
  c._ws=ws; Object.assign(st,keep); c._storeSel=null; c._view="list"; c._renderAll();
  return { waiting, found, sent, upd: !!(upd && upd.hours && upd.address), closed }; });
check("OSM-Suche: „Suche läuft“ bleibt als Seite stehen, bis die Antwort da ist", r.waiting && r.sent?.store_id && r.sent?.name === "N6698847448", JSON.stringify(r));
check("OSM-Suche: Treffer auf derselben Seite, „Für das Geschäft“ übernimmt Zeiten + Adresse und schließt", r.found && r.upd && r.closed, JSON.stringify(r));

// 37) 📺 Kochmodus-Anzeige: der Kochmodus meldet Schritt + Zutaten an HA (nur bei Änderung), Schließen schaltet aus; die Anzeige-Karte zeigt es groß
r = await p.evaluate(async () => { const c=document.querySelector('#c1'); const calls=[]; const old=c._hass.callWS; c._hass.callWS=async(m)=>{ calls.push(m); return {}; }; c._ws=async()=>({});
  document.querySelectorAll("[data-elcook]").forEach(o=>o._elClose?.()); calls.length=0;
  const r={id:"rk",name:"Lasagne",items:[{name:"Hack",quantity:"500 g"}],steps:"Zwiebeln würfeln.\nHack anbraten 10 Minuten.",heat:[],servings:4,servings_unit:"persons"};
  c._data.recipes=[r]; c._cookMode(r, 0, false); await new Promise(r=>setTimeout(r,150));
  const ov=document.querySelector("[data-elcook]"); const sets=()=>calls.filter(m=>m.type==="einkaufsliste/cook/set");
  const first=sets()[0]; [...ov.querySelectorAll("button")].find(b=>/Weiter/.test(b.textContent))?.click(); await new Promise(r=>setTimeout(r,80));
  const second=sets()[1]; const n=sets().length; c._cookShow(c._cookSess[0]); await new Promise(r=>setTimeout(r,50));
  ov._elClose(); await new Promise(r=>setTimeout(r,50));
  const clear=calls.find(m=>m.type==="einkaufsliste/cook/clear"); c._hass.callWS=old;
  const k=document.createElement("einkaufsliste-kochmodus"); k.id="km"; document.querySelector(".wrap").after(k);
  k.setConfig({}); k.hass={...c._hass, states:{"sensor.einkaufsliste_kochmodus":{state:"Lasagne",attributes:{aktiv:true,rezept:"Lasagne",schritt:2,schritte:2,text:"Hack anbraten 10 Minuten.",naechster:"",personen:4,einheit:"Personen",zutaten:["500 g Hack"],geraete:["🔥 Backofen 180 °C"],notiz:"weniger Salz",von:"Marco"}}}};
  const t=k.shadowRoot.textContent;
  const pics=[]; k.hass={...c._hass, callWS:async(m)=>{ pics.push(m); return { data:"data:image/gif;base64,R0lGODlhAQABAAAAACw=" }; }, states:{"sensor.einkaufsliste_kochmodus":{state:"Lasagne",attributes:{aktiv:true,rezept:"Lasagne",schritt:1,schritte:2,text:"Zwiebeln würfeln.",foto_schluessel:"rezept#rk#s0"}}}};
  await new Promise(r=>setTimeout(r,80)); const img=!!k.shadowRoot.querySelector(".left .sc .pic img");
  k.hass={...c._hass, states:{"sensor.einkaufsliste_kochmodus":{state:"aus",attributes:{aktiv:false}}}}; const idle=k.shadowRoot.textContent; k.remove();
  return { first, second, n, clear, t, idle, img, pic: pics[0] }; });
check("Kochmodus-Anzeige: Schritt-Foto wird geholt und scrollt im Text-Bereich mit", r.img && r.pic?.type === "einkaufsliste/photo/get" && r.pic.name === "rezept#rk#s0", JSON.stringify({img:r.img, pic:r.pic}));
check("Kochmodus meldet Rezept, Schritt und nur die Zutaten des Schritts an HA", r.first?.name === "Lasagne" && r.first.step === 1 && r.first.total === 3 && r.first.items.length === 0 && r.first.sid && r.second?.step === 2 && r.second.text.startsWith("Hack") && r.second.items[0] === "500 g Hack", JSON.stringify(r));
check("Kochmodus meldet nur bei Änderung, Schließen schaltet die Anzeige aus", r.n === 2 && r.clear?.sid === r.first?.sid, JSON.stringify(r));
check("Kochmodus-Anzeige zeigt Schritt, Zutaten, Backofen und Notiz; ohne Kochen den Hinweis", /Schritt 2 \/ 2/.test(r.t) && /Hack anbraten/.test(r.t) && /500 g Hack/.test(r.t) && /Backofen/.test(r.t) && /weniger Salz/.test(r.t) && /nichts gekocht/.test(r.idle), r.t + " | " + r.idle);

// 38) ⏱️ Dauer ca.: neben der Personenzahl; ohne Eintrag geschätzt mit „≈“; der Editor speichert das Feld mit
r = await p.evaluate(async () => { const c=document.querySelector('#c1'); const calls=[]; const old=c._hass.callWS; c._hass.callWS=async(m)=>{ calls.push(m); return {}; }; const oldWs=c._ws; c._ws=async(m)=>{ calls.push(m); return {}; };
  const a={id:"rt1",name:"Lasagne",items:[{name:"Hack"}],steps:"Backen",heat:[],servings:4,servings_unit:"persons",minutes:75};
  const e={id:"rt2",name:"Suppe",items:[{name:"Lauch"}],steps:"Kochen 20 Minuten.\nZiehen lassen 10 Minuten.",heat:[],servings:2,servings_unit:"persons"};
  const tagA=c._servTag(a).replace(/<[^>]+>/g,""), tagE=c._servTag(e).replace(/<[^>]+>/g,"");
  c._openRecipe(a); await new Promise(r=>setTimeout(r,80)); const inp=c.$("rMinutes"); const val=inp?.value;
  if (inp) { inp.value="50"; inp.dispatchEvent(new Event("input",{bubbles:true})); }
  try { await c._saveRecipe(); } catch (err) {} await new Promise(r=>setTimeout(r,80));
  const sent=calls.find(m=>m.type==="einkaufsliste/recipe/update"); c._hass.callWS=old; c._ws=oldWs;
  return { tagA, tagE, val, sent: sent?.minutes }; });
check("⏱️ Dauer steht neben der Personenzahl (eingetragen)", /4 Personen · ⏱️ 1 Std 15 Min/.test(r.tagA), JSON.stringify(r));
check("⏱️ ohne Eintrag geschätzt mit „≈“", /2 Personen · ⏱️ ≈ 30 Min/.test(r.tagE), JSON.stringify(r));
check("Rezept-Editor: „Dauer ca.“ zeigt den Wert und speichert ihn", r.val === "75" && r.sent === 50, JSON.stringify(r));

// 39) 🥕 Zutaten pro Schritt: automatisch erkannt (auch „Hack“ ↔ „Hackfleisch“, Mehrzahl), im Editor festlegbar, Kochmodus zeigt nur diese
r = await p.evaluate(async () => { const c=document.querySelector('#c1'); const calls=[]; const old=c._hass.callWS; c._hass.callWS=async(m)=>{ calls.push(m); return {}; }; const oldWs=c._ws; c._ws=async(m)=>{ calls.push(m); return {}; };
  const items=[{name:"Hackfleisch",quantity:"500 g"},{name:"Zwiebel",quantity:"2"},{name:"Tomaten",quantity:"800 g"},{name:"Salz"}];
  const auto=c._autoStepItems("Zwiebeln würfeln und mit dem Hack anbraten.", items).map(i=>i.name);
  const none=c._autoStepItems("35 Minuten backen.", items).length;
  const r={id:"rs",name:"Soße",items,steps:"Zwiebeln würfeln und mit dem Hack anbraten.\nDie Soße einkochen.\nAbschmecken.",heat:[],servings:4,servings_unit:"persons",step_items:[null,["tomaten","salz"]]};
  const fixed=c._stepItems(r,1).map(i=>i.name);
  c._data.recipes=[r]; c._openRecipe(r); await new Promise(r=>setTimeout(r,80));
  const q=(x)=>c.shadowRoot.querySelector(x);
  const btn=q('.strow[data-k] [data-act="step-ing"]'); const btnTxt=btn?.textContent.trim(); btn?.click(); await new Promise(r=>setTimeout(r,50));
  const chips=[...c.shadowRoot.querySelectorAll(".sting .stchip.on")].map(b=>b.textContent.replace("✓","").trim());
  [...c.shadowRoot.querySelectorAll(".sting .stchip")].find(b=>/Tomaten/.test(b.textContent))?.click(); await new Promise(r=>setTimeout(r,50));
  try { await c._saveRecipe(); } catch (err) {} await new Promise(r=>setTimeout(r,80));
  const sent=calls.find(m=>m.type==="einkaufsliste/recipe/update")?.step_items;
  document.querySelectorAll("[data-elcook]").forEach(o=>o._elClose?.());
  c._cookMode(r, 1, false); await new Promise(r=>setTimeout(r,150));
  const ov=document.querySelector("[data-elcook]"); [...ov.querySelectorAll("[data-elintro] button")].find(b=>/Los geht/.test(b.textContent))?.click(); await new Promise(r=>setTimeout(r,120));
  const ingTxt=()=>[...ov.querySelectorAll("div")].map(d=>d.innerHTML).find(h=>/data-elingall/.test(h) && !/data-elcook/.test(h))||"";
  const s2=ingTxt(); ov.querySelector("[data-elingall]")?.click(); await new Promise(r=>setTimeout(r,50)); const all=ingTxt();
  ov._elClose(); c._hass.callWS=old; c._ws=oldWs;
  return { auto, none, fixed, btnTxt, chips, sent, s2: s2.replace(/<[^>]+>/g," "), all: all.replace(/<[^>]+>/g," ") }; });
check("🥕 Zutaten im Schritt automatisch erkannt (Hack ↔ Hackfleisch, Zwiebeln ↔ Zwiebel)", JSON.stringify(r.auto) === '["Hackfleisch","Zwiebel"]' && r.none === 0, JSON.stringify(r));
check("🥕 Im Editor festgelegte Zutaten gelten", JSON.stringify(r.fixed) === '["Tomaten","Salz"]', JSON.stringify(r));
check("🥕 Editor: Knopf zeigt ≈ Anzahl, Kärtchen vorgewählt, Antippen legt fest und wird gespeichert", r.btnTxt === "≈ 2" && JSON.stringify(r.chips) === '["Hackfleisch","Zwiebel"]' && JSON.stringify(r.sent?.[0]) === '["hackfleisch","zwiebel","tomaten"]' && JSON.stringify(r.sent?.[1]) === '["tomaten","salz"]', JSON.stringify(r));
check("🥕 Kochmodus: nur Zutaten des Schritts, „Alle Zutaten“ zeigt alles", /800 g Tomaten/.test(r.s2) && /Salz/.test(r.s2) && !/Hackfleisch/.test(r.s2) && /Hackfleisch/.test(r.all) && /Zwiebel/.test(r.all), JSON.stringify(r));

// 40) 🧂 Koch-Wörter, „restliche Zutaten“, Abhaken beim Kochen (auch an HA), Hinweis „in keinem Schritt“, 🟢 wird gerade gekocht
r = await p.evaluate(async () => { const c=document.querySelector('#c1'); const calls=[]; const old=c._hass.callWS; c._hass.callWS=async(m)=>{ calls.push(m); return {}; };
  const items=[{name:"Schnitzel"},{name:"Mehl"},{name:"Eier"},{name:"Paniermehl"},{name:"Salz"},{name:"Pfeffer"},{name:"Butterschmalz"},{name:"Zitrone"},{name:"Petersilie"}];
  const r={id:"rw",name:"Schnitzel",items,steps:"Schnitzel klopfen und würzen.\nPanieren.\nIn Butterschmalz anbraten.\nRestliche Zutaten dazu servieren.",heat:[],servings:2,servings_unit:"persons"};
  const names=(i)=>c._stepItems(r,i).map(x=>x.name);
  const s=[0,1,2,3].map(names);
  const pasta=c._autoStepItems("Nudeln in Wasser kochen.", [{name:"Nudeln"},{name:"Salz"},{name:"Käse"}]).map(x=>x.name);
  c._data.recipes=[r]; c._openRecipe({...r, steps:r.steps.split("\n").slice(0,3).join("\n"), items:[...items,{name:"Zucker"}]}); await new Promise(r=>setTimeout(r,80));
  const warn=c.$("rStepWarn")?.textContent||"";
  document.querySelectorAll("[data-elcook]").forEach(o=>o._elClose?.()); calls.length=0;
  c._view="list"; c._cookMode(r, 2, false); await new Promise(r=>setTimeout(r,150));
  const ov=document.querySelector("[data-elcook]"); [...ov.querySelectorAll("[data-elintro] button")].find(b=>/Los geht/.test(b.textContent))?.click(); await new Promise(r=>setTimeout(r,120));
  ov.querySelector('[data-elingx="butterschmalz"]')?.click(); await new Promise(r=>setTimeout(r,60));
  const struck=/line-through/.test(ov.querySelector('[data-elingx="butterschmalz"]')?.getAttribute("style")||"");
  const sets=calls.filter(m=>m.type==="einkaufsliste/cook/set"); const last=sets[sets.length-1];
  ov._elClose(); c._hass.callWS=old;
  const k=document.createElement("einkaufsliste-kochmodus"); document.querySelector(".wrap").after(k); k.setConfig({});
  k.hass={...c._hass, states:{"sensor.einkaufsliste_kochmodus":{state:"Schnitzel",attributes:{aktiv:true,rezept:"Schnitzel",schritt:3,schritte:4,text:"x",zutaten:["Butterschmalz","Salz"],erledigt:[0]}}}};
  const tvStruck=k.shadowRoot.querySelector(".ing s.dn")?.textContent||""; k.remove();
  const hs=c._hass; c._hass={...hs, states:{...hs.states, "sensor.einkaufsliste_kochmodus":{state:"Schnitzel",attributes:{aktiv:true,rezept:"Schnitzel",rezept_id:"rw",schritt:3,schritte:4,von:"Jamila"}}}};
  c._view="recipes"; c._renderAll?.(); await new Promise(r=>setTimeout(r,80));
  const row=c.shadowRoot.querySelector('.recipe.cooking[data-id="rw"]'); const join=row?.querySelector(".cooknow")?.textContent||"";
  c._view="list"; c._syncRecipesBtn(); const dot=c.$("cookDot")?.hidden===false; c._hass=hs; c._syncRecipesBtn();
  return { s, pasta, warn, struck, done:last?.done, items:last?.items, tvStruck, join, dot }; });
check("🧂 würzen → Salz & Pfeffer, panieren → Mehl/Eier/Paniermehl, anbraten → Butterschmalz", JSON.stringify(r.s[0])==='["Schnitzel","Salz","Pfeffer"]' && JSON.stringify(r.s[1])==='["Mehl","Eier","Paniermehl"]' && JSON.stringify(r.s[2])==='["Butterschmalz"]', JSON.stringify(r));
check("🧂 Nudeln kochen → Salz; „restliche Zutaten“ = alles, was vorher nicht dran war", JSON.stringify(r.pasta)==='["Nudeln","Salz"]' && JSON.stringify(r.s[3])==='["Zitrone","Petersilie"]', JSON.stringify(r));
check("⚠️ Editor sagt, welche Zutat in keinem Schritt vorkommt", /Zucker/.test(r.warn) && /Zitrone/.test(r.warn) && !/Salz/.test(r.warn), JSON.stringify(r));
check("✔️ Zutat antippen = durchgestrichen, HA bekommt es mit, TV streicht durch", r.struck && JSON.stringify(r.done)==='[0]' && /Butterschmalz/.test(r.tvStruck), JSON.stringify(r));
check("🟢 Kochmütze: grüner Rand + „Wird gerade gekocht · Schritt 3 von 4 · Jamila“, Punkt oben", /gerade gekocht/.test(r.join) && /3 von 4/.test(r.join) && /Jamila/.test(r.join) && r.dot, JSON.stringify(r));

// 41) ▶️ „Weitermachen“: keine Personen-Auswahl mehr, gleich beim gemerkten Schritt, gemerkte Personenzahl
r = await p.evaluate(async () => { const c=document.querySelector('#c1'); const old=c._hass.callWS; c._hass.callWS=async()=>({}); const w=(ms)=>new Promise(r=>setTimeout(r,ms));
  document.querySelectorAll("[data-elcook]").forEach(o=>o._elClose?.());
  const r={id:"rres",name:"Weiter",items:[{name:"Mehl",quantity:"100 g"}],steps:"Eins Mehl\nZwei\nDrei\nVier",heat:[],servings:2,servings_unit:"persons"};
  c._data.recipes=[r]; c._cookMode(r); await w(200); let ov=document.querySelector("[data-elcook]");
  [...ov.querySelectorAll("[data-elintro] button")].find(b=>/^\+$|＋/.test(b.textContent.trim()))?.click(); await w(50);
  [...ov.querySelectorAll("[data-elintro] button")].find(b=>/Los geht/.test(b.textContent))?.click(); await w(100);
  for (let i=0;i<2;i++){ [...ov.querySelectorAll("button")].find(b=>/Weiter ›/.test(b.textContent))?.click(); await w(80); }
  ov._elClose(); await w(80); delete c._cookPers[r.id];
  c._cookMode(r); await w(250);
  [...document.querySelectorAll("button")].find(b=>/^Weitermachen$/.test(b.textContent.trim()))?.click(); await w(250);
  ov=document.querySelector("[data-elcook]");
  const res={ intro: !!ov?.querySelector("[data-elintro]"), pos: ov?.textContent.match(/Schritt \d von \d/)?.[0], pers: ov?.textContent.match(/für (\d+) Personen/)?.[1] };
  ov?._elClose(); c._hass.callWS=old; return res; });
check("▶️ Weitermachen: ohne Personen-Auswahl direkt bei Schritt 3, Personenzahl gemerkt", !r.intro && r.pos === "Schritt 3 von 5" && r.pers === "3", JSON.stringify(r));

// 🆕 Beta 2.76.28: Wer ist im Laden, Angebote je Land, Grundvorrat
r = await p.evaluate(async () => { const c=document.querySelector('#c1'); const d=c._data; const st=d.stores[1]; const states=c._hass.states;
  const keepZones=st.zones, keepZone=st.zone, keepCtry=st.country, keepTab=c._tab, keepSet={...d.settings}, keepOffers=d.offers;
  states["zone.testladen"]={entity_id:"zone.testladen", state:"2", attributes:{persons:["person.anna","person.ben"]}};
  states["person.anna"]={entity_id:"person.anna", state:"Testladen", attributes:{friendly_name:"Anna"}};
  states["person.ben"]={entity_id:"person.ben", state:"Testladen", attributes:{friendly_name:"Ben"}};
  st.zones=["zone.testladen"]; st.zone="zone.testladen"; c._tab=st.id; c._view="list"; c._renderAll(); await new Promise(r=>setTimeout(r,60));
  const bar=c.shadowRoot.querySelector("#hereBar"); const here={ hidden:bar?.hidden, text:bar?.textContent||"", ring:!!c.shadowRoot.querySelector(".tab.active.here") };
  st.country="DE"; d.offers={ milch:[{n:"Milch",r:"Aldi",p:1.1,ctry:"CH"},{n:"Milch",r:"Aldi",p:1.2,ctry:"DE"},{n:"Milch",r:"Aldi",p:1.3}] };
  const offers=c._offersFor({name:"Milch", store_id:st.id}).map(o=>o.p); const noStore=c._offersFor({name:"Milch"}).length;
  d.settings.basics_on=true; d.settings.basics=["Salz","Olivenöl"];
  const basic={ salz:c._isBasic({name:"Salz"}), oel:c._isBasic({name:"Olivenöl extra"}), mehl:c._isBasic({name:"Mehl"}) };
  delete states["zone.testladen"]; delete states["person.anna"]; delete states["person.ben"];
  st.zones=keepZones; st.zone=keepZone; st.country=keepCtry; c._tab=keepTab; d.settings=keepSet; d.offers=keepOffers; c._renderAll();
  return { here, offers, noStore, basic }; });
check("📍 Gerade dort: Namen über der Liste, Rand am Reiter", !r.here.hidden && /Anna, Ben/.test(r.here.text) && r.here.ring, JSON.stringify(r.here));
check("🌍 Angebote: CH-Angebot nicht beim deutschen Geschäft, ohne Geschäft alles", r.offers.join() === "1.2,1.3" && r.noStore === 3, JSON.stringify(r));
check("🧂 Grundvorrat-Liste: Salz/Olivenöl ja, Mehl nein", r.basic.salz && r.basic.oel && !r.basic.mehl, JSON.stringify(r.basic));

// 🧂 beta.3: nur EIN Grundvorrat – 🧂-Knopf im Editor ändert die zentrale Liste
r = await p.evaluate(async () => { const c=document.querySelector('#c1'); const d=c._data; const keepSet={...d.settings}; const sent=[];
  d.settings.basics_on=true; d.settings.basics=["Pfeffer","Salz"]; c._ws=async(m)=>{ sent.push(m); return {}; };
  c._openRecipe(null); await new Promise(r=>setTimeout(r,80));
  c.$("inName").value="Pfeffer"; await c._addRecipeIngredient(); await new Promise(r=>setTimeout(r,30));
  const a={...c._draft.items.find(i=>i.name==="Pfeffer")}; const aBasic=c._isBasic(a); const sentA=sent.filter(m=>m.type==="einkaufsliste/recipe/basics").length;
  const meta=c.$("rItems")?.textContent || "";
  c.$("inName").value="Zimt"; c._setBasic(true, true); await c._addRecipeIngredient(); await new Promise(r=>setTimeout(r,30));
  const zimt=[...d.settings.basics];
  c.$("inName").value="Pfeffer schwarz"; c._setBasic(false, true); await c._addRecipeIngredient(); await new Promise(r=>setTimeout(r,30));
  const after=[...d.settings.basics]; const pBasic=c._isBasic({name:"Pfeffer"});
  const last=sent.filter(m=>m.type==="einkaufsliste/recipe/basics").pop();
  d.settings=keepSet; let n=0; while(c._page && n++<6) c._pageBack(); c._view="list"; c._renderAll();
  return { a, aBasic, sentA, label:/Grundvorrat/.test(meta) && !/\(Liste\)/.test(meta), zimt, after, pBasic, last }; });
check("🧂 Neue Zutat „Pfeffer“ ohne Knopf: Grundvorrat aus der Liste, nichts geändert", r.aBasic && !r.a.basic && !r.a.no_basic && r.sentA === 0, JSON.stringify(r));
check("🧂 Überall dasselbe „🧂 Grundvorrat“ (kein „(Liste)“)", r.label, JSON.stringify(r));
check("🧂 Knopf an bei „Zimt“ = kommt auf die zentrale Liste", r.zimt.join() === "Pfeffer,Salz,Zimt", JSON.stringify(r.zimt));
check("🧂 Knopf aus bei „Pfeffer schwarz“ = Pfeffer fliegt überall raus", r.after.join() === "Salz,Zimt" && !r.pBasic && r.last?.names?.join() === "Salz,Zimt", JSON.stringify(r));

// 🧪 beta.4: „Neu in dieser Beta“ – höchste Beta-Nummer oben
r = await p.evaluate(() => { const c=document.querySelector('#c1'); const h=c._newsHtml(false); const box=document.createElement("div"); box.innerHTML=h;
  const nos=[...box.querySelectorAll("ul li > b")].map(b=>b.textContent).filter(t=>/^beta\.\d+$/.test(t)).map(t=>+t.split(".")[1]);
  return { nos }; });
check("🧪 Beta-Kasten: neueste Beta oben", r.nos.length > 1 && r.nos.every((n,i)=>i===0 || n<=r.nos[i-1]), JSON.stringify(r));

// 📷 beta.4: „Rezept vorschlagen“ liest ein Rezept-Foto wie der Editor
r = await p.evaluate(async () => { const c=document.querySelector('#c1'); const calls=[];
  c._ws=async(m)=>{ calls.push(m.type); return m.type==="einkaufsliste/recipe/heat_guess" ? { heat:[{device:"Backofen",mode:"Umluft",temp:180,minutes:25}] } : {}; };
  c._ocrText=async()=>"Omas Apfelkuchen\nZutaten\n200 g Mehl\n3 Eier\nZubereitung\nBackofen auf 180 °C Umluft vorheizen.\nTeig rühren und 25 Minuten backen.";
  c._pickFile=async()=>{ const t=c._photoTarget; setTimeout(()=>t.ocr("data:image/png;base64,iVBORw0KGgo="),10); };
  c._proposeRecipe(); await new Promise(r=>setTimeout(r,120));
  const root=document.querySelector("[data-elpage]")||c.shadowRoot; const q=(s)=>root.querySelector(s)||c.shadowRoot.querySelector(s)||document.querySelector(s);
  q("[data-pocr]").click(); await new Promise(r=>setTimeout(r,250));
  [...document.querySelectorAll("[data-elconfirm] button")].find(b=>/Rezept lesen/.test(b.textContent))?.click(); // 📷 Text zu sehen → immer fragen
  await new Promise(r=>setTimeout(r,250));
  const fertig=[...document.querySelectorAll("[data-elconfirm] button")].find(b=>/Fertig/.test(b.textContent)); fertig?.click();
  await new Promise(r=>setTimeout(r,400));
  const out={ hasBtn:true, fertig:!!fertig, name:q("[data-pn]")?.value, ing:q("[data-pi]")?.value, steps:q("[data-ps]")?.value, heat:q("[data-ph]")?.value, hint:q("[data-pphint]")?.textContent, calls };
  c._propPhoto=null; let n=0; while(c._page && n++<6) c._pageBack(); document.querySelectorAll("[data-elov],[data-elconfirm]").forEach(e=>e.remove()); c._view="list"; c._renderAll();
  return out; });
check("📷 Vorschlag: Rezept aus Fotos füllt Name, Zutaten, Schritte, Backofen und Foto", r.fertig && r.name==="Omas Apfelkuchen" && /200 g Mehl/.test(r.ing||"") && /vorheizen/.test(r.steps||"") && /Backofen Umluft 180 °C 25 Min/.test(r.heat||"") && /Foto ist dabei/.test(r.hint||""), JSON.stringify(r));

// 41) 🧮 Nährwerte + 🔀 Reihenfolge beim Import: Entwurf behält die Reihenfolge, Editor zeigt/speichert Nährwerte, Liste zeigt sie, Foto-Text liefert sie
r = await p.evaluate(async () => { const c=document.querySelector('#c1'); const calls=[]; const oldWs=c._ws; c._ws=async(m)=>{ calls.push(m); return m.type==="einkaufsliste/recipe/add"?{id:"rnew"}:{}; };
  c._openRecipeDraft({ name:"Lasagne Bolognese", items:[{name:"Lasagneplatte"},{name:"Hackfleisch",quantity:"600 g"},{name:"Butter"},{name:"Milch"}], servings:4, nutrition:{kcal:898,protein:44.8,fat:55.2,carbs:46.7} });
  await new Promise(r=>setTimeout(r,80));
  const order=c._draft.items.map(i=>i.name).join(","), serv=c.$("rServings")?.value;
  const nut=[...c.shadowRoot.querySelectorAll("[data-nut]")].map(i=>i.dataset.nut+"="+i.value).join(",");
  const kc=c.shadowRoot.querySelector('[data-nut="kcal"]'); if (kc) kc.value="900";
  try { await c._saveRecipe(); } catch (err) {} await new Promise(r=>setTimeout(r,80));
  const sent=calls.find(m=>m.type==="einkaufsliste/recipe/add");
  c._data.recipes=[{id:"rn1",name:"Lasagne",items:[{name:"Hack"}],steps:"Backen",heat:[],nutrition:{kcal:898,protein:44.8,fat:55.2,carbs:46.7}}];
  c._view="recipes"; c._renderAll(); await new Promise(r=>setTimeout(r,80));
  const line=c.shadowRoot.querySelector('.recipe[data-id="rn1"] .rnut')?.textContent||"";
  // 📷 Foto im Editor: Text mit Nährwert-Tabelle
  c._openRecipe(null); await new Promise(r=>setTimeout(r,80));
  const oldOcr=c._ocrText; c._ocrText=async()=>"Lasagne\nZutaten\n200 g Mehl\n1 Prise Salz\nNährwerte pro Portion\nBrennwert 898 kcal\nEiweiß 44,8 g\nFett 55,2 g\nKohlenhydrate 46,7 g\nZubereitung\nAlles schichten und backen.";
  c._pickFile=async()=>{ const t=c._photoTarget; setTimeout(()=>t.ocr("data:image/png;base64,iVBORw0KGgo="),10); };
  c._recipeFromPhotos([]); await new Promise(r=>setTimeout(r,250));
  [...document.querySelectorAll("[data-elconfirm] button")].find(b=>/Rezept lesen/.test(b.textContent))?.click();
  await new Promise(r=>setTimeout(r,250));
  [...document.querySelectorAll("[data-elconfirm] button")].find(b=>/Fertig/.test(b.textContent))?.click();
  await new Promise(r=>setTimeout(r,400));
  const ocrNut=c._readNut(), ocrIng=c.$("rImportText")?.value||"";
  c._ocrText=oldOcr; c._ws=oldWs; document.querySelectorAll("[data-elov],[data-elconfirm]").forEach(e=>e.remove()); c._view="list"; c._data.recipes=[]; c._renderAll();
  return { order, serv, nut, sentNut: sent?.nutrition, sentOrder: (sent?.items||[]).map(i=>i.name).join(","), line, ocrNut, ocrIng }; });
check("🔀 Import-Entwurf behält die Reihenfolge des Rezepts", r.order === "Lasagneplatte,Hackfleisch,Butter,Milch" && r.sentOrder === r.order, JSON.stringify(r));
check("🍽️ Portionen aus dem Import stehen im Editor", r.serv === "4", JSON.stringify(r));
check("🧮 Editor zeigt die Nährwerte und speichert die Änderung", /kcal=898/.test(r.nut) && /protein=44.8/.test(r.nut) && r.sentNut?.kcal === 900 && r.sentNut?.fat === 55.2, JSON.stringify(r));
check("🧮 Rezeptliste zeigt die Nährwerte unter dem Namen", r.line === "🧮 898 kcal · Eiweiß 44,8 g · Fett 55,2 g · KH 46,7 g", r.line);
check("🧮 Foto-Text: Nährwert-Tabelle wird erkannt und nicht zu Zutaten", r.ocrNut?.kcal === 898 && r.ocrNut?.carbs === 46.7 && !/Brennwert|Eiweiß/.test(r.ocrIng) && /Salz/.test(r.ocrIng), JSON.stringify(r));

// 42) 🧮 Nährwerte zugeklappt mit Kurzfassung, 🤖 KI schätzt, ✂️ Zuschneide-Rahmen passt zur Kartenbreite
r = await p.evaluate(async () => { const c=document.querySelector('#c1'); const calls=[]; const oldWs=c._ws; const oldAi={...(c._data.settings||{})};
  c._data.settings={...(c._data.settings||{}), ai_on:true, ai_agent:"conversation.test", privacy:false};
  c._ws=async(m)=>{ calls.push(m); return m.type==="einkaufsliste/ai/nutrition"?{nutrition:{kcal:410,protein:18.4}}:{}; };
  c._openRecipeDraft({ name:"Pfannkuchen", items:[{name:"Mehl",quantity:"250 g"},{name:"Eier",quantity:"3"}], servings:4, nutrition:{kcal:898,protein:44.8} });
  await new Promise(r=>setTimeout(r,80));
  const box=c.$("rNutBox"), tog=c.shadowRoot.querySelector('[data-act="nut-toggle"]');
  const closed=box.hidden, sum=c.$("rNutSum").textContent;
  tog.click(); await new Promise(r=>setTimeout(r,30));
  const opened=!box.hidden, aiBtn=!!c.shadowRoot.querySelector('[data-act="nut-ai"]');
  const oldConfirm=window.elConfirm; 
  c.shadowRoot.querySelector('[data-act="nut-ai"]').click(); await new Promise(r=>setTimeout(r,150));
  document.querySelectorAll("[data-elconfirm] button").forEach(b=>{ if(/Ja|OK|Ersetzen|ersetzen/i.test(b.textContent)) b.click(); });
  [...document.querySelectorAll("[data-elconfirm] button")].pop()?.click();
  await new Promise(r=>setTimeout(r,200));
  const sent=calls.find(m=>m.type==="einkaufsliste/ai/nutrition");
  const kc=c.shadowRoot.querySelector('[data-nut="kcal"]').value;
  tog.click(); await new Promise(r=>setTimeout(r,30)); const sum2=c.$("rNutSum").textContent;
  // ✂️ Zuschneiden: Rahmen = angezeigtes Bild (Karte schmaler als das Fenster)
  const cv0=document.createElement("canvas"); cv0.width=768; cv0.height=432; cv0.getContext("2d").fillRect(0,0,768,432);
  const blob=await new Promise(ok=>cv0.toBlob(ok,"image/webp",0.8)); const file=new File([blob],"original.webp",{type:"image/webp"});
  let got=null; c._photoTarget={ ocr:(d)=>{got=d;} };
  const pr=c._onPhotoFile({target:{files:[file]}}); await new Promise(r=>setTimeout(r,600));
  const all=(q)=>[...document.querySelectorAll(q),...c.shadowRoot.querySelectorAll(q)];
  const cv=all("canvas").find(x=>x.nextElementSibling?.firstElementChild); const R=(e)=>e.getBoundingClientRect();
  const fit=cv ? Math.abs(R(cv).width-R(cv.nextElementSibling).width)<2 && Math.abs(R(cv).height-R(cv.nextElementSibling).height)<2 : false;
  const oks=all("button").filter(b=>/Übernehmen/.test(b.textContent)); oks[oks.length-1]?.click(); await Promise.race([pr,new Promise(r=>setTimeout(r,800))]);
  c._ws=oldWs; c._data.settings=oldAi; document.querySelectorAll("[data-elov],[data-elconfirm]").forEach(e=>e.remove()); c._view="list"; c._renderAll();
  return { closed, sum, opened, aiBtn, sent, kc, sum2, fit, got: !!got }; });
check("🧮 Nährwerte sind zugeklappt und zeigen die Kurzfassung", r.closed && /898 kcal/.test(r.sum) && r.opened, JSON.stringify(r));
check("🤖 Nährwerte schätzen: Zutaten mit Menge + Portionen gehen an die KI, Werte landen in den Feldern", r.aiBtn && r.sent?.items?.join("|") === "250 g Mehl|3 Eier" && r.sent?.servings === 4 && r.kc === "410" && /410 kcal/.test(r.sum2), JSON.stringify(r));
check("✂️ Zuschneide-Rahmen ist genau so groß wie das angezeigte Bild", r.fit && r.got, JSON.stringify(r));

// 43) 📷 EIN Foto-Knopf: kein Text → gleich Rezept-Foto · Text → immer fragen (Gericht oder Rezept lesen) · Vorschlag genauso
r = await p.evaluate(async () => { const c=document.querySelector('#c1'); const oldWs=c._ws, oldOcr=c._ocrText, oldPick=c._pickFile; c._ws=async()=>({});
  const click=(re)=>[...document.querySelectorAll("[data-elconfirm] button")].find(b=>re.test(b.textContent))?.click();
  const wait=(ms)=>new Promise(r=>setTimeout(r,ms));
  const png="data:image/png;base64,iVBORw0KGgo=";
  c._pickFile=async()=>{ const t=c._photoTarget; setTimeout(()=>t.ocr(png),10); };
  c._openRecipe(null); await wait(150);
  const btns=[...c.shadowRoot.querySelectorAll('[data-act="rphotos-read"],[data-act="rphoto-take"]')].map(b=>b.dataset.act);
  // a) Kuchenfoto: nur Buchstabensalat → ohne Frage Rezept-Foto, nichts bei den Zutaten
  c._ocrText=async()=>"De * Fa 7. A er\n2 SD A. ZEN | A\nAI EA\nN ya Pe\nA EN K N } A\n&E Gy N ER WO\nR WO a BROS N za";
  c._recipeFromPhotos([]); await wait(400);
  const asked1=!!document.querySelector("[data-elconfirm]"); const photos1=(c._draft.newPhotos||[]).length; const ing1=c.$("rImportText")?.value||"";
  // b) Foto mit Text → fragen; „Foto vom Gericht“ → Rezept-Foto, keine Zutaten
  c._ocrText=async()=>"Omas Apfelkuchen\nZutaten\n200 g Mehl\n3 Eier\nZubereitung\nBackofen auf 180 Grad vorheizen und alles backen.";
  c._recipeFromPhotos([]); await wait(400);
  const asked2=!!document.querySelector("[data-elconfirm]"); click(/Foto vom Gericht/); await wait(300);
  const photos2=(c._draft.newPhotos||[]).length; const ing2=c.$("rImportText")?.value||"";
  // c) Vorschlag: Kuchenfoto → Foto geht mit dem Vorschlag mit
  c._ocrText=async()=>"A er\nZEN | A";
  c._proposeRecipe(); await wait(150);
  const root=document.querySelector("[data-elpage]")||c.shadowRoot; const q=(s)=>root.querySelector(s)||c.shadowRoot.querySelector(s)||document.querySelector(s);
  const pBtn=[!!q("[data-pocr]"), !!q("[data-pphoto]")];
  q("[data-pocr]").click(); await wait(400);
  const asked3=!!document.querySelector("[data-elconfirm]"); const hint=q("[data-pphint]")?.textContent, has=!!c._propPhoto;
  c._propPhoto=null; let n=0; while(c._page && n++<6) c._pageBack(); document.querySelectorAll("[data-elov],[data-elconfirm]").forEach(e=>e.remove());
  c._ws=oldWs; c._ocrText=oldOcr; c._pickFile=oldPick; c._view="list"; c._renderAll();
  return { btns, asked1, photos1, ing1, asked2, photos2, ing2, pBtn, asked3, hint, has }; });
check("📷 Editor hat nur noch EINEN Foto-Knopf", r.btns.length === 1 && r.btns[0] === "rphotos-read", JSON.stringify(r));
check("📷 Kuchenfoto ohne lesbaren Text: keine Frage, Rezept-Foto, kein Buchstabensalat bei den Zutaten", !r.asked1 && r.photos1 === 1 && r.ing1 === "", JSON.stringify(r));
check("📷 Foto mit Text: immer fragen; „Foto vom Gericht“ → Rezept-Foto, Zutaten bleiben leer", r.asked2 && r.photos2 === 2 && r.ing2 === "", JSON.stringify(r));
check("📷 Vorschlag: ein Foto-Knopf, Kuchenfoto geht ohne Frage mit dem Vorschlag mit", r.pBtn[0] && !r.pBtn[1] && !r.asked3 && r.has && /Foto ist dabei/.test(r.hint || ""), JSON.stringify(r));

// 44) 🖨️ „Drucken & Teilen“ unter dem Rezept · Blatt mit Foto, Zeiten, Nährwerten, Quelle, Zutaten in 2 Spalten · passt auf EINE A4-Seite
r = await p.evaluate(async () => { const c=document.querySelector('#c1'); const wait=(ms)=>new Promise(r=>setTimeout(r,ms));
  const cv=document.createElement("canvas"); cv.width=400; cv.height=300; cv.getContext("2d").fillRect(0,0,400,300); const photo=cv.toDataURL("image/jpeg",.8);
  const oldPD=c._photoData, oldHP=c._hasPhoto; c._photoData=async()=>photo; c._hasPhoto=()=>true;
  const names=["Weizenmehl","Zucker","Hefe","Milch","Zwetschgen","Vanillezucker","Ei","Salz","Butter","Zitronenabrieb","Zimt","Lasagneplatten"];
  const mk=(n)=>({ id:"rp1", name:"Zwetschgendatschi", items:names.map((x,i)=>({name:x,quantity:(i+1)*10+" g"})), servings:20, servings_unit:"persons", minutes:160, source:"https://www.rewe.de/rezepte/zwetschgendatschi/", nutrition:{kcal:266,protein:4.2}, heat:[],
    steps:Array.from({length:n},(_,i)=>`Schritt ${i+1}: Zwetschgen waschen, halbieren, entkernen und vierteln. Den Teig mit dem Knethaken solange kneten, bis er Blasen wirft und danach zugedeckt gehen lassen, bis sich sein Volumen verdoppelt hat.`).join("\n") });
  const out={}; c._data.recipes=[mk(6)]; c._view="recipes"; c._renderAll(); await wait(120);
  const btn=c.shadowRoot.querySelector('.rtools [data-act="recipe-share"]'); const first=c.shadowRoot.querySelector(".rtools .btn"); out.firstAct=first?.dataset.act;
  out.icon=btn?.querySelector("ha-icon")?.getAttribute("icon"); out.title=btn?.title;
  for (const n of [6, 22]) {
    c._printRecipePage(mk(n)); await wait(500);
    const sheet=document.querySelector(".prsheet")||c.shadowRoot.querySelector(".prsheet");
    if (n === 6) { out.img=!!sheet.querySelector(".rzimg"); out.chips=sheet.querySelectorAll(".rzchip").length; out.cols=getComputedStyle(sheet.querySelector(".rzcols")).columnCount; out.nut=/266 kcal/.test(sheet.textContent); out.src=/rewe\.de/.test(sheet.textContent); }
    (document.querySelector("[data-prgo]")||c.shadowRoot.querySelector("[data-prgo]")).click(); await wait(1200);
    const doc=document.querySelector("iframe")?.contentDocument; const h=doc?.body.getBoundingClientRect().height||0;
    out["h"+n]=Math.round(h); out["z"+n]=doc?.body.style.zoom||"";
    document.querySelectorAll("iframe").forEach(e=>e.remove()); let k=0; while(c._page && k++<6) c._pageBack();
  }
  out.avail=Math.round(263*96/25.4);
  c._photoData=oldPD; c._hasPhoto=oldHP; c._data.recipes=[]; document.querySelectorAll("[data-elov],[data-elconfirm]").forEach(e=>e.remove()); c._view="list"; c._renderAll();
  return out; });
check("🖨️ Unter dem Rezept: erstes Symbol „Ansehen“, der Teilen-Knopf heißt „Drucken & Teilen“ mit Symbol Blatt mit Pfeil", r.firstAct === "recipe-view" && r.icon === "mdi:file-send-outline" && /Drucken/.test(r.title || ""), JSON.stringify(r));
check("🖨️ Blatt: Foto, Dauer/Portionen, Nährwerte, Quelle und Zutaten in zwei Spalten", r.img && r.chips === 2 && r.nut && r.src && r.cols === "2", JSON.stringify(r));
check("🖨️ Kurzes Rezept bleibt in Originalgröße, langes wird passend verkleinert und passt auf EINE Seite", r.z6 === "" && r.h6 <= r.avail && Number(r.z22) < 1 && r.h22 <= r.avail, JSON.stringify(r));

// 45) 🧱 Zweispaltige Rezeptkarte (TikTok): Spalten getrennt gelesen, Überschrift mit Symbol, Kästen enden an der nächsten Überschrift, Thermomix nur auf Wunsch
r = await p.evaluate(async () => { const c=document.querySelector('#c1'); const oldWs=c._ws, oldOcr=c._ocrText, oldPick=c._pickFile; c._ws=async()=>({});
  const wait=(ms)=>new Promise(r=>setTimeout(r,ms));
  const click=(re)=>[...document.querySelectorAll("[data-elconfirm] button")].find(b=>re.test(b.textContent))?.click();
  const png="data:image/png;base64,iVBORw0KGgo=";
  c._pickFile=async()=>{ const t=c._photoTarget; setTimeout(()=>t.ocr(png),10); };
  const TXT="A\nVE\nvn FE MONTAG - KW 44 DOM\nCremige Brokkoli-Schinken-Nudeln\na {1 4 Personen - ca. 25 Minuten © DZ\n"
   +"{3 ZUTATEN E\n400 g kurze Nudeln + 500 g Brokkoli\n200 g Kochschinken + 1 Zwiebel\n10 g Öl - 200 g Frischkäse natur $\n250 mi Milch + 100 ml Nudelwasser\nSalz, Pfeffer, Muskat\n©) THERMOMIX + TM6\n[1] Nudeln und Brokkoli wie oben im Topf garen.\n[2] Zwiebel halbiert 5 Sek./Stufe 5 zerkleinern,\nherunterschieben. Öl zugeben: 3 Min./120 °C/\nStufe 1.\n© Milch, Frischkäse und Gewürze: 5 Min./90 °C/\nStufe 2. Schinken gewürfelt: 2 Min./90 °C/\nLinkslauf/Stufe 1.\n[4] Sauce in einer großen Schüssel mit Nudeln,\nBrokkoli und Nudelwasser mischen.\n"
   +"{ ZUBEREITUNG - NORMAL\n\n(1) Nudeln nach Packung garen. Brokkoliröschen\ndie letzten 5-6 Min. mitkochen. 100 ml\nNudelwasser auffangen.\n\n@ Zwiebel fein würfeln, in Öl glasig dünsten.\nMilch und Frischkäse einrühren, 3-4 Min.\nsanft erhitzen.\n\n® Gewürfeliten Schinken, Nudeln und Brokkoli\nunterheben. Mit Nudelwasser cremig rühren\nund würzen.\n\n1] NÄHRWERTE PRO PORTION - CA.\n650 kcal + 34 g Eiweiß + 84 g Kohlenhydrate + 19 g Fett\nT—\n\nTI AUFBEWAHRUNG & MEAL PREP\n\nZügig abkühlen und kalt stellen. Im Kühlschrank\nbis 2 Tage. Einfrieren möglich, Sauce kann sich\netwas trennen. Mit etwas Milch in Topf oder\nMikrowelle gründlich erhitzen.\n\nTipp: Brokkoli am Vorabend schneiden.\n";
  c._ocrText=async()=>TXT;
  const run=async(tm)=>{
    c._openRecipe(null); await wait(150);
    c._recipeFromPhotos([]); await wait(500);
    click(/Rezept lesen/); await wait(500);   // Text drauf → „Rezept lesen“
    click(/Fertig/); await wait(500);          // keine weitere Seite
    const asked=!!document.querySelector("[data-elconfirm]");
    click(tm ? /Ja, dazu/ : /^Nein/); await wait(700);
    const name=c.$("rName")?.value, ing=c.$("rImportText")?.value||"", steps=(c._draft.stepRows||[]).map(r=>r.t), nut=c._readNut?.();
    document.querySelectorAll("[data-elov],[data-elconfirm]").forEach(e=>e.remove());
    return { asked, name, ing, steps, kcal: nut?.kcal, protein: nut?.protein, carbs: nut?.carbs, fat: nut?.fat };
  };
  const no=await run(false); c._view="list"; c._renderAll();
  const yes=await run(true);
  // 🧱 Spalten-Erkennung selbst: zweispaltig → Trennlinie, einspaltig → keine
  const mk=(n,cols)=>Array.from({length:n},(_,i)=>({bbox:{x0:40,y0:i*30,x1:1000,y1:i*30+24},words:cols?[{text:"Nudeln",bbox:{x0:40,x1:200,y0:i*30,y1:i*30+24},confidence:90},{text:"kochen",bbox:{x0:210,x1:420,y0:i*30,y1:i*30+24},confidence:90},{text:"Zwiebel",bbox:{x0:560,x1:700,y0:i*30,y1:i*30+24},confidence:90},{text:"würfeln",bbox:{x0:710,x1:980,y0:i*30,y1:i*30+24},confidence:90}]:[{text:"Ein",bbox:{x0:40,x1:100,y0:i*30,y1:i*30+24},confidence:90},{text:"langer",bbox:{x0:110,x1:300,y0:i*30,y1:i*30+24},confidence:90},{text:"Satz",bbox:{x0:310,x1:520,y0:i*30,y1:i*30+24},confidence:90},{text:"mitten",bbox:{x0:530,x1:700,y0:i*30,y1:i*30+24},confidence:90},{text:"durch",bbox:{x0:710,x1:980,y0:i*30,y1:i*30+24},confidence:90}]}));
  const two=elOcrSplit(mk(10,true),1080), one=elOcrSplit(mk(10,false),1080);
  c._data.recipes=[]; c._ws=oldWs; c._ocrText=oldOcr; c._pickFile=oldPick; document.querySelectorAll("[data-elov],[data-elconfirm]").forEach(e=>e.remove()); c._view="list"; c._renderAll();
  return { no, yes, two, one }; });
check("🧱 Zweispaltige Karte: Name und Zutaten sauber (zwei Zutaten pro Zeile getrennt, kein Thermomix/Nährwerte/Aufbewahrung darin)", r.no.name === "Cremige Brokkoli-Schinken-Nudeln" && /^400 g kurze Nudeln\n500 g Brokkoli\n200 g Kochschinken\n1 Zwiebel\n10 g Öl\n200 g Frischkäse natur\n250 ml Milch\n100 ml Nudelwasser\nSalz, Pfeffer, Muskat$/.test(r.no.ing||"") , JSON.stringify(r.no));
check("🧱 Schritte: 3 echte Schritte (Zeilen gehören zusammen), Nährwerte aus EINER Zeile, Thermomix auf Nachfrage mit „Nein“ nicht dabei", r.no.asked && r.no.steps.length === 3 && /^Nudeln nach Packung garen\. Brokkoliröschen die letzten 5-6 Min\. mitkochen\. 100 ml Nudelwasser auffangen\.$/.test(r.no.steps[0]) && r.no.kcal === 650 && r.no.protein === 34 && r.no.carbs === 84 && r.no.fat === 19, JSON.stringify(r.no));
check("🍲 Thermomix mit „Ja, dazu“: Block hängt hinten an den Schritten", r.yes.steps.length === 7 && /^🍲 Nudeln und Brokkoli/.test(r.yes.steps[3]) && /Stufe 1\.$/.test(r.yes.steps[4]), JSON.stringify(r.yes));
check("🧱 Spalten-Erkennung: zweispaltig → Trennlinie in der Mitte, Fließtext → keine", r.two && r.two.x > 450 && r.two.x < 560 && r.one === null, JSON.stringify({two:r.two, one:r.one}));

// 46) 🧱 Ganzer TikTok-Screenshot: App-Leiste wird nicht zum Namen, Spalten (Marke) → Zutaten links, Schritte rechts, Thermomix-Block extra, Nährwerte aus einer Zeile
r = await p.evaluate(async () => { const c=document.querySelector('#c1'); const oldWs=c._ws, oldOcr=c._ocrText, oldPick=c._pickFile; c._ws=async()=>({});
  const wait=(ms)=>new Promise(r=>setTimeout(r,ms));
  const click=(re)=>[...document.querySelectorAll("[data-elconfirm] button")].find(b=>re.test(b.textContent))?.click();
  const png="data:image/png;base64,iVBORw0KGgo=";
  c._pickFile=async()=>{ const t=c._photoTarget; setTimeout(()=>t.ocr(png),10); };
  const M="‖SPALTE‖";
  const TXT="LIVE\nSteinfurt Gefolgt Shop Für dich Q\n\nCremige BroKKOl Schinken-Nudeln\n\nI 4 Personen -\n\nca. 25 Minuten ©\n\n"
   +"400 g kurze Nudeln +\n200 g Kochschinken - 1 Zwiebel\n10 g Öl - 200 g Frischkäse natur\n250 ml Milch +\n\n500 g Brokkoli\n\n%\n\n100 ml Nudelwasser /\n\nSalz, Pfeffer, Muskat\n\n"
   +"Nudeln und Brokkoli wie oben im Topf garen.\n\nZwiebel halbiert 5 Sek./Stufe 5 zerkleinern,\nherunterschieben. Öl zugeben: 3 Min./120 °C/\nStufe 1.\n\nW Sauce in einer großen Schüssel mit Nudeln,\nBrokkoli und Nudelwasser mischen.\n\nx\n\n"+M+"\n\n"
   +"3 Nudeln nach Packung garen. Brokkoliröschen\n=” die letzten 5-6 Min. mitkochen. 100 ml\nNudelwasser auffangen.\n\nZwiebel fein würfeln, in Öl glasig dünsten.\nMilch und Frischkäse einrühren, 3-4 Min.\nsanft erhitzen.\n\nGewürfeliten Schinken, Nudeln und Brokkoli\nunterheben. Mit Nudelwasser cremig rühren\nund würzen.\n\n650 kcal - 34 g Eiweiß - 84 g Kohlenhydrate + 19 g Fett\n\nZügig abkühlen und kalt stellen. Im Kühlschrank\nbis 2 Tage. Einfrieren möglich.\n\nTipp: Brokkoli am Vorabend schneiden.\n\ndanisfamilienkueche\n\nHome Freund*innen Posteingang Profil\n";
  c._ocrText=async()=>TXT;
  c._openRecipe(null); await wait(150);
  c._recipeFromPhotos([]); await wait(500);
  click(/Rezept lesen/); await wait(500); click(/Fertig/); await wait(500);
  const asked=!!document.querySelector("[data-elconfirm]"); click(/^Nein/); await wait(700);
  const name=c.$("rName")?.value, ing=c.$("rImportText")?.value||"", steps=(c._draft.stepRows||[]).map(r=>r.t), nut=c._readNut?.();
  document.querySelectorAll("[data-elov],[data-elconfirm]").forEach(e=>e.remove()); c._view="list"; c._renderAll();
  // 🧱 Absätze nach Spalten ordnen (Tesseract-Absätze mit Position): links 3, rechts 3, ein Titel über alles
  const mk=(t,x0,x1,y0)=>({text:t,bbox:{x0,x1,y0,y1:y0+60}});
  const arranged=elOcrArrange([mk("Titel quer",30,1000,10),mk("A links",40,400,100),mk("B links",40,420,200),mk("C links",40,380,300),mk("D rechts",560,1000,100),mk("E rechts",560,990,200),mk("F rechts",560,980,300)]);
  const single=elOcrArrange([mk("A",40,900,100),mk("B",40,900,200),mk("C",40,900,300),mk("D",40,900,400)]);
  c._data.recipes=[]; c._ws=oldWs; c._ocrText=oldOcr; c._pickFile=oldPick; return { asked, name, ing, steps, kcal: nut?.kcal, protein: nut?.protein, arranged, single }; });
check("🧱 Ganzer Screenshot: App-Leiste wird nicht der Name, Zutaten links sauber, Kopf-Reste (4 Personen, 25 Minuten) weg", r.name === "Cremige BroKKOl Schinken-Nudeln" && r.ing === "400 g kurze Nudeln\n200 g Kochschinken\n1 Zwiebel\n10 g Öl\n200 g Frischkäse natur\n250 ml Milch\n500 g Brokkoli\n100 ml Nudelwasser\nSalz, Pfeffer, Muskat", JSON.stringify(r));
check("🧱 Schritte nur rechts (3), ohne Thermomix, Aufbewahrung, Tipp, Benutzername und App-Menü; Nährwerte da", r.asked && r.steps.length === 3 && /^Nudeln nach Packung garen\. Brokkoliröschen die letzten/.test(r.steps[0]) && !/=”/.test(r.steps[0]) && r.kcal === 650 && r.protein === 34, JSON.stringify(r));
check("🧱 Absätze nach Spalten geordnet (Titel, links, Marke, rechts), einspaltig bleibt wie es ist", r.arranged === "Titel quer\n\nA links\n\nB links\n\nC links\n\n‖SPALTE‖\n\nD rechts\n\nE rechts\n\nF rechts" && !r.single.includes("SPALTE"), JSON.stringify({a:r.arranged, s:r.single}));

// 💶 Angebotspreis am 🏷️: Tooltip mit günstigstem Angebot, Preis daneben nur mit Schalter (Standard aus)
r = await p.evaluate(async () => { const c=document.querySelector('#c1'); const root=c.shadowRoot; const d=c._data;
  const it=d.items.find((i)=>!i.checked && !i.offer); const keepOff=d.offers; const vp=d.settings.view_prefs||{}; const keepVp={...vp};
  const to=new Date(Date.now()+2*864e5).toISOString();
  d.offers={ [it.name.toLowerCase()]: [{p:1.49, r:"Aldi", to}, {p:0.99, op:1.99, r:"Lidl", to}, {p:0.5, r:"Netto", alt:"Ähnlich", to}] };
  c._tab="all"; c._view="list"; c._viewKey=null; c._renderAll(); await new Promise(r=>setTimeout(r,40));
  const btn=()=>root.querySelector('.item[data-id="'+it.id+'"] .offtag');
  const off={ title:btn()?.getAttribute("title")||"", price:!!btn()?.querySelector(".offp") };
  const tmp=document.createElement("div"); tmp.innerHTML=c._viewHtml(); const sw=tmp.querySelector('[data-key="offer_price"]');
  d.settings.view_prefs={ ...vp, _all:{ ...(vp._all||{}), offer_price:true } }; c._viewKey=null; c._renderList(); await new Promise(r=>setTimeout(r,30));
  const on={ txt:btn()?.querySelector(".offp")?.textContent||"" };
  d.settings.view_prefs=keepVp; d.offers=keepOff; c._viewKey=null; c._renderAll();
  return { off, on, sw:{ there:!!sw, pressed:sw?.getAttribute("aria-pressed") }, info:c._viewInfo() }; });
check("💶 Tooltip am 🏷️: günstigstes echtes Angebot mit statt, bis und +2 weitere", /^Lidl: 0,99\s€ \(statt 1,99\s€\) · bis .+ · \+2 weitere – Im Angebot/.test(r.off.title) && !r.off.price, JSON.stringify(r));
check("💶 Schalter „Angebotspreis neben 🏷️“ Standard aus, an = „ab 0,99 €“ daneben", r.sw.there && r.sw.pressed === "false" && /^ab 0,99\s€$/.test(r.on.txt) && !/ausgeblendet/.test(r.info), JSON.stringify(r));

check("keine JavaScript-Fehler", errs.length === 0, errs.join(" | "));
await b.close(); srv.close();
if (fails) { console.log(`\n${fails} Prüfung(en) fehlgeschlagen`); process.exit(1); }
console.log("\nAlles ok 🎉");
