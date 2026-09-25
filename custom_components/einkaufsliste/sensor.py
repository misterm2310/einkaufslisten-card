"""Sensor: wie viele Artikel stehen noch auf der Liste?"""

from __future__ import annotations

from typing import Any

from homeassistant.components.sensor import SensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.device_registry import DeviceEntryType, DeviceInfo
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN, SIGNAL_UPDATED, VERSION
from .manager import EinkaufslisteManager


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    manager: EinkaufslisteManager = hass.data[DOMAIN]["manager"]
    async_add_entities([OffeneArtikelSensor(manager, entry)])


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
            "naechstes_aufraeumen": self._m.next_cleanup().isoformat(),
        }
