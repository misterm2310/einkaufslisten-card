// 📌 Seitenleisten-Ansicht: zeigt die Einkaufsliste-Karte über die ganze Seite.
// Wird nur geladen, wenn die Option „In der Seitenleiste anzeigen“ eingeschaltet ist.
class EinkaufslistePanel extends HTMLElement {
  constructor() {
    super();
    this._built = false;
    this._narrow = false;
  }

  set hass(hass) {
    this._hass = hass;
    if (this._card) this._card.hass = hass;
  }

  set narrow(v) {
    this._narrow = !!v;
    if (this._menu) this._menu.style.display = this._narrow ? "" : "none";
  }

  set panel(p) {
    this._panel = p;
    this._load();
  }

  connectedCallback() {
    this._build();
    this._load();
  }

  _build() {
    if (this._built) return;
    this._built = true;
    this.style.cssText = "display:block;height:100%;background:var(--primary-background-color);overflow:auto;";
    const bar = document.createElement("div");
    bar.style.cssText = "display:flex;align-items:center;gap:8px;padding:8px 12px 0;";
    const menu = document.createElement("button");
    menu.textContent = "☰";
    menu.title = "Menü";
    menu.setAttribute("aria-label", "Menü");
    menu.style.cssText = "font-size:24px;background:none;border:none;color:var(--primary-text-color);cursor:pointer;padding:4px 8px;";
    menu.style.display = this._narrow ? "" : "none";
    menu.addEventListener("click", () => this.dispatchEvent(new Event("hass-toggle-menu", { bubbles: true, composed: true })));
    bar.appendChild(menu);
    this._menu = menu;
    const wrap = document.createElement("div");
    wrap.style.cssText = "max-width:900px;margin:0 auto;padding:8px 12px 24px;box-sizing:border-box;";
    this.append(bar, wrap);
    this._wrap = wrap;
  }

  async _load() {
    if (this._card || this._loading || !this._built) return;
    this._loading = true;
    try {
      if (!customElements.get("einkaufsliste-card")) {
        const url = this._panel?.config?.card_url || "/einkaufsliste_files/einkaufsliste-card.js";
        await import(url);
        await customElements.whenDefined("einkaufsliste-card");
      }
      const card = document.createElement("einkaufsliste-card");
      card.setConfig({ title: "Einkaufsliste" });
      this._card = card;
      this._wrap.appendChild(card);
      if (this._hass) card.hass = this._hass;
    } catch (err) {
      this._wrap.textContent = "Die Einkaufsliste konnte nicht geladen werden: " + (err && err.message ? err.message : err);
    } finally {
      this._loading = false;
    }
  }
}
if (!customElements.get("einkaufsliste-panel")) customElements.define("einkaufsliste-panel", EinkaufslistePanel);
