"""Websocket-Befehle: darüber redet die Karte live mit Home Assistant."""

from __future__ import annotations

from collections.abc import Callable
import logging
from typing import Any

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.dispatcher import async_dispatcher_connect

from .barcode import async_auto_photo, async_lookup, async_product_info, async_refresh_photo
from .ai_cook import async_cook
from .grocy_import import async_fetch, clean_base, import_rows, parse_catalog_text
from .recipe_import import async_import
from .const import DOMAIN, SIGNAL_UPDATED
from .mail_import import mail_sources
from .transfer import async_todo_text, import_recipe_file, import_text, import_text_by_store, todo_lists
from .manager import AUTO_CATEGORY, EinkaufslisteManager, person_name_for_user, product_key

OPT_STR = vol.Any(None, str)
_LOGGER = logging.getLogger(__name__)


@callback
def async_register(hass: HomeAssistant) -> None:
    for handler in (
        ws_get,
        ws_subscribe,
        ws_item_add,
        ws_item_update,
        ws_item_toggle,
        ws_item_remove,
        ws_item_move,
        ws_cleanup,
        ws_recipe_add,
        ws_recipe_update,
        ws_recipe_remove,
        ws_recipe_apply,
        ws_recipe_unapply,
        ws_recipe_import,
        ws_photo_set,
        ws_photo_get,
        ws_photo_remove,
        ws_photo_move,
        ws_check,
        ws_barcode_lookup,
        ws_barcode_assign,
        ws_product_barcode,
        ws_barcode_info,
        ws_products,
        ws_product_update,
        ws_product_remove,
        ws_barcode_remove,
        ws_typo_learn,
        ws_product_confirm,
        ws_typo_forget,
        ws_pin_set,
        ws_pin_check,
        ws_item_out,
        ws_recipe_import_file,
        ws_import_text,
        ws_import_todo_lists,
        ws_import_todo,
        ws_todo_sync,
        ws_todo_sync_remove,
        ws_mail_sources,
        ws_mail_import,
        ws_mascot,
        ws_labels,
        ws_cards_enable,
        ws_grocy_preview,
        ws_grocy_import,
        ws_catalog_csv,
        ws_note_templates,
        ws_ai_agent,
        ws_ai_prefs,
        ws_ai_cook,
        ws_grocy_set,
        ws_grocy_clear,
        ws_grocy_run,
        ws_cards_list,
        ws_card_add,
        ws_card_update,
        ws_card_remove,
        ws_card_photo,
        ws_favorite_set,
        ws_favorites_add,
        ws_privacy_set,
        ws_spend_set,
        ws_auto_shop_set,
        ws_spend_auto_set,
        ws_purchases_get,
        ws_purchases_add,
        ws_purchases_remove,
        ws_seen,
        ws_group_add,
        ws_group_update,
        ws_group_remove,
        ws_reorder,
        ws_log_get,
        ws_log_settings,
        ws_log_clear,
        ws_missed_hide,
        ws_offers_set,
        ws_offers_refresh,
        ws_offers_search,
        ws_offers_take,
        ws_product_add,
        ws_product_refresh,
        ws_photos_refresh_plan,
        ws_stats,
        ws_errors_get,
        ws_errors_clear,
        ws_errors_report,
        ws_product_merge,
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
        with manager.acting(
            _user_name(hass, connection),
            connection.user.id if connection.user else None,
            msg.get("via") or "card",
        ):
            result = func(manager)
    except ValueError as err:
        connection.send_error(msg["id"], "invalid", str(err))
        return
    except Exception as err:  # noqa: BLE001 – etwas ging technisch schief: ins Fehler-Protokoll, die Karte bekommt eine Meldung
        _LOGGER.error("Befehl %s ging schief", msg.get("type"), exc_info=True)
        connection.send_error(msg["id"], "error", f"Das ging schief ({type(err).__name__}) – Details stehen im Fehler-Protokoll.")
        return
    connection.send_result(msg["id"], result)


VIA = ("card", "scan", "merge", "recipe")


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
        vol.Optional("via"): vol.In(VIA),
        vol.Required("name"): str,
        vol.Optional("store_id"): OPT_STR,
        vol.Optional("category_id"): OPT_STR,
        vol.Optional("quantity"): OPT_STR,
        vol.Optional("note"): OPT_STR,
        vol.Optional("own_note"): OPT_STR,  # ✏️ Eigene Notiz
        vol.Optional("for_whom"): OPT_STR,
        vol.Optional("barcode"): OPT_STR,
    }
)
@callback
def ws_item_add(hass, connection, msg):
    who = _user_name(hass, connection)

    def _add(m):
        item = m.add_item(
            msg["name"],
            store_id=msg.get("store_id"),
            category_id=msg["category_id"] if "category_id" in msg else AUTO_CATEGORY,
            quantity=msg.get("quantity"),
            note=msg.get("note"),
            own_note=msg.get("own_note"),
            for_whom=msg.get("for_whom"),
            added_by=who,
            barcode=msg.get("barcode"),
            added_by_id=connection.user.id if connection.user else None,
        )
        _auto_photo(hass, m, msg.get("barcode"), product_key(item["name"], item.get("note")))
        return item

    _run(hass, connection, msg, _add)


def _auto_photo(hass, manager, code, name) -> None:
    """Gescannt und noch kein Foto? Dann im Hintergrund das Produktfoto holen."""
    if code and name and not manager.photos.get(name.strip().lower()):
        hass.async_create_background_task(
            async_auto_photo(hass, manager, code, name), "einkaufsliste_auto_photo"
        )


@websocket_api.websocket_command(
    {
        vol.Required("type"): "einkaufsliste/item/update",
        vol.Optional("via"): vol.In(VIA),
        vol.Required("item_id"): str,
        vol.Optional("name"): str,
        vol.Optional("store_id"): OPT_STR,
        vol.Optional("category_id"): OPT_STR,
        vol.Optional("quantity"): OPT_STR,
        vol.Optional("note"): OPT_STR,
        vol.Optional("own_note"): OPT_STR,  # ✏️ Eigene Notiz
        vol.Optional("for_whom"): OPT_STR,
        vol.Optional("aliases"): [str],  # 🏷️ Spitznamen des Produkts
    }
)
@callback
def ws_item_update(hass, connection, msg):
    fields = _pick(msg, "name", "store_id", "category_id", "quantity", "note", "own_note", "for_whom", "aliases")
    _run(hass, connection, msg, lambda m: m.update_item(msg["item_id"], **fields))


