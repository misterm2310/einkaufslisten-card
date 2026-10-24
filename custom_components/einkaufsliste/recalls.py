"""⚠️ Rückruf-Warnung: offizielle Warnungen von lebensmittelwarnung.de gegen eure Einkäufe prüfen.

lebensmittelwarnung.de (Bund und Länder) veröffentlicht jede Warnung in einem offenen RSS-Feed.
Wir holen den Feed alle paar Stunden und schauen, ob ein Produkt aus der Warnung zu etwas passt,
das ihr in den letzten Wochen abgehakt (= gekauft) habt. Passt etwas, kommt eine Meldung in
Home Assistant und das Ereignis „einkaufsliste_rueckruf“ für eigene Automationen.

Ehrlich: Der Abgleich geht über den Namen. „Kaffee“ passt auf jede Kaffee-Warnung – die Meldung
heißt deshalb „bitte prüfen“, nicht „betroffen“. Marke, Charge und MHD stehen im Link.
Standardmäßig aus. Mit 🔒 Datenschutz wird nichts abgefragt.
"""

from __future__ import annotations

import asyncio
import html
import logging
import re
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta
from email.utils import parsedate_to_datetime
from typing import Any

import aiohttp

from homeassistant.components import persistent_notification
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.event import async_call_later, async_track_time_interval
from homeassistant.util import dt as dt_util

from .const import EVENT_RECALL, VERSION
from .netutil import cancel_tasks, read_limited, track_task
from .offers import _norm, _word_hit, name_words

_LOGGER = logging.getLogger(__name__)

FEED_URL = "https://www.lebensmittelwarnung.de/___LMW-Redaktion/RSSNewsfeed/Functions/RssFeeds/rssnewsfeed_Alle_DE.xml?nn=314268"
USER_AGENT = f"HomeAssistant-Einkaufsliste/{VERSION} (github.com/misterm2310/einkaufslisten-card)"
HOURS = 6  # so oft wird nachgeschaut
BOUGHT_DAYS = 30  # Einkäufe der letzten 30 Tage zählen
WARN_DAYS = 60  # ältere Warnungen interessieren nicht mehr
MAX_FEED = 3 * 1024 * 1024
MAX_HITS = 20  # so viele Treffer merkt sich die Liste
MAX_SEEN = 300  # schon gemeldete Warnungen (gegen doppelte Meldungen)
NOTIFY_ID = "einkaufsliste_rueckruf"


def _plain(text: str | None) -> str:
    """HTML aus der Beschreibung entfernen: <br> = Zeilenumbruch, Rest weg, Leerzeichen aufräumen."""
    text = re.sub(r"<br\s*/?>", "\n", str(text or ""), flags=re.I)
    text = html.unescape(re.sub(r"<[^>]+>", " ", text))
    return "\n".join(re.sub(r"[ \t]+", " ", line).strip() for line in text.split("\n") if line.strip())


def parse_feed(raw: str | bytes) -> list[dict[str, Any]]:
    """RSS lesen: [{"id", "title", "link", "date", "text"}] – kaputte Einträge werden übersprungen."""
    if isinstance(raw, bytes):
        raw = raw.decode("utf-8", errors="replace")
    if "<!DOCTYPE" in raw[:2000].upper() or "<!ENTITY" in raw.upper():  # 🛡️ keine eigenen XML-Entitäten
        raise ValueError("Unerwartetes Format")
    root = ET.fromstring(raw)
    out: list[dict[str, Any]] = []
    for item in root.iter("item"):
        title = (item.findtext("title") or "").strip()
        link = (item.findtext("link") or "").strip()
        if not title or not link.startswith("https://www.lebensmittelwarnung.de/"):
            continue
        date = None
        try:
            date = parsedate_to_datetime(item.findtext("pubDate") or "")
        except (TypeError, ValueError):
            pass
        out.append({
            "id": (item.findtext("guid") or link).strip(),
            "title": title[:200],
            "link": link,
            "date": date.isoformat() if date else None,
            "text": _plain(item.findtext("description"))[:2000],
        })
    return out


def match(name: str, warning: dict[str, Any]) -> bool:
    """Passt ein gekaufter Artikel zur Warnung? Alle tauglichen Wörter des Namens müssen im Titel stehen."""
    words = name_words(name)
    if not words:
        return False
    tokens = _norm(warning.get("title")).split()
    return all(_word_hit(w, tokens) for w in words)


