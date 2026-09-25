/*
 * Einkaufsliste Card – die Familien-Einkaufsliste für Home Assistant
 * Wird automatisch von der Integration "einkaufsliste" geladen.
 */
const EL_VERSION = "1.0.0";

const WD_SHORT = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"]; // Python: Montag = 0
const WD_LONG = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"];
const pyWd = (d) => (d.getDay() + 6) % 7;
const DAY = 86400000;

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const dayDiff = (a, b) => Math.round((startOfDay(a) - startOfDay(b)) / DAY);
const fmtDay = (d) => `${WD_SHORT[pyWd(d)]} ${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}.`;
function fmtSince(iso) {
  const d = new Date(iso);
  const diff = dayDiff(new Date(), d);
  if (diff <= 0) return "heute";
  if (diff === 1) return "gestern";
  if (diff < 7) return `seit ${WD_SHORT[pyWd(d)]}`;
  return `seit ${fmtDay(d)}`;
}

const EMPTY_JOKES = [
  "Alles erledigt! Der Kühlschrank ist glücklich. 🎉",
  "Nix mehr zu kaufen – Zeit fürs Sofa! 🛋️",
  "Liste leer. Der Einkaufswagen macht heute frei. 🛒💤",
  "Alles im Korb. Du bist ein Einkaufs-Profi! 🏆",
];

