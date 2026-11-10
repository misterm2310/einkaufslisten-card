"""📋 Rezept einfügen: Zutaten aus Text oder aus einem Rezept-Link herausholen."""

from __future__ import annotations

import asyncio
import base64
import html
import ipaddress
import json
import logging
import re
import socket
from typing import Any
from urllib.parse import urljoin, urlparse

import aiohttp

from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .const import VERSION
from .convert import convert_line, convert_temps
from .netutil import read_limited
from .quantity import NUM, UNIT_WORDS, norm_qty
from .recipe_heat import guess_heat

_LOGGER = logging.getLogger(__name__)

USER_AGENT = f"HomeAssistant-Einkaufsliste/{VERSION} (github.com/misterm2310/einkaufslisten-card)"
MAX_PAGE = 3 * 1024 * 1024
MAX_IMAGE = 3 * 1024 * 1024

# Mengen-Einheiten, die vor dem Produktnamen stehen dürfen („200 g Mehl“, „1 Prise Salz“) –
# dieselbe Liste wie beim Eintragen (quantity.py), damit alles gleich geschrieben wird
UNITS = tuple(u for u in UNIT_WORDS if u not in ("x", "×", "mal"))
_NUM = NUM
_UNIT = "|".join(sorted((re.escape(u) for u in UNITS), key=len, reverse=True))
# „1x Milch“ / „2 x Eier“: das x gehört zur Menge (sonst bleibt es im Namen hängen: „X Milch“)
_LINE = re.compile(rf"^(?P<qty>{_NUM})\s*(?P<unit>(?:{_UNIT})\.?(?=\s|$)|[x×](?=\s|$))?\s*(?P<rest>.*)$", re.IGNORECASE)
_BULLET = re.compile(r"^\s*(?:[-–•*·▪►✓✔☐□]+|\d+[.)](?=\s))\s*")
_SKIP = re.compile(
    r"^(zutaten|zubereitung|anleitung|für\s+\d+|für den|für die|portionen?|zeit|dauer|schwierigkeit)\b",
    re.IGNORECASE,
)


def _nice(text: str) -> str:
    text = re.sub(r"\s+", " ", text).strip(" ,;:-–")
    return text[:1].upper() + text[1:] if text else ""


def parse_line(line: str) -> dict[str, Any] | None:
    """Eine Zutaten-Zeile zerlegen: „200 g Mehl (Type 405)“ -> Menge 200 g, Name Mehl, Notiz Type 405."""
    line = html.unescape(line)
    line = convert_line(_BULLET.sub("", line).strip())  # ⚖️ cup, oz, lb … -> g, ml
    if not line or len(line) > 120 or line.endswith(":") or _SKIP.match(line):
        return None
    qty = None
    m = _LINE.match(line)
    if m and m.group("rest"):
        unit = (m.group("unit") or "").rstrip(".")
        qty = norm_qty(f"{m.group('qty')} {unit}".strip())
        line = m.group("rest")
    note_parts: list[str] = []
    for part in re.findall(r"\(([^)]*)\)", line):
        if part.strip():
            note_parts.append(part.strip())
    line = re.sub(r"\([^)]*\)", " ", line)
    if "," in line:  # „Zwiebel, fein gehackt“
        line, extra = line.split(",", 1)
        if extra.strip():
            note_parts.append(extra.strip())
    name = _nice(line)
    if not name or not re.search(r"[A-Za-zÄÖÜäöüß]", name):
        return None
    note = _nice(", ".join(note_parts))[:60] or None
    return {"name": name[:60], "quantity": qty, "note": note}


def parse_text(text: str) -> list[dict[str, Any]]:
    """Mehrere Zeilen (oder mit Komma/Semikolon getrennt) in Zutaten umwandeln."""
    lines = re.split(r"[\r\n]+", text or "")
    if len(lines) == 1:
        lines = re.split(r"[;,](?![^(]*\))", lines[0])
    out: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for raw in lines:
        entry = parse_line(raw)
        if not entry:
            continue
        key = (entry["name"].lower(), (entry["note"] or "").lower())
        if key in seen:
            continue
        seen.add(key)
        out.append(entry)
    return out


def _find_recipe(node: Any) -> dict[str, Any] | None:
    if isinstance(node, list):
        for sub in node:
            found = _find_recipe(sub)
            if found:
                return found
        return None
    if not isinstance(node, dict):
        return None
    kind = node.get("@type")
    kinds = kind if isinstance(kind, list) else [kind]
    if "Recipe" in kinds:
        return node
    for key in ("@graph", "mainEntity", "itemListElement"):
        if key in node:
            found = _find_recipe(node[key])
            if found:
                return found
    return None


