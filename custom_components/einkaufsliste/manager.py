"""Das Herzstück: speichert Geschäfte, Kategorien und Artikel."""

from __future__ import annotations

from collections.abc import Callable
from datetime import date, datetime, timedelta
import logging
from typing import Any
import uuid

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.dispatcher import async_dispatcher_send
from homeassistant.helpers.event import async_track_time_change
from homeassistant.helpers.storage import Store
from homeassistant.util import dt as dt_util

from .const import (
    CONF_CLEANUP_TIME,
    CONF_CLEANUP_WEEKDAY,
    CONF_MIN_AGE_DAYS,
    CONF_ONLY_CHECKED,
    DEFAULT_CATEGORIES,
    DEFAULT_OPTIONS,
    DEFAULT_STORES,
    EVENT_CLEANUP,
    EVENT_ITEM_ADDED,
    HISTORY_LIMIT,
    SAVE_DELAY,
    SIGNAL_UPDATED,
    STORAGE_KEY,
    STORAGE_VERSION,
    UNDO_WINDOW_SECONDS,
)

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


@callback
def person_name_for_user(hass: HomeAssistant, user_id: str | None) -> str | None:
    """Sucht die Person (person.xyz), die zu einem HA-Benutzer gehört."""
    if not user_id:
        return None
    for state in hass.states.async_all("person"):
        if state.attributes.get("user_id") == user_id:
            return state.attributes.get("friendly_name") or state.name
    return None