@websocket_api.websocket_command(
    {
        vol.Required("type"): "einkaufsliste/item/toggle",
        vol.Optional("via"): vol.In(VIA),
        vol.Required("item_id"): str,
        vol.Optional("checked"): bool,
        vol.Optional("store_id"): OPT_STR,  # 🤷 „Egal wo“ in diesem Geschäft abgehakt
        vol.Optional("undo"): bool,  # ↩️ Rückgängig: altes Datum behalten
    }
)
@callback
def ws_item_toggle(hass, connection, msg):
    who = _user_name(hass, connection)
    _run(
        hass,
        connection,
        msg,
        lambda m: m.set_checked(
            msg["item_id"], msg.get("checked"), who, connection.user.id if connection.user else None,
            msg.get("store_id") or None, bool(msg.get("undo")),
        ),
    )


@websocket_api.websocket_command(
    {
        vol.Required("type"): "einkaufsliste/item/move",
        vol.Optional("via"): vol.In(VIA),
        vol.Required("item_id"): str,
        vol.Required("store_id"): OPT_STR,  # None = 🤷 „Egal wo“
    }
)
@callback
def ws_item_move(hass, connection, msg):
    who = _user_name(hass, connection)
    uid = connection.user.id if connection.user else None
    _run(hass, connection, msg, lambda m: m.move_item(msg["item_id"], msg["store_id"] or None, who, uid))


@websocket_api.websocket_command(
    {
        vol.Required("type"): "einkaufsliste/item/remove",
        vol.Optional("via"): vol.In(VIA),
        vol.Required("item_id"): str,
    }
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


KIND = vol.In(["stores", "categories", "persons", "recipe_groups"])


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
        vol.Optional("zone"): OPT_STR,
        vol.Optional("zones"): [str],
        vol.Optional("brands"): OPT_STR,
        vol.Optional("cat_order"): vol.Any(None, [str]),
    }
)
@callback
def ws_group_update(hass, connection, msg):
    fields = _pick(msg, "name", "color", "icon", "zone", "zones", "brands", "cat_order")
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
        vol.Required("kind"): vol.In(["stores", "categories", "persons", "recipes", "recipe_groups"]),
        vol.Required("ids"): [str],
    }
)
@callback
def ws_reorder(hass, connection, msg):
    _run(hass, connection, msg, lambda m: m.reorder(msg["kind"], msg["ids"]))


HEAT_ROW = vol.Schema(
    {
        vol.Optional("device"): OPT_STR,
        vol.Optional("mode"): OPT_STR,
        vol.Optional("temp"): vol.Any(None, vol.Coerce(float)),
        vol.Optional("minutes"): vol.Any(None, vol.Coerce(float)),
        vol.Optional("minutes_to"): vol.Any(None, vol.Coerce(float)),
        vol.Optional("preheat"): bool,
        vol.Optional("note"): OPT_STR,
    }
)

RECIPE_ITEM = vol.Schema(
    {
        vol.Required("name"): str,
        vol.Optional("quantity"): OPT_STR,
        vol.Optional("note"): OPT_STR,
        vol.Optional("for_whom"): OPT_STR,
        vol.Optional("store_id"): OPT_STR,
        vol.Optional("category_id"): OPT_STR,
        vol.Optional("barcode"): OPT_STR,
        vol.Optional("basic"): bool,
    }
)


@websocket_api.websocket_command(
    {
        vol.Required("type"): "einkaufsliste/recipe/add",
        vol.Required("name"): str,
        vol.Optional("icon"): OPT_STR,
        vol.Optional("items", default=[]): [RECIPE_ITEM],
        vol.Optional("steps"): OPT_STR,
        vol.Optional("heat"): [HEAT_ROW],
        vol.Optional("servings"): vol.Any(None, vol.All(vol.Coerce(int), vol.Range(min=1, max=99))),
        vol.Optional("servings_unit"): vol.In(["persons", "trays"]),
        vol.Optional("group"): vol.Any(None, str),
        vol.Optional("ai"): bool,
    }
)
@callback
def ws_recipe_add(hass, connection, msg):
    _run(hass, connection, msg, lambda m: m.add_recipe(msg["name"], msg["items"], msg.get("icon"), msg.get("steps"), msg.get("heat"), msg.get("servings"), msg.get("servings_unit"), msg.get("group"), bool(msg.get("ai"))))


@websocket_api.websocket_command(
    {
        vol.Required("type"): "einkaufsliste/recipe/update",
        vol.Required("recipe_id"): str,
        vol.Optional("name"): str,
        vol.Optional("icon"): OPT_STR,
        vol.Optional("items"): [RECIPE_ITEM],
        vol.Optional("steps"): OPT_STR,
        vol.Optional("heat"): [HEAT_ROW],
        vol.Optional("servings"): vol.Any(None, vol.All(vol.Coerce(int), vol.Range(min=1, max=99))),
        vol.Optional("servings_unit"): vol.In(["persons", "trays"]),
        vol.Optional("group"): vol.Any(None, str),
        vol.Optional("step_map"): [vol.Any(None, vol.All(vol.Coerce(int), vol.Range(min=0, max=999)))],
    }
)
@callback
def ws_recipe_update(hass, connection, msg):
    fields = _pick(msg, "name", "icon", "items", "steps", "heat", "servings", "servings_unit", "group", "step_map")
    _run(hass, connection, msg, lambda m: m.update_recipe(msg["recipe_id"], **fields))


@websocket_api.websocket_command(
    {vol.Required("type"): "einkaufsliste/recipe/remove", vol.Required("recipe_id"): str}
)
@callback
def ws_recipe_remove(hass, connection, msg):
    _run(hass, connection, msg, lambda m: m.remove_recipe(msg["recipe_id"]))


