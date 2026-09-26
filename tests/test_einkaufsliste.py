"""Tests für die Einkaufsliste (echtes Home Assistant im Testmodus)."""

from datetime import datetime, timedelta
from unittest.mock import patch

import pytest
from pytest_homeassistant_custom_component.common import (
    MockConfigEntry,
    async_fire_time_changed,
)

from homeassistant.core import Context, HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.setup import async_setup_component
from homeassistant.util import dt as dt_util

from custom_components.einkaufsliste.const import DOMAIN

TZ = "Europe/Berlin"


@pytest.fixture
async def setup(hass: HomeAssistant):
    await hass.config.async_set_time_zone(TZ)
    assert await async_setup_component(hass, "http", {})
    hass.config.components.update({"frontend", "lovelace"})
    entry = MockConfigEntry(
        domain=DOMAIN,
        title="Einkaufsliste",
        options={"cleanup_weekday": 6, "cleanup_time": "03:00:00", "min_age_days": 7},
    )
    entry.add_to_hass(hass)
    with patch("custom_components.einkaufsliste.frontend.add_extra_js_url") as js:
        assert await hass.config_entries.async_setup(entry.entry_id)
        await hass.async_block_till_done()
    assert js.called
    return entry


def mgr(hass):
    return hass.data[DOMAIN]["manager"]


def tz():
    return dt_util.get_time_zone(TZ)


async def test_defaults(hass, setup):
    m = mgr(hass)
    assert [s["name"] for s in m.stores][:3] == ["Netto", "Aldi", "Lidl"]
    assert any(c["name"] == "TK-Ware" for c in m.categories)
    assert hass.states.get("sensor.einkaufsliste_offene_artikel").state == "0"


async def test_websocket_flow_with_user_name(hass, setup, hass_ws_client, hass_admin_user):
    client = await hass_ws_client(hass)
    m = mgr(hass)
    aldi = m.find_store("aldi")

    await client.send_json({"id": 1, "type": "einkaufsliste/subscribe"})
    assert (await client.receive_json())["success"]
    first = await client.receive_json()
    assert first["event"]["items"] == [] and first["event"]["recipes"] == []

    await client.send_json(
        {
            "id": 2,
            "type": "einkaufsliste/item/add",
            "name": "Milch",
            "store_id": aldi,
            "quantity": "2",
            "note": "Bio",
            "for_whom": "Oma",
        }
    )
    assert (await client.receive_json())["type"] == "event"
    res = await client.receive_json()
    assert res["success"], res
    item = res["result"]
    assert item["added_by"] == hass_admin_user.name
    assert item["note"] == "Bio" and item["for_whom"] == "Oma"
    await hass.async_block_till_done()
    state = hass.states.get("sensor.einkaufsliste_offene_artikel")
    assert state.state == "1"
    assert state.attributes["pro_geschaeft"]["Aldi"] == 1
    assert state.attributes["artikel"][0]["fuer"] == "Oma"

    await client.send_json({"id": 4, "type": "einkaufsliste/item/toggle", "item_id": item["id"]})
    await client.receive_json()
    res = await client.receive_json()
    assert res["result"]["checked"] is True

    await client.send_json({"id": 5, "type": "einkaufsliste/item/add", "name": "  "})
    res = await client.receive_json()
    assert not res["success"] and res["error"]["code"] == "invalid"


async def test_person_name_is_used(hass, setup, hass_admin_user):
    hass.states.async_set(
        "person.anna", "home", {"user_id": hass_admin_user.id, "friendly_name": "Anna"}
    )
    await hass.services.async_call(
        DOMAIN, "add_item", {"name": "Brot"}, blocking=True, context=Context(user_id=hass_admin_user.id)
    )
    assert mgr(hass).items[0]["added_by"] == "Anna"


async def test_duplicates_only_with_different_note_person_or_store(hass, setup):
    m = mgr(hass)
    netto, aldi = m.find_store("Netto"), m.find_store("Aldi")
    a = m.add_item("Käse", store_id=netto, added_by="Anna")
    same = m.add_item("käse", store_id=netto, added_by="Ben")
    assert same is a and len(m.items) == 1
    m.add_item("Käse", store_id=aldi)  # anderes Geschäft -> erlaubt
    m.add_item("Käse", store_id=netto, note="gerieben")
    m.add_item("Käse", store_id=netto, for_whom="Oma")
    assert len(m.items) == 4
    with pytest.raises(ValueError):
        m.update_item(m.items[1]["id"], store_id=netto)  # würde Duplikat ergeben
    m.update_item(m.items[1]["id"], store_id=None)  # "Egal wo" ist wieder ein eigener Ort
    assert len(m.items) == 4


async def test_readd_always_takes_new_name(hass, setup, freezer):
    m = mgr(hass)
    item = m.add_item("Butter", added_by="Anna")
    m.set_checked(item["id"], True, "Ben")
    assert item["checked_by"] == "Ben"
    freezer.tick(timedelta(seconds=10))
    m.set_checked(item["id"], False, "Ben")  # auch kurz danach: neuer Name
    assert item["added_by"] == "Ben" and not item["checked"]
    m.set_checked(item["id"], True, "Ben")
    again = m.add_item("Butter", added_by="Clara")
    assert again is item and item["added_by"] == "Clara" and not item["checked"]


