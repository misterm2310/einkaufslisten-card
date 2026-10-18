"""Sensoren: wie viele Artikel stehen noch auf der Liste – insgesamt, pro Geschäft – und was kam zuletzt dazu?"""

from __future__ import annotations

import time

from datetime import timedelta
from typing import Any

from homeassistant.components.sensor import SensorDeviceClass, SensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.device_registry import DeviceEntryType, DeviceInfo
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.event import async_call_later, async_track_time_interval
from homeassistant.util import dt as dt_util

from .const import DOMAIN, SIGNAL_UPDATED, VERSION
from .manager import EinkaufslisteManager


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    manager: EinkaufslisteManager = hass.data[DOMAIN]["manager"]
    async_add_entities([OffeneArtikelSensor(manager, entry), ZuletztEingetragenSensor(manager, entry), ZuletztGekauftSensor(manager, entry), GesundheitSensor(manager, entry), KochtimerSensor(manager, entry)])

    # 🏪 Ein Sensor pro Geschäft – neue Geschäfte bekommen ihren Sensor automatisch, gelöschte verschwinden
    known: dict[str, GeschaeftSensor] = {}

    @callback
    def _sync_stores() -> None:
        ids = {s["id"] for s in manager.stores}
        new = [GeschaeftSensor(manager, entry, sid) for sid in ids if sid not in known]
        for ent in new:
            known[ent.store_id] = ent
        if new:
            async_add_entities(new)
        reg = er.async_get(hass)
        for sid in [sid for sid in known if sid not in ids]:
            ent = known.pop(sid)
            if ent.entity_id and reg.async_get(ent.entity_id):
                reg.async_remove(ent.entity_id)

    _sync_stores()
    entry.async_on_unload(async_dispatcher_connect(hass, SIGNAL_UPDATED, _sync_stores))


def _device(entry: ConfigEntry) -> DeviceInfo:
    return DeviceInfo(
        identifiers={(DOMAIN, entry.entry_id)},
        name="Einkaufsliste",
        manufacturer="Einkaufsliste",
        sw_version=VERSION,
        entry_type=DeviceEntryType.SERVICE,
    )


class _Base(SensorEntity):
    _attr_has_entity_name = True
    _attr_should_poll = False

    def __init__(self, manager: EinkaufslisteManager, entry: ConfigEntry) -> None:
        self._m = manager
        self._attr_device_info = _device(entry)

    async def async_added_to_hass(self) -> None:
        self.async_on_remove(async_dispatcher_connect(self.hass, SIGNAL_UPDATED, self._refresh))

    @callback
    def _refresh(self) -> None:
        if self.hass is not None and self.entity_id:
            self.async_write_ha_state()


class GeschaeftSensor(_Base):
    """sensor.einkaufsliste_aldi – offene Artikel bei diesem Geschäft"""

    _attr_native_unit_of_measurement = "Artikel"
    _unrecorded_attributes = frozenset({"artikel"})

    def __init__(self, manager: EinkaufslisteManager, entry: ConfigEntry, store_id: str) -> None:
        super().__init__(manager, entry)
        self.store_id = store_id
        self._attr_unique_id = f"{entry.entry_id}_geschaeft_{store_id}"

    @property
    def _store(self) -> dict[str, Any] | None:
        return self._m.store_by_id(self.store_id)

    @property
    def available(self) -> bool:
        return self._store is not None

    @property
    def name(self) -> str:
        return (self._store or {}).get("name") or "Geschäft"

    @property
    def icon(self) -> str:
        return (self._store or {}).get("icon") or "mdi:store"

    def _open(self) -> list[dict[str, Any]]:
        return [i for i in self._m.items if not i["checked"] and i.get("store_id") == self.store_id]

    @property
    def native_value(self) -> int:
        return len(self._open())

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        return {
            "geschaeft": self.name,
            "artikel": [
                (f"{i['quantity']} " if i.get("quantity") else "") + i["name"] + (f" · {i['note']}" if i.get("note") else "")
                for i in self._open()
            ],
            # 🏷️ Nur Artikel mit laufendem Angebot (Preis, ab/bis, Händler) – "artikel" oben bleibt unverändert
            "angebote": [
                {
                    "artikel": i["name"],
                    "preis": i["offer"].get("p"),
                    "ab": i["offer"].get("from"),
                    "bis": i["offer"].get("to"),
                    "haendler": i["offer"].get("r"),
                }
                for i in self._open()
                if (i.get("offer") or {}).get("p") is not None and not i["offer"].get("expired")
            ],
        }


