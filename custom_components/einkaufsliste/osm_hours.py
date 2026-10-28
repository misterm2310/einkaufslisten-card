"""Öffnungszeiten aus OpenStreetMap holen (nur auf Knopfdruck, über Home Assistant).

Die Karte schickt nie selbst etwas ins Internet: Home Assistant fragt auf Wunsch die
offene Overpass-Schnittstelle von OpenStreetMap (Geschäftsname + ungefährer Ort).
Die Zeiten stammen von Freiwilligen – ohne Gewähr. © OpenStreetMap-Mitwirkende (ODbL)."""

from __future__ import annotations

import asyncio
from math import asin, cos, radians, sin, sqrt
import logging
import re
from typing import Any

import aiohttp

from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .barcode import USER_AGENT, _check_privacy

_LOGGER = logging.getLogger(__name__)
# Der Hauptserver ist oft überlastet (Fehler 504): dann der Reihe nach die Ersatz-Server fragen
OVERPASS_SERVERS = (
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
)
_DAYS = {"Mo": 0, "Tu": 1, "We": 2, "Th": 3, "Fr": 4, "Sa": 5, "Su": 6}
_TIME = re.compile(r"^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$")


def _hhmm(h: int, m: int) -> str | None:
    if m > 59 or h > 24 or (h == 24 and m):
        return None
    if h == 24:
        return "23:59"
    return f"{h:02d}:{m:02d}"


def _days(spec: str) -> list[int] | None:
    """„Mo-Fr,Su“ -> [0..4, 6]; None = nicht lesbar."""
    out: list[int] = []
    for part in spec.split(","):
        part = part.strip()
        if "-" in part:
            a, _, b = part.partition("-")
            if a not in _DAYS or b not in _DAYS:
                return None
            i, j = _DAYS[a], _DAYS[b]
            out += list(range(i, j + 1)) if i <= j else list(range(i, 7)) + list(range(0, j + 1))
        elif part in _DAYS:
            out.append(_DAYS[part])
        else:
            return None
    return out


def parse_opening_hours(raw: str | None) -> list[Any] | None:
    """OSM-Text („Mo-Fr 07:00-13:00,14:30-18:00; Sa 07:00-13:00“) -> 7 Tage (Mo..So) oder None.

    Nur das Einfache wird gelesen. Alles andere (Wochen, Monate, Sonnenstand, Nachtschicht,
    Kommentare …) gibt None zurück – lieber nichts als etwas Falsches."""
    if not raw or not isinstance(raw, str):
        return None
    text = raw.strip()
    if text == "24/7":
        return [[["00:00", "23:59"]] for _ in range(7)]
    week: list[Any] = [None] * 7
    seen = False
    for chunk in text.split(";"):
        chunk = chunk.strip()
        if not chunk:
            continue
        # „Mo-Fr 08:00-12:00, Sa 09:00-12:00“: Regeln mit Komma getrennt
        for rule in re.split(r",\s*(?=(?:Mo|Tu|We|Th|Fr|Sa|Su|PH|SH)\b)", chunk):
            rule = rule.strip()
            if not rule:
                continue
            m = re.match(r"^((?:[A-Z][A-Za-z](?:-[A-Z][A-Za-z])?)(?:,[A-Z][A-Za-z](?:-[A-Z][A-Za-z])?)*)\s*(.*)$", rule)
            if m and m.group(1) in ("PH", "SH"):
                continue  # Feiertage regelt die Karte selbst
            if m and ("PH" in m.group(1).split(",") or "SH" in m.group(1).split(",")):
                return None
            if m:
                days = _days(m.group(1))
                rest = m.group(2).strip()
            else:  # nur Zeiten = jeden Tag
                days = list(range(7))
                rest = rule
            if days is None:
                return None
            if rest in ("off", "closed"):
                for d in days:
                    week[d] = None
                seen = True
                continue
            ranges: list[list[str]] = []
            for t in rest.split(","):
                tm = _TIME.match(t.strip())
                if not tm:
                    return None
                a = _hhmm(int(tm[1]), int(tm[2]))
                b = _hhmm(int(tm[3]), int(tm[4]))
                if not a or not b or b <= a:
                    return None
                ranges.append([a, b])
            ranges.sort()
            if any(y[0] < x[1] for x, y in zip(ranges, ranges[1:])):
                return None
            for d in days:
                week[d] = ranges
            seen = True
    return week if seen and any(week) else None


def _distance_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p = radians
    a = sin(p(lat2 - lat1) / 2) ** 2 + cos(p(lat1)) * cos(p(lat2)) * sin(p(lon2 - lon1) / 2) ** 2
    return 2 * 6371 * asin(sqrt(a))


