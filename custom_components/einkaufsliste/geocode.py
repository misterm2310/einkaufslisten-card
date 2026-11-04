"""📍 Adresse -> GPS-Punkt (über OpenStreetMap/Nominatim, nur die Adresse des Geschäfts geht raus).

Damit erkennt die Einkaufsliste ein Geschäft auch ohne eigene Zone in Home Assistant:
Ist jemand nah genug am Punkt, zählt das wie „in der Zone“. Gefragt wird nur einmal pro Adresse,
das Ergebnis merkt sich die Integration. Bei Datenschutz an wird nichts gefragt.
© OpenStreetMap-Mitwirkende (ODbL)."""

from __future__ import annotations

import asyncio
import logging
from typing import Any

import aiohttp

from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .barcode import USER_AGENT

_LOGGER = logging.getLogger(__name__)
NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"


def geo_key(address: str | None, country: str | None) -> str | None:
    """Merkzettel-Schlüssel: „DE|hauptstr. 1, 48565 steinfurt“ (gleiche Adresse = einmal fragen)."""
    addr = " ".join(str(address or "").split()).lower()
    if len(addr) < 4:
        return None
    return f"{(country or '').upper()}|{addr}"


async def async_geocode(hass: HomeAssistant, address: str, country: str | None) -> list[float] | None:
    """[lat, lon] oder None (nicht gefunden). Wirft ConnectionError, wenn der Dienst nicht erreichbar ist."""
    params: dict[str, Any] = {"q": address, "format": "jsonv2", "limit": "1", "addressdetails": "0"}
    if country:
        params["countrycodes"] = country.lower()
    session = async_get_clientsession(hass)
    try:
        async with asyncio.timeout(15):
            resp = await session.get(NOMINATIM_URL, params=params, headers={"User-Agent": USER_AGENT, "Accept-Language": "de"})
            if resp.status != 200:
                raise ConnectionError(f"Fehler {resp.status}")
            data = await resp.json(content_type=None)
    except (TimeoutError, aiohttp.ClientError, ValueError) as err:
        raise ConnectionError(str(err) or "nicht erreichbar") from err
    if not isinstance(data, list) or not data:
        return None
    try:
        return [round(float(data[0]["lat"]), 6), round(float(data[0]["lon"]), 6)]
    except (KeyError, TypeError, ValueError):
        return None