def _image_url(img: Any) -> str | None:
    if isinstance(img, str):
        return img
    if isinstance(img, list) and img:
        return _image_url(img[0])
    if isinstance(img, dict):
        return img.get("url") or img.get("contentUrl")
    return None


def parse_html(page: str) -> dict[str, Any]:
    """Rezept-Seite lesen: fast alle großen Seiten (Chefkoch & Co.) liefern ein schema.org-„Recipe“ mit."""
    for block in re.findall(
        r"<script[^>]+application/ld\+json[^>]*>(.*?)</script>", page, re.IGNORECASE | re.DOTALL
    ):
        try:
            data = json.loads(block.strip())
        except ValueError:
            continue
        recipe = _find_recipe(data)
        if not recipe:
            continue
        lines = recipe.get("recipeIngredient") or recipe.get("ingredients") or []
        if isinstance(lines, str):
            lines = [lines]
        items = parse_text("\n".join(str(x) for x in lines))
        return {
            "name": _nice(html.unescape(str(recipe.get("name") or "")))[:60] or None,
            "items": items,
            "image_url": _image_url(recipe.get("image")),
            "steps": _steps(recipe.get("recipeInstructions")),
            "minutes": _total_minutes(recipe),
        }
    return {"name": None, "items": [], "image_url": None, "steps": None, "minutes": None}


def _iso_minutes(value: Any) -> int | None:
    """⏱️ schema.org-Zeit wie „PT1H30M“ oder „P0DT0H45M“ in Minuten."""
    m = re.fullmatch(r"\s*P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:\d+(?:\.\d+)?S)?)?\s*", str(value or ""), re.IGNORECASE)
    if not m or not any(m.groups()):
        return None
    n = int(m[1] or 0) * 1440 + int(m[2] or 0) * 60 + int(m[3] or 0)
    return n if 1 <= n <= 1440 else None


def _total_minutes(recipe: dict[str, Any]) -> int | None:
    """⏱️ Gesamtzeit von der Rezeptseite (totalTime, sonst Vorbereitung + Kochen)."""
    total = _iso_minutes(recipe.get("totalTime"))
    if total:
        return total
    parts = [_iso_minutes(recipe.get(k)) for k in ("prepTime", "cookTime")]
    n = sum(p for p in parts if p)
    return n if 1 <= n <= 1440 else None


def _steps(node: Any) -> str | None:
    """👨‍🍳 Zubereitung aus schema.org holen (Text, HowToStep oder HowToSection)."""
    out: list[str] = []

    def walk(n: Any) -> None:
        if isinstance(n, str):
            for part in re.split(r"[\r\n]+", html.unescape(re.sub(r"<[^>]+>", " ", n))):
                part = " ".join(part.split())
                if part:
                    out.append(part)
        elif isinstance(n, list):
            for sub in n:
                walk(sub)
        elif isinstance(n, dict):
            if n.get("itemListElement"):
                walk(n["itemListElement"])
            else:
                walk(n.get("text") or n.get("name") or "")

    walk(node)
    return convert_temps("\n".join(out))[:8000] or None  # ⚖️ °F -> °C


def _bad_ip(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped:
        ip = ip.ipv4_mapped
    return (ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved
            or ip.is_multicast or ip.is_unspecified or not ip.is_global)


def _is_local(host: str) -> bool:
    host = host.strip("[]").lower().rstrip(".")
    if host in ("localhost", "homeassistant", "homeassistant.local") or host.endswith((".local", ".lan", ".home", ".internal", ".localhost")):
        return True
    if "." not in host and ":" not in host:  # „router“, „nas“ – Namen ohne Punkt gibt's nur im Heimnetz
        return True
    try:
        return _bad_ip(ipaddress.ip_address(host))
    except ValueError:
        return False


def _resolve(host: str, port: int) -> list[str]:
    """Alle IP-Adressen zu einem Namen (läuft im Hintergrund-Thread)."""
    return list({info[4][0] for info in socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)})