@websocket_api.websocket_command(
    {
        vol.Required("type"): "einkaufsliste/recipe/apply",
        vol.Required("recipe_id"): str,
        vol.Optional("items"): [vol.Coerce(int)],
        # pro Zutat-Nummer: angepasste Menge (👥 Personen) und/oder gewähltes Geschäft ("" = Egal wo)
        vol.Optional("overrides"): {
            vol.Coerce(str): {
                vol.Optional("quantity"): vol.Any(None, str),
                vol.Optional("store_id"): vol.Any(None, str),
            }
        },
    }
)
@callback
def ws_recipe_apply(hass, connection, msg):
    who = _user_name(hass, connection)
    _run(hass, connection, msg, lambda m: m.apply_recipe(msg["recipe_id"], who, msg.get("items"), msg.get("overrides")))


@websocket_api.websocket_command(
    {vol.Required("type"): "einkaufsliste/recipe/unapply", vol.Required("recipe_id"): str}
)
@callback
def ws_recipe_unapply(hass, connection, msg):
    _run(hass, connection, msg, lambda m: m.unapply_recipe(msg["recipe_id"]))


@websocket_api.websocket_command(
    {vol.Required("type"): "einkaufsliste/recipe/import", vol.Required("text"): str}
)
@websocket_api.async_response
async def ws_recipe_import(hass, connection, msg):
    await _run_async(hass, connection, msg, lambda m: async_import(hass, m, msg["text"]))


@websocket_api.websocket_command(
    {vol.Required("type"): "einkaufsliste/barcode/info", vol.Required("code"): str}
)
@websocket_api.async_response
async def ws_barcode_info(hass, connection, msg):
    await _run_async(hass, connection, msg, lambda m: async_product_info(hass, msg["code"]))


@websocket_api.websocket_command({vol.Required("type"): "einkaufsliste/products"})
@callback
def ws_products(hass, connection, msg):
    _run(hass, connection, msg, lambda m: m.products())


@websocket_api.websocket_command(
    {
        vol.Required("type"): "einkaufsliste/product/update",
        vol.Required("key"): str,
        vol.Optional("name"): str,
        vol.Optional("note"): OPT_STR,
        vol.Optional("category_id"): OPT_STR,
        vol.Optional("store_id"): OPT_STR,
        vol.Optional("unit"): OPT_STR,  # 📏 "" oder None = automatisch lernen
        vol.Optional("aliases"): [str],  # 🏷️ Spitznamen („Tempos“)
        vol.Optional("stores"): [str],  # 🏪 „Gibt's bei“
        vol.Optional("own_note"): OPT_STR,  # ✏️ Eigene Notiz
    }
)
@callback
def ws_product_update(hass, connection, msg):
    fields = _pick(msg, "name", "note", "category_id", "store_id", "unit", "stores", "own_note")
    if "unit" in fields and fields["unit"] is None:
        fields["unit"] = ""
    if "note" in fields and fields["note"] is None:
        fields["note"] = ""
    for k in ("category_id", "store_id"):
        if k in fields and fields[k] is None:
            fields[k] = ""

    def do(m):
        prod = m.update_product(msg["key"], **fields)
        if "aliases" in msg:
            m.set_aliases(prod["key"], msg["aliases"])
            prod = next((p for p in m.products() if p["key"] == prod["key"]), prod)
        return prod
    _run(hass, connection, msg, do)


@websocket_api.websocket_command(
    {vol.Required("type"): "einkaufsliste/product/remove", vol.Required("key"): str}
)
@websocket_api.async_response
async def ws_product_remove(hass, connection, msg):
    # 🗑️ ganz löschen: Fotos, Barcodes, Vorschlag und von der Einkaufsliste (Rezepte bleiben)
    await _run_async(hass, connection, msg, lambda m: m.async_delete_product(msg["key"]))


@websocket_api.websocket_command(
    {vol.Required("type"): "einkaufsliste/recipe/import_file", vol.Required("text"): str,
     vol.Optional("filename"): OPT_STR}
)
@websocket_api.require_admin
@callback
def ws_recipe_import_file(hass, connection, msg):
    _run(hass, connection, msg, lambda m: import_recipe_file(m, msg["text"], msg.get("filename")))


@websocket_api.websocket_command(
    {
        vol.Required("type"): "einkaufsliste/import/text",
        vol.Required("text"): str,
        vol.Optional("store_id"): OPT_STR,
        vol.Optional("by_store"): bool,  # 📸 Geschäfts-Überschriften im Text beachten
    }
)
@callback
def ws_import_text(hass, connection, msg):
    if msg.get("by_store"):
        _run(hass, connection, msg, lambda m: import_text_by_store(m, msg["text"], msg.get("store_id") or None))
    else:
        _run(hass, connection, msg, lambda m: import_text(m, msg["text"], msg.get("store_id") or None))


@websocket_api.websocket_command({vol.Required("type"): "einkaufsliste/import/todo_lists"})
@callback
def ws_import_todo_lists(hass, connection, msg):
    connection.send_result(msg["id"], todo_lists(hass))


@websocket_api.websocket_command(
    {vol.Required("type"): "einkaufsliste/import/todo", vol.Required("entity_id"): str, vol.Optional("store_id"): OPT_STR}
)
@websocket_api.async_response
async def ws_import_todo(hass, connection, msg):
    try:  # erst die offenen Einträge holen, dann wie „Text einfügen“ eintragen (mit „wer“)
        text = await async_todo_text(hass, msg["entity_id"])
    except ValueError as err:
        connection.send_error(msg["id"], "invalid", str(err))
        return
    _run(hass, connection, msg, lambda m: import_text(m, text, msg.get("store_id") or None))


@websocket_api.websocket_command(
    {vol.Required("type"): "einkaufsliste/todo_sync/set", vol.Optional("entity_id"): OPT_STR, vol.Optional("store_id"): OPT_STR,
     vol.Optional("mode"): vol.In(["move", "keep", "sync"])}
)
@websocket_api.require_admin
@callback
def ws_todo_sync(hass, connection, msg):
    """🔁 To-do-Liste zum automatischen Herüberholen hinzufügen/ändern (ohne entity_id = alle aus)."""
    _run(hass, connection, msg, lambda m: m.set_todo_sync(msg.get("entity_id") or None, msg.get("store_id") or None, msg.get("mode")))


