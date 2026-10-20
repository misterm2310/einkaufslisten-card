"""📱 Offline-App: eine eigene kleine Seite nur für die Einkaufsliste.

Auf dem Handy im Browser öffnen (z. B. über die Nabu-Casa-Adresse), anmelden und „Zum Startbildschirm“.
Die Seite speichert den letzten Stand im Handy, öffnet auch ohne Netz, merkt sich Änderungen und
schickt sie nach, sobald wieder Netz da ist. Die Seite selbst enthält keine Daten – die kommen erst nach
der Anmeldung über die normale, geschützte Home-Assistant-Verbindung.
"""

from __future__ import annotations

from pathlib import Path

from aiohttp import web

from homeassistant.components.http import HomeAssistantView

from .const import VERSION

APP_DIR = Path(__file__).parent / "www" / "app"
APP_URL = "/einkaufsliste/app/"

_TYPES = {
    "index.html": "text/html; charset=utf-8",
    "sw.js": "text/javascript; charset=utf-8",
    "manifest.webmanifest": "application/manifest+json",
    "icon-192.png": "image/png",
    "icon-512.png": "image/png",
    "icons.json": "application/json",  # Material Design Icons (Apache 2.0), liegt gepackt als icons.json.gz
    "zxing.min.js": "text/javascript",  # Barcode-Leser für Handys ohne eingebauten (ZXing-js 0.21.3, Apache 2.0), gepackt als .gz
}
_GZ = {"icons.json", "zxing.min.js"}
_MANIFEST_EN = {
    '"Einkaufsliste"': '"Shopping list"', '"Einkauf"': '"Shopping"',
    "Die Familien-Einkaufsliste aus Home Assistant – auch ohne Netz.": "The family shopping list from Home Assistant – even offline.",
    '"Eintragen"': '"Add"', '"Laden-Modus"': '"Shop mode"', '"Laden"': '"Shop"', '"Scannen"': '"Scan"',
}


class AppView(HomeAssistantView):
    """Liefert die Offline-App aus (ohne Anmeldung – die Seite enthält nur Programm, keine Daten)."""

    url = "/einkaufsliste/app/{file:.*}"
    name = "einkaufsliste:app"
    requires_auth = False

    async def get(self, request: web.Request, file: str = "") -> web.StreamResponse:
        file = file or "index.html"
        if file not in _TYPES:
            return web.Response(status=404)
        path = APP_DIR / (file + ".gz" if file in _GZ else file)
        hass = request.app["hass"]
        body = await hass.async_add_executor_job(path.read_bytes)
        if file in _GZ:  # schon gepackt – so muss das Handy weniger laden
            return web.Response(body=body, content_type=_TYPES[file],
                                headers={"Content-Encoding": "gzip", "Cache-Control": "public, max-age=604800"})
        if file in ("index.html", "sw.js"):
            body = body.replace(b"__EL_VERSION__", VERSION.encode())
        if file == "manifest.webmanifest" and not str(getattr(hass.config, "language", "de") or "de").lower().startswith("de"):
            for de, en in _MANIFEST_EN.items():  # 🌍 Schnellmenü am App-Symbol auf Englisch
                body = body.replace(de.encode(), en.encode())
        headers = {"Cache-Control": "no-cache"}
        if file == "sw.js":
            headers["Service-Worker-Allowed"] = APP_URL
        return web.Response(body=body, content_type=_TYPES[file].split(";")[0], charset="utf-8" if "charset" in _TYPES[file] else None, headers=headers)


class AppRedirectView(HomeAssistantView):
    """/einkaufsliste/app ohne Schrägstrich -> mit Schrägstrich (sonst passt der Offline-Speicher nicht)."""

    url = "/einkaufsliste/app"
    name = "einkaufsliste:app_redirect"
    requires_auth = False

    async def get(self, request: web.Request) -> web.StreamResponse:
        raise web.HTTPFound(APP_URL)
