"""🥫 Produkte aus Grocy holen (REST-API von Grocy, Anmeldung mit dem Header GROCY-API-KEY).

Der API-Schlüssel wird nur für diese eine Abfrage benutzt und NICHT gespeichert.
Übernommen werden Name, Barcodes und die Produktgruppe (als Kategorie) – kein Lagerbestand, keine Standorte.
"""

from __future__ import annotations

import asyncio
import csv
import json
import logging
import re
from typing import TYPE_CHECKING, Any
from urllib.parse import urlsplit

import aiohttp

from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .netutil import read_limited

if TYPE_CHECKING:
    from .manager import EinkaufslisteManager

_LOGGER = logging.getLogger(__name__)

MAX_BYTES = 8 * 1024 * 1024
MAX_PRODUCTS = 3000


def clean_base(url: Any) -> str:
    """Aus dem, was jemand tippt, die Grundadresse machen („192.168.1.5:9283/api/“ -> „http://192.168.1.5:9283“)."""
    raw = str(url or "").strip()
    if not raw:
        raise ValueError("Bitte die Grocy-Adresse eintragen, z. B. http://192.168.1.20:9283")
    if "://" not in raw:
        raw = "http://" + raw
    try:
        parts = urlsplit(raw)
        host = parts.hostname
    except ValueError as err:
        raise ValueError("Die Grocy-Adresse sieht nicht richtig aus.") from err
    if parts.scheme not in ("http", "https") or not host or parts.username or parts.password:
        raise ValueError("Die Grocy-Adresse sieht nicht richtig aus – z. B. http://192.168.1.20:9283")
    path = parts.path.rstrip("/")
    if path.endswith("/api"):
        path = path[:-4]
    return f"{parts.scheme}://{parts.netloc}{path}"


async def _request(session: aiohttp.ClientSession, method: str, base: str, key: str, endpoint: str,
                   body: dict | None = None, params: dict | None = None) -> Any:
    """Eine Anfrage an die Grocy-API. Antwort als JSON (bei „kein Inhalt“ None). Fehler als verständliche ValueError."""
    try:
        async with asyncio.timeout(20):
            resp = await session.request(
                method, f"{base}/api/{endpoint}", params=params, json=body,
                headers={"GROCY-API-KEY": key, "accept": "application/json"},
            )
            if resp.status in (401, 403):
                raise ValueError("Grocy lehnt den API-Schlüssel ab – bitte prüfen (in Grocy beim Benutzer unter „API-Schlüssel“).")
            if resp.status == 404:
                raise ValueError("Unter dieser Adresse habe ich kein Grocy gefunden – stimmt Adresse und Port?")
            if resp.status >= 400:
                raise ValueError(f"Grocy antwortet mit Fehler {resp.status}.")
            raw = await read_limited(resp.content, MAX_BYTES)
    except (TimeoutError, aiohttp.ClientError) as err:
        _LOGGER.debug("Grocy nicht erreichbar: %s", err)
        raise ValueError("Grocy ist von Home Assistant aus nicht erreichbar – Adresse und Netzwerk prüfen.") from err
    if raw is None:
        raise ValueError("Die Antwort von Grocy ist ungewöhnlich groß – abgebrochen.")
    if not raw.strip():
        return None
    try:
        return json.loads(raw)
    except ValueError as err:
        raise ValueError("Grocy hat keine lesbare Antwort geschickt – ist das die richtige Adresse?") from err


async def _get(session: aiohttp.ClientSession, base: str, key: str, endpoint: str, params: dict | None = None) -> Any:
    return await _request(session, "GET", base, key, endpoint, params=params)


async def async_fetch(hass, url: Any, api_key: Any) -> dict[str, Any]:
    """Produkte, Barcodes und Produktgruppen von Grocy holen und zu Zeilen für die Vorschau machen."""
    key = str(api_key or "").strip()
    if not key:
        raise ValueError("Bitte den API-Schlüssel eintragen (in Grocy beim Benutzer unter „API-Schlüssel“ erzeugen).")
    base = clean_base(url)
    session = async_get_clientsession(hass)
    products = await _get(session, base, key, "objects/products")
    if not isinstance(products, list):
        raise ValueError("Grocy hat die Produkte in einem unbekannten Format geschickt.")
    try:  # Barcodes und Gruppen sind „nice to have“: Fehlt etwas, kommen die Produkte trotzdem
        barcodes = await _get(session, base, key, "objects/product_barcodes")
    except ValueError:
        barcodes = []
    try:
        groups = await _get(session, base, key, "objects/product_groups")
    except ValueError:
        groups = []
    return build_rows(products, barcodes if isinstance(barcodes, list) else [], groups if isinstance(groups, list) else [])


def _digits(code: Any) -> str:
    return "".join(ch for ch in str(code or "") if ch.isdigit())