@websocket_api.websocket_command({vol.Required("type"): "einkaufsliste/todo_sync/remove", vol.Required("entity_id"): str})
@websocket_api.require_admin
@callback
def ws_todo_sync_remove(hass, connection, msg):
    """🔁 Eine To-do-Liste nicht mehr herüberholen."""
    _run(hass, connection, msg, lambda m: m.remove_todo_sync(msg["entity_id"]))


@websocket_api.websocket_command({vol.Required("type"): "einkaufsliste/mail/sources"})
@websocket_api.require_admin
@callback
def ws_mail_sources(hass, connection, msg):
    """📧 Eingerichtete IMAP-Postfächer."""
    connection.send_result(msg["id"], mail_sources(hass))


@websocket_api.websocket_command(
    {
        vol.Required("type"): "einkaufsliste/mail/set",
        vol.Optional("entry_id"): OPT_STR,
        vol.Optional("store_id"): OPT_STR,
        vol.Optional("senders"): [str],
        vol.Optional("after"): vol.In(["keep", "seen", "delete"]),
    }
)
@websocket_api.require_admin
@callback
def ws_mail_import(hass, connection, msg):
    """📧 „Per E-Mail auf die Liste“ einstellen (ohne entry_id = aus)."""
    _run(hass, connection, msg, lambda m: m.set_mail_import(msg.get("entry_id") or None, msg.get("store_id") or None,
                                                         msg.get("senders"), msg.get("after")))


@websocket_api.websocket_command({vol.Required("type"): "einkaufsliste/autoshop/set", vol.Required("on"): bool})
@callback
def ws_auto_shop_set(hass, connection, msg):
    """📍 Laden-Modus automatisch für alle an/aus."""
    _run(hass, connection, msg, lambda m: m.set_auto_shop(msg["on"]))


@websocket_api.websocket_command({vol.Required("type"): "einkaufsliste/privacy/set", vol.Required("on"): bool})
@websocket_api.require_admin
@callback
def ws_privacy_set(hass, connection, msg):
    """🔒 Datenschutz für alle an/aus (an = keine Kamera, keine Fotos, kein Barcode-Scanner)."""
    _run(hass, connection, msg, lambda m: m.set_privacy(msg["on"]))


@websocket_api.websocket_command({vol.Required("type"): "einkaufsliste/labels/set", vol.Required("on"): bool})
@callback
def ws_labels(hass, connection, msg):
    """🏷️ Text unter den Icons für alle an/aus."""
    _run(hass, connection, msg, lambda m: m.set_labels(msg["on"]))


@websocket_api.websocket_command({vol.Required("type"): "einkaufsliste/mascot/set", vol.Required("on"): bool})
@callback
def ws_mascot(hass, connection, msg):
    """🛒😊 Maskottchen für alle an/aus."""
    _run(hass, connection, msg, lambda m: m.set_mascot(msg["on"]))


@websocket_api.websocket_command({vol.Required("type"): "einkaufsliste/spend/set", vol.Required("on"): bool})
@callback
def ws_spend_set(hass, connection, msg):
    """🧾 Einkaufs-Protokoll für alle an/aus."""
    _run(hass, connection, msg, lambda m: m.set_spend(msg["on"]))


@websocket_api.websocket_command({vol.Required("type"): "einkaufsliste/spend/auto", vol.Required("on"): bool})
@callback
def ws_spend_auto_set(hass, connection, msg):
    """🧾 Option: Protokoll von selbst anbieten, wenn alles abgehakt ist."""
    _run(hass, connection, msg, lambda m: m.set_spend_auto(msg["on"]))


@websocket_api.websocket_command({vol.Required("type"): "einkaufsliste/purchases/get"})
@callback
def ws_purchases_get(hass, connection, msg):
    _run(hass, connection, msg, lambda m: m.get_purchases())


@websocket_api.websocket_command(
    {
        vol.Required("type"): "einkaufsliste/purchases/add",
        vol.Required("store_id"): str,
        vol.Required("amount"): vol.Any(str, int, float),
        vol.Optional("day"): OPT_STR,
    }
)
@callback
def ws_purchases_add(hass, connection, msg):
    _run(hass, connection, msg, lambda m: m.add_purchase(msg["store_id"], msg["amount"], msg.get("day")))


@websocket_api.websocket_command({vol.Required("type"): "einkaufsliste/purchases/remove", vol.Required("id"): str})
@callback
def ws_purchases_remove(hass, connection, msg):
    _run(hass, connection, msg, lambda m: m.remove_purchase(msg["id"]))


@websocket_api.websocket_command(
    {vol.Required("type"): "einkaufsliste/item/out", vol.Required("item_id"): str}
)
@callback
def ws_item_out(hass, connection, msg):
    _run(hass, connection, msg, lambda m: m.mark_out(msg["item_id"]))


@websocket_api.websocket_command(
    {vol.Required("type"): "einkaufsliste/barcode/remove", vol.Required("code"): str}
)
@callback
def ws_barcode_remove(hass, connection, msg):
    _run(hass, connection, msg, lambda m: m.remove_barcode(msg["code"]))


@websocket_api.websocket_command({vol.Required("type"): "einkaufsliste/product/confirm", vol.Required("key"): str})
@callback
def ws_product_confirm(hass, connection, msg):
    """📷 Neu gescanntes Produkt geprüft – „Passt so“."""
    _run(hass, connection, msg, lambda m: m.confirm_scanned(msg["key"]))


@websocket_api.websocket_command(
    {vol.Required("type"): "einkaufsliste/typo/learn", vol.Required("wrong"): str, vol.Required("right"): str}
)
@callback
def ws_typo_learn(hass, connection, msg):
    """🧠 „Meintest du …?“ wurde angenommen – merken."""
    _run(hass, connection, msg, lambda m: m.learn_typo(msg["wrong"], msg["right"]))


