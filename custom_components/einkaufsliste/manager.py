"""Das Herzstück: speichert Geschäfte, Kategorien, Artikel und Rezepte."""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import re
import secrets
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import date, datetime, time, timedelta
import logging
from pathlib import Path
from typing import Any
import uuid

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.dispatcher import async_dispatcher_send
from homeassistant.helpers.event import async_track_time_change, async_track_time_interval
from homeassistant.helpers.storage import Store
from homeassistant.util import dt as dt_util

from .categories import category_hints, guess_category
from .netutil import photo_file_complete
from .quantity import UNIT_CHOICES, apply_unit, is_bare, norm_qty, split_qty, split_qty_ex, unit_of
from .const import (
    CATEGORY_COLORS,
    CONF_CLEANUP_TIME,
    CONF_CLEANUP_WEEKDAY,
    CONF_MIN_AGE_DAYS,
    DEFAULT_CATEGORIES,
    DEFAULT_OPTIONS,
    DEFAULT_STORES,
    EVENT_CLEANUP,
    EVENT_ITEM_ADDED,
    HISTORY_LIMIT,
    ERROR_LIMIT,
    OFFER_OPEN_DAYS,
    PURCHASE_LIMIT,
    MAX_PHOTOS,
    RECIPE_GROUPS,
    RECIPE_GROUP_NAMES_EN,
    DEFAULT_CATEGORIES_EN,
    DEFAULT_STORES_EN,
    VERSION,
    PERSON_COLORS,
    LOG_DAY_CHOICES,
    LOG_DEFAULT_DAYS,
    LOG_LIMIT,
    SAVE_DELAY,
    SIGNAL_UPDATED,
    STORAGE_KEY,
    STORAGE_VERSION,
)

TYPO_LEARN_AFTER = 2  # so oft „Meintest du …?“ angenommen, dann wird von selbst korrigiert

_ACTOR: ContextVar[dict] = ContextVar("einkaufsliste_actor", default={})
_LOGGER = logging.getLogger(__name__)


def _new_id() -> str:
    return uuid.uuid4().hex[:12]


def _now_iso() -> str:
    return dt_util.utcnow().isoformat()


def _local_date(iso: str | None) -> date | None:
    if not iso:
        return None
    parsed = dt_util.parse_datetime(iso)
    if parsed is None:
        return None
    return dt_util.as_local(parsed).date()


def _clean(text: Any) -> str | None:
    if text is None:
        return None
    text = str(text).strip()
    return text or None


def _norm_name(text: Any) -> str:
    """„ALDI SÜD“ -> „aldi süd“, „Netto Marken-Discount“ -> „netto marken discount“"""
    return re.sub(r"\s+", " ", re.sub(r"[^\wäöüß]+", " ", str(text or "").lower())).strip()


def _nice(text: Any) -> str | None:
    """Namen aufhübschen: Leerzeichen säubern, erster Buchstabe groß.

    „  milch “ -> „Milch“. Wörter wie „iPhone“ bleiben, wie sie sind.
    """
    text = _clean(text)
    if not text:
        return text
    text = " ".join(text.split())
    if text[0].islower() and (len(text) == 1 or not text[1].isupper()):
        text = text[0].upper() + text[1:]
    return text


def _servings(value: Any) -> int | None:
    """👥 Für wie viele Personen ist das Rezept? (leer = nicht angegeben)"""
    try:
        n = int(value)
    except (TypeError, ValueError):
        return None
    return n if 1 <= n <= 99 else None


def _servings_unit(value: Any) -> str:
    """👥 Personen oder 🍰 Bleche (z. B. beim Kuchen)."""
    return "trays" if value == "trays" else "persons"


def _default_recipe_groups(english: bool = False) -> list[dict[str, Any]]:
    """🏷️ Start-Liste der Rezept-Gruppen (änderbar in ⚙️ → Rezept-Gruppen)."""
    return [
        {"id": key, "name": RECIPE_GROUP_NAMES_EN.get(key, name) if english else name, "icon": icon,
         "color": CATEGORY_COLORS[k % len(CATEGORY_COLORS)]}
        for k, (key, (name, icon)) in enumerate(RECIPE_GROUPS.items())
    ]


def _abc(entry: dict[str, Any]) -> tuple[str, str]:
    """🔤 Sortier-Schlüssel A–Z wie im Telefonbuch: Ä wie A, ß wie ss, groß/klein egal."""
    def fold(text: Any) -> str:
        text = str(text or "").casefold()
        for a, b in (("ä", "a"), ("ö", "o"), ("ü", "u"), ("ß", "ss")):
            text = text.replace(a, b)
        return text
    return fold(entry.get("name")), fold(entry.get("note"))


def product_key(name: str | None, note: str | None = None) -> str:
    """Ein Produkt = Name + Notiz („Käse · Gouda“ ≠ „Käse · Leerdammer“) – für Fotos und Barcodes.

    „Für wen“ spielt hier absichtlich keine Rolle: Leerdammer bleibt Leerdammer, egal für wen –
    gleiche Packung, gleicher Barcode, gleiches Foto.
    """
    name = (_clean(name) or "").lower()
    note = (_clean(note) or "").lower()
    return f"{name}|{note}" if note else name


def _note(text: Any) -> str | None:
    """Notiz immer mit Großbuchstaben am Anfang („bio“ -> „Bio“)."""
    text = _clean(text)
    return text[:1].upper() + text[1:] if text else None


def _own(text: Any) -> str | None:
    """✏️ Eigene Notiz: wie die Notiz mit Großbuchstaben am Anfang, aber nicht Teil des Produktnamens (und höchstens 120 Zeichen)."""
    text = _note(text)
    return text[:120] if text else None


def _clean_steps(text: Any) -> str | None:
    """Zubereitung: ein Schritt pro Zeile, leere Zeilen raus."""
    if not text:
        return None
    lines = [" ".join(line.split()) for line in str(text).splitlines()]
    lines = [line for line in lines if line]
    return "\n".join(lines)[:8000] or None


def _clean_heat(rows: Any) -> list[dict[str, Any]]:
    """🔥 Backofen & Co.: Gerät, Modus, Grad, Minuten, Vorheizen, Hinweis – höchstens 6 Zeilen."""
    out: list[dict[str, Any]] = []
    for raw in rows or []:
        if not isinstance(raw, dict):
            continue

        def num(v: Any, hi: int) -> int | None:
            try:
                n = int(float(str(v).replace(",", ".")))
            except (TypeError, ValueError):
                return None
            return n if 0 < n <= hi else None

        row = {
            "device": (_clean(raw.get("device")) or "Backofen")[:30],
            "mode": (_clean(raw.get("mode")) or "")[:40] or None,
            "temp": num(raw.get("temp"), 1500),
            "minutes": num(raw.get("minutes"), 1440),
            "minutes_to": num(raw.get("minutes_to"), 1440),  # „15–20 Min“
            "preheat": bool(raw.get("preheat")),
            "note": (_clean(raw.get("note")) or "")[:60] or None,
        }
        if row["minutes_to"] and (not row["minutes"] or row["minutes_to"] <= row["minutes"]):
            row["minutes_to"] = None
        if row["mode"] or row["temp"] or row["minutes"] or row["note"]:
            out.append(row)
    return out[:6]


def purchase_photo_key(purchase_id: str) -> str:
    """🧾📷 Bon-Foto zu einem Protokoll-Eintrag: Schlüssel „bon#<id>“ bei den Produkt-Fotos."""
    return f"bon#{purchase_id}".lower()


def recipe_step_photo_key(recipe_id: str, step: int) -> str:
    """📷 Foto zu einem Kochschritt (0 = erster Schritt): liegt bei den Produkt-Fotos, Schlüssel „rezept#<id>#s<n>“."""
    return f"rezept#{recipe_id}#s{int(step)}".lower()


def recipe_step_count(recipe: dict[str, Any]) -> int:
    return len([ln for ln in re.split(r"\n+", str(recipe.get("steps") or "")) if ln.strip()])


def recipe_photo_key(recipe_id: str) -> str:
    """Rezept-Fotos liegen bei den Produkt-Fotos, aber mit eigenem Schlüssel."""
    return f"rezept#{recipe_id}".lower()


def _key(
    name: str | None,
    note: str | None,
    for_whom: str | None,
    store_id: str | None,
    recipe_id: str | None = None,
) -> tuple[str, str, str, str, str]:
    """Zwei Artikel sind gleich, wenn Name, Notiz, „für wen“, Geschäft und Rezept gleich sind."""
    return (
        (_clean(name) or "").lower(),
        (_clean(note) or "").lower(),
        (_clean(for_whom) or "").lower(),
        store_id or "",
        recipe_id or "",
    )


def _icon(value: Any, default: str) -> str:
    """„dog“ oder „mdi:dog“ -> „mdi:dog“."""
    value = _clean(value)
    if not value:
        return default
    return value if ":" in value else f"mdi:{value.lower()}"


@callback
def person_name_for_user(hass: HomeAssistant, user_id: str | None) -> str | None:
    """Sucht die Person (person.xyz), die zu einem HA-Benutzer gehört."""
    if not user_id:
        return None
    for state in hass.states.async_all("person"):
        if state.attributes.get("user_id") == user_id:
            return state.attributes.get("friendly_name") or state.name
    return None


AUTO_CATEGORY: Any = object()  # add_item: „Kategorie nicht angegeben“ (≠ ausdrücklich keine)