async def _check_url(hass: HomeAssistant, url: str) -> bool:
    """🔒 Nur echte Internet-Adressen: kein Heimnetz, auch nicht über einen Namen, der auf eine private IP zeigt."""
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname or _is_local(parsed.hostname):
        return False
    try:
        ips = await hass.async_add_executor_job(_resolve, parsed.hostname, parsed.port or (443 if parsed.scheme == "https" else 80))
    except (OSError, UnicodeError) as err:
        _LOGGER.debug("Name nicht auflösbar (%s): %s", parsed.hostname, err)
        return False
    try:
        return bool(ips) and not any(_bad_ip(ipaddress.ip_address(ip.split("%")[0])) for ip in ips)
    except ValueError:
        return False


async def _download(hass: HomeAssistant, session: aiohttp.ClientSession, url: str, limit: int) -> tuple[bytes, str] | None:
    """Laden mit Prüfung – auch jede Umleitung wird einzeln geprüft (höchstens 5)."""
    try:
        async with asyncio.timeout(15):
            for _ in range(6):
                if not await _check_url(hass, url):
                    _LOGGER.info("🔒 Adresse im Heimnetz oder ungültig – nicht geladen: %s", url)
                    return None
                resp = await session.get(url, headers={"User-Agent": USER_AGENT}, allow_redirects=False)
                if resp.status in (301, 302, 303, 307, 308) and resp.headers.get("Location"):
                    url = urljoin(url, resp.headers["Location"])
                    resp.release()
                    continue
                if resp.status != 200:
                    return None
                raw = await read_limited(resp.content, limit)  # bis zum Ende lesen
                if raw is None:
                    return None
                return raw, resp.headers.get("Content-Type", "")
            return None  # zu viele Umleitungen
    except (TimeoutError, aiohttp.ClientError, ValueError) as err:
        _LOGGER.debug("Laden fehlgeschlagen (%s): %s", url, err)
        return None


async def async_import(hass: HomeAssistant, manager: Any, text: str) -> dict[str, Any]:
    """Text oder Link auswerten. Gibt Name, Zutaten und (bei Links) das Rezeptbild zurück."""
    text = (text or "").strip()
    if not text:
        raise ValueError("Da steht ja noch nichts drin 😉")
    result: dict[str, Any] = {"name": None, "items": [], "image": None, "source": "text", "steps": None}
    first = text.split()[0]
    if re.match(r"^https?://", first, re.IGNORECASE) and len(text.split()) == 1:
        parsed = urlparse(first)
        if not parsed.hostname:
            raise ValueError("Das ist kein gültiger Link.")
        if _is_local(parsed.hostname):
            raise ValueError("Links ins eigene Heimnetz werden nicht geöffnet.")
        session = async_get_clientsession(hass)
        got = await _download(hass, session, first, MAX_PAGE)
        if got is None:
            raise ValueError("Die Seite konnte nicht geladen werden. Kopier lieber die Zutaten als Text rein.")
        page = got[0].decode("utf-8", errors="replace")
        info = parse_html(page)
        if not info["items"]:
            raise ValueError("Auf der Seite habe ich keine Zutaten-Liste gefunden. Kopier sie lieber als Text rein.")
        result.update(source="link", name=info["name"], items=info["items"], steps=info.get("steps"), source_url=first[:500], minutes=info.get("minutes"))
        img_url = info.get("image_url")
        if isinstance(img_url, str) and img_url.startswith("http"):
            img = await _download(hass, session, img_url, MAX_IMAGE)
            if img and (img[0][:3] == b"\xff\xd8\xff" or img[0][:8] == b"\x89PNG\r\n\x1a\n" or img[0][8:12] == b"WEBP"):
                mime = "image/png" if img[0][:4] == b"\x89PNG" else "image/webp" if img[0][8:12] == b"WEBP" else "image/jpeg"
                result["image"] = f"data:{mime};base64,{base64.b64encode(img[0]).decode()}"
    else:
        result["items"] = parse_text(text)
        if not result["items"]:
            raise ValueError("Ich habe keine Zutaten erkannt. Am besten eine Zutat pro Zeile, z. B. „200 g Mehl“.")
    enrich_items(manager, result["items"])
    if result.get("steps"):
        result["heat"] = guess_heat(result["steps"])  # 🔥 Backofen & Airfryer aus den Schritten
    return result


def enrich_items(manager: Any, items: list[dict[str, Any]]) -> None:
    """Geschäft und Kategorie wie beim letzten Mal (sonst geraten) an die Zutaten hängen."""
    for item in items:
        hist = manager.history_for(item["name"]) or {}
        item["store_id"] = hist.get("store_id") if manager.store_by_id(hist.get("store_id")) else None
        cat = hist.get("category_id") or manager.guess_category(item["name"])
        item["category_id"] = cat if manager.category_by_id(cat) else None