def recent_names(items: list[dict[str, Any]], now: datetime, days: int = BOUGHT_DAYS) -> list[str]:
    """Namen der Artikel, die in den letzten `days` Tagen abgehakt wurden (ohne Doppelte)."""
    since = now - timedelta(days=days)
    names: dict[str, str] = {}
    for item in items:
        when = dt_util.parse_datetime(str(item.get("checked_at") or "")) if item.get("checked") else None
        if when is not None and when >= since and not item.get("removed"):
            names.setdefault(item["name"].lower(), item["name"])
    return list(names.values())


class Recalls:
    """Schaut regelmäßig nach neuen Warnungen und gleicht sie mit den Einkäufen ab."""

    def __init__(self, hass: HomeAssistant, manager: Any) -> None:
        self.hass = hass
        self.manager = manager
        self._unsub = None
        self._first = None
        self._busy = False
        self._tasks: set[asyncio.Task] = set()

    @callback
    def start(self) -> None:
        self.stop()
        if not (self.manager.recalls_cfg or {}).get("enabled"):
            return
        self._unsub = async_track_time_interval(self.hass, self._tick, timedelta(minutes=30))
        self._first = async_call_later(self.hass, 120, self._tick)  # nach dem Start kurz Luft lassen

    @callback
    def stop(self) -> None:
        cancel_tasks(self._tasks)
        for attr in ("_unsub", "_first"):
            fn = getattr(self, attr)
            if fn:
                fn()
                setattr(self, attr, None)

    @callback
    def _tick(self, _now: Any = None) -> None:
        self._first = None
        last = (self.manager.recalls_cfg or {}).get("last")
        last_dt = dt_util.parse_datetime(last) if isinstance(last, str) else None
        if last_dt is not None and dt_util.utcnow() - last_dt < timedelta(hours=HOURS):
            return
        track_task(self.hass, self._tasks, self.run())

    async def _fetch(self) -> bytes:
        session = async_get_clientsession(self.hass)
        async with asyncio.timeout(30):
            resp = await session.get(FEED_URL, headers={"User-Agent": USER_AGENT})
            if resp.status != 200:
                raise ValueError(f"lebensmittelwarnung.de antwortet mit {resp.status}")
            raw = await read_limited(resp.content, MAX_FEED)
        if raw is None:
            raise ValueError("Der Feed ist ungewöhnlich groß")
        return raw

    async def run(self, force: bool = False) -> dict[str, Any]:
        """Einmal prüfen. Gibt den Stand für die Karte zurück."""
        cfg = self.manager.recalls_cfg
        if not cfg or not cfg.get("enabled") or self._busy or self.manager.privacy:  # 🔒 Datenschutz: nichts abfragen
            return self.manager.recalls_info() or {"enabled": False}
        self._busy = True
        try:
            try:
                warnings = parse_feed(await self._fetch())
            except (TimeoutError, aiohttp.ClientError, ValueError, ET.ParseError) as err:
                _LOGGER.info("Rückruf-Warnungen gerade nicht abrufbar: %s", err)
                self.manager.recalls_result(ok=False, error=str(err) or type(err).__name__)
                return self.manager.recalls_info()
            return self.check(warnings)
        finally:
            self._busy = False

    @callback
    def check(self, warnings: list[dict[str, Any]], now: datetime | None = None) -> dict[str, Any]:
        """Warnungen mit den Einkäufen abgleichen; Neues melden. (Ohne Netz – auch für die Tests.)"""
        now = now or dt_util.utcnow()
        names = recent_names(self.manager.items, now)
        seen = set(self.manager.recalls_seen)
        new_hits: list[dict[str, Any]] = []
        for w in warnings:
            when = dt_util.parse_datetime(w["date"]) if w.get("date") else None
            if when is not None and now - when > timedelta(days=WARN_DAYS):
                continue
            products = [n for n in names if match(n, w)]
            if products and w["id"] not in seen:
                new_hits.append({**{k: w[k] for k in ("id", "title", "link", "date")}, "products": products,
                                 "found": now.isoformat()})
        for hit in new_hits:
            self.hass.bus.async_fire(EVENT_RECALL, {k: hit[k] for k in ("title", "link", "date", "products")})
        if new_hits:
            lines = [f"- **{', '.join(h['products'])}** → [{h['title']}]({h['link']})" for h in new_hits]
            persistent_notification.async_create(
                self.hass,
                "Zu diesen Einkäufen der letzten Wochen gibt es eine offizielle Warnung. "
                "Bitte Marke, Charge und Haltbarkeit im Link prüfen:\n\n" + "\n".join(lines),
                title="⚠️ Einkaufsliste: Rückruf prüfen",
                notification_id=NOTIFY_ID,
            )
        self.manager.recalls_result(ok=True, hits=new_hits, checked=len(warnings))
        return self.manager.recalls_info()
