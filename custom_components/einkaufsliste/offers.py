"""🏷️ Angebote aus Prospekten (Marktguru) – inoffiziell, standardmäßig aus.

Marktguru hat keine offene Schnittstelle für Entwickler. Die Webseite marktguru.de lädt ihre Angebote
aber selbst über eine Schnittstelle – mit einem Schlüssel, den jeder Browser beim Öffnen der Seite
bekommt. Genau so holen wir ihn uns: Seite öffnen, Schlüssel suchen, testen. Im Code steht KEIN Schlüssel.

Ehrlich: Das kann jederzeit aufhören zu funktionieren (Webseite geändert, Zugang gesperrt).
Dann zeigt ⚙️ „Angebote gerade nicht verfügbar“ – die Einkaufsliste selbst läuft einfach weiter.
"""

from __future__ import annotations

import asyncio
import logging
import re
from datetime import timedelta
from typing import Any

import aiohttp

from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.event import async_call_later, async_track_time_interval
from homeassistant.util import dt as dt_util

_LOGGER = logging.getLogger(__name__)

INTERVALS = (3, 6, 12, 24)  # Stunden zwischen zwei Abfragen
MAX_ITEMS = 40  # höchstens so viele offene Artikel pro Durchgang
MAX_OFFERS = 5  # pro Artikel
MAX_ALT = 4  # 🔀 „Andere Marke“-Treffer pro Artikel (gleicher Typ, wenn es für den genauen Artikel nichts gibt)
MAX_TYPE_LOOKUPS = 10  # so viele Produkttypen pro Durchgang aus der Datenbank holen
MAX_SCRIPTS = 20
_BROWSER = {
    "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36",
    "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": "de-DE,de;q=0.9",
}
_SCRIPT = re.compile(r"<script[^>]+src=[\"']([^\"']+)[\"']", re.I)
_KEY_PATTERNS = (
    re.compile(r"x-apikey\s*['\"]?\s*[:=]\s*['\"]([^'\"]{10,})['\"]", re.I),
    re.compile(r"apiKey\s*[:=]\s*['\"]([^'\"]{10,})['\"]", re.I),
    re.compile(r"[A-Za-z0-9+/]{40,60}={1,2}"),
)


def domain(country: str | None) -> str:
    """marktguru.at für Österreich, sonst marktguru.de."""
    return "at" if str(country or "").upper() == "AT" else "de"


def key_candidates(text: str) -> list[str]:
    """Mögliche Schlüssel in einem Stück Webseite / Skript."""
    found: list[str] = []
    for rx in _KEY_PATTERNS:
        for m in rx.finditer(text or ""):
            val = m.group(1) if rx.groups else m.group(0)
            if val not in found:
                found.append(val)
    return found


def _norm(text: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^\wäöüß ]", " ", str(text or "").lower())).strip()


def matches(item_name: str, offer: dict[str, Any]) -> bool:
    """Passt das Angebot wirklich zum Artikel? (Marktguru sucht sehr großzügig – „Milch“ findet auch Milchschnitte-Deko)"""
    want = _norm(item_name)
    if not want:
        return False
    hay = _norm(" ".join(str(x or "") for x in (
        (offer.get("product") or {}).get("name"), offer.get("description"), (offer.get("brand") or {}).get("name"))))
    tokens = hay.split()
    words = [w for w in want.split() if len(w) >= 3] or want.split()

    def hit(w: str) -> bool:
        # Deutsch: das Hauptwort steht hinten („Marken-butter“, „Voll-milch“) – „Milch-schnitte“ ist keine Milch.
        # Einzahl/Mehrzahl dürfen etwas abweichen („Tomaten“ ↔ „Rispentomate“, „Ei“ ↔ „Eier“).
        stems = {w}
        for cut in ("en", "n", "e", "s", "er"):
            if w.endswith(cut) and len(w) - len(cut) >= 4:
                stems.add(w[: -len(cut)])
        return any(t == w or any(t.endswith(st) or t[:-1].endswith(st) or t[:-2].endswith(st) for st in stems) for t in tokens)

    return all(hit(w) for w in words)


def slim(offer: dict[str, Any], dom: str) -> dict[str, Any] | None:
    """Nur das, was die Karte braucht: Händler, Preis, alter Preis, gültig von/bis, Beschreibung, Bild."""
    try:
        price = float(offer.get("price"))
    except (TypeError, ValueError):
        return None
    adv = offer.get("advertisers") or []
    retailer = (adv[0] or {}).get("name") if adv and isinstance(adv[0], dict) else None
    dates = (offer.get("validityDates") or [{}])[0] or {}
    old = offer.get("oldPrice")
    unit = (offer.get("unit") or {}).get("shortName") if isinstance(offer.get("unit"), dict) else None
    oid = offer.get("id")
    return {
        "id": oid,
        "r": retailer or "?",
        "p": round(price, 2),
        "op": round(float(old), 2) if isinstance(old, (int, float)) and old > price else None,
        "from": dates.get("from"),
        "to": dates.get("to"),
        "d": " ".join(x for x in ((offer.get("brand") or {}).get("name"), (offer.get("product") or {}).get("name")) if x)
        or offer.get("description") or "",
        "q": " ".join(str(x) for x in (offer.get("volume"), unit) if x) or None,
        "img": f"https://cdn.marktguru.{dom}/api/v1/offers/{oid}/images/default/0/medium.webp" if oid else None,
    }