def prepare_file_recipes(manager: Any, recipes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """🍲 Rezepte aus einer Datei für den Editor fertig machen (Geschäft/Kategorie, 🔥 Backofen & Co.)."""
    for rec in recipes:
        enrich_items(manager, rec["items"])
        rec["heat"] = guess_heat(rec.get("steps")) if rec.get("steps") else []
        rec.pop("image_url", None)  # Bilder aus Dateien kommen nur aus der .zip, nie aus dem Internet
    return recipes


# ------------------------------------------------------------------ 🍲 Mealie & schema.org aus Dateien

MAX_FILE = 25 * 1024 * 1024  # .zip aus Mealie (Bild darin) – mehr braucht kein Rezept
MAX_FILE_RECIPES = 50
_IMG_EXT = {".webp": "image/webp", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png"}


class OwnFormat(ValueError):
    """Die Datei ist kein Mealie/schema.org-Rezept – das eigene Format nimmt der normale Import."""


def _num_text(value: Any) -> str | None:
    """600.0 -> „600“, 0.5 -> „0,5“, 0/None -> None."""
    try:
        n = float(value)
    except (TypeError, ValueError):
        return None
    if n <= 0:
        return None
    return str(int(n)) if n == int(n) else f"{n:g}".replace(".", ",")


def _text_minutes(value: Any) -> int | None:
    """⏱️ „PT1H30M“, „1 Stunde 30 Minuten“, „45 min“ oder 45 -> Minuten."""
    if isinstance(value, (int, float)) and 0 < value <= 1440:
        return int(value)
    iso = _iso_minutes(value)
    if iso:
        return iso
    text = str(value or "").lower()
    h = re.search(r"(\d+)\s*(?:h\b|std|stunde|hour)", text)
    m = re.search(r"(\d+)\s*(?:m\b|min)", text)
    n = (int(h.group(1)) * 60 if h else 0) + (int(m.group(1)) if m else 0)
    return n if 1 <= n <= 1440 else None


def _servings_of(value: Any) -> int | None:
    if isinstance(value, list):
        value = value[0] if value else None
    m = re.search(r"\d+", str(value or ""))
    n = int(m.group(0)) if m else 0
    return n if 1 <= n <= 99 else None


def _ingredient(raw: Any) -> dict[str, Any] | None:
    """Eine Zutat: Text („600 g Hackfleisch“) oder Mealie-Feld (Menge, Einheit, Zutat, Bemerkung getrennt)."""
    if isinstance(raw, str):
        return parse_line(raw)
    if not isinstance(raw, dict):
        return None
    food = raw.get("food") if isinstance(raw.get("food"), dict) else None
    food_name = str((food or {}).get("name") or "").strip()
    note = str(raw.get("note") or "").strip()
    if not food_name:  # Mealie ohne „Lebensmittel“: steht alles im Text
        text = raw.get("display") or raw.get("originalText") or note
        return parse_line(str(text or "")) if text else None
    unit = raw.get("unit") if isinstance(raw.get("unit"), dict) else {}
    unit_txt = str(unit.get("abbreviation") or unit.get("name") or "").strip()
    qty = _num_text(raw.get("quantity"))
    parsed = parse_line(f"{qty} {unit_txt} {food_name}".strip()) if qty else None
    out = {"name": _nice(food_name)[:80], "quantity": (parsed or {}).get("quantity") if qty else (unit_txt or None), "note": note[:120] or None}
    if qty and not out["quantity"]:
        out["quantity"] = f"{qty} {unit_txt}".strip()
    return out


def recipe_from_schema(node: dict[str, Any]) -> dict[str, Any]:
    """schema.org-„Recipe“ (Webseite, Rezept-App) oder Mealie-Rezept -> Rezept für den Editor."""
    items = []
    for raw in node.get("recipeIngredient") or node.get("ingredients") or []:
        if isinstance(raw, dict) and raw.get("title") and not raw.get("food") and not raw.get("note"):
            continue  # nur eine Zwischen-Überschrift
        it = _ingredient(raw)
        if it and it.get("name"):
            items.append(it)
    steps = _steps(node.get("recipeInstructions"))
    minutes = _text_minutes(node.get("totalTime")) or _total_minutes(node) or (
        (_text_minutes(node.get("prepTime")) or 0) + (_text_minutes(node.get("performTime")) or _text_minutes(node.get("cookTime")) or 0) or None
    )
    source = node.get("orgURL") or node.get("url")
    return {
        "name": _nice(html.unescape(str(node.get("name") or "")))[:60] or None,
        "items": items,
        "steps": steps,
        "minutes": minutes if minutes and minutes <= 1440 else None,
        "servings": _servings_of(node.get("recipeServings") or node.get("recipeYield")),
        "source": source if isinstance(source, str) and source.startswith("http") else None,
        "image_url": _image_url(node.get("image")) if isinstance(node.get("image"), (dict, list)) or str(node.get("image") or "").startswith("http") else None,
    }


def _recipes_in_json(data: Any) -> list[dict[str, Any]]:
    """Alle schema.org/Mealie-Rezepte in einer JSON-Datei (ein Rezept, Liste oder @graph)."""
    nodes: list[dict[str, Any]] = []

    def walk(n: Any, depth: int = 0) -> None:
        if depth > 6 or len(nodes) >= MAX_FILE_RECIPES:
            return
        if isinstance(n, list):
            for sub in n:
                walk(sub, depth + 1)
        elif isinstance(n, dict):
            kind = n.get("@type")
            kinds = kind if isinstance(kind, list) else [kind]
            if "Recipe" in kinds or ("recipeIngredient" in n and n.get("name")):
                nodes.append(n)
                return
            for key in ("@graph", "mainEntity", "itemListElement", "recipes", "items", "data"):
                if key in n:
                    walk(n[key], depth + 1)

    walk(data)
    return [recipe_from_schema(n) for n in nodes]


def _data_url(raw: bytes, name: str) -> str | None:
    ext = "." + name.rsplit(".", 1)[-1].lower() if "." in name else ""
    mime = _IMG_EXT.get(ext)
    if not mime or not raw or len(raw) > MAX_IMAGE:
        return None
    return f"data:{mime};base64,{base64.b64encode(raw).decode()}"


def parse_recipe_file(data: bytes, filename: str | None = None) -> list[dict[str, Any]]:
    """🍲 Mealie-Export (.zip mit .json + Bild, oder nur die .json) bzw. schema.org-JSON lesen.

    Gibt die Rezepte zurück (nichts gespeichert). Eigenes Format -> OwnFormat (dann nimmt
    der normale Datei-Import). Kaputt/leer -> ValueError mit verständlicher Meldung.
    """
    import io
    import zipfile

    if not data:
        raise ValueError("Die Datei ist leer.")
    if len(data) > MAX_FILE:
        raise ValueError("Die Datei ist zu groß (höchstens 25 MB).")
    name = (filename or "").lower()
    if data[:2] == b"PK" or name.endswith(".zip"):
        try:
            zf = zipfile.ZipFile(io.BytesIO(data))
        except zipfile.BadZipFile as err:
            raise ValueError("Die .zip-Datei ist kaputt.") from err
        recipes: list[dict[str, Any]] = []
        images = [i for i in zf.infolist() if not i.is_dir() and i.file_size <= MAX_IMAGE and ("." + i.filename.rsplit(".", 1)[-1].lower()) in _IMG_EXT]
        for info in zf.infolist():
            if info.is_dir() or not info.filename.lower().endswith(".json") or info.file_size > 5 * 1024 * 1024:
                continue
            try:
                found = _recipes_in_json(json.loads(zf.read(info).decode("utf-8-sig")))
            except (ValueError, UnicodeDecodeError):
                continue
            folder = info.filename.rsplit("/", 1)[0] if "/" in info.filename else ""
            for rec in found:
                # 📷 Bild aus der .zip: „original“ im selben Ordner zuerst (so legt Mealie es ab)
                near = sorted(
                    (i for i in images if not folder or i.filename.startswith(folder)),
                    key=lambda i: (0 if "original" in i.filename.lower() and "min-" not in i.filename.lower() and "tiny" not in i.filename.lower() else 1, -i.file_size),
                )
                if near:
                    rec["image"] = _data_url(zf.read(near[0]), near[0].filename)
                recipes.append(rec)
        if not recipes:
            raise ValueError("In der .zip habe ich kein Rezept gefunden (es fehlt die .json von Mealie).")
        return recipes[:MAX_FILE_RECIPES]
    try:
        parsed = json.loads(data.decode("utf-8-sig"))
    except (ValueError, UnicodeDecodeError) as err:
        raise OwnFormat("kein JSON") from err
    recipes = _recipes_in_json(parsed)
    if not recipes:
        raise OwnFormat("kein schema.org/Mealie-Rezept")
    return recipes[:MAX_FILE_RECIPES]
