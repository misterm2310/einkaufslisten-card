"""🎫 Gast-Link: die Einkaufsliste für Nachbarn oder Babysitter – ohne Home-Assistant-Konto.

So funktioniert's (für Doofe):
* Ein Admin erstellt in der Karte (⚙️ → App & Info → Gast-Link) einen Link mit PIN. Der Link gilt höchstens 24 Stunden.
* Der Gast öffnet den Link, tippt die PIN ein und sieht NUR die offenen Artikel (Name, Menge, Notiz) – und kann sie abhaken.
* Sonst nichts: keine Einstellungen, keine Rezepte, keine Personen, kein Home Assistant. Der Gast bekommt keine
  Anmeldung bei Home Assistant, sondern spricht nur mit genau einer Adresse dieser Integration.

Sicherheit:
* Der Schlüssel steht hinter dem „#“ im Link. Dieser Teil wird vom Browser nie mitgeschickt – er landet in keinem
  Server-Protokoll und in keinem Proxy-Log. Gespeichert wird er nur als Prüfsumme (SHA-256), die PIN mit PBKDF2.
* Falscher Schlüssel oder falsche PIN zählen wie eine falsche Anmeldung bei Home Assistant (IP-Sperre, wenn eingeschaltet).
  Zusätzlich: nach 5 falschen PINs 15 Minuten Pause, nach 25 ist der Link ganz gesperrt.
* Ablaufzeit, „Jetzt sperren“-Knopf und ein neuer Link machen den alten sofort ungültig.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import re
import secrets
import time
from datetime import timedelta
from http import HTTPStatus
from pathlib import Path
from typing import TYPE_CHECKING, Any

from aiohttp import web

from homeassistant.components.http import HomeAssistantView
from homeassistant.components.http.ban import process_wrong_login
from homeassistant.util import dt as dt_util

from .const import DOMAIN

if TYPE_CHECKING:
    from .manager import EinkaufslisteManager

GUEST_URL = "/einkaufsliste/gast/"
GUEST_API = "/api/einkaufsliste/gast"
GUEST_HOURS = (2, 6, 12, 24)  # zur Auswahl – mehr als 24 Stunden gibt es absichtlich nicht
GUEST_NAME = "Gast"
PBKDF2_ROUNDS = 120_000
FAILS_PAUSE = 5  # so viele falsche PINs hintereinander …
PAUSE_SECONDS = 900  # … dann 15 Minuten Pause
FAILS_REVOKE = 25  # so viele insgesamt: Link ist ganz gesperrt
MAX_SESSIONS = 8  # so viele Geräte gleichzeitig (älteste fliegt raus)
MAX_BODY = 2048
_TOKEN = re.compile(r"[A-Za-z0-9_-]{30,64}")
_PIN = re.compile(r"\d{4,8}")
_ID = re.compile(r"[A-Za-z0-9_-]{1,64}")

GUEST_DIR = Path(__file__).parent / "www" / "guest"
_FILES = {"": "index.html", "index.html": "index.html", "gast.js": "gast.js"}
_TYPES = {"index.html": "text/html", "gast.js": "text/javascript"}
_CSP = ("default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; "
        "img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
_HEADERS = {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "X-Robots-Tag": "noindex, nofollow",
}


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _pin_hash(pin: str, salt: str) -> str:
    return hashlib.pbkdf2_hmac("sha256", pin.encode(), bytes.fromhex(salt), PBKDF2_ROUNDS).hex()


def _rt(m: EinkaufslisteManager) -> dict[str, Any]:
    """Laufzeit-Zustand (nur im Speicher): offene Sitzungen und Fehlversuche."""
    rt = getattr(m, "_guest_rt", None)
    if rt is None:
        rt = m._guest_rt = {"sessions": {}, "fails": 0, "pause": 0.0, "total": 0}
    return rt


def _reset_rt(m: EinkaufslisteManager) -> None:
    m._guest_rt = {"sessions": {}, "fails": 0, "pause": 0.0, "total": 0}


def active(m: EinkaufslisteManager) -> dict[str, Any] | None:
    """Der gültige Gast-Link – abgelaufene werden dabei weggeräumt."""
    g = m.guest
    if not g:
        return None
    until = dt_util.parse_datetime(str(g.get("until") or ""))
    if until is None or until <= dt_util.utcnow():
        m.guest = None
        _reset_rt(m)
        m._changed()
        return None
    return g


def info(m: EinkaufslisteManager) -> dict[str, Any] | None:
    """Für die Karte: läuft ein Gast-Link, bis wann, für welches Geschäft? (nie Schlüssel oder PIN)"""
    g = m.guest
    if not g:
        return None
    until = dt_util.parse_datetime(str(g.get("until") or ""))
    if until is None or until <= dt_util.utcnow():
        return None
    return {"until": g.get("until"), "store_id": g.get("store_id"), "by": g.get("by"), "created": g.get("created")}


async def async_create(m: EinkaufslisteManager, pin: str, hours: int, store_id: str | None, by: str | None) -> dict[str, Any]:
    """Neuen Gast-Link anlegen. Ein alter Link ist damit sofort ungültig. Der Schlüssel kommt nur EINMAL zurück."""
    pin = str(pin or "").strip()
    if not _PIN.fullmatch(pin):
        raise ValueError("Die Gast-PIN muss aus 4 bis 8 Ziffern bestehen.")
    if m.pin_hash and hmac.compare_digest(m._pin_hash(pin, m.pin_hash.split("$", 1)[0]), m.pin_hash):  # (ohne Fehlversuch-Zähler)
        raise ValueError("Bitte nicht die PIN der Einstellungen nehmen – der Gast bekommt eine eigene.")
    if hours not in GUEST_HOURS:
        raise ValueError("So lange geht ein Gast-Link nicht (höchstens 24 Stunden).")
    if store_id and m.store_by_id(store_id) is None:
        raise ValueError("Dieses Geschäft gibt es nicht (mehr).")
    token = secrets.token_urlsafe(32)
    salt = secrets.token_hex(16)
    ph = await m.hass.async_add_executor_job(_pin_hash, pin, salt)
    now = dt_util.utcnow()
    m.guest = {
        "th": _token_hash(token), "ph": ph, "salt": salt,
        "created": now.isoformat(), "until": (now + timedelta(hours=hours)).isoformat(),
        "store_id": store_id or None, "by": by,
    }
    _reset_rt(m)
    m._log("guest_on", {"name": "Gast-Link", "store_id": store_id}, f"{hours} Std.", who=by)
    m._changed()
    return {"token": token, "path": GUEST_URL + "#" + token, **(info(m) or {})}


def revoke(m: EinkaufslisteManager, by: str | None = None, reason: str | None = None) -> None:
    """🔒 Gast-Link sofort sperren (alle Gast-Geräte fliegen raus)."""
    if m.guest:
        m._log("guest_off", {"name": "Gast-Link", "store_id": m.guest.get("store_id")}, reason, who=by)
    m.guest = None
    _reset_rt(m)
    m._changed()


def visible_items(m: EinkaufslisteManager, g: dict[str, Any]) -> list[dict[str, Any]]:
    """Was der Gast sieht: offene Artikel (beim gewählten Geschäft + „Egal wo“) und was ER in dieser Zeit abgehakt hat."""
    sid = g.get("store_id")
    store = m.store_by_id(sid) if sid else None
    since = str(g.get("created") or "")
    out = []
    for i in m.items:
        if i["checked"] and not (i.get("checked_by") == GUEST_NAME and str(i.get("checked_at") or "") >= since):
            continue
        if not m.shows_in_store(i, store):  # 🤷 „Egal wo“ nur, wo es nicht abgeschaltet ist (no_any / 🚫 Nicht bei …)
            continue
        st = m.store_by_id(i.get("store_id"))
        out.append({
            "id": i["id"], "name": i["name"], "quantity": i.get("quantity"), "note": i.get("note"),
            "store": st["name"] if st else None, "color": st.get("color") if st else None, "checked": bool(i["checked"]),
        })
    out.sort(key=lambda x: (x["checked"], (x["store"] or "~").lower(), x["name"].lower()))
    return out


def _answer(m: EinkaufslisteManager, g: dict[str, Any], extra: dict[str, Any] | None = None) -> dict[str, Any]:
    store = m.store_by_id(g.get("store_id")) if g.get("store_id") else None
    lang = str(getattr(m.hass.config, "language", "de") or "de").lower()
    return {
        "ok": True, "until": g.get("until"), "store": store["name"] if store else None,
        "lang": "de" if lang.startswith("de") else "en", "items": visible_items(m, g), **(extra or {}),
    }


def _json(data: dict[str, Any], status: int = HTTPStatus.OK) -> web.Response:
    return web.json_response(data, status=status, headers=_HEADERS)


class GuestPageView(HomeAssistantView):
    """Die Gast-Seite selbst. Enthält nur Programm, keine Daten – die gibt es erst mit Schlüssel und PIN."""

    url = "/einkaufsliste/gast/{file:.*}"
    name = "einkaufsliste:gast"
    requires_auth = False

    async def get(self, request: web.Request, file: str = "") -> web.StreamResponse:
        real = _FILES.get(file)
        if real is None:
            return web.Response(status=HTTPStatus.NOT_FOUND)
        hass = request.app["hass"]
        body = await hass.async_add_executor_job((GUEST_DIR / real).read_bytes)
        return web.Response(body=body, content_type=_TYPES[real], charset="utf-8",
                            headers={**_HEADERS, "Content-Security-Policy": _CSP})


class GuestRedirectView(HomeAssistantView):
    """/einkaufsliste/gast ohne Schrägstrich -> mit (der Teil hinter „#“ bleibt im Browser erhalten)."""

    url = "/einkaufsliste/gast"
    name = "einkaufsliste:gast_redirect"
    requires_auth = False

    async def get(self, request: web.Request) -> web.StreamResponse:
        raise web.HTTPFound(GUEST_URL)


class GuestApiView(HomeAssistantView):
    """Die EINZIGE Adresse, mit der die Gast-Seite spricht. Kann nur: Liste lesen, abhaken, Haken zurücknehmen."""

    url = GUEST_API
    name = "api:einkaufsliste:gast"
    requires_auth = False

    async def post(self, request: web.Request) -> web.Response:
        hass = request.app["hass"]
        m: EinkaufslisteManager | None = hass.data.get(DOMAIN, {}).get("manager")
        if request.content_length is None or request.content_length > MAX_BODY:
            return _json({"error": "bad"}, HTTPStatus.BAD_REQUEST)
        try:
            data = json.loads(await request.text())
        except ValueError:
            return _json({"error": "bad"}, HTTPStatus.BAD_REQUEST)
        if not isinstance(data, dict):
            return _json({"error": "bad"}, HTTPStatus.BAD_REQUEST)
        token = data.get("t")
        if not isinstance(token, str) or not _TOKEN.fullmatch(token):
            await process_wrong_login(request)
            return _json({"error": "gone"}, HTTPStatus.FORBIDDEN)
        g = active(m) if m is not None else None
        if g is None:
            return _json({"error": "gone"}, HTTPStatus.GONE)
        if not hmac.compare_digest(_token_hash(token), g["th"]):
            await process_wrong_login(request)  # 🛡️ zählt wie eine falsche Anmeldung (IP-Sperre von HA)
            return _json({"error": "gone"}, HTTPStatus.FORBIDDEN)
        rt = _rt(m)
        action = data.get("do")
        if action == "open":
            return await self._open(request, m, g, rt, data.get("pin"))
        sid = data.get("s")
        if not isinstance(sid, str) or not any(hmac.compare_digest(sid, k) for k in rt["sessions"]):
            return _json({"error": "pin"}, HTTPStatus.UNAUTHORIZED)
        rt["sessions"][sid] = time.monotonic()
        if action == "list":
            return _json(_answer(m, g))
        if action == "check":
            item_id = data.get("id")
            want = data.get("checked")
            if not isinstance(item_id, str) or not _ID.fullmatch(item_id) or not isinstance(want, bool):
                return _json({"error": "bad"}, HTTPStatus.BAD_REQUEST)
            seen = {i["id"]: i for i in visible_items(m, g)}
            if item_id not in seen:  # nur was der Gast auch sehen darf
                return _json(_answer(m, g, {"note": "gone"}))
            if seen[item_id]["checked"] != want:
                with m.acting(GUEST_NAME, None, "guest"):
                    if want:
                        m.set_checked(item_id, True, GUEST_NAME, None)
                    else:  # ↩️ nur die eigenen Haken des Gastes (siehe visible_items)
                        m.set_checked(item_id, False, GUEST_NAME, None, undo=True)
            return _json(_answer(m, g))
        return _json({"error": "bad"}, HTTPStatus.BAD_REQUEST)

    async def _open(self, request: web.Request, m: EinkaufslisteManager, g: dict[str, Any], rt: dict[str, Any],
                    pin: Any) -> web.Response:
        wait = rt["pause"] - time.monotonic()
        if wait > 0:
            return _json({"error": "pause", "wait": int(wait) + 1}, HTTPStatus.TOO_MANY_REQUESTS)
        ok = isinstance(pin, str) and _PIN.fullmatch(pin) is not None
        if ok:
            calc = await m.hass.async_add_executor_job(_pin_hash, pin, g["salt"])
            ok = hmac.compare_digest(calc, g["ph"])
        if not ok:
            await asyncio.sleep(0.5)  # bremst Durchprobieren zusätzlich
            await process_wrong_login(request)
            rt["fails"] += 1
            rt["total"] += 1
            if rt["total"] >= FAILS_REVOKE:
                revoke(m, None, "zu viele falsche PINs")
                return _json({"error": "gone"}, HTTPStatus.GONE)
            if rt["fails"] >= FAILS_PAUSE:
                rt["fails"] = 0
                rt["pause"] = time.monotonic() + PAUSE_SECONDS
                return _json({"error": "pause", "wait": PAUSE_SECONDS}, HTTPStatus.TOO_MANY_REQUESTS)
            return _json({"error": "pin"}, HTTPStatus.UNAUTHORIZED)
        rt["fails"] = 0
        sessions = rt["sessions"]
        while len(sessions) >= MAX_SESSIONS:
            sessions.pop(min(sessions, key=sessions.get), None)
        sid = secrets.token_urlsafe(32)
        sessions[sid] = time.monotonic()
        return _json(_answer(m, g, {"s": sid}))
