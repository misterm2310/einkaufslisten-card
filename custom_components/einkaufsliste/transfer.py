"""📥 Import & Sicherung: alles sichern/zurückholen, Rezepte aus Dateien, Listen aus anderen Apps."""

from __future__ import annotations

import csv
import io
import json
import logging
import re
import zipfile
from http import HTTPStatus
from typing import TYPE_CHECKING, Any

from aiohttp import web

from homeassistant.components.http import HomeAssistantView
from homeassistant.core import HomeAssistant
from homeassistant.util import dt as dt_util

from .const import DOMAIN, VERSION
from .recipe_import import parse_line

if TYPE_CHECKING:
    from .manager import EinkaufslisteManager

_LOGGER = logging.getLogger(__name__)
BACKUP_FORMAT = "einkaufsliste-sicherung"
MAX_BACKUP = 300 * 1024 * 1024  # 300 MB – reicht für sehr viele Fotos
MAX_RECIPES = 500

# ------------------------------------------------------------------ 💾 Sicherung


async def async_export(manager: EinkaufslisteManager) -> bytes:
    """Alles in eine Zip-Datei: data.json (Liste, Rezepte, Produkte …) + alle Fotos."""
    data = {"format": BACKUP_FORMAT, "version": VERSION, "created": dt_util.utcnow().isoformat(),
            "data": manager._to_storage()}
    ids = {pid for entry in manager.photos.values() for pid in manager._photo_ids(entry)}

    def build() -> bytes:
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            zf.writestr("data.json", json.dumps(data, ensure_ascii=False, indent=1))
            for pid in sorted(ids):
                path = manager._photo_path(pid)
                if path.exists():
                    zf.write(path, f"fotos/{pid}.jpg")
        return buf.getvalue()

    return await manager.hass.async_add_executor_job(build)


async def async_restore(manager: EinkaufslisteManager, raw: bytes) -> dict[str, Any]:
    """Sicherung einspielen: ersetzt ALLES (Liste, Rezepte, Produkte, Einstellungen der Liste, Fotos)."""

    def read() -> tuple[dict[str, Any], dict[str, bytes]]:
        try:
            zf = zipfile.ZipFile(io.BytesIO(raw))
        except zipfile.BadZipFile as err:
            raise ValueError("Das ist keine Sicherung der Einkaufsliste (keine Zip-Datei).") from err
        with zf:
            try:
                meta = json.loads(zf.read("data.json").decode("utf-8"))
            except (KeyError, ValueError) as err:
                raise ValueError("In der Datei fehlt data.json – ist das wirklich eine Sicherung?") from err
            photos = {}
            for name in zf.namelist():
                m = re.fullmatch(r"fotos/([0-9a-f]{6,64})\.jpg", name)
                if m:
                    photos[m.group(1)] = zf.read(name)
        return meta, photos

    meta, photos = await manager.hass.async_add_executor_job(read)
    if meta.get("format") != BACKUP_FORMAT or not isinstance(meta.get("data"), dict):
        raise ValueError("Das ist keine Sicherung der Einkaufsliste.")
    data = meta["data"]
    for key in ("stores", "categories", "items", "recipes"):
        if not isinstance(data.get(key, []), list):
            raise ValueError("Die Sicherung ist beschädigt.")

    def write_photos() -> None:
        manager.photo_dir.mkdir(parents=True, exist_ok=True)
        for pid, blob in photos.items():
            manager._photo_path(pid).write_bytes(blob)

    await manager.hass.async_add_executor_job(write_photos)
    await manager._store.async_save(data)
    await manager.async_load()
    if getattr(manager, "sync", None) is not None:
        manager.sync.start()  # 🔁 gewählte To-do-Liste aus der Sicherung übernehmen
    if getattr(manager, "mail", None) is not None:
        manager.mail.start()
    if getattr(manager, "offers", None) is not None:
        manager.offers.start()  # 🏷️ Angebote
    # Fotos, die jetzt zu nichts mehr gehören, wegräumen
    await manager.async_check(fixes={"photo_orphans": ""})
    manager._changed()
    return {"items": len(manager.items), "recipes": len(manager.recipes), "photos": len(photos),
            "version": meta.get("version")}