async def test_cleanup_checks_instead_of_deleting(hass, setup, freezer):
    """Di eingetragen -> erster So bleibt offen, zweiter So wird abgehakt."""
    m = mgr(hass)
    freezer.move_to(datetime(2026, 9, 22, 18, 0, tzinfo=tz()))  # Dienstag
    nudeln = m.add_item("Nudeln")
    m.cleanup(reference=datetime(2026, 9, 27, 3, 0, tzinfo=tz()), scheduled=True)
    assert not nudeln["checked"]
    freezer.move_to(datetime(2026, 9, 27, 10, 0, tzinfo=tz()))
    zahnpasta = m.add_item("Zahnpasta")
    m.cleanup(reference=datetime(2026, 10, 4, 3, 0, tzinfo=tz()), scheduled=True)
    assert nudeln["checked"] and zahnpasta["checked"]
    assert nudeln["checked_by"] is None
    assert len(m.items) == 2  # nichts gelöscht


async def test_scheduler_fires_on_sunday(hass, setup, freezer):
    m = mgr(hass)
    freezer.move_to(datetime(2026, 9, 22, 18, 0, tzinfo=tz()))
    # Zeitplan neu starten, damit er von der eingefrorenen Zeit ausgeht (nicht vom echten Datum)
    m.async_stop()
    m.async_start_scheduler()
    item = m.add_item("Nudeln")
    events = []
    hass.bus.async_listen("einkaufsliste_cleanup", lambda e: events.append(e))
    for target, expected in (
        (datetime(2026, 9, 27, 3, 0, tzinfo=tz()), 0),
        (datetime(2026, 10, 4, 3, 0, tzinfo=tz()), 1),
    ):
        freezer.move_to(target)
        async_fire_time_changed(hass, target)
        await hass.async_block_till_done()
        assert events[-1].data["checked"] == expected
    assert item["checked"] and len(m.items) == 1


async def test_recipes(hass, setup, hass_ws_client, hass_admin_user):
    client = await hass_ws_client(hass)
    m = mgr(hass)
    tk = m.find_category("TK-Ware")
    m.add_item("Spinat", store_id=m.find_store("Aldi"), category_id=tk)  # Verlauf merken
    spinat = m.items[0]
    m.set_checked(spinat["id"], True)

    await client.send_json(
        {
            "id": 1,
            "type": "einkaufsliste/recipe/add",
            "name": "Freitags Fisch",
            "icon": "fish",
            "items": [
                {"name": "Fertig-Salat", "for_whom": "Ben"},
                {"name": "Fischstäbchen", "quantity": "2x", "category_id": tk},
                {"name": "Spinat"},
                {"name": " "},
            ],
        }
    )
    res = await client.receive_json()
    assert res["success"], res
    recipe = res["result"]
    assert recipe["icon"] == "mdi:fish" and len(recipe["items"]) == 3

    await client.send_json({"id": 2, "type": "einkaufsliste/recipe/apply", "recipe_id": recipe["id"]})
    res = await client.receive_json()
    assert res["success"], res
    assert res["result"] == {"added": 3, "already": 0}
    # Rezept-Zutaten kommen ZUSÄTZLICH: normaler Spinat bleibt, Rezept-Spinat ist neu
    assert len(m.items) == 4
    assert spinat["checked"] and spinat["recipe_id"] is None
    rezept_spinat = next(i for i in m.items if i["name"] == "Spinat" and i["recipe_id"])
    assert not rezept_spinat["checked"] and rezept_spinat["category_id"] == tk  # aus dem Verlauf
    salat = m.find_item("Fertig-Salat")
    assert salat["for_whom"] == "Ben" and salat["added_by"] == hass_admin_user.name

    # normaler Mozzarella + Rezept-Mozzarella = zwei Einträge
    m.add_item("Mozzarella")
    await client.send_json(
        {"id": 3, "type": "einkaufsliste/recipe/update", "recipe_id": recipe["id"],
         "items": recipe["items"] + [{"name": "Mozzarella"}]}
    )
    assert (await client.receive_json())["success"]

    # nochmal anwenden -> keine Duplikate, nur der neue Mozzarella kommt dazu
    await client.send_json({"id": 4, "type": "einkaufsliste/recipe/apply", "recipe_id": recipe["id"]})
    res = await client.receive_json()
    assert res["result"] == {"added": 1, "already": 3}
    mozz = [i for i in m.items if i["name"] == "Mozzarella"]
    assert len(mozz) == 2 and {bool(i["recipe_id"]) for i in mozz} == {True, False}
    assert len(m.items) == 6

    # Rezept-Zutat abhaken -> verschwindet ganz, normaler Mozzarella bleibt
    rm = next(i for i in mozz if i["recipe_id"])
    normal = next(i for i in mozz if not i["recipe_id"])
    m.set_checked(rm["id"], True)
    assert rm not in m.items and len(m.items) == 5
    m.set_checked(normal["id"], True)
    assert normal in m.items and normal["checked"]

    # doppelte Zutat im Rezept -> Fehler
    await client.send_json(
        {"id": 6, "type": "einkaufsliste/recipe/update", "recipe_id": recipe["id"],
         "items": [{"name": "A"}, {"name": "a"}]}
    )
    assert not (await client.receive_json())["success"]

    # per Aktion: alles abhaken -> Rezept-Zutaten weg, normale bleiben abgehakt
    for i in list(m.items):
        m.set_checked(i["id"], True)
    assert all(not i["recipe_id"] for i in m.items)
    assert sorted(i["name"] for i in m.items) == ["Mozzarella", "Spinat"]
    res = await hass.services.async_call(
        DOMAIN, "add_recipe", {"name": "freitags fisch"}, blocking=True, return_response=True
    )
    assert res["added"] == 4 and len(m.items) == 6

    # automatisches Aufräumen: Rezept-Zutaten verschwinden, normale werden abgehakt
    m.add_item("Brot")
    m.cleanup(force=True)
    assert sorted(i["name"] for i in m.items) == ["Brot", "Mozzarella", "Spinat"]
    assert all(i["checked"] for i in m.items)

    m.apply_recipe(recipe["id"])
    # Rezept löschen: offene Rezept-Einträge werden normale Artikel, wenn es sie nicht
    # schon normal gibt (Mozzarella + Spinat gibt es normal -> Rezept-Doppel fliegen raus)
    await client.send_json({"id": 7, "type": "einkaufsliste/recipe/remove", "recipe_id": recipe["id"]})
    assert (await client.receive_json())["success"]
    assert all(i["recipe_id"] is None for i in m.items)
    assert sorted(i["name"] for i in m.items) == ["Brot", "Fertig-Salat", "Fischstäbchen", "Mozzarella", "Spinat"]