class ZuletztEingetragenSensor(_Base):
    """sensor.einkaufsliste_zuletzt_eingetragen – was kam zuletzt auf die Liste, von wem, wann?"""

    _attr_translation_key = "zuletzt_eingetragen"
    _attr_icon = "mdi:cart-plus"

    def __init__(self, manager: EinkaufslisteManager, entry: ConfigEntry) -> None:
        super().__init__(manager, entry)
        self._attr_unique_id = f"{entry.entry_id}_zuletzt_eingetragen"

    def _last(self) -> dict[str, Any] | None:
        for e in reversed(self._m.log):
            if e.get("a") in ("add", "readd") and e.get("n"):
                return e
        items = [i for i in self._m.items if i.get("added_at")]
        if not items:
            return None
        i = max(items, key=lambda x: x["added_at"])
        return {"n": i["name"], "s": i.get("store_id"), "w": i.get("added_by"), "t": i["added_at"], "a": "add", "v": None}

    @property
    def native_value(self) -> str | None:
        last = self._last()
        return last["n"] if last else None

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        last = self._last()
        if not last:
            return {}
        store = self._m.store_by_id(last.get("s"))
        item = next((i for i in self._m.items if i["name"] == last["n"] and i.get("store_id") == last.get("s")), None)
        return {
            "von": last.get("w"),
            "wann": last.get("t"),
            "geschaeft": store["name"] if store else None,
            "menge": (item or {}).get("quantity"),
            "notiz": (item or {}).get("note"),
            "fuer": (item or {}).get("for_whom"),
            "wieder_drauf": last.get("a") == "readd",
            "wie": last.get("v"),
        }


class ZuletztGekauftSensor(_Base):
    """sensor.einkaufsliste_zuletzt_gekauft – was wurde zuletzt abgehakt, von wem, wann?"""

    _attr_translation_key = "zuletzt_gekauft"
    _attr_icon = "mdi:cart-check"

    def __init__(self, manager: EinkaufslisteManager, entry: ConfigEntry) -> None:
        super().__init__(manager, entry)
        self._attr_unique_id = f"{entry.entry_id}_zuletzt_gekauft"

    def _last(self) -> dict[str, Any] | None:
        # Aufräum-Abhaken („cleanup“) ist kein Einkauf
        for e in reversed(self._m.log):
            if e.get("a") == "check" and e.get("n") and e.get("v") != "cleanup":
                return e
        items = [i for i in self._m.items if i.get("checked") and i.get("checked_at")]
        if not items:
            return None
        i = max(items, key=lambda x: x["checked_at"])
        return {"n": i["name"], "s": i.get("store_id"), "w": i.get("checked_by"), "t": i["checked_at"], "a": "check", "v": None}

    @property
    def native_value(self) -> str | None:
        last = self._last()
        return last["n"] if last else None

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        last = self._last()
        if not last:
            return {}
        store = self._m.store_by_id(last.get("s"))
        item = next((i for i in self._m.items if i["name"] == last["n"] and i.get("store_id") == last.get("s")), None)
        return {
            "von": last.get("w"),
            "wann": last.get("t"),
            "geschaeft": store["name"] if store else None,
            "menge": (item or {}).get("quantity"),
            "notiz": (item or {}).get("note"),
            "fuer": (item or {}).get("for_whom"),
            "wie": last.get("v"),
        }


class OffeneArtikelSensor(SensorEntity):
    """sensor.einkaufsliste_offene_artikel"""

    _attr_has_entity_name = True
    _attr_name = "Offene Artikel"
    _attr_icon = "mdi:cart"
    _attr_native_unit_of_measurement = "Artikel"
    _attr_should_poll = False
    _unrecorded_attributes = frozenset({"artikel", "pro_geschaeft"})

    def __init__(self, manager: EinkaufslisteManager, entry: ConfigEntry) -> None:
        self._m = manager
        self._attr_unique_id = f"{entry.entry_id}_offene_artikel"
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, entry.entry_id)},
            name="Einkaufsliste",
            manufacturer="Einkaufsliste",
            sw_version=VERSION,
            entry_type=DeviceEntryType.SERVICE,
        )

    async def async_added_to_hass(self) -> None:
        self.async_on_remove(
            async_dispatcher_connect(self.hass, SIGNAL_UPDATED, self._refresh)
        )

    @callback
    def _refresh(self) -> None:
        self.async_write_ha_state()

    @property
    def native_value(self) -> int:
        return sum(1 for i in self._m.items if not i["checked"])

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        per_store: dict[str, int] = {s["name"]: 0 for s in self._m.stores}
        artikel = []
        for item in self._m.items:
            if item["checked"]:
                continue
            store = self._m.store_by_id(item["store_id"])
            cat = self._m.category_by_id(item["category_id"])
            store_name = store["name"] if store else "Ohne Geschäft"
            per_store[store_name] = per_store.get(store_name, 0) + 1
            artikel.append(
                {
                    "name": item["name"],
                    "menge": item.get("quantity"),
                    "notiz": item.get("note"),
                    "fuer": item.get("for_whom"),
                    "geschaeft": store_name,
                    "kategorie": cat["name"] if cat else None,
                    "von": item.get("added_by"),
                }
            )
        return {
            "pro_geschaeft": per_store,
            "abgehakt": sum(1 for i in self._m.items if i["checked"]),
            "artikel": artikel,
            "naechstes_aufraeumen": self._m.next_cleanup().isoformat() if self._m.cleanup_on else None,
        }