class EinkaufslisteManager:
    """Verwaltet alle Daten der Einkaufsliste."""

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry) -> None:
        self.hass = hass
        self.entry = entry
        self._store: Store = Store(hass, STORAGE_VERSION, STORAGE_KEY)
        self.stores: list[dict[str, Any]] = []
        self.categories: list[dict[str, Any]] = []
        self.items: list[dict[str, Any]] = []
        self.history: dict[str, dict[str, Any]] = {}
        self.last_cleanup: str | None = None
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

    @property
    def only_checked(self) -> bool:
        return bool(self._opt(CONF_ONLY_CHECKED))

    # ------------------------------------------------------------ Laden/Speichern
    async def async_load(self) -> None:
        data = await self._store.async_load()
        if data is None:
            self.stores = [
                {"id": _new_id(), "name": n, "color": c, "icon": i}
                for n, c, i in DEFAULT_STORES
            ]
            self.categories = [
                {"id": _new_id(), "name": n, "icon": i} for n, i in DEFAULT_CATEGORIES
            ]
            self.last_cleanup = _now_iso()
            self._schedule_save()
            return
        self.stores = data.get("stores", [])
        self.categories = data.get("categories", [])
        self.items = data.get("items", [])
        self.history = data.get("history", {})
        self.last_cleanup = data.get("last_cleanup")

    def _to_storage(self) -> dict[str, Any]:
        return {
            "stores": self.stores,
            "categories": self.categories,
            "items": self.items,
            "history": self.history,
            "last_cleanup": self.last_cleanup,
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
            "history": history[:300],
            "settings": {
                "cleanup_weekday": self.cleanup_weekday,
                "cleanup_time": "%02d:%02d" % self.cleanup_time,
                "min_age_days": self.min_age_days,
                "only_checked": self.only_checked,
                "next_cleanup": self.next_cleanup().isoformat(),
            },
        }

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

    def find_item(self, name: str, store_id: str | None = None) -> dict[str, Any]:
        wanted = (_clean(name) or "").lower()
        matches = [
            i
            for i in self.items
            if i["name"].lower() == wanted and (store_id is None or i["store_id"] == store_id)
        ]
        if not matches:
            raise ValueError(f"„{name}“ steht nicht auf der Liste.")
        # offene Artikel zuerst
        matches.sort(key=lambda i: i["checked"])
        return matches[0]

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
        self.history[key] = entry
        if len(self.history) > HISTORY_LIMIT:
            oldest = sorted(self.history.items(), key=lambda kv: kv[1].get("last_used", ""))
            for k, _ in oldest[: len(self.history) - HISTORY_LIMIT]:
                self.history.pop(k, None)

    def _fire_added(self, item: dict[str, Any], readded: bool) -> None:
        store = self.store_by_id(item["store_id"])
        cat = self.category_by_id(item["category_id"])
        self.hass.bus.async_fire(
            EVENT_ITEM_ADDED,
            {
                "item_id": item["id"],
                "name": item["name"],
                "quantity": item.get("quantity"),
                "store": store["name"] if store else None,
                "category": cat["name"] if cat else None,
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
        category_id: str | None = None,
        quantity: str | None = None,
        note: str | None = None,
        added_by: str | None = None,
    ) -> dict[str, Any]:
        name = _clean(name)
        if not name:
            raise ValueError("Ohne Namen geht's nicht – was soll denn gekauft werden?")
        store_id = self._check_store(store_id)
        category_id = self._check_category(category_id)
        quantity, note = _clean(quantity), _clean(note)

        existing = next(
            (
                i
                for i in self.items
                if i["name"].lower() == name.lower() and i["store_id"] == store_id
            ),
            None,
        )
        if existing is not None:
            readded = existing["checked"]
            if readded:
                # Haken raus – steht wieder auf der Liste
                existing.update(
                    checked=False,
                    checked_at=None,
                    checked_by=None,
                    added_at=_now_iso(),
                    added_by=added_by,
                )
            if quantity:
                existing["quantity"] = quantity
            if note:
                existing["note"] = note
            if category_id:
                existing["category_id"] = category_id
            self._remember(existing)
            self._changed()
            if readded:
                self._fire_added(existing, True)
            return existing

        item = {
            "id": _new_id(),
            "name": name,
            "store_id": store_id,
            "category_id": category_id,
            "quantity": quantity,
            "note": note,
            "checked": False,
            "added_by": added_by,
            "added_at": _now_iso(),
            "checked_by": None,
            "checked_at": None,
        }
        self.items.append(item)
        self._remember(item)
        self._changed()
        self._fire_added(item, False)
        return item

    @callback
    def update_item(self, item_id: str, **fields: Any) -> dict[str, Any]:
        item = self.get_item(item_id)
        if "name" in fields:
            name = _clean(fields["name"])
            if not name:
                raise ValueError("Der Name darf nicht leer sein.")
            item["name"] = name
        if "store_id" in fields:
            item["store_id"] = self._check_store(fields["store_id"])
        if "category_id" in fields:
            item["category_id"] = self._check_category(fields["category_id"])
        if "quantity" in fields:
            item["quantity"] = _clean(fields["quantity"])
        if "note" in fields:
            item["note"] = _clean(fields["note"])
        self._remember_quiet(item)
        self._changed()
        return item

    def _remember_quiet(self, item: dict[str, Any]) -> None:
        key = item["name"].lower()
        if key in self.history:
            self.history[key].update(
                store_id=item["store_id"], category_id=item["category_id"]
            )

    @callback
    def set_checked(
        self, item_id: str, checked: bool | None = None, by: str | None = None
    ) -> dict[str, Any]:
        """Abhaken oder Haken wieder rausnehmen (None = umschalten)."""
        item = self.get_item(item_id)
        if checked is None:
            checked = not item["checked"]
        if checked == item["checked"]:
            return item
        if checked:
            item.update(checked=True, checked_at=_now_iso(), checked_by=by)
        else:
            checked_at = dt_util.parse_datetime(item.get("checked_at") or "")
            oops = (
                checked_at is not None
                and (dt_util.utcnow() - checked_at).total_seconds() < UNDO_WINDOW_SECONDS
            )
            item.update(checked=False, checked_at=None, checked_by=None)
            if not oops:
                # Richtig "wieder drauf": neues Datum, neuer Name
                item.update(added_at=_now_iso(), added_by=by)
                self._remember(item)
                self._fire_added(item, True)
        self._changed()
        return item

    @callback
    def remove_item(self, item_id: str) -> None:
        item = self.get_item(item_id)
        self.items.remove(item)
        self._changed()

    @callback
    def clear_checked(self) -> int:
        before = len(self.items)
        self.items = [i for i in self.items if not i["checked"]]
        removed = before - len(self.items)
        if removed:
            self._changed()
        return removed

    # ------------------------------------------------------------------ Aufräumen
    @callback
    def cleanup(
        self,
        reference: datetime | None = None,
        force: bool = False,
        min_age_days: int | None = None,
        scheduled: bool = False,
    ) -> list[dict[str, Any]]:
        """Löscht alte Einträge.

        Ein Artikel fliegt raus, wenn er am Aufräum-Tag mindestens
        `min_age_days` Tage auf der Liste steht. Beispiel: Dienstag eingetragen,
        Aufräumen sonntags -> der erste Sonntag (5 Tage) lässt ihn stehen,
        der zweite Sonntag (12 Tage) löscht ihn.
        """
        ref_date = dt_util.as_local(reference or dt_util.now()).date()
        min_age = self.min_age_days if min_age_days is None else int(min_age_days)
        keep: list[dict[str, Any]] = []
        removed: list[dict[str, Any]] = []
        for item in self.items:
            if force:
                removed.append(item)
                continue
            if self.only_checked and not item["checked"]:
                keep.append(item)
                continue
            added = _local_date(item.get("added_at")) or ref_date
            if (ref_date - added).days >= min_age:
                removed.append(item)
            else:
                keep.append(item)
        self.items = keep
        if scheduled:
            self.last_cleanup = _now_iso()
        if removed or scheduled:
            self._changed()
        self.hass.bus.async_fire(
            EVENT_CLEANUP,
            {
                "removed": len(removed),
                "names": [i["name"] for i in removed],
                "remaining": len(keep),
                "force": force,
                "scheduled": scheduled,
            },
        )
        _LOGGER.debug("Einkaufsliste aufgeräumt: %s Artikel entfernt", len(removed))
        return removed

    @callback
    def async_start_scheduler(self) -> None:
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
        if self._unsub_time:
            self._unsub_time()
            self._unsub_time = None

    # ------------------------------------------------------ Geschäfte/Kategorien
    def _list(self, kind: str) -> list[dict[str, Any]]:
        if kind == "stores":
            return self.stores
        if kind == "categories":
            return self.categories
        raise ValueError("Unbekannte Liste.")

    def _unique_name(self, kind: str, name: str | None, skip_id: str | None = None) -> str:
        name = _clean(name)
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
            entry["icon"] = _clean(icon) or "mdi:cart"
        else:
            entry["icon"] = _clean(icon) or "mdi:tag-outline"
        self._list(kind).append(entry)
        self._changed()
        return entry

    @callback
    def update_group(self, kind: str, group_id: str, **fields: Any) -> dict[str, Any]:
        entry = next((e for e in self._list(kind) if e["id"] == group_id), None)
        if entry is None:
            raise ValueError("Gibt es nicht (mehr).")
        if "name" in fields:
            entry["name"] = self._unique_name(kind, fields["name"], group_id)
        if "color" in fields and kind == "stores":
            entry["color"] = _clean(fields["color"]) or entry.get("color")
        if "icon" in fields:
            entry["icon"] = _clean(fields["icon"]) or entry.get("icon")
        self._changed()
        return entry

    @callback
    def remove_group(self, kind: str, group_id: str) -> None:
        lst = self._list(kind)
        entry = next((e for e in lst if e["id"] == group_id), None)
        if entry is None:
            raise ValueError("Gibt es nicht (mehr).")
        lst.remove(entry)
        field = "store_id" if kind == "stores" else "category_id"
        for item in self.items:
            if item[field] == group_id:
                item[field] = None
        for hist in self.history.values():
            if hist.get(field) == group_id:
                hist[field] = None
        self._changed()

    @callback
    def reorder(self, kind: str, ids: list[str]) -> None:
        lst = self._list(kind)
        pos = {gid: n for n, gid in enumerate(ids)}
        lst.sort(key=lambda e: pos.get(e["id"], len(ids)))
        self._changed()
