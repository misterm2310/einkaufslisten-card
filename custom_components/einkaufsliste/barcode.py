"""Barcode nachschlagen: erst im eigenen Gedächtnis, dann bei Open Food Facts & Co."""

from __future__ import annotations

import asyncio
import logging
import re
from typing import Any

import aiohttp

from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .const import VERSION

_LOGGER = logging.getLogger(__name__)

# Offene, kostenlose Produkt-Datenbanken (Lebensmittel, Drogerie, Sonstiges)
SOURCES = [
    ("Open Food Facts", "https://world.openfoodfacts.org"),
    ("Open Beauty Facts", "https://world.openbeautyfacts.org"),
    ("Open Products Facts", "https://world.openproductsfacts.org"),
]
FIELDS = "product_name,product_name_de,generic_name_de,brands,categories_tags"
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


def _product_name(product: dict[str, Any]) -> str | None:
    name = (
        product.get("product_name_de")
        or product.get("product_name")
        or product.get("generic_name_de")
        or ""
    ).strip()
    brand = (product.get("brands") or "").split(",")[0].strip()
    if not name and not brand:
        return None
    if brand and brand.lower() not in name.lower():
        return f"{brand} {name}".strip()
    return name


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
        name = _product_name(product)
        if not name:
            continue
        return {
            "code": code,
            "found": True,
            "source": source,
            "name": name,
            "store_id": None,
            "category_id": guess_category(
                product.get("categories_tags") or [], source, manager.categories
            ),
        }
    return {"code": code, "found": False}
