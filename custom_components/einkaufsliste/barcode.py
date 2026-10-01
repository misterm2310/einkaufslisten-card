"""Barcode nachschlagen: erst im eigenen Gedächtnis, dann bei Open Food Facts & Co."""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import re
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import aiohttp

from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .const import VERSION
from .netutil import photo_complete, read_limited

_LOGGER = logging.getLogger(__name__)

# Offene, kostenlose Produkt-Datenbanken (Lebensmittel, Drogerie, Sonstiges)
SOURCES = [
    ("Open Food Facts", "https://world.openfoodfacts.org"),
    ("Open Beauty Facts", "https://world.openbeautyfacts.org"),
    ("Open Products Facts", "https://world.openproductsfacts.org"),
]
FIELDS = "product_name,product_name_de,generic_name_de,brands,categories_tags,stores_tags"
USER_AGENT = f"HomeAssistant-Einkaufsliste/{VERSION} (github.com/misterm2310/einkaufslisten-card)"

# Stichwort in den Kategorien der Datenbank -> passende Kategorie-Namen bei dir
CATEGORY_HINTS: list[tuple[tuple[str, ...], tuple[str, ...]]] = [
    (("frozen", "surgele", "tiefkuhl"), ("tk", "tiefkühl", "tiefkuehl")),
    (("beverage", "drink", "water", "juice", "soda", "beer", "wine", "coffee", "tea"), ("getränk", "getraenk")),
    (("dair", "milk", "cheese", "yogurt", "yoghurt", "butter", "cream"), ("kühl", "kuehl", "milch")),
    (("bread", "baker", "pastr", "viennoiser"), ("back", "brot")),
    (("fruit", "vegetable", "salad"), ("obst", "gemüse", "gemuese")),
    (("meat", "sausage", "ham", "poultr", "fish", "seafood"), ("fleisch", "wurst", "fisch")),
    (("sweet", "chocolate", "candie", "confection", "biscuit", "snack", "chips"), ("süß", "suess", "snack")),
    (("pasta", "rice", "canned", "cereal", "sauce", "condiment", "spice", "flour", "oil"), ("vorrat", "konserve")),
    (("cleaning", "detergent", "household"), ("haushalt",)),
]


def _clean_code(code: str) -> str:
    return re.sub(r"\D", "", code or "")


def guess_category(tags: list[str], source: str, categories: list[dict[str, Any]]) -> str | None:
    """Rät die passende Kategorie aus deinen eigenen Kategorien."""
    joined = " ".join(tags or []).lower()
    wanted: tuple[str, ...] = ()
    if source == "Open Beauty Facts":
        wanted = ("drogerie",)
    else:
        for keywords, names in CATEGORY_HINTS:
            if any(k in joined for k in keywords):
                wanted = names
                break
    for cat in categories:
        if any(w in cat["name"].lower() for w in wanted):
            return cat["id"]
    return None


# 🏷️ Eigenmarken: gibt's nur in einer Kette. Stehen in data/eigenmarken.json (nach Land) – ohne Python ergänzbar.
_BRANDS_FILE = Path(__file__).parent / "data" / "eigenmarken.json"


def load_private_labels(path: Path = _BRANDS_FILE) -> dict[str, dict[str, tuple[str, ...]]]:
    """{"DE": {"aldi": ("milsani", …)}, "AT": {…}} – Schlüssel mit „_“ (Erklärungen) werden übersprungen."""
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as err:
        _LOGGER.error("🏷️ Eigenmarken-Liste %s nicht lesbar: %s", path, err)
        return {}
    out: dict[str, dict[str, tuple[str, ...]]] = {}
    for country, chains in raw.items():
        if country.startswith("_") or not isinstance(chains, dict):
            continue
        out[country.upper()] = {
            str(k).lower(): tuple(str(b).strip().lower() for b in v or [] if str(b).strip())
            for k, v in chains.items() if not str(k).startswith("_")
        }
    return out


PRIVATE_LABELS_BY_COUNTRY = load_private_labels()  # einmal beim Laden der Integration