async def test_services(hass, setup):
    m = mgr(hass)
    res = await hass.services.async_call(
        DOMAIN,
        "add_item",
        {"name": "Pizza", "store": "netto", "category": "tk-ware", "added_by": "Oma", "for_whom": "Ben"},
        blocking=True,
        return_response=True,
    )
    assert res["item"]["added_by"] == "Oma" and res["item"]["for_whom"] == "Ben"
    pizza = m.items[0]
    m.remove_item(pizza["id"])
    await hass.services.async_call(DOMAIN, "add_item", {"name": "pizza"}, blocking=True)
    assert m.store_by_id(m.items[0]["store_id"])["name"] == "Netto"  # aus dem Verlauf

    await hass.services.async_call(DOMAIN, "check_item", {"name": "Pizza"}, blocking=True)
    assert m.items[0]["checked"]

    m.add_item("X")
    res = await hass.services.async_call(
        DOMAIN, "cleanup", {"force": True}, blocking=True, return_response=True
    )
    assert res["checked"] == 1 and len(m.items) == 2

    await hass.services.async_call(DOMAIN, "remove_item", {"name": "X"}, blocking=True)
    assert len(m.items) == 1

    with pytest.raises(HomeAssistantError):
        await hass.services.async_call(
            DOMAIN, "add_item", {"name": "Y", "store": "Gibtsnicht"}, blocking=True
        )


async def test_groups_and_icons(hass, setup, hass_ws_client):
    client = await hass_ws_client(hass)
    m = mgr(hass)
    await client.send_json(
        {"id": 1, "type": "einkaufsliste/group/add", "kind": "categories", "name": "Tierbedarf", "icon": "dog"}
    )
    res = await client.receive_json()
    assert res["success"] and res["result"]["icon"] == "mdi:dog"
    await client.send_json(
        {"id": 2, "type": "einkaufsliste/group/add", "kind": "stores", "name": "Kaufland", "color": "#ff0000"}
    )
    new_id = (await client.receive_json())["result"]["id"]
    item = m.add_item("Reis", store_id=new_id)
    ids = [s["id"] for s in m.stores]
    await client.send_json(
        {"id": 3, "type": "einkaufsliste/group/reorder", "kind": "stores", "ids": [new_id] + ids[:-1]}
    )
    assert (await client.receive_json())["success"]
    assert m.stores[0]["name"] == "Kaufland"
    await client.send_json(
        {"id": 4, "type": "einkaufsliste/group/remove", "kind": "stores", "group_id": new_id}
    )
    assert (await client.receive_json())["success"]
    assert item["store_id"] is None


async def test_persistence_and_unload(hass, setup, hass_storage):
    m = mgr(hass)
    m.add_item("Kaffee")
    m.add_recipe("Frühstück", [{"name": "Brötchen"}])
    assert await hass.config_entries.async_unload(setup.entry_id)
    data = hass_storage["einkaufsliste.data"]["data"]
    assert data["items"][0]["name"] == "Kaffee"
    assert data["recipes"][0]["name"] == "Frühstück"


async def test_old_data_is_upgraded(hass, hass_storage):
    await hass.config.async_set_time_zone(TZ)
    hass_storage["einkaufsliste.data"] = {
        "version": 1,
        "key": "einkaufsliste.data",
        "data": {
            "stores": [], "categories": [], "history": {}, "last_cleanup": dt_util.utcnow().isoformat(),
            "items": [{"id": "a", "name": "Alt", "store_id": None, "category_id": None, "quantity": None,
                       "note": None, "checked": False, "added_by": None, "added_at": dt_util.utcnow().isoformat(),
                       "checked_by": None, "checked_at": None}],
        },
    }
    assert await async_setup_component(hass, "http", {})
    hass.config.components.update({"frontend", "lovelace"})
    entry = MockConfigEntry(domain=DOMAIN, options={"cleanup_weekday": 6, "cleanup_time": "03:00:00", "min_age_days": 7, "only_checked": True})
    entry.add_to_hass(hass)
    with patch("custom_components.einkaufsliste.frontend.add_extra_js_url"):
        assert await hass.config_entries.async_setup(entry.entry_id)
    item = mgr(hass).items[0]
    assert item["for_whom"] is None and item["recipe_id"] is None
    assert mgr(hass).as_dict()["recipes"] == []