class KochtimerSensor(_Base):
    """sensor.einkaufsliste_kochtimer – wann klingelt der nächste Kochtimer? (Zeitpunkt; ohne laufenden Timer: wann der letzte abgelaufene
    klingelte, solange er noch auf „fertig“ steht; leer = kein Timer da. Wie viele wirklich laufen, steht in „laufend“)"""

    _attr_translation_key = "kochtimer"
    _attr_device_class = SensorDeviceClass.TIMESTAMP
    _attr_icon = "mdi:timer-outline"
    _unrecorded_attributes = frozenset({"timer"})

    def __init__(self, manager: EinkaufslisteManager, entry: ConfigEntry) -> None:
        super().__init__(manager, entry)
        self._attr_unique_id = f"{entry.entry_id}_kochtimer"

    def _running(self) -> list[dict[str, Any]]:
        return sorted((t for t in self._m.timers if not t.get("done")), key=lambda t: t["end"])

    @property
    def native_value(self):
        running = self._running()
        if running:
            return dt_util.parse_datetime(running[0]["end"])
        done = sorted((t for t in self._m.timers if t.get("done")), key=lambda t: t["end"])
        return dt_util.parse_datetime(done[-1]["end"]) if done else None  # 🔔 fertig, aber noch nicht weggedrückt: Anzeige bleibt

    def _name(self, t: dict[str, Any]) -> str:
        """„Lasagne – Schritt 2“ – damit man bei mehreren Rezepten weiß, welcher Timer es ist."""
        recipe = self._m.recipe_by_id(t.get("recipe_id"))
        return f"{recipe['name']} – {t['label']}" if recipe else t["label"]

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        running = self._running()
        return {
            "laufend": len(running),
            "fertig": sum(1 for t in self._m.timers if t.get("done")),
            "naechster": self._name(running[0]) if running else None,  # z. B. für eine Ansage
            "timer": [
                {
                    "name": self._name(t),
                    "rezept": (self._m.recipe_by_id(t.get("recipe_id")) or {}).get("name"),
                    "label": t["label"],
                    "schritt": t.get("step"),
                    "ende": t["end"],
                    "fertig": bool(t.get("done")),
                }
                for t in self._m.timers
            ],
        }


class GesundheitSensor(_Base):
    """sensor.einkaufsliste_gesundheit – die Ampel aus ⚙️: ok / hinweis / problem (zum Beispiel für eine Benachrichtigung)"""

    _attr_translation_key = "gesundheit"
    _attr_device_class = SensorDeviceClass.ENUM
    _attr_options = ["ok", "hinweis", "problem", "unbekannt"]

    def __init__(self, manager: EinkaufslisteManager, entry: ConfigEntry) -> None:
        super().__init__(manager, entry)
        self._attr_unique_id = f"{entry.entry_id}_gesundheit"

    async def async_added_to_hass(self) -> None:
        await super().async_added_to_hass()

        async def _check(_now=None) -> None:
            await self._m.async_health()
            self.async_write_ha_state()

        # kurz nach dem Start und danach alle 30 Minuten (die Prüfung ist leicht, kostet aber etwas)
        self.async_on_remove(async_call_later(self.hass, 30, _check))
        self.async_on_remove(async_track_time_interval(self.hass, _check, timedelta(minutes=30)))

    @property
    def native_value(self) -> str:
        return self._m.health_cache.get("level") or "unbekannt"

    @property
    def icon(self) -> str:
        return {"ok": "mdi:heart-pulse", "hinweis": "mdi:alert-circle-outline", "problem": "mdi:alert-octagon"}.get(
            self.native_value, "mdi:help-circle-outline"
        )

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        c = self._m.health_cache
        mins = max((time.monotonic() - self._m.stat_start) / 60, 1 / 60)
        return {
            "probleme": c.get("probleme"), "fehler_24h": c.get("fehler_24h"), "geprueft": c.get("geprueft"),
            # 📊 Diagnose bei hoher Last: wie oft hat sich etwas geändert, wie viele Pakete gingen an Karten/Apps?
            "aenderungen_gesamt": self._m.stat_changes,
            "aenderungen_pro_minute": round(self._m.stat_changes / mins, 2),
            "pakete_an_karten_gesamt": self._m.stat_pushes,
            "laufzeit_minuten": round(mins),
        }