class BackupView(HomeAssistantView):
    """GET = Sicherung herunterladen, POST = Sicherung einspielen (nur Admins)."""

    url = "/api/einkaufsliste/sicherung"
    name = "api:einkaufsliste:sicherung"
    requires_auth = True

    def _manager(self, request: web.Request) -> EinkaufslisteManager | None:
        return request.app["hass"].data.get(DOMAIN, {}).get("manager")

    async def get(self, request: web.Request) -> web.Response:
        if not request["hass_user"].is_admin:
            return web.Response(status=HTTPStatus.FORBIDDEN, text="Nur für Admins.")
        manager = self._manager(request)
        if manager is None:
            return web.Response(status=HTTPStatus.SERVICE_UNAVAILABLE, text="Nicht eingerichtet.")
        body = await async_export(manager)
        stamp = dt_util.now().strftime("%Y-%m-%d")
        return web.Response(body=body, content_type="application/zip",
                            headers={"Content-Disposition": f'attachment; filename="einkaufsliste-sicherung-{stamp}.zip"'})

    async def post(self, request: web.Request) -> web.Response:
        if not request["hass_user"].is_admin:
            return web.Response(status=HTTPStatus.FORBIDDEN, text="Nur für Admins.")
        manager = self._manager(request)
        if manager is None:
            return web.Response(status=HTTPStatus.SERVICE_UNAVAILABLE, text="Nicht eingerichtet.")
        raw = await request.content.read(MAX_BACKUP + 1)
        if len(raw) > MAX_BACKUP:
            return web.Response(status=HTTPStatus.REQUEST_ENTITY_TOO_LARGE, text="Die Datei ist zu groß.")
        try:
            result = await async_restore(manager, raw)
        except ValueError as err:
            return web.json_response({"error": str(err)}, status=HTTPStatus.BAD_REQUEST)
        return web.json_response(result)


def async_register_views(hass: HomeAssistant) -> None:
    if not hass.data[DOMAIN].get("views_registered"):
        from .app_view import AppRedirectView, AppView  # noqa: PLC0415 – 📱 Offline-App

        hass.http.register_view(BackupView())
        hass.http.register_view(AppView())
        hass.http.register_view(AppRedirectView())
        hass.data[DOMAIN]["views_registered"] = True


# ------------------------------------------------------------------ 📄 Rezepte aus einer Datei

_STEPS_HEAD = re.compile(r"^\s*(zubereitung|anleitung|so geht's|so geht es|instructions|directions|method)\s*:?\s*$", re.IGNORECASE)
_INGR_HEAD = re.compile(r"^\s*(zutaten|ingredients)\s*:?\s*$", re.IGNORECASE)
_TITLE = re.compile(r"^\s*#{1,3}\s*(.+?)\s*$")


def _recipes_from_json(data: Any) -> list[dict[str, Any]]:
    if isinstance(data, dict) and data.get("format") == BACKUP_FORMAT:
        data = data.get("data", {}).get("recipes", [])
    elif isinstance(data, dict) and "recipes" in data:
        data = data["recipes"]
    if isinstance(data, dict):
        data = [data]
    out = []
    for r in data if isinstance(data, list) else []:
        if not isinstance(r, dict) or not r.get("name"):
            continue
        items = []
        for it in r.get("items") or r.get("ingredients") or []:
            if isinstance(it, str):
                parsed = parse_line(it)
                if parsed:
                    items.append(parsed)
            elif isinstance(it, dict) and it.get("name"):
                items.append({"name": str(it["name"]), "quantity": it.get("quantity"), "note": it.get("note")})
        steps = r.get("steps") or r.get("instructions")
        if isinstance(steps, list):
            steps = "\n".join(str(s) for s in steps)
        out.append({"name": str(r["name"]), "items": items, "steps": steps or None,
                    "servings": r.get("servings")})
    return out


def _recipes_from_csv(text: str) -> list[dict[str, Any]]:
    sample = text[:2000]
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters=";,\t")
    except csv.Error:
        dialect = csv.excel
    rows = list(csv.DictReader(io.StringIO(text), dialect=dialect))
    if not rows:
        return []

    def col(row: dict[str, Any], *names: str) -> str:
        for key, val in row.items():
            if key and key.strip().lower() in names:
                return (val or "").strip()
        return ""

    recipes: dict[str, dict[str, Any]] = {}
    for row in rows:
        name = col(row, "rezept", "recipe", "rezeptname", "gericht")
        ingr = col(row, "zutat", "ingredient", "produkt", "name")
        if not name or not ingr:
            continue
        rec = recipes.setdefault(name.lower(), {"name": name, "items": [], "steps": None})
        qty = col(row, "menge", "quantity", "amount")
        unit = col(row, "einheit", "unit")
        rec["items"].append({"name": ingr, "quantity": f"{qty} {unit}".strip() or None,
                             "note": col(row, "notiz", "note", "hinweis") or None})
        steps = col(row, "zubereitung", "anleitung", "instructions", "steps")
        if steps and not rec["steps"]:
            rec["steps"] = steps
    return list(recipes.values())


