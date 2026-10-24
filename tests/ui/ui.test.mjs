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
check("Rückruf-Warnung: ✔ schickt „dismiss“", r.calls.some((m) => m.type === "einkaufsliste/recalls/dismiss" && m.id === "w1"), JSON.stringify(r.calls));
r = await p.evaluate(`(() => { const c=${card}; const was=c._data.settings.privacy; c._data.settings.privacy=true; const blocked=/Gesperrt/.test(c._recallsHtml()); const priv=/Rückruf-Warnung/.test(c._privacyHtml(false)) && /Recall warning/.test(c._privacyHtml(true)); c._data.settings.privacy=was; return { blocked, priv, privOn: c._privacyOn.toString().slice(0,80) }; })()`);
check("Rückruf-Warnung: Datenschutz an = „🔒 Gesperrt“, und sie steht auf der Datenschutz-Seite", r.blocked && r.priv, JSON.stringify(r));

check("keine JavaScript-Fehler", errs.length === 0, errs.join(" | "));
await b.close(); srv.close();
if (fails) { console.log(`\n${fails} Prüfung(en) fehlgeschlagen`); process.exit(1); }
console.log("\nAlles ok 🎉");