@websocket_api.websocket_command({vol.Required("type"): "einkaufsliste/typo/forget", vol.Required("wrong"): str})
@callback
def ws_typo_forget(hass, connection, msg):
    _run(hass, connection, msg, lambda m: m.forget_typo(msg["wrong"]))


@websocket_api.websocket_command(
    {vol.Required("type"): "einkaufsliste/pin/set", vol.Optional("pin"): vol.Any(str, None), vol.Optional("old"): vol.Any(str, None)}
)
@callback
def ws_pin_set(hass, connection, msg):
    """🔒 PIN für die Einstellungen setzen (leer = aus). Gibt es schon eine, muss die alte stimmen."""
    _run(hass, connection, msg, lambda m: m.set_pin(msg.get("pin"), msg.get("old")))


@websocket_api.websocket_command({vol.Required("type"): "einkaufsliste/pin/check", vol.Required("pin"): str})
@callback
def ws_pin_check(hass, connection, msg):
    _run(hass, connection, msg, lambda m: {"ok": m.check_pin(msg["pin"])})


async def _run_async(hass, connection, msg, coro_factory) -> None:
    manager = _manager(hass)
    if manager is None:
        connection.send_error(
            msg["id"], "not_loaded", "Die Integration „Einkaufsliste“ ist nicht eingerichtet."
        )
        return
    try:
        with manager.acting(  # 👤 damit im Verlauf der richtige Name steht (nicht „Automatisch“)
            _user_name(hass, connection),
            connection.user.id if connection.user else None,
            msg.get("via") or "card",
        ):
            result = await coro_factory(manager)
    except ValueError as err:
        connection.send_error(msg["id"], "invalid", str(err))
        return
    except Exception as err:  # noqa: BLE001
        _LOGGER.error("Befehl %s ging schief", msg.get("type"), exc_info=True)
        connection.send_error(msg["id"], "error", f"Das ging schief ({type(err).__name__}) – Details stehen im Fehler-Protokoll.")
        return
    connection.send_result(msg["id"], result)


@websocket_api.websocket_command(
    {
        vol.Required("type"): "einkaufsliste/photo/set",
        vol.Required("name"): str,
        vol.Required("data"): str,
        vol.Optional("add", default=False): bool,
    }
)
@websocket_api.async_response
async def ws_photo_set(hass, connection, msg):
    await _run_async(hass, connection, msg, lambda m: m.async_set_photo(msg["name"], msg["data"], msg["add"]))


@websocket_api.websocket_command(
    {
        vol.Required("type"): "einkaufsliste/photo/get",
        vol.Required("name"): str,
        vol.Optional("index", default=0): vol.Coerce(int),
    }
)
@websocket_api.async_response
async def ws_photo_get(hass, connection, msg):
    async def _get(m):
        return {"data": await m.async_get_photo(msg["name"], msg["index"])}

    await _run_async(hass, connection, msg, _get)


@websocket_api.websocket_command(
    {
        vol.Required("type"): "einkaufsliste/photo/remove",
        vol.Required("name"): str,
        vol.Optional("index"): vol.Coerce(int),
    }
)
@websocket_api.async_response
async def ws_photo_remove(hass, connection, msg):
    await _run_async(hass, connection, msg, lambda m: m.async_remove_photo(msg["name"], msg.get("index")))


@websocket_api.websocket_command(
    {
        vol.Required("type"): "einkaufsliste/photo/move",
        vol.Required("name"): str,
        vol.Required("index"): vol.Coerce(int),
        vol.Required("to"): vol.Coerce(int),
    }
)
@callback
def ws_photo_move(hass, connection, msg):
    _run(hass, connection, msg, lambda m: m.move_photo(msg["name"], msg["index"], msg["to"]))


@websocket_api.websocket_command(
    {
        vol.Required("type"): "einkaufsliste/check",
        vol.Optional("fix", default=False): bool,
        # ✅ nur diese Funde reparieren: {Fund-ID: gewählter Wert ("" = Vorschlag / leer)}
        vol.Optional("fixes"): {str: vol.Any(str, None)},
    }
)
@websocket_api.async_response
async def ws_check(hass, connection, msg):
    fixes = {k: v or "" for k, v in (msg.get("fixes") or {}).items()} or None
    await _run_async(hass, connection, msg, lambda m: m.async_check(msg["fix"], fixes))


@websocket_api.websocket_command(
    {
        vol.Required("type"): "einkaufsliste/barcode/lookup",
        vol.Required("code"): str,
        vol.Optional("fresh"): bool,  # True = Datenbank selbst fragen, nicht das Gemerkte
    }
)
@websocket_api.async_response
async def ws_barcode_lookup(hass, connection, msg):
    await _run_async(hass, connection, msg, lambda m: async_lookup(hass, m, msg["code"], bool(msg.get("fresh"))))


@websocket_api.websocket_command(
    {
        vol.Required("type"): "einkaufsliste/barcode/assign",
        vol.Required("item_id"): str,
        vol.Required("code"): str,
    }
)
@callback
def ws_barcode_assign(hass, connection, msg):
    def _assign(m):
        result = m.assign_barcode(msg["item_id"], msg["code"])
        _auto_photo(hass, m, result["code"], product_key(result["name"], result.get("note")))
        return result

    _run(hass, connection, msg, _assign)


@websocket_api.websocket_command(
    {
        vol.Required("type"): "einkaufsliste/product/barcode",
        vol.Required("key"): str,
        vol.Required("code"): str,
    }
)
@callback
def ws_product_barcode(hass, connection, msg):
    def _add(m):
        result = m.add_product_barcode(msg["key"], msg["code"])
        _auto_photo(hass, m, result["code"], result["key"])
        return result

    _run(hass, connection, msg, _add)


@websocket_api.websocket_command(
    {vol.Required("type"): "einkaufsliste/seen", vol.Required("store"): str}
)
@callback
def ws_seen(hass, connection, msg):
    user_id = connection.user.id if connection.user else "unbekannt"
    _run(hass, connection, msg, lambda m: m.mark_seen(user_id, msg["store"]))


@websocket_api.websocket_command({vol.Required("type"): "einkaufsliste/log/get"})
@callback
def ws_log_get(hass, connection, msg):
    _run(hass, connection, msg, lambda m: m.get_log())


