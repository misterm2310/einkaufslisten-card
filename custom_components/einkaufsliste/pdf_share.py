"""📄 Einkaufsliste als PDF kurz bereitstellen.

Die HA-App auf iPhone/iPad kann aus der Karte weder drucken noch Dateien teilen. Darum baut die
Karte die PDF selbst, schickt sie hierher und die App öffnet einen Link darauf im Browser des Handys
(dort: Teilen → Drucken / In Dateien sichern). Der Link ist zufällig, gilt 10 Minuten und verrät nichts.
"""

from __future__ import annotations

import base64
import binascii
import re
import secrets
import time
from http import HTTPStatus
from typing import Any

from aiohttp import web

from homeassistant.components.http import HomeAssistantView
from homeassistant.core import HomeAssistant

from .const import DOMAIN

PDF_TTL = 600  # Sekunden, so lange gilt ein Link
PDF_MAX = 5 * 1024 * 1024  # 5 MB – eine Einkaufsliste hat meist nur ein paar KB
PDF_KEEP = 5  # höchstens so viele Dateien gleichzeitig im Speicher
_TOKEN = re.compile(r"[A-Za-z0-9_-]{20,64}")


def _store(hass: HomeAssistant) -> dict[str, dict[str, Any]]:
    return hass.data.setdefault(DOMAIN, {}).setdefault("pdf_files", {})


def _clean_name(name: Any) -> str:
    """Dateiname nur aus einfachen Zeichen (steht im Link und im Kopf der Antwort)."""
    text = str(name or "")
    for a, b in (("ä", "ae"), ("ö", "oe"), ("ü", "ue"), ("Ä", "Ae"), ("Ö", "Oe"), ("Ü", "Ue"), ("ß", "ss")):
        text = text.replace(a, b)
    text = re.sub(r"[^A-Za-z0-9.-]+", "-", text).strip("-.")
    text = re.sub(r"\.pdf$", "", text, flags=re.IGNORECASE)[:60].strip("-.") or "Einkaufsliste"
    return f"{text}.pdf"


def store_pdf(hass: HomeAssistant, data: str, name: Any = None, now: float | None = None) -> dict[str, str]:
    """PDF (Base64) merken und den Link darauf zurückgeben."""
    try:
        raw = base64.b64decode(data, validate=True)
    except (binascii.Error, ValueError) as err:
        raise ValueError("Die PDF ist kaputt angekommen.") from err
    if len(raw) > PDF_MAX:
        raise ValueError("Die PDF ist zu groß.")
    if not raw.startswith(b"%PDF-"):
        raise ValueError("Das ist keine PDF.")
    now = time.time() if now is None else now
    files = _store(hass)
    for key in [k for k, v in files.items() if v["until"] < now]:  # Abgelaufenes wegräumen
        files.pop(key, None)
    while len(files) >= PDF_KEEP:  # die älteste fliegt raus
        files.pop(min(files, key=lambda k: files[k]["until"]), None)
    token = secrets.token_urlsafe(24)
    fname = _clean_name(name)
    files[token] = {"data": raw, "until": now + PDF_TTL, "name": fname}
    return {"url": f"/api/einkaufsliste/pdf/{token}/{fname}"}


def get_pdf(hass: HomeAssistant, token: str, now: float | None = None) -> dict[str, Any] | None:
    if not _TOKEN.fullmatch(token or ""):
        return None
    entry = _store(hass).get(token)
    if entry is None or entry["until"] < (time.time() if now is None else now):
        return None
    return entry


class PdfView(HomeAssistantView):
    """GET = die PDF zum Link (ohne Anmeldung: der Browser des Handys hat keine; der zufällige Link ist der Schlüssel)."""

    url = "/api/einkaufsliste/pdf/{token}/{name}"
    name = "api:einkaufsliste:pdf"
    requires_auth = False

    async def get(self, request: web.Request, token: str, name: str) -> web.Response:
        entry = get_pdf(request.app["hass"], token)
        if entry is None:
            return web.Response(status=HTTPStatus.NOT_FOUND, text="Der Link ist abgelaufen – bitte in der Karte neu auf „PDF“ tippen.")
        return web.Response(body=entry["data"], content_type="application/pdf", headers={
            "Content-Disposition": f'inline; filename="{entry["name"]}"',
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "no-referrer",
        })