class Offers:
    """Holt regelmäßig Angebote zu den offenen Artikeln."""

    def __init__(self, hass: HomeAssistant, manager: Any) -> None:
        self.hass = hass
        self.manager = manager
        self._unsub = None
        self._first = None
        self._busy = False

    @callback
    def start(self) -> None:
        self.stop()
        cfg = self.manager.offers_cfg
        if not cfg or not cfg.get("enabled"):
            return
        self._unsub = async_track_time_interval(self.hass, self._tick, timedelta(minutes=30))
        self._first = async_call_later(self.hass, 90, self._tick)  # nach dem Start kurz Luft lassen

    @callback
    def stop(self) -> None:
        for attr in ("_unsub", "_first"):
            fn = getattr(self, attr)
            if fn:
                fn()
                setattr(self, attr, None)

    @callback
    def _tick(self, _now: Any = None) -> None:
        self._first = None
        cfg = self.manager.offers_cfg or {}
        last = cfg.get("last")
        hours = cfg.get("hours", 6)
        if last and dt_util.utcnow() - dt_util.parse_datetime(last) < timedelta(hours=hours):
            return
        self.hass.async_create_task(self.run())

    async def _get(self, session: aiohttp.ClientSession, url: str, **kw: Any) -> aiohttp.ClientResponse:
        async with asyncio.timeout(15):
            resp = await session.get(url, **kw)
            await resp.read()
            return resp

    async def _find_key(self, session: aiohttp.ClientSession, dom: str) -> str | None:
        """🔑 Den Schlüssel so holen, wie ihn jeder Browser bekommt: Seite öffnen, Skripte durchsehen, testen."""
        base = f"https://www.marktguru.{dom}"
        html = ""
        for path in ("/", "/suche?q=milch", "/search?q=milch"):
            try:
                resp = await self._get(session, base + path, headers=_BROWSER)
                if resp.status == 200:
                    html = await resp.text()
                    break
            except (TimeoutError, aiohttp.ClientError):
                continue
        if not html:
            return None
        cands = key_candidates(html)
        for src in _SCRIPT.findall(html)[:MAX_SCRIPTS]:
            url = "https:" + src if src.startswith("//") else base + src if src.startswith("/") else src
            if not url.startswith(("https://www.marktguru.", "https://static.marktguru.", "https://cdn.marktguru.", base)):
                continue
            try:
                resp = await self._get(session, url, headers=_BROWSER)
                if resp.status == 200:
                    cands += [c for c in key_candidates(await resp.text()) if c not in cands]
            except (TimeoutError, aiohttp.ClientError):
                continue
        for cand in cands[:30]:
            if await self._search(session, dom, cand, "milch", "10115" if dom == "de" else "1010", 1) is not None:
                return cand
        return None

    async def _search(self, session: aiohttp.ClientSession, dom: str, key: str, query: str, zip_code: str,
                      limit: int = 20) -> list[dict[str, Any]] | None:
        url = f"https://api.marktguru.{dom}/api/v1/offers/search"
        params = {"as": "web", "q": query, "limit": str(limit), "offset": "0", "zipCode": zip_code}
        try:
            async with asyncio.timeout(15):
                resp = await session.get(url, params=params, headers={"x-apikey": key, "accept": "application/json"})
                if resp.status != 200:
                    return None
                data = await resp.json(content_type=None)
        except (TimeoutError, aiohttp.ClientError, ValueError):
            return None
        return list((data or {}).get("results") or [])

    async def search(self, query: str) -> list[dict[str, Any]]:
        """🔎 Angebote zu einem beliebigen Produkt (beim Tippen „🏷️ Angebote für … anzeigen“)."""
        cfg = self.manager.offers_cfg
        query = str(query or "").strip()[:60]
        if not cfg or not cfg.get("enabled") or len(query) < 2:
            return []
        dom = domain(getattr(self.hass.config, "country", None))
        session = async_get_clientsession(self.hass)
        key = cfg.get("key")
        results = await self._search(session, dom, key, query, cfg["zip"], 30) if key else None
        if results is None:  # Schlüssel neu holen und nochmal
            key = cfg["key"] = await self._find_key(session, dom)
            results = await self._search(session, dom, key, query, cfg["zip"], 30) if key else None
        if results is None:
            raise ValueError("Marktguru ist gerade nicht erreichbar oder hat etwas geändert.")
        now = dt_util.utcnow()
        wanted = [s["name"].strip().lower() for s in self.manager.stores if s["id"] in (cfg.get("stores") or [])]
        out = []
        for raw in results:
            if not matches(query, raw):
                continue
            o = slim(raw, dom)
            if not o or (wanted and not any(w in o["r"].lower() or o["r"].lower() in w for w in wanted)):
                continue
            to = dt_util.parse_datetime(o["to"]) if o.get("to") else None
            if to and to < now:
                continue
            out.append(o)
        out.sort(key=lambda o: o["p"])
        return out[:20]

    async def run(self, force: bool = False) -> dict[str, Any]:
        """Einmal alle offenen Artikel nachschlagen. Gibt den Stand zurück."""
        cfg = self.manager.offers_cfg
        if not cfg or not cfg.get("enabled") or self._busy:
            return {"ok": False}
        self._busy = True
        try:
            return await self._run(cfg)
        finally:
            self._busy = False

    async def _type_of(self, item: dict[str, Any] | None, name: str, lookups: list[int]) -> str | None:
        """Produkttyp eines Barcode-Artikels (gemerkt am Barcode; fehlt er, einmal aus der Datenbank holen)."""
        from .barcode import async_product_type
        from .manager import product_key

        if not item:
            return None
        m = self.manager
        codes = m.barcodes_for(product_key(item["name"], item.get("note")))
        if not codes:
            return None
        bc = m.barcodes[codes[0]]
        if "type" in bc:
            return bc["type"] or None
        if lookups[0] >= MAX_TYPE_LOOKUPS:
            return None
        lookups[0] += 1
        got = await async_product_type(self.hass, codes[0], name)
        if got is False:  # Datenbank nicht erreichbar: nächstes Mal wieder versuchen
            return None
        bc["type"] = got or ""
        m._schedule_save()
        return got or None

    async def _alt_offers(self, session: aiohttp.ClientSession, dom: str, key: str, cfg: dict[str, Any],
                          item: dict[str, Any] | None, name: str, wanted_stores: list[str], now: Any,
                          lookups: list[int]) -> list[dict[str, Any]]:
        typ = await self._type_of(item, name, lookups)
        if not typ or _norm(typ) == _norm(name):
            return []
        await asyncio.sleep(1)
        results = await self._search(session, dom, key, typ, cfg["zip"])
        out: list[dict[str, Any]] = []
        for raw in results or []:
            if not matches(typ, raw):
                continue
            o = slim(raw, dom)
            if not o:
                continue
            if wanted_stores and not any(w in o["r"].lower() or o["r"].lower() in w for w in wanted_stores):
                continue
            to = dt_util.parse_datetime(o["to"]) if o.get("to") else None
            if to and to < now:
                continue
            o["alt"] = typ
            out.append(o)
        out.sort(key=lambda o: o["p"])
        return out[:MAX_ALT]

    async def _run(self, cfg: dict[str, Any]) -> dict[str, Any]:
        m = self.manager
        dom = domain(getattr(self.hass.config, "country", None))
        session = async_get_clientsession(self.hass)
        key = cfg.get("key")
        if not key or await self._search(session, dom, key, "milch", cfg["zip"], 1) is None:
            key = await self._find_key(session, dom)
            cfg["key"] = key
        now = dt_util.utcnow()
        cfg["last"] = now.isoformat()
        if not key:
            cfg["ok"] = False
            cfg["error"] = "Marktguru ist gerade nicht erreichbar oder hat etwas geändert."
            m._changed()
            return {"ok": False}
        names: list[str] = []
        first: dict[str, dict[str, Any]] = {}
        for item in m.items:
            if not item["checked"] and item["name"].lower() not in (n.lower() for n in names):
                names.append(item["name"])
                first[item["name"].lower()] = item
        wanted_stores = [s["name"].strip().lower() for s in m.stores if s["id"] in (cfg.get("stores") or [])]
        found: dict[str, list[dict[str, Any]]] = {}
        lookups = [0]
        for name in names[:MAX_ITEMS]:
            results = await self._search(session, dom, key, name, cfg["zip"])
            if results is None:
                continue
            offers = []
            for raw in results:
                if not matches(name, raw):
                    continue
                o = slim(raw, dom)
                if not o:
                    continue
                if wanted_stores and not any(w in o["r"].lower() or o["r"].lower() in w for w in wanted_stores):
                    continue
                to = dt_util.parse_datetime(o["to"]) if o.get("to") else None
                if to and to < now:
                    continue
                offers.append(o)
            if offers:
                offers.sort(key=lambda o: o["p"])
                found[name.lower()] = offers[:MAX_OFFERS]
            else:  # 🔀 nichts für genau diesen Artikel: Angebote für den Typ („Proteinriegel“), andere Marke
                alt = await self._alt_offers(session, dom, key, cfg, first.get(name.lower()), name, wanted_stores, now, lookups)
                if alt:
                    found[name.lower()] = alt
            await asyncio.sleep(1)  # sparsam: eine Anfrage pro Sekunde
        m.offers_data = found
        cfg["ok"] = True
        cfg["error"] = None
        cfg["count"] = sum(len(v) for v in found.values())
        m._changed()
        return {"ok": True, "items": len(found), "offers": cfg["count"]}