def build_rows(products: list, barcodes: list, groups: list) -> dict[str, Any]:
    """Aus den rohen Grocy-Listen die Vorschau-Zeilen machen: {id, name, group, barcodes}."""
    group_name = {str(g.get("id")): str(g.get("name") or "").strip() for g in groups if isinstance(g, dict)}
    codes: dict[str, list[str]] = {}
    bad_codes = 0
    for b in barcodes:
        if not isinstance(b, dict):
            continue
        code = _digits(b.get("barcode"))
        if not 6 <= len(code) <= 14 or code != str(b.get("barcode") or "").strip():
            bad_codes += 1  # z. B. „MDETEST24“ oder zu kurz: kein Strichcode, den unsere Liste kennt
            continue
        lst = codes.setdefault(str(b.get("product_id")), [])
        if code not in lst:
            lst.append(code)
    rows: list[dict[str, Any]] = []
    inactive = 0
    for p in products:
        if not isinstance(p, dict):
            continue
        name = " ".join(str(p.get("name") or "").split())
        if not name:
            continue
        if str(p.get("active", "1")) == "0":
            inactive += 1
            continue
        rows.append({
            "id": str(p.get("id")),
            "name": name,
            "group": group_name.get(str(p.get("product_group_id")), "") or None,
            "barcodes": codes.get(str(p.get("id")), []),
        })
    rows.sort(key=lambda r: r["name"].lower())
    return {"rows": rows[:MAX_PRODUCTS], "more": max(0, len(rows) - MAX_PRODUCTS), "inactive": inactive, "bad_codes": bad_codes}


def import_rows(manager: EinkaufslisteManager, rows: list[dict[str, Any]], make_categories: bool = True) -> dict[str, int]:
    """Die gewählten Produkte in den Katalog legen. Was es schon gibt, wird übersprungen – nichts wird überschrieben."""
    added = exists = failed = codes_added = codes_skipped = cats_made = 0
    for row in rows[:MAX_PRODUCTS]:
        if not isinstance(row, dict):
            continue
        name = " ".join(str(row.get("name") or "").split())
        if not name or len(name) > 80:
            failed += 1
            continue
        if name.lower() in manager.history:
            exists += 1
            continue
        cat_id = None
        group = " ".join(str(row.get("group") or "").split())
        if group:
            cat = next((c for c in manager.categories if c["name"].strip().lower() == group.lower()), None)
            if cat is None and make_categories:
                cat = manager.add_group("categories", group[:40])
                cats_made += 1
            cat_id = cat["id"] if cat else None
        try:
            prod = manager.add_product(name, category_id=cat_id, note=row.get("note") or None)
        except ValueError:
            exists += 1
            continue
        added += 1
        for code in [str(c) for c in (row.get("barcodes") or [])][:10]:
            try:
                manager.add_product_barcode(prod["key"], code)
                codes_added += 1
            except ValueError:
                codes_skipped += 1  # gehört schon zu einem anderen Produkt
    return {"added": added, "exists": exists, "failed": failed, "codes_added": codes_added,
            "codes_skipped": codes_skipped, "categories_made": cats_made}


# ---------------------------------------------------------------- 📄 Katalog aus CSV / Text
_HEAD = {
    "name": {"name", "produkt", "artikel", "bezeichnung", "product", "item", "title", "titel"},
    "group": {"kategorie", "category", "gruppe", "group", "produktgruppe", "warengruppe"},
    "barcode": {"barcode", "ean", "gtin", "code", "strichcode"},
    "note": {"notiz", "note", "bemerkung", "kommentar", "comment", "marke", "brand"},
}


def parse_catalog_text(text: str) -> list[dict[str, Any]]:
    """CSV oder einfache Liste lesen: eine Zeile = ein Produkt.

    Trenner ; , oder Tab (wird erkannt). Mit Kopfzeile (Name, Kategorie, Barcode, Notiz – in beliebiger Reihenfolge)
    oder ohne: dann gilt die Reihenfolge Name; Kategorie; Barcode; Notiz.
    """
    lines = [ln for ln in str(text or "").replace("\r\n", "\n").replace("\r", "\n").split("\n") if ln.strip()]
    if not lines:
        return []
    sample = "\n".join(lines[:5])
    delim = max((";", "\t", ","), key=lambda d: sample.count(d))
    if sample.count(delim) == 0:
        delim = "\x00"  # keine Spalten: jede Zeile ist ein Name
    rows = list(csv.reader(lines, delimiter=delim)) if delim != "\x00" else [[ln] for ln in lines]
    cols = {"name": 0, "group": 1, "barcode": 2, "note": 3}
    first = [c.strip().lower() for c in rows[0]]
    mapped = {k: i for i, c in enumerate(first) for k, names in _HEAD.items() if c in names}
    if "name" in mapped:  # Kopfzeile
        cols = {k: mapped.get(k) for k in cols}
        rows = rows[1:]
    out: list[dict[str, Any]] = []
    for r in rows:
        def cell(key: str) -> str:
            i = cols.get(key)
            return " ".join(r[i].split()) if i is not None and i < len(r) else ""
        name = cell("name")
        if not name:
            continue
        codes = [c for c in re.split(r"[\s,;|]+", cell("barcode")) if c.isdigit() and 6 <= len(c) <= 14]
        out.append({"name": name, "group": cell("group") or None, "barcodes": codes, "note": cell("note")[:80] or None})
    return out
