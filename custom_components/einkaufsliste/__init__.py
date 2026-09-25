"""Einkaufsliste – die Familien-Einkaufsliste für Home Assistant."""

from __future__ import annotations

import logging
import voluptuous as vol

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import (
    HomeAssistant,
    ServiceCall,
    ServiceResponse,
    SupportsResponse,
)
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.typing import ConfigType

from . import websocket as ws
from .const import DOMAIN
from .frontend import async_setup_frontend
from .manager import EinkaufslisteManager, person_name_for_user

_LOGGER = logging.getLogger(__name__)

CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)
PLATFORMS = [Platform.SENSOR]

SCHEMA_ADD = vol.Schema(
    {
        vol.Required("name"): cv.string,
        vol.Optional("store"): cv.string,
        vol.Optional("category"): cv.string,
        vol.Optional("quantity"): cv.string,
        vol.Optional("note"): cv.string,
        vol.Optional("for_whom"): cv.string,
        vol.Optional("added_by"): cv.string,
    }
)
SCHEMA_BY_NAME = vol.Schema(
    {vol.Required("name"): cv.string, vol.Optional("store"): cv.string}
)
SCHEMA_RECIPE = vol.Schema(
    {vol.Required("name"): cv.string, vol.Optional("added_by"): cv.string}
)
SCHEMA_CLEANUP = vol.Schema(
    {
        vol.Optional("force", default=False): cv.boolean,
        vol.Optional("min_age_days"): vol.All(vol.Coerce(int), vol.Range(min=0, max=365)),
    }
)


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """Einmalig: Karte bereitstellen, Websocket + Aktionen anmelden."""
    hass.data.setdefault(DOMAIN, {})

    # Die Dashboard-Karte wird direkt von der Integration ausgeliefert und
    # automatisch als Ressource eingetragen – nichts von Hand nötig.
    await async_setup_frontend(hass)

    ws.async_register(hass)
    _register_services(hass)
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    manager = EinkaufslisteManager(hass, entry)
    await manager.async_load()
    hass.data[DOMAIN]["manager"] = manager
    manager.async_start_scheduler()
    entry.async_on_unload(manager.async_stop)
    entry.async_on_unload(entry.add_update_listener(_async_update_listener))
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    unloaded = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unloaded:
        manager: EinkaufslisteManager | None = hass.data[DOMAIN].pop("manager", None)
        if manager is not None:
            await manager.async_save_now()
    return unloaded


async def _async_update_listener(hass: HomeAssistant, entry: ConfigEntry) -> None:
    await hass.config_entries.async_reload(entry.entry_id)


def _get_manager(hass: HomeAssistant) -> EinkaufslisteManager:
    manager = hass.data.get(DOMAIN, {}).get("manager")
    if manager is None:
        raise HomeAssistantError("Die Einkaufsliste ist noch nicht eingerichtet.")
    return manager


async def _caller_name(hass: HomeAssistant, call: ServiceCall) -> str | None:
    user_id = call.context.user_id
    if not user_id:
        return None
    name = person_name_for_user(hass, user_id)
    if name:
        return name
    user = await hass.auth.async_get_user(user_id)
    return user.name if user else None


def _register_services(hass: HomeAssistant) -> None:
    async def add_item(call: ServiceCall) -> ServiceResponse:
        m = _get_manager(hass)
        try:
            name = call.data["name"]
            hist = m.history_for(name) or {}
            store_id = (
                m.find_store(call.data["store"]) if "store" in call.data else hist.get("store_id")
            )
            cat_id = (
                m.find_category(call.data["category"])
                if "category" in call.data
                else hist.get("category_id")
            )
            if m.store_by_id(store_id) is None:
                store_id = None
            if m.category_by_id(cat_id) is None:
                cat_id = m.guess_category(name) if "category" not in call.data else None
            who = call.data.get("added_by") or await _caller_name(hass, call)
            item = m.add_item(
                name,
                store_id=store_id,
                category_id=cat_id,
                quantity=call.data.get("quantity"),
                note=call.data.get("note"),
                for_whom=call.data.get("for_whom"),
                added_by=who,
            )
        except ValueError as err:
            raise HomeAssistantError(str(err)) from err
        return {"item": item}

    async def check_item(call: ServiceCall) -> None:
        m = _get_manager(hass)
        try:
            store_id = m.find_store(call.data.get("store"))
            item = m.find_item(call.data["name"], store_id)
            m.set_checked(item["id"], True, await _caller_name(hass, call))
        except ValueError as err:
            raise HomeAssistantError(str(err)) from err

    async def remove_item(call: ServiceCall) -> None:
        m = _get_manager(hass)
        try:
            store_id = m.find_store(call.data.get("store"))
            item = m.find_item(call.data["name"], store_id)
            m.remove_item(item["id"])
        except ValueError as err:
            raise HomeAssistantError(str(err)) from err

    async def add_recipe(call: ServiceCall) -> ServiceResponse:
        m = _get_manager(hass)
        try:
            recipe = m.find_recipe(call.data["name"])
            who = call.data.get("added_by") or await _caller_name(hass, call)
            return m.apply_recipe(recipe["id"], who)
        except ValueError as err:
            raise HomeAssistantError(str(err)) from err

    async def cleanup(call: ServiceCall) -> ServiceResponse:
        removed = _get_manager(hass).cleanup(
            force=call.data["force"], min_age_days=call.data.get("min_age_days")
        )
        return {"checked": len(removed), "names": [i["name"] for i in removed]}

    hass.services.async_register(
        DOMAIN, "add_item", add_item, SCHEMA_ADD, supports_response=SupportsResponse.OPTIONAL
    )
    hass.services.async_register(DOMAIN, "check_item", check_item, SCHEMA_BY_NAME)
    hass.services.async_register(DOMAIN, "remove_item", remove_item, SCHEMA_BY_NAME)
    hass.services.async_register(
        DOMAIN,
        "add_recipe",
        add_recipe,
        SCHEMA_RECIPE,
        supports_response=SupportsResponse.OPTIONAL,
    )
    hass.services.async_register(
        DOMAIN, "cleanup", cleanup, SCHEMA_CLEANUP, supports_response=SupportsResponse.OPTIONAL
    )