@websocket_api.websocket_command(
    {vol.Required("type"): "einkaufsliste/log/settings", vol.Required("days"): vol.Coerce(int)}
)
@callback
def ws_log_settings(hass, connection, msg):
    _run(hass, connection, msg, lambda m: m.set_log_days(msg["days"]))


@websocket_api.websocket_command(
    {vol.Required("type"): "einkaufsliste/product/add", vol.Required("name"): str,
     vol.Optional("category_id"): OPT_STR, vol.Optional("store_id"): OPT_STR, vol.Optional("barcode"): OPT_STR, vol.Optional("note"): OPT_STR}
)
@callback
def ws_product_add(hass, connection, msg):
    def _add(m):
        result = m.add_product(msg["name"], msg.get("category_id"), msg.get("store_id"), msg.get("barcode"), msg.get("note"))
        if result.get("barcodes"):
            _auto_photo(hass, m, result["barcodes"][0], result["key"])
        return result

    _run(hass, connection, msg, _add)


@websocket_api.websocket_command(
    {vol.Required("type"): "einkaufsliste/product/refresh", vol.Required("key"): str, vol.Optional("only_missing"): bool, vol.Optional("replace"): bool}
)
@websocket_api.async_response
async def ws_product_refresh(hass, connection, msg):
    """🔄 Foto zu einem Produkt neu aus der Barcode-Datenbank holen."""
    await _run_async(hass, connection, msg, lambda m: async_refresh_photo(hass, m, msg["key"], bool(msg.get("only_missing")), bool(msg.get("replace"))))


@websocket_api.websocket_command({vol.Required("type"): "einkaufsliste/photos/refresh_plan"})
@websocket_api.async_response
async def ws_photos_refresh_plan(hass, connection, msg):
    """🔄 Alle Fotos neu holen: welche Produkte mit Barcode brauchen ein Foto?"""
    await _run_async(hass, connection, msg, lambda m: m.async_photo_refresh_plan())


@websocket_api.websocket_command(
    {vol.Required("type"): "einkaufsliste/offers/set", vol.Required("enabled"): bool, vol.Optional("zip"): OPT_STR,
     vol.Optional("stores"): [str], vol.Optional("hours"): vol.Coerce(int)}
)
@websocket_api.require_admin
@callback
def ws_offers_set(hass, connection, msg):
    """🏷️ Angebote (Marktguru, inoffiziell) ein-/ausschalten."""
    _run(hass, connection, msg, lambda m: m.set_offers(msg["enabled"], msg.get("zip"), msg.get("stores"), msg.get("hours")))


@websocket_api.websocket_command({vol.Required("type"): "einkaufsliste/offers/refresh"})
@websocket_api.require_admin
@websocket_api.async_response
async def ws_offers_refresh(hass, connection, msg):
    """🏷️ Jetzt nachschauen."""
    async def _go(m):
        if getattr(m, "offers", None) is None:
            raise ValueError("Angebote sind aus.")
        return await m.offers.run(force=True)
    await _run_async(hass, connection, msg, _go)


@websocket_api.websocket_command({vol.Required("type"): "einkaufsliste/offers/search", vol.Required("q"): str})
@websocket_api.async_response
async def ws_offers_search(hass, connection, msg):
    """🔎 Angebote zu einem getippten Produkt."""
    async def _go(m):
        if getattr(m, "offers", None) is None:
            return []
        return await m.offers.search(msg["q"])
    await _run_async(hass, connection, msg, _go)


OFFER = vol.Schema({vol.Required("p"): vol.Coerce(float), vol.Optional("to"): OPT_STR, vol.Optional("from"): OPT_STR, vol.Optional("r"): OPT_STR,
                    vol.Optional("d"): OPT_STR}, extra=vol.REMOVE_EXTRA)


@websocket_api.websocket_command(
    {vol.Required("type"): "einkaufsliste/offers/take", vol.Required("offer"): OFFER, vol.Optional("item_id"): OPT_STR,
     vol.Optional("name"): OPT_STR, vol.Optional("store_id"): OPT_STR, vol.Optional("via"): vol.In(VIA),
     vol.Optional("extra"): bool}
)
@callback
def ws_offers_take(hass, connection, msg):
    """🛒 Angebot übernehmen („Hier kaufen“ / „Auf die Liste“)."""
    who = _user_name(hass, connection)
    uid = connection.user.id if connection.user else None
    _run(hass, connection, msg, lambda m: m.take_offer(msg["offer"], msg.get("item_id") or None, msg.get("name") or None,
                                                       msg.get("store_id") or None, who, uid, bool(msg.get("extra"))))


@websocket_api.websocket_command({vol.Required("type"): "einkaufsliste/stats"})
@websocket_api.async_response
async def ws_stats(hass, connection, msg):
    await _run_async(hass, connection, msg, lambda m: m.async_stats())


@websocket_api.websocket_command(
    {vol.Required("type"): "einkaufsliste/missed/hide", vol.Required("name"): str, vol.Required("store_id"): str}
)
@callback
def ws_missed_hide(hass, connection, msg):
    _run(hass, connection, msg, lambda m: m.hide_missed(msg["name"], msg["store_id"]))


@websocket_api.websocket_command({vol.Required("type"): "einkaufsliste/log/clear"})
@callback
def ws_log_clear(hass, connection, msg):
    _run(hass, connection, msg, lambda m: m.clear_log())


# ------------------------------------------------------------------ 🐞 Fehler-Protokoll
@websocket_api.websocket_command({vol.Required("type"): "einkaufsliste/errors/get"})
@callback
def ws_errors_get(hass, connection, msg):
    _run(hass, connection, msg, lambda m: m.get_errors())


@websocket_api.websocket_command({vol.Required("type"): "einkaufsliste/errors/clear"})
@callback
def ws_errors_clear(hass, connection, msg):
    _run(hass, connection, msg, lambda m: m.clear_errors())