async def test_config_flow(hass):
    await hass.config.async_set_time_zone(TZ)
    hass.config.components.update({"frontend", "http", "websocket_api", "lovelace"})
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": "user"})
    assert result["type"] == "form"
    with patch("custom_components.einkaufsliste.async_setup", return_value=True), patch(
        "custom_components.einkaufsliste.async_setup_entry", return_value=True
    ):
        result = await hass.config_entries.flow.async_configure(
            result["flow_id"],
            {"cleanup_weekday": "5", "cleanup_time": "04:30:00", "min_age_days": 14},
        )
    assert result["type"] == "create_entry"
    assert result["options"] == {"cleanup_weekday": 5, "cleanup_time": "04:30:00", "min_age_days": 14}


async def test_card_is_registered_as_resource(hass, hass_storage):
    """Die Karte trägt sich selbst als Dashboard-Ressource ein (und passt alte an)."""
    await hass.config.async_set_time_zone(TZ)
    hass_storage["lovelace_resources"] = {
        "version": 1,
        "key": "lovelace_resources",
        "data": {"items": [{"id": "handmade", "type": "module", "url": "/einkaufsliste_files/einkaufsliste-card.js"}]},
    }
    assert await async_setup_component(hass, "http", {})
    assert await async_setup_component(hass, "lovelace", {})
    hass.config.components.add("frontend")
    entry = MockConfigEntry(domain=DOMAIN, options={"cleanup_weekday": 6, "cleanup_time": "03:00:00", "min_age_days": 7})
    entry.add_to_hass(hass)
    with patch("custom_components.einkaufsliste.frontend.add_extra_js_url") as js:
        assert await hass.config_entries.async_setup(entry.entry_id)
        await hass.async_block_till_done()
    assert not js.called
    from homeassistant.components.lovelace.const import LOVELACE_DATA
    from custom_components.einkaufsliste.const import VERSION

    items = hass.data[LOVELACE_DATA].resources.async_items()
    urls = [i["url"] for i in items if "einkaufsliste" in i["url"]]
    assert urls == [f"/einkaufsliste_files/einkaufsliste-card.js?v={VERSION}"]  # kein Doppel


async def test_persons(hass, setup, hass_ws_client):
    client = await hass_ws_client(hass)
    m = mgr(hass)
    await client.send_json({"id": 1, "type": "einkaufsliste/group/add", "kind": "persons", "name": "Oma"})
    res = await client.receive_json()
    assert res["success"] and res["result"]["name"] == "Oma"
    oma = res["result"]["id"]
    await client.send_json({"id": 2, "type": "einkaufsliste/group/add", "kind": "persons", "name": "oma"})
    assert not (await client.receive_json())["success"]
    item = m.add_item("Kekse", for_whom="Oma")
    m.add_recipe("Kaffeeklatsch", [{"name": "Kuchen", "for_whom": "Oma"}])
    await client.send_json(
        {"id": 3, "type": "einkaufsliste/group/update", "kind": "persons", "group_id": oma, "name": "Omi"}
    )
    assert (await client.receive_json())["success"]
    assert item["for_whom"] == "Omi" and m.recipes[0]["items"][0]["for_whom"] == "Omi"
    await client.send_json({"id": 4, "type": "einkaufsliste/group/remove", "kind": "persons", "group_id": oma})
    assert (await client.receive_json())["success"]
    assert m.persons == [] and item["for_whom"] == "Omi"
    assert m.as_dict()["persons"] == []


async def test_persons_seeded_from_old_data(hass, hass_storage):
    await hass.config.async_set_time_zone(TZ)
    now = dt_util.utcnow().isoformat()
    hass_storage["einkaufsliste.data"] = {
        "version": 1,
        "key": "einkaufsliste.data",
        "data": {
            "stores": [], "categories": [], "history": {}, "last_cleanup": now,
            "recipes": [{"id": "r", "name": "R", "icon": "mdi:x", "items": [{"name": "A", "for_whom": "Ben"}]}],
            "items": [{"id": "a", "name": "Alt", "store_id": None, "category_id": None, "quantity": None,
                       "note": None, "for_whom": "Oma", "recipe_id": None, "checked": False, "added_by": None,
                       "added_at": now, "checked_by": None, "checked_at": None}],
        },
    }
    assert await async_setup_component(hass, "http", {})
    hass.config.components.update({"frontend", "lovelace"})
    entry = MockConfigEntry(domain=DOMAIN, options={"cleanup_weekday": 6, "cleanup_time": "03:00:00", "min_age_days": 7})
    entry.add_to_hass(hass)
    with patch("custom_components.einkaufsliste.frontend.add_extra_js_url"):
        assert await hass.config_entries.async_setup(entry.entry_id)
    assert [p["name"] for p in mgr(hass).persons] == ["Oma", "Ben"]


JPEG = bytes.fromhex("ffd8ffe000104a46494600010100000100010000ffd9")


