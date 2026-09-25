"""Websocket-Befehle: darüber redet die Karte live mit Home Assistant."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.dispatcher import async_dispatcher_connect

from .const import DOMAIN, SIGNAL_UPDATED
from .manager import EinkaufslisteManager, person_name_for_user

OPT_STR = vol.Any(None, str)


@callback
def async_register(hass: HomeAssistant) -> None:
    for handler in (
        ws_get,
        ws_subscribe,
        ws_item_add,
        ws_item_update,
        ws_item_toggle,
        ws_item_remove,
        ws_cleanup,
        ws_recipe_add,
        ws_recipe_update,
        ws_recipe_remove,
        ws_recipe_apply,
        ws_group_add,
        ws_group_update,
        ws_group_remove,
        ws_reorder,
    ):
        websocket_api.async_register_command(hass, handler)


def _manager(hass: HomeAssistant) -> EinkaufslisteManager | None:
    return hass.data.get(DOMAIN, {}).get("manager")


def _user_name(hass: HomeAssistant, connection: websocket_api.ActiveConnection) -> str | None:
    user = connection.user
    if user is None:
        return None
    return person_name_for_user(hass, user.id) or user.name


def _run(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
    func: Callable[[EinkaufslisteManager], Any],
) -> None:
    manager = _manager(hass)
    if manager is None:
        connection.send_error(
            msg["id"], "not_loaded", "Die Integration „Einkaufsliste“ ist nicht eingerichtet."
        )
        return
    try:
        result = func(manager)
    except ValueError as err:
        connection.send_error(msg["id"], "invalid", str(err))
        return
    connection.send_result(msg["id"], result)


def _pick(msg: dict[str, Any], *keys: str) -> dict[str, Any]:
    return {k: msg[k] for k in keys if k in msg}


@websocket_api.websocket_command({vol.Required("type"): "einkaufsliste/get"})
@callback
def ws_get(hass, connection, msg):
    _run(hass, connection, msg, lambda m: m.as_dict())


@websocket_api.websocket_command({vol.Required("type"): "einkaufsliste/subscribe"})
@callback
def ws_subscribe(hass, connection, msg):
    manager = _manager(hass)
    if manager is None:
        connection.send_error(
            msg["id"], "not_loaded", "Die Integration „Einkaufsliste“ ist nicht eingerichtet."
        )
        return

    @callback
    def forward() -> None:
        current = _manager(hass)
        if current is not None:
            connection.send_message(websocket_api.event_message(msg["id"], current.as_dict()))

    connection.subscriptions[msg["id"]] = async_dispatcher_connect(hass, SIGNAL_UPDATED, forward)
    connection.send_result(msg["id"])
    forward()


@websocket_api.websocket_command(
    {
        vol.Required("type"): "einkaufsliste/item/add",
        vol.Required("name"): str,
        vol.Optional("store_id"): OPT_STR,
        vol.Optional("category_id"): OPT_STR,
        vol.Optional("quantity"): OPT_STR,
        vol.Optional("note"): OPT_STR,
        vol.Optional("for_whom"): OPT_STR,
    }
)
@callback
def ws_item_add(hass, connection, msg):
    who = _user_name(hass, connection)
    _run(
        hass,
        connection,
        msg,
        lambda m: m.add_item(
            msg["name"],
            store_id=msg.get("store_id"),
            category_id=msg.get("category_id"),
            quantity=msg.get("quantity"),
            note=msg.get("note"),
            for_whom=msg.get("for_whom"),
            added_by=who,
        ),
    )


@websocket_api.websocket_command(
    {
        vol.Required("type"): "einkaufsliste/item/update",
        vol.Required("item_id"): str,
        vol.Optional("name"): str,
        vol.Optional("store_id"): OPT_STR,
        vol.Optional("category_id"): OPT_STR,
        vol.Optional("quantity"): OPT_STR,
        vol.Optional("note"): OPT_STR,
        vol.Optional("for_whom"): OPT_STR,
    }
)
@callback
def ws_item_update(hass, connection, msg):
    fields = _pick(msg, "name", "store_id", "category_id", "quantity", "note", "for_whom")
    _run(hass, connection, msg, lambda m: m.update_item(msg["item_id"], **fields))


@websocket_api.websocket_command(
    {
        vol.Required("type"): "einkaufsliste/item/toggle",
        vol.Required("item_id"): str,
        vol.Optional("checked"): bool,
    }
)
@callback
def ws_item_toggle(hass, connection, msg):
    who = _user_name(hass, connection)
    _run(
        hass,
        connection,
        msg,
        lambda m: m.set_checked(msg["item_id"], msg.get("checked"), who),
    )


@websocket_api.websocket_command(
    {vol.Required("type"): "einkaufsliste/item/remove", vol.Required("item_id"): str}
)
@callback
def ws_item_remove(hass, connection, msg):
    _run(hass, connection, msg, lambda m: m.remove_item(msg["item_id"]))


@websocket_api.websocket_command(
    {vol.Required("type"): "einkaufsliste/cleanup", vol.Optional("force", default=False): bool}
)
@callback
def ws_cleanup(hass, connection, msg):
    _run(
        hass,
        connection,
        msg,
        lambda m: {"checked": len(m.cleanup(force=msg["force"]))},
    )


KIND = vol.In(["stores", "categories"])


@websocket_api.websocket_command(
    {
        vol.Required("type"): "einkaufsliste/group/add",
        vol.Required("kind"): KIND,
        vol.Required("name"): str,
        vol.Optional("color"): OPT_STR,
        vol.Optional("icon"): OPT_STR,
    }
)
@callback
def ws_group_add(hass, connection, msg):
    _run(
        hass,
        connection,
        msg,
        lambda m: m.add_group(msg["kind"], msg["name"], msg.get("color"), msg.get("icon")),
    )


@websocket_api.websocket_command(
    {
        vol.Required("type"): "einkaufsliste/group/update",
        vol.Required("kind"): KIND,
        vol.Required("group_id"): str,
        vol.Optional("name"): str,
        vol.Optional("color"): OPT_STR,
        vol.Optional("icon"): OPT_STR,
    }
)
@callback
def ws_group_update(hass, connection, msg):
    fields = _pick(msg, "name", "color", "icon")
    _run(
        hass, connection, msg, lambda m: m.update_group(msg["kind"], msg["group_id"], **fields)
    )


@websocket_api.websocket_command(
    {
        vol.Required("type"): "einkaufsliste/group/remove",
        vol.Required("kind"): KIND,
        vol.Required("group_id"): str,
    }
)
@callback
def ws_group_remove(hass, connection, msg):
    _run(hass, connection, msg, lambda m: m.remove_group(msg["kind"], msg["group_id"]))


@websocket_api.websocket_command(
    {
        vol.Required("type"): "einkaufsliste/group/reorder",
        vol.Required("kind"): vol.In(["stores", "categories", "recipes"]),
        vol.Required("ids"): [str],
    }
)
@callback
def ws_reorder(hass, connection, msg):
    _run(hass, connection, msg, lambda m: m.reorder(msg["kind"], msg["ids"]))


RECIPE_ITEM = vol.Schema(
    {
        vol.Required("name"): str,
        vol.Optional("quantity"): OPT_STR,
        vol.Optional("note"): OPT_STR,
        vol.Optional("for_whom"): OPT_STR,
        vol.Optional("store_id"): OPT_STR,
        vol.Optional("category_id"): OPT_STR,
    }
)


@websocket_api.websocket_command(
    {
        vol.Required("type"): "einkaufsliste/recipe/add",
        vol.Required("name"): str,
        vol.Optional("icon"): OPT_STR,
        vol.Optional("items", default=[]): [RECIPE_ITEM],
    }
)
@callback
def ws_recipe_add(hass, connection, msg):
    _run(hass, connection, msg, lambda m: m.add_recipe(msg["name"], msg["items"], msg.get("icon")))


@websocket_api.websocket_command(
    {
        vol.Required("type"): "einkaufsliste/recipe/update",
        vol.Required("recipe_id"): str,
        vol.Optional("name"): str,
        vol.Optional("icon"): OPT_STR,
        vol.Optional("items"): [RECIPE_ITEM],
    }
)
@callback
def ws_recipe_update(hass, connection, msg):
    fields = _pick(msg, "name", "icon", "items")
    _run(hass, connection, msg, lambda m: m.update_recipe(msg["recipe_id"], **fields))


@websocket_api.websocket_command(
    {vol.Required("type"): "einkaufsliste/recipe/remove", vol.Required("recipe_id"): str}
)
@callback
def ws_recipe_remove(hass, connection, msg):
    _run(hass, connection, msg, lambda m: m.remove_recipe(msg["recipe_id"]))


@websocket_api.websocket_command(
    {vol.Required("type"): "einkaufsliste/recipe/apply", vol.Required("recipe_id"): str}
)
@callback
def ws_recipe_apply(hass, connection, msg):
    who = _user_name(hass, connection)
    _run(hass, connection, msg, lambda m: m.apply_recipe(msg["recipe_id"], who))