def private_labels(country: str | None) -> dict[str, tuple[str, ...]]:
    """Eigenmarken fürs Land aus den HA-Einstellungen – kennt die Liste das Land nicht, gelten alle zusammen."""
    if country and country.upper() in PRIVATE_LABELS_BY_COUNTRY:
        return PRIVATE_LABELS_BY_COUNTRY[country.upper()]
    merged: dict[str, tuple[str, ...]] = {}
    for chains in PRIVATE_LABELS_BY_COUNTRY.values():
        for key, labels in chains.items():
            merged[key] = tuple(dict.fromkeys(merged.get(key, ()) + labels))
    return merged


def private_label_store(manager: Any, brands: str | None, stores_tags: list[str] | None = None) -> tuple[str | None, str | None]:
    """(Geschäfts-ID, Geschäfts-Name) für eine Eigenmarke – oder (None, None).

    1. Eigene Marken, die beim Geschäft in ⚙️ eingetragen sind.
    2. Die eingebaute Eigenmarken-Liste (nur wenn es das Geschäft in deiner Liste gibt).
    3. Die Produkt-Datenbank kennt genau EIN Geschäft, und das gibt es bei dir.
    """
    wanted = [b.strip().lower() for b in (brands or "").split(",") if b.strip()]
    stores = manager.stores
    for brand in wanted:
        for st in stores:
            own = [b.strip().lower() for b in (st.get("brands") or []) if b and b.strip()]
            if brand in own:
                return st["id"], st["name"]
    for brand in wanted:
        for key, labels in private_labels(getattr(getattr(getattr(manager, "hass", None), "config", None), "country", None)).items():
            if brand in labels:
                st = next((x for x in stores if key in x["name"].lower().replace("-", " ").split() or x["name"].lower().startswith(key)), None)
                if st:
                    return st["id"], st["name"]
    tags = [t.split(":")[-1].replace("-", " ") for t in (stores_tags or [])]
    if len(tags) == 1:
        st = next((x for x in stores if tags[0] and (tags[0] in x["name"].lower() or x["name"].lower() in tags[0])), None)
        if st:
            return st["id"], st["name"]
    return None, None


def _product_name(product: dict[str, Any]) -> tuple[str | None, str | None]:
    """(Name, Marke) – die Marke kommt als Notiz: „Pizza Salami · Wagner“."""
    name = " ".join(
        (
            product.get("product_name_de")
            or product.get("product_name")
            or product.get("generic_name_de")
            or ""
        ).split()
    )
    brand = (product.get("brands") or "").split(",")[0].strip()
    if not name and not brand:
        return None, None
    if not name:
        return brand, None
    if brand:
        # Marke vorne/hinten aus dem Namen nehmen („Wagner Pizza Salami“ -> „Pizza Salami“)
        low, b = name.lower(), brand.lower()
        if low.startswith(b + " "):
            name = name[len(brand):].strip(" -–,")
        elif low.endswith(" " + b):
            name = name[: -len(brand)].strip(" -–,")
        if not name or name.lower() == b:
            return brand, None
    return name, brand or None


async def async_lookup(hass: HomeAssistant, manager: Any, code: str) -> dict[str, Any]:
    """Barcode nachschlagen. Gibt immer ein Ergebnis zurück (found True/False)."""
    code = _clean_code(code)
    if not code:
        raise ValueError("Das ist kein gültiger Barcode.")

    known = manager.barcodes.get(code)
    if known:
        return {
            "code": code,
            "found": True,
            "source": "gemerkt",
            "name": known["name"],
            "note": known.get("note"),
            "store_id": known.get("store_id") if manager.store_by_id(known.get("store_id")) else None,
            "category_id": known.get("category_id")
            if manager.category_by_id(known.get("category_id"))
            else None,
        }

    session = async_get_clientsession(hass)
    for source, base in SOURCES:
        url = f"{base}/api/v2/product/{code}.json"
        try:
            async with asyncio.timeout(8):
                resp = await session.get(
                    url, params={"fields": FIELDS}, headers={"User-Agent": USER_AGENT}
                )
                if resp.status == 404:
                    continue
                if resp.status != 200:
                    _LOGGER.debug("%s antwortet mit %s", source, resp.status)
                    continue
                data = await resp.json(content_type=None)
        except (TimeoutError, aiohttp.ClientError, ValueError) as err:
            _LOGGER.debug("%s nicht erreichbar: %s", source, err)
            continue
        if not isinstance(data, dict) or data.get("status") != 1:
            continue
        product = data.get("product") or {}
        name, brand = _product_name(product)
        if not name:
            continue
        pl_store, pl_name = private_label_store(manager, product.get("brands"), product.get("stores_tags"))
        return {
            "code": code,
            "found": True,
            "source": source,
            "name": name,
            "note": brand,
            "store_id": pl_store,
            "private_label": pl_name,
            "category_id": guess_category(
                product.get("categories_tags") or [], source, manager.categories
            ),
        }
    return {"code": code, "found": False}