const STYLE = `
:host { display:block; }
ha-card { display:block; padding:12px 12px 8px; overflow:hidden; }
* { box-sizing:border-box; }
button { font:inherit; color:inherit; }
.head { display:flex; align-items:center; gap:8px; margin:0 2px 10px; }
.title { display:flex; align-items:center; gap:8px; font-size:1.25em; font-weight:600; flex:1; min-width:0; }
.title span.t { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.badge { background:var(--primary-color,#03a9f4); color:var(--text-primary-color,#fff); border-radius:999px; padding:1px 9px; font-size:.75em; font-weight:600; }
.iconbtn { background:none; border:0; cursor:pointer; padding:6px; border-radius:50%; display:inline-flex; color:var(--secondary-text-color); line-height:0; }
.iconbtn:hover { background:var(--secondary-background-color, rgba(127,127,127,.12)); color:var(--primary-text-color); }
.iconbtn[disabled] { opacity:.3; pointer-events:none; }
.tabs { display:flex; gap:6px; overflow-x:auto; padding:2px 2px 8px; scrollbar-width:none; }
.tabs::-webkit-scrollbar { display:none; }
.tab { --c: var(--primary-color,#03a9f4); flex:0 0 auto; border:1.5px solid color-mix(in srgb, var(--c) 55%, transparent); background:transparent; border-radius:999px; padding:5px 12px; cursor:pointer; display:inline-flex; align-items:center; gap:6px; font-size:.9em; }
.tab .dot { width:9px; height:9px; border-radius:50%; background:var(--c); }
.tab .n { opacity:.7; font-size:.85em; }
.tab.active { background:var(--c); border-color:var(--c); color:#fff; }
.tab.active .dot { background:#fff; }
.tab.active .n { opacity:.9; }
form.add { display:grid; grid-template-columns: 1fr 72px 44px; gap:6px; margin:2px 2px 6px; }
form.add .sel { grid-column: 1 / span 3; display:grid; grid-template-columns:1fr 1fr; gap:6px; }
form.add.fixed .sel { grid-template-columns:1fr; }
input, select { font:inherit; font-size:.95em; color:var(--primary-text-color); background:var(--input-fill-color, var(--secondary-background-color, rgba(127,127,127,.08))); border:1px solid var(--divider-color, rgba(127,127,127,.3)); border-radius:10px; padding:9px 10px; min-width:0; width:100%; outline:none; }
input:focus, select:focus { border-color:var(--primary-color,#03a9f4); }
.primary { background:var(--primary-color,#03a9f4); color:var(--text-primary-color,#fff); border:0; border-radius:10px; cursor:pointer; display:inline-flex; align-items:center; justify-content:center; }
.primary:active { transform:scale(.96); }
.shake { animation: shake .35s; }
@keyframes shake { 25%{transform:translateX(-5px)} 75%{transform:translateX(5px)} }
.group { margin-top:8px; }
.ghead { display:flex; align-items:center; gap:6px; font-size:.8em; font-weight:600; text-transform:uppercase; letter-spacing:.04em; color:var(--secondary-text-color); padding:6px 4px 2px; }
.ghead ha-icon { --mdc-icon-size:16px; }
.ghead .n { margin-left:auto; font-weight:500; }
.item { display:flex; align-items:center; gap:4px; padding:4px 2px; border-radius:10px; transition: opacity .25s, background .2s; }
.item:hover { background:var(--secondary-background-color, rgba(127,127,127,.06)); }
.item .check { color:var(--primary-color,#03a9f4); }
.item .txt { flex:1; min-width:0; cursor:pointer; padding:2px 0; }
.item .line { display:flex; flex-wrap:wrap; align-items:baseline; gap:0 6px; }
.item .name { font-weight:500; word-break:break-word; }
.item .qty { font-size:.85em; background:var(--secondary-background-color, rgba(127,127,127,.12)); border-radius:6px; padding:0 6px; }
.item .who { font-size:.85em; color:var(--secondary-text-color); }
.item .meta { font-size:.75em; color:var(--secondary-text-color); display:flex; flex-wrap:wrap; gap:2px 8px; margin-top:1px; }
.chip { --c:#888; display:inline-flex; align-items:center; gap:4px; }
.chip::before { content:""; width:7px; height:7px; border-radius:50%; background:var(--c); }
.item .acts { display:flex; opacity:.55; }
.item:hover .acts { opacity:1; }
.item.done .name { text-decoration:line-through; opacity:.6; }
.item.done .check { color:var(--success-color, #43a047); }
.item.pending { opacity:.45; }
.donehead { cursor:pointer; user-select:none; }
.donehead ha-icon.chev { transition: transform .2s; }
.donehead.closed ha-icon.chev { transform: rotate(-90deg); }
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
.srow input.grow { flex:1; }
.srow input[type=color] { width:40px; height:38px; padding:2px; flex:0 0 auto; cursor:pointer; }
.srow input.grow { min-width:90px; }
.srow input.icon { width:74px; flex:0 0 auto; font-size:.8em; }
.srow .iconbtn { padding:4px; }
.srow .prev { width:24px; flex:0 0 auto; color:var(--secondary-text-color); }
.srow .primary { width:40px; height:38px; flex:0 0 auto; }
.sec p { margin:4px 0; font-size:.9em; line-height:1.4; }
.hint { color:var(--secondary-text-color); font-size:.8em !important; }
.btnrow { display:flex; flex-wrap:wrap; gap:6px; margin-top:8px; }
.btn { border:1px solid var(--divider-color, rgba(127,127,127,.35)); background:transparent; border-radius:10px; padding:8px 12px; cursor:pointer; font-size:.9em; display:inline-flex; align-items:center; gap:6px; }
.btn.danger { color:var(--error-color,#db4437); border-color:color-mix(in srgb, var(--error-color,#db4437) 50%, transparent); }
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
    this._view = "list";
    this._editing = null;
    this._doneOpen = true;
    this._pending = new Set();
    this._joke = EMPTY_JOKES[Math.floor(Math.random() * EMPTY_JOKES.length)];
  }

  setConfig(config) {
    this._config = {
      title: "Einkaufsliste",
      store: "all",
      show_checked: true,
      show_added_by: true,
      added_by_style: "name",
      show_dates: true,
      show_settings: true,
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
  }

  connectedCallback() {
    if (this._hass && !this._unsub && !this._subscribing) this._subscribe();
  }

  disconnectedCallback() {
    if (this._unsub) { this._unsub(); this._unsub = null; }
  }

  getCardSize() { return 3 + Math.min(10, (this._data?.items?.length || 0)); }

  async _subscribe() {
    this._subscribing = true;
    try {
      const unsub = await this._hass.connection.subscribeMessage(
        (data) => { this._data = data; this._error = null; this._renderAll(); },
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
          <div class="title"><ha-icon icon="mdi:cart-variant"></ha-icon><span class="t" id="title"></span><span class="badge" id="count" hidden></span></div>
          <button class="iconbtn" id="btnSettings" title="Geschäfte & Kategorien"><ha-icon icon="mdi:cog-outline"></ha-icon></button>
        </div>
        <div class="error" id="error" hidden></div>
        <div id="listView">
          <div class="tabs" id="tabs"></div>
          <form class="add" id="addForm" autocomplete="off">
            <input id="inName" list="hist" placeholder="Was brauchen wir? z. B. Milch" enterkeyhint="done">
            <input id="inQty" placeholder="Menge">
            <button class="primary" type="submit" title="Hinzufügen"><ha-icon icon="mdi:plus"></ha-icon></button>
            <div class="sel">
              <select id="inStore" title="Geschäft"></select>
              <select id="inCat" title="Kategorie"></select>
            </div>
            <datalist id="hist"></datalist>
          </form>
          <div id="list"></div>
        </div>
        <div id="settingsView" hidden></div>
        <div class="footer" id="footer" hidden></div>
      </ha-card>`;

    const root = this.shadowRoot;
    this.$("addForm").addEventListener("submit", (e) => this._onAdd(e));
    this.$("inName").addEventListener("input", () => this._onNameInput());
    this.$("btnSettings").addEventListener("click", () => {
      this._view = this._view === "list" ? "settings" : "list";
      this._renderAll();
    });
    root.addEventListener("click", (e) => this._onClick(e));
    root.addEventListener("change", (e) => this._onChange(e));
    root.addEventListener("input", (e) => {
      if (e.target.dataset?.field === "icon") {
        const prev = e.target.parentElement.querySelector(".prev");
        if (prev) prev.setAttribute("icon", e.target.value);
      }
    });
    root.addEventListener("submit", (e) => {
      if (e.target.dataset?.addkind) this._onGroupAdd(e);
      if (e.target.classList?.contains("editrow")) { e.preventDefault(); this._saveEdit(); }
    });
    this._renderAll();
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
  _deleteDate(item) {
    const s = this._data?.settings;
    if (!s) return null;
    if (s.only_checked && !item.checked) return null;
    let d = new Date(s.next_cleanup);
    const added = new Date(item.added_at);
    for (let i = 0; i < 60 && dayDiff(d, added) < s.min_age_days; i++) d = new Date(d.getTime() + 7 * DAY);
    return d;
  }

  // ---------------------------------------------------------------- Rendern
  _renderAll() {
    if (!this._built || !this._config) return;
    const d = this._data;
    this.$("title").textContent = this._fixedStore && this._store(this._fixedStore)
      ? `${this._config.title} · ${this._store(this._fixedStore).name}` : this._config.title;
    const err = this.$("error");
    err.hidden = !this._error;
    err.textContent = this._error || "";
    this.$("btnSettings").hidden = !this._config.show_settings || !d;
    this.$("btnSettings").querySelector("ha-icon").setAttribute("icon", this._view === "settings" ? "mdi:close" : "mdi:cog-outline");
    if (!d) { this.$("listView").hidden = true; this.$("footer").hidden = true; return; }

    const open = d.items.filter((i) => !i.checked && (this._fixedStore ? i.store_id === this._fixedStore : true));
    const cnt = this.$("count");
    cnt.hidden = open.length === 0;
    cnt.textContent = open.length;

    const settings = this._view === "settings";
    this.$("listView").hidden = settings;
    this.$("settingsView").hidden = !settings;
    if (settings) {
      const sv = this.$("settingsView");
      if (!sv.contains(this.shadowRoot.activeElement)) this._renderSettings();
    } else {
      this._renderTabs();
      this._renderSelects();
      this._renderHistory();
      if (!this._editing) this._renderList();
    }
    this._renderFooter();
  }

  _renderTabs() {
    const tabs = this.$("tabs");
    const d = this._data;
    if (this._fixedStore) { tabs.hidden = true; return; }
    tabs.hidden = false;
    const openCount = (fn) => d.items.filter((i) => !i.checked && fn(i)).length;
    const active = this._activeTab;
    const parts = [`<button class="tab ${active === "all" ? "active" : ""}" data-act="tab" data-tab="all"><ha-icon icon="mdi:format-list-checks" style="--mdc-icon-size:16px"></ha-icon>Alle <span class="n">${openCount(() => true)}</span></button>`];
    for (const s of d.stores) {
      parts.push(`<button class="tab ${active === s.id ? "active" : ""}" style="--c:${esc(s.color)}" data-act="tab" data-tab="${s.id}"><span class="dot"></span>${esc(s.name)} <span class="n">${openCount((i) => i.store_id === s.id)}</span></button>`);
    }
    const none = openCount((i) => !i.store_id);
    if (none || active === "none") {
      parts.push(`<button class="tab ${active === "none" ? "active" : ""}" style="--c:#888" data-act="tab" data-tab="none"><span class="dot"></span>Egal wo <span class="n">${none}</span></button>`);
    }
    tabs.innerHTML = parts.join("");
  }

  _renderSelects() {
    const d = this._data;
    const st = this.$("inStore");
    const ct = this.$("inCat");
    const form = this.$("addForm");
    form.classList.toggle("fixed", !!this._fixedStore);
    st.hidden = !!this._fixedStore;
    const prevStore = st.value;
    const prevCat = ct.value;
    st.innerHTML = `<option value="">🛒 Egal wo</option>` + d.stores.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join("");
    ct.innerHTML = `<option value="">📦 Ohne Kategorie</option>` + d.categories.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("");
    const tab = this._activeTab;
    if (this._lastTab !== tab) {
      st.value = tab !== "all" && tab !== "none" ? tab : "";
      this._lastTab = tab;
    } else if (d.stores.some((s) => s.id === prevStore)) st.value = prevStore;
    if (d.categories.some((c) => c.id === prevCat)) ct.value = prevCat;
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
    const meta = [];
    if (this._activeTab === "all" && store) meta.push(`<span class="chip" style="--c:${esc(store.color)}">${esc(store.name)}</span>`);
    if (item.note) meta.push(`<span>📝 ${esc(item.note)}</span>`);
    if (c.show_dates) {
      if (item.checked) {
        meta.push(`<span>✓ ${item.checked_by ? esc(this._who(item.checked_by)) : "abgehakt"}</span>`);
      } else {
        meta.push(`<span>${fmtSince(item.added_at)}</span>`);
      }
      const del = this._deleteDate(item);
      if (del) meta.push(`<span title="Wird beim Aufräumen gelöscht">🧹 ${fmtDay(del)}</span>`);
    }
    const who = c.show_added_by && item.added_by ? `<span class="who">(${esc(this._who(item.added_by))})</span>` : "";
    const qty = item.quantity ? `<span class="qty">${esc(item.quantity)}</span>` : "";
    const icon = item.checked ? "mdi:checkbox-marked-circle" : "mdi:checkbox-blank-circle-outline";
    return `
      <div class="item ${item.checked ? "done" : ""} ${this._pending.has(item.id) ? "pending" : ""}" data-id="${item.id}">
        <button class="iconbtn check" data-act="toggle" title="${item.checked ? "Wieder auf die Liste" : "Abhaken"}"><ha-icon icon="${icon}"></ha-icon></button>
        <div class="txt" data-act="toggle">
          <div class="line"><span class="name">${esc(item.name)}</span>${qty}${who}</div>
          ${meta.length ? `<div class="meta">${meta.join("")}</div>` : ""}
        </div>
        <div class="acts">
          <button class="iconbtn" data-act="edit" title="Bearbeiten"><ha-icon icon="mdi:pencil-outline"></ha-icon></button>
          <button class="iconbtn" data-act="remove" title="Löschen"><ha-icon icon="mdi:close"></ha-icon></button>
        </div>
      </div>`;
  }

  _editHtml(item) {
    const d = this._data;
    const opt = (list, sel, empty) => `<option value="">${empty}</option>` + list.map((x) => `<option value="${x.id}" ${x.id === sel ? "selected" : ""}>${esc(x.name)}</option>`).join("");
    return `
      <form class="editrow" data-id="${item.id}">
        <input class="full" id="edName" value="${esc(item.name)}" placeholder="Name">
        <input id="edQty" value="${esc(item.quantity || "")}" placeholder="Menge">
        <input id="edNote" value="${esc(item.note || "")}" placeholder="Notiz (z. B. Bio)">
        <select id="edStore">${opt(d.stores, item.store_id, "🛒 Egal wo")}</select>
        <select id="edCat">${opt(d.categories, item.category_id, "📦 Ohne Kategorie")}</select>
        <div class="btns">
          <button type="button" class="textbtn" data-act="edit-cancel">Abbrechen</button>
          <button type="submit" class="primary">Speichern</button>
        </div>
      </form>`;
  }

  _renderList() {
    const d = this._data;
    const list = this.$("list");
    const items = d.items.filter((i) => this._matchesTab(i));
    const open = items.filter((i) => !i.checked);
    const done = items.filter((i) => i.checked);
    const row = (i) => (this._editing === i.id ? this._editHtml(i) : this._itemHtml(i));
    const html = [];

    if (!open.length) {
      html.push(`<div class="empty"><ha-icon icon="mdi:cart-check"></ha-icon>${
        items.length || d.items.length ? esc(this._joke) : "Noch nichts auf der Liste. Tipp oben rein, was fehlt! ✍️"}</div>`);
    } else {
      const groups = new Map();
      for (const c of d.categories) groups.set(c.id, []);
      groups.set(null, []);
      for (const i of open) (groups.has(i.category_id) ? groups.get(i.category_id) : groups.get(null)).push(i);
      for (const [cid, arr] of groups) {
        if (!arr.length) continue;
        arr.sort((a, b) => a.name.localeCompare(b.name, "de"));
        const cat = this._cat(cid);
        html.push(`<div class="group"><div class="ghead"><ha-icon icon="${esc(cat?.icon || "mdi:tag-outline")}"></ha-icon>${esc(cat?.name || "Ohne Kategorie")}<span class="n">${arr.length}</span></div>${arr.map(row).join("")}</div>`);
      }
    }

    if (this._config.show_checked && done.length) {
      done.sort((a, b) => (b.checked_at || "").localeCompare(a.checked_at || ""));
      html.push(`<div class="group">
        <div class="ghead donehead ${this._doneOpen ? "" : "closed"}" data-act="toggle-done"><ha-icon class="chev" icon="mdi:chevron-down"></ha-icon>Im Wagen / erledigt<span class="n">${done.length}</span></div>
        ${this._doneOpen ? done.map(row).join("") + `<button class="textbtn danger" data-act="clear-checked">🗑️ Erledigte entfernen</button>` : ""}
      </div>`);
    }
    list.innerHTML = html.join("");
    if (this._editing) this.$("edName")?.focus();
  }

  _renderFooter() {
    const f = this.$("footer");
    const s = this._data?.settings;
    if (!s || this._view === "settings") { f.hidden = true; return; }
    f.hidden = false;
    const next = new Date(s.next_cleanup);
    const what = s.only_checked ? "abgehakte Einträge" : "Einträge";
    f.innerHTML = `<ha-icon icon="mdi:broom"></ha-icon><span>Nächstes Aufräumen: <b>${fmtDay(next)} ${s.cleanup_time}</b> – ${what} ab ${s.min_age_days} Tagen fliegen raus</span>`;
  }

  _renderSettings() {
    const d = this._data;
    const s = d.settings;
    const row = (kind, e, i, len) => `
      <div class="srow" data-kind="${kind}" data-id="${e.id}">
        ${kind === "stores"
          ? `<input type="color" value="${esc(e.color || "#607d8b")}" data-field="color" title="Farbe">`
          : `<ha-icon class="prev" icon="${esc(e.icon || "mdi:tag-outline")}"></ha-icon>`}
        <input class="grow" value="${esc(e.name)}" data-field="name">
        ${kind === "categories" ? `<input class="icon" value="${esc(e.icon || "")}" data-field="icon" placeholder="mdi:…" title="Icon (mdi:…)">` : ""}
        <button class="iconbtn" data-act="up" ${i === 0 ? "disabled" : ""} title="Nach oben"><ha-icon icon="mdi:chevron-up"></ha-icon></button>
        <button class="iconbtn" data-act="down" ${i === len - 1 ? "disabled" : ""} title="Nach unten"><ha-icon icon="mdi:chevron-down"></ha-icon></button>
        <button class="iconbtn" data-act="group-remove" title="Löschen"><ha-icon icon="mdi:trash-can-outline"></ha-icon></button>
      </div>`;
    this.$("settingsView").innerHTML = `
      <div class="sec">
        <h3><ha-icon icon="mdi:store-outline"></ha-icon>Geschäfte</h3>
        ${d.stores.map((e, i) => row("stores", e, i, d.stores.length)).join("")}
        <form class="srow" data-addkind="stores">
          <input type="color" value="#607d8b" name="color" title="Farbe">
          <input class="grow" name="name" placeholder="Neues Geschäft, z. B. Kaufland">
          <button class="primary" type="submit" title="Hinzufügen"><ha-icon icon="mdi:plus"></ha-icon></button>
        </form>
      </div>
      <div class="sec">
        <h3><ha-icon icon="mdi:shape-outline"></ha-icon>Kategorien</h3>
        ${d.categories.map((e, i) => row("categories", e, i, d.categories.length)).join("")}
        <form class="srow" data-addkind="categories">
          <ha-icon class="prev" icon="mdi:tag-plus-outline"></ha-icon>
          <input class="grow" name="name" placeholder="Neue Kategorie">
          <input class="icon" name="icon" placeholder="mdi:dog" title="Icon (mdi:…)">
          <button class="primary" type="submit" title="Hinzufügen"><ha-icon icon="mdi:plus"></ha-icon></button>
        </form>
        <p class="hint">Icons findest du auf pictogrammers.com/library/mdi – einfach z. B. <b>mdi:dog</b> eintragen.</p>
      </div>
      <div class="sec">
        <h3><ha-icon icon="mdi:broom"></ha-icon>Aufräumen</h3>
        <p>Jeden <b>${WD_LONG[s.cleanup_weekday]}</b> um <b>${s.cleanup_time} Uhr</b> werden ${s.only_checked ? "alle <b>abgehakten</b>" : "<b>alle</b>"} Einträge gelöscht, die mindestens <b>${s.min_age_days} Tage</b> auf der Liste stehen.</p>
        <p class="hint">Ändern: Einstellungen → Geräte & Dienste → Einkaufsliste → Konfigurieren</p>
        <div class="btnrow">
          <button class="btn" data-act="cleanup-now"><ha-icon icon="mdi:broom"></ha-icon>Jetzt nach Regeln aufräumen</button>
          <button class="btn danger" data-act="clear-all"><ha-icon icon="mdi:delete-sweep-outline"></ha-icon>Liste komplett leeren</button>
        </div>
      </div>
      <p class="hint" style="text-align:right">Einkaufsliste v${EL_VERSION}</p>`;
  }

  // ---------------------------------------------------------------- Aktionen
  _onNameInput() {
    const val = this.$("inName").value.trim().toLowerCase();
    const h = this._data?.history.find((x) => x.name.toLowerCase() === val);
    if (!h) return;
    if (h.category_id && this._cat(h.category_id)) this.$("inCat").value = h.category_id;
    if (!this._fixedStore && this._activeTab === "all" && h.store_id && this._store(h.store_id)) this.$("inStore").value = h.store_id;
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
    const qty = this.$("inQty").value.trim();
    if (qty) msg.quantity = qty;
    try {
      await this._ws(msg);
      this.$("inName").value = "";
      this.$("inQty").value = "";
      this.$("inCat").value = "";
      this.$("inName").focus();
    } catch (_) { /* Meldung kam schon */ }
  }

  _onClick(e) {
    const el = e.target.closest("[data-act]");
    if (!el) return;
    const act = el.dataset.act;
    const itemEl = el.closest(".item");
    const id = itemEl?.dataset.id;
    const srow = el.closest(".srow");

    switch (act) {
      case "tab":
        this._tab = el.dataset.tab;
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
      case "remove":
        this._ws({ type: "einkaufsliste/item/remove", item_id: id }).catch(() => {});
        break;
      case "edit":
        this._editing = id;
        this._renderList();
        break;
      case "edit-cancel":
        this._editing = null;
        this._renderList();
        break;
      case "toggle-done":
        this._doneOpen = !this._doneOpen;
        this._renderList();
        break;
      case "clear-checked":
        this._ws({ type: "einkaufsliste/items/clear_checked" })
          .then((r) => this._toast(`${r.removed} erledigte Artikel entfernt 🧹`)).catch(() => {});
        break;
      case "cleanup-now":
        this._ws({ type: "einkaufsliste/cleanup" })
          .then((r) => this._toast(r.removed ? `${r.removed} alte Artikel aufgeräumt 🧹` : "Nix zu tun – alles noch frisch! ✨")).catch(() => {});
        break;
      case "clear-all":
        if (!confirm("Wirklich die KOMPLETTE Liste leeren? Das kann man nicht rückgängig machen.")) return;
        this._ws({ type: "einkaufsliste/cleanup", force: true })
          .then((r) => this._toast(`Liste geleert – ${r.removed} Artikel weg. Tabula rasa! 🧽`)).catch(() => {});
        break;
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
        const field = kind === "stores" ? "store_id" : "category_id";
        const used = this._data.items.filter((i) => i[field] === entry.id).length;
        const txt = `„${entry.name}“ löschen?` + (used ? ` ${used} Artikel landen dann bei „${kind === "stores" ? "Egal wo" : "Ohne Kategorie"}“.` : "");
        if (!confirm(txt)) return;
        this._ws({ type: "einkaufsliste/group/remove", kind, group_id: entry.id }).then(() => this._renderSettings()).catch(() => {});
        break;
      }
    }
  }

  _onChange(e) {
    const t = e.target;
    const srow = t.closest(".srow[data-kind]");
    if (!srow || !t.dataset.field) return;
    const msg = { type: "einkaufsliste/group/update", kind: srow.dataset.kind, group_id: srow.dataset.id };
    msg[t.dataset.field] = t.value;
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
    if (form.elements.icon && form.elements.icon.value.trim()) msg.icon = form.elements.icon.value.trim();
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
  store: "Welche Geschäfte zeigen?",
  show_checked: "Abgehakte Artikel anzeigen",
  show_added_by: "Name „(X)“ hinter dem Artikel",
  added_by_style: "Name anzeigen als",
  show_dates: "Datum & Aufräum-Tag anzeigen",
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
      title: "Einkaufsliste", show_checked: true, show_added_by: true, added_by_style: "name",
      show_dates: true, show_settings: true, ...this._config,
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
    description: "Familien-Einkaufsliste mit Geschäften, Kategorien und Live-Sync.",
    preview: false,
    documentationURL: "https://github.com/misterm2310/einkaufslisten-card",
  });
}

console.info(`%c 🛒 EINKAUFSLISTE %c v${EL_VERSION} `, "background:#43a047;color:#fff;font-weight:700;border-radius:4px 0 0 4px", "background:#333;color:#fff;border-radius:0 4px 4px 0");
