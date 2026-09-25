"""Das Herzstück: speichert Geschäfte, Kategorien, Artikel und Rezepte."""

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
        self.recipes = data.get("recipes", [])
        self.history = data.get("history", {})
        self.last_cleanup = data.get("last_cleanup")
        for item in self.items:  # ältere Daten auffüllen
            item.setdefault("for_whom", None)
            item.setdefault("recipe_id", None)

    def _to_storage(self) -> dict[str, Any]:
        return {
            "stores": self.stores,
            "categories": self.categories,
            "items": self.items,
            "recipes": self.recipes,
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
            "recipes": self.recipes,
            "history": history[:300],
            "settings": {
                "cleanup_weekday": self.cleanup_weekday,
                "cleanup_time": "%02d:%02d" % self.cleanup_time,
                "min_age_days": self.min_age_days,
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
        category_id: str | None = None,
        quantity: str | None = None,
        note: str | None = None,
        for_whom: str | None = None,
        added_by: str | None = None,
        recipe_id: str | None = None,
        notify: bool = True,
    ) -> dict[str, Any]:
        """Artikel hinzufügen.

        Gibt es schon einen Artikel mit gleichem Namen, gleicher Notiz, gleichem
        „für wen“ und gleichem Geschäft, wird kein zweiter angelegt: Ist er abgehakt, kommt er wieder
        auf die Liste (Haken raus), sonst werden nur die Angaben aktualisiert.
        """
        name = _clean(name)
        if not name:
            raise ValueError("Ohne Namen geht's nicht – was soll denn gekauft werden?")
        store_id = self._check_store(store_id)
        category_id = self._check_category(category_id)
        quantity, note, for_whom = _clean(quantity), _clean(note), _clean(for_whom)

        # Rezept-Zutaten kommen zusätzlich auf die Liste (eigener Eintrag pro Rezept)
        recipe_id = recipe_id if self.recipe_by_id(recipe_id) else None
        existing = self._find_same(name, note, for_whom, store_id, recipe_id)
        if existing is not None:
            readded = existing["checked"]
            if readded:
                existing.update(
                    checked=False,
                    checked_at=None,
                    checked_by=None,
                    added_at=_now_iso(),
                    added_by=added_by,
                )
            if category_id:
                existing["category_id"] = category_id
            if quantity:
                existing["quantity"] = quantity
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
            "category_id": category_id,
            "quantity": quantity,
            "note": note,
            "for_whom": for_whom,
            "recipe_id": recipe_id,
            "checked": False,
            "added_by": added_by,
            "added_at": _now_iso(),
            "checked_by": None,
            "checked_at": None,
        }
        self.items.append(item)
        self._remember(item)
        if notify:
            self._changed()
        self._fire_added(item, False)
        return item

    @callback
    def update_item(self, item_id: str, **fields: Any) -> dict[str, Any]:
        item = self.get_item(item_id)
        new = {
            "name": _clean(fields.get("name", item["name"])),
            "note": _clean(fields.get("note", item.get("note"))),
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
        item.update(new)
        if "category_id" in fields:
            item["category_id"] = self._check_category(fields["category_id"])
        if "quantity" in fields:
            item["quantity"] = _clean(fields["quantity"])
        key = item["name"].lower()
        if key in self.history:
            self.history[key].update(store_id=item["store_id"], category_id=item["category_id"])
        self._changed()
        return item

    @callback
    def set_checked(
        self, item_id: str, checked: bool | None = None, by: str | None = None
    ) -> dict[str, Any]:
        """Abhaken oder wieder auf die Liste nehmen (None = umschalten)."""
        item = self.get_item(item_id)
        if checked is None:
            checked = not item["checked"]
        if checked == item["checked"]:
            return item
        if checked and item.get("recipe_id"):
            # Rezept-Zutaten verschwinden beim Abhaken ganz von der Liste
            self.items.remove(item)
            self._changed()
            return {**item, "checked": True, "checked_at": _now_iso(), "checked_by": by, "removed": True}
        if checked:
            item.update(checked=True, checked_at=_now_iso(), checked_by=by)
        else:
            # Wieder drauf: neues Datum, und wer ihn reinnimmt, steht dahinter
            item.update(
                checked=False,
                checked_at=None,
                checked_by=None,
                added_at=_now_iso(),
                added_by=by,
            )
            self._remember(item)
            self._fire_added(item, True)
        self._changed()
        return item

    @callback
    def remove_item(self, item_id: str) -> None:
        item = self.get_item(item_id)
        self.items.remove(item)
        self._changed()

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
            added = _local_date(item.get("added_at")) or ref_date
            if force or (ref_date - added).days >= min_age:
                item.update(checked=True, checked_at=now, checked_by=None)
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

    # ------------------------------------------------------------------ Rezepte
    def _recipe_items(self, items: list[dict[str, Any]]) -> list[dict[str, Any]]:
        out = []
        seen = set()
        for raw in items:
            name = _clean(raw.get("name"))
            if not name:
                continue
            entry = {
                "name": name,
                "quantity": _clean(raw.get("quantity")),
                "note": _clean(raw.get("note")),
                "for_whom": _clean(raw.get("for_whom")),
                "store_id": self._check_store(raw.get("store_id")),
                "category_id": self._check_category(raw.get("category_id")),
            }
            key = _key(entry["name"], entry["note"], entry["for_whom"], entry["store_id"])
            if key in seen:
                raise ValueError(f"„{name}“ steht doppelt im Rezept.")
            seen.add(key)
            out.append(entry)
        return out

    def _recipe_name(self, name: str | None, skip_id: str | None = None) -> str:
        name = _clean(name)
        if not name:
            raise ValueError("Das Rezept braucht einen Namen.")
        for recipe in self.recipes:
            if recipe["id"] != skip_id and recipe["name"].lower() == name.lower():
                raise ValueError(f"Das Rezept „{name}“ gibt es schon.")
        return name

    @callback
    def add_recipe(
        self, name: str, items: list[dict[str, Any]] | None = None, icon: str | None = None
    ) -> dict[str, Any]:
        recipe = {
            "id": _new_id(),
            "name": self._recipe_name(name),
            "icon": _icon(icon, "mdi:silverware-fork-knife"),
            "items": self._recipe_items(items or []),
        }
        self.recipes.append(recipe)
        self._changed()
        return recipe

    @callback
    def update_recipe(self, recipe_id: str, **fields: Any) -> dict[str, Any]:
        recipe = self.recipe_by_id(recipe_id)
        if recipe is None:
            raise ValueError("Dieses Rezept gibt es nicht (mehr).")
        if "name" in fields:
            recipe["name"] = self._recipe_name(fields["name"], recipe_id)
        if "icon" in fields:
            recipe["icon"] = _icon(fields["icon"], recipe.get("icon", "mdi:silverware-fork-knife"))
        if "items" in fields:
            recipe["items"] = self._recipe_items(fields["items"])
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
        for item in self.items:
            if item.get("recipe_id") != recipe_id:
                keep.append(item)
                continue
            item["recipe_id"] = None
            twin = self._find_same(
                item["name"], item.get("note"), item.get("for_whom"), item["store_id"], None, item["id"]
            )
            if not item["checked"] and twin is None:
                keep.append(item)
        self.items = keep
        self._changed()

    @callback
    def apply_recipe(self, recipe_id: str, added_by: str | None = None) -> dict[str, Any]:
        """Alle Zutaten eines Rezepts auf die Liste setzen."""
        recipe = self.recipe_by_id(recipe_id)
        if recipe is None:
            raise ValueError("Dieses Rezept gibt es nicht (mehr).")
        if not recipe["items"]:
            raise ValueError("Das Rezept hat noch keine Zutaten.")
        added = 0
        already = 0
        for entry in recipe["items"]:
            hist = self.history_for(entry["name"]) or {}
            store_id = entry["store_id"] or hist.get("store_id")
            store_id = store_id if self.store_by_id(store_id) else None
            cat_id = entry["category_id"] or hist.get("category_id")
            same = self._find_same(
                entry["name"], entry["note"], entry["for_whom"], store_id, recipe_id
            )
            if same is not None and not same["checked"]:
                already += 1
            else:
                added += 1
            self.add_item(
                entry["name"],
                store_id=store_id,
                category_id=cat_id if self.category_by_id(cat_id) else None,
                quantity=entry["quantity"],
                note=entry["note"],
                for_whom=entry["for_whom"],
                added_by=added_by,
                recipe_id=recipe_id,
                notify=False,
            )
        self._changed()
        return {"added": added, "already": already}

    # ------------------------------------------------------ Geschäfte/Kategorien
    def _list(self, kind: str) -> list[dict[str, Any]]:
        if kind == "stores":
            return self.stores
        if kind == "categories":
            return self.categories
        if kind == "recipes":
            return self.recipes
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
            entry["icon"] = _icon(icon, "mdi:cart")
        else:
            entry["icon"] = _icon(icon, "mdi:tag-outline")
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
            entry["icon"] = _icon(fields["icon"], entry.get("icon") or "mdi:tag-outline")
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