# Bilder nur von den offiziellen Bild-Servern der Datenbanken laden
IMAGE_HOSTS = (
    "images.openfoodfacts.org",
    "images.openbeautyfacts.org",
    "images.openproductsfacts.org",
    "static.openfoodfacts.org",
    "static.openbeautyfacts.org",
    "static.openproductsfacts.org",
)
IMAGE_FIELDS = "image_front_url,image_front_small_url,image_url"
MAX_IMAGE = 3 * 1024 * 1024


async def _image_url(session: aiohttp.ClientSession, code: str) -> str | None:
    for source, base in SOURCES:
        try:
            async with asyncio.timeout(8):
                resp = await session.get(
                    f"{base}/api/v2/product/{code}.json",
                    params={"fields": IMAGE_FIELDS},
                    headers={"User-Agent": USER_AGENT},
                )
                if resp.status != 200:
                    continue
                data = await resp.json(content_type=None)
        except (TimeoutError, aiohttp.ClientError, ValueError) as err:
            _LOGGER.debug("%s nicht erreichbar: %s", source, err)
            continue
        if not isinstance(data, dict) or data.get("status") != 1:
            continue
        product = data.get("product") or {}
        for key in IMAGE_FIELDS.split(","):
            url = product.get(key)
            if isinstance(url, str) and url.startswith("https://") and urlparse(url).hostname in IMAGE_HOSTS:
                return url
    return None


async def _download_photo(hass: HomeAssistant, code: str) -> bytes | None:
    """Das ganze Produktfoto zu einem Barcode holen – None, wenn es keins gibt oder es unvollständig ankam."""
    session = async_get_clientsession(hass)
    url = await _image_url(session, code)
    if not url:
        return None
    try:
        async with asyncio.timeout(20):
            resp = await session.get(url, headers={"User-Agent": USER_AGENT})
            if resp.status != 200:
                return None
            raw = await read_limited(resp.content, MAX_IMAGE)  # bis zum Ende lesen, nicht nur das erste Stück
    except (TimeoutError, aiohttp.ClientError) as err:
        _LOGGER.debug("Produktfoto nicht ladbar: %s", err)
        return None
    if not raw or not photo_complete(raw):
        _LOGGER.debug("Produktfoto unvollständig oder zu groß – verworfen")
        return None
    return raw


async def async_auto_photo(hass: HomeAssistant, manager: Any, code: str, name: str) -> bool:
    """📸 Produktfoto aus der Datenbank holen – aber nur, wenn es noch kein eigenes Foto gibt."""
    code = _clean_code(code)
    if not code or not name or manager.photos.get(name.strip().lower()):
        return False
    raw = await _download_photo(hass, code)
    if raw is None:
        return False
    # Inzwischen doch ein eigenes Foto gemacht? Dann das eigene behalten.
    if manager.photos.get(name.strip().lower()):
        return False
    try:
        await manager.async_set_photo(name, base64.b64encode(raw).decode(), db=True)
    except ValueError as err:
        _LOGGER.debug("Produktfoto abgelehnt: %s", err)
        return False
    return True