def _recipes_from_text(text: str) -> list[dict[str, Any]]:
    """Mehrere Rezepte als Text: jedes beginnt mit „# Name“ – oder Blöcke durch Leerzeilen, erste Zeile = Name."""
    lines = text.replace("\r\n", "\n").split("\n")
    has_titles = any(_TITLE.match(line) for line in lines)
    blocks: list[list[str]] = []
    current: list[str] = []
    for line in lines:
        if has_titles and _TITLE.match(line):
            if current:
                blocks.append(current)
            current = [_TITLE.match(line).group(1)]
        elif not has_titles and not line.strip():
            if current:
                blocks.append(current)
            current = []
        else:
            current.append(line)
    if current:
        blocks.append(current)
    out = []
    for block in blocks:
        block = [b for b in block if b is not None]
        if not block or not block[0].strip():
            block = [b for b in block if b.strip()]
        if not block:
            continue
        name, body = block[0].strip(), block[1:]
        items, steps, in_steps = [], [], False
        for line in body:
            if _STEPS_HEAD.match(line):
                in_steps = True
                continue
            if _INGR_HEAD.match(line):
                in_steps = False
                continue
            if in_steps:
                if line.strip():
                    steps.append(line.strip())
                continue
            parsed = parse_line(line)
            if parsed:
                items.append(parsed)
        if name and (items or steps):
            out.append({"name": name, "items": items, "steps": "\n".join(steps) or None})
    return out


def import_recipe_file(manager: EinkaufslisteManager, text: str, filename: str | None = None) -> dict[str, Any]:
    """Rezepte aus einer Datei anlegen. Gibt es den Namen schon, bekommt das neue „(Import)“ dahinter."""
    text = (text or "").lstrip("﻿")
    if not text.strip():
        raise ValueError("Die Datei ist leer.")
    fname = (filename or "").lower()
    recipes: list[dict[str, Any]] = []
    if fname.endswith(".json") or text.lstrip()[:1] in "[{":
        try:
            recipes = _recipes_from_json(json.loads(text))
        except ValueError as err:
            raise ValueError("Die JSON-Datei konnte nicht gelesen werden.") from err
    elif fname.endswith(".csv") or (text.count(";") + text.count(",") > 3 and re.search(r"(?i)^\W*(rezept|recipe)", text)):
        recipes = _recipes_from_csv(text)
    else:
        recipes = _recipes_from_text(text)
    if not recipes:
        raise ValueError("In der Datei habe ich keine Rezepte gefunden. Tipp: jedes Rezept mit „# Name“ anfangen.")
    added, names = 0, []
    existing = {r["name"].lower() for r in manager.recipes}
    for rec in recipes[:MAX_RECIPES]:
        name = rec["name"][:60]
        while name.lower() in existing:
            name = f"{rec['name'][:50]} (Import)" if "(Import)" not in name else name + "+"
        try:
            manager.add_recipe(name, rec["items"], steps=rec.get("steps"),
                               servings=rec.get("servings") if isinstance(rec.get("servings"), int) else None)
        except ValueError as err:
            _LOGGER.debug("Rezept %s übersprungen: %s", name, err)
            continue
        existing.add(name.lower())
        added += 1
        names.append(name)
    return {"added": added, "names": names, "found": len(recipes)}


# ------------------------------------------------------------------ 🔁 Aus anderen Apps

_DONE = re.compile(r"^\s*(?:[☑✅✔✓]|\[x\]|- \[x\])", re.IGNORECASE)
_BULLET = re.compile(r"^\s*(?:- \[ \]|\[ \]|[-–•*·▪►☐□]+|\d+[.)](?=\s))\s*")