@websocket_api.websocket_command(
    {
        vol.Required("type"): "einkaufsliste/errors/report",
        vol.Required("where"): vol.All(str, vol.Length(max=60)),
        vol.Required("message"): vol.All(str, vol.Length(max=400)),
    }
)
@callback
def ws_errors_report(hass, connection, msg):
    """Die Karte oder die Offline-App meldet einen Fehler, den nur sie sieht (z. B. Foto-Upload)."""
    _run(hass, connection, msg, lambda m: m.log_error(msg["where"], msg["message"]))


# ------------------------------------------------------------------ 🧲 Produkte zusammenführen
@websocket_api.websocket_command(
    {
        vol.Required("type"): "einkaufsliste/product/merge",
        vol.Required("from_key"): str,
        vol.Required("into_key"): str,
    }
)
@websocket_api.async_response
async def ws_product_merge(hass, connection, msg):
    await _run_async(hass, connection, msg, lambda m: m.async_merge_products(msg["from_key"], msg["into_key"]))


# ---------------------------------------------------------------- ⭐ Favoriten
@websocket_api.websocket_command(
    {
        vol.Required("type"): "einkaufsliste/favorite/set",
        vol.Required("name"): str,
        vol.Optional("note"): OPT_STR,
        vol.Required("value"): bool,
    }
)
@callback
def ws_favorite_set(hass, connection, msg):
    """⭐ Produkt als Favorit merken/loslassen."""
    _run(hass, connection, msg, lambda m: m.set_favorite(msg["name"], msg.get("note"), msg["value"]))


@websocket_api.websocket_command({vol.Required("type"): "einkaufsliste/favorites/add"})
@callback
def ws_favorites_add(hass, connection, msg):
    """⭐ Alle Favoriten auf die Einkaufsliste."""
    _run(
        hass, connection, msg,
        lambda m: m.add_favorites(_user_name(hass, connection), connection.user.id if connection.user else None),
    )


# ---------------------------------------------------------------- 💳 Kundenkarten
def _uid(connection) -> str | None:
    return connection.user.id if connection.user else None


@websocket_api.websocket_command({vol.Required("type"): "einkaufsliste/cards/enable", vol.Required("on"): bool})
@callback
def ws_cards_enable(hass, connection, msg):
    """💳 Kundenkarten für alle an/aus."""
    _run(hass, connection, msg, lambda m: m.set_cards_on(msg["on"]))


@websocket_api.websocket_command({vol.Required("type"): "einkaufsliste/cards/list"})
@callback
def ws_cards_list(hass, connection, msg):
    """💳 Meine Karten (eigene + „für alle“). Die Codes gehen NICHT in die große Daten-Antwort, damit „nur für mich“ privat bleibt."""
    _run(hass, connection, msg, lambda m: m.cards_for(_uid(connection)))


CARD_FIELDS = {
    vol.Required("name"): str,
    vol.Required("code"): str,
    vol.Optional("fmt"): str,
    vol.Optional("color"): OPT_STR,
    vol.Optional("photo"): str,
}


@websocket_api.websocket_command(
    {vol.Required("type"): "einkaufsliste/card/add", **CARD_FIELDS, vol.Optional("shared", default=True): bool}
)
@callback
def ws_card_add(hass, connection, msg):
    """💳 Karte anlegen („für alle“ oder nur für mich)."""
    _run(
        hass, connection, msg,
        lambda m: m.add_card(msg["name"], msg["code"], msg.get("fmt"), msg.get("color"), msg["shared"],
                             _uid(connection), _user_name(hass, connection), msg.get("photo")),
    )


@websocket_api.websocket_command(
    {
        vol.Required("type"): "einkaufsliste/card/update",
        vol.Required("card_id"): str,
        vol.Optional("name"): str,
        vol.Optional("code"): str,
        vol.Optional("fmt"): str,
        vol.Optional("color"): OPT_STR,
        vol.Optional("photo"): str,
    }
)
@callback
def ws_card_update(hass, connection, msg):
    """💳 Karte ändern."""
    fields = _pick(msg, "name", "code", "fmt", "color", "photo")
    _run(hass, connection, msg, lambda m: m.update_card(msg["card_id"], _uid(connection), **fields))


@websocket_api.websocket_command({vol.Required("type"): "einkaufsliste/card/photo", vol.Required("card_id"): str})
@callback
def ws_card_photo(hass, connection, msg):
    """💳 Das Foto einer Karte holen (nur wer die Karte sehen darf)."""
    _run(hass, connection, msg, lambda m: m.card_photo(msg["card_id"], _uid(connection)))


@websocket_api.websocket_command({vol.Required("type"): "einkaufsliste/card/remove", vol.Required("card_id"): str})
@callback
def ws_card_remove(hass, connection, msg):
    """💳 Karte löschen."""
    _run(hass, connection, msg, lambda m: m.remove_card(msg["card_id"], _uid(connection)))


# ---------------------------------------------------------------- 🥫 Grocy-Import (nur Admin: es ruft ein anderes Gerät im Netz ab)
@websocket_api.websocket_command(
    {vol.Required("type"): "einkaufsliste/grocy/preview", vol.Optional("url", default=""): str,
     vol.Optional("api_key", default=""): str}
)
@websocket_api.require_admin
@websocket_api.async_response
async def ws_grocy_preview(hass, connection, msg):
    """🥫 Produkte aus Grocy holen (Vorschau). Der Schlüssel wird nicht gespeichert."""
    manager = _manager(hass)
    url, key = msg["url"].strip(), msg["api_key"].strip()
    saved = (manager.grocy if manager is not None else {}) or {}
    if not url:  # nichts getippt -> gespeicherte Verbindung nehmen
        url = saved.get("url", "")
    if not key and saved.get("api_key") and (not msg["url"].strip() or clean_base_safe(url) == saved.get("url")):
        key = saved["api_key"]
    try:
        res = await async_fetch(hass, url, key)
    except ValueError as err:
        connection.send_error(msg["id"], "invalid", str(err))
        return
    existing = {}
    if manager is not None:
        existing = manager.history
    for row in res["rows"]:
        row["exists"] = row["name"].lower() in existing
    connection.send_result(msg["id"], res)