async def async_refresh_photo(hass: HomeAssistant, manager: Any, key: str, only_missing: bool = False, replace: bool = False) -> dict[str, Any]:
    """🔄 Foto zu einem Produkt neu aus der Datenbank holen (abgeschnittene alte Fotos werden ersetzt).

    replace=True („Alle Fotos neu holen“): das Datenbank-Foto wird durch das aktuelle ersetzt, eigene bleiben.
    only_missing=True („Alle Fotos neu holen“): ganze Fotos bleiben unangetastet, es kommt nichts doppelt dazu –
    nur abgeschnittene Fotos fliegen raus, und ein neues Foto kommt nur, wenn danach keins mehr da ist.
    """
    key = (key or "").strip().lower()
    codes = manager.barcodes_for(key)
    if not codes:
        raise ValueError("Dieses Produkt hat keinen Barcode – darum weiß die Datenbank nicht, welches Foto gemeint ist.")
    raw = None
    for code in codes:
        raw = await _download_photo(hass, code)
        if raw:
            break
    if raw is None:
        raise ValueError("Die Datenbank hat zu diesem Barcode kein (vollständiges) Foto, oder sie ist gerade nicht erreichbar.")
    dropped = await manager.async_drop_cut_photos(key)  # kaputte alte Fotos raus
    if replace:  # „Alle Fotos neu holen“: Datenbank-Foto ersetzen, eigene Fotos bleiben
        status = await manager.async_replace_db_photo(key, raw)
        return {"key": key, "status": status, "fixed": dropped}
    if only_missing and manager.photos.get(key):
        return {"key": key, "count": 1 + len(manager.photos[key].get("more", [])), "fixed": dropped, "added": False}
    label = (manager.photos.get(key) or {}).get("name") or key
    name = label if manager.photos.get(key) else manager.product_label(key)
    result = await manager.async_set_photo(name, base64.b64encode(raw).decode(), add=bool(manager.photos.get(key)))
    return {"key": key, "count": result.get("count", 1), "fixed": dropped, "added": True}


# ℹ️ Produkt-Infos (nur auf Nachfrage: beim Draufdrücken aufs Produkt)
INFO_FIELDS = "product_name,product_name_de,brands,quantity,nutriscore_grade,nova_group,allergens_tags,traces_tags,labels_tags,ingredients_text_de,ingredients_text"
ALLERGENS_DE = {
    "gluten": "Gluten", "milk": "Milch", "eggs": "Eier", "nuts": "Schalenfrüchte (Nüsse)",
    "peanuts": "Erdnüsse", "soybeans": "Soja", "fish": "Fisch", "crustaceans": "Krebstiere",
    "molluscs": "Weichtiere", "celery": "Sellerie", "mustard": "Senf", "sesame-seeds": "Sesam",
    "sulphur-dioxide-and-sulphites": "Schwefeldioxid/Sulfite", "lupin": "Lupinen",
}
LABELS_DE = {
    "organic": "Bio", "eu-organic": "EU-Bio", "vegan": "Vegan", "vegetarian": "Vegetarisch",
    "gluten-free": "Glutenfrei", "no-lactose": "Laktosefrei", "lactose-free": "Laktosefrei",
    "fair-trade": "Fairtrade", "palm-oil-free": "Ohne Palmöl",
}


def _tags(tags: list[str] | None, names: dict[str, str]) -> list[str]:
    out: list[str] = []
    for tag in tags or []:
        key = str(tag).split(":", 1)[-1]
        label = names.get(key)
        if label and label not in out:
            out.append(label)
    return out


async def async_product_info(hass: HomeAssistant, code: str) -> dict[str, Any]:
    code = _clean_code(code)
    if not code:
        raise ValueError("Zu diesem Produkt ist kein Barcode hinterlegt.")
    session = async_get_clientsession(hass)
    for source, base in SOURCES:
        try:
            async with asyncio.timeout(8):
                resp = await session.get(
                    f"{base}/api/v2/product/{code}.json",
                    params={"fields": INFO_FIELDS},
                    headers={"User-Agent": USER_AGENT},
                )
                if resp.status != 200:
                    continue
                data = await resp.json(content_type=None)
        except (TimeoutError, aiohttp.ClientError, ValueError):
            continue
        if not isinstance(data, dict) or data.get("status") != 1:
            continue
        p = data.get("product") or {}
        grade = str(p.get("nutriscore_grade") or "").lower()
        return {
            "found": True,
            "code": code,
            "source": source,
            "name": _product_name(p)[0],
            "brand": (p.get("brands") or "").split(",")[0].strip() or None,
            "quantity": p.get("quantity") or None,
            "nutriscore": grade.upper() if grade in ("a", "b", "c", "d", "e") else None,
            "nova": p.get("nova_group") or None,
            "allergens": _tags(p.get("allergens_tags"), ALLERGENS_DE),
            "traces": _tags(p.get("traces_tags"), ALLERGENS_DE),
            "labels": _tags(p.get("labels_tags"), LABELS_DE),
            "ingredients": (p.get("ingredients_text_de") or p.get("ingredients_text") or "")[:1500] or None,
        }
    return {"found": False, "code": code}
