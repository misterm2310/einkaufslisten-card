// 🧪 Offline-App: eigene Anmeldung (Benutzer, Passwort, 2-Faktor) gegen nachgebaute /auth-Schnittstelle. Start: node tests/ui/app.test.mjs
import { chromium } from "playwright";
import http from "http"; import fs from "fs"; import path from "path"; import { fileURLToPath } from "url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = process.env.OUT || ""; const www = path.join(root, "custom_components/einkaufsliste/www");
const log = [];
const srv = http.createServer(async (q, r) => {
  const url = q.url.split("?")[0]; let body = "";
  for await (const c of q) body += c;
  log.push(`${q.method} ${url}`);
  if (url === "/einkaufsliste/app/") { r.setHeader("content-type", "text/html"); return r.end(fs.readFileSync(path.join(www, "app/index.html"), "utf8").replaceAll("__EL_VERSION__", "test")); }
  if (url.startsWith("/einkaufsliste/app/")) { const f = path.join(www, "app", url.slice(19)); try { r.setHeader("content-type", f.endsWith(".js") ? "text/javascript" : "application/octet-stream"); return r.end(fs.readFileSync(f)); } catch (e) { r.statusCode = 404; return r.end(); } }
  if (url.startsWith("/einkaufsliste/files/")) { const f = path.join(www, url.slice(21)); try { r.setHeader("content-type", f.endsWith(".js") ? "text/javascript" : "application/json"); return r.end(fs.readFileSync(f)); } catch (e) { r.statusCode = 404; return r.end(); } }
  r.setHeader("content-type", "application/json");
  if (url === "/auth/providers") return r.end(JSON.stringify({ providers: [{ name: "Home Assistant Local", id: null, type: "homeassistant" }], preselect_remember_me: false }));
  if (url === "/auth/login_flow") return r.end(JSON.stringify({ type: "form", flow_id: "f1", handler: ["homeassistant", null], step_id: "init", data_schema: [{ name: "username", type: "string" }, { name: "password", type: "string" }], errors: {} }));
  if (url === "/auth/login_flow/f1") {
    const j = JSON.parse(body || "{}");
    if (j.code) return r.end(JSON.stringify(j.code === "123456" ? { type: "create_entry", result: "CODE1", version: 1 } : { type: "form", flow_id: "f1", step_id: "mfa", data_schema: [{ name: "code", type: "string" }], errors: { base: "invalid_code" }, description_placeholders: { mfa_module_name: "Authenticator app" } }));
    if (j.password !== "geheim") return r.end(JSON.stringify({ type: "form", flow_id: "f1", step_id: "init", data_schema: [{ name: "username", type: "string" }, { name: "password", type: "string" }], errors: { base: "invalid_auth" } }));
    return r.end(JSON.stringify({ type: "form", flow_id: "f1", step_id: "mfa", data_schema: [{ name: "code", type: "string" }], errors: {}, description_placeholders: { mfa_module_name: "Authenticator app" } }));
  }
  if (url === "/auth/token") return r.end(JSON.stringify({ access_token: "A1", refresh_token: "R1", expires_in: 1800, token_type: "Bearer" }));
  r.statusCode = 404; r.end("{}");
}).listen(0);
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const p = await b.newPage({ viewport: { width: 400, height: 760 }, deviceScaleFactor: 2, locale: "de-DE" });
const errs = []; p.on("pageerror", (e) => errs.push(String(e)));
await p.goto(`http://localhost:${srv.address().port}/einkaufsliste/app/`); await p.waitForTimeout(600);
if (OUT) await p.screenshot({ path: `${OUT}/1-start.png` });
const res = {};
res.haBtn = await p.locator("#haLoginBtn").count();
await p.click("#loginBtn"); await p.waitForTimeout(300);
res.fields = await p.$$eval("form.lform input", (xs) => xs.map((x) => x.name + ":" + (x.type || "")));
await p.fill('input[name=username]', "marco"); await p.fill('input[name=password]', "falsch"); await p.click("form.lform button[type=submit]"); await p.waitForTimeout(300);
res.err = await p.locator(".lerr").textContent().catch(() => null);
res.keepUser = await p.inputValue("input[name=username]");
if (OUT) await p.screenshot({ path: `${OUT}/2-falsch.png` });
await p.fill('input[name=password]', "geheim"); await p.click("form.lform button[type=submit]"); await p.waitForTimeout(300);
res.mfa = await p.$$eval("form.lform input", (xs) => xs.map((x) => x.name + ":" + x.autocomplete));
if (OUT) await p.screenshot({ path: `${OUT}/3-code.png` });
await p.fill('input[name=code]', "123456"); await p.click("form.lform button[type=submit]"); await p.waitForTimeout(600);
res.auth = await p.evaluate(() => Object.keys(localStorage).filter((k) => /auth/.test(k)).map((k) => localStorage.getItem(k)).join("|"));
res.formGone = (await p.locator("form.lform").count()) === 0;
res.calls = log;
let fails = 0;
const check = (name, ok) => { console.log(`${ok ? "✅" : "❌"} ${name}${ok ? "" : " – " + JSON.stringify(res)}`); if (!ok) fails++; };
check("Anmelden: eigenes Formular mit Benutzer + Passwort, alter Weg als Knopf", res.haBtn === 1 && res.fields.join() === "username:text,password:password");
check("Falsches Passwort: Meldung, Benutzername bleibt stehen", /stimmt nicht/.test(res.err || "") && res.keepUser === "marco");
check("2-Faktor: Code-Feld (Einmal-Code fürs Handy)", res.mfa.join() === "code:one-time-code");
check("Geschafft: Schlüssel gespeichert, Formular weg", /"refresh":"R1"/.test(res.auth) && res.formGone);
check("Nur /einkaufsliste/*, /auth/* und /api/websocket gebraucht (kein /frontend_latest, /static, /einkaufsliste_files)", res.calls.every((x) => /^(GET|POST) \/(einkaufsliste\/|auth\/|api\/websocket$)/.test(x)));
check("keine JavaScript-Fehler", errs.length === 0);
console.log(fails ? `\n${fails} Fehler` : "\nAlles ok 🎉");
process.exitCode = fails ? 1 : 0;
await b.close(); srv.close();