def _regex_escape(name: str) -> str:
    return re.sub(r'([\\.^$|?*+()\[\]{}"])', r"\\\1", name)


def _short_place(tags: dict[str, Any]) -> str:
    return str(tags.get("addr:suburb") or tags.get("addr:city") or tags.get("addr:street") or tags.get("name") or "Filiale")[:40]


def _address(tags: dict[str, Any]) -> str:
    street = " ".join(x for x in (tags.get("addr:street"), tags.get("addr:housenumber")) if x)
    city = " ".join(x for x in (tags.get("addr:postcode"), tags.get("addr:city")) if x)
    return ", ".join(x for x in (street, city) if x)


def _osm_phone(tags: dict[str, Any]) -> str | None:
    raw = str(tags.get("phone") or tags.get("contact:phone") or "").split(";")[0].strip()
    return raw[:40] if raw and re.fullmatch(r"[0-9+\-/() ]+", raw) and re.search(r"\d", raw) else None


def _osm_website(tags: dict[str, Any]) -> str | None:
    raw = str(tags.get("website") or tags.get("contact:website") or "").split(";")[0].strip()
    if raw and not re.match(r"^https?://", raw, re.I):
        raw = "https://" + raw
    return raw[:300] if raw and re.match(r"^https?://[^/\s]+\S*$", raw, re.I) else None


async def async_search_hours(
    hass: HomeAssistant, manager: Any, name: str, zone: str | None = None, radius_km: int = 10
) -> list[dict[str, Any]]:
    """Geschäfte mit diesem Namen in der Nähe suchen (Mitte: Zone des Geschäfts, sonst Zuhause)."""
    _check_privacy(manager)
    name = (name or "").strip()[:60]
    if len(name) < 2:
        raise ValueError("Bitte einen Namen mit mindestens 2 Zeichen eingeben.")
    lat, lon = hass.config.latitude, hass.config.longitude
    if zone:
        st = hass.states.get(zone)
        try:
            lat, lon = float(st.attributes["latitude"]), float(st.attributes["longitude"])  # type: ignore[union-attr]
        except (AttributeError, KeyError, TypeError, ValueError):
            pass
    radius = max(1, min(int(radius_km), 30)) * 1000
    rx = _regex_escape(name)
    around = f"(around:{radius},{lat:.5f},{lon:.5f})"
    # leichte Abfrage: erst nach Schlüssel „shop“/„amenity“ filtern, dann nach dem Namen
    query = (
        f'[out:json][timeout:15];(nwr["shop"]["name"~"{rx}",i]{around};'
        f'nwr["amenity"]["name"~"{rx}",i]{around};);out center tags 40;'
    )
    session = async_get_clientsession(hass)
    data: Any = None
    last = "keine Antwort"
    for url in OVERPASS_SERVERS:
        try:
            async with asyncio.timeout(20):
                resp = await session.post(url, data={"data": query}, headers={"User-Agent": USER_AGENT})
                if resp.status != 200:
                    last = f"Fehler {resp.status}"
                    _LOGGER.debug("OpenStreetMap-Server %s antwortet mit %s", url, resp.status)
                    continue
                data = await resp.json(content_type=None)
                break
        except (TimeoutError, aiohttp.ClientError, ValueError) as err:
            last = "nicht erreichbar"
            _LOGGER.debug("OpenStreetMap-Server %s nicht erreichbar: %s", url, err)
    if data is None:
        raise ValueError(f"OpenStreetMap ist gerade überlastet oder nicht erreichbar ({last}). Bitte in ein paar Minuten nochmal versuchen.")
    out: list[dict[str, Any]] = []
    for el in (data.get("elements") if isinstance(data, dict) else None) or []:
        tags = el.get("tags") if isinstance(el, dict) else None
        if not isinstance(tags, dict) or not tags.get("name"):
            continue
        c = el.get("center") or el
        try:
            dist = _distance_km(lat, lon, float(c["lat"]), float(c["lon"]))
        except (KeyError, TypeError, ValueError):
            dist = None
        raw = tags.get("opening_hours")
        hours = parse_opening_hours(raw)
        out.append(
            {
                "name": str(tags["name"])[:60],
                "place": _short_place(tags),
                "address": _address(tags),
                "distance_km": round(dist, 1) if dist is not None else None,
                "raw": str(raw)[:200] if raw else None,
                "hours": hours,
                "phone": _osm_phone(tags),  # ℹ️ für den Steckbrief gleich mit
                "website": _osm_website(tags),
            }
        )
    out.sort(key=lambda r: (r["distance_km"] is None, r["distance_km"] or 0))
    return out[:15]