async def test_photos(hass, setup, hass_ws_client):
    import base64

    client = await hass_ws_client(hass)
    m = mgr(hass)
    item = m.add_item("Nudeln")
    data = "data:image/jpeg;base64," + base64.b64encode(JPEG).decode()
    await client.send_json({"id": 1, "type": "einkaufsliste/photo/set", "name": "Nudeln", "data": data})
    res = await client.receive_json()
    assert res["success"], res
    assert "nudeln" in m.as_dict()["photos"]
    await client.send_json({"id": 2, "type": "einkaufsliste/photo/get", "name": "nudeln"})
    res = await client.receive_json()
    assert res["result"]["data"].startswith("data:image/jpeg;base64,")

    # kein Bild -> Fehler
    await client.send_json({"id": 3, "type": "einkaufsliste/photo/set", "name": "Nudeln", "data": base64.b64encode(b"hallo").decode()})
    assert not (await client.receive_json())["success"]

    # Foto bleibt beim Produkt: abhaken + wieder rein
    m.set_checked(item["id"], True)
    m.set_checked(item["id"], False)
    assert "nudeln" in m.photos

    # Umbenennen nimmt das Foto mit
    m.update_item(item["id"], name="Spaghetti")
    assert "spaghetti" in m.photos and "nudeln" not in m.photos
    photo_file = m._photo_path(m.photos["spaghetti"]["id"])
    assert photo_file.exists()

    # Ganz löschen -> Foto weg
    m.remove_item(item["id"])
    await hass.async_block_till_done()
    assert "spaghetti" not in m.photos and not photo_file.exists()


async def test_photo_kept_for_recipe(hass, setup):
    import base64

    m = mgr(hass)
    item = m.add_item("Mozzarella")
    m.add_recipe("Pizza", [{"name": "Mozzarella"}])
    await m.async_set_photo("Mozzarella", base64.b64encode(JPEG).decode())
    m.remove_item(item["id"])
    await hass.async_block_till_done()
    assert "mozzarella" in m.photos  # Rezept braucht es noch


async def test_names_are_tidied(hass, setup):
    m = mgr(hass)
    assert m.add_item("  milch   ")["name"] == "Milch"
    assert m.add_item("h-milch")["name"] == "H-milch"
    assert m.add_item("iPhone Kabel")["name"] == "iPhone Kabel"
    assert m.add_item("MILCH") is m.items[0]  # gleicher Artikel, keine Dopplung
    r = m.add_recipe("freitags   fisch", [{"name": "fischstäbchen"}])
    assert r["name"] == "Freitags fisch" and r["items"][0]["name"] == "Fischstäbchen"
    assert m.add_group("stores", "kaufland")["name"] == "Kaufland"


async def test_category_guessing(hass, setup):
    from custom_components.einkaufsliste.categories import guess_category

    m = mgr(hass)
    cat = lambda n: (m.category_by_id(guess_category(n, m.categories)) or {}).get("name")
    assert cat("Joghurt") == "Kühlregal & Milch"
    assert cat("Pizza Salami") == "TK-Ware"
    assert cat("Vollmilch") == "Kühlregal & Milch"
    assert cat("Milchschokolade") == "Süßes & Snacks"
    assert cat("Reis") == "Vorrat & Konserven"
    assert cat("Eis") == "TK-Ware"
    assert cat("Eier") == "Kühlregal & Milch"
    assert cat("Weißwein") == "Getränke"
    assert cat("WC-Reiniger") == "Haushalt"
    assert cat("Bananen") == "Obst & Gemüse"
    assert cat("Irgendwas Komisches") is None
    hints = m.as_dict()["category_hints"]
    assert any("joghurt" in h["words"] for h in hints)
    # Aktion ohne Kategorie -> geraten
    await hass.services.async_call(DOMAIN, "add_item", {"name": "Toastbrot"}, blocking=True)
    assert m.category_by_id(m.items[0]["category_id"])["name"] == "Backwaren"


async def test_store_zone(hass, setup, hass_ws_client):
    client = await hass_ws_client(hass)
    m = mgr(hass)
    aldi = m.find_store("Aldi")
    await client.send_json({"id": 1, "type": "einkaufsliste/group/update", "kind": "stores", "group_id": aldi, "zone": "zone.aldi"})
    assert (await client.receive_json())["success"]
    assert m.store_by_id(aldi)["zone"] == "zone.aldi"
    await client.send_json({"id": 2, "type": "einkaufsliste/group/update", "kind": "stores", "group_id": aldi, "zone": "sensor.x"})
    assert not (await client.receive_json())["success"]
    await client.send_json({"id": 3, "type": "einkaufsliste/group/update", "kind": "stores", "group_id": aldi, "zone": None})
    assert (await client.receive_json())["success"] and m.store_by_id(aldi)["zone"] is None


async def test_move_item_to_other_store(hass, setup):
    m = mgr(hass)
    aldi, netto = m.find_store("Aldi"), m.find_store("Netto")
    item = m.add_item("Milch", store_id=aldi)
    m.update_item(item["id"], store_id=netto)
    assert item["store_id"] == netto
    m.add_item("Milch", store_id=aldi)
    with pytest.raises(ValueError):
        m.update_item(item["id"], store_id=aldi)  # gibt's dort schon