class EinkaufslisteManager:
    """Verwaltet alle Daten der Einkaufsliste."""

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry) -> None:
        self.hass = hass
        self.entry = entry
        self._store: Store = Store(hass, STORAGE_VERSION, STORAGE_KEY)
        self.stores: list[dict[str, Any]] = []
        self.categories: list[dict[str, Any]] = []
        self.items: list[dict[str, Any]] = []
        self.recipes: list[dict[str, Any]] = []
        self.persons: list[dict[str, Any]] = []
        self.recipe_groups: list[dict[str, Any]] = []  # 🏷️ Fisch, Fleisch, Gebäck … (mit Icon)
        self.photos: dict[str, dict[str, Any]] = {}  # Produktname (klein) -> Foto
        self.seen: dict[str, dict[str, str]] = {}  # Benutzer -> Geschäft -> zuletzt angeschaut
        self.barcodes: dict[str, dict[str, Any]] = {}  # Barcode -> gelernter Artikel
        self.aliases: dict[str, dict[str, Any]] = {}  # 🏷️ Spitzname (klein) -> {"name", "note"} des Produkts
        self.typos: dict[str, dict[str, Any]] = {}  # 🧠 Tippfehler (klein) -> {"right": Name, "n": wie oft korrigiert}
        self.pin_hash: str | None = None  # 🔒 PIN für die Einstellungen (nur als Prüfsumme gespeichert)
        self.mascot: bool = False  # 🛒😊 Maskottchen an/aus – gilt für alle Karten und Handys
        self.spend: bool = False  # 🧾 Einkaufs-Protokoll an/aus (standardmäßig aus) – gilt für alle
        self.auto_shop: bool = False  # 📍 Laden-Modus geht in der Zone von selbst an – ein Schalter für alle Geräte
        self.spend_auto: bool = False  # 🧾 Protokoll von selbst anbieten, wenn alles abgehakt ist (Option, standardmäßig aus)
        self.health_cache: dict[str, Any] = {}  # 🩺 letztes Ergebnis für den Gesundheits-Sensor
        self.purchases: list[dict[str, Any]] = []  # 🧾 {"id","t","s","sn","w","wi","a"} – wer, wann, wo, wie viel
        self.todo_syncs: list[dict[str, Any]] = []  # 🔁 je To-do-Liste {"entity_id", "store_id", "count", "mode", "links"} – herüberholen
        self.offers_cfg: dict[str, Any] | None = None  # 🏷️ {"enabled", "zip", "stores", "hours", "key", "last", "ok", "error", "count"}
        self.offers_data: dict[str, list[dict[str, Any]]] = {}  # 🏷️ Artikelname klein -> Angebote
        self.mail_seen: list[str] = []  # 📧 zuletzt eingetragene Mails (Nummer|Datum) – gegen doppeltes Eintragen
        self.mail_import: dict[str, Any] | None = None  # 📧 {"entry_id", "store_id", "senders", "count"} – per E-Mail
        self.photo_dir = Path(hass.config.path("einkaufsliste_fotos"))
        self.history: dict[str, dict[str, Any]] = {}
        self.last_cleanup: str | None = None
        self.log: list[dict[str, Any]] = []  # 📋 Verlauf, das Neueste hinten
        self.log_days: int = LOG_DEFAULT_DAYS
        self.errors: list[dict[str, Any]] = []  # 🐞 Fehler-Protokoll: {"t","w","m","n"} – das Neueste hinten
        self.missed_hidden: dict[str, str] = {}  # 📈 „Oft nicht bekommen“ weggeklickt: "name|geschäft" -> seit wann
        self._actor = {}
        self._unsub_time: Callable[[], None] | None = None

    # ------------------------------------------------------------------ Optionen
    def _opt(self, key: str) -> Any:
        return self.entry.options.get(key, DEFAULT_OPTIONS[key])

    @property
    def cleanup_weekday(self) -> int:
        return int(self._opt(CONF_CLEANUP_WEEKDAY))

    @property
    def cleanup_time(self) -> tuple[int, int]:
        parts = str(self._opt(CONF_CLEANUP_TIME)).split(":")
        try:
            return int(parts[0]), int(parts[1]) if len(parts) > 1 else 0
        except ValueError:
            return 3, 0

    @property
    def min_age_days(self) -> int:
        return int(self._opt(CONF_MIN_AGE_DAYS))

    # ------------------------------------------------------------ Laden/Speichern
    async def async_load(self) -> None:
        data = await self._store.async_load()
        if data is None:
            # 🌍 Erstes Einrichten: Startwerte in der Sprache von Home Assistant (Deutsch oder sonst Englisch)
            english = not str(getattr(self.hass.config, "language", "de") or "de").lower().startswith("de")
            self.stores = [
                {"id": _new_id(), "name": n, "color": c, "icon": i}
                for n, c, i in (DEFAULT_STORES_EN if english else DEFAULT_STORES)
            ]
            self.categories = [
                {"id": _new_id(), "name": n, "icon": i, "color": CATEGORY_COLORS[k % len(CATEGORY_COLORS)]}
                for k, (n, i) in enumerate(DEFAULT_CATEGORIES_EN if english else DEFAULT_CATEGORIES)
            ]
            self.recipe_groups = _default_recipe_groups(english)
            self.last_cleanup = _now_iso()
            self._schedule_save()
            return
        self.stores = data.get("stores", [])
        self.categories = data.get("categories", [])
        self.items = data.get("items", [])
        self.recipes = data.get("recipes", [])
        self.history = data.get("history", {})
        self.last_cleanup = data.get("last_cleanup")
        tidied = False  # 🔢 alte Mengen einheitlich schreiben („1“ -> „1x“, „1/2 tl“ -> „0,5 TL“)
        for item in self.items:  # ältere Daten auffüllen
            item.setdefault("for_whom", None)
            item.setdefault("recipe_id", None)
            item["note"] = _note(item.get("note"))
            new_qty = norm_qty(item.get("quantity"))
            tidied |= new_qty != item.get("quantity")
            item["quantity"] = new_qty
        for recipe in self.recipes:
            recipe.setdefault("steps", None)
            recipe.setdefault("heat", [])
            recipe.setdefault("servings", None)
            recipe.setdefault("servings_unit", "persons")
            recipe.setdefault("group", None)
            for entry in recipe.get("items", []):
                entry["note"] = _note(entry.get("note"))
                new_qty = norm_qty(entry.get("quantity"))
                tidied |= new_qty != entry.get("quantity")
                entry["quantity"] = new_qty
                entry.setdefault("basic", False)
            recipe["items"] = sorted(recipe.get("items", []), key=_abc)  # 🔤 Zutaten A–Z
        self.photos = data.get("photos", {})
        self.seen = data.get("seen", {})
        for mine in self.seen.values():  # älter als v2.2.0: Blasen-Zeiten („b:…“) nachrüsten
            if not any(k.startswith("b:") for k in mine):
                for key, value in list(mine.items()):
                    mine["b:" + key] = value
        for k, cat in enumerate(self.categories):  # ältere Daten: Farben nachrüsten
            cat.setdefault("color", CATEGORY_COLORS[k % len(CATEGORY_COLORS)])
        self.barcodes = data.get("barcodes", {})
        self.aliases = data.get("aliases", {})
        self.typos = data.get("typos", {})
        self.pin_hash = data.get("pin")
        self.mascot = bool(data.get("mascot", False))
        self.spend = bool(data.get("spend", False))
        self.spend_auto = bool(data.get("spend_auto", False))
        self.auto_shop = bool(data.get("auto_shop", False))
        self.purchases = list(data.get("purchases") or [])
        raw_sync = data.get("todo_syncs")
        if raw_sync is None and data.get("todo_sync"):  # ♻️ früher gab es nur eine Liste
            raw_sync = [data["todo_sync"]]
        self.todo_syncs = [c for c in (raw_sync or []) if isinstance(c, dict) and c.get("entity_id")]
        self.mail_import = data.get("mail_import") or None
        self.mail_seen = [str(k) for k in (data.get("mail_seen") or [])][-50:]
        self.offers_cfg = data.get("offers_cfg") or None
        self.offers_data = dict(data.get("offers_data") or {})
        for store in self.stores:  # 📍 früher eine Zone pro Geschäft, jetzt beliebig viele
            if "zones" not in store:
                store["zones"] = [store["zone"]] if store.get("zone") else []
            store["zone"] = store["zones"][0] if store["zones"] else None
        self.log = data.get("log", [])
        self.log_days = int(data.get("log_days", LOG_DEFAULT_DAYS))
        self.missed_hidden = dict(data.get("missed_hidden") or {})
        self.errors = [e for e in (data.get("errors") or []) if isinstance(e, dict)][-ERROR_LIMIT:]
        if "persons" in data:
            self.persons = data["persons"]
        else:
            # Erstes Update: schon benutzte „für wen“-Namen als Personen übernehmen
            names: list[str] = []
            for entry in self.items + [ri for r in self.recipes for ri in r["items"]]:
                name = _clean(entry.get("for_whom"))
                if name and name.lower() not in (n.lower() for n in names):
                    names.append(name)
            self.persons = [{"id": _new_id(), "name": n} for n in names]
            if names:
                self._schedule_save()
        for k, person in enumerate(self.persons):  # ältere Daten: Farben nachrüsten
            person.setdefault("color", PERSON_COLORS[k % len(PERSON_COLORS)])
        if "recipe_groups" in data:
            self.recipe_groups = data["recipe_groups"]
            for k, grp in enumerate(self.recipe_groups):  # 🎨 Farben nachrüsten
                grp.setdefault("color", CATEGORY_COLORS[k % len(CATEGORY_COLORS)])
        else:  # erstes Update mit Rezept-Gruppen: fertige Liste zum Start
            self.recipe_groups = _default_recipe_groups()
            self._schedule_save()
        if tidied:  # aufgeräumte Mengen gleich dauerhaft speichern
            self._schedule_save()

    def _to_storage(self) -> dict[str, Any]:
        return {
            "stores": self.stores,
            "categories": self.categories,
            "items": self.items,
            "recipes": self.recipes,
            "persons": self.persons,
            "recipe_groups": self.recipe_groups,
            "photos": self.photos,
            "barcodes": self.barcodes,
            "seen": self.seen,
            "history": self.history,
            "aliases": self.aliases,
            "typos": self.typos,
            "pin": self.pin_hash,
            "mascot": self.mascot,
            "spend": self.spend,
            "spend_auto": self.spend_auto,
            "auto_shop": self.auto_shop,
            "purchases": self.purchases,
            "todo_syncs": self.todo_syncs,
            "mail_import": self.mail_import,
            "mail_seen": self.mail_seen[-50:],
            "offers_cfg": self.offers_cfg,
            "offers_data": self.offers_data,
            "last_cleanup": self.last_cleanup,
            "log": self.log,
            "log_days": self.log_days,
            "missed_hidden": self.missed_hidden,
            "errors": self.errors,
        }

    def _schedule_save(self) -> None:
        self._store.async_delay_save(self._to_storage, SAVE_DELAY)

    async def async_save_now(self) -> None:
        await self._store.async_save(self._to_storage())

    @callback
    def _changed(self) -> None:
        self._schedule_save()
        async_dispatcher_send(self.hass, SIGNAL_UPDATED)

    # ------------------------------------------------------------------ Ausgabe
    def next_cleanup(self, now: datetime | None = None) -> datetime:
        now = dt_util.as_local(now or dt_util.now())
        hour, minute = self.cleanup_time
        candidate = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
        candidate += timedelta(days=(self.cleanup_weekday - now.weekday()) % 7)
        if candidate <= now:
            candidate += timedelta(days=7)
        return candidate

    def last_scheduled_cleanup(self, now: datetime | None = None) -> datetime:
        now = dt_util.as_local(now or dt_util.now())
        hour, minute = self.cleanup_time
        candidate = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
        candidate -= timedelta(days=(now.weekday() - self.cleanup_weekday) % 7)
        if candidate > now:
            candidate -= timedelta(days=7)
        return candidate

    @callback
    def as_dict(self) -> dict[str, Any]:
        history = sorted(
            self.history.values(), key=lambda h: (-h.get("count", 0), h["name"].lower())
        )
        return {
            "stores": self.stores,
            "categories": self.categories,
            "items": self.items,
            "recipes": self.recipes,
            "persons": self.persons,
            "photos": {k: v.get("updated") for k, v in self.photos.items()},
            "photo_counts": {k: 1 + len(v["more"]) for k, v in self.photos.items() if v.get("more")},
            "version": VERSION,
            "recipe_groups": self.recipe_groups,
            "category_hints": category_hints(self.categories),
            "seen": self.seen,
            "history": history[:300],
            "barcodes_by_name": self._barcodes_by_name(),
            "aliases": [{"alias": a, "name": t["name"], "note": t.get("note")} for a, e in sorted(self.aliases.items()) for t in self._al_targets(e)],
            "typos": {k: v["right"] for k, v in self.typos.items() if v.get("n", 0) >= TYPO_LEARN_AFTER},
            "scanned_new": len({product_key(b.get("name"), b.get("note")) for b in self.barcodes.values() if b.get("new") and b.get("name")}),
            "settings": {
                "cleanup_weekday": self.cleanup_weekday,
                "cleanup_time": "%02d:%02d" % self.cleanup_time,
                "min_age_days": self.min_age_days,
                "next_cleanup": self.next_cleanup().isoformat(),
                "pin": bool(self.pin_hash),
                "app_url": self._app_url(),
                "mascot": self.mascot,
                "spend": self.spend,
                "spend_auto": self.spend_auto,
                "auto_shop": self.auto_shop,
                "todo_syncs": [self._todo_sync_info(c) for c in self.todo_syncs],
                "mail_import": self._mail_import_info(),
                "offers": self._offers_info(),
                "errors": len(self.errors),
                "errors_24h": self._errors_since(timedelta(hours=24)),
            },
            "missed": self.missed_counts(),
            "offers": self.offers_data if (self.offers_cfg or {}).get("enabled") else {},
            "missed_hidden": self.missed_hidden,
        }

    def _todo_sync_info(self, cfg: dict[str, Any]) -> dict[str, Any]:
        st = self.hass.states.get(cfg["entity_id"])
        info = {k: v for k, v in cfg.items() if k != "links"}
        return {**info, "mode": info.get("mode", "move"), "name": st.name if st else cfg["entity_id"],
                "ok": st is not None and st.state != "unavailable"}

    def store_for_retailer(self, retailer: str | None) -> str | None:
        """🏷️ „ALDI SÜD“ -> dein Geschäft „Aldi“ (am Namen erkannt)."""
        r = _norm_name(retailer)
        if not r:
            return None
        best_len = 0
        best_id: str | None = None
        for st in self.stores:
            n = _norm_name(st["name"])
            if not n:
                continue
            if n == r:
                return st["id"]
            if (n in r.split() or r.startswith(n + " ") or n.startswith(r + " ")) and len(n) > best_len:
                best_len, best_id = len(n), st["id"]
        return best_id

    @staticmethod
    def _parse_offer_dt(value: Any, end_of_day: bool = False) -> datetime | None:
        """Datum/Zeit robust lesen: ohne Zeitzone gilt lokale Zeit, nur Datum = Tagesanfang (bzw. -ende)."""
        text = str(value or "").strip()
        if not text:
            return None
        try:
            dt = None if re.fullmatch(r"\d{4}-\d{2}-\d{2}", text) else dt_util.parse_datetime(text)
            if dt is None:
                d = dt_util.parse_date(text)
                if d is None:
                    return None
                dt = datetime.combine(d, time(23, 59, 59) if end_of_day else time(0, 0))
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=dt_util.DEFAULT_TIME_ZONE)
            return dt
        except (ValueError, TypeError):
            return None

    @staticmethod
    def offer_note(offer: dict[str, Any]) -> str:
        """„🏷️ 1,19 € bis Sa.“ – liegt der Start in der Zukunft: „🏷️ 1,19 € ab Mo.“"""
        price = f"{float(offer.get('p') or 0):.2f}".replace(".", ",")
        names = ["Mo.", "Di.", "Mi.", "Do.", "Fr.", "Sa.", "So."]
        start = EinkaufslisteManager._parse_offer_dt(offer.get("from"))
        end = EinkaufslisteManager._parse_offer_dt(offer.get("to"), end_of_day=True)
        if start is not None and start > dt_util.utcnow():
            return f"🏷️ {price} € ab {names[dt_util.as_local(start).weekday()]}"
        if end is not None:
            return f"🏷️ {price} € bis {names[dt_util.as_local(end).weekday()]}"
        return f"🏷️ {price} €"

    def take_offer(self, offer: dict[str, Any], item_id: str | None = None, name: str | None = None,
                   store_id: str | None = None, by: str | None = None, by_id: str | None = None) -> dict[str, Any]:
        """🛒 Angebot übernehmen: neuer Artikel mit dem Namen des Angebots (im Geschäft des Angebots),
        das Angebot steht in einem eigenen Feld (nicht in der Notiz), das ursprüngliche Produkt wird abgehakt.
        Artikel aus Angeboten verschwinden beim Abhaken ganz."""
        store_id = self._check_store(store_id)
        original = self.get_item(item_id) if item_id else None
        if original is None and name:  # „Angebote suchen“: offenes Produkt mit diesem Namen auf der Liste?
            low = name.strip().lower()
            original = next((i for i in self.items if not i["checked"] and not i.get("from_offer")
                             and not i.get("recipe_id") and i["name"].strip().lower() == low), None)
        offer_name = (offer.get("d") or name or (original or {}).get("name") or "").strip()
        created = False
        if original is not None and (not offer_name or offer_name.lower() == original["name"].strip().lower()):
            item = original  # gleicher Name = dein Produkt: das Angebot hängt nur daran, es wird nie gelöscht
            if store_id is not None and item["store_id"] != store_id and not item["checked"]:
                item = self.move_item(item["id"], store_id or "~none", by, by_id)
            original = None
        else:
            before = len(self.items)
            item = self.add_item(offer_name, store_id=store_id, added_by=by, added_by_id=by_id, from_offer=True)
            created = len(self.items) > before  # gab es den Artikel schon, ist er dein Produkt
        if created:
            item["from_offer"] = True  # erst durch das Angebot entstanden: verschwindet mit dem Angebot
            if original is not None:  # dein ursprüngliches Produkt merken, damit es danach zurückkommt
                item["orig"] = {"id": original["id"], "name": original["name"], "added_at": original.get("added_at"),
                                "added_by": original.get("added_by"), "added_by_id": original.get("added_by_id")}
        item["offer"] = {"to": offer.get("to"), "from": offer.get("from"), "r": offer.get("r"), "p": offer.get("p"),
                         "taken": _now_iso()}  # „taken“: ohne Enddatum zählen die 14 Tage ab hier
        self._log("update", item, f"Angebot {offer.get('r') or ''} {self.offer_note(offer)}".strip(), who=by)
        if original is not None and not original["checked"]:
            self.set_checked(original["id"], True, by, by_id)  # das eigentliche Produkt ist „erledigt“
        self._changed()
        return item

    @callback
    def expire_offers(self, now: datetime | None = None) -> int:
        """⌛ Abgelaufene Angebote: „⌛ Angebot vorbei“ steht noch 1 Tag. Danach fällt das Angebot weg –
        bei deinem Produkt bleibt der Artikel, ein durch das Angebot entstandener Artikel wird gelöscht
        und dein ursprüngliches Produkt kommt wieder auf die Liste (Datum der ersten Eingabe bleibt)."""
        now = now or dt_util.utcnow()
        n = 0
        gone_items: list[dict[str, Any]] = []
        for item in list(self.items):
            try:
                off = item.get("offer")
                if not off:
                    continue
                if off.get("expired"):
                    gone = self._parse_offer_dt(off["expired"])
                    if gone is not None and now - gone >= timedelta(days=1):
                        if item.get("from_offer"):
                            gone_items.append(item)  # 1 Tag „Angebot vorbei“ ist um – Angebots-Artikel raus
                        else:
                            item.pop("offer", None)
                        n += 1
                    continue
                if off.get("to"):
                    to = self._parse_offer_dt(off["to"], end_of_day=True)
                else:  # 📅 ohne Enddatum: nach 14 Tagen (ab Übernahme) wie abgelaufen
                    taken = self._parse_offer_dt(off.get("taken"))
                    if taken is None:
                        off["taken"] = now.isoformat()  # alte Angebote ohne Datum: ab jetzt zählen
                        continue
                    to = taken + timedelta(days=OFFER_OPEN_DAYS)
                if to is None or to > now:
                    continue
                part = off.get("part") or ""
                note = item.get("note") or ""
                if part and part in note:  # alte Artikel (vor 2.39): Angebot steckte in der Notiz
                    note = note.replace(" · " + part, "").replace(part, "").strip(" ·")
                    item["note"] = note or None
                item["offer"] = {"expired": now.isoformat()}
                n += 1
            except Exception:  # noqa: BLE001 – ein kaputtes Angebot darf nie alle anderen blockieren
                _LOGGER.exception("Angebot konnte nicht geprüft werden: %s", item.get("name"))
        for item in gone_items:
            try:
                self.items.remove(item)
                self._log("remove", item, "Angebot vorbei", who="automatisch")
                orig = item.get("orig") or {}
                old = next((i for i in self.items if i["id"] == orig.get("id")), None)
                if old is not None and old["checked"] and not any(
                        i is not old and not i["checked"] and i["name"].lower() == old["name"].lower()
                        and i["store_id"] == old["store_id"] for i in self.items):
                    self.set_checked(old["id"], False, None, None)  # dein Produkt zurück auf die Liste …
                    old.update(added_at=orig.get("added_at") or old.get("added_at"),  # … mit dem alten Datum
                               added_by=orig.get("added_by"), added_by_id=orig.get("added_by_id"))
            except Exception:  # noqa: BLE001
                _LOGGER.exception("Abgelaufenes Angebot konnte nicht entfernt werden")
        if n:
            self._changed()
        return n

    def _offers_info(self) -> dict[str, Any] | None:
        """🏷️ Angebote-Einstellungen für die Karte (ohne Schlüssel)."""
        cfg = self.offers_cfg
        if not cfg:
            return None
        return {k: cfg.get(k) for k in ("enabled", "zip", "stores", "hours", "last", "ok", "error", "count")}

    def set_offers(self, enabled: bool, zip_code: str | None = None, stores: list[str] | None = None,
                   hours: int | None = None) -> dict[str, Any] | None:
        """🏷️ Angebote ein-/ausschalten (inoffiziell über Marktguru)."""
        from .offers import INTERVALS  # noqa: PLC0415

        cfg = dict(self.offers_cfg or {})
        if enabled:
            zip_code = re.sub(r"\D", "", str(zip_code or cfg.get("zip") or ""))
            if not 4 <= len(zip_code) <= 5:
                raise ValueError("Bitte deine Postleitzahl eintragen.")
            cfg.update(enabled=True, zip=zip_code,
                       stores=[s for s in (stores if stores is not None else cfg.get("stores", [])) if self.store_by_id(s)],
                       hours=hours if hours in INTERVALS else cfg.get("hours", 6), last=None)
            self.offers_cfg = cfg
        else:
            if cfg:
                cfg["enabled"] = False
            self.offers_cfg = cfg or None
            self.offers_data = {}
        if getattr(self, "offers", None) is not None:
            self.offers.start()
        self._changed()
        return self._offers_info()

    def _mail_import_info(self) -> dict[str, Any] | None:
        if not self.mail_import:
            return None
        entry = self.hass.config_entries.async_get_entry(self.mail_import["entry_id"])
        return {**self.mail_import, "name": (entry.title if entry else None) or "IMAP", "ok": entry is not None}

    def set_mail_import(self, entry_id: str | None, store_id: str | None = None, senders: list[str] | None = None,
                        after: str | None = None) -> None:
        """📧 Postfach (IMAP) für „per E-Mail auf die Liste“ wählen (None = aus)."""
        if entry_id:
            entry = self.hass.config_entries.async_get_entry(entry_id)
            if entry is None or entry.domain != "imap":
                raise ValueError("Dieses Postfach gibt es nicht. Erst in Home Assistant die Integration „IMAP“ einrichten.")
            clean: list[str] = []
            for raw in senders or []:
                for part in re.split(r"[,;\s]+", str(raw)):
                    part = part.strip().lower()
                    if not part:
                        continue
                    if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", part):
                        raise ValueError(f"„{part}“ ist keine E-Mail-Adresse.")
                    if part not in clean:
                        clean.append(part)
            if not clean:
                raise ValueError("Bitte mindestens einen erlaubten Absender eintragen – sonst dürfte jeder etwas auf die Liste schicken.")
            store_id = self._check_store(store_id)
            count = self.mail_import.get("count", 0) if self.mail_import and self.mail_import.get("entry_id") == entry_id else 0
            if after not in (None, "keep", "seen", "delete"):
                raise ValueError("Unbekannte Auswahl, was mit der Mail passieren soll.")
            self.mail_import = {"entry_id": entry_id, "store_id": store_id, "senders": clean[:20], "count": count,
                                "after": after or "keep"}
        else:
            self.mail_import = None
        self._changed()
        mail = getattr(self, "mail", None)
        if mail is not None:
            mail.start()

    def set_mascot(self, on: bool) -> None:
        """🛒😊 Maskottchen für alle an- oder ausschalten."""
        self.mascot = bool(on)
        self._changed()

    # ------------------------------------------------------------------ 🧾 Einkaufs-Protokoll
    def set_spend(self, on: bool) -> None:
        """🧾 Einkaufs-Protokoll für alle an- oder ausschalten (die Einträge bleiben erhalten)."""
        self.spend = bool(on)
        self._changed()

    def set_auto_shop(self, on: bool) -> None:
        """📍 Laden-Modus automatisch für alle an- oder ausschalten."""
        self.auto_shop = bool(on)
        self._changed()

    def set_spend_auto(self, on: bool) -> None:
        """🧾 Option: Protokoll von selbst anbieten, sobald alles abgehakt ist (gilt für alle)."""
        self.spend_auto = bool(on)
        self._changed()

    def get_purchases(self) -> dict[str, Any]:
        if not self.spend:
            raise ValueError("Das Einkaufs-Protokoll ist ausgeschaltet (⚙️ → Extras).")
        return {"entries": sorted(self.purchases, key=lambda e: e.get("t", ""), reverse=True)}

    def add_purchase(self, store_id: str | None, amount: Any, day: str | None = None) -> dict[str, Any]:
        """🧾 Nach dem Einkauf: Geschäft + Betrag. Wer und wann setzen wir selbst (Datum nur, wenn es ein anderer Tag war)."""
        if not self.spend:
            raise ValueError("Das Einkaufs-Protokoll ist ausgeschaltet (⚙️ → Extras).")
        store = self.store_by_id(store_id) if store_id else None
        if store is None:
            raise ValueError("Bei welchem Geschäft war das?")
        try:
            value = round(float(str(amount).strip().replace("€", "").replace(" ", "").replace(",", ".")), 2)
        except (TypeError, ValueError) as err:
            raise ValueError("Der Betrag ist keine Zahl – z. B. 23,40.") from err
        if not 0 < value <= 100000:
            raise ValueError("Der Betrag muss größer als 0 sein.")
        now = dt_util.now()
        when = now
        if day:
            try:
                d = datetime.strptime(str(day)[:10], "%Y-%m-%d").date()
            except ValueError as err:
                raise ValueError("Das Datum ist ungültig.") from err
            if d > now.date():
                raise ValueError("Das Datum liegt in der Zukunft.")
            if d != now.date():
                when = datetime.combine(d, time(12, 0), tzinfo=now.tzinfo)
        actor = self._actor
        entry = {
            "id": _new_id(), "t": when.isoformat(), "s": store["id"], "sn": store["name"],
            "w": actor.get("who"), "wi": actor.get("who_id"), "a": value,
        }
        self.purchases.append(entry)
        if len(self.purchases) > PURCHASE_LIMIT:
            self.purchases = self.purchases[-PURCHASE_LIMIT:]
        self._log("buy", {"name": f"Einkauf bei {store['name']}", "store_id": store["id"]}, f"{value:.2f} €".replace(".", ","))
        self._changed()
        return entry

    def remove_purchase(self, purchase_id: str) -> None:
        if not self.spend:
            raise ValueError("Das Einkaufs-Protokoll ist ausgeschaltet (⚙️ → Extras).")
        before = len(self.purchases)
        self.purchases = [e for e in self.purchases if e["id"] != purchase_id]
        if len(self.purchases) == before:
            raise ValueError("Diesen Eintrag gibt es nicht (mehr).")
        bon = purchase_photo_key(purchase_id)  # 🧾📷 Bon-Foto geht mit dem Eintrag
        if bon in self.photos:
            self.hass.async_create_task(self.async_remove_photo(bon))
        self._changed()

    def set_todo_sync(self, entity_id: str | None, store_id: str | None = None, mode: str | None = None) -> None:
        """🔁 To-do-Liste zum automatischen Herüberholen hinzufügen oder ändern (jede Liste: eigenes Geschäft + eigene Art).

        entity_id=None: alle Listen aus (so ging es früher mit nur einer Liste).
        """
        if not entity_id:
            self.todo_syncs = []
        else:
            if not entity_id.startswith("todo.") or self.hass.states.get(entity_id) is None:
                raise ValueError("Diese To-do-Liste gibt es nicht.")
            store_id = self._check_store(store_id)
            same = next((c for c in self.todo_syncs if c["entity_id"] == entity_id), None)
            if same is None and len(self.todo_syncs) >= 10:
                raise ValueError("Mehr als 10 To-do-Listen sind zu viel des Guten 😉")
            mode = mode or (same or {}).get("mode") or "move"
            if mode not in ("move", "keep", "sync"):
                raise ValueError("Unbekannte Art des Abgleichs.")
            cfg = {"entity_id": entity_id, "store_id": store_id, "count": (same or {}).get("count", 0), "mode": mode,
                   "links": (same or {}).get("links", {}) if mode != "move" else {}}
            if same is None:
                self.todo_syncs.append(cfg)
            else:
                self.todo_syncs[self.todo_syncs.index(same)] = cfg
        self._changed()
        sync = getattr(self, "sync", None)
        if sync is not None:
            sync.start()

    def remove_todo_sync(self, entity_id: str) -> None:
        """🔁 Eine To-do-Liste nicht mehr herüberholen."""
        before = len(self.todo_syncs)
        self.todo_syncs = [c for c in self.todo_syncs if c["entity_id"] != entity_id]
        if len(self.todo_syncs) == before:
            raise ValueError("Diese To-do-Liste war gar nicht verknüpft.")
        self._changed()
        sync = getattr(self, "sync", None)
        if sync is not None:
            sync.start()

    def _app_url(self) -> str | None:
        """📱 Adresse der Offline-App von unterwegs (Nabu Casa bzw. externe https-Adresse)."""
        try:
            from homeassistant.helpers.network import NoURLAvailableError, get_url  # noqa: PLC0415
        except ImportError:  # pragma: no cover
            return None
        try:
            base = get_url(self.hass, allow_internal=False, allow_ip=False, require_ssl=True, prefer_cloud=True)
        except NoURLAvailableError:
            return None
        except Exception:  # noqa: BLE001 – lieber keine Adresse als ein Fehler
            return None
        return base.rstrip("/") + "/einkaufsliste/app/"

    def missed_counts(self) -> dict[str, int]:
        """📈 Wie oft gab es etwas bei einem Geschäft nicht? Schlüssel „name klein|geschäft-id“."""
        by_name = {st["name"].lower(): st["id"] for st in self.stores}
        out: dict[str, int] = {}
        for e in self.log:
            if not e.get("n") or e.get("a") not in ("out", "move"):
                continue
            if e["a"] == "out":
                sid = e.get("s")
            else:  # ⇄ verschoben – aus „Egal wo“ ist nur ein Umzug, kein „nicht bekommen“
                sid = by_name.get(str(e.get("d") or "").split(" → ")[0].strip().lower())
            if sid:
                key = f"{e['n'].lower()}|{sid}"
                if e.get("t", "") <= self.missed_hidden.get(key, ""):
                    continue  # ✖ weggeklickt: zählt erst ab da neu
                out[key] = out.get(key, 0) + 1
        return {k: v for k, v in out.items() if v >= 2}

    def hide_missed(self, name: str, store_id: str) -> None:
        """✖ „Oft nicht bekommen“ ausblenden („hab ich geregelt“) – der Verlauf bleibt, es zählt ab jetzt neu."""
        key = f"{(name or '').strip().lower()}|{store_id}"
        if not name or not self.store_by_id(store_id):
            raise ValueError("Diesen Eintrag gibt es nicht.")
        self.missed_hidden[key] = _now_iso()
        stores = {st["id"] for st in self.stores}
        if len(self.missed_hidden) > 300:  # nicht endlos wachsen
            self.missed_hidden = dict(sorted(self.missed_hidden.items(), key=lambda kv: kv[1])[-300:])
        self.missed_hidden = {k: v for k, v in self.missed_hidden.items() if k.rsplit("|", 1)[-1] in stores}
        self._changed()

    def _barcodes_by_name(self) -> dict[str, list[str]]:
        out: dict[str, list[str]] = {}
        for code, entry in self.barcodes.items():
            if entry.get("name"):
                out.setdefault(product_key(entry["name"], entry.get("note")), []).append(code)
        return out

    # ------------------------------------------------------------------ Produkt-Katalog
    def add_product(
        self, name: str, category_id: str | None = None, store_id: str | None = None, barcode: str | None = None
    ) -> dict[str, Any]:
        """📦 Neues Produkt direkt im Katalog – ohne es auf die Liste zu setzen (optional gleich mit Barcode)."""
        name = _nice(name or "")
        if not name or len(name) > 80:
            raise ValueError("Wie heißt das Produkt?")
        key = name.lower()
        if key in self.history:
            raise ValueError(f"„{self.history[key]['name']}“ gibt es schon.")
        code = "".join(ch for ch in str(barcode or "") if ch.isdigit())
        if barcode and not code:
            raise ValueError("Das ist kein gültiger Barcode.")
        if code and code in self.barcodes and self.barcodes[code].get("name"):
            raise ValueError(f"Der Barcode gehört schon zu „{self.barcodes[code]['name']}“.")
        self.history[key] = {
            "name": name,
            "count": 0,
            "store_id": store_id if self.store_by_id(store_id) else None,
            "category_id": category_id if self.category_by_id(category_id) else self.guess_category(name),
            "last_used": _now_iso(),
        }
        if code:
            h = self.history[key]
            self.learn_barcode(code, name, h["store_id"], h["category_id"])
        self._changed()
        return next((p for p in self.products() if p["key"] == product_key(name, None)), {"key": key, "name": name})

    def products(self) -> list[dict[str, Any]]:
        """Alle bekannten Produkte (Name + Notiz) mit Foto-, Barcode- und Verlaufs-Infos."""
        out: dict[str, dict[str, Any]] = {}

        def entry(name: str, note: str | None) -> dict[str, Any]:
            key = product_key(name, note)
            if key not in out:
                hist = self.history.get(name.lower()) or {}
                out[key] = {
                    "key": key,
                    "name": name,
                    "note": note,
                    "category_id": hist.get("category_id"),
                    "store_id": hist.get("store_id"),
                    "count": hist.get("count", 0),
                    "last_used": hist.get("last_used"),
                    "aliases": sorted(a for a, e in self.aliases.items() if any(product_key(t["name"], t.get("note")) == key for t in self._al_targets(e))),
                    "own_note": hist.get("own_note"),  # ✏️ Eigene Notiz
                    "unit": hist.get("unit"),  # 📏 gemerkte Einheit beim direkten Eintragen
                    "unit_fixed": bool(hist.get("unit_fixed")),
                    "stores": [sid for sid in hist.get("stores", []) if self.store_by_id(sid)],  # 🏪 gibt's bei …
                    "scanned": False,  # 📷 neu gescannt – noch nicht geprüft
                    "barcodes": [],
                    "photos": 0,
                    "open": 0,
                    "items": 0,
                    "last_bought": None,  # 🗓️ zuletzt abgehakt
                    "last_added": None,  # 🗓️ zuletzt eingetragen
                    "in_recipes": 0,  # 🍳 in so vielen Rezepten
                }
            return out[key]

        for hist in self.history.values():
            entry(hist["name"], None)
        for item in self.items:
            e = entry(item["name"], item.get("note"))
            e["items"] += 1
            if not item["checked"]:
                e["open"] += 1
            elif item.get("checked_at") and str(item["checked_at"]) > (e["last_bought"] or ""):
                e["last_bought"] = str(item["checked_at"])
            if item.get("added_at") and str(item["added_at"]) > (e["last_added"] or ""):
                e["last_added"] = str(item["added_at"])
            if item.get("category_id") and not e["category_id"]:
                e["category_id"] = item["category_id"]
            if item.get("store_id") and not e["store_id"]:
                e["store_id"] = item["store_id"]
        for recipe in self.recipes:
            for ri in recipe["items"]:
                e = entry(ri["name"], ri.get("note"))
                e["in_recipes"] += 1
                if ri.get("category_id") and not e["category_id"]:
                    e["category_id"] = ri["category_id"]
                if ri.get("store_id") and not e["store_id"]:
                    e["store_id"] = ri["store_id"]
        for code, bc in self.barcodes.items():
            if bc.get("name"):
                e = entry(bc["name"], bc.get("note"))
                e["barcodes"].append(code)
                if bc.get("new"):
                    e["scanned"] = True
                    e["scanned_at"] = max(e.get("scanned_at") or "", bc.get("updated") or "")
        for key, ph in self.photos.items():
            if key.startswith(("rezept#", "bon#")):
                continue
            name, _, note = (ph.get("name") or key).partition("|")
            e = out.get(key) or entry(name, note or None)
            e["photos"] = len(self._photo_ids(ph))
        # Einträge nur aus dem Verlauf, die es auch mit Notiz gibt, nicht doppelt zeigen
        names_with_note = {e["name"].lower() for e in out.values() if e["note"]}
        result = [
            e for e in out.values()
            if e["note"] or e["name"].lower() not in names_with_note
            or e["items"] or e["barcodes"] or e["photos"]
        ]
        return sorted(result, key=lambda e: (e["name"].lower(), (e["note"] or "").lower()))

    @callback
    def update_product(
        self,
        key: str,
        name: str | None = None,
        note: str | None = None,
        category_id: str | None = None,
        store_id: str | None = None,
        unit: str | None = None,
        stores: list[str] | None = None,
        own_note: str | None = None,
    ) -> dict[str, Any]:
        """Produkt im Katalog ändern – zieht Artikel, Rezepte, Fotos, Barcodes und Verlauf mit.

        unit: „Pck.“ usw. = fest eingestellte Einheit beim direkten Eintragen, "" = wieder selbst lernen.
        """
        key = (key or "").lower()
        prod = next((p for p in self.products() if p["key"] == key), None)
        if prod is None:
            raise ValueError("Dieses Produkt gibt es nicht (mehr).")
        new_name = _nice(name) if name is not None else prod["name"]
        if not new_name:
            raise ValueError("Der Name darf nicht leer sein.")
        new_note = _note(note) if note is not None else prod["note"]
        new_key = product_key(new_name, new_note)
        if new_key != key and any(p["key"] == new_key for p in self.products()):
            raise ValueError(
                f"„{new_name}“ gibt es schon – bitte „Zusammenführen“ benutzen.")
        cat = self._check_category(category_id) if category_id is not None else None
        store = self._check_store(store_id) if store_id is not None else None
        if unit and unit not in UNIT_CHOICES:
            raise ValueError("Diese Einheit gibt es nicht.")
        for thing in self.items + [ri for r in self.recipes for ri in r["items"]]:
            if product_key(thing["name"], thing.get("note")) == key:
                thing["name"], thing["note"] = new_name, new_note
                if category_id is not None:
                    thing["category_id"] = cat
        if store_id is not None:
            # Geschäft im Katalog hat Vorrang: Rezepte ziehen immer mit,
            # bereits abgehakte Artikel auf der Liste auch – aber offene
            # Artikel bleiben stehen, damit beim Einkaufen nichts "springt".
            for recipe in self.recipes:
                for ri in recipe["items"]:
                    if product_key(ri["name"], ri.get("note")) == new_key:
                        ri["store_id"] = store
            for item in list(self.items):
                if product_key(item["name"], item.get("note")) != new_key or not item["checked"]:
                    continue
                twin = self._find_same(
                    item["name"], item.get("note"), item.get("for_whom"), store,
                    item.get("recipe_id"), skip_id=item["id"],
                )
                if twin is not None:
                    self.items.remove(item)
                else:
                    item["store_id"] = store
        for bc in self.barcodes.values():
            if product_key(bc.get("name"), bc.get("note")) == key:
                bc.update(name=new_name, note=new_note)
                bc.pop("new", None)  # 📷 im Katalog gespeichert = geprüft
                if category_id is not None:
                    bc["category_id"] = cat
                if store_id is not None:
                    bc["store_id"] = store
        self._al_retarget(key, new_name, new_note)  # 🏷️ Spitznamen zeigen aufs neue Produkt
        if new_key != key and key in self.photos and new_key not in self.photos:
            self.photos[new_key] = self.photos.pop(key)
            self.photos[new_key]["name"] = new_key
        elif new_key == key and key in self.photos:
            self.photos[key]["name"] = new_key
        old_hist = self.history.get(prod["name"].lower())
        if old_hist is not None:
            old_hist["name"] = new_name
            if new_name.lower() != prod["name"].lower():
                self.history.pop(prod["name"].lower(), None)
                self.history.setdefault(new_name.lower(), old_hist)
            target = self.history[new_name.lower()]
            if category_id is not None:
                target["category_id"] = cat
            if store_id is not None:
                target["store_id"] = store
        elif category_id is not None or store_id is not None or unit:
            self.history[new_name.lower()] = {
                "name": new_name, "count": 0, "last_used": _now_iso(),
                "store_id": store if store_id is not None else prod["store_id"],
                "category_id": cat if category_id is not None else prod["category_id"],
            }
        if stores is not None:  # 🏪 „Gibt's bei“: mehrere Geschäfte
            valid = [sid for sid in dict.fromkeys(stores) if self.store_by_id(sid)]
            target = self.history.setdefault(new_name.lower(), {
                "name": new_name, "count": 0, "last_used": _now_iso(),
                "store_id": prod["store_id"], "category_id": prod["category_id"]})
            target["stores"] = valid
        if own_note is not None:  # ✏️ Eigene Notiz beim Produkt (und bei seinen Artikeln auf der Liste)
            own = _own(own_note)
            target = self.history.setdefault(new_name.lower(), {
                "name": new_name, "count": 0, "last_used": _now_iso(),
                "store_id": prod["store_id"], "category_id": prod["category_id"]})
            for thing in self.items:
                if thing["name"].lower() == new_name.lower() and not thing.get("recipe_id"):
                    if own:
                        thing["own_note"] = own
                    else:
                        thing.pop("own_note", None)
            if own:
                target["own_note"] = own
            else:
                target.pop("own_note", None)
        if unit is not None and new_name.lower() in self.history:
            target = self.history[new_name.lower()]
            if unit:  # 📏 im Katalog fest eingestellt – wird nicht mehr überschrieben
                target.update(unit=unit, unit_fixed=True)
            else:  # „automatisch“: wieder aus dem Eintragen lernen
                target.pop("unit", None)
                target.pop("unit_fixed", None)
        self._changed()
        return next((p for p in self.products() if p["key"] == new_key), {"key": new_key})

    def _learn_store(self, name: str, store_id: str | None) -> None:
        """Wo etwas gekauft wurde, gibt es das auch – für „Gibt's bei“ (mehrere Geschäfte pro Produkt)."""
        if not store_id or not self.store_by_id(store_id):
            return
        hist = self.history.get((name or "").lower())
        if hist is None:
            return
        stores = hist.setdefault("stores", [])
        if store_id not in stores:
            stores.append(store_id)
        # 🧠 Wo wird es wirklich gekauft? Jedes Abhaken zählt – das Geschäft mit den meisten Haken (ab 2×) ist „meist dort“
        bought = hist.setdefault("bought", {})
        bought[store_id] = int(bought.get(store_id, 0)) + 1
        best = max(bought.items(), key=lambda kv: kv[1])
        if best[1] >= 2 and sum(1 for v in bought.values() if v == best[1]) == 1 and self.store_by_id(best[0]):
            hist["usual"] = best[0]
        else:
            hist.pop("usual", None)

    def confirm_scanned(self, key: str) -> None:
        """📷 „Passt so“: neu gescanntes Produkt ist geprüft."""
        key = (key or "").lower()
        for bc in self.barcodes.values():
            if product_key(bc.get("name"), bc.get("note")) == key:
                bc.pop("new", None)
        self._changed()

    def resolve_alias(self, name: str | None, note: str | None) -> tuple[str | None, str | None]:
        """🏷️ Spitzname -> richtiges Produkt („Tempos“ -> Taschentücher). Eigene Notiz hat Vorrang."""
        low = (name or "").strip().lower()
        target = self.aliases.get(low)
        if not target:
            typo = self.typos.get(low)  # 🧠 gelernter Tippfehler („Mlich“ -> Milch, ab dem 2. Mal)
            if typo and typo.get("n", 0) >= TYPO_LEARN_AFTER:
                return typo["right"], note
            return name, note
        return target["name"], note or target.get("note")

    # ------------------------------------------------------------------ 🧠 Tippfehler lernen
    def learn_typo(self, wrong: str, right: str) -> dict[str, Any]:
        """„Meintest du …?“ wurde angenommen: merken. Ab dem 2. Mal wird der Tippfehler von selbst korrigiert."""
        wrong_l = " ".join((wrong or "").split()).lower()
        right = _nice(right)
        if not wrong_l or not right or wrong_l == right.lower():
            return {"learned": False}
        entry = self.typos.get(wrong_l)
        if entry and entry.get("right", "").lower() == right.lower():
            entry["n"] = entry.get("n", 0) + 1
        else:
            entry = self.typos[wrong_l] = {"right": right, "n": 1}
        if len(self.typos) > 300:  # nicht endlos wachsen: die seltensten fliegen raus
            for k in sorted(self.typos, key=lambda k: self.typos[k].get("n", 0))[: len(self.typos) - 300]:
                self.typos.pop(k, None)
        self._changed()
        return {"learned": entry["n"] >= TYPO_LEARN_AFTER, "count": entry["n"]}

    def forget_typo(self, wrong: str) -> None:
        self.typos.pop((wrong or "").strip().lower(), None)
        self._changed()

    # ------------------------------------------------------------------ 🔒 PIN für die Einstellungen
    @staticmethod
    def _pin_hash(pin: str, salt: str) -> str:
        return salt + "$" + hashlib.sha256((salt + str(pin)).encode()).hexdigest()

    def check_pin(self, pin: str | None) -> bool:
        if not self.pin_hash:
            return True
        salt = self.pin_hash.split("$", 1)[0]
        return hmac.compare_digest(self._pin_hash(str(pin or ""), salt), self.pin_hash)

    def set_pin(self, pin: str | None, old: str | None = None) -> None:
        """Neue PIN (4–8 Ziffern) setzen; leer = PIN aus. Gibt es schon eine, muss die alte stimmen."""
        if self.pin_hash and not self.check_pin(old):
            raise ValueError("Die alte PIN stimmt nicht.")
        pin = (pin or "").strip()
        if pin and not re.fullmatch(r"\d{4,8}", pin):
            raise ValueError("Die PIN muss aus 4 bis 8 Ziffern bestehen.")
        self.pin_hash = self._pin_hash(pin, secrets.token_hex(8)) if pin else None
        self._changed()

    def clear_pin(self) -> None:
        """PIN vergessen? Admin setzt sie unter Geräte & Dienste → Einkaufsliste → Konfigurieren zurück."""
        self.pin_hash = None
        self._changed()

    # 🏷️ Ein Spitzname darf zu mehreren Produkten gehören: erstes Ziel in name/note, weitere in „also“
    @staticmethod
    def _al_targets(entry: dict[str, Any]) -> list[dict[str, Any]]:
        return [entry, *entry.get("also", [])]

    def _al_set(self, alias: str, targets: list[dict[str, Any]]) -> None:
        if not targets:
            self.aliases.pop(alias, None)
            return
        first = {"name": targets[0]["name"], "note": targets[0].get("note")}
        if len(targets) > 1:
            first["also"] = [{"name": t["name"], "note": t.get("note")} for t in targets[1:]]
        self.aliases[alias] = first

    def _al_remove(self, key: str) -> None:
        for a, e in list(self.aliases.items()):
            self._al_set(a, [t for t in self._al_targets(e) if product_key(t["name"], t.get("note")) != key])

    def _al_add(self, alias: str, name: str, note: str | None) -> None:
        targets = self._al_targets(self.aliases[alias]) if alias in self.aliases else []
        key = product_key(name, note)
        if not any(product_key(t["name"], t.get("note")) == key for t in targets):
            targets = [*targets, {"name": name, "note": note}]
        self._al_set(alias, targets)

    def _al_retarget(self, from_key: str, name: str, note: str | None) -> None:
        for a, e in list(self.aliases.items()):
            targets = [{"name": name, "note": note} if product_key(t["name"], t.get("note")) == from_key else t for t in self._al_targets(e)]
            seen: list[dict[str, Any]] = []
            for t in targets:  # nach Umbenennen/Zusammenführen keine doppelten Ziele
                if not any(product_key(x["name"], x.get("note")) == product_key(t["name"], t.get("note")) for x in seen):
                    seen.append(t)
            self._al_set(a, seen)

    def set_aliases(self, key: str, aliases: list[str]) -> None:
        """Spitznamen eines Produkts setzen (alte werden ersetzt; gehört ein Name schon woanders hin, zieht er um)."""
        key = (key or "").lower()
        prod = next((p for p in self.products() if p["key"] == key), None)
        if prod is None:
            raise ValueError("Dieses Produkt gibt es nicht (mehr).")
        self._al_remove(key)
        for raw in aliases:
            alias = " ".join(str(raw).split()).lower()[:40]
            if not alias or alias == prod["name"].lower():
                continue
            self._al_add(alias, prod["name"], prod["note"])
        self._changed()

    def recipes_with(self, key: str) -> list[str]:
        """In welchen Rezepten steht dieses Produkt (Name + Notiz) noch?"""
        key = (key or "").lower()
        return [r["name"] for r in self.recipes if any(product_key(ri["name"], ri.get("note")) == key for ri in r["items"])]

    async def async_delete_product(self, key: str) -> dict[str, Any]:
        """🗑️ Produkt ganz löschen: Fotos, Barcodes, Vorschlag UND alle Artikel auf der Liste (offen + erledigt).

        Rezepte werden NICHT still geändert – zurück kommt, in welchen es noch steht.
        """
        key = (key or "").lower()
        in_recipes = self.recipes_with(key)
        gone = [i for i in self.items if not i.get("recipe_id") and product_key(i["name"], i.get("note")) == key]
        for item in gone:
            self.items.remove(item)
            self._log("remove", item)
        await self.async_forget_product(key)
        self._al_remove(key)
        self._changed()
        return {"removed": len(gone), "recipes": in_recipes}

    async def async_merge_products(self, from_key: str, into_key: str) -> dict[str, Any]:
        """🧲 Zwei Produkte zu einem machen („Tomaten“ -> „Tomate“): Artikel, Rezept-Zutaten, Barcodes, Fotos,
        Spitznamen und Gedächtnis ziehen um. Der alte Name wird ein Spitzname, damit er künftig beim richtigen landet."""
        from_key, into_key = (from_key or "").lower(), (into_key or "").lower()
        if from_key == into_key:
            raise ValueError("Das ist dasselbe Produkt – zum Zusammenführen brauche ich zwei verschiedene.")
        prods = {p["key"]: p for p in self.products()}
        src, dst = prods.get(from_key), prods.get(into_key)
        if src is None or dst is None:
            raise ValueError("Eines der beiden Produkte gibt es nicht (mehr).")
        name, note = dst["name"], dst["note"]
        moved = merged = 0
        for item in list(self.items):
            if item.get("recipe_id") or product_key(item["name"], item.get("note")) != from_key:
                continue
            same = self._find_same(name, note, item.get("for_whom"), item.get("store_id"), None, skip_id=item["id"])
            if same is not None:  # gibt es dort schon: nicht doppelt – ein offener Eintrag holt den erledigten zurück
                if not item["checked"] and same["checked"]:
                    self.set_checked(same["id"], False, None, None)
                self.items.remove(item)
                merged += 1
                continue
            before = dict(item)
            item["name"], item["note"] = name, note
            self._log_changes(before, item)
            moved += 1
        for recipe in self.recipes:
            for ri in recipe["items"]:
                if product_key(ri["name"], ri.get("note")) == from_key:
                    ri["name"], ri["note"] = name, note
                    moved += 1
            recipe["items"] = sorted(recipe["items"], key=_abc)
        for bc in self.barcodes.values():
            if bc.get("name") and product_key(bc["name"], bc.get("note")) == from_key:
                bc["name"], bc["note"] = name, note
        self._al_retarget(from_key, name, note)
        if not src["note"] and src["name"].lower() != name.lower() and src["name"].lower() not in self.aliases:
            self.aliases[src["name"].lower()] = {"name": name, "note": note}  # 🏷️ „Tomaten“ landet künftig bei „Tomate“
        # 📷 Fotos: zum Ziel dazu (höchstens MAX_PHOTOS), der Rest wird gelöscht
        photo = self.photos.pop(from_key, None)
        if photo is not None:
            ids = self._photo_ids(photo)
            target = self.photos.get(into_key)
            if target is None:
                self.photos[into_key] = {"id": ids[0], "updated": _now_iso(), "name": dst["name"] + (f"|{note}" if note else ""),
                                         "more": ids[1:MAX_PHOTOS]}
                ids = ids[MAX_PHOTOS:]
            else:
                room = MAX_PHOTOS - len(self._photo_ids(target))
                target.setdefault("more", []).extend(ids[:max(room, 0)])
                target["updated"] = _now_iso()
                ids = ids[max(room, 0):]
            for photo_id in ids:
                await self._async_delete_file(photo_id)
        # 🧠 Gedächtnis: Zählung, Geschäfte und „meist dort“ zusammenlegen
        old_hist = self.history.get(src["name"].lower())
        new_hist = self.history.get(name.lower())
        others = [p for p in self.products() if p["name"].lower() == src["name"].lower() and p["key"] != from_key]
        if old_hist and new_hist is not None and old_hist is not new_hist:
            new_hist["count"] = new_hist.get("count", 0) + old_hist.get("count", 0)
            for sid in old_hist.get("stores", []):
                if sid not in new_hist.setdefault("stores", []):
                    new_hist["stores"].append(sid)
            for sid, n in (old_hist.get("bought") or {}).items():
                bought = new_hist.setdefault("bought", {})
                bought[sid] = int(bought.get(sid, 0)) + int(n)
            if not others:
                self.history.pop(src["name"].lower(), None)
        self._changed()
        return {"moved": moved, "merged": merged, "into": name}

    @callback
    def mark_out(self, item_id: str) -> dict[str, Any]:
        """⇄ „Nächstes Mal wieder hier“: Artikel bleibt offen, bekommt „war aus (Tag)“,
        und die Frist fürs automatische Aufräumen zählt ab heute neu."""
        item = self.get_item(item_id)
        if item["checked"]:
            raise ValueError("Der Artikel ist schon abgehakt.")
        item["out_at"] = _now_iso()
        self._log("out", item, "war aus")
        self._changed()
        return item

    @callback
    def remove_barcode(self, code: str) -> None:
        """▥ Einen einzelnen Barcode vom Produkt lösen (das Produkt bleibt)."""
        if self.barcodes.pop(str(code).strip(), None) is None:
            raise ValueError("Diesen Barcode gibt es nicht (mehr).")
        self._changed()

    async def async_forget_product(self, key: str) -> None:
        """Produkt vergessen: Fotos, Barcodes und Verlauf weg (Artikel auf der Liste bleiben)."""
        key = (key or "").lower()
        prod = next((p for p in self.products() if p["key"] == key), None)
        if prod is None:
            return
        for code in [c for c, bc in self.barcodes.items() if product_key(bc.get("name"), bc.get("note")) == key]:
            self.barcodes.pop(code, None)
        others = [p for p in self.products() if p["name"].lower() == prod["name"].lower() and p["key"] != key]
        if not others:
            self.history.pop(prod["name"].lower(), None)
        await self.async_remove_photo(key)
        self._changed()

    # ------------------------------------------------------------------ Fehler-Protokoll
    def log_error(self, where: str, text: str) -> None:
        """🐞 Merkt sich einen technischen Fehler (für ⚙️ → Fehler-Protokoll). Gleiche Meldung nacheinander zählt hoch."""
        where = str(where or "?")[:60]
        text = str(text or "?").strip()[:400]
        now = _now_iso()
        if self.errors and self.errors[-1].get("w") == where and self.errors[-1].get("m") == text:
            self.errors[-1]["n"] = int(self.errors[-1].get("n", 1)) + 1
            self.errors[-1]["t"] = now
        else:
            self.errors.append({"t": now, "w": where, "m": text, "n": 1})
            del self.errors[:-ERROR_LIMIT]
        self._schedule_save()

    def _errors_since(self, span: timedelta) -> int:
        limit = dt_util.utcnow() - span
        return sum(1 for e in self.errors if (dt_util.parse_datetime(str(e.get("t") or "")) or limit) > limit)

    def get_errors(self) -> dict[str, Any]:
        return {"errors": list(reversed(self.errors)), "version": VERSION}

    def clear_errors(self) -> dict[str, Any]:
        self.errors = []
        self._changed()
        return self.get_errors()

    # ------------------------------------------------------------------ Verlauf
    # 👤 Wer gerade etwas tut – pro Befehl getrennt (ContextVar), damit sich gleichzeitige Befehle nicht vermischen
    @property
    def _actor(self) -> dict[str, Any]:
        return _ACTOR.get()

    @_actor.setter
    def _actor(self, value: dict[str, Any]) -> None:
        _ACTOR.set(value)

    @contextmanager
    def acting(self, who: str | None, who_id: str | None, via: str | None) -> Iterator[None]:
        """Merkt sich für die Dauer eines Befehls, wer ihn wie ausgelöst hat (für den Verlauf)."""
        old = self._actor
        self._actor = {"who": who, "who_id": who_id, "via": via or old.get("via")}
        try:
            yield
        finally:
            self._actor = old

    @contextmanager
    def _via(self, via: str) -> Iterator[None]:
        old = self._actor
        self._actor = {**old, "via": via}
        try:
            yield
        finally:
            self._actor = old

    def _log(
        self,
        action: str,
        item: dict[str, Any],
        detail: str | None = None,
        who: str | None = None,
    ) -> None:
        actor = self._actor
        self.log.append(
            {
                "t": _now_iso(),
                "a": action,
                "n": item.get("name"),
                "s": item.get("store_id"),
                "w": who if who is not None else actor.get("who"),
                "v": actor.get("via") or "service",
                **({"d": detail} if detail else {}),
            }
        )
        if len(self.log) > LOG_LIMIT or len(self.log) % 50 == 0:
            self._prune_log()

    def _prune_log(self) -> None:
        cutoff = (dt_util.utcnow() - timedelta(days=self.log_days)).isoformat()
        self.log = [e for e in self.log if e.get("t", "") >= cutoff][-LOG_LIMIT:]

    def get_log(self) -> dict[str, Any]:
        self._prune_log()
        return {"days": self.log_days, "entries": list(reversed(self.log))}

    def set_log_days(self, days: int) -> dict[str, Any]:
        days = int(days)
        if days not in LOG_DAY_CHOICES:
            raise ValueError("Diese Aufbewahrungszeit gibt es nicht.")
        self.log_days = days
        self._prune_log()
        self._schedule_save()
        return {"days": days}

    def clear_log(self) -> None:
        self.log = []
        self._changed()

    # ------------------------------------------------------------------ Suchen
    def get_item(self, item_id: str) -> dict[str, Any]:
        for item in self.items:
            if item["id"] == item_id:
                return item
        raise ValueError("Diesen Artikel gibt es nicht (mehr).")

    def store_by_id(self, store_id: str | None) -> dict[str, Any] | None:
        return next((s for s in self.stores if s["id"] == store_id), None)

    def category_by_id(self, cat_id: str | None) -> dict[str, Any] | None:
        return next((c for c in self.categories if c["id"] == cat_id), None)

    def recipe_by_id(self, recipe_id: str | None) -> dict[str, Any] | None:
        return next((r for r in self.recipes if r["id"] == recipe_id), None)

    def find_store(self, value: str | None) -> str | None:
        """Findet ein Geschäft per ID oder Name (Groß/klein egal)."""
        value = _clean(value)
        if value is None:
            return None
        for store in self.stores:
            if store["id"] == value or store["name"].lower() == value.lower():
                return store["id"]
        raise ValueError(f"Das Geschäft „{value}“ gibt es nicht auf der Liste.")

    def find_category(self, value: str | None) -> str | None:
        value = _clean(value)
        if value is None:
            return None
        for cat in self.categories:
            if cat["id"] == value or cat["name"].lower() == value.lower():
                return cat["id"]
        raise ValueError(f"Die Kategorie „{value}“ gibt es nicht.")

    def find_recipe(self, value: str | None) -> dict[str, Any]:
        value = _clean(value) or ""
        for recipe in self.recipes:
            if recipe["id"] == value or recipe["name"].lower() == value.lower():
                return recipe
        raise ValueError(f"Das Rezept „{value}“ gibt es nicht.")

    def find_item(self, name: str, store_id: str | None = None) -> dict[str, Any]:
        wanted = (_clean(name) or "").lower()
        matches = [
            i
            for i in self.items
            if i["name"].lower() == wanted and (store_id is None or i["store_id"] == store_id)
        ]
        if not matches:
            raise ValueError(f"„{name}“ steht nicht auf der Liste.")
        matches.sort(key=lambda i: i["checked"])  # offene zuerst
        return matches[0]

    def guess_category(self, name: str) -> str | None:
        return guess_category(name, self.categories)

    def _auto_category(self, name: str) -> str | None:
        """Kategorie von letztem Mal, sonst aus dem Wörterbuch."""
        cat = (self.history_for(name) or {}).get("category_id")
        return cat if self.category_by_id(cat) else self.guess_category(name)

    def history_for(self, name: str) -> dict[str, Any] | None:
        return self.history.get(name.strip().lower())

    def _check_store(self, store_id: str | None) -> str | None:
        if store_id and self.store_by_id(store_id) is None:
            raise ValueError("Unbekanntes Geschäft.")
        return store_id or None

    def _check_category(self, cat_id: str | None) -> str | None:
        if cat_id and self.category_by_id(cat_id) is None:
            raise ValueError("Unbekannte Kategorie.")
        return cat_id or None

    def _find_same(
        self,
        name: str | None,
        note: str | None,
        for_whom: str | None,
        store_id: str | None,
        recipe_id: str | None = None,
        skip_id: str | None = None,
    ) -> dict[str, Any] | None:
        key = _key(name, note, for_whom, store_id, recipe_id)
        return next(
            (
                i
                for i in self.items
                if i["id"] != skip_id and _key(i["name"], i.get("note"), i.get("for_whom"), i.get("store_id"), i.get("recipe_id"))
                == key
            ),
            None,
        )

    def _remember(self, item: dict[str, Any]) -> None:
        key = item["name"].lower()
        entry = self.history.get(key, {"name": item["name"], "count": 0})
        entry.update(
            name=item["name"],
            store_id=item["store_id"],
            category_id=item["category_id"],
            count=entry.get("count", 0) + 1,
            last_used=_now_iso(),
        )
        # 📏 Einheit merken („Backpulver“ -> Pck.) – nur beim direkten Eintragen, nicht aus Rezepten,
        # und nicht, wenn sie im Katalog fest eingestellt ist
        if not item.get("recipe_id") and not entry.get("unit_fixed"):
            unit = unit_of(item.get("quantity"))
            if unit:
                entry["unit"] = unit
        if not item.get("recipe_id") and item.get("quantity"):
            entry["qty"] = item["quantity"]  # 🔁 für „wie zuletzt“
        if not item.get("recipe_id"):
            if item.get("own_note"):
                entry["own_note"] = item["own_note"]  # ✏️ Eigene Notiz bleibt beim Produkt (Vorschläge füllen sie wieder ein)
            else:
                entry.pop("own_note", None)
        self.history[key] = entry
        if len(self.history) > HISTORY_LIMIT:
            oldest = sorted(self.history.items(), key=lambda kv: kv[1].get("last_used", ""))
            for k, _ in oldest[: len(self.history) - HISTORY_LIMIT]:
                self.history.pop(k, None)

    def _fire_added(self, item: dict[str, Any], readded: bool) -> None:
        store = self.store_by_id(item["store_id"])
        cat = self.category_by_id(item["category_id"])
        recipe = self.recipe_by_id(item.get("recipe_id"))
        self.hass.bus.async_fire(
            EVENT_ITEM_ADDED,
            {
                "item_id": item["id"],
                "name": item["name"],
                "quantity": item.get("quantity"),
                "note": item.get("note"),
                "for_whom": item.get("for_whom"),
                "store": store["name"] if store else None,
                "category": cat["name"] if cat else None,
                "recipe": recipe["name"] if recipe else None,
                "added_by": item.get("added_by"),
                "readded": readded,
            },
        )

    # ------------------------------------------------------------------ Artikel
    @callback
    def add_item(
        self,
        name: str,
        store_id: str | None = None,
        category_id: Any = AUTO_CATEGORY,
        quantity: str | None = None,
        note: str | None = None,
        for_whom: str | None = None,
        added_by: str | None = None,
        recipe_id: str | None = None,
        notify: bool = True,
        barcode: str | None = None,
        added_by_id: str | None = None,
        from_offer: bool = False,
        own_note: str | None = None,
    ) -> dict[str, Any]:
        """Artikel hinzufügen.

        Gibt es schon einen Artikel mit gleichem Namen, gleicher Notiz, gleichem
        „für wen“ und gleichem Geschäft, wird kein zweiter angelegt: Ist er abgehakt, kommt er wieder
        auf die Liste (Haken raus), sonst werden nur die Angaben aktualisiert.
        """
        if not _clean(quantity):
            name, quantity, bare = split_qty_ex(name)  # „3 milch“ -> Milch · 3x
        else:
            bare = is_bare(quantity)
        name, note = self.resolve_alias(_nice(name), note)  # 🏷️ „Tempos“ -> Taschentücher
        if not name:
            raise ValueError("Ohne Namen geht's nicht – was soll denn gekauft werden?")
        store_id = self._check_store(store_id)
        # 🗂️ Keine Kategorie mitgegeben (Angebote, E-Mail, Alexa, Text-Import …)? Dann raten – erst „wie beim letzten Mal“,
        # sonst das Wörterbuch. Eine ausdrücklich gewählte Kategorie (auch „Ohne“ = None) bleibt, wie sie ist.
        auto = category_id is AUTO_CATEGORY
        category_id = None if auto else self._check_category(category_id)
        guessed = self._auto_category(name) if auto else None
        quantity, note, for_whom = norm_qty(_clean(quantity)), _note(note), _clean(for_whom)
        if _clean(barcode):
            code = str(barcode).strip()
            is_new = code not in self.barcodes
            self.learn_barcode(code, name, store_id, category_id or guessed, note, for_whom)
            if is_new:
                self.barcodes[code]["new"] = True  # 📷 neu gescannt: im Katalog unter „Neu gescannt“ prüfen

        # Rezept-Zutaten kommen zusätzlich auf die Liste (eigener Eintrag pro Rezept)
        recipe_id = recipe_id if self.recipe_by_id(recipe_id) else None
        # ✏️ Eigene Notiz: nichts mitgegeben (None) = die vom letzten Mal beim Produkt nehmen, "" = ausdrücklich keine
        if recipe_id is not None:
            own = None
        elif own_note is None:
            own = (self.history_for(name) or {}).get("own_note")
        else:
            own = _own(own_note)
        if bare and quantity and recipe_id is None:  # 📏 nur eine Zahl? Dann die gemerkte Einheit („2“ -> 2 Pck.)
            unit = (self.history_for(name) or {}).get("unit")
            if unit:
                quantity = apply_unit(quantity, unit)
        existing = self._find_same(name, note, for_whom, store_id, recipe_id)
        if existing is not None:
            if not from_offer and recipe_id is None and existing.get("from_offer"):
                # ✍️ von Hand (nochmal) eingetragen: ab jetzt dein Artikel, verschwindet nicht mit dem Angebot
                for k in ("from_offer", "offer", "orig"):
                    existing.pop(k, None)
            readded = existing["checked"]
            if readded:
                existing.update(
                    checked=False,
                    checked_at=None,
                    checked_by=None,
                    added_at=_now_iso(),
                    added_by=added_by,
                    added_by_id=added_by_id,
                )
            if category_id:
                existing["category_id"] = category_id
            if own_note is not None and recipe_id is None:
                if own:
                    existing["own_note"] = own
                else:
                    existing.pop("own_note", None)
            old_qty = existing.get("quantity")
            if quantity:
                existing["quantity"] = quantity
            if readded:
                self._log("readd", existing, who=added_by)
            elif quantity and quantity != old_qty:
                self._log("edit", existing, f"Menge {old_qty or '–'} → {quantity}", who=added_by)
            self._remember(existing)
            if notify:
                self._changed()
            if readded:
                self._fire_added(existing, True)
            return existing

        item = {
            "id": _new_id(),
            "name": name,
            "store_id": store_id,
            "category_id": category_id or guessed,
            "quantity": quantity,
            "note": note,
            "own_note": own,
            "for_whom": for_whom,
            "recipe_id": recipe_id,
            "checked": False,
            "added_by": added_by,
            "added_by_id": added_by_id,
            "added_at": _now_iso(),
            "checked_by": None,
            "checked_at": None,
        }
        self.items.append(item)
        self._log("add", item, who=added_by)
        self._remember(item)
        if notify:
            self._changed()
        self._fire_added(item, False)
        return item

    @callback
    def update_item(self, item_id: str, **fields: Any) -> dict[str, Any]:
        item = self.get_item(item_id)
        new = {
            "name": _nice(fields.get("name", item["name"])),
            "note": _note(fields.get("note", item.get("note"))),
            "for_whom": _clean(fields.get("for_whom", item.get("for_whom"))),
        }
        if not new["name"]:
            raise ValueError("Der Name darf nicht leer sein.")
        new["store_id"] = (
            self._check_store(fields["store_id"]) if "store_id" in fields else item["store_id"]
        )
        if self._find_same(
            new["name"],
            new["note"],
            new["for_whom"],
            new["store_id"],
            item.get("recipe_id"),
            skip_id=item_id,
        ):
            raise ValueError(
                f"„{new['name']}“ gibt es schon – unterscheide ihn über Notiz, „für wen“ oder Geschäft."
            )
        old_name = item["name"]
        before = dict(item)
        item.update(new)
        old_key = product_key(old_name, before.get("note"))
        new_key = product_key(item["name"], item.get("note"))
        if old_key != new_key:
            self._move_photo(old_key, new_key)
            for entry in self.barcodes.values():  # gelernte Barcodes mitziehen
                if product_key(entry.get("name"), entry.get("note")) == old_key:
                    entry.update(name=item["name"], note=item.get("note"))
        if "category_id" in fields:
            item["category_id"] = self._check_category(fields["category_id"])
        if "quantity" in fields:
            item["quantity"] = norm_qty(_clean(fields["quantity"]))
        if "own_note" in fields and not item.get("recipe_id"):
            item["own_note"] = _own(fields["own_note"])
        key = item["name"].lower()
        if key in self.history:
            self.history[key].update(store_id=item["store_id"], category_id=item["category_id"])
            if "own_note" in fields and not item.get("recipe_id"):
                if item.get("own_note"):
                    self.history[key]["own_note"] = item["own_note"]
                else:
                    self.history[key].pop("own_note", None)
        self._log_changes(before, item)
        self._changed()
        return item

    def _log_changes(self, before: dict[str, Any], item: dict[str, Any]) -> None:
        def store_name(sid: str | None) -> str:
            st = self.store_by_id(sid)
            return st["name"] if st else "Egal wo"

        def cat_name(cid: str | None) -> str:
            cat = self.category_by_id(cid)
            return cat["name"] if cat else "ohne"

        parts: list[str] = []
        if before["name"] != item["name"]:
            parts.append(f"Name {before['name']} → {item['name']}")
        for key, label in (("quantity", "Menge"), ("note", "Notiz"), ("own_note", "Eigene Notiz"), ("for_whom", "Für wen")):
            if (before.get(key) or None) != (item.get(key) or None):
                parts.append(f"{label} {before.get(key) or '–'} → {item.get(key) or '–'}")
        if before.get("category_id") != item.get("category_id"):
            parts.append(f"Kategorie {cat_name(before.get('category_id'))} → {cat_name(item.get('category_id'))}")
        moved = before.get("store_id") != item.get("store_id")
        if moved and not parts:
            self._log("move", item, f"{store_name(before.get('store_id'))} → {store_name(item.get('store_id'))}")
            return
        if moved:
            parts.append(f"Geschäft {store_name(before.get('store_id'))} → {store_name(item.get('store_id'))}")
        if parts:
            self._log("edit", item, " · ".join(parts))

    @callback
    def set_checked(
        self,
        item_id: str,
        checked: bool | None = None,
        by: str | None = None,
        by_id: str | None = None,
        at_store: str | None = None,
        undo: bool = False,
    ) -> dict[str, Any]:
        """Abhaken oder wieder auf die Liste nehmen (None = umschalten).

        undo: ↩️ „Rückgängig“ – war nur ein Versehen, also Datum und Eintrager bleiben wie vorher.

        at_store: 🤷 ein „Egal wo“-Artikel wird in diesem Geschäft abgehakt -> gehört ab jetzt dorthin
        (dort unter „Erledigt“, bei den anderen weg; wieder draufgesetzt landet er dort).
        """
        item = self.get_item(item_id)
        if checked is None:
            checked = not item["checked"]
        if checked == item["checked"]:
            return item
        if checked and item["store_id"] is None and not item.get("recipe_id") and self.store_by_id(at_store):
            old = self._find_same(item["name"], item.get("note"), item.get("for_whom"), at_store, None)
            if old is not None and old is not item and old["checked"]:
                self.items.remove(old)  # der alte abgehakte Eintrag dort wird ersetzt
                self._relink(old["id"], item["id"])
            if old is None or old["checked"]:
                item["store_id"] = at_store
        self._log("check" if checked else "readd", item, who=by)
        if checked and (item.get("recipe_id") or item.get("from_offer")):
            # Rezept-Zutaten und Artikel aus Angeboten verschwinden beim Abhaken ganz von der Liste
            self.items.remove(item)
            self._changed()
            return {**item, "checked": True, "checked_at": _now_iso(), "checked_by": by, "removed": True}
        if checked:
            item.update(checked=True, checked_at=_now_iso(), checked_by=by, out_at=None)
            self._learn_store(item["name"], item.get("store_id"))  # 🏪 hier gekauft = gibt's hier
        elif undo:
            # ↩️ Rückgängig: nur den Haken weg – altes Datum und Eintrager bleiben
            item.update(checked=False, checked_at=None, checked_by=None)
            self._changed()
            return item
        else:
            # Wieder drauf: neues Datum, und wer ihn reinnimmt, steht dahinter
            item.update(
                checked=False,
                checked_at=None,
                checked_by=None,
                added_at=_now_iso(),
                added_by=by,
                added_by_id=by_id,
            )
            self._remember(item)
            self._fire_added(item, True)
        self._changed()
        return item

    @callback
    def move_item(
        self, item_id: str, store_id: str | None, by: str | None = None, by_id: str | None = None
    ) -> dict[str, Any]:
        """⇄ „War aus“: beim alten Geschäft abhaken, beim neuen offen auf die Liste.

        Beide Einträge bleiben erhalten (der alte unten bei „Erledigt“), damit man ihn
        beim nächsten Mal in jedem Geschäft wieder antippen kann.
        """
        item = self.get_item(item_id)
        target = self._check_store(None if store_id == "~none" else store_id)
        if target == item["store_id"]:
            return item
        if target is None:  # 🤷 nach „Egal wo“: steht dann in jedem Geschäft – einfach umziehen
            source = (self.store_by_id(item["store_id"]) or {}).get("name", "?")
            twin = self._find_same(item["name"], item.get("note"), item.get("for_whom"), None, item.get("recipe_id"))
            if twin is not None and twin is not item:
                if not item["checked"] and twin["checked"]:
                    twin.update(checked=False, checked_at=None, checked_by=None, added_at=_now_iso(), added_by=by, added_by_id=by_id)
                if item.get("quantity"):
                    twin["quantity"] = item["quantity"]
                self.items.remove(item)
                self._relink(item["id"], twin["id"])
                new = twin
            else:
                item["store_id"] = None
                new = item
            self._log("move", new, f"{source} → Egal wo", who=by)
            self._changed()
            return new
        now = _now_iso()
        source_name = (self.store_by_id(item["store_id"]) or {}).get("name", "Egal wo")
        target_name = self.store_by_id(target)["name"]
        twin = self._find_same(
            item["name"], item.get("note"), item.get("for_whom"), target, item.get("recipe_id")
        )
        if item["store_id"] is None and not item["checked"]:
            # 🤷 aus „Egal wo“: einfach umziehen – kein abgehakter Rest bleibt zurück
            if twin is not None and not twin["checked"]:  # dort schon offen -> zusammenlegen
                if item.get("quantity"):
                    twin["quantity"] = item["quantity"]
                self.items.remove(item)
                self._relink(item["id"], twin["id"])
                new = twin
            else:
                if twin is not None:  # alter abgehakter Eintrag dort wird ersetzt
                    self.items.remove(twin)
                    self._relink(twin["id"], item["id"])
                item["store_id"] = target
                new = item
            self._remember(new)
            self._log("move", new, f"{source_name} → {target_name}", who=by)
            self._changed()
            return new
        # alter Laden: abhaken (Rezept-Zutaten verschwinden wie beim normalen Abhaken)
        if not item["checked"]:
            if item.get("recipe_id"):
                self.items.remove(item)
            else:
                item.update(checked=True, checked_at=now, checked_by=by)
        # neuer Laden: offen
        if twin is not None:
            if twin["checked"]:
                twin.update(
                    checked=False, checked_at=None, checked_by=None,
                    added_at=now, added_by=by, added_by_id=by_id,
                )
            if item.get("quantity"):
                twin["quantity"] = item["quantity"]
            new = twin
        else:
            new = {
                "id": _new_id(),
                "name": item["name"],
                "store_id": target,
                "category_id": item.get("category_id"),
                "quantity": item.get("quantity"),
                "note": item.get("note"),
                "for_whom": item.get("for_whom"),
                "recipe_id": item.get("recipe_id"),
                "checked": False,
                "added_by": by,
                "added_by_id": by_id,
                "added_at": now,
                "checked_by": None,
                "checked_at": None,
            }
            self.items.append(new)
        self._remember(new)
        self._log("move", new, f"{source_name} → {target_name}", who=by)
        self._changed()
        return new

    def _relink(self, old_id: str, new_id: str) -> None:
        """🔁 Verknüpfungen der To-do-Liste auf den verbleibenden Eintrag umbiegen."""
        for cfg in self.todo_syncs:
            links = cfg.get("links") or {}
            if any(v.get("item") == new_id for v in links.values()):
                continue  # schon verknüpft: der doppelte Eintrag drüben wird beim Abgleich gelöscht
            for v in links.values():
                if v.get("item") == old_id:
                    v["item"] = new_id

    @callback
    def remove_item(self, item_id: str) -> None:
        item = self.get_item(item_id)
        self.items.remove(item)
        self._log("remove", item)
        key = product_key(item["name"], item.get("note"))
        if not self._name_in_use(key):
            # Artikel ganz gelöscht -> Foto kommt mit weg
            self.hass.async_create_task(self.async_remove_photo(key))
        self._changed()

    # ------------------------------------------------------------------ Fotos
    def _name_in_use(self, key: str) -> bool:
        """Wird dieses Produkt (Name + Notiz) noch irgendwo gebraucht?"""
        key = key.lower()
        return any(product_key(i["name"], i.get("note")) == key for i in self.items) or any(
            product_key(ri["name"], ri.get("note")) == key for r in self.recipes for ri in r["items"]
        )

    def _move_photo(self, old: str, new: str) -> None:
        old_key, new_key = old.lower(), new.lower()
        if old_key in self.photos and new_key not in self.photos and not self._name_in_use(old):
            self.photos[new_key] = self.photos.pop(old_key)

    def _photo_path(self, photo_id: str) -> Path:
        return self.photo_dir / f"{photo_id}.jpg"

    @staticmethod
    def _photo_ids(entry: dict[str, Any]) -> list[str]:
        return [entry["id"], *entry.get("more", [])]

    async def async_replace_db_photo(self, key: str, raw: bytes) -> str:
        """🔄 Datenbank-Foto durch das aktuelle ersetzen – eigene Fotos bleiben, nichts kommt doppelt dazu.

        Gibt zurück: "same" (schon aktuell), "replaced" (altes Datenbank-Foto ersetzt), "added" (neu dazu)
        oder "full" (schon MAX_PHOTOS eigene Fotos – kein Platz).
        """
        entry = self.photos.get(key)
        if entry is None:
            await self.async_set_photo(self.product_label(key), base64.b64encode(raw).decode(), db=True)
            return "added"
        ids = self._photo_ids(entry)
        new_md5 = hashlib.md5(raw).hexdigest()

        def _md5s() -> dict[str, str]:
            out: dict[str, str] = {}
            for pid in ids:
                try:
                    out[pid] = hashlib.md5(self._photo_path(pid).read_bytes()).hexdigest()
                except OSError:
                    pass
            return out

        sums = await self.hass.async_add_executor_job(_md5s)
        dbs = entry.setdefault("db", [])
        same_ids = [pid for pid in ids if sums.get(pid) == new_md5]
        if same_ids:  # genau dieses Foto ist schon da (= stammt aus der Datenbank)
            keep, dup = same_ids[0], same_ids[1:]
            if keep not in dbs:
                dbs.append(keep)
                self._changed()
            if dup:  # Doppelte (gleiche Datei mehrfach) räumen wir auf: nur eines bleibt
                ids = [i for i in ids if i not in dup]
                for pid in dup:
                    await self._async_delete_file(pid)
                entry.update(id=ids[0], more=ids[1:], db=[i for i in dbs if i not in dup])
                self._changed()
            return "same"
        old_db = [i for i in ids if i in dbs]
        if not old_db and len(ids) >= MAX_PHOTOS:
            return "full"
        if len(raw) > 3 * 1024 * 1024 or not (raw[:3] == b"\xff\xd8\xff" or raw[:8] == b"\x89PNG\r\n\x1a\n" or raw[8:12] == b"WEBP"):
            raise ValueError("Das Foto aus der Datenbank ist kein brauchbares Foto.")
        new_id = _new_id()

        def _write() -> None:
            self.photo_dir.mkdir(parents=True, exist_ok=True)
            self._photo_path(new_id).write_bytes(raw)

        await self.hass.async_add_executor_job(_write)
        if old_db:
            ids[ids.index(old_db[0])] = new_id  # an derselben Stelle (auch als Hauptfoto)
            drop = old_db
        else:
            ids.append(new_id)
            drop = []
        ids = [i for i in ids if i not in drop[1:]]
        for pid in drop:
            await self._async_delete_file(pid)
        entry.update(id=ids[0], more=ids[1:], db=[new_id], updated=_now_iso())
        self._changed()
        return "replaced" if old_db else "added"

    async def async_set_photo(self, name: str, data: str, add: bool = False, db: bool = False) -> dict[str, Any]:
        """Foto zu einem Produkt speichern (Base64, vom Handy schon verkleinert).

        add=True: zusätzliches Foto (z. B. Rückseite), sonst wird das Haupt-Foto ersetzt.
        """
        name = _clean(name)
        if not name:
            raise ValueError("Zu welchem Artikel gehört das Foto?")
        if "," in data[:100]:
            data = data.split(",", 1)[1]
        try:
            raw = base64.b64decode(data, validate=True)
        except (binascii.Error, ValueError) as err:
            raise ValueError("Das Foto konnte nicht gelesen werden.") from err
        if len(raw) > 3 * 1024 * 1024:
            raise ValueError("Das Foto ist zu groß (max. 3 MB).")
        if not (raw[:3] == b"\xff\xd8\xff" or raw[:8] == b"\x89PNG\r\n\x1a\n" or raw[8:12] == b"WEBP"):
            raise ValueError("Das ist kein Foto (JPG/PNG/WebP).")
        photo_id = _new_id()
        path = self._photo_path(photo_id)

        def _write() -> None:
            self.photo_dir.mkdir(parents=True, exist_ok=True)
            path.write_bytes(raw)

        await self.hass.async_add_executor_job(_write)
        key = name.lower()
        old = self.photos.get(key)
        if old and add:
            if len(self._photo_ids(old)) >= MAX_PHOTOS:
                await self._async_delete_file(photo_id)
                raise ValueError(f"Mehr als {MAX_PHOTOS} Fotos pro Produkt gehen nicht.")
            old.setdefault("more", []).append(photo_id)
            old["updated"] = _now_iso()
        else:
            self.photos[key] = {"id": photo_id, "updated": _now_iso(), "name": name, "more": old.get("more", []) if old else []}
            if old:
                kept = [pid for pid in old.get("db", []) if pid in self._photo_ids(self.photos[key])]
                if kept:
                    self.photos[key]["db"] = kept
                await self._async_delete_file(old["id"])
        if db:  # 🏷️ merken: dieses Foto stammt aus der Datenbank (wird bei „Alle Fotos neu holen“ ersetzt)
            self.photos[key].setdefault("db", []).append(photo_id)
        self._changed()
        entry = self.photos[key]
        return {"name": name, "updated": entry["updated"], "count": len(self._photo_ids(entry))}

    def barcodes_for(self, key: str) -> list[str]:
        """Alle Barcodes, die zu diesem Produkt (Name + Notiz) gehören."""
        return [c for c, bc in self.barcodes.items() if bc.get("name") and product_key(bc["name"], bc.get("note")) == key]

    def barcode_product_keys(self) -> list[str]:
        """Alle Produkte (Name + Notiz), die mindestens einen Barcode haben."""
        keys: list[str] = []
        for bc in self.barcodes.values():
            if bc.get("name"):
                k = product_key(bc["name"], bc.get("note"))
                if k not in keys:
                    keys.append(k)
        return keys

    async def async_photo_refresh_plan(self) -> dict[str, Any]:
        """🔄 Welche Produkte mit Barcode brauchen ein Foto? (keins da oder ein abgeschnittenes dabei)"""
        keys = self.barcode_product_keys()

        def _plan() -> list[str]:
            todo: list[str] = []
            for k in keys:
                entry = self.photos.get(k)
                if entry is None or any(not photo_file_complete(self._photo_path(pid)) for pid in self._photo_ids(entry)):
                    todo.append(k)
            return todo

        todo = await self.hass.async_add_executor_job(_plan)
        names = {k: self.product_label(k).replace("|", " · ") for k in keys}
        return {"keys": todo, "total": len(keys), "all": keys, "names": names}

    def product_label(self, key: str) -> str:
        """Name des Produkts in Originalschreibweise (Name|Notiz) – für ein neues Foto."""
        for code in self.barcodes_for(key):
            bc = self.barcodes[code]
            return bc["name"] + (f"|{bc['note']}" if bc.get("note") else "")
        return key

    async def async_drop_cut_photos(self, key: str) -> int:
        """Abgeschnittene (unvollständige) Fotos eines Produkts löschen. Gibt zurück, wie viele es waren."""
        entry = self.photos.get(key)
        if entry is None:
            return 0
        ids = self._photo_ids(entry)

        def _cut() -> list[str]:
            return [pid for pid in ids if not photo_file_complete(self._photo_path(pid))]

        cut = await self.hass.async_add_executor_job(_cut)
        if not cut:
            return 0
        keep = [pid for pid in ids if pid not in cut]
        if keep:
            entry["id"], entry["more"] = keep[0], keep[1:]
            entry["updated"] = _now_iso()
        else:
            self.photos.pop(key, None)
        for pid in cut:
            await self._async_delete_file(pid)
        self._changed()
        return len(cut)

    async def async_get_photo(self, name: str, index: int = 0) -> str:
        entry = self.photos.get((_clean(name) or "").lower())
        if entry is None:
            raise ValueError("Zu diesem Artikel gibt es kein Foto.")
        ids = self._photo_ids(entry)
        path = self._photo_path(ids[max(0, min(int(index or 0), len(ids) - 1))])

        def _read() -> bytes | None:
            return path.read_bytes() if path.exists() else None

        raw = await self.hass.async_add_executor_job(_read)
        if raw is None:
            raise ValueError("Das Foto ist nicht mehr da.")
        mime = "image/png" if raw[:4] == b"\x89PNG" else "image/webp" if raw[8:12] == b"WEBP" else "image/jpeg"
        return f"data:{mime};base64,{base64.b64encode(raw).decode()}"

    async def async_remove_photo(self, name: str, index: int | None = None) -> None:
        """Foto(s) löschen: index=None alle, sonst nur dieses eine."""
        key = (_clean(name) or "").lower()
        entry = self.photos.get(key)
        if entry is None:
            return
        ids = self._photo_ids(entry)
        if index is None or len(ids) <= 1:
            self.photos.pop(key, None)
            for pid in ids:
                await self._async_delete_file(pid)
        else:
            index = max(0, min(int(index), len(ids) - 1))
            gone = ids.pop(index)
            if entry.get("db"):
                entry["db"] = [pid for pid in entry["db"] if pid != gone]
                if not entry["db"]:
                    entry.pop("db")
            entry["id"], entry["more"] = ids[0], ids[1:]
            entry["updated"] = _now_iso()
            await self._async_delete_file(gone)
        self._changed()

    @callback
    def move_photo(self, name: str, index: int, to: int) -> None:
        """↔️ Foto in der Reihenfolge verschieben (to=0 = ⭐ Hauptfoto)."""
        entry = self.photos.get((_clean(name) or "").lower())
        if entry is None:
            raise ValueError("Zu diesem Artikel gibt es kein Foto.")
        ids = self._photo_ids(entry)
        if not 0 <= int(index) < len(ids):
            raise ValueError("Dieses Foto gibt es nicht (mehr).")
        to = max(0, min(int(to), len(ids) - 1))
        ids.insert(to, ids.pop(int(index)))
        entry["id"], entry["more"] = ids[0], ids[1:]
        entry["updated"] = _now_iso()
        self._changed()

    # ------------------------------------------------------------ ✅ Alles ok?
    async def async_stats(self) -> dict[str, Any]:
        """📊 Wie viel Platz braucht die Einkaufsliste? (Dateien auf der Platte + wie viel drinsteht)"""
        data_file = Path(self.hass.config.path(".storage", STORAGE_KEY))
        photo_dir = self.photo_dir

        def _sizes() -> tuple[int, int, int]:
            data = data_file.stat().st_size if data_file.exists() else 0
            files = list(photo_dir.glob("*.jpg")) if photo_dir.exists() else []
            return data, sum(f.stat().st_size for f in files), len(files)

        data_bytes, photo_bytes, photo_files = await self.hass.async_add_executor_job(_sizes)
        return {
            "data_bytes": data_bytes,
            "photo_bytes": photo_bytes,
            "photo_files": photo_files,
            "items": len(self.items),
            "open": sum(1 for i in self.items if not i["checked"]),
            "products": len(self.history),
            "recipes": len(self.recipes),
            "barcodes": len(self.barcodes),
            "log": len(self.log),
            "log_days": self.log_days,
        }

    async def async_check(self, fix: bool = False, fixes: dict[str, str] | None = None) -> dict[str, Any]:
        """✅ Alles ok? – sucht kaputte oder unvollständige Einträge.

        Jeder Fund ist ein eigener Eintrag mit: was genau los ist (text), wie repariert wird (how)
        und – wo man wählen kann – Auswahl (options) samt Vorschlag (default).
        fixes = {Fund-ID: gewählter Wert}: nur diese werden repariert (Wert "" = so wie vorgeschlagen,
        bei Auswahl-Funden „leer lassen“). fix=True repariert alles mit Vorschlag.
        """
        found: list[dict[str, Any]] = []
        actions: dict[str, Any] = {}
        stores = {s["id"] for s in self.stores}
        cats = {c["id"] for c in self.categories}
        recipes = {r["id"]: r for r in self.recipes}
        groups = {g["id"] for g in self.recipe_groups}
        recipe_keys = {recipe_photo_key(rid): r["name"] for rid, r in recipes.items()}
        store_opts = [{"value": s["id"], "label": s["name"]} for s in self.stores]
        cat_opts = [{"value": c["id"], "label": c["name"]} for c in self.categories]
        group_opts = [{"value": g["id"], "label": g["name"]} for g in self.recipe_groups]
        DEL = "__delete__"  # 🗑️ gibt's gar nicht? -> Produkt ganz löschen

        def del_opt(key: str) -> dict[str, str]:
            where = self.recipes_with(key)
            return {"value": DEL, "label": "🗑️ Produkt ganz löschen" + (f" (bleibt in Rezept: {', '.join(where)})" if where else "")}

        def add(pid: str, text: str, how: str, action: Any, options: list | None = None,
                default: str | None = None, empty: str | None = None, edit: dict[str, str] | None = None) -> None:
            entry: dict[str, Any] = {"id": pid, "text": text, "how": how}
            if edit:  # ✏️ „Selbst ändern“: wohin die Karte springen soll
                entry["edit"] = edit
            if options is not None:
                entry.update(options=options, default=default or "", empty=empty)
            found.append(entry)
            actions[pid] = (action, entry)

        def _files() -> set[str]:
            return {f.stem for f in self.photo_dir.glob("*.jpg")} if self.photo_dir.exists() else set()

        files = await self.hass.async_add_executor_job(_files)

        def _cut_files() -> set[str]:
            return {f.stem for f in self.photo_dir.glob("*.jpg") if not photo_file_complete(f)} if self.photo_dir.exists() else set()

        cut_ids = await self.hass.async_add_executor_job(_cut_files)
        used: set[str] = set()
        for key, entry in list(self.photos.items()):
            ids = self._photo_ids(entry)
            used |= set(ids)
            if key.startswith("bon#"):  # 🧾📷 Bon-Foto: gehört zu einem Eintrag im Einkaufs-Protokoll
                if key[4:] not in {str(e["id"]).lower() for e in self.purchases}:
                    add(f"photo_bon:{key}", f"📷 {len(ids)} Bon-Foto(s) gehören zu einem Einkauf, den es nicht mehr gibt",
                        "Fotos löschen", lambda _v, key=key: self.async_remove_photo(key))
                continue
            base, _sep, step_part = key.partition("#s") if key.startswith("rezept#") and "#s" in key else (key, "", "")
            label = recipe_keys.get(base) or (entry.get("name") or key).replace("|", " · ")
            if step_part.isdigit() and base in recipe_keys:
                label = f"{label} – Schritt {int(step_part) + 1}"
            if key.startswith("rezept#") and base not in recipe_keys:
                add(f"photo_recipe:{key}", f"📷 {len(ids)} Foto(s) gehören zu einem Rezept, das es nicht mehr gibt",
                    "Fotos löschen", lambda _v, key=key: self.async_remove_photo(key))
                continue
            if step_part.isdigit():
                recipe = recipes.get(base.split("#", 1)[1])
                if recipe is not None and int(step_part) >= recipe_step_count(recipe):
                    add(f"photo_step:{key}", f"📷 {label}: den Schritt gibt es nicht mehr (Zubereitung wurde kürzer)",
                        "Foto löschen", lambda _v, key=key: self.async_remove_photo(key))
                    continue
            cut = [pid for pid in ids if pid in files and pid in cut_ids]
            if cut and not key.startswith(("rezept#", "bon#")):
                async def refetch(_v, key=key):
                    await self.async_drop_cut_photos(key)
                    from .barcode import async_auto_photo  # noqa: PLC0415 – erst hier, damit nichts im Kreis importiert wird
                    for code in self.barcodes_for(key):
                        if await async_auto_photo(self.hass, self, code, self.product_label(key)):
                            break
                has_bc = bool(self.barcodes_for(key))

                async def cut_fix(v, key=key, refetch=refetch):
                    if v == "drop":
                        await self.async_drop_cut_photos(key)
                    else:
                        await refetch(v)
                cut_opts = ([{"value": "refetch", "label": "🔄 Löschen und neu aus der Datenbank holen"}] if has_bc else []) \
                    + [{"value": "drop", "label": "🗑️ Nur die abgeschnittenen löschen"}]
                add(f"photo_cut:{key}", f"📷 „{label}“: {len(cut)} von {len(ids)} Foto(s) sind abgeschnitten (nur halb geladen)",
                    "Abgeschnittene Fotos löschen" + (" und neu aus der Datenbank holen" if has_bc else ""), cut_fix,
                    cut_opts, cut_opts[0]["value"], edit={"kind": "product", "id": key})
            missing = [pid for pid in ids if pid not in files]
            if missing:
                def drop(_v, key=key, entry=entry, ids=ids):
                    keep = [pid for pid in ids if pid in files]
                    if keep:
                        entry["id"], entry["more"] = keep[0], keep[1:]
                    else:
                        self.photos.pop(key, None)
                keep_n = len(ids) - len(missing)
                add(f"photo_missing:{key}",
                    f"📷 „{label}“: {len(missing)} von {len(ids)} Foto(s) fehlen auf der Festplatte",
                    f"Fehlende Fotos austragen{f' ({keep_n} vorhandene bleiben)' if keep_n else ' (Produkt hat dann kein Foto mehr)'}", drop,
                    edit=None if key.startswith(("rezept#", "bon#")) else {"kind": "product", "id": key})
        # 👯 Zwei Produkte mit genau demselben Foto (oder ein Foto doppelt beim selben Produkt)
        prod_photos = [(k, pid) for k, e in self.photos.items() if not k.startswith(("rezept#", "bon#"))
                       for pid in self._photo_ids(e) if pid in files and pid not in cut_ids]

        def _hash_files() -> dict[str, str]:
            out: dict[str, str] = {}
            for _k, pid in prod_photos:
                try:
                    out[pid] = hashlib.md5(self._photo_path(pid).read_bytes()).hexdigest()  # noqa: S324 – nur zum Vergleichen
                except OSError:
                    continue
            return out

        digest = await self.hass.async_add_executor_job(_hash_files)
        first_of: dict[str, tuple[str, str]] = {}
        for k, pid in sorted(prod_photos, key=lambda x: (x[0], self._photo_ids(self.photos[x[0]]).index(x[1]))):
            h = digest.get(pid)
            if not h:
                continue
            if h not in first_of:
                first_of[h] = (k, pid)
                continue
            k0, _pid0 = first_of[h]
            e = self.photos[k]
            lab = (e.get("name") or k).replace("|", " · ")
            lab0 = (self.photos[k0].get("name") or k0).replace("|", " · ")
            if k == k0:
                text, how = f"📷 „{lab}“: ein Foto ist doppelt vorhanden", "Das doppelte Foto löschen"
            else:
                text, how = (f"📷 „{lab}“ hat genau dasselbe Foto wie „{lab0}“",
                             f"Foto bei „{lab}“ löschen (bei „{lab0}“ bleibt es)")
            if k == k0:
                add(f"photo_dup:{k}:{pid}", text, how, lambda _v, k=k, pid=pid: self._drop_photo_by_id(k, pid),
                    edit={"kind": "product", "id": k})
            else:
                dup_opts = [{"value": "this", "label": f"🗑️ Bei „{lab}“ löschen"}, {"value": "other", "label": f"🗑️ Bei „{lab0}“ löschen"}]
                add(f"photo_dup:{k}:{pid}", text, how,
                    lambda v, k=k, pid=pid, k0=k0, pid0=_pid0: self._drop_photo_by_id(k0, pid0) if v == "other" else self._drop_photo_by_id(k, pid),
                    dup_opts, "this", edit={"kind": "product", "id": k})
        orphans = files - used
        if orphans:
            async def wipe(_v, orphans=sorted(orphans)):
                for pid in orphans:
                    await self._async_delete_file(pid)
            add("photo_orphans", f"🗂️ {len(orphans)} Foto-Datei(en) auf der Festplatte gehören zu keinem Produkt mehr",
                "Dateien löschen (Platz sparen)", wipe)

        for code, bc in list(self.barcodes.items()):
            if not bc.get("name"):
                add(f"bc_noname:{code}", f"▥ Barcode {code} hat keinen Produktnamen", "Barcode löschen",
                    lambda _v, code=code: self.barcodes.pop(code, None))

        def ref(pid: str, thing: dict[str, Any], label: str, fields: tuple[str, ...] = ("store_id", "category_id"),
                edit: dict[str, str] | None = None) -> None:
            for field in fields:
                if not thing.get(field):
                    continue
                if field == "store_id" and thing[field] not in stores:
                    add(f"ref:{pid}:store", f"🔗 {label}: das Geschäft gibt es nicht mehr",
                        "Anderes Geschäft wählen", lambda v, t=thing: t.__setitem__("store_id", v or None),
                        store_opts, None, "🤷 Egal wo / wie zuletzt", edit)
                if field == "category_id" and thing[field] not in cats:
                    guess = self.guess_category(thing.get("name") or "")
                    add(f"ref:{pid}:cat", f"🔗 {label}: die Kategorie gibt es nicht mehr",
                        "Andere Kategorie wählen", lambda v, t=thing: t.__setitem__("category_id", v or None),
                        cat_opts, guess, "📦 Ohne Kategorie", edit)

        for code, bc in self.barcodes.items():
            if bc.get("name"):
                ref(f"bc:{code}", bc, f"Barcode „{bc['name']}“", edit={"kind": "product", "id": product_key(bc["name"], bc.get("note"))})
        for recipe in self.recipes:
            for n, ri in enumerate(recipe["items"]):
                ref(f"ri:{recipe['id']}:{n}", ri, f"Zutat „{ri['name']}“ in „{recipe['name']}“", edit={"kind": "recipe", "id": recipe["id"]})
            if recipe.get("group") and recipe["group"] not in groups:
                add(f"rgroup:{recipe['id']}", f"🏷️ Rezept „{recipe['name']}“: die Rezept-Gruppe gibt es nicht mehr",
                    "Andere Gruppe wählen", lambda v, r=recipe: r.__setitem__("group", v or None),
                    group_opts, None, "Ohne Gruppe", {"kind": "recipe", "id": recipe["id"]})
        for hkey, hist in self.history.items():
            ref(f"hist:{hkey}", hist, f"Gedächtnis „{hist.get('name', '?')}“")
        for item in self.items:
            label = item["name"] + (f" · {item['note']}" if item.get("note") else "")
            ref(f"item:{item['id']}", item, f"Artikel „{label}“", ("category_id",), {"kind": "item", "id": item["id"]})
            if item.get("recipe_id") and item["recipe_id"] not in recipes:
                add(f"item_recipe:{item['id']}", f"🍽️ Artikel „{label}“ gehört zu einem Rezept, das es nicht mehr gibt",
                    "Rezept-Hinweis entfernen (der Artikel bleibt auf der Liste)",
                    lambda _v, i=item: i.__setitem__("recipe_id", None), edit={"kind": "item", "id": item["id"]})
            # 🛒 kein (gültiges) Geschäft – Vorschlag: so wie zuletzt gekauft
            # „Egal wo“ (kein Geschäft) ist erlaubt – nur melden, wenn das eingetragene Geschäft fehlt
            if item.get("store_id") and item["store_id"] not in stores:
                last = (self.history_for(item["name"]) or {}).get("store_id")
                state = "offen" if not item["checked"] else "erledigt"
                pkey = product_key(item["name"], item.get("note"))

                def set_store(v, i=item, pkey=pkey):
                    if v == DEL:
                        return self.async_delete_product(pkey)
                    i["store_id"] = v or None
                    return None
                add(f"nostore:{item['id']}",
                    f"🛒 „{label}“ ({state}) hat kein Geschäft" + (" – das alte gibt es nicht mehr" if item.get("store_id") else " („Egal wo“)"),
                    "Geschäft setzen" + (" (Vorschlag: wie zuletzt)" if last in stores else "") + " – oder ganz löschen, falls es das nicht gibt",
                    set_store, store_opts + ([] if item.get("recipe_id") else [del_opt(pkey)]),
                    last if last in stores else None, "🤷 Egal wo lassen", {"kind": "item", "id": item["id"]})
        # 📦 Produkte im Katalog ohne Kategorie – Vorschlag aus dem Wörterbuch
        for prod in self.products():
            if prod["category_id"] and prod["category_id"] in cats:
                continue
            label = prod["name"] + (f" · {prod['note']}" if prod["note"] else "")
            guess = self.guess_category(prod["name"])

            def set_cat(v, key=prod["key"]):
                if v == DEL:
                    return self.async_delete_product(key)
                return v and self.update_product(key, category_id=v)
            add(f"nocat:{prod['key']}", f"📦 „{label}“ hat keine Kategorie",
                "Kategorie setzen" + (" (Vorschlag aus dem Wörterbuch)" if guess else " – bitte selbst wählen") + " – oder ganz löschen, falls es das nicht gibt",
                set_cat, cat_opts + [del_opt(prod["key"])], guess, "📦 Ohne Kategorie lassen", {"kind": "product", "id": prod["key"]})

        # 🔧 Reparieren: nur was ausgewählt ist (bzw. bei fix=True alles mit Vorschlag)
        todo: dict[str, str] = dict(fixes or {})
        if fix and not fixes:
            todo = {pid: e.get("default") or "" for pid, (_a, e) in actions.items() if "options" not in e or e.get("default")}
        fixed = 0
        try:
            for pid, value in todo.items():
                if pid not in actions:
                    continue
                action, _entry = actions[pid]
                try:
                    result = action(value or "")
                    if hasattr(result, "__await__"):
                        await result
                except ValueError:  # hat sich durch eine andere Reparatur schon erledigt (z. B. Produkt weg)
                    continue
                except Exception:  # noqa: BLE001 – eine kaputte Reparatur darf die anderen nicht stoppen
                    _LOGGER.exception("Reparatur %s fehlgeschlagen", pid)
                    continue
                fixed += 1
        finally:
            if todo:
                self._changed()
        problems = [e["text"] for e in found]
        return {"items": found, "problems": problems, "count": len(found), "fixed": fixed}

    async def _drop_photo_by_id(self, key: str, pid: str) -> None:
        """Ein bestimmtes Foto eines Produkts löschen (nach Datei-ID, nicht nach Platz – der kann sich verschieben)."""
        entry = self.photos.get(key)
        if entry is None or pid not in self._photo_ids(entry):
            return
        await self.async_remove_photo(key, self._photo_ids(entry).index(pid))

    async def _async_delete_file(self, photo_id: str) -> None:
        path = self._photo_path(photo_id)
        await self.hass.async_add_executor_job(lambda: path.unlink(missing_ok=True))

    # ------------------------------------------------------------------ Barcodes
    @callback
    def learn_barcode(
        self,
        code: str,
        name: str,
        store_id: str | None,
        category_id: str | None,
        note: str | None = None,
        for_whom: str | None = None,
    ) -> None:
        """Merkt sich, welcher Artikel (Name + Notiz) zu einem Barcode gehört."""
        del for_whom  # die Packung weiß nicht, für wen sie ist
        self.barcodes[code] = {
            "name": name,
            "note": _note(note),
            "store_id": store_id,
            "category_id": category_id,
            "updated": _now_iso(),
        }

    @callback
    def assign_barcode(self, item_id: str, code: str) -> dict[str, Any]:
        """Einem Artikel, der schon auf der Liste steht, einen Barcode zuordnen."""
        item = self.get_item(item_id)
        code = "".join(ch for ch in str(code or "") if ch.isdigit())
        if not code:
            raise ValueError("Das ist kein gültiger Barcode.")
        self.learn_barcode(
            code, item["name"], item["store_id"], item["category_id"], item.get("note"), item.get("for_whom")
        )
        self._changed()
        return {"code": code, "name": item["name"], "note": item.get("note")}

    @callback
    def add_product_barcode(self, key: str, code: str) -> dict[str, Any]:
        """📦 Einem Katalog-Produkt nachträglich einen Barcode zuordnen (getippt oder gescannt)."""
        key = (key or "").lower()
        prod = next((p for p in self.products() if p["key"] == key), None)
        if prod is None:
            raise ValueError("Dieses Produkt gibt es nicht (mehr).")
        code = "".join(ch for ch in str(code or "") if ch.isdigit())
        if len(code) < 6:
            raise ValueError("Das ist kein gültiger Barcode (mindestens 6 Ziffern).")
        known = self.barcodes.get(code)
        if known and known.get("name") and product_key(known["name"], known.get("note")) != key:
            raise ValueError(f"Dieser Barcode gehört schon zu „{known['name']}“.")
        self.learn_barcode(code, prod["name"], prod.get("store_id"), prod.get("category_id"), prod.get("note"))
        self._changed()
        return {"code": code, "name": prod["name"], "note": prod.get("note"), "key": key}

    # ------------------------------------------------------------------ Gesehen
    @callback
    def mark_seen(self, user_id: str, store: str) -> None:
        """Merkt sich, wann jemand ein Geschäft (oder „all“) zuletzt angeschaut hat."""
        now = _now_iso()
        mine = self.seen.setdefault(user_id, {})
        if store in ("all", "init"):
            # „all“ = ✨ überall angeschaut; „init“ (erster Besuch) = zusätzlich alle 🔴 Blasen weg
            for key in [s["id"] for s in self.stores] + ["none", "all"]:
                mine[key] = now
                if store == "init":
                    mine["b:" + key] = now
        else:
            mine[str(store)[:80]] = now
        # ✨ „n:<Artikel>“ = dieser Artikel wurde als gesehen angetippt – nach 2 Tagen ist das nicht mehr nötig
        limit = (dt_util.utcnow() - timedelta(days=2)).isoformat()
        for key in [k for k, v in mine.items() if k.startswith("n:") and str(v) < limit]:
            del mine[key]
        self._changed()

    # ------------------------------------------------------------------ 🩺 Gesundheit (für den Sensor)
    async def async_health(self) -> dict[str, Any]:
        """Prüft wie „Alles ok?“ (ohne etwas zu reparieren) und merkt sich das Ergebnis: ok / hinweis / problem."""
        try:
            res = await self.async_check(fix=False)
            n = len(res.get("items") or [])
        except Exception:  # noqa: BLE001 – der Sensor soll nie die Integration stören
            n = -1
        recent = self._errors_since(timedelta(hours=24))
        if n < 0:
            level = "unbekannt"
        elif n > 5:
            level = "problem"
        elif n > 0 or recent:
            level = "hinweis"
        else:
            level = "ok"
        self.health_cache = {"level": level, "probleme": max(n, 0), "fehler_24h": recent, "geprueft": _now_iso()}
        return self.health_cache

    # ------------------------------------------------------------------ Aufräumen
    @callback
    def cleanup(
        self,
        reference: datetime | None = None,
        force: bool = False,
        min_age_days: int | None = None,
        scheduled: bool = False,
    ) -> list[dict[str, Any]]:
        """Hakt alte Einträge automatisch ab – gelöscht wird nichts.

        Rezept-Zutaten werden dabei ganz entfernt (wie beim normalen Abhaken).
        Ein offener Artikel wird abgehakt, wenn er am Aufräum-Tag mindestens
        `min_age_days` Tage auf der Liste steht. Beispiel: Dienstag eingetragen,
        Aufräumen sonntags -> der erste Sonntag (5 Tage) lässt ihn offen,
        der zweite Sonntag (12 Tage) hakt ihn ab.
        """
        ref_date = dt_util.as_local(reference or dt_util.now()).date()
        min_age = self.min_age_days if min_age_days is None else int(min_age_days)
        done: list[dict[str, Any]] = []
        now = _now_iso()
        keep: list[dict[str, Any]] = []
        for item in self.items:
            keep.append(item)
            if item["checked"]:
                continue
            # „war aus“ startet die Frist neu: gezählt wird ab dem späteren Datum
            added = max(filter(None, (_local_date(item.get("added_at")), _local_date(item.get("out_at")))), default=ref_date)
            if force or (ref_date - added).days >= min_age:
                item.update(checked=True, checked_at=now, checked_by=None, out_at=None)
                with self._via("cleanup"):
                    self._log("check", item, who="")
                done.append(item)
                if item.get("recipe_id"):
                    keep.pop()  # Rezept-Zutaten verschwinden statt abgehakt zu bleiben
        self.items = keep
        if scheduled:
            self.last_cleanup = now
        if done or scheduled:
            self._changed()
        self.hass.bus.async_fire(
            EVENT_CLEANUP,
            {
                "checked": len(done),
                "names": [i["name"] for i in done],
                "still_open": sum(1 for i in self.items if not i["checked"]),
                "force": force,
                "scheduled": scheduled,
            },
        )
        _LOGGER.debug("Einkaufsliste aufgeräumt: %s Artikel abgehakt", len(done))
        return done

    @callback
    def async_start_scheduler(self) -> None:
        self.expire_offers()
        self._unsub_offer_exp = async_track_time_interval(self.hass, lambda now: self.expire_offers(), timedelta(hours=1))
        hour, minute = self.cleanup_time
        self._unsub_time = async_track_time_change(
            self.hass, self._handle_time, hour=hour, minute=minute, second=0
        )
        # Verpasst (z. B. HA war zur Aufräumzeit aus)? Dann jetzt nachholen.
        last_planned = self.last_scheduled_cleanup()
        last_done = dt_util.parse_datetime(self.last_cleanup or "")
        if last_done is None or last_done < last_planned:
            self.cleanup(reference=last_planned, scheduled=True)

    @callback
    def _handle_time(self, now: datetime) -> None:
        now = dt_util.as_local(now)
        if now.weekday() == self.cleanup_weekday:
            self.cleanup(reference=now, scheduled=True)

    @callback
    def async_stop(self) -> None:
        if getattr(self, "sync", None) is not None:
            self.sync.stop()
        if getattr(self, "mail", None) is not None:
            self.mail.stop()
        if getattr(self, "offers", None) is not None:
            self.offers.stop()
        if getattr(self, "_unsub_offer_exp", None):
            self._unsub_offer_exp()
            self._unsub_offer_exp = None
        if self._unsub_time:
            self._unsub_time()
            self._unsub_time = None

    # ------------------------------------------------------------------ Rezepte
    def _recipe_items(self, items: list[dict[str, Any]]) -> list[dict[str, Any]]:
        out = []
        seen = set()
        for raw in items:
            raw_name, qty = raw.get("name"), raw.get("quantity")
            if not _clean(qty):
                raw_name, qty = split_qty(raw_name)
            name, alias_note = self.resolve_alias(_nice(raw_name), raw.get("note"))  # 🏷️ Spitzname
            if not name:
                continue
            entry = {
                "name": name,
                "quantity": norm_qty(_clean(qty)),
                "note": _note(alias_note),
                "for_whom": _clean(raw.get("for_whom")),
                "store_id": self._check_store(raw.get("store_id")),
                "category_id": self._check_category(raw.get("category_id")),
                "basic": bool(raw.get("basic")),  # 🧂 Grundvorrat („haben wir immer“)
            }
            key = _key(entry["name"], entry["note"], entry["for_whom"], entry["store_id"])
            if key in seen:
                raise ValueError(f"„{name}“ steht doppelt im Rezept.")
            seen.add(key)
            out.append(entry)
            code = "".join(ch for ch in str(raw.get("barcode") or "") if ch.isdigit())
            if code:  # im Rezept gescannt -> Barcode gehört ab jetzt zu diesem Produkt
                self.learn_barcode(code, name, entry["store_id"], entry["category_id"], entry["note"])
        return sorted(out, key=_abc)  # 🔤 Zutaten immer A–Z

    def _group(self, value: Any) -> str | None:
        """🏷️ Rezept-Gruppe – nur eine, die es in der Liste gibt, sonst leer."""
        return value if any(g["id"] == value for g in self.recipe_groups) else None

    def _recipe_name(self, name: str | None, skip_id: str | None = None) -> str:
        name = _nice(name)
        if not name:
            raise ValueError("Das Rezept braucht einen Namen.")
        for recipe in self.recipes:
            if recipe["id"] != skip_id and recipe["name"].lower() == name.lower():
                raise ValueError(f"Das Rezept „{name}“ gibt es schon.")
        return name

    @callback
    def add_recipe(
        self,
        name: str,
        items: list[dict[str, Any]] | None = None,
        icon: str | None = None,
        steps: str | None = None,
        heat: list[dict[str, Any]] | None = None,
        servings: int | None = None,
        servings_unit: str | None = None,
        group: str | None = None,
    ) -> dict[str, Any]:
        recipe = {
            "id": _new_id(),
            "name": self._recipe_name(name),
            "icon": _icon(icon, "mdi:silverware-fork-knife"),
            "items": self._recipe_items(items or []),
            "steps": _clean_steps(steps),
            "heat": _clean_heat(heat),
            "servings": _servings(servings),
            "servings_unit": _servings_unit(servings_unit),
            "group": self._group(group),
        }
        self.recipes.append(recipe)
        self._changed()
        return recipe

    @callback
    def update_recipe(self, recipe_id: str, **fields: Any) -> dict[str, Any]:
        recipe = self.recipe_by_id(recipe_id)
        if recipe is None:
            raise ValueError("Dieses Rezept gibt es nicht (mehr).")
        new_name = self._recipe_name(fields["name"], recipe_id) if "name" in fields else None
        new_icon = _icon(fields["icon"], recipe.get("icon", "mdi:silverware-fork-knife")) if "icon" in fields else None
        new_items = self._recipe_items(fields["items"]) if "items" in fields else None
        if "name" in fields:
            recipe["name"] = new_name
        if "icon" in fields:
            recipe["icon"] = new_icon
        if "items" in fields:
            recipe["items"] = new_items
        if "steps" in fields:
            recipe["steps"] = _clean_steps(fields["steps"])
        if "heat" in fields:
            recipe["heat"] = _clean_heat(fields["heat"])
        if "servings" in fields:
            recipe["servings"] = _servings(fields["servings"])
        if "servings_unit" in fields:
            recipe["servings_unit"] = _servings_unit(fields["servings_unit"])
        if "group" in fields:
            recipe["group"] = self._group(fields["group"])
        self._changed()
        return recipe

    @callback
    def remove_recipe(self, recipe_id: str) -> None:
        recipe = self.recipe_by_id(recipe_id)
        if recipe is None:
            raise ValueError("Dieses Rezept gibt es nicht (mehr).")
        self.recipes.remove(recipe)
        # Zutaten dieses Rezepts: offene bleiben als normale Artikel, sofern es sie
        # nicht schon normal gibt; abgehakte Rezept-Einträge verschwinden.
        keep = []
        drop: list[str] = []
        for item in self.items:
            if item.get("recipe_id") != recipe_id:
                keep.append(item)
                continue
            item["recipe_id"] = None
            twin = self._find_same(
                item["name"], item.get("note"), item.get("for_whom"), item["store_id"], None, item["id"]
            )
            if not item["checked"] and (twin is None or twin["checked"]):
                keep.append(item)
                if twin is not None:  # abgehakter Zwilling: der offene Eintrag bleibt, Doppel vermeiden
                    drop.append(twin["id"])
        self.items = [i for i in keep if i["id"] not in drop]
        base = recipe_photo_key(recipe_id)
        for pkey in [k for k in self.photos if k == base or k.startswith(base + "#")]:  # Rezept-Fotos und Schritt-Fotos
            self.hass.async_create_task(self.async_remove_photo(pkey))
        self._changed()

    @callback
    def apply_recipe(
        self,
        recipe_id: str,
        added_by: str | None = None,
        only: list[int] | None = None,
        overrides: dict[Any, dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        """Zutaten eines Rezepts auf die Liste setzen (alle oder nur die ausgewählten Nummern)."""
        recipe = self.recipe_by_id(recipe_id)
        if recipe is None:
            raise ValueError("Dieses Rezept gibt es nicht (mehr).")
        if not recipe["items"]:
            raise ValueError("Das Rezept hat noch keine Zutaten.")
        # overrides: {Nummer: {"quantity": "600 g", "store_id": "…" oder "" für Egal wo}}
        over = {int(k): v or {} for k, v in (overrides or {}).items()}
        numbered = list(enumerate(recipe["items"]))
        if only is not None:
            wanted = set(only)
            numbered = [(n, e) for n, e in numbered if n in wanted]
            if not numbered:
                raise ValueError("Du hast keine Zutat ausgewählt.")
        added = 0
        already = 0
        for n, entry in numbered:
            ov = over.get(n, {})
            hist = self.history_for(entry["name"]) or {}
            if "store_id" in ov:  # 🛒 beim Draufsetzen gewählt (noch nie gekauft)
                store_id = ov["store_id"] or None
            else:
                store_id = entry["store_id"] or hist.get("store_id")
            store_id = store_id if self.store_by_id(store_id) else None
            quantity = norm_qty(_clean(ov["quantity"])) if "quantity" in ov else entry["quantity"]
            cat_id = entry["category_id"] or hist.get("category_id") or self.guess_category(entry["name"])
            same = self._find_same(
                entry["name"], entry["note"], entry["for_whom"], store_id, recipe_id
            )
            if same is not None and not same["checked"]:
                already += 1
            else:
                added += 1
            with self._via("recipe"):
                self.add_item(
                    entry["name"],
                    store_id=store_id,
                    category_id=cat_id if self.category_by_id(cat_id) else None,
                    quantity=quantity,
                    note=entry["note"],
                    for_whom=entry["for_whom"],
                    added_by=added_by,
                    recipe_id=recipe_id,
                    notify=False,
                )
        self._changed()
        return {"added": added, "already": already}

    @callback
    def unapply_recipe(self, recipe_id: str) -> dict[str, Any]:
        """Alle offenen Zutaten eines Rezepts wieder von der Liste nehmen."""
        recipe = self.recipe_by_id(recipe_id)
        if recipe is None:
            raise ValueError("Dieses Rezept gibt es nicht (mehr).")
        gone = [i for i in self.items if i.get("recipe_id") == recipe_id and not i["checked"]]
        with self._via("recipe"):
            for item in gone:
                self.items.remove(item)
                self._log("remove", item, f"Rezept „{recipe['name']}“ von der Liste genommen")
        if gone:
            self._changed()
        return {"removed": len(gone)}

    # ------------------------------------------------------ Geschäfte/Kategorien
    def _list(self, kind: str) -> list[dict[str, Any]]:
        if kind == "stores":
            return self.stores
        if kind == "categories":
            return self.categories
        if kind == "recipes":
            return self.recipes
        if kind == "persons":
            return self.persons
        if kind == "recipe_groups":
            return self.recipe_groups
        raise ValueError("Unbekannte Liste.")

    def _unique_name(self, kind: str, name: str | None, skip_id: str | None = None) -> str:
        name = _nice(name)
        if not name:
            raise ValueError("Der Name darf nicht leer sein.")
        for entry in self._list(kind):
            if entry["id"] != skip_id and entry["name"].lower() == name.lower():
                raise ValueError(f"„{name}“ gibt es schon.")
        return name

    @callback
    def add_group(self, kind: str, name: str, color: str | None = None, icon: str | None = None) -> dict[str, Any]:
        entry: dict[str, Any] = {"id": _new_id(), "name": self._unique_name(kind, name)}
        if kind == "stores":
            entry["color"] = _clean(color) or "#607d8b"
            entry["icon"] = _icon(icon, "mdi:cart")
            entry["zone"] = None
            entry["zones"] = []
        elif kind == "persons":
            entry["color"] = _clean(color) or PERSON_COLORS[len(self.persons) % len(PERSON_COLORS)]
        elif kind == "recipe_groups":
            entry["icon"] = _icon(icon, "mdi:silverware-fork-knife")
            entry["color"] = _clean(color) or CATEGORY_COLORS[len(self.recipe_groups) % len(CATEGORY_COLORS)]
        else:
            entry["icon"] = _icon(icon, "mdi:tag-outline")
            if kind == "categories":
                entry["color"] = _clean(color) or CATEGORY_COLORS[len(self.categories) % len(CATEGORY_COLORS)]
        self._list(kind).append(entry)
        self._changed()
        return entry

    @callback
    def update_group(self, kind: str, group_id: str, **fields: Any) -> dict[str, Any]:
        entry = next((e for e in self._list(kind) if e["id"] == group_id), None)
        if entry is None:
            raise ValueError("Gibt es nicht (mehr).")
        if "name" in fields:
            old = entry["name"]
            entry["name"] = self._unique_name(kind, fields["name"], group_id)
            if kind == "persons" and old != entry["name"]:
                # Umbenennen: überall mitziehen
                for thing in self.items + [ri for r in self.recipes for ri in r["items"]]:
                    if (thing.get("for_whom") or "").lower() == old.lower():
                        thing["for_whom"] = entry["name"]
        if "zone" in fields and kind == "stores" and "zones" not in fields:  # alt: genau eine Zone
            fields["zones"] = [fields["zone"]] if _clean(fields["zone"]) else []
        if "zones" in fields and kind == "stores":  # 📍 beliebig viele Zonen (z. B. mehrere Filialen)
            zones: list[str] = []
            for zone in fields["zones"] or []:
                zone = _clean(zone)
                if not zone:
                    continue
                if not zone.startswith("zone."):
                    raise ValueError("Das ist keine Zone.")
                if zone not in zones:
                    zones.append(zone)
            entry["zones"] = zones
            entry["zone"] = zones[0] if zones else None
        if "color" in fields and kind in ("stores", "categories", "persons", "recipe_groups"):
            entry["color"] = _clean(fields["color"]) or entry.get("color")
        if "icon" in fields and kind == "stores" and not _clean(fields["icon"]):
            entry["icon"] = None  # 🏪 leer = automatisch (Icon der Zone, sonst Einkaufswagen)
        elif "icon" in fields and kind != "persons":
            entry["icon"] = _icon(fields["icon"], entry.get("icon") or "mdi:tag-outline")
        if "cat_order" in fields and kind == "stores":  # 🗺️ eigene Kategorien-Reihenfolge (None = wie alle)
            if fields["cat_order"] is None:
                entry["cat_order"] = None
            else:
                known = {c["id"] for c in self.categories}
                entry["cat_order"] = [c for c in dict.fromkeys(fields["cat_order"]) if c in known]
        if "brands" in fields and kind == "stores":  # 🏷️ eigene Eigenmarken („Milsani, Moser Roth“)
            entry["brands"] = [b.strip() for b in re.split(r"[,;]", fields["brands"] or "") if b.strip()][:30]
        self._changed()
        return entry

    @callback
    def remove_group(self, kind: str, group_id: str) -> None:
        lst = self._list(kind)
        entry = next((e for e in lst if e["id"] == group_id), None)
        if entry is None:
            raise ValueError("Gibt es nicht (mehr).")
        lst.remove(entry)
        if kind == "persons":
            # Artikel behalten den Namen als Text – es geht nichts verloren
            self._changed()
            return
        if kind == "recipe_groups":
            # Rezepte bleiben, sie haben dann nur keine Gruppe mehr
            for recipe in self.recipes:
                if recipe.get("group") == group_id:
                    recipe["group"] = None
            self._changed()
            return
        field = "store_id" if kind == "stores" else "category_id"
        for item in self.items:
            if item[field] == group_id:
                item[field] = None
        for hist in list(self.history.values()) + list(self.barcodes.values()):
            if hist.get(field) == group_id:
                hist[field] = None
        for recipe in self.recipes:
            for entry_item in recipe["items"]:
                if entry_item.get(field) == group_id:
                    entry_item[field] = None
        self._changed()

    @callback
    def reorder(self, kind: str, ids: list[str]) -> None:
        lst = self._list(kind)
        pos = {gid: n for n, gid in enumerate(ids)}
        lst.sort(key=lambda e: pos.get(e["id"], len(ids)))
        self._changed()