@websocket_api.websocket_command(
    {
        vol.Required("type"): "einkaufsliste/grocy/import",
        vol.Required("rows"): [
            {
                vol.Required("name"): str,
                vol.Optional("group"): OPT_STR,
                vol.Optional("barcodes"): [str],
            }
        ],
        vol.Optional("make_categories", default=True): bool,
    }
)
@websocket_api.require_admin
@callback
def ws_grocy_import(hass, connection, msg):
    """🥫 Die gewählten Grocy-Produkte in den Katalog übernehmen."""
    _run(hass, connection, msg, lambda m: import_rows(m, msg["rows"], msg["make_categories"]))


def clean_base_safe(url: str) -> str:
    try:
        return clean_base(url)
    except ValueError:
        return ""


@websocket_api.websocket_command(
    {
        vol.Required("type"): "einkaufsliste/grocy/set",
        vol.Optional("url", default=""): str,
        vol.Optional("api_key", default=""): str,
        vol.Optional("list_id", default=1): vol.Any(int, str),
        vol.Optional("a_on", default=False): bool,
        vol.Optional("a_mode", default="move"): str,
        vol.Optional("a_store_id"): OPT_STR,
        vol.Optional("b_on", default=False): bool,
        vol.Optional("b_hours", default=6): int,
        vol.Optional("b_cats", default=True): bool,
    }
)
@websocket_api.require_admin
@callback
def ws_grocy_set(hass, connection, msg):
    """🛒 Dauerabgleich mit Grocy einstellen (Schlüssel bleibt auf dem Server)."""
    fields = {k: v for k, v in msg.items() if k not in ("id", "type")}
    _run(hass, connection, msg, lambda m: m.set_grocy(**fields))


@websocket_api.websocket_command({vol.Required("type"): "einkaufsliste/grocy/clear"})
@websocket_api.require_admin
@callback
def ws_grocy_clear(hass, connection, msg):
    """🛒 Verbindung zu Grocy entfernen."""
    _run(hass, connection, msg, lambda m: m.clear_grocy())


@websocket_api.websocket_command({vol.Required("type"): "einkaufsliste/grocy/run"})
@websocket_api.require_admin
@websocket_api.async_response
async def ws_grocy_run(hass, connection, msg):
    """🛒 Jetzt sofort mit Grocy abgleichen."""
    manager = _manager(hass)
    gs = getattr(manager, "grocy_sync", None) if manager is not None else None
    if gs is None or not (manager.grocy or {}).get("url"):
        connection.send_error(msg["id"], "invalid", "Grocy ist noch nicht eingerichtet.")
        return
    status = await gs.run(force_b=True)
    connection.send_result(msg["id"], {"status": status})


@websocket_api.websocket_command(
    {vol.Required("type"): "einkaufsliste/import/catalog", vol.Required("text"): vol.All(str, vol.Length(max=2_000_000)),
     vol.Optional("make_categories", default=True): bool, vol.Optional("preview", default=False): bool}
)
@websocket_api.require_admin
@callback
def ws_catalog_csv(hass, connection, msg):
    """📄 Produkte aus CSV/Text in den Katalog (preview = nur zählen, nichts anlegen)."""
    rows = parse_catalog_text(msg["text"])
    if msg["preview"]:
        m = _manager(hass)
        have = sum(1 for r in rows if m is not None and r["name"].lower() in m.history)
        connection.send_result(msg["id"], {"rows": len(rows), "exists": have,
                                           "sample": [r["name"] for r in rows[:5]]})
        return
    _run(hass, connection, msg, lambda m: import_rows(m, rows, msg["make_categories"]))


@websocket_api.websocket_command(
    {vol.Required("type"): "einkaufsliste/note_templates/set", vol.Required("items"): vol.Any(None, [vol.All(str, vol.Length(max=80))])}
)
@callback
def ws_note_templates(hass, connection, msg):
    """📝 Vorlagen für die Eigene Notiz (null = Standard)."""
    _run(hass, connection, msg, lambda m: m.set_note_templates(msg["items"]))


@websocket_api.websocket_command(
    {vol.Required("type"): "einkaufsliste/ai/agent", vol.Required("entity_id"): vol.Any(None, str), vol.Optional("on"): bool}
)
@websocket_api.require_admin
@callback
def ws_ai_agent(hass, connection, msg):
    """🤖 KI-Assistent fürs Kochen wählen (null = aus)."""
    _run(hass, connection, msg, lambda m: m.set_ai_agent(msg["entity_id"] or None, msg.get("on")))


@websocket_api.websocket_command(
    {
        vol.Required("type"): "einkaufsliste/ai/prefs",
        vol.Optional("pantry"): vol.All(str, vol.Length(max=1200)),
        vol.Optional("avoid"): vol.All(str, vol.Length(max=1200)),
    }
)
@websocket_api.require_admin
@callback
def ws_ai_prefs(hass, connection, msg):
    """🤖 KI-Kochen: „Immer im Haus“ und „Das nie vorschlagen“ speichern."""
    _run(hass, connection, msg, lambda m: m.set_ai_prefs(msg.get("pantry"), msg.get("avoid")))


@websocket_api.websocket_command(
    {
        vol.Required("type"): "einkaufsliste/ai/cook",
        vol.Optional("ingredients", default=list): [vol.All(str, vol.Length(max=120))],
        vol.Optional("use_list", default=False): bool,
        vol.Optional("wishes", default=""): vol.All(str, vol.Length(max=300)),
        vol.Optional("servings"): vol.Any(None, vol.All(vol.Coerce(int), vol.Range(min=1, max=20))),
    }
)
@websocket_api.async_response
async def ws_ai_cook(hass, connection, msg):
    """🤖 „Was kann ich damit kochen?“ – Ideen vom KI-Assistenten."""
    manager = _manager(hass)
    if manager is None:
        connection.send_error(msg["id"], "not_ready", "Die Einkaufsliste ist noch nicht bereit.")
        return
    try:
        ideas = await async_cook(hass, manager, msg["ingredients"], msg["use_list"], msg["wishes"], servings=msg.get("servings"))
    except ValueError as err:
        connection.send_error(msg["id"], "invalid", str(err))
        return
    connection.send_result(msg["id"], {"ideas": ideas})