async def test_barcode_lookup(hass, setup, hass_ws_client, aioclient_mock):
    client = await hass_ws_client(hass)
    m = mgr(hass)
    aioclient_mock.get(
        "https://world.openfoodfacts.org/api/v2/product/4008400402222.json",
        json={"status": 1, "product": {"product_name_de": "Pizza Salami", "brands": "Wagner,Nestlé",
                                        "categories_tags": ["en:frozen-foods", "en:pizzas"]}},
    )
    aioclient_mock.get("https://world.openfoodfacts.org/api/v2/product/4005900000000.json", status=404)
    aioclient_mock.get(
        "https://world.openbeautyfacts.org/api/v2/product/4005900000000.json",
        json={"status": 1, "product": {"product_name": "Duschgel", "brands": "Nivea"}},
    )
    for base in ("openfoodfacts", "openbeautyfacts", "openproductsfacts"):
        aioclient_mock.get(f"https://world.{base}.org/api/v2/product/1111111111116.json", status=404)

    await client.send_json({"id": 1, "type": "einkaufsliste/barcode/lookup", "code": "4008400402222"})
    res = (await client.receive_json())["result"]
    assert res["found"] and res["name"] == "Wagner Pizza Salami" and res["source"] == "Open Food Facts"
    assert res["category_id"] == m.find_category("TK-Ware")

    await client.send_json({"id": 2, "type": "einkaufsliste/barcode/lookup", "code": "4005900000000"})
    res = (await client.receive_json())["result"]
    assert res["name"] == "Nivea Duschgel" and res["category_id"] == m.find_category("Drogerie")

    await client.send_json({"id": 3, "type": "einkaufsliste/barcode/lookup", "code": "1111111111116"})
    res = (await client.receive_json())["result"]
    assert res == {"code": "1111111111116", "found": False}

    # unbekannten Barcode beim Hinzufügen lernen -> nächstes Mal ohne Internet
    aldi = m.find_store("Aldi")
    await client.send_json({"id": 4, "type": "einkaufsliste/item/add", "name": "Hausmarke Kekse",
                            "store_id": aldi, "barcode": "1111111111116"})
    assert (await client.receive_json())["success"]
    calls = aioclient_mock.call_count
    await client.send_json({"id": 5, "type": "einkaufsliste/barcode/lookup", "code": "1111111111116"})
    res = (await client.receive_json())["result"]
    assert res["found"] and res["source"] == "gemerkt" and res["name"] == "Hausmarke Kekse"
    assert res["store_id"] == aldi and aioclient_mock.call_count == calls

    await client.send_json({"id": 6, "type": "einkaufsliste/barcode/lookup", "code": "abc"})
    assert not (await client.receive_json())["success"]


async def test_assign_barcode_to_existing_item(hass, setup, hass_ws_client, aioclient_mock):
    for base in ("openfoodfacts", "openbeautyfacts", "openproductsfacts"):
        aioclient_mock.get(f"https://world.{base}.org/api/v2/product/4000417025005.json", status=404)
    client = await hass_ws_client(hass)
    m = mgr(hass)
    aldi = m.find_store("Aldi")
    item = m.add_item("Milch", store_id=aldi, category_id=m.find_category("Kühlregal & Milch"))
    await client.send_json({"id": 1, "type": "einkaufsliste/barcode/assign", "item_id": item["id"], "code": "4 000417 025005"})
    res = await client.receive_json()
    assert res["success"] and res["result"] == {"code": "4000417025005", "name": "Milch", "note": None}
    await client.send_json({"id": 2, "type": "einkaufsliste/barcode/lookup", "code": "4000417025005"})
    res = (await client.receive_json())["result"]
    assert res["found"] and res["source"] == "gemerkt" and res["name"] == "Milch" and res["store_id"] == aldi
    await client.send_json({"id": 3, "type": "einkaufsliste/barcode/assign", "item_id": item["id"], "code": "abc"})
    assert not (await client.receive_json())["success"]
    await hass.async_block_till_done(wait_background_tasks=True)
    assert "milch" not in m.photos


async def test_category_colors_and_seen(hass, setup, hass_ws_client, hass_admin_user):
    client = await hass_ws_client(hass)
    m = mgr(hass)
    assert all(c.get("color", "").startswith("#") for c in m.categories)
    tk = m.find_category("TK-Ware")
    await client.send_json({"id": 1, "type": "einkaufsliste/group/update", "kind": "categories", "group_id": tk, "color": "#123456"})
    assert (await client.receive_json())["success"]
    assert m.category_by_id(tk)["color"] == "#123456"
    new = m.add_group("categories", "Tierbedarf", icon="dog")
    assert new["color"].startswith("#")

    aldi = m.find_store("Aldi")
    await client.send_json({"id": 2, "type": "einkaufsliste/seen", "store": aldi})
    assert (await client.receive_json())["success"]
    assert aldi in m.seen[hass_admin_user.id]
    await client.send_json({"id": 3, "type": "einkaufsliste/seen", "store": "all"})
    assert (await client.receive_json())["success"]
    assert {"all", "none", aldi} <= set(m.seen[hass_admin_user.id])
    assert m.as_dict()["seen"][hass_admin_user.id]["all"]
    # „Alle“ anschauen lässt die Blasen stehen, erst der erste Besuch („init“) setzt sie
    assert "b:" + aldi not in m.seen[hass_admin_user.id]
    await client.send_json({"id": 4, "type": "einkaufsliste/seen", "store": "b:" + aldi})
    assert (await client.receive_json())["success"]
    assert "b:" + aldi in m.seen[hass_admin_user.id]
    await client.send_json({"id": 5, "type": "einkaufsliste/seen", "store": "init"})
    assert (await client.receive_json())["success"]
    assert "b:none" in m.seen[hass_admin_user.id]

    await client.send_json({"id": 6, "type": "einkaufsliste/item/add", "name": "Eis"})
    item = (await client.receive_json())["result"]
    assert item["added_by_id"] == hass_admin_user.id


