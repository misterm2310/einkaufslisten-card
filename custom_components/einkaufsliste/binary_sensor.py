"""Ja/Nein-Sensoren: steht überhaupt etwas auf der Liste? Und: hat das Geschäft gerade offen?"""

from __future__ import annotations

from datetime import timedelta
from typing import Any

from homeassistant.components.binary_sensor import BinarySensorDeviceClass, BinarySensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.event import async_track_time_interval
from homeassistant.util import dt as dt_util

from .const import DOMAIN, SIGNAL_UPDATED
from .manager import EinkaufslisteManager
from .opening import store_open
from .sensor import _device

WD_LONG = ("Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag")


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    manager: EinkaufslisteManager = hass.data[DOMAIN]["manager"]
    async_add_entities([EtwasZuKaufenSensor(manager, entry)])

    # 🕒 Ein „offen?“-Sensor pro Geschäft – neue Geschäfte bekommen ihn automatisch, gelöschte verschwinden
    known: dict[str, GeschaeftOffenSensor] = {}

    @callback
    def _sync_stores() -> None:
        ids = {s["id"] for s in manager.stores}
        new = [GeschaeftOffenSensor(manager, entry, sid) for sid in ids if sid not in known]
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


class EtwasZuKaufenSensor(BinarySensorEntity):
    """binary_sensor.einkaufsliste_etwas_zu_kaufen – an, sobald mindestens ein Artikel offen ist"""

    _attr_has_entity_name = True
    _attr_translation_key = "etwas_zu_kaufen"
    _attr_should_poll = False

    def __init__(self, manager: EinkaufslisteManager, entry: ConfigEntry) -> None:
        self._m = manager
        self._attr_unique_id = f"{entry.entry_id}_etwas_zu_kaufen"
        self._attr_device_info = _device(entry)

    async def async_added_to_hass(self) -> None:
        self.async_on_remove(async_dispatcher_connect(self.hass, SIGNAL_UPDATED, self._refresh))

    @callback
    def _refresh(self) -> None:
        self.async_write_ha_state()

    @property
    def is_on(self) -> bool:
        return any(not i["checked"] for i in self._m.items)

    @property
    def icon(self) -> str:
        return "mdi:cart-arrow-down" if self.is_on else "mdi:cart-check"

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        stores = {}
        for i in self._m.items:
            if not i["checked"]:
                st = self._m.store_by_id(i.get("store_id"))
                name = st["name"] if st else "Egal wo"
                stores[name] = stores.get(name, 0) + 1
        return {"anzahl": sum(stores.values()), "geschaefte": sorted(stores)}


def _when(info: dict[str, Any] | None) -> str | None:
    """„08:00“ (heute) oder „Montag 08:00“."""
    if not info or not info.get("next"):
        return None
    return info["next"] if info.get("today") else f"{WD_LONG[info.get('day', 0)]} {info['next']}"


class GeschaeftOffenSensor(BinarySensorEntity):
    """binary_sensor.einkaufsliste_aldi_offen – an, solange das Geschäft (oder eine seiner Filialen) offen hat"""

    _attr_has_entity_name = True
    _attr_should_poll = False
    _attr_device_class = BinarySensorDeviceClass.OPENING

    def __init__(self, manager: EinkaufslisteManager, entry: ConfigEntry, store_id: str) -> None:
        self._m = manager
        self.store_id = store_id
        self._attr_unique_id = f"{entry.entry_id}_offen_{store_id}"
        self._attr_device_info = _device(entry)

    async def async_added_to_hass(self) -> None:
        self.async_on_remove(async_dispatcher_connect(self.hass, SIGNAL_UPDATED, self._refresh))
        # ⏱️ jede Minute nachsehen – Öffnungszeiten ändern sich mit der Uhr, nicht mit der Liste
        self.async_on_remove(async_track_time_interval(self.hass, self._tick, timedelta(minutes=1)))

    @callback
    def _tick(self, _now: Any) -> None:
        self._refresh()

    @callback
    def _refresh(self) -> None:
        if self.hass is not None and self.entity_id:
            self.async_write_ha_state()

    @property
    def _store(self) -> dict[str, Any] | None:
        return self._m.store_by_id(self.store_id)

    def _calc(self) -> dict[str, Any]:
        return store_open(self._store or {}, dt_util.now())

    @property
    def available(self) -> bool:
        return self._store is not None

    @property
    def name(self) -> str:
        return f"{(self._store or {}).get('name') or 'Geschäft'} offen"

    @property
    def icon(self) -> str:
        return "mdi:store-clock" if self.is_on else "mdi:store-off-outline"

    @property
    def is_on(self) -> bool | None:
        return self._calc()["state"]  # None = keine Öffnungszeiten eingetragen

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        res = self._calc()
        if res["branches"] is None:
            info = res["info"] or {}
            return {"offen_bis": info.get("until"), "oeffnet": _when(info), "feiertag": info.get("holiday")}
        return {
            "feiertag": next((i.get("holiday") for _, i in res["branches"] if i and i.get("holiday")), None),
            "filialen": [
                {"name": b.get("name"), "offen": None if i is None else i["open"],
                 "offen_bis": (i or {}).get("until"), "oeffnet": _when(i)}
                for b, i in res["branches"]
            ],
        }
