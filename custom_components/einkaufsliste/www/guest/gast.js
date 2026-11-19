// 🎫 Gast-Seite: PIN eingeben, offene Artikel sehen, abhaken. Spricht nur mit /api/einkaufsliste/gast.
// Der Schlüssel steht hinter „#“ im Link – der Browser schickt diesen Teil nie von selbst mit (kein Server-Protokoll).
(() => {
  "use strict";
  const API = "/api/einkaufsliste/gast";
  const token = decodeURIComponent((location.hash || "").slice(1));
  const $ = (id) => document.getElementById(id);
  let lang = /^de/i.test(navigator.language || "de") ? "de" : "en";
  let sid = null, timer = null, busy = false;
  const TXT = {
    de: { sub: "Gast-Zugang", ask: "Bitte die PIN eingeben, die du bekommen hast.", wrong: "Die PIN stimmt nicht.", gone: "Dieser Link ist abgelaufen oder wurde gesperrt.", pause: "Zu viele falsche Versuche. Bitte in {} Minuten noch einmal.", net: "Keine Verbindung – ich versuche es gleich noch einmal.", empty: "Alles erledigt – nichts mehr offen. 🎉", until: "Gilt bis {}", any: "Egal wo", title: "Einkaufsliste", hint: "Antippen = abgehakt · nochmal antippen = zurück", nolink: "Der Link ist unvollständig – bitte ganz kopieren." },
    en: { sub: "Guest access", ask: "Please enter the PIN you were given.", wrong: "The PIN is wrong.", gone: "This link has expired or was locked.", pause: "Too many wrong attempts. Please try again in {} minutes.", net: "No connection – trying again shortly.", empty: "All done – nothing left. 🎉", until: "Valid until {}", any: "Anywhere", title: "Shopping list", hint: "Tap = checked off · tap again = undo", nolink: "The link is incomplete – please copy all of it." },
  };
  const t = (k, v) => TXT[lang][k].replace("{}", v ?? "");
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  function texts() {
    document.documentElement.lang = lang;
    $("title").textContent = t("title"); document.title = t("title");
    $("sub").textContent = t("sub"); $("ask").textContent = t("ask");
  }
  async function call(body) {
    const r = await fetch(API, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ t: token, ...body }), cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer" });
    let data = {};
    try { data = await r.json(); } catch (_) { /* leer */ }
    return { status: r.status, data };
  }
  function stop(text) {
    clearInterval(timer); timer = null; sid = null;
    $("list").hidden = true; $("login").hidden = false;
    $("pin").disabled = $("go").disabled = true;
    $("msg").textContent = text;
  }
  function render(d) {
    if (d.lang && d.lang !== lang) { lang = d.lang; texts(); }
    const until = d.until ? new Date(d.until).toLocaleString(lang === "de" ? "de-DE" : "en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" }) : "";
    $("sub").textContent = `${d.store ? d.store + " · " : ""}${t("until", until)}`;
    const items = d.items || [];
    if (!items.length) { $("list").innerHTML = `<p class="empty">${esc(t("empty"))}</p>`; return; }
    let html = "", last = null;
    for (const i of items) {
      const grp = i.checked ? "✓" : (i.store || t("any"));
      if (grp !== last && !d.store) { html += `<div class="store" style="--c:${/^#[0-9a-f]{3,8}$/i.test(i.color || "") ? i.color : "#888"}"><span class="dot"></span>${esc(grp)}</div>`; last = grp; }
      html += `<div class="item${i.checked ? " done" : ""}" role="checkbox" tabindex="0" aria-checked="${i.checked}" data-id="${esc(i.id)}" data-c="${i.checked ? 1 : 0}"><span class="chk">${i.checked ? "✓" : ""}</span><span class="nm">${i.quantity ? `<span class="q">${esc(i.quantity)}</span>` : ""}${esc(i.name)}${i.note ? `<span class="note">${esc(i.note)}</span>` : ""}</span></div>`;
    }
    $("list").innerHTML = html;
    $("foot").textContent = t("hint");
  }
  function handle(res) {
    if (res.status === 200 && res.data.ok) { render(res.data); return true; }
    if (res.status === 401) { stop(""); $("pin").disabled = $("go").disabled = false; $("msg").textContent = t("wrong"); return false; }
    if (res.status === 429) { $("msg").textContent = t("pause", Math.ceil((res.data.wait || 900) / 60)); return false; }
    stop(t("gone")); return false;
  }
  async function refresh() {
    if (!sid || busy || document.hidden) return;
    try { handle(await call({ do: "list", s: sid })); } catch (_) { /* 📶 kurz weg: beim nächsten Mal */ }
  }
  async function login() {
    const pin = $("pin").value.trim();
    if (!/^\d{4,8}$/.test(pin)) { $("msg").textContent = t("wrong"); return; }
    $("go").disabled = true;
    try {
      const res = await call({ do: "open", pin });
      if (handle(res)) {
        sid = res.data.s; $("pin").value = ""; $("msg").textContent = "";
        $("login").hidden = true; $("list").hidden = false;
        clearInterval(timer); timer = setInterval(refresh, 30000); // alle 30 s frisch (nur wenn die Seite sichtbar ist)
      }
    } catch (_) { $("msg").textContent = t("net"); }
    if (!sid && !$("pin").disabled) $("go").disabled = false; // nochmal versuchen (außer der Link ist weg)
  }
  async function toggle(row) {
    if (!sid || busy) return;
    busy = true;
    const want = row.dataset.c !== "1";
    row.classList.toggle("done", want); row.querySelector(".chk").textContent = want ? "✓" : "";
    try { handle(await call({ do: "check", s: sid, id: row.dataset.id, checked: want })); }
    catch (_) { $("foot").textContent = t("net"); }
    busy = false;
  }
  texts();
  if (!/^[A-Za-z0-9_-]{30,64}$/.test(token)) { stop(t("nolink")); return; }
  history.replaceState(null, "", location.pathname + location.hash); // nichts an die Adresse hängen
  $("go").addEventListener("click", login);
  $("pin").addEventListener("keydown", (e) => { if (e.key === "Enter") login(); });
  $("list").addEventListener("click", (e) => { const row = e.target.closest(".item"); if (row) toggle(row); });
  $("list").addEventListener("keydown", (e) => { if ((e.key === " " || e.key === "Enter") && e.target.closest(".item")) { e.preventDefault(); toggle(e.target.closest(".item")); } });
  document.addEventListener("visibilitychange", refresh);
})();