async def test_rename_keeps_barcode(hass, setup):
    m = mgr(hass)
    item = m.add_item("❓ Unbekannt", barcode="4001234567890")
    m.update_item(item["id"], name="Hafermilch")
    assert m.barcodes["4001234567890"]["name"] == "Hafermilch"


async def test_recipe_apply_only_selected(hass, setup, hass_ws_client):
    client = await hass_ws_client(hass)
    m = mgr(hass)
    recipe = m.add_recipe("Pfannkuchen", items=[{"name": "Mehl"}, {"name": "Eier"}, {"name": "Milch"}])
    await client.send_json({"id": 1, "type": "einkaufsliste/recipe/apply", "recipe_id": recipe["id"], "items": [0, 2]})
    res = await client.receive_json()
    assert res["success"] and res["result"]["added"] == 2
    assert sorted(i["name"] for i in m.items if i["recipe_id"]) == ["Mehl", "Milch"]
    await client.send_json({"id": 2, "type": "einkaufsliste/recipe/apply", "recipe_id": recipe["id"], "items": []})
    assert not (await client.receive_json())["success"]


async def test_auto_photo_from_barcode(hass, setup, hass_ws_client, aioclient_mock):
    client = await hass_ws_client(hass)
    m = mgr(hass)
    img = "https://images.openfoodfacts.org/images/products/400/front_de.400.jpg"
    aioclient_mock.get(
        "https://world.openfoodfacts.org/api/v2/product/4000000000001.json",
        json={"status": 1, "product": {"image_front_url": img}},
    )
    aioclient_mock.get(img, content=JPEG)
    await client.send_json({"id": 1, "type": "einkaufsliste/item/add", "name": "Kakao", "barcode": "4000000000001"})
    assert (await client.receive_json())["success"]
    await hass.async_block_till_done(wait_background_tasks=True)
    assert "kakao" in m.photos

    # eigenes Foto wird nie überschrieben
    own = m.photos["kakao"]["id"]
    item = next(i for i in m.items if i["name"] == "Kakao")
    await client.send_json({"id": 2, "type": "einkaufsliste/barcode/assign", "item_id": item["id"], "code": "4000000000001"})
    assert (await client.receive_json())["success"]
    await hass.async_block_till_done(wait_background_tasks=True)
    assert m.photos["kakao"]["id"] == own

    # fremde Bild-Server werden nicht geladen
    aioclient_mock.get(
        "https://world.openfoodfacts.org/api/v2/product/4000000000002.json",
        json={"status": 1, "product": {"image_front_url": "https://evil.example.com/x.jpg"}},
    )
    for base in ("openbeautyfacts", "openproductsfacts"):
        aioclient_mock.get(f"https://world.{base}.org/api/v2/product/4000000000002.json", status=404)
    await client.send_json({"id": 3, "type": "einkaufsliste/item/add", "name": "Tee", "barcode": "4000000000002"})
    assert (await client.receive_json())["success"]
    await hass.async_block_till_done(wait_background_tasks=True)
    assert "tee" not in m.photos


async def test_log(hass, setup, hass_ws_client, hass_admin_user, freezer):
    client = await hass_ws_client(hass)
    m = mgr(hass)
    aldi, netto = m.find_store("Aldi"), m.find_store("Netto")
    await client.send_json({"id": 1, "type": "einkaufsliste/item/add", "name": "Milch", "store_id": aldi, "via": "scan"})
    item = (await client.receive_json())["result"]
    await client.send_json({"id": 2, "type": "einkaufsliste/item/update", "item_id": item["id"], "quantity": "2x"})
    assert (await client.receive_json())["success"]
    await client.send_json({"id": 3, "type": "einkaufsliste/item/update", "item_id": item["id"], "store_id": netto})
    assert (await client.receive_json())["success"]
    await client.send_json({"id": 4, "type": "einkaufsliste/item/toggle", "item_id": item["id"]})
    assert (await client.receive_json())["success"]
    recipe = m.add_recipe("Kuchen", items=[{"name": "Mehl"}])
    await client.send_json({"id": 5, "type": "einkaufsliste/recipe/apply", "recipe_id": recipe["id"]})
    assert (await client.receive_json())["success"]
    m.cleanup(force=True)
    await client.send_json({"id": 6, "type": "einkaufsliste/log/get"})
    res = (await client.receive_json())["result"]
    assert res["days"] == 90
    got = [(e["a"], e["n"], e["v"]) for e in reversed(res["entries"])]
    assert got == [
        ("add", "Milch", "scan"),
        ("edit", "Milch", "card"),
        ("move", "Milch", "card"),
        ("check", "Milch", "card"),
        ("add", "Mehl", "recipe"),
        ("check", "Mehl", "cleanup"),
    ]
    entries = list(reversed(res["entries"]))
    assert entries[1]["d"] == "Menge – → 2x" and entries[2]["d"] == "Aldi → Netto"
    assert entries[0]["w"] and entries[0]["s"] == aldi

    # Aufbewahrung: alte Einträge fliegen raus
    await client.send_json({"id": 7, "type": "einkaufsliste/log/settings", "days": 7})
    assert (await client.receive_json())["success"]
    freezer.tick(timedelta(days=8))
    assert m.get_log()["entries"] == []
    await client.send_json({"id": 8, "type": "einkaufsliste/log/settings", "days": 5})
    assert not (await client.receive_json())["success"]

    m.add_item("Brot")
    await client.send_json({"id": 9, "type": "einkaufsliste/log/clear"})
    assert (await client.receive_json())["success"]
    assert m.log == []

    # Barcodes am Produkt sichtbar
    m.assign_barcode(m.items[0]["id"], "4001")
    assert m.as_dict()["barcodes_by_name"][m.items[0]["name"].lower()] == ["4001"]