_NAME_COLS = ("name", "artikel", "item", "produkt", "product", "titel", "title", "zutat", "bezeichnung")
_QTY_COLS = ("menge", "quantity", "amount", "anzahl", "qty", "specification", "spezifikation", "detail", "details")
_NOTE_COLS = ("notiz", "note", "notes", "notizen", "hinweis", "beschreibung", "description")
_DONE_COLS = ("erledigt", "checked", "completed", "done", "status", "abgehakt")
_DONE_VALUES = {"1", "true", "yes", "ja", "x", "✓", "✔", "checked", "completed", "done", "erledigt"}


def _table_rows(text: str) -> list[dict[str, str]] | None:
    """Erkennt CSV/TSV-Exporte (z. B. Bring!, AnyList) an der Kopfzeile. Sonst None = normaler Text."""
    lines = [ln for ln in text.splitlines() if ln.strip()]
    if len(lines) < 2:
        return None
    head = lines[0]
    delim = next((d for d in ("\t", ";", ",") if d in head), None)
    if not delim:
        return None
    cols = [c.strip().strip('"').lower() for c in head.split(delim)]
    if not any(c in _NAME_COLS for c in cols):
        return None
    reader = csv.DictReader(io.StringIO("\n".join(lines)), delimiter=delim)
    rows = []
    for row in reader:
        rows.append({(k or "").strip().lower(): (v or "").strip() for k, v in row.items() if isinstance(v, (str, type(None)))})
    return rows


def _import_table(manager: EinkaufslisteManager, rows: list[dict[str, str]], store_id: str | None) -> dict[str, Any]:
    def pick(row: dict[str, str], names: tuple[str, ...]) -> str:
        return next((row[n] for n in names if row.get(n)), "")

    added = skipped = 0
    for row in rows:
        name = pick(row, _NAME_COLS)
        if not name or len(name) > 80:
            continue
        if pick(row, _DONE_COLS).lower() in _DONE_VALUES:
            skipped += 1
            continue
        manager.add_item(name, store_id=store_id, quantity=pick(row, _QTY_COLS)[:30] or None,
                         note=pick(row, _NOTE_COLS)[:120] or None,
                         added_by=manager._actor.get("who"), added_by_id=manager._actor.get("who_id"), notify=False)
        added += 1
    if added:
        manager._changed()
    return {"added": added, "skipped": skipped}


def import_text(manager: EinkaufslisteManager, text: str, store_id: str | None = None) -> dict[str, Any]:
    """Liste als Text (z. B. „Teilen“ aus Bring! oder Google Keep): eine Zeile = ein Artikel. Erledigtes (☑) wird übersprungen."""
    text = (text or "").lstrip("\ufeff")
    table = _table_rows(text)
    if table is not None:
        return _import_table(manager, table, store_id)
    added = skipped = 0
    for raw in re.split(r"[\r\n]+", text or ""):
        line = raw.strip()
        if not line or line.endswith(":"):
            continue
        if _DONE.match(line):
            skipped += 1
            continue
        line = _BULLET.sub("", line).strip()
        if not line or len(line) > 80:
            continue
        manager.add_item(line, store_id=store_id, added_by=manager._actor.get("who"),
                         added_by_id=manager._actor.get("who_id"), notify=False)
        added += 1
    if added:
        manager._changed()
    return {"added": added, "skipped": skipped}


def todo_lists(hass: HomeAssistant) -> list[dict[str, Any]]:
    """Alle To-do-Listen in HA (HA-Einkaufsliste, Bring!, Google Tasks, Todoist …)."""
    return [{"entity_id": s.entity_id, "name": s.name, "open": int(s.state) if str(s.state).isdigit() else None}
            for s in sorted(hass.states.async_all("todo"), key=lambda s: s.name.lower())]


async def async_todo_text(hass: HomeAssistant, entity_id: str) -> str:
    """Offene Einträge einer HA-To-do-Liste als Text (eine Zeile pro Eintrag). Die Liste selbst bleibt unverändert."""
    if not entity_id.startswith("todo.") or hass.states.get(entity_id) is None:
        raise ValueError("Diese To-do-Liste gibt es nicht.")
    resp = await hass.services.async_call("todo", "get_items", {"entity_id": entity_id, "status": ["needs_action"]},
                                          blocking=True, return_response=True)
    entries = (resp or {}).get(entity_id, {}).get("items", [])
    return "\n".join(str(e.get("summary") or "") for e in entries)
