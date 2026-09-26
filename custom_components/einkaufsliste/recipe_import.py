"""📋 Rezept einfügen: Zutaten aus Text oder aus einem Rezept-Link herausholen."""

from __future__ import annotations

import asyncio
import base64
import html
import ipaddress
import json
import logging
import re
from typing import Any
from urllib.parse import urlparse

import aiohttp

from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .const import VERSION

_LOGGER = logging.getLogger(__name__)

USER_AGENT = f"HomeAssistant-Einkaufsliste/{VERSION} (github.com/misterm2310/einkaufslisten-card)"
MAX_PAGE = 3 * 1024 * 1024
MAX_IMAGE = 3 * 1024 * 1024

# Mengen-Einheiten, die vor dem Produktnamen stehen dürfen („200 g Mehl“, „1 Prise Salz“)
UNITS = (
    "g", "gr", "gramm", "kg", "mg", "ml", "cl", "dl", "l", "liter",
    "el", "tl", "essl", "teel", "essl.", "teel.", "esslöffel", "teelöffel",
    "msp", "prise", "prisen", "stk", "stück", "st", "pck", "päckchen", "pkt", "packung", "packungen",
    "dose", "dosen", "becher", "bund", "zehe", "zehen", "tasse", "tassen", "scheibe", "scheiben",
    "glas", "gläser", "flasche", "flaschen", "beutel", "würfel", "kugel", "kugeln", "handvoll",
    "schuss", "spritzer", "tropfen", "blatt", "blätter", "zweig", "zweige", "stange", "stangen",
    "kopf", "köpfe", "knolle", "knollen", "rolle", "rollen", "netz", "schale", "schalen",
)
_FRACTIONS = {"½": "1/2", "¼": "1/4", "¾": "3/4", "⅓": "1/3", "⅔": "2/3", "⅛": "1/8"}
_NUM = r"(?:\d+(?:[.,]\d+)?(?:\s*/\s*\d+)?|\d*\s*[½¼¾⅓⅔⅛])(?:\s*-\s*\d+(?:[.,]\d+)?)?"
_UNIT = "|".join(sorted((re.escape(u) for u in UNITS), key=len, reverse=True))
_LINE = re.compile(rf"^(?P<qty>{_NUM})\s*(?P<unit>(?:{_UNIT})\.?(?=\s|$))?\s*(?P<rest>.*)$", re.IGNORECASE)
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
    for k, v in _FRACTIONS.items():
        line = line.replace(k, f" {v}")
    line = _BULLET.sub("", line).strip()
    if not line or len(line) > 120 or line.endswith(":") or _SKIP.match(line):
        return None
    qty = None
    m = _LINE.match(line)
    if m and m.group("rest"):
        num = re.sub(r"\s+", "", m.group("qty"))
        unit = (m.group("unit") or "").rstrip(".")
        qty = f"{num} {unit}".strip() if unit else f"{num}x"
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
        }
    return {"name": None, "items": [], "image_url": None, "steps": None}


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
    return "\n".join(out)[:8000] or None


def _is_local(host: str) -> bool:
    host = host.strip("[]").lower()
    if host in ("localhost", "homeassistant", "homeassistant.local") or host.endswith(".local"):
        return True
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return False
    return ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved


async def _download(session: aiohttp.ClientSession, url: str, limit: int) -> tuple[bytes, str] | None:
    try:
        async with asyncio.timeout(15):
            resp = await session.get(url, headers={"User-Agent": USER_AGENT}, allow_redirects=True)
            if resp.status != 200:
                return None
            raw = await resp.content.read(limit + 1)
            if len(raw) > limit:
                return None
            return raw, resp.headers.get("Content-Type", "")
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
        got = await _download(session, first, MAX_PAGE)
        if got is None:
            raise ValueError("Die Seite konnte nicht geladen werden. Kopier lieber die Zutaten als Text rein.")
        page = got[0].decode("utf-8", errors="replace")
        info = parse_html(page)
        if not info["items"]:
            raise ValueError("Auf der Seite habe ich keine Zutaten-Liste gefunden. Kopier sie lieber als Text rein.")
        result.update(source="link", name=info["name"], items=info["items"], steps=info.get("steps"))
        img_url = info.get("image_url")
        if isinstance(img_url, str) and img_url.startswith("http"):
            img = await _download(session, img_url, MAX_IMAGE)
            if img and (img[0][:3] == b"\xff\xd8\xff" or img[0][:8] == b"\x89PNG\r\n\x1a\n" or img[0][8:12] == b"WEBP"):
                mime = "image/png" if img[0][:4] == b"\x89PNG" else "image/webp" if img[0][8:12] == b"WEBP" else "image/jpeg"
                result["image"] = f"data:{mime};base64,{base64.b64encode(img[0]).decode()}"
    else:
        result["items"] = parse_text(text)
        if not result["items"]:
            raise ValueError("Ich habe keine Zutaten erkannt. Am besten eine Zutat pro Zeile, z. B. „200 g Mehl“.")
    for item in result["items"]:
        hist = manager.history_for(item["name"]) or {}
        item["store_id"] = hist.get("store_id") if manager.store_by_id(hist.get("store_id")) else None
        cat = hist.get("category_id") or manager.guess_category(item["name"])
        item["category_id"] = cat if manager.category_by_id(cat) else None
    return result