async def test_move_keeps_both_stores(hass, setup, hass_ws_client):
    client = await hass_ws_client(hass)
    m = mgr(hass)
    aldi, netto = m.find_store("Aldi"), m.find_store("Netto")
    brot = m.add_item("Brot", store_id=netto, quantity="2x")
    await client.send_json({"id": 1, "type": "einkaufsliste/item/move", "item_id": brot["id"], "store_id": aldi})
    res = await client.receive_json()
    assert res["success"], res
    new = res["result"]
    assert new["store_id"] == aldi and not new["checked"] and new["quantity"] == "2x"
    assert brot["checked"] and brot["store_id"] == netto  # bleibt bei Netto unter „Erledigt“
    assert len([i for i in m.items if i["name"] == "Brot"]) == 2

    # zurück nach Netto: der alte Netto-Eintrag kommt wieder, kein dritter
    await client.send_json({"id": 2, "type": "einkaufsliste/item/move", "item_id": new["id"], "store_id": netto})
    res = (await client.receive_json())["result"]
    assert res["id"] == brot["id"] and not brot["checked"] and m.get_item(new["id"])["checked"]
    assert len([i for i in m.items if i["name"] == "Brot"]) == 2
    assert m.get_log()["entries"][0]["a"] == "move" and m.get_log()["entries"][0]["d"] == "Aldi → Netto"

    # Rezept-Zutat: verschwindet beim alten Laden
    recipe = m.add_recipe("Suppe", items=[{"name": "Lauch", "store_id": aldi}])
    m.apply_recipe(recipe["id"])
    lauch = next(i for i in m.items if i["name"] == "Lauch")
    m.move_item(lauch["id"], netto)
    assert [i["store_id"] for i in m.items if i["name"] == "Lauch"] == [netto]


async def test_photo_and_barcode_per_note(hass, setup, hass_ws_client):
    import base64

    client = await hass_ws_client(hass)
    m = mgr(hass)
    leer = m.add_item("Käse", note="Leerdammer", barcode="111")
    gouda = m.add_item("Käse", note="Gouda")
    data = base64.b64encode(JPEG).decode()
    await client.send_json({"id": 1, "type": "einkaufsliste/photo/set", "name": "Käse|Leerdammer", "data": data})
    assert (await client.receive_json())["success"]
    d = m.as_dict()
    assert "käse|leerdammer" in d["photos"] and "käse|gouda" not in d["photos"]
    assert d["barcodes_by_name"] == {"käse|leerdammer": ["111"]}
    await client.send_json({"id": 2, "type": "einkaufsliste/barcode/lookup", "code": "111"})
    res = (await client.receive_json())["result"]
    assert res["name"] == "Käse" and res["note"] == "Leerdammer"
    # Barcode für Gouda zuordnen -> getrennt
    m.assign_barcode(gouda["id"], "222")
    assert m.as_dict()["barcodes_by_name"]["käse|gouda"] == ["222"]
    # Notiz ändern: Foto + Barcode ziehen mit
    m.update_item(leer["id"], note="Maasdamer")
    d = m.as_dict()
    assert "käse|maasdamer" in d["photos"] and d["barcodes_by_name"]["käse|maasdamer"] == ["111"]
    # Gouda löschen nimmt das Leerdammer-/Maasdamer-Foto nicht mit
    m.remove_item(gouda["id"])
    await hass.async_block_till_done()
    assert "käse|maasdamer" in m.photos
    # Für wen spielt für Foto/Barcode keine Rolle: gleiche Packung
    oma = m.add_item("Käse", note="Maasdamer", for_whom="Oma")
    assert oma["id"] != leer["id"]  # aber eigene Zeile auf der Liste
    assert m.as_dict()["barcodes_by_name"]["käse|maasdamer"] == ["111"]
    m.remove_item(oma["id"])
    await hass.async_block_till_done()
    assert "käse|maasdamer" in m.photos  # der andere Maasdamer braucht das Foto noch


async def test_recipe_unapply(hass, setup, hass_ws_client):
    client = await hass_ws_client(hass)
    m = mgr(hass)
    fisch = m.add_recipe("Fisch", items=[{"name": "Lachs"}, {"name": "Zitrone"}])
    pasta = m.add_recipe("Pasta", items=[{"name": "Nudeln"}])
    m.add_item("Zitrone")  # normaler Artikel bleibt
    m.apply_recipe(fisch["id"])
    m.apply_recipe(pasta["id"])
    await client.send_json({"id": 1, "type": "einkaufsliste/recipe/unapply", "recipe_id": fisch["id"]})
    res = await client.receive_json()
    assert res["success"] and res["result"]["removed"] == 2
    assert sorted((i["name"], bool(i["recipe_id"])) for i in m.items) == [("Nudeln", True), ("Zitrone", False)]
    assert m.get_log()["entries"][0]["a"] == "remove" and m.get_log()["entries"][0]["v"] == "recipe"
