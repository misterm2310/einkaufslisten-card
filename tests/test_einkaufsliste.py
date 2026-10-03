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
    r3 = await client.receive_json(); assert r3["success"], r3

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
    assert result["options"] == {"cleanup_weekday": 5, "cleanup_time": "04:30:00", "min_age_days": 14, "sidebar": False}


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


async def test_sidebar_panel_is_an_option(hass):
    """📌 Seitenleiste: standardmäßig aus, per Option an, beim Ausschalten wieder weg."""
    from homeassistant.components import frontend

    await hass.config.async_set_time_zone(TZ)
    assert await async_setup_component(hass, "http", {})
    assert await async_setup_component(hass, "lovelace", {})
    hass.config.components.add("frontend")
    entry = MockConfigEntry(domain=DOMAIN, options={"cleanup_weekday": 6, "cleanup_time": "03:00:00", "min_age_days": 7})
    entry.add_to_hass(hass)
    with patch("custom_components.einkaufsliste.frontend.add_extra_js_url"):
        assert await hass.config_entries.async_setup(entry.entry_id)
        await hass.async_block_till_done()
        panels = lambda: hass.data.get(frontend.DATA_PANELS, {})  # noqa: E731
        assert "einkaufsliste" not in panels()  # Standard: kein Eintrag

        hass.config_entries.async_update_entry(entry, options={**entry.options, "sidebar": True})
        await hass.async_block_till_done()
        panel = panels()["einkaufsliste"]
        assert panel.sidebar_title == "Einkaufsliste" and panel.sidebar_icon == "mdi:cart"
        assert panel.require_admin is False
        assert panel.config["_panel_custom"]["module_url"].startswith("/einkaufsliste_files/einkaufsliste-panel.js")
        assert panel.config["card_url"].startswith("/einkaufsliste_files/einkaufsliste-card.js")

        hass.config_entries.async_update_entry(entry, options={**entry.options, "sidebar": False})
        await hass.async_block_till_done()
        assert "einkaufsliste" not in panels()


async def test_step_photos_move_with_steps(hass, setup, hass_ws_client):
    """↕️ Schritte verschieben/löschen: die Schritt-Fotos wandern mit, Fotos gelöschter Schritte verschwinden."""
    import base64

    m = mgr(hass)
    r = m.add_recipe("Nudeln", [{"name": "Nudeln"}], steps="Wasser kochen\nNudeln rein\nAbgießen")
    rid = r["id"]
    for n in (0, 2):
        await m.async_set_photo(f"rezept#{rid}#s{n}", base64.b64encode(JPEG).decode())
    id0 = m.photos[f"rezept#{rid}#s0".lower()]["id"]
    id2 = m.photos[f"rezept#{rid}#s2".lower()]["id"]
    client = await hass_ws_client(hass)
    # neue Reihenfolge: Abgießen(alt 2), Wasser kochen(alt 0), neuer Schritt; „Nudeln rein“ (alt 1) fliegt raus
    await client.send_json({"id": 1, "type": "einkaufsliste/recipe/update", "recipe_id": rid,
                            "steps": "Abgießen\nWasser kochen\nSoße rühren", "step_map": [2, 0, None]})
    assert (await client.receive_json())["success"]
    await hass.async_block_till_done()
    assert m.photos[f"rezept#{rid}#s0".lower()]["id"] == id2
    assert m.photos[f"rezept#{rid}#s1".lower()]["id"] == id0
    assert f"rezept#{rid}#s2".lower() not in m.photos
    # Schritt gelöscht: sein Foto geht mit
    await client.send_json({"id": 2, "type": "einkaufsliste/recipe/update", "recipe_id": rid,
                            "steps": "Wasser kochen", "step_map": [1]})
    assert (await client.receive_json())["success"]
    await hass.async_block_till_done()
    assert list(k for k in m.photos if k.startswith(f"rezept#{rid}#s".lower())) == [f"rezept#{rid}#s0".lower()]
    assert m.photos[f"rezept#{rid}#s0".lower()]["id"] == id0
    assert not m._photo_path(id2).exists()
    # ohne step_map bleibt alles beim Alten
    await client.send_json({"id": 3, "type": "einkaufsliste/recipe/update", "recipe_id": rid, "steps": "Wasser sieden"})
    assert (await client.receive_json())["success"]
    assert m.photos[f"rezept#{rid}#s0".lower()]["id"] == id0


async def test_favorites_add_all(hass, setup, hass_ws_client):
    """⭐ Favoriten markieren, Knopf setzt alle auf die Liste (nichts doppelt), Umbenennen zieht mit."""
    m = mgr(hass)
    client = await hass_ws_client(hass)
    m.add_item("Milch", quantity="2 L")
    m.add_item("Brot")
    m.add_item("Eier", quantity="10x")
    for n in m.items:  # alles erledigt – die Produkte bleiben im Gedächtnis
        m.set_checked(n["id"], True, None)
    for i, name in enumerate(["Milch", "Brot"], start=1):
        await client.send_json({"id": i, "type": "einkaufsliste/favorite/set", "name": name, "value": True})
        assert (await client.receive_json())["success"]
    await client.send_json({"id": 5, "type": "einkaufsliste/favorite/set", "name": "Gibt es nicht", "value": True})
    assert not (await client.receive_json())["success"]
    assert sorted(m.as_dict()["favorites"]) == ["brot", "milch"]
    m.add_item("Brot")  # steht schon offen drauf
    await client.send_json({"id": 6, "type": "einkaufsliste/favorites/add"})
    res = await client.receive_json()
    assert res["success"] and res["result"]["added"] == ["Milch"] and res["result"]["skipped"] == 1
    open_ = {i["name"]: i for i in m.items if not i["checked"]}
    assert set(open_) == {"Milch", "Brot"} and open_["Milch"]["quantity"] == "2 L"  # Menge wie zuletzt
    # zweimal drücken: nichts doppelt
    await client.send_json({"id": 7, "type": "einkaufsliste/favorites/add"})
    res = await client.receive_json()
    assert res["result"]["added"] == [] and res["result"]["skipped"] == 2
    # Umbenennen im Katalog: der Favorit zieht mit
    m.update_product("milch", name="H-Milch")
    assert "h-milch" in m.as_dict()["favorites"] and "milch" not in m.as_dict()["favorites"]
    # loslassen
    await client.send_json({"id": 8, "type": "einkaufsliste/favorite/set", "name": "H-Milch", "value": False})
    assert (await client.receive_json())["success"]
    assert "h-milch" not in m.as_dict()["favorites"]


async def test_loyalty_cards(hass, setup, hass_ws_client, hass_admin_user):
    """💳 Kundenkarten: Schalter standardmäßig aus; „für alle“ oder nur für mich; Codes nie in der großen Antwort."""
    m = mgr(hass)
    client = await hass_ws_client(hass)
    assert m.as_dict()["settings"]["cards_on"] is False
    await client.send_json({"id": 1, "type": "einkaufsliste/cards/enable", "on": True})
    assert (await client.receive_json())["success"] and m.as_dict()["settings"]["cards_on"] is True
    await client.send_json({"id": 2, "type": "einkaufsliste/card/add", "name": "Payback", "code": "1234567890123", "fmt": "ean13", "shared": True})
    res = await client.receive_json()
    assert res["success"] and res["result"]["shared"] is True
    shared_id = res["result"]["id"]
    await client.send_json({"id": 3, "type": "einkaufsliste/card/add", "name": "dm", "code": "https://x.example/abc", "fmt": "qr", "shared": False, "color": "#ff0000"})
    res = await client.receive_json()
    assert res["success"] and res["result"]["shared"] is False
    mine_id = res["result"]["id"]
    # gleicher Name nochmal: Fehler; leerer Code: Fehler
    await client.send_json({"id": 4, "type": "einkaufsliste/card/add", "name": "payback", "code": "1", "shared": True})
    assert not (await client.receive_json())["success"]
    await client.send_json({"id": 5, "type": "einkaufsliste/card/add", "name": "Rewe", "code": "  ", "shared": True})
    assert not (await client.receive_json())["success"]
    await client.send_json({"id": 6, "type": "einkaufsliste/cards/list"})
    res = await client.receive_json()
    assert [c["name"] for c in res["result"]] == ["dm", "Payback"]  # erst eigene, dann „für alle“
    # die große Daten-Antwort enthält KEINE Codes
    assert "1234567890123" not in str(m.as_dict()) and "x.example" not in str(m.as_dict())
    # ein anderer Benutzer sieht nur die geteilten
    assert [c["name"] for c in m.cards_for("anderer-benutzer")] == ["Payback"]
    with pytest.raises(ValueError):
        m.update_card(mine_id, "anderer-benutzer", name="Hack")
    with pytest.raises(ValueError):
        m.remove_card(mine_id, "anderer-benutzer")
    # ändern + löschen
    await client.send_json({"id": 7, "type": "einkaufsliste/card/update", "card_id": shared_id, "code": "999"})
    assert (await client.receive_json())["result"]["code"] == "999"
    await client.send_json({"id": 8, "type": "einkaufsliste/card/remove", "card_id": mine_id})
    assert (await client.receive_json())["success"]
    assert [c["name"] for c in m.cards_for(hass_admin_user.id)] == ["Payback"]


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
    assert m.add_item("h-milch")["name"] == "H-Milch"
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
    assert res["found"] and res["name"] == "Pizza Salami" and res["note"] == "Wagner" and res["source"] == "Open Food Facts"
    assert res["category_id"] == m.find_category("TK-Ware")

    await client.send_json({"id": 2, "type": "einkaufsliste/barcode/lookup", "code": "4005900000000"})
    res = (await client.receive_json())["result"]
    assert res["name"] == "Duschgel" and res["note"] == "Nivea" and res["category_id"] == m.find_category("Drogerie")

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

    # fresh = die Datenbank selbst fragen, auch wenn der Barcode schon gemerkt ist
    aioclient_mock.get(
        "https://world.openfoodfacts.org/api/v2/product/4008400402222.json",
        json={"status": 1, "product": {"product_name_de": "Pizza Salami", "brands": "Wagner"}},
    )
    for base in ("openbeautyfacts", "openproductsfacts"):
        aioclient_mock.get(f"https://world.{base}.org/api/v2/product/4008400402222.json", status=404)
    await client.send_json({"id": 7, "type": "einkaufsliste/item/add", "name": "Meine Pizza",
                            "store_id": aldi, "barcode": "4008400402222"})
    assert (await client.receive_json())["success"]
    await client.send_json({"id": 8, "type": "einkaufsliste/barcode/lookup", "code": "4008400402222"})
    assert (await client.receive_json())["result"]["source"] == "gemerkt"
    await client.send_json({"id": 9, "type": "einkaufsliste/barcode/lookup", "code": "4008400402222", "fresh": True})
    res = (await client.receive_json())["result"]
    assert res["found"] and res["source"] == "Open Food Facts" and res["name"] == "Pizza Salami"

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
    assert sorted(i["name"] for i in m.items if i["recipe_id"]) == ["Eier", "Milch"]  # A–Z: Eier, Mehl, Milch
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


async def test_recipe_barcode_and_guess(hass, setup, hass_ws_client):
    client = await hass_ws_client(hass)
    m = mgr(hass)
    await client.send_json({"id": 1, "type": "einkaufsliste/recipe/add", "name": "Pizza-Abend",
                            "items": [{"name": "Pizza Salami", "barcode": "4008400402222"}, {"name": "Joghurt"}]})
    res = await client.receive_json()
    assert res["success"], res
    assert "barcode" not in res["result"]["items"][0]
    assert m.barcodes["4008400402222"]["name"] == "Pizza Salami"
    m.apply_recipe(res["result"]["id"])
    cats = {i["name"]: i["category_id"] for i in m.items}
    assert cats["Pizza Salami"] == m.find_category("TK-Ware")
    assert cats["Joghurt"] == m.find_category("Kühlregal & Milch")


def test_parse_ingredient_lines():
    from custom_components.einkaufsliste.recipe_import import parse_html, parse_text

    items = parse_text("""Zutaten für 4 Portionen:
- 200 g Mehl (Type 405)
• 3 Eier
½ l Milch
1 Prise Salz
Zwiebel, fein gehackt
2 EL Zucker
Zubereitung:""")
    assert [(i["name"], i["quantity"], i["note"]) for i in items] == [
        ("Mehl", "200 g", "Type 405"),
        ("Eier", "3x", None),
        ("Milch", "0,5 L", None),
        ("Salz", "1 Prise", None),
        ("Zwiebel", None, "Fein gehackt"),
        ("Zucker", "2 EL", None),
    ]
    assert [i["name"] for i in parse_text("Milch, Eier, 2 Butter")] == ["Milch", "Eier", "Butter"]
    page = """<html><script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"WebPage"},
      {"@type":"Recipe","name":"Pfannkuchen","image":["https://img.example.com/p.jpg"],
       "recipeIngredient":["250 g Mehl","3 Eier","500 ml Milch"]}]}</script></html>"""
    info = parse_html(page)
    assert info["name"] == "Pfannkuchen" and info["image_url"] == "https://img.example.com/p.jpg"
    assert [i["name"] for i in info["items"]] == ["Mehl", "Eier", "Milch"]


async def test_recipe_import_ws(hass, setup, hass_ws_client, aioclient_mock, monkeypatch):
    from custom_components.einkaufsliste import recipe_import
    monkeypatch.setattr(recipe_import, "_resolve", lambda host, port: ["93.184.216.34"])  # echte Internet-IP
    client = await hass_ws_client(hass)
    m = mgr(hass)
    page = """<script type="application/ld+json">{"@type":"Recipe","name":"Pizza","image":"https://img.example.com/pizza.jpg",
      "recipeIngredient":["1 Pizza Salami","200 g Mozzarella"]}</script>"""
    aioclient_mock.get("https://rezepte.example.com/pizza", text=page)
    aioclient_mock.get("https://img.example.com/pizza.jpg", content=JPEG)
    await client.send_json({"id": 1, "type": "einkaufsliste/recipe/import", "text": "https://rezepte.example.com/pizza"})
    res = await client.receive_json()
    assert res["success"], res
    r = res["result"]
    assert r["name"] == "Pizza" and r["source"] == "link" and r["image"].startswith("data:image/jpeg;base64,")
    assert r["items"][0]["name"] == "Pizza Salami" and r["items"][0]["category_id"] == m.find_category("TK-Ware")
    await client.send_json({"id": 2, "type": "einkaufsliste/recipe/import", "text": "http://192.168.1.10/x"})
    assert not (await client.receive_json())["success"]
    await client.send_json({"id": 3, "type": "einkaufsliste/recipe/import", "text": "3 Eier\n1 l Milch"})
    res = (await client.receive_json())["result"]
    assert [i["name"] for i in res["items"]] == ["Eier", "Milch"] and res["image"] is None

    # Rezept-Foto verschwindet mit dem Rezept
    import base64
    recipe = m.add_recipe("Pizza", items=[{"name": "Teig"}])
    key = f"rezept#{recipe['id']}".lower()
    await m.async_set_photo(key, base64.b64encode(JPEG).decode())
    assert key in m.photos
    m.remove_recipe(recipe["id"])
    await hass.async_block_till_done()
    assert key not in m.photos


async def test_note_capitalized(hass, setup):
    m = mgr(hass)
    item = m.add_item("Käse", note="gouda")
    assert item["note"] == "Gouda"
    m.update_item(item["id"], note="leerdammer")
    assert item["note"] == "Leerdammer"
    r = m.add_recipe("Toast", items=[{"name": "Käse", "note": "scheiben"}])
    assert r["items"][0]["note"] == "Scheiben"


async def test_person_colors(hass, setup, hass_ws_client):
    client = await hass_ws_client(hass)
    m = mgr(hass)
    a = m.add_group("persons", "Oma")
    b = m.add_group("persons", "Opa")
    assert a["color"].startswith("#") and a["color"] != b["color"]
    await client.send_json({"id": 1, "type": "einkaufsliste/group/update", "kind": "persons", "group_id": a["id"], "color": "#123456"})
    assert (await client.receive_json())["success"]
    assert m.persons[0]["color"] == "#123456"


async def test_quantity_in_name_and_units(hass, setup):
    m = mgr(hass)
    a = m.add_item("3 milch")
    assert a["name"] == "Milch" and a["quantity"] == "3x"
    b = m.add_item("Mehl 500gr")
    assert b["name"] == "Mehl" and b["quantity"] == "500 g"
    c = m.add_item("Cola", quantity="1,5 liter")
    assert c["quantity"] == "1,5 L"
    d = m.add_item("Xbox 360")
    assert d["name"] == "Xbox 360" and d["quantity"] is None
    m.update_item(a["id"], quantity="2 stk")
    assert a["quantity"] == "2x"
    r = m.add_recipe("Kuchen", items=[{"name": "250g Butter"}, {"name": "Salz", "basic": True}], steps="Teig rühren\n\n Backen  ")
    assert r["items"][0]["name"] == "Butter" and r["items"][0]["quantity"] == "250 g"
    assert r["items"][1]["basic"] is True and r["steps"] == "Teig rühren\nBacken"
    assert m.as_dict()["version"]


def test_quantity_rules():
    """🔢 Alles gleich geschrieben: Einheiten, Kommazahlen statt Brüche, Bereiche, Einzahl/Mehrzahl."""
    from custom_components.einkaufsliste.quantity import norm_qty, split_qty

    cases = {
        "3el": "3 EL", "3 el": "3 EL", "3 El.": "3 EL", "1": "1x", "3 stk": "3x", "500gr": "500 g",
        "1/2 tl": "0,5 TL", "½ TL": "0,5 TL", "1½ L": "1,5 L", "1 1/2 l": "1,5 L", "¼ l": "0,25 L",
        "1/3 tasse": "0,33 Tassen", "2/3 L": "0,67 L", "1.5 l": "1,5 L", "1.000 g": "1000 g",
        "2-3 el": "2-3 EL", "2 - 3 EL": "2-3 EL", "2 bis 3 el": "2-3 EL", "2–3": "2-3x", "1½-2 l": "1,5-2 L",
        "1 zehen": "1 Zehe", "2 zehe": "2 Zehen", "2 tasse": "2 Tassen", "1 Tassen": "1 Tasse",
        "2 kopf": "2 Köpfe", "2 blätter": "2 Blatt", "2 schluck": "2 Schluck", "1 messerspitze": "1 Msp.",
        "2 dose": "2 Dosen", "1 dosen": "1 Dose", "2 zweig": "2 Zweige", "1 würfel": "1 Würfel",
        "etwas": "etwas", "nach Geschmack": "nach Geschmack",
    }
    assert {q: norm_qty(q) for q in cases} == cases
    assert split_qty("1 kopf salat") == ("salat", "1 Kopf")
    assert split_qty("3 blatt gelatine") == ("gelatine", "3 Blatt")
    assert split_qty("½ tl salz") == ("salz", "0,5 TL")
    assert split_qty("Xbox 360") == ("Xbox 360", None)


async def test_old_quantities_tidied_on_load(hass, hass_storage):
    """Schon gespeicherte Mengen werden beim Start einmal aufgeräumt und dauerhaft gespeichert."""
    await hass.config.async_set_time_zone(TZ)
    now = dt_util.utcnow().isoformat()
    hass_storage["einkaufsliste.data"] = {
        "version": 1,
        "key": "einkaufsliste.data",
        "data": {
            "stores": [], "categories": [], "history": {}, "last_cleanup": now, "persons": [], "recipe_groups": [],
            "items": [{"id": "a", "name": "Milch", "store_id": None, "category_id": None, "quantity": "1",
                       "note": None, "checked": False, "added_by": None, "added_at": now,
                       "checked_by": None, "checked_at": None}],
            "recipes": [{"id": "r", "name": "Kuchen", "icon": None, "items": [
                {"name": "Zucker", "quantity": "3el", "note": None, "for_whom": None, "store_id": None, "category_id": None},
                {"name": "Salz", "quantity": "1/2 tl", "note": None, "for_whom": None, "store_id": None, "category_id": None},
            ]}],
        },
    }
    assert await async_setup_component(hass, "http", {})
    hass.config.components.update({"frontend", "lovelace"})
    entry = MockConfigEntry(domain=DOMAIN, options={"cleanup_weekday": 6, "cleanup_time": "03:00:00", "min_age_days": 7})
    entry.add_to_hass(hass)
    with patch("custom_components.einkaufsliste.frontend.add_extra_js_url"):
        assert await hass.config_entries.async_setup(entry.entry_id)
    m = mgr(hass)
    assert m.items[0]["quantity"] == "1x"
    assert [i["quantity"] for i in m.recipes[0]["items"]] == ["0,5 TL", "3 EL"]  # Salz, Zucker (A–Z)
    async_fire_time_changed(hass, dt_util.utcnow() + timedelta(minutes=5))
    await hass.async_block_till_done()
    saved = hass_storage["einkaufsliste.data"]["data"]
    assert saved["items"][0]["quantity"] == "1x"
    assert sorted(i["quantity"] for i in saved["recipes"][0]["items"]) == ["0,5 TL", "3 EL"]


async def test_multiple_photos_and_catalog(hass, setup, hass_ws_client):
    import base64

    client = await hass_ws_client(hass)
    m = mgr(hass)
    item = m.add_item("Käse", note="Gouda", barcode="123")
    data = base64.b64encode(JPEG).decode()
    for n, add in ((1, False), (2, True), (3, True)):
        await client.send_json({"id": n, "type": "einkaufsliste/photo/set", "name": "käse|gouda", "data": data, "add": add})
        assert (await client.receive_json())["success"]
    assert m.as_dict()["photo_counts"]["käse|gouda"] == 3
    await client.send_json({"id": 4, "type": "einkaufsliste/photo/get", "name": "käse|gouda", "index": 2})
    assert (await client.receive_json())["result"]["data"].startswith("data:image/jpeg")
    await client.send_json({"id": 5, "type": "einkaufsliste/photo/remove", "name": "käse|gouda", "index": 0})
    assert (await client.receive_json())["success"]
    assert m.as_dict()["photo_counts"]["käse|gouda"] == 2

    await client.send_json({"id": 6, "type": "einkaufsliste/products"})
    prods = (await client.receive_json())["result"]
    gouda = next(p for p in prods if p["key"] == "käse|gouda")
    assert gouda["barcodes"] == ["123"] and gouda["photos"] == 2 and gouda["open"] == 1
    tk = m.find_category("TK-Ware")
    await client.send_json({"id": 7, "type": "einkaufsliste/product/update", "key": "käse|gouda", "note": "Alter Gouda", "category_id": tk})
    res = await client.receive_json()
    assert res["success"], res
    assert item["note"] == "Alter Gouda" and item["category_id"] == tk
    assert "käse|alter gouda" in m.photos and m.barcodes["123"]["note"] == "Alter Gouda"
    await client.send_json({"id": 8, "type": "einkaufsliste/product/remove", "key": "käse|alter gouda"})
    res = await client.receive_json()
    assert res["success"] and res["result"] == {"removed": 1, "recipes": []}, res
    await hass.async_block_till_done()
    assert "käse|alter gouda" not in m.photos and "123" not in m.barcodes
    assert item not in m.items  # 🗑️ ganz löschen: auch von der Einkaufsliste


def test_steps_from_schema():
    from custom_components.einkaufsliste.recipe_import import parse_html

    page = """<script type="application/ld+json">{"@type":"Recipe","name":"X","recipeIngredient":["1 Ei"],
      "recipeInstructions":[{"@type":"HowToStep","text":"Ei kochen."},{"@type":"HowToSection","itemListElement":[{"@type":"HowToStep","text":"Schälen."}]}]}</script>"""
    assert parse_html(page)["steps"] == "Ei kochen.\nSchälen."


async def test_recipe_heat(hass, setup, hass_ws_client):
    client = await hass_ws_client(hass)
    m = mgr(hass)
    await client.send_json({"id": 1, "type": "einkaufsliste/recipe/add", "name": "Pizza",
                            "heat": [{"device": "Backofen", "mode": "Ober-/Unterhitze", "temp": 220, "minutes": "12", "preheat": True},
                                     {"device": "Heißluftfritteuse", "temp": None, "minutes": None}]})
    res = await client.receive_json()
    assert res["success"], res
    heat = res["result"]["heat"]
    assert heat == [{"device": "Backofen", "mode": "Ober-/Unterhitze", "temp": 220, "minutes": 12, "minutes_to": None, "preheat": True, "note": None}]
    r2 = m.add_recipe("Pommes", heat=[{"device": "Heißluftfritteuse", "minutes": 15, "minutes_to": 20}, {"minutes": 10, "minutes_to": 5}])
    assert r2["heat"][0]["minutes_to"] == 20 and r2["heat"][1]["minutes_to"] is None
    rid = res["result"]["id"]
    await client.send_json({"id": 2, "type": "einkaufsliste/recipe/update", "recipe_id": rid, "heat": []})
    assert (await client.receive_json())["success"]
    assert m.recipe_by_id(rid)["heat"] == []


async def test_recipe_items_sorted_abc(hass, setup):
    """🔤 Rezept-Zutaten stehen immer A–Z (Ä wie A, groß/klein egal)."""
    m = mgr(hass)
    r = m.add_recipe("Auflauf", [{"name": "zwiebel"}, {"name": "Äpfel"}, {"name": "Käse", "note": "Gouda"}, {"name": "Käse", "note": "Emmentaler"}, {"name": "Butter"}])
    assert [(i["name"], i["note"]) for i in r["items"]] == [
        ("Äpfel", None), ("Butter", None), ("Käse", "Emmentaler"), ("Käse", "Gouda"), ("Zwiebel", None)]
    m.update_recipe(r["id"], items=[{"name": "Salz"}, {"name": "Mehl"}])
    assert [i["name"] for i in r["items"]] == ["Mehl", "Salz"]


async def test_recipe_multiple_photos(hass, setup):
    """📷 Rezepte können mehrere Fotos haben – und beim Löschen gehen alle mit."""
    import base64

    m = mgr(hass)
    r = m.add_recipe("Kuchen", [{"name": "Mehl"}])
    key = f"rezept#{r['id']}"
    data = base64.b64encode(JPEG).decode()
    await m.async_set_photo(key, data)
    await m.async_set_photo(key, data, add=True)
    await m.async_set_photo(key, data, add=True)
    assert m.as_dict()["photo_counts"][key] == 3
    await m.async_remove_photo(key, 1)
    assert m.as_dict()["photo_counts"][key] == 2
    m.remove_recipe(r["id"])
    await hass.async_block_till_done()
    assert key not in m.photos


async def test_recipe_servings_and_overrides(hass, setup, hass_ws_client):
    """👥 Rezept für x Personen; beim Draufsetzen angepasste Menge und gewähltes Geschäft."""
    client = await hass_ws_client(hass)
    m = mgr(hass)
    aldi = m.add_group("stores", "Testmarkt")
    await client.send_json({"id": 1, "type": "einkaufsliste/recipe/add", "name": "Nudeln", "servings": 4,
                            "items": [{"name": "Nudeln", "quantity": "500 g"}, {"name": "Tomaten", "quantity": "2x"}]})
    res = await client.receive_json()
    assert res["success"] and res["result"]["servings"] == 4
    rid = res["result"]["id"]
    await client.send_json({"id": 2, "type": "einkaufsliste/recipe/apply", "recipe_id": rid, "items": [0, 1],
                            "overrides": {"0": {"quantity": "750 g", "store_id": aldi["id"]}, "1": {"quantity": "3x", "store_id": ""}}})
    res = await client.receive_json()
    assert res["success"], res
    got = {i["name"]: i for i in m.items if i["recipe_id"] == rid}
    assert got["Nudeln"]["quantity"] == "750 g" and got["Nudeln"]["store_id"] == aldi["id"]
    assert got["Tomaten"]["quantity"] == "3x" and got["Tomaten"]["store_id"] is None
    await client.send_json({"id": 3, "type": "einkaufsliste/recipe/update", "recipe_id": rid, "servings": None})
    assert (await client.receive_json())["result"]["servings"] is None
    assert m.recipe_by_id(rid)["servings_unit"] == "persons"
    await client.send_json({"id": 4, "type": "einkaufsliste/recipe/update", "recipe_id": rid, "servings": 1, "servings_unit": "trays"})
    res = (await client.receive_json())["result"]
    assert res["servings"] == 1 and res["servings_unit"] == "trays"


async def test_recipe_groups(hass, setup, hass_ws_client):
    """🏷️ Rezept-Gruppen: Start-Liste, eigene Gruppe mit Icon, Löschen nimmt die Gruppe aus den Rezepten."""
    client = await hass_ws_client(hass)
    m = mgr(hass)
    names = [g["name"] for g in m.as_dict()["recipe_groups"]]
    assert names[:3] == ["Fisch", "Fleisch", "Geflügel"] and "Gebäck" in names
    fisch = m.recipe_groups[0]
    assert fisch["icon"] == "mdi:fish"
    await client.send_json({"id": 1, "type": "einkaufsliste/group/add", "kind": "recipe_groups", "name": "grillen", "icon": "grill"})
    grill = (await client.receive_json())["result"]
    assert grill["name"] == "Grillen" and grill["icon"] == "mdi:grill"
    r = m.add_recipe("Würstchen", [{"name": "Bratwurst"}], group=grill["id"])
    assert r["group"] == grill["id"]
    m.update_recipe(r["id"], group="gibtsnicht")
    assert r["group"] is None
    m.update_recipe(r["id"], group=grill["id"])
    await client.send_json({"id": 2, "type": "einkaufsliste/group/remove", "kind": "recipe_groups", "group_id": grill["id"]})
    assert (await client.receive_json())["success"]
    assert r["group"] is None and m.recipe_by_id(r["id"]) is not None


async def test_photo_order_and_main(hass, setup, hass_ws_client):
    """↔️ Foto-Reihenfolge ändern, ⭐ Hauptfoto festlegen."""
    import base64

    client = await hass_ws_client(hass)
    m = mgr(hass)
    data = base64.b64encode(JPEG).decode()
    for _ in range(3):
        await m.async_set_photo("Käse|gouda", data, add=True)
    ids = m._photo_ids(m.photos["käse|gouda"])
    await client.send_json({"id": 1, "type": "einkaufsliste/photo/move", "name": "Käse|Gouda", "index": 2, "to": 0})
    assert (await client.receive_json())["success"]
    assert m._photo_ids(m.photos["käse|gouda"]) == [ids[2], ids[0], ids[1]]
    await client.send_json({"id": 2, "type": "einkaufsliste/photo/move", "name": "Käse|Gouda", "index": 0, "to": 1})
    assert (await client.receive_json())["success"]
    assert m._photo_ids(m.photos["käse|gouda"]) == [ids[0], ids[2], ids[1]]


async def test_check_and_repair(hass, setup, hass_ws_client):
    """✅ Alles ok?: jeder Fund einzeln, mit Erklärung; repariert wird nur, was ausgewählt ist – wie gewählt."""
    import base64

    client = await hass_ws_client(hass)
    m = mgr(hass)
    await m.async_check(fix=True)  # Reste anderer Tests im gemeinsamen Foto-Ordner wegräumen
    await client.send_json({"id": 1, "type": "einkaufsliste/check"})
    res = (await client.receive_json())["result"]
    assert res["count"] == 0, res["problems"]
    netto, aldi = m.stores[0]["id"], m.stores[1]["id"]
    milk = m.add_item("Milch", store_id=aldi, category_id=None)  # ausdrücklich ohne Kategorie
    milk["store_id"] = "weg"  # Geschäft gelöscht
    r = m.add_recipe("Kuchen", [{"name": "Mehl"}], group="fisch")
    r["group"] = "weg"
    await m.async_set_photo("Brot", base64.b64encode(JPEG).decode())
    m._photo_path(m.photos["brot"]["id"]).unlink()
    await m.async_set_photo("rezept#gibtsnicht", base64.b64encode(JPEG).decode())
    await client.send_json({"id": 2, "type": "einkaufsliste/check"})
    res = (await client.receive_json())["result"]
    ids = {e["id"]: e for e in res["items"]}
    assert res["fixed"] == 0
    # Jeder Fund sagt genau, was los ist und wie repariert wird
    assert set(ids) >= {"photo_missing:brot", "photo_recipe:rezept#gibtsnicht", f"rgroup:{r['id']}",
                        f"nostore:{milk['id']}", "nocat:mehl", "nocat:milch"}, list(ids)
    assert all(e["text"] and e["how"] for e in res["items"])
    ns = ids[f"nostore:{milk['id']}"]
    assert "Milch" in ns["text"] and ns["default"] == aldi  # Vorschlag: wie zuletzt
    assert {o["value"] for o in ns["options"]} == {s["id"] for s in m.stores} | {"__delete__"}
    assert ids["nocat:mehl"]["default"] == m.find_category("Vorrat & Konserven")

    # Nur zwei Sachen reparieren, und zwar mit eigener Wahl
    await client.send_json({"id": 3, "type": "einkaufsliste/check", "fixes": {
        f"nostore:{milk['id']}": netto,               # nicht der Vorschlag Aldi, sondern Netto
        "nocat:mehl": m.find_category("Backwaren"),     # andere Kategorie als vorgeschlagen
    }})
    res = (await client.receive_json())["result"]
    assert res["fixed"] == 2
    assert milk["store_id"] == netto
    assert r["items"][0]["category_id"] == m.find_category("Backwaren")
    assert r["group"] == "weg" and "brot" in m.photos  # nicht ausgewählt -> unverändert

    # Der Rest mit den Vorschlägen
    await client.send_json({"id": 4, "type": "einkaufsliste/check", "fix": True})
    res = (await client.receive_json())["result"]
    assert res["fixed"] >= 3
    assert "brot" not in m.photos and "rezept#gibtsnicht" not in m.photos
    assert milk["category_id"] == m.find_category("Kühlregal & Milch")
    # Gruppe hat keinen Vorschlag -> bleibt, bis man selbst wählt
    await client.send_json({"id": 5, "type": "einkaufsliste/check"})
    res = (await client.receive_json())["result"]
    assert [e["id"] for e in res["items"]] == [f"rgroup:{r['id']}"], res["problems"]
    await client.send_json({"id": 6, "type": "einkaufsliste/check", "fixes": {f"rgroup:{r['id']}": ""}})
    assert (await client.receive_json())["result"]["fixed"] == 1
    assert r["group"] is None
    await client.send_json({"id": 7, "type": "einkaufsliste/check"})
    assert (await client.receive_json())["result"]["count"] == 0


def _prod(m, name, note=None):
    key = f"{name}|{note}".lower() if note else name.lower()
    return next(p for p in m.products() if p["key"] == key)


async def test_products_fallback_priority(hass, setup):
    """Katalog: Kategorie/Geschäft kommen aus Gedächtnis > Liste > Rezept, in dieser Reihenfolge."""
    m = mgr(hass)
    netto, aldi, lidl = m.stores[0]["id"], m.stores[1]["id"], m.stores[2]["id"]
    backwaren = m.find_category("Backwaren")
    tk = m.find_category("TK-Ware")

    # Nur im Rezept bekannt -> Katalog übernimmt das aus dem Rezept.
    m.add_recipe("Kuchen", [{"name": "Mehl", "store_id": lidl, "category_id": backwaren}])
    p = _prod(m, "Mehl")
    assert p["store_id"] == lidl and p["category_id"] == backwaren

    # Ein Artikel auf der Liste hat Vorrang vor dem Rezept.
    item = m.add_item("Mehl", store_id=aldi, category_id=None)
    item["category_id"] = None  # kein Kategorie am Artikel -> Rezept darf hier noch einspringen
    p = _prod(m, "Mehl")
    assert p["store_id"] == aldi  # vom Artikel, nicht vom Rezept
    assert p["category_id"] == backwaren  # kein Artikel-Wert da -> Rezept als Fallback

    # Das Gedächtnis (Verlauf) hat die höchste Priorität von allen.
    m.history["mehl"] = {"name": "Mehl", "count": 3, "store_id": netto, "category_id": tk, "last_used": "x"}
    p = _prod(m, "Mehl")
    assert p["store_id"] == netto and p["category_id"] == tk


async def test_update_product_store_propagation(hass, setup):
    """Katalog hat Vorrang: Geschäft-Änderung zieht Rezepte und abgehakte Artikel mit, offene bleiben stehen."""
    m = mgr(hass)
    netto, aldi = m.stores[0]["id"], m.stores[1]["id"]
    r = m.add_recipe("Kuchen", [{"name": "Zucker", "store_id": netto}])

    offen = m.add_item("Zucker", store_id=netto)
    abgehakt = m.add_item("Zucker", store_id=netto, for_whom="Max")
    abgehakt["checked"] = True

    m.update_product("zucker", store_id=aldi)

    assert r["items"][0]["store_id"] == aldi  # Rezept zieht immer mit
    assert offen["store_id"] == netto  # offen bleibt stehen, damit nichts "springt"
    assert abgehakt["store_id"] == aldi  # abgehakt zieht mit, ist ja schon gekauft


async def test_update_product_store_propagation_merges_duplicate(hass, setup):
    """Zieht ein abgehakter Artikel beim Geschäftswechsel in einen bereits vorhandenen Zwilling, gibt's kein Duplikat."""
    m = mgr(hass)
    netto, aldi = m.stores[0]["id"], m.stores[1]["id"]

    abgehakt = m.add_item("Zucker", store_id=netto)
    abgehakt["checked"] = True
    zwilling = m.add_item("Zucker", store_id=aldi)

    m.update_product("zucker", store_id=aldi)

    zucker_items = [i for i in m.items if i["name"] == "Zucker"]
    assert len(zucker_items) == 1
    assert zucker_items[0]["id"] == zwilling["id"]


async def test_unit_learned_and_catalog(hass, setup, hass_ws_client):
    """📏 Einheit pro Produkt: wird beim direkten Eintragen gemerkt, im Katalog fest einstellbar."""
    from custom_components.einkaufsliste.quantity import apply_unit, is_bare, split_qty_ex, unit_of

    assert unit_of("2 Dosen") == "Dose" and unit_of("3x") == "x" and unit_of("etwas") is None
    assert is_bare("2") and is_bare("1,5") and not is_bare("2x") and not is_bare("2 L")
    assert apply_unit("2x", "Pck.") == "2 Pck." and apply_unit("1 Dose", "x") == "1x" and apply_unit("2", "Dose") == "2 Dosen"
    assert split_qty_ex("2 backpulver") == ("backpulver", "2x", True)
    assert split_qty_ex("2x backpulver") == ("backpulver", "2x", False)

    client = await hass_ws_client(hass)
    m = mgr(hass)
    netto = m.stores[0]["id"]
    # Einmal mit Pck. eingetragen -> gemerkt; beim nächsten Mal reicht die Zahl
    m.add_item("Backpulver", quantity="1 pck", store_id=netto)
    assert m.history_for("Backpulver")["unit"] == "Pck."
    assert m.add_item("2 backpulver", store_id=netto, for_whom="Oma")["quantity"] == "2 Pck."
    assert m.add_item("Backpulver", quantity="3", store_id=netto, for_whom="Opa")["quantity"] == "3 Pck."
    # „2x“ ausdrücklich getippt bleibt x (und wird als neue Einheit gemerkt)
    assert m.add_item("Backpulver", quantity="2x", store_id=netto, for_whom="Tante")["quantity"] == "2x"
    assert m.history_for("Backpulver")["unit"] == "x"
    # Unbekanntes Produkt: nur Zahl -> x
    assert m.add_item("Wasser", quantity="3")["quantity"] == "3x"

    # Aus dem Rezept wird nichts gelernt (Rezepte haben eigene Einheiten)
    r = m.add_recipe("Pudding", [{"name": "Milch", "quantity": "200 ml"}])
    m.apply_recipe(r["id"])
    assert (m.history_for("Milch") or {}).get("unit") is None
    assert m.add_item("Milch", quantity="2")["quantity"] == "2x"

    # Im Katalog fest einstellen -> wird nicht mehr überschrieben
    await client.send_json({"id": 1, "type": "einkaufsliste/product/update", "key": "wasser", "unit": "Flasche"})
    res = await client.receive_json()
    assert res["success"], res
    assert res["result"]["unit"] == "Flasche" and res["result"]["unit_fixed"] is True
    m.add_item("Wasser", quantity="1 L", for_whom="Oma")
    assert m.history_for("Wasser")["unit"] == "Flasche"
    assert m.add_item("Wasser", quantity="2", for_whom="Opa")["quantity"] == "2 Flaschen"
    # Katalog ohne Einheit speichern lässt die Einheit in Ruhe
    m.update_product("wasser", note="Still")
    assert m.history_for("Wasser")["unit"] == "Flasche"
    # „automatisch“ -> wieder lernen
    await client.send_json({"id": 2, "type": "einkaufsliste/product/update", "key": "wasser|still", "unit": None})
    assert (await client.receive_json())["success"]
    assert "unit" not in m.history_for("Wasser") and "unit_fixed" not in m.history_for("Wasser")
    with pytest.raises(ValueError):
        m.update_product("backpulver", unit="Eimer")


async def test_last_quantity_remembered(hass, setup):
    """🔁 Letzte selbst eingetragene Menge wird gemerkt (nicht die aus Rezepten)."""
    m = mgr(hass)
    m.add_item("Milch", quantity="1 L")
    assert m.history_for("Milch")["qty"] == "1 L"
    r = m.add_recipe("Pudding", [{"name": "Milch", "quantity": "500 ml"}])
    m.apply_recipe(r["id"])
    assert m.history_for("Milch")["qty"] == "1 L" and m.history_for("Milch")["unit"] == "L"



async def test_delete_product_and_barcode(hass, setup, hass_ws_client):
    """🗑️ Produkt ganz löschen (Liste + Fotos + Barcodes, Rezepte bleiben mit Hinweis); ▥ Barcode einzeln löschen."""
    import base64

    client = await hass_ws_client(hass)
    m = mgr(hass)
    a = m.add_item("Gewürze", note="Paprika", barcode="111")
    a["checked"] = True
    m.add_item("Gewürze", note="Paprika", for_whom="Oma")
    other = m.add_item("Gewürze", note="Kümmel")
    r = m.add_recipe("Gulasch", [{"name": "Gewürze", "note": "Paprika"}])
    m.learn_barcode("222", "Gewürze", None, None, "Paprika")
    await m.async_set_photo("gewürze|paprika", base64.b64encode(JPEG).decode())

    # Barcode einzeln löschen – Produkt bleibt
    await client.send_json({"id": 1, "type": "einkaufsliste/barcode/remove", "code": "222"})
    assert (await client.receive_json())["success"]
    assert "222" not in m.barcodes and "111" in m.barcodes and "gewürze|paprika" in m.photos

    # Ganz löschen
    res = await m.async_delete_product("gewürze|paprika")
    assert res == {"removed": 2, "recipes": ["Gulasch"]}
    assert [i["note"] for i in m.items if i["name"] == "Gewürze"] == ["Kümmel"] and other in m.items
    assert "111" not in m.barcodes and "gewürze|paprika" not in m.photos
    assert r["items"][0]["note"] == "Paprika"  # Rezept bleibt unverändert


async def test_check_offers_delete(hass, setup):
    """✅ Alles ok?: Produkt ohne Kategorie / Artikel ohne Geschäft lässt sich auch ganz löschen."""
    m = mgr(hass)
    await m.async_check(fix=True)
    x = m.add_item("Quatschprodukt")
    x["category_id"] = None
    x["store_id"] = "gibtsnicht"
    m.history_for("Quatschprodukt")["category_id"] = None
    res = await m.async_check()
    ids = {e["id"]: e for e in res["items"]}
    assert any(o["value"] == "__delete__" for o in ids["nocat:quatschprodukt"]["options"])
    assert any(o["value"] == "__delete__" for o in ids[f"nostore:{x['id']}"]["options"])
    res = await m.async_check(fixes={"nocat:quatschprodukt": "__delete__"})
    assert res["fixed"] == 1 and x not in m.items and m.history_for("Quatschprodukt") is None


async def test_out_of_stock_restarts_cleanup(hass, setup, hass_ws_client, freezer):
    """⇄ „Nächstes Mal wieder hier“: bleibt offen, „war aus“-Datum, Aufräum-Frist startet neu, Abhaken löscht den Hinweis."""
    client = await hass_ws_client(hass)
    m = mgr(hass)
    freezer.move_to(datetime(2026, 9, 15, 18, 0, tzinfo=tz()))  # Dienstag eingetragen
    milch = m.add_item("Milch")
    freezer.move_to(datetime(2026, 9, 26, 11, 0, tzinfo=tz()))  # Samstag: war aus
    await client.send_json({"id": 1, "type": "einkaufsliste/item/out", "item_id": milch["id"]})
    assert (await client.receive_json())["success"]
    assert milch["out_at"] and not milch["checked"]
    assert m.log[-1]["a"] == "out"
    # Ohne „war aus“ wäre sie am So 27.09. dran (12 Tage alt) – jetzt erst 7 Tage ab Samstag
    m.cleanup(reference=datetime(2026, 9, 27, 3, 0, tzinfo=tz()), scheduled=True)
    assert not milch["checked"]
    m.cleanup(reference=datetime(2026, 10, 4, 3, 0, tzinfo=tz()), scheduled=True)
    assert milch["checked"] and milch["out_at"] is None
    with pytest.raises(ValueError):
        m.mark_out(milch["id"])  # abgehakt -> geht nicht


async def test_aliases(hass, setup, hass_ws_client):
    """🏷️ Spitznamen: „Tempos“ landet bei Taschentücher – beim Eintragen, im Rezept, nach Umbenennen und Löschen."""
    client = await hass_ws_client(hass)
    m = mgr(hass)
    m.add_item("Taschentücher")
    await client.send_json({"id": 1, "type": "einkaufsliste/product/update", "key": "taschentücher", "aliases": ["Tempos", " tempo ", "Taschentücher"]})
    res = await client.receive_json()
    assert res["success"], res
    assert res["result"]["aliases"] == ["tempo", "tempos"]  # eigener Name wird nicht Spitzname
    assert m.as_dict()["aliases"][0]["name"] == "Taschentücher"
    item = m.add_item("tempos", for_whom="Oma")
    assert item["name"] == "Taschentücher"
    r = m.add_recipe("Schnupfen-Set", [{"name": "2 tempo"}])
    assert r["items"][0]["name"] == "Taschentücher" and r["items"][0]["quantity"] == "2x"
    # Umbenennen zieht die Spitznamen mit
    m.update_product("taschentücher", name="Papiertaschentücher")
    assert m.add_item("Tempos", for_whom="Opa")["name"] == "Papiertaschentücher"
    # Ganz löschen nimmt sie mit
    await m.async_delete_product("papiertaschentücher")
    assert m.aliases == {}


def test_convert_foreign_units():
    """⚖️ Umrechnen beim Rezept-Import: cup, oz, lb, tbsp, °F."""
    from custom_components.einkaufsliste.convert import convert_temps
    from custom_components.einkaufsliste.recipe_import import parse_line, parse_text

    got = {line: parse_line(line)["quantity"] for line in (
        "1 cup flour", "2 cups sugar", "1 1/2 cups milk", "8 oz cheddar cheese", "1 lb ground beef",
        "2 tbsp olive oil", "1 tsp salt", "2 sticks butter", "200 g Mehl", "3 Eier")}
    assert got == {
        "1 cup flour": "125 g", "2 cups sugar": "400 g", "1 1/2 cups milk": "360 ml", "8 oz cheddar cheese": "225 g",
        "1 lb ground beef": "455 g", "2 tbsp olive oil": "2 EL", "1 tsp salt": "1 TL", "2 sticks butter": "225 g",
        "200 g Mehl": "200 g", "3 Eier": "3x"}
    assert parse_text("1 cup of chopped nuts")[0] == {"name": "Chopped nuts", "quantity": "140 g", "note": None}
    assert convert_temps("Bake at 350°F, then 425 degrees F.") == "Bake at 175 °C, then 220 °C."


async def test_backup_roundtrip(hass, setup, hass_client):
    """💾 Sicherung herunterladen und wieder einspielen – samt Fotos."""
    import base64

    client = await hass_client()
    m = mgr(hass)
    m.add_item("Sicherungs-Milch", note="Bio")
    m.add_recipe("Sicherungs-Kuchen", [{"name": "Mehl", "quantity": "500 g"}])
    await m.async_set_photo("sicherungs-milch|bio", base64.b64encode(JPEG).decode())
    resp = await client.get("/api/einkaufsliste/sicherung")
    assert resp.status == 200 and resp.headers["Content-Type"] == "application/zip"
    backup = await resp.read()
    # alles durcheinanderbringen …
    m.items.clear()
    m.recipes.clear()
    await m.async_remove_photo("sicherungs-milch|bio")
    assert "sicherungs-milch|bio" not in m.photos
    # … und zurückholen
    resp = await client.post("/api/einkaufsliste/sicherung", data=backup)
    res = await resp.json()
    assert resp.status == 200, res
    assert res["photos"] == 1
    assert [i["name"] for i in m.items] == ["Sicherungs-Milch"] and m.recipes[0]["name"] == "Sicherungs-Kuchen"
    assert "sicherungs-milch|bio" in m.photos and m._photo_path(m.photos["sicherungs-milch|bio"]["id"]).exists()
    bad = await client.post("/api/einkaufsliste/sicherung", data=b"kein zip")
    assert bad.status == 400


async def test_recipe_file_import(hass, setup, hass_ws_client):
    """📄 Rezepte aus einer Datei: Text mit „# Name“, CSV und JSON."""
    client = await hass_ws_client(hass)
    m = mgr(hass)
    text = """# Pfannkuchen
250 g Mehl
3 Eier
500 ml Milch
Zubereitung:
Alles verrühren.
In der Pfanne backen.

# Pancakes (US)
1 cup flour
2 tbsp sugar
"""
    await client.send_json({"id": 1, "type": "einkaufsliste/recipe/import_file", "text": text, "filename": "kochbuch.txt"})
    res = await client.receive_json()
    assert res["success"], res
    assert res["result"]["added"] == 2
    pf = next(r for r in m.recipes if r["name"] == "Pfannkuchen")
    assert [i["name"] for i in pf["items"]] == ["Eier", "Mehl", "Milch"] and pf["steps"] == "Alles verrühren.\nIn der Pfanne backen."
    us = next(r for r in m.recipes if r["name"] == "Pancakes (US)")
    assert {i["name"]: i["quantity"] for i in us["items"]} == {"Flour": "125 g", "Sugar": "2 EL"}
    # CSV – gleicher Name bekommt „(Import)“
    csv_text = "Rezept;Menge;Zutat;Notiz\nPfannkuchen;1 Prise;Salz;\nSalat;1;Gurke;Bio\n"
    await client.send_json({"id": 2, "type": "einkaufsliste/recipe/import_file", "text": csv_text, "filename": "r.csv"})
    res = (await client.receive_json())["result"]
    assert res["added"] == 2 and "Pfannkuchen (Import)" in res["names"]
    salat = next(r for r in m.recipes if r["name"] == "Salat")
    assert salat["items"][0] == {**salat["items"][0], "name": "Gurke", "quantity": "1x", "note": "Bio"}
    # JSON
    import json as _json
    js = _json.dumps([{"name": "Tee", "items": ["1 Beutel Pfefferminztee"], "steps": ["Wasser kochen"]}])
    await client.send_json({"id": 3, "type": "einkaufsliste/recipe/import_file", "text": js, "filename": "r.json"})
    assert (await client.receive_json())["result"]["added"] == 1
    await client.send_json({"id": 4, "type": "einkaufsliste/recipe/import_file", "text": "nix", "filename": "x.txt"})
    assert not (await client.receive_json())["success"]


async def test_import_from_other_apps(hass, setup, hass_ws_client):
    """🔁 Aus anderen Apps: Text (Bring!/Keep teilen) und HA-To-do-Listen."""
    client = await hass_ws_client(hass)
    m = mgr(hass)
    aldi = m.stores[1]["id"]
    text = "Einkauf:\n☐ Milch\n☑ Brot\n- [ ] 2 Äpfel\n- [x] Käse\n• Butter\n"
    await client.send_json({"id": 1, "type": "einkaufsliste/import/text", "text": text, "store_id": aldi})
    res = await client.receive_json()
    assert res["success"], res
    assert res["result"] == {"added": 3, "skipped": 2}
    assert {(i["name"], i["quantity"], i["store_id"]) for i in m.items} == {("Milch", None, aldi), ("Äpfel", "2x", aldi), ("Butter", None, aldi)}

    # HA-To-do-Liste (hier die eingebaute HA-Einkaufsliste)
    import os
    if os.path.exists(hass.config.path(".shopping_list.json")):  # Reste aus früheren Testläufen weg
        os.remove(hass.config.path(".shopping_list.json"))
    sl = MockConfigEntry(domain="shopping_list")
    sl.add_to_hass(hass)
    assert await hass.config_entries.async_setup(sl.entry_id)
    await hass.async_block_till_done()
    await hass.services.async_call("todo", "add_item", {"entity_id": "todo.einkaufsliste", "item": "Kaffee"}, blocking=True)
    await hass.services.async_call("todo", "add_item", {"entity_id": "todo.einkaufsliste", "item": "3 Joghurt"}, blocking=True)
    await client.send_json({"id": 2, "type": "einkaufsliste/import/todo_lists"})
    lists = (await client.receive_json())["result"]
    assert any(x["entity_id"] == "todo.einkaufsliste" for x in lists)
    await client.send_json({"id": 3, "type": "einkaufsliste/import/todo", "entity_id": "todo.einkaufsliste"})
    res = await client.receive_json()
    assert res["success"], res
    assert res["result"]["added"] == 2
    assert any(i["name"] == "Joghurt" and i["quantity"] == "3x" for i in m.items)


@pytest.mark.english
async def test_english_defaults(hass: HomeAssistant, setup) -> None:
    """🌍 Home Assistant auf Englisch: Start-Geschäfte, Kategorien und Gruppen auf Englisch, Wörterbuch und Einheiten verstehen Englisch."""
    m = mgr(hass)
    assert [c["name"] for c in m.categories][:3] == ["Fruit & vegetables", "Bakery", "Dairy & chilled"]
    assert "Supermarket" in [s["name"] for s in m.stores]
    assert any(g["name"] == "Poultry" for g in m.recipe_groups)
    cat = {c["id"]: c["name"] for c in m.categories}
    assert cat[m.guess_category("Milk")] == "Dairy & chilled"
    assert cat[m.guess_category("Frozen pizza")] == "Frozen"
    assert cat[m.guess_category("Toilet paper")] == "Household"
    item = m.add_item("Tomatoes 2 cans", store_id=m.stores[0]["id"])
    assert (item["name"], item["quantity"]) == ("Tomatoes", "2 Dosen")
    from custom_components.einkaufsliste.quantity import norm_qty
    assert norm_qty("3 tbsp") == "3 EL"


async def test_more_sensors(hass: HomeAssistant, setup) -> None:
    """📊 Sensor pro Geschäft, Ja/Nein „Etwas zu kaufen“ und „Zuletzt eingetragen“."""
    m = mgr(hass)
    aldi = next(s for s in m.stores if s["name"] == "Aldi")
    assert hass.states.get("binary_sensor.einkaufsliste_etwas_zu_kaufen").state == "off"
    assert hass.states.get("sensor.einkaufsliste_aldi").state == "0"
    with m.acting("Anna", None, "card"):
        m.add_item("Milch", store_id=aldi["id"], quantity="2 L", note="Laktosefrei")
    await hass.async_block_till_done()
    st = hass.states.get("sensor.einkaufsliste_aldi")
    assert st.state == "1" and st.attributes["artikel"] == ["2 L Milch · Laktosefrei"]
    assert hass.states.get("binary_sensor.einkaufsliste_etwas_zu_kaufen").state == "on"
    last = hass.states.get("sensor.einkaufsliste_zuletzt_eingetragen")
    assert last.state == "Milch"
    assert last.attributes["von"] == "Anna" and last.attributes["geschaeft"] == "Aldi" and last.attributes["menge"] == "2 L"
    # neues Geschäft -> neuer Sensor, gelöscht -> weg
    kl = m.add_group("stores", "Kaufland")
    await hass.async_block_till_done()
    assert hass.states.get("sensor.einkaufsliste_kaufland").state == "0"
    m.remove_group("stores", kl["id"])
    await hass.async_block_till_done()
    assert hass.states.get("sensor.einkaufsliste_kaufland") is None


async def test_pin_typos_and_brackets(hass: HomeAssistant, setup, hass_ws_client) -> None:
    """🔒 PIN, 🧠 Tippfehler lernen, „Milch (2)“ erkennen."""
    m = mgr(hass)
    client = await hass_ws_client(hass)
    # PIN
    assert m.as_dict()["settings"]["pin"] is False
    await client.send_json({"id": 1, "type": "einkaufsliste/pin/set", "pin": "12a4"})
    assert not (await client.receive_json())["success"]
    await client.send_json({"id": 2, "type": "einkaufsliste/pin/set", "pin": "2310"})
    assert (await client.receive_json())["success"]
    assert m.as_dict()["settings"]["pin"] is True and "2310" not in (m.pin_hash or "")
    await client.send_json({"id": 3, "type": "einkaufsliste/pin/check", "pin": "0000"})
    assert (await client.receive_json())["result"] == {"ok": False}
    await client.send_json({"id": 4, "type": "einkaufsliste/pin/check", "pin": "2310"})
    assert (await client.receive_json())["result"] == {"ok": True}
    await client.send_json({"id": 5, "type": "einkaufsliste/pin/set", "pin": "9999", "old": "1111"})
    assert not (await client.receive_json())["success"]
    m.clear_pin()
    assert m.as_dict()["settings"]["pin"] is False
    # Tippfehler: erst beim 2. Mal
    assert m.learn_typo("Mlich", "Milch") == {"learned": False, "count": 1}
    assert m.add_item("Mlich")["name"] == "Mlich"
    assert m.learn_typo("mlich", "Milch")["learned"] is True
    assert m.as_dict()["typos"] == {"mlich": "Milch"}
    item = m.add_item("Mlich", store_id=m.stores[0]["id"])
    assert item["name"] == "Milch"
    m.forget_typo("mlich")
    assert m.as_dict()["typos"] == {}
    # Mengen in Klammern
    it = m.add_item("Joghurt (4)", store_id=m.stores[0]["id"])
    assert (it["name"], it["quantity"]) == ("Joghurt", "4x")
    it = m.add_item("Kinder (Oma)")
    assert it["name"] == "Kinder (Oma)" and not it.get("quantity")


async def test_offline_app_pages(hass: HomeAssistant, setup, hass_client_no_auth) -> None:
    """📱 Die Offline-App ist ohne Anmeldung erreichbar (enthält keine Daten), mit Offline-Speicher."""
    client = await hass_client_no_auth()
    r = await client.get("/einkaufsliste/app/")
    assert r.status == 200 and "text/html" in r.headers["Content-Type"]
    body = await r.text()
    assert "__EL_VERSION__" not in body and "/auth/authorize" in body
    r = await client.get("/einkaufsliste/app/sw.js")
    assert r.status == 200 and r.headers.get("Service-Worker-Allowed") == "/einkaufsliste/app/"
    assert "el-queue" in await r.text()  # 🔄 im Hintergrund nachschicken
    r = await client.get("/einkaufsliste/app/manifest.json")
    man = await r.json()
    assert r.status == 200 and man["start_url"] == "/einkaufsliste/app/"
    assert [x["url"].split("=")[-1] for x in man["shortcuts"]] == ["add", "shop", "scan"]  # 📱 Schnellmenü
    r = await client.get("/einkaufsliste/app/../manifest.json")
    assert r.status == 404
    r = await client.get("/einkaufsliste/app", allow_redirects=False)
    assert r.status == 302 and r.headers["Location"] == "/einkaufsliste/app/"
    r = await client.get("/einkaufsliste/app/icons.json")
    assert r.status == 200
    icons = await r.json()
    assert "cart" in icons and icons["cart"].startswith("M")
    assert "einkaufsliste-card.js" in body  # 📱 in der App steckt dieselbe Karte
    r = await client.get("/einkaufsliste/app/zxing.min.js")  # 📷 Barcode-Leser für Handys ohne eingebauten
    assert r.status == 200 and "javascript" in r.headers["Content-Type"]
    assert "MultiFormatReader" in await r.text()
    assert "bar_code/scan" in body and "hasBarCodeScanner" in body  # 📷 Kamera-Scanner in der App


async def test_scanned_stores_private_labels(hass: HomeAssistant, setup) -> None:
    """📷 Neu gescannt im Katalog, 🏪 mehrere Geschäfte pro Produkt, 🏷️ Eigenmarken."""
    from custom_components.einkaufsliste.barcode import private_label_store
    m = mgr(hass)
    aldi = next(s for s in m.stores if s["name"] == "Aldi")
    netto = next(s for s in m.stores if s["name"] == "Netto")
    dm = next(s for s in m.stores if s["name"] == "DM")
    # Eigenmarken
    assert private_label_store(m, "Milsani, Aldi") == (aldi["id"], "Aldi")
    assert private_label_store(m, "Balea") == (dm["id"], "DM")
    assert private_label_store(m, "K-Classic") == (None, None)  # kein Kaufland angelegt
    lidl = next(s for s in m.stores if s["name"] == "Lidl")
    assert private_label_store(m, "Wagner", ["en:lidl"]) == (lidl["id"], "Lidl")  # Datenbank kennt nur Lidl
    assert private_label_store(m, "Wagner", ["en:lidl", "en:rewe"]) == (None, None)  # überall zu haben
    m.update_group("stores", netto["id"], brands="Hausmarke X, Biobio")
    assert private_label_store(m, "hausmarke x") == (netto["id"], "Netto")
    # Neu gescannt
    item = m.add_item("H-Milch", store_id=aldi["id"], note="Weihenstephan", barcode="4008452027008")
    prod = next(p for p in m.products() if p["key"] == "h-milch|weihenstephan")
    assert prod["scanned"] is True and m.as_dict()["scanned_new"] == 1
    m.add_item("H-Milch", store_id=netto["id"], note="Weihenstephan", barcode="4008452027008")  # schon bekannt
    m.confirm_scanned("h-milch|weihenstephan")
    assert m.as_dict()["scanned_new"] == 0
    # Gibt's bei: lernt beim Abhaken, im Katalog setzbar
    m.set_checked(item["id"], True)
    assert aldi["id"] in next(p for p in m.products() if p["name"] == "H-Milch")["stores"]
    m.update_product("h-milch|weihenstephan", stores=[aldi["id"], netto["id"], "gibtsnicht"])
    assert m.history["h-milch"]["stores"] == [aldi["id"], netto["id"]]


async def test_missed_counts(hass: HomeAssistant, setup) -> None:
    """📈 Oft nicht bekommen: zählt „war aus“ und ⇄ weg von einem Geschäft."""
    m = mgr(hass)
    aldi = next(s for s in m.stores if s["name"] == "Aldi")
    netto = next(s for s in m.stores if s["name"] == "Netto")
    for _ in range(2):
        it = m.add_item("Butter", store_id=aldi["id"])
        m.mark_out(it["id"])
    m.move_item(it["id"], netto["id"])
    assert m.as_dict()["missed"] == {f"butter|{aldi['id']}": 3}


async def test_zones_mascot_todo_sync(hass: HomeAssistant, setup, hass_ws_client) -> None:
    """📍 mehrere Zonen pro Geschäft, 🛒😊 Maskottchen für alle, 🔁 To-do-Liste automatisch herüberholen."""
    m = mgr(hass)
    aldi = next(s for s in m.stores if s["name"] == "Aldi")
    # 📍 Zonen
    m.update_group("stores", aldi["id"], zones=["zone.aldi_ort", "zone.aldi_stadt", "zone.aldi_ort"])
    assert aldi["zones"] == ["zone.aldi_ort", "zone.aldi_stadt"] and aldi["zone"] == "zone.aldi_ort"
    with pytest.raises(ValueError):
        m.update_group("stores", aldi["id"], zones=["person.anna"])
    m.update_group("stores", aldi["id"], zone="zone.aldi_neu")  # alter Weg: genau eine Zone
    assert aldi["zones"] == ["zone.aldi_neu"]
    m.update_group("stores", aldi["id"], zones=[])
    assert aldi["zones"] == [] and aldi["zone"] is None
    # alte Daten (nur „zone“) werden beim Laden umgebaut
    aldi["zone"] = "zone.alt"
    del aldi["zones"]
    await m.async_save_now()
    await m.async_load()
    aldi = next(s for s in m.stores if s["name"] == "Aldi")
    assert aldi["zones"] == ["zone.alt"]

    # 🛒😊 Maskottchen
    client = await hass_ws_client(hass)
    await client.send_json({"id": 1, "type": "einkaufsliste/mascot/set", "on": True})
    assert (await client.receive_json())["success"]
    assert m.as_dict()["settings"]["mascot"] is True

    # 🔁 To-do-Liste (hier die eingebaute HA-Einkaufsliste)
    import os
    if os.path.exists(hass.config.path(".shopping_list.json")):
        os.remove(hass.config.path(".shopping_list.json"))
    sl = MockConfigEntry(domain="shopping_list")
    sl.add_to_hass(hass)
    assert await hass.config_entries.async_setup(sl.entry_id)
    await hass.async_block_till_done()
    await hass.services.async_call("todo", "add_item", {"entity_id": "todo.einkaufsliste", "item": "Kaffee"}, blocking=True)
    netto = next(s for s in m.stores if s["name"] == "Netto")
    await client.send_json({"id": 2, "type": "einkaufsliste/todo_sync/set", "entity_id": "todo.einkaufsliste", "store_id": netto["id"]})
    assert (await client.receive_json())["success"]
    await hass.async_block_till_done()
    kaffee = next(i for i in m.items if i["name"] == "Kaffee")
    assert kaffee["store_id"] == netto["id"] and not kaffee["checked"]
    assert hass.states.get("todo.einkaufsliste").state == "0"  # dort gelöscht
    # später Gesagtes kommt von selbst
    await hass.services.async_call("todo", "add_item", {"entity_id": "todo.einkaufsliste", "item": "2 Milch"}, blocking=True)
    await hass.async_block_till_done()
    milch = next(i for i in m.items if i["name"] == "Milch")
    assert milch["quantity"] == "2x" and milch["store_id"] == netto["id"]
    assert hass.states.get("todo.einkaufsliste").state == "0"
    info = m.as_dict()["settings"]["todo_syncs"][0]
    assert info["entity_id"] == "todo.einkaufsliste" and info["count"] == 2 and info["ok"]
    assert m.log[-1]["v"] == "sync"
    # ausschalten
    await client.send_json({"id": 3, "type": "einkaufsliste/todo_sync/set", "entity_id": None})
    assert (await client.receive_json())["success"]
    await hass.services.async_call("todo", "add_item", {"entity_id": "todo.einkaufsliste", "item": "Tee"}, blocking=True)
    await hass.async_block_till_done()
    assert not any(i["name"] == "Tee" for i in m.items)
    assert m.as_dict()["settings"]["todo_syncs"] == []


async def test_mail_import_and_store_icon(hass: HomeAssistant, setup, hass_ws_client) -> None:
    """📧 Produkte per E-Mail (IMAP-Ereignis) und 🏪 Geschäfts-Icon leer = automatisch."""
    from custom_components.einkaufsliste.mail_import import mail_text
    m = mgr(hass)
    assert mail_text("Milch\n6 Eier\n\n> alt\n-- \nMax\nSignatur") == "Milch\n6 Eier"
    assert mail_text("<html><body><div>Brot</div><div>Käse &amp; Wurst</div></body></html>") == "Brot\nKäse & Wurst"
    assert mail_text("", "Milch, Butter") == "Milch\nButter"
    imap = MockConfigEntry(domain="imap", title="liste@example.com")
    imap.add_to_hass(hass)
    client = await hass_ws_client(hass)
    await client.send_json({"id": 1, "type": "einkaufsliste/mail/sources"})
    assert (await client.receive_json())["result"] == [{"entry_id": imap.entry_id, "name": "liste@example.com"}]
    await client.send_json({"id": 2, "type": "einkaufsliste/mail/set", "entry_id": imap.entry_id, "senders": []})
    assert not (await client.receive_json())["success"]  # ohne Absender geht's nicht
    aldi = next(s for s in m.stores if s["name"] == "Aldi")
    await client.send_json({"id": 3, "type": "einkaufsliste/mail/set", "entry_id": imap.entry_id, "store_id": aldi["id"],
                            "senders": ["Papa@Example.com, oma@example.com"]})
    assert (await client.receive_json())["success"]
    assert m.mail_import["senders"] == ["papa@example.com", "oma@example.com"]
    ev = {"entry_id": imap.entry_id, "initial": True, "uid": "1", "date": "x", "subject": "Einkauf",
          "sender": "Papa <papa@example.com>", "text": "Kaffee\n2 Joghurt\n\nGesendet von meinem iPhone"}
    hass.bus.async_fire("imap_content", ev)
    await hass.async_block_till_done()
    kaffee = next(i for i in m.items if i["name"] == "Kaffee")
    assert kaffee["store_id"] == aldi["id"] and kaffee["added_by"] == "📧 Papa"
    assert any(i["name"] == "Joghurt" and i["quantity"] == "2x" for i in m.items)
    assert m.log[-1]["v"] == "mail"
    n = len(m.items)
    hass.bus.async_fire("imap_content", ev)  # dieselbe Mail nochmal
    hass.bus.async_fire("imap_content", {**ev, "uid": "2", "sender": "fremd@spam.com", "text": "Bitcoin"})
    await hass.async_block_till_done()
    assert len(m.items) == n
    assert m.as_dict()["settings"]["mail_import"]["count"] == 2
    await client.send_json({"id": 4, "type": "einkaufsliste/mail/set", "entry_id": None})
    assert (await client.receive_json())["success"] and m.mail_import is None
    # 🏪 Icon leer = automatisch
    m.update_group("stores", aldi["id"], icon="baguette")
    assert aldi["icon"] == "mdi:baguette"
    m.update_group("stores", aldi["id"], icon="")
    assert aldi["icon"] is None


async def test_mail_stores_and_after(hass: HomeAssistant, setup) -> None:
    """📧 Geschäft aus Betreff/Überschrift, danach Mail löschen."""
    m = mgr(hass)
    aldi = next(s for s in m.stores if s["name"] == "Aldi")
    dm = next(s for s in m.stores if s["name"] == "DM")
    netto = next(s for s in m.stores if s["name"] == "Netto")
    imap = MockConfigEntry(domain="imap", title="liste@example.com")
    imap.add_to_hass(hass)
    calls = []

    async def _delete(call):
        calls.append(dict(call.data))

    hass.services.async_register("imap", "delete", _delete)
    m.set_mail_import(imap.entry_id, netto["id"], ["ich@example.com"], "delete")
    fire = lambda uid, subject, text: hass.bus.async_fire("imap_content", {  # noqa: E731
        "entry_id": imap.entry_id, "initial": True, "uid": uid, "date": uid, "subject": subject, "sender": "ich@example.com", "text": text})
    fire("10", "Einkauf bei Aldi", "Milch\n2 Brot")
    await hass.async_block_till_done()
    assert next(i for i in m.items if i["name"] == "Milch")["store_id"] == aldi["id"]
    assert not any(i["name"] == "Einkauf bei Aldi" for i in m.items)
    fire("11", "Einkauf", "Butter\nDM:\nZahnpasta\naldi\n6 Eier")
    await hass.async_block_till_done()
    assert next(i for i in m.items if i["name"] == "Butter")["store_id"] == netto["id"]  # eingestelltes Geschäft
    assert next(i for i in m.items if i["name"] == "Zahnpasta")["store_id"] == dm["id"]
    eier = next(i for i in m.items if i["name"] == "Eier")
    assert eier["store_id"] == aldi["id"] and eier["quantity"] == "6x"
    assert [c["uid"] for c in calls] == ["10", "11"] and calls[0]["entry"] == imap.entry_id
    fire("12", "Hallo", "")  # nichts eingetragen -> nicht löschen
    await hass.async_block_till_done()
    assert len(calls) == 2 or calls[-1]["uid"] != "12" or any(i["name"] == "Hallo" for i in m.items)
    with pytest.raises(ValueError):
        m.set_mail_import(imap.entry_id, None, ["ich@example.com"], "weg")


async def test_todo_sync_keep_and_full(hass: HomeAssistant, setup) -> None:
    """🔗 To-do-Liste abgleichen: bei beiden behalten (keep) und voller Abgleich (sync)."""
    import os
    from datetime import timedelta
    from pytest_homeassistant_custom_component.common import async_fire_time_changed
    from homeassistant.util import dt as dt_util
    m = mgr(hass)
    if os.path.exists(hass.config.path(".shopping_list.json")):
        os.remove(hass.config.path(".shopping_list.json"))
    sl = MockConfigEntry(domain="shopping_list")
    sl.add_to_hass(hass)
    assert await hass.config_entries.async_setup(sl.entry_id)
    await hass.async_block_till_done()
    ent = "todo.einkaufsliste"

    async def todo():
        r = await hass.services.async_call("todo", "get_items", {"entity_id": ent}, blocking=True, return_response=True)
        return {t["summary"]: t for t in r[ent]["items"]}

    async def settle():
        await hass.async_block_till_done()
        async_fire_time_changed(hass, dt_util.utcnow() + timedelta(seconds=3))
        await hass.async_block_till_done()

    await hass.services.async_call("todo", "add_item", {"entity_id": ent, "item": "Kaffee"}, blocking=True)
    m.set_todo_sync(ent, None, "keep")
    await settle()
    kaffee = next(i for i in m.items if i["name"] == "Kaffee")
    assert (await todo())["Kaffee"]["status"] == "needs_action"  # bleibt drüben
    m.set_checked(kaffee["id"], True)  # bei uns abgehakt -> drüben abgehakt
    await settle()
    assert (await todo())["Kaffee"]["status"] == "completed"
    await hass.services.async_call("todo", "update_item", {"entity_id": ent, "item": "Kaffee", "status": "needs_action"}, blocking=True)
    await settle()
    assert not next(i for i in m.items if i["name"] == "Kaffee")["checked"]  # drüben wieder offen -> bei uns auch
    await hass.services.async_call("todo", "remove_item", {"entity_id": ent, "item": ["Kaffee"]}, blocking=True)
    await settle()
    assert next(i for i in m.items if i["name"] == "Kaffee")["checked"]  # drüben gestrichen -> abgehakt
    # voller Abgleich: Eigenes kommt auch rüber, ohne doppelt zurückzukommen
    m.set_todo_sync(ent, None, "sync")
    m.add_item("Tee", quantity="2x")
    await settle()
    assert "Tee (2x)" in await todo()
    await settle()
    assert len([i for i in m.items if i["name"].lower().startswith("tee")]) == 1
    sy = m.as_dict()["settings"]["todo_syncs"][0]
    assert sy["mode"] == "sync" and "links" not in sy


async def test_move_from_anywhere_relocates(hass: HomeAssistant, setup) -> None:
    """🤷 Aus „Egal wo“ verschieben = einfach umziehen, kein abgehakter Rest bleibt zurück."""
    m = mgr(hass)
    netto, aldi = m.find_store("Netto"), m.find_store("Aldi")
    milch = m.add_item("Milch", quantity="2x")
    new = m.move_item(milch["id"], netto)
    assert new["id"] == milch["id"] and new["store_id"] == netto and not new["checked"]
    assert len([i for i in m.items if i["name"] == "Milch"]) == 1
    # alter abgehakter Eintrag im Ziel wird ersetzt statt doppelt
    old = m.add_item("Kakao", store_id=aldi)
    m.set_checked(old["id"], True)
    kakao = m.add_item("Kakao")
    new = m.move_item(kakao["id"], aldi)
    assert [i["id"] for i in m.items if i["name"] == "Kakao"] == [kakao["id"]] and new["store_id"] == aldi
    # dort schon offen -> zusammenlegen
    m.add_item("Brot", store_id=netto)
    brot = m.add_item("Brot", quantity="3x")
    new = m.move_item(brot["id"], netto)
    assert len([i for i in m.items if i["name"] == "Brot"]) == 1 and new["quantity"] == "3x"
    # zwischen echten Geschäften bleibt „War aus“: alt abgehakt, neu offen
    m.move_item(new["id"], aldi)
    brote = [i for i in m.items if i["name"] == "Brot"]
    assert len(brote) == 2 and {i["checked"] for i in brote} == {True, False}


async def test_mail_glued_text_and_fetch_part(hass: HomeAssistant, setup) -> None:
    """📧 Mail ohne Zeilenumbrüche (Samsung-Mail): Teil selbst holen, Gruß/Signatur weg, „Netto: Milch, Brot“."""
    import base64
    from custom_components.einkaufsliste.mail_import import mail_groups, mail_text
    m = mgr(hass)
    netto = next(s for s in m.stores if s["name"] == "Netto")
    dm = next(s for s in m.stores if s["name"] == "DM")
    assert mail_text("Netto:MilchMit freundlichen Grüßen / Best regardsMax MusterHinweis: vertraulich …") == "Netto:Milch"
    assert mail_text("Hallo Schatz,\nMilch.\nEinen schönen Tag noch!\nLG Max\nMobil 0123") == "Milch"
    assert mail_groups(m, "Netto: Milch, Brot\nDM: Zahnpasta; Seife\n1,5 % Milch", None, None) == [
        (netto["id"], "Milch\nBrot"), (dm["id"], "Zahnpasta\nSeife\n1,5 % Milch")]
    imap = MockConfigEntry(domain="imap", title="liste@example.com")
    imap.add_to_hass(hass)
    asked = []

    async def _part(call):
        asked.append(call.data["part"])
        if call.data["part"] == "0":
            return {"part_data": base64.b64encode("Netto:\nKakao\nButter\n\nViele Grüße\nMax".encode()).decode(),
                    "content_transfer_encoding": "base64", "content_type": "text/plain", "uid": call.data["uid"], "part": "0"}
        return {"part_data": "", "content_transfer_encoding": "7bit"}

    from homeassistant.core import SupportsResponse
    hass.services.async_register("imap", "fetch_part", _part, supports_response=SupportsResponse.ONLY)
    m.set_mail_import(imap.entry_id, None, ["ich@example.com"], "keep")
    hass.bus.async_fire("imap_content", {
        "entry_id": imap.entry_id, "initial": True, "uid": "2", "date": "d", "subject": "", "sender": '"ich" <ich@example.com>',
        "text": "Netto:KakaoButterViele GrüßeMax", "parts": {"0": {"content_type": "text/plain"}, "1": {"content_type": "text/html"}}})
    await hass.async_block_till_done()
    assert "0" in asked
    assert next(i for i in m.items if i["name"] == "Kakao")["store_id"] == netto["id"]
    assert next(i for i in m.items if i["name"] == "Butter")["store_id"] == netto["id"]
    assert not any("Grüße" in i["name"] or i["name"] == "Max" for i in m.items)


async def test_product_remove_logs_user(hass: HomeAssistant, setup, hass_ws_client, hass_admin_user) -> None:
    """👤 „Ganz löschen“ im Verlauf mit Namen statt „Automatisch“."""
    m = mgr(hass)
    m.add_item("Gurke")
    client = await hass_ws_client(hass)
    await client.send_json({"id": 1, "type": "einkaufsliste/product/remove", "key": "gurke"})
    assert (await client.receive_json())["success"]
    entry = next(e for e in reversed(m.log) if e["a"] == "remove" and e["n"] == "Gurke")
    assert entry["w"]  # ein Name, nicht leer
    assert m._actor == {}  # danach wieder niemand


async def test_missed_ignores_anywhere_and_hide(hass: HomeAssistant, setup) -> None:
    """📈 Umzug aus „Egal wo“ zählt nicht; ✖ ausgeblendet zählt ab da neu."""
    m = mgr(hass)
    aldi, netto = m.find_store("Aldi"), m.find_store("Netto")
    for _ in range(2):  # 2× aus „Egal wo“ umgezogen
        it = m.add_item("Kakao")
        m.move_item(it["id"], netto)
        m.set_checked(it["id"], True)
    assert not any(k.startswith("kakao|") for k in m.missed_counts())
    for _ in range(2):  # 2× bei Aldi nicht bekommen
        it = m.add_item("Butter", store_id=aldi)
        m.move_item(it["id"], netto)
        m.set_checked(next(i for i in m.items if i["name"] == "Butter" and not i["checked"])["id"], True)
    assert m.missed_counts().get(f"butter|{aldi}") == 2
    m.hide_missed("Butter", aldi)
    assert f"butter|{aldi}" not in m.missed_counts()
    assert f"butter|{aldi}" in m.as_dict()["missed_hidden"]
    with pytest.raises(ValueError):
        m.hide_missed("Butter", "gibtsnicht")


async def test_data_files_brands_and_dictionary(hass: HomeAssistant, setup, tmp_path) -> None:
    """🏷️📖 Eigenmarken und Kategorie-Wörterbuch kommen aus data/*.json – nach Land, ohne Python ergänzbar."""
    import json
    from custom_components.einkaufsliste import barcode
    from custom_components.einkaufsliste.categories import load_dictionary
    assert "milsani" in barcode.private_labels("DE")["aldi"]
    assert "balea" in barcode.private_labels(None)["dm"]  # unbekanntes Land -> alle zusammen
    f = tmp_path / "eigenmarken.json"
    f.write_text(json.dumps({"_info": ["x"], "AT": {"spar": ["S-Budget"]}, "DE": {"aldi": ["milsani"]}}), encoding="utf-8")
    labels = barcode.load_private_labels(f)
    assert labels == {"AT": {"spar": ("s-budget",)}, "DE": {"aldi": ("milsani",)}}
    assert barcode.load_private_labels(tmp_path / "fehlt.json") == {}
    k = tmp_path / "kategorien.json"
    k.write_text(json.dumps({"categories": [{"id": "x", "match": ["kühl"], "words": {"de": ["Milch"], "nl": ["melk"]}}]}), encoding="utf-8")
    assert load_dictionary(k) == [{"match": ["kühl"], "de": ["milch"], "other": ["melk"]}]
    m = mgr(hass)
    aldi = m.find_store("Aldi")
    assert barcode.private_label_store(m, "Milsani")[0] == aldi


async def test_store_cat_order(hass: HomeAssistant, setup, hass_ws_client) -> None:
    """🗺️ Pro Geschäft eigene Kategorien-Reihenfolge – Standard: wie alle (None)."""
    m = mgr(hass)
    aldi = m.find_store("Aldi")
    ids = [c["id"] for c in m.categories]
    assert m.store_by_id(aldi).get("cat_order") is None
    client = await hass_ws_client(hass)
    await client.send_json({"id": 1, "type": "einkaufsliste/group/update", "kind": "stores", "group_id": aldi,
                            "cat_order": [ids[1], ids[0], "gibtsnicht", ids[1]]})
    assert (await client.receive_json())["success"]
    assert m.store_by_id(aldi)["cat_order"] == [ids[1], ids[0]]
    await client.send_json({"id": 2, "type": "einkaufsliste/group/update", "kind": "stores", "group_id": aldi, "cat_order": None})
    assert (await client.receive_json())["success"]
    assert m.store_by_id(aldi)["cat_order"] is None



async def test_recipe_import_blocks_home_network(hass, setup, hass_ws_client, aioclient_mock, monkeypatch):
    """🔒 Rezept-Link: kein Heimnetz – weder direkt, noch per Umleitung, Bild oder Namen mit privater IP."""
    from custom_components.einkaufsliste import recipe_import
    ips = {"rezepte.example.com": ["93.184.216.34"], "boese.example.com": ["192.168.1.10"], "img.example.com": ["93.184.216.35"]}
    monkeypatch.setattr(recipe_import, "_resolve", lambda host, port: ips.get(host, ["10.0.0.1"]))
    client = await hass_ws_client(hass)
    for n, url in enumerate(["http://192.168.1.1/x", "http://router/x", "http://[::ffff:127.0.0.1]/x", "https://boese.example.com/x"], 1):
        await client.send_json({"id": n, "type": "einkaufsliste/recipe/import", "text": url})
        assert not (await client.receive_json())["success"], url
    # Umleitung ins Heimnetz wird nicht verfolgt
    aioclient_mock.get("https://rezepte.example.com/weiter", status=302, headers={"Location": "http://192.168.1.1/admin"})
    await client.send_json({"id": 10, "type": "einkaufsliste/recipe/import", "text": "https://rezepte.example.com/weiter"})
    assert not (await client.receive_json())["success"]
    assert not any("192.168" in str(c[1]) for c in aioclient_mock.mock_calls)
    # Rezeptbild aus dem Heimnetz wird nicht geladen, das Rezept selbst schon
    page = """<script type="application/ld+json">{"@type":"Recipe","name":"Suppe","image":"https://boese.example.com/bild.jpg",
      "recipeIngredient":["1 Karotte"]}</script>"""
    aioclient_mock.get("https://rezepte.example.com/suppe", text=page)
    await client.send_json({"id": 11, "type": "einkaufsliste/recipe/import", "text": "https://rezepte.example.com/suppe"})
    res = await client.receive_json()
    assert res["success"] and res["result"]["image"] is None
    assert not any("boese" in str(c[1]) for c in aioclient_mock.mock_calls)


async def test_mail_and_sync_admin_only(hass: HomeAssistant, setup, hass_ws_client, hass_read_only_access_token) -> None:
    """🔒 E-Mail- und To-do-Abgleich einstellen dürfen nur Admins."""
    client = await hass_ws_client(hass, hass_read_only_access_token)
    for n, msg in enumerate([{"type": "einkaufsliste/mail/set", "entry_id": None},
                             {"type": "einkaufsliste/mail/sources"},
                             {"type": "einkaufsliste/todo_sync/set", "entity_id": "todo.x"}], 1):
        await client.send_json({"id": n, **msg})
        res = await client.receive_json()
        assert not res["success"] and res["error"]["code"] == "unauthorized", msg


async def test_move_to_anywhere_and_check_at_store(hass: HomeAssistant, setup) -> None:
    """🤷 Nach „Egal wo“ schieben, im Geschäft abhaken -> gehört dorthin; wieder drauf -> dort."""
    m = mgr(hass)
    edeka_like, netto = m.find_store("Aldi"), m.find_store("Netto")
    tee = m.add_item("Tee", store_id=netto)
    moved = m.move_item(tee["id"], None)
    assert moved["id"] == tee["id"] and moved["store_id"] is None and len([i for i in m.items if i["name"] == "Tee"]) == 1
    assert m.log[-1]["d"] == "Netto → Egal wo"
    m.set_checked(tee["id"], True, at_store=edeka_like)
    assert tee["checked"] and tee["store_id"] == edeka_like
    m.set_checked(tee["id"], False)
    assert not tee["checked"] and tee["store_id"] == edeka_like  # wieder drauf: da, wo zuletzt gekauft
    # alter abgehakter Eintrag im Geschäft wird ersetzt, nicht verdoppelt
    alt = m.add_item("Saft", store_id=edeka_like)
    m.set_checked(alt["id"], True)
    saft = m.add_item("Saft")
    m.set_checked(saft["id"], True, at_store=edeka_like)
    assert [i["id"] for i in m.items if i["name"] == "Saft"] == [saft["id"]]


async def test_offers_marktguru(hass: HomeAssistant, setup, aioclient_mock) -> None:
    """🏷️ Angebote: Schlüssel von der Webseite holen (nicht im Code), passende Angebote zu offenen Artikeln."""
    from custom_components.einkaufsliste import offers as mod
    m = mgr(hass)
    aldi = m.find_store("Aldi")
    assert mod.key_candidates('headers:{"x-apikey":"ABCDEFGHIJKLMNOP"}') == ["ABCDEFGHIJKLMNOP"]
    assert mod.matches("Butter", {"product": {"name": "Deutsche Markenbutter"}, "description": ""})
    assert not mod.matches("Milch", {"product": {"name": "Milchschnitte"}, "description": ""})
    assert mod.matches("Tomaten", {"product": {"name": "Rispentomate"}, "description": ""})
    with pytest.raises(ValueError):
        m.set_offers(True, "12")
    m.add_item("Butter", store_id=aldi)
    m.add_item("Zahnpasta")
    aioclient_mock.get("https://www.marktguru.de/", text='<html><script src="/app.js"></script></html>')
    aioclient_mock.get("https://www.marktguru.de/app.js", text='const c={apiKey:"GEHEIMERSCHLUESSEL1"}')
    offer = {"id": 7, "price": 1.79, "oldPrice": 2.49, "product": {"name": "Markenbutter"}, "brand": {"name": "Kerrygold"},
             "advertisers": [{"name": "ALDI SÜD"}], "validityDates": [{"from": "2026-01-01T00:00:00Z", "to": "2099-01-01T00:00:00Z"}],
             "description": "", "unit": {"shortName": "g"}, "volume": 250}
    other = {**offer, "id": 8, "price": 0.99, "advertisers": [{"name": "Lidl"}]}
    aioclient_mock.get("https://api.marktguru.de/api/v1/offers/search", json={"results": [offer, other]})
    with patch("custom_components.einkaufsliste.offers.asyncio.sleep"):
        m.set_offers(True, "48565", [aldi], 6)
        assert m.as_dict()["settings"]["offers"]["enabled"] and "key" not in m.as_dict()["settings"]["offers"]
        res = await m.offers.run()
    assert res["ok"]
    assert m.offers_cfg["key"] == "GEHEIMERSCHLUESSEL1"
    butter = m.as_dict()["offers"]["butter"]
    assert len(butter) == 1 and butter[0]["r"] == "ALDI SÜD" and butter[0]["p"] == 1.79 and butter[0]["op"] == 2.49  # nur Aldi
    m.set_offers(False)
    assert m.as_dict()["offers"] == {} and not m.as_dict()["settings"]["offers"]["enabled"]


async def test_offer_take_and_expire(hass: HomeAssistant, setup) -> None:
    """🛒 Angebot: eigener Artikel mit Angebots-Feld, Original abgehakt; abgelaufen -> Artikel weg, Original zurück."""
    from datetime import timedelta as td
    m = mgr(hass)
    aldi, netto = m.find_store("Aldi"), m.find_store("Netto")
    assert m.store_for_retailer("ALDI SÜD") == aldi and m.store_for_retailer("Kaufland") is None
    now = dt_util.utcnow()
    soon = (now + td(days=2)).isoformat()
    # Datumsregel: Start in der Zukunft -> „ab“, sonst „bis“
    assert " bis " in m.offer_note({"p": 1.19, "to": soon, "from": (now - td(days=1)).isoformat()})
    assert " ab " in m.offer_note({"p": 1.19, "to": soon, "from": (now + td(days=1)).isoformat()})
    # gleicher Name = dein Produkt: Angebot hängt daran, Notiz bleibt, nie gelöscht
    butter = m.add_item("Butter", store_id=netto, note="Irisch")
    same = m.take_offer({"p": 1.19, "to": soon, "r": "ALDI SÜD", "d": "Butter"}, item_id=butter["id"], store_id=aldi)
    assert same["store_id"] == aldi and same["note"] == "Irisch" and same["offer"]["p"] == 1.19 and not same.get("from_offer")
    # anderer Name: neuer Artikel, das ursprüngliche Produkt wird abgehakt
    kaffee = m.add_item("Kaffee", store_id=None)
    first = kaffee["added_at"]
    kaffee["added_at"] = "2026-09-20T10:00:00+00:00"
    jac = m.take_offer({"p": 4.99, "to": soon, "r": "Lidl", "d": "Jacobs Krönung"}, item_id=kaffee["id"], store_id=None)
    assert jac["name"] == "Jacobs Krönung" and jac["note"] is None and jac["from_offer"] and jac["offer"]["p"] == 4.99
    assert kaffee["checked"] and kaffee in m.items
    # „Angebote suchen“: offenes Produkt mit dem Suchnamen wird abgehakt, sonst nur der Angebotsartikel
    tee = m.add_item("Tee", store_id=None)
    m.take_offer({"p": 2.0, "to": soon, "r": "Lidl", "d": "Teekanne"}, name="Tee")
    assert tee["checked"]
    m.take_offer({"p": 3.0, "to": soon, "r": "Lidl", "d": "Eis"}, name="Gibtsnicht")
    # Ablauf: „vorbei“ bleibt 1 Tag
    assert m.expire_offers(now + td(days=3)) == 4
    assert same["offer"].get("expired") and jac["offer"].get("expired") and jac in m.items
    assert m.expire_offers(now + td(days=3, hours=12)) == 0 and jac in m.items
    # danach: Angebots-Artikel weg, dein Produkt zurück (mit altem Datum); dein Butter-Artikel bleibt, nur das Angebot fällt
    m.expire_offers(now + td(days=4, hours=1))
    assert jac not in m.items and "offer" not in same and same in m.items
    assert not kaffee["checked"] and kaffee["added_at"] == "2026-09-20T10:00:00+00:00"
    assert not tee["checked"]
    assert not any(i["name"] in ("Teekanne", "Eis") for i in m.items)
    # Abhaken eines Angebots-Artikels löscht ihn ganz, dein Produkt bleibt unter „Erledigt“
    jac2 = m.take_offer({"p": 4.99, "to": soon, "r": "Lidl", "d": "Jacobs Krönung"}, item_id=kaffee["id"], store_id=None)
    assert m.set_checked(jac2["id"], True).get("removed") and jac2 not in m.items and kaffee["checked"]
    plain = m.add_item("Mehl", store_id=netto)
    m.set_checked(plain["id"], True)
    assert plain in m.items and plain["checked"]
    m.set_checked(same["id"], True)
    assert same in m.items and same["checked"]  # dein Produkt mit Angebot: normal unter „Erledigt“


async def test_add_item_guesses_category_everywhere(hass, setup):
    """Ohne Kategorie (Angebote, Mail, Alexa …) rät Home Assistant selbst; Gewähltes bleibt."""
    m = mgr(hass)
    milch = m.find_category("Kühlregal & Milch")
    assert m.add_item("Joghurt")["category_id"] == milch  # Wörterbuch
    assert m.add_item("Joghurt", category_id=None, note="Bio")["category_id"] is None  # ausdrücklich „Ohne“
    other = next(c["id"] for c in m.categories if c["id"] != milch)
    assert m.add_item("Joghurt", category_id=other, note="x")["category_id"] == other  # selbst gewählt
    # „wie beim letzten Mal“ schlägt das Wörterbuch
    m.history["kekse"] = {"name": "Kekse", "category_id": other, "count": 1}
    assert m.add_item("Kekse")["category_id"] == other


async def test_purchases(hass, setup):
    """🧾 Einkaufs-Protokoll: nur wenn eingeschaltet; wer, wann, wo, wie viel."""
    m = mgr(hass)
    netto = m.stores[0]["id"]
    with pytest.raises(ValueError):
        m.add_purchase(netto, "12,50")  # aus = nichts geht
    m.set_spend(True)
    with m.acting("Marco", "u1", "card"):
        e = m.add_purchase(netto, "23,40")
    assert e["a"] == 23.4 and e["w"] == "Marco" and e["sn"] == m.stores[0]["name"]
    with pytest.raises(ValueError):
        m.add_purchase(netto, "abc")
    with pytest.raises(ValueError):
        m.add_purchase(netto, "0")
    with pytest.raises(ValueError):
        m.add_purchase("gibtsnicht", "5")
    with pytest.raises(ValueError):
        m.add_purchase(netto, "5", day="2999-01-01")
    old = m.add_purchase(netto, 7.5, day="2020-03-05")
    assert old["t"].startswith("2020-03-05")
    assert [x["a"] for x in m.get_purchases()["entries"]] == [23.4, 7.5]  # neueste zuerst
    assert m.log[-1]["a"] == "buy"
    m.remove_purchase(old["id"])
    assert len(m.purchases) == 1
    m.set_spend(False)  # aus: Einträge bleiben, sind aber nicht abrufbar
    assert len(m.purchases) == 1
    with pytest.raises(ValueError):
        m.get_purchases()
    assert m._to_storage()["purchases"] == m.purchases


# ------------------------------------------------------------------ v2.40: neue Funktionen

async def test_offer_without_end_expires_after_14_days(hass: HomeAssistant, setup) -> None:
    """🏷️ Angebot ohne Enddatum läuft nach 14 Tagen ab."""
    m = mgr(hass)
    it = m.add_item("Kaffee", store_id=None)
    jac = m.take_offer({"p": 4.99, "r": "Lidl", "d": "Jacobs"}, item_id=it["id"], store_id=None)
    assert jac["offer"].get("taken") and jac["orig"]["name"] == "Kaffee"
    now = dt_util.utcnow()
    assert m.expire_offers(now + timedelta(days=10)) == 0
    assert m.expire_offers(now + timedelta(days=15)) >= 1


async def test_error_log(hass: HomeAssistant, setup) -> None:
    """🐞 Fehler-Protokoll: gleiche Meldung zählt hoch, Limit, Leeren."""
    m = mgr(hass)
    m.log_error("x", "kaputt")
    m.log_error("x", "kaputt")
    m.log_error("y", "anders")
    got = m.get_errors()["errors"]
    assert got[0]["w"] == "y" and got[1]["n"] == 2
    assert m._to_storage()["errors"] == m.errors
    for i in range(100):
        m.log_error("z", f"e{i}")
    assert len(m.errors) <= 60
    assert m.clear_errors()["errors"] == []


async def test_import_table_csv(hass: HomeAssistant, setup) -> None:
    """🔁 Import aus CSV/TSV-Exporten (Beispieldaten, keine echten Bring!/AnyList-Exporte)."""
    from custom_components.einkaufsliste.transfer import import_text
    m = mgr(hass)
    csv_text = "Name,Menge,Notiz,Erledigt\nMilch,2 l,Bio,\nBrot,,,ja\nÄpfel,1 kg,,nein\n"
    assert import_text(m, csv_text) == {"added": 2, "skipped": 1}
    milch = next(i for i in m.items if i["name"] == "Milch")
    assert milch["quantity"].lower() == "2 l" and milch["note"] == "Bio"
    tsv = "Item\tSpecification\nEier\t10 Stück\n"
    assert import_text(m, tsv)["added"] == 1
    # normaler Text bleibt normaler Text
    assert import_text(m, "- Nudeln\n- Reis")["added"] == 2


async def test_merge_products(hass: HomeAssistant, setup) -> None:
    """🧲 Produkte zusammenführen."""
    m = mgr(hass)
    m.add_item("Tomaten", store_id=None)
    m.add_item("Tomate", store_id=None)
    res = await m.async_merge_products("tomaten", "tomate")
    assert res["into"]
    assert sum(1 for i in m.items if i["name"].lower().startswith("tomat") and not i["checked"]) == 1
    with pytest.raises(ValueError):
        await m.async_merge_products("tomate", "tomate")


async def test_photo_keys(hass: HomeAssistant, setup) -> None:
    from custom_components.einkaufsliste.manager import recipe_step_photo_key, purchase_photo_key
    assert recipe_step_photo_key("abc", 2) == "rezept#abc#s2"
    assert purchase_photo_key("p1") == "bon#p1"


async def test_seen_item_ack_pruned(hass: HomeAssistant, setup) -> None:
    """✨ „n:<Artikel>“ = angetippt; alte Merker (> 2 Tage) werden aufgeräumt."""
    m = mgr(hass)
    m.seen["u1"] = {"n:alt": (dt_util.utcnow() - timedelta(days=3)).isoformat()}
    m.mark_seen("u1", "n:neu")
    assert "n:neu" in m.seen["u1"] and "n:alt" not in m.seen["u1"]


async def test_health_summary(hass: HomeAssistant, setup) -> None:
    """🩺 Gesundheits-Ampel für den Sensor."""
    m = mgr(hass)
    res = await m.async_health()
    assert res["level"] in ("ok", "hinweis", "problem") and res["probleme"] >= 0
    m.log_error("x", "kaputt")
    res = await m.async_health()
    assert res["fehler_24h"] == 1 and res["level"] != "ok"
    state = hass.states.get("sensor.einkaufsliste_gesundheit")
    assert state is not None


async def test_spend_auto_option(hass: HomeAssistant, setup) -> None:
    m = mgr(hass)
    assert m.spend_auto is False
    m.set_spend_auto(True)
    assert m._to_storage()["spend_auto"] is True and m.as_dict()["settings"]["spend_auto"] is True


async def test_import_text_by_store(hass: HomeAssistant, setup) -> None:
    """📸 Zettel mit Geschäfts-Überschriften."""
    from custom_components.einkaufsliste.transfer import import_text_by_store
    m = mgr(hass)
    aldi, netto = m.find_store("Aldi"), m.find_store("Netto")
    res = import_text_by_store(m, "Aldi\nMilch\nBrot\nNetto:\nEier\nDM: Zahnpasta, Seife\nButter", netto)
    assert res["added"] == 6
    by = {i["name"]: i["store_id"] for i in m.items}
    assert by["Milch"] == aldi and by["Brot"] == aldi and by["Eier"] == netto
    assert by["Zahnpasta"] == m.find_store("DM") and by["Seife"] == m.find_store("DM")
    assert by["Butter"] == m.find_store("DM")  # gilt bis zur nächsten Überschrift


async def test_add_product_with_barcode(hass: HomeAssistant, setup) -> None:
    """📦▥ Neues Produkt im Katalog direkt mit Barcode anlegen."""
    m = mgr(hass)
    p = m.add_product("Nudeln", barcode="4001 234-567890")
    assert p["barcodes"] == ["4001234567890"]
    assert m.barcodes["4001234567890"]["name"] == "Nudeln"
    with pytest.raises(ValueError):
        m.add_product("Reis", barcode="4001234567890")  # Barcode gehört schon zu Nudeln
    with pytest.raises(ValueError):
        m.add_product("Mehl", barcode="abc")


async def test_products_last_bought(hass: HomeAssistant, setup) -> None:
    """🗓️ Katalog kennt „zuletzt abgehakt“ und „zuletzt eingetragen“."""
    m = mgr(hass)
    it = m.add_item("Butter", added_by="x")
    assert next(p for p in m.products() if p["name"] == "Butter")["last_bought"] is None
    m.set_checked(it["id"], True, by="x")
    p = next(p for p in m.products() if p["name"] == "Butter")
    assert p["last_bought"] and p["last_added"]


async def test_auto_shop_setting(hass: HomeAssistant, setup) -> None:
    """📍 Laden-Modus automatisch: ein Schalter für alle Geräte."""
    m = mgr(hass)
    assert m.auto_shop is False
    m.set_auto_shop(True)
    assert m._to_storage()["auto_shop"] is True and m.as_dict()["settings"]["auto_shop"] is True


def test_photo_complete_checks() -> None:
    from custom_components.einkaufsliste.netutil import photo_complete

    full = b"\xff\xd8\xff\xe0" + b"x" * 500 + b"\xff\xd9"
    assert photo_complete(full)
    assert not photo_complete(full[:300])  # abgeschnitten
    png = b"\x89PNG\r\n\x1a\n" + b"x" * 100 + b"\x00\x00\x00\x00IEND\xaeB`\x82"
    assert photo_complete(png) and not photo_complete(png[:60])
    webp = b"RIFF" + (100 - 8).to_bytes(4, "little") + b"WEBP" + b"x" * 88
    assert photo_complete(webp) and not photo_complete(webp[:50])
    assert not photo_complete(b"hallo")


async def test_read_limited_reads_all_chunks() -> None:
    from custom_components.einkaufsliste.netutil import read_limited

    class Stream:
        def __init__(self, parts):
            self.parts = parts

        async def iter_chunked(self, n):
            for p in self.parts:
                yield p

    assert await read_limited(Stream([b"ab", b"cd", b"ef"]), 100) == b"abcdef"  # nicht nur das erste Stück
    assert await read_limited(Stream([b"abc", b"def"]), 4) is None  # zu groß


async def test_cut_photos_found_and_refreshed(hass: HomeAssistant, setup, monkeypatch) -> None:
    import base64

    m = mgr(hass)
    full = b"\xff\xd8\xff\xe0" + b"x" * 500 + b"\xff\xd9"
    await m.async_set_photo("Wraps", base64.b64encode(full).decode())
    m.learn_barcode("4001234567890", "Wraps", None, None)
    # Foto auf der Festplatte abschneiden
    pid = m.photos["wraps"]["id"]
    path = m._photo_path(pid)
    path.write_bytes(full[:200])
    res = await m.async_check()
    assert any(f["id"] == "photo_cut:wraps" for f in res["items"])
    # Neu holen: Download vortäuschen
    import custom_components.einkaufsliste.barcode as bc

    async def fake(hass_, code):
        return full

    monkeypatch.setattr(bc, "_download_photo", fake)
    out = await bc.async_refresh_photo(hass, m, "wraps")
    assert out["count"] == 1
    assert m.photos["wraps"]["id"] != pid
    assert m._photo_path(m.photos["wraps"]["id"]).read_bytes() == full
    res = await m.async_check()
    assert not any(f["id"].startswith("photo_cut") for f in res["items"])
    # ohne Barcode: freundliche Fehlermeldung
    with pytest.raises(ValueError):
        await bc.async_refresh_photo(hass, m, "gibtsnicht")


async def test_refresh_all_photos_only_missing(hass: HomeAssistant, setup, monkeypatch) -> None:
    """🔄 „Alle Fotos neu holen“: nur fehlende/abgeschnittene Fotos, ganze bleiben, nichts kommt doppelt."""
    import base64

    import custom_components.einkaufsliste.barcode as bc

    m = mgr(hass)
    full = b"\xff\xd8\xff\xe0" + b"y" * 500 + b"\xff\xd9"
    m.learn_barcode("4001", "Milch", None, None)      # kein Foto
    m.learn_barcode("4002", "Butter", None, None)     # ganzes Foto
    m.learn_barcode("4003", "Wraps", None, None)      # abgeschnittenes Foto
    await m.async_set_photo("Butter", base64.b64encode(full).decode())
    await m.async_set_photo("Wraps", base64.b64encode(full).decode())
    m._photo_path(m.photos["wraps"]["id"]).write_bytes(full[:100])
    plan = await m.async_photo_refresh_plan()
    assert plan["total"] == 3
    assert sorted(plan["keys"]) == ["milch", "wraps"]

    async def fake(hass_, code):
        return full

    monkeypatch.setattr(bc, "_download_photo", fake)
    butter_id = m.photos["butter"]["id"]
    out = await bc.async_refresh_photo(hass, m, "butter", only_missing=True)
    assert out["added"] is False and m.photos["butter"]["id"] == butter_id and not m.photos["butter"].get("more")
    out = await bc.async_refresh_photo(hass, m, "milch", only_missing=True)
    assert out["added"] is True and m.photos["milch"]["id"]
    out = await bc.async_refresh_photo(hass, m, "wraps", only_missing=True)
    assert out["added"] is True
    assert (await m.async_photo_refresh_plan())["keys"] == []


async def test_duplicate_photo_finding(hass: HomeAssistant, setup) -> None:
    """🧹 „Alles ok?“ findet zwei Produkte mit genau demselben Foto und löscht auf Wunsch das doppelte."""
    import base64

    m = mgr(hass)
    one = base64.b64encode(b"\xff\xd8\xff\xe0" + b"a" * 300 + b"\xff\xd9").decode()
    two = base64.b64encode(b"\xff\xd8\xff\xe0" + b"b" * 300 + b"\xff\xd9").decode()
    await m.async_set_photo("Apfel", one)
    await m.async_set_photo("Birne", one)   # dasselbe Foto
    await m.async_set_photo("Kiwi", two)
    res = await m.async_check()
    dups = [f for f in res["items"] if f["id"].startswith("photo_dup:")]
    assert len(dups) == 1 and dups[0]["id"].startswith("photo_dup:birne:")
    await m.async_check(fix=True)
    assert "birne" not in m.photos and "apfel" in m.photos and "kiwi" in m.photos
    res = await m.async_check()
    assert not any(f["id"].startswith("photo_dup:") for f in res["items"])


async def test_todo_sync_multiple_lists(hass: HomeAssistant, setup) -> None:
    """🔁 Mehrere To-do-/Alexa-Listen: jede mit eigenem Geschäft und eigener Abgleich-Art."""
    m = mgr(hass)
    netto = next(x for x in m.stores if x["name"] == "Netto")
    aldi = next(x for x in m.stores if x["name"] == "Aldi")
    hass.states.async_set("todo.alexa_netto", "0", {"friendly_name": "Alexa Netto"})
    hass.states.async_set("todo.alexa_aldi", "0", {"friendly_name": "Alexa Aldi"})
    m.set_todo_sync("todo.alexa_netto", netto["id"], "move")
    m.set_todo_sync("todo.alexa_aldi", aldi["id"], "keep")
    infos = m.as_dict()["settings"]["todo_syncs"]
    assert [(i["entity_id"], i["store_id"], i["mode"]) for i in infos] == [
        ("todo.alexa_netto", netto["id"], "move"), ("todo.alexa_aldi", aldi["id"], "keep")]
    assert all("links" not in i for i in infos)
    m.set_todo_sync("todo.alexa_netto", None, "move")  # dieselbe Liste nochmal = ändern, nicht doppelt
    assert len(m.todo_syncs) == 2 and m.todo_syncs[0]["store_id"] is None
    with pytest.raises(ValueError):
        m.set_todo_sync("todo.gibts_nicht", None, "move")
    with pytest.raises(ValueError):
        m.remove_todo_sync("todo.gibts_nicht")
    m.remove_todo_sync("todo.alexa_aldi")
    assert [c["entity_id"] for c in m.todo_syncs] == ["todo.alexa_netto"]
    m.set_todo_sync(None)  # alter Weg: alles aus
    assert m.todo_syncs == []
    m.sync.stop()


async def test_check_findings_have_edit_and_choices(hass: HomeAssistant, setup) -> None:
    """🔧 „Alles ok?“: Funde bringen Sprungziel (✏️) und – wo es mehrere Wege gibt – eine Auswahl mit."""
    import base64

    m = mgr(hass)
    full = b"\xff\xd8\xff\xe0" + b"z" * 300 + b"\xff\xd9"
    await m.async_set_photo("Wraps", base64.b64encode(full).decode())
    m._photo_path(m.photos["wraps"]["id"]).write_bytes(full[:100])
    m.add_item("Seife")
    m.items[-1]["store_id"] = "gibtsnicht"
    res = await m.async_check()
    cut = next(f for f in res["items"] if f["id"] == "photo_cut:wraps")
    assert cut["edit"] == {"kind": "product", "id": "wraps"}
    assert [o["value"] for o in cut["options"]] == ["drop"] and cut["default"] == "drop"
    nostore = next(f for f in res["items"] if f["id"].startswith("nostore:"))
    assert nostore["edit"]["kind"] == "item"
    # gewählte Reparatur: „nur löschen“
    await m.async_check(fixes={"photo_cut:wraps": "drop"})
    assert "wraps" not in m.photos


async def test_check_ignores_egal_wo_items(hass: HomeAssistant, setup) -> None:
    """„Alles ok?“: Artikel ohne Geschäft („Egal wo“) sind kein Fehler – nur ein nicht mehr vorhandenes Geschäft."""
    m = mgr(hass)
    m.add_item("Kakao")
    m.add_item("Seife")
    m.items[-1]["store_id"] = "gibtsnicht"
    res = await m.async_check()
    ids = [f["id"] for f in res["items"] if f["id"].startswith("nostore:")]
    kakao = next(i for i in m.items if i["name"] == "Kakao")
    seife = next(i for i in m.items if i["name"] == "Seife")
    assert f"nostore:{kakao['id']}" not in ids
    assert f"nostore:{seife['id']}" in ids


async def test_undo_keeps_original_date(hass: HomeAssistant, setup, freezer) -> None:
    """↩️ Rückgängig behält Datum + Eintrager; normales Wieder-Draufsetzen bekommt das neue Datum."""
    m = mgr(hass)
    item = m.add_item("Milch", added_by="Marco")
    old = item["added_at"]
    m.set_checked(item["id"], True, "Sandra")
    freezer.tick(86400 * 2)
    m.set_checked(item["id"], False, "Sandra", None, None, True)
    got = m.get_item(item["id"])
    assert got["checked"] is False and got["added_at"] == old and got["added_by"] == "Marco"
    m.set_checked(item["id"], True, "Sandra")
    m.set_checked(item["id"], False, "Sandra")
    assert m.get_item(item["id"])["added_at"] != old


async def test_refresh_all_replaces_db_photo_keeps_own(hass: HomeAssistant, setup, monkeypatch) -> None:
    """🔄 „Alle Fotos neu holen“ (replace): Datenbank-Foto wird ersetzt, eigene Fotos bleiben, gleiches Foto = unverändert."""
    import base64

    import custom_components.einkaufsliste.barcode as bc

    m = mgr(hass)
    old = b"\xff\xd8\xff\xe0" + b"o" * 400 + b"\xff\xd9"
    new = b"\xff\xd8\xff\xe0" + b"n" * 400 + b"\xff\xd9"
    own = b"\xff\xd8\xff\xe0" + b"e" * 400 + b"\xff\xd9"
    m.learn_barcode("5001", "Milch", None, None)
    m.learn_barcode("5002", "Butter", None, None)
    # Milch: Datenbank-Foto (markiert) + eigenes Foto
    await m.async_set_photo("Milch", base64.b64encode(old).decode(), db=True)
    await m.async_set_photo("Milch", base64.b64encode(own).decode(), add=True)
    box = {"raw": new}

    async def fake(hass_, code):
        return box["raw"]

    monkeypatch.setattr(bc, "_download_photo", fake)
    out = await bc.async_refresh_photo(hass, m, "milch", replace=True)
    assert out["status"] == "replaced"
    ids = m._photo_ids(m.photos["milch"])
    assert len(ids) == 2
    assert m._photo_path(ids[0]).read_bytes() == new      # an derselben Stelle (Hauptfoto)
    assert m._photo_path(ids[1]).read_bytes() == own      # eigenes Foto bleibt
    out = await bc.async_refresh_photo(hass, m, "milch", replace=True)
    assert out["status"] == "same" and len(m._photo_ids(m.photos["milch"])) == 2
    # Butter: noch gar kein Foto -> neu dazu, danach „unverändert“
    out = await bc.async_refresh_photo(hass, m, "butter", replace=True)
    assert out["status"] == "added"
    assert (await bc.async_refresh_photo(hass, m, "butter", replace=True))["status"] == "same"
    plan = await m.async_photo_refresh_plan()
    assert sorted(plan["all"]) == ["butter", "milch"] and plan["names"]["milch"] == "Milch"


async def test_mail_initial_false_is_imported_once(hass: HomeAssistant, setup) -> None:
    """📧 HA schickt manche neue Mails mit „initial: false“ – die werden trotzdem eingetragen, aber nur einmal."""
    from datetime import datetime, timedelta, timezone

    m = mgr(hass)
    imap = MockConfigEntry(domain="imap", title="liste@example.com")
    imap.add_to_hass(hass)
    m.set_mail_import(imap.entry_id, None, ["ich@example.com"], "keep")
    now = datetime.now(timezone.utc)

    def fire(uid, text, initial, date):
        hass.bus.async_fire("imap_content", {
            "entry_id": imap.entry_id, "initial": initial, "uid": uid, "date": date, "subject": "",
            "sender": '"ich" <ich@example.com>', "text": text, "parts": {}})

    fire("10", "Kakao\nButter", False, now)
    await hass.async_block_till_done()
    assert {i["name"] for i in m.items} >= {"Kakao", "Butter"}
    assert "10|" + str(now) in m.mail_seen
    count = len(m.items)
    fire("10", "Kakao\nButter", False, now)       # HA schickt dieselbe Mail nochmal
    await hass.async_block_till_done()
    assert len(m.items) == count and m.mail_import["count"] == 2  # zählt Artikel, nicht Mails
    fire("9", "Honig", False, now - timedelta(days=5))  # alte, nur aufgewärmte Mail
    await hass.async_block_till_done()
    assert not any(i["name"] == "Honig" for i in m.items)
    fire("11", "Honig", True, now - timedelta(days=5))  # echte neue Mail (initial: true) geht immer
    await hass.async_block_till_done()
    assert any(i["name"] == "Honig" for i in m.items)


# ---------------------------------------------------------------- Regressionen (sichere Bugfixes)
async def test_offer_dates_without_timezone_do_not_crash(hass, setup):
    m = mgr(hass)
    assert isinstance(m.offer_note({"p": 1.19, "to": "2026-10-05"}), str)
    assert "bis" in m.offer_note({"p": 1.19, "to": "2026-10-05", "from": "2026-09-01T00:00:00"})
    a = m.add_item("Kaffee")
    b = m.add_item("Tee")
    a["offer"] = {"to": "2000-01-01", "p": 1}
    b["offer"] = {"to": "kaputt", "taken": 5, "p": 1}
    assert m.expire_offers() >= 1  # kein TypeError, der kaputte Eintrag blockiert nichts
    assert "expired" in a["offer"]


async def test_take_offer_without_store_keeps_store(hass, setup):
    m = mgr(hass)
    sid = m.stores[0]["id"]
    item = m.add_item("Butter", store_id=sid)
    m.take_offer({"d": "Butter", "r": "X", "p": 1.0, "to": None}, item_id=item["id"])
    assert m.get_item(item["id"])["store_id"] == sid


async def test_remove_recipe_keeps_open_item_with_checked_twin(hass, setup):
    m = mgr(hass)
    r = m.add_recipe("Kuchen", items=[{"name": "Mehl"}])
    m.apply_recipe(r["id"])
    twin = m.add_item("Mehl")
    m.set_checked(twin["id"], True)
    m.remove_recipe(r["id"])
    open_mehl = [i for i in m.items if i["name"] == "Mehl" and not i["checked"]]
    assert len(open_mehl) == 1
    assert len([i for i in m.items if i["name"] == "Mehl"]) == 1


async def test_update_product_collision_and_case_rename(hass, setup):
    m = mgr(hass)
    m.add_item("milch")
    m.add_item("Sahne")
    with pytest.raises(ValueError, match="Zusammenführen"):
        m.update_product("milch", name="Sahne")
    m.update_product("milch", name="Milch")
    assert m.history["milch"]["name"] == "Milch"


async def test_manual_add_clears_offer_flags(hass, setup):
    m = mgr(hass)
    item = m.take_offer({"d": "Pesto", "r": "Rewe", "p": 1.0, "to": "2026-12-01"})
    assert item.get("from_offer")
    again = m.add_item("Pesto")
    assert again["id"] == item["id"]
    assert not again.get("from_offer") and not again.get("offer") and not again.get("orig")


async def test_store_for_retailer_prefers_exact_and_longest(hass, setup):
    m = mgr(hass)
    m.stores = [{"id": "a", "name": "Aldi"}, {"id": "b", "name": "Aldi Süd"}]
    assert m.store_for_retailer("ALDI SÜD") == "b"
    assert m.store_for_retailer("Aldi") == "a"


async def test_update_recipe_invalid_leaves_recipe_unchanged(hass, setup):
    m = mgr(hass)
    r = m.add_recipe("Suppe", items=[{"name": "Wasser"}])
    with pytest.raises(ValueError):
        m.update_recipe(r["id"], name="Brühe", items=[{"name": "Salz"}, {"name": "salz"}])
    assert m.recipe_by_id(r["id"])["name"] == "Suppe"


async def test_replace_main_photo_keeps_db_marker(hass, setup):
    import base64
    m = mgr(hass)
    jpg = base64.b64encode(b"\xff\xd8\xff" + b"0" * 20).decode()
    await m.async_set_photo("Käse", jpg)
    await m.async_set_photo("Käse", jpg, add=True, db=True)
    entry = m.photos["käse"]
    extra = entry["more"][0]
    assert entry["db"] == [extra]
    await m.async_set_photo("Käse", jpg)  # Hauptfoto ersetzen
    assert m.photos["käse"].get("db") == [extra]
    await m.async_remove_photo("Käse", 1)
    assert not m.photos["käse"].get("db")


async def test_todo_sync_long_text_truncated_and_failed_not_deleted(hass, setup):
    m = mgr(hass)
    long = "x" * 120
    sync = m.sync
    entity = "todo.alexa"
    hass.states.async_set(entity, "1", {"friendly_name": "Alexa"})
    calls = []

    async def get_items(call):
        return {entity: {"items": [{"uid": "1", "summary": long}, {"uid": "2", "summary": "  "}]}}

    async def remove_item(call):
        calls.append(call.data["item"])

    from homeassistant.core import SupportsResponse
    hass.services.async_register("todo", "get_items", get_items, supports_response=SupportsResponse.ONLY)
    hass.services.async_register("todo", "remove_item", remove_item)
    await sync._once({"entity_id": entity, "mode": "move"})
    assert any(i["name"].startswith("X") and len(i["name"]) <= 80 for i in m.items)
    assert calls and set(calls[0]) == {"1", "2"}


def test_mail_text_is_capped():
    from custom_components.einkaufsliste.mail_import import MAX_MAIL_CHARS, mail_text
    text = "Milch\n" + "x\n" * MAX_MAIL_CHARS
    assert len(mail_text(text).split("\n")) <= 60


async def test_own_note(hass, setup):
    """✏️ Eigene Notiz: bleibt beim Produkt, ist nicht Teil des Namens, wird vorgeschlagen und im Katalog änderbar."""
    m = mgr(hass)
    a = m.add_item("Kaffee", note="Bohnen", own_note="nur die große Packung")
    assert a["own_note"] == "Nur die große Packung" and a["note"] == "Bohnen"
    assert m.own_notes["kaffee|bohnen"] == "Nur die große Packung"
    # nochmal ohne eigene Notiz: die vom letzten Mal kommt wieder mit
    m.set_checked(a["id"], True)
    b = m.add_item("Kaffee", note="Bohnen")
    assert b["id"] == a["id"] and b["own_note"] == "Nur die große Packung"
    # eigene Notiz trennt keine Artikel: kein zweiter Eintrag
    assert len([i for i in m.items if i["name"] == "Kaffee"]) == 1
    # am Artikel ändern / leeren
    m.update_item(a["id"], own_note="Fair gehandelt")
    assert m.get_item(a["id"])["own_note"] == "Fair gehandelt"
    assert m.own_notes["kaffee|bohnen"] == "Fair gehandelt"
    m.update_item(a["id"], own_note="")
    assert not m.get_item(a["id"]).get("own_note") and "kaffee|bohnen" not in m.own_notes
    # im Katalog setzen: Produkt + Artikel
    p = m.update_product("kaffee|bohnen", own_note="Nur Arabica")
    assert p["own_note"] == "Nur Arabica"
    assert m.get_item(a["id"])["own_note"] == "Nur Arabica"
    m.update_product("kaffee|bohnen", own_note="")
    assert not m.get_item(a["id"]).get("own_note")


async def test_note_move_to_own(hass, setup):
    """„Notiz → ✏️“: alte Notiz wandert in die Eigene Notiz, das Produkt verliert die 📝 Notiz."""
    m = mgr(hass)
    a = m.add_item("Kaffee", note="Bohnen")
    m.update_product("kaffee|bohnen", note="", own_note="Arabica · Bohnen")
    it = m.get_item(a["id"])
    assert not it.get("note") and it["own_note"] == "Arabica · Bohnen"
    assert m.own_notes["kaffee"] == "Arabica · Bohnen"


async def test_refresh_replace_removes_identical_duplicates(hass: HomeAssistant, setup, monkeypatch) -> None:
    """Gleiches Datenbank-Foto mehrfach (alter Fehler) -> beim Neuholen bleibt nur eines, eigenes Foto bleibt."""
    import base64

    import custom_components.einkaufsliste.barcode as bc

    m = mgr(hass)
    db = b"\xff\xd8\xff\xe0" + b"d" * 400 + b"\xff\xd9"
    own = b"\xff\xd8\xff\xe0" + b"e" * 400 + b"\xff\xd9"
    m.learn_barcode("6001", "Quark", None, None)
    await m.async_set_photo("Quark", base64.b64encode(db).decode(), db=True)
    await m.async_set_photo("Quark", base64.b64encode(db).decode(), add=True)   # Doppelte (wie früher)
    await m.async_set_photo("Quark", base64.b64encode(db).decode(), add=True)
    await m.async_set_photo("Quark", base64.b64encode(own).decode(), add=True)
    assert len(m._photo_ids(m.photos["quark"])) == 4

    async def fake(hass_, code):
        return db

    monkeypatch.setattr(bc, "_download_photo", fake)
    out = await bc.async_refresh_photo(hass, m, "quark", replace=True)
    assert out["status"] == "same"
    ids = m._photo_ids(m.photos["quark"])
    assert len(ids) == 2
    assert sorted(m._photo_path(i).read_bytes() for i in ids) == sorted([db, own])
    # nochmal: nichts ändert sich
    assert (await bc.async_refresh_photo(hass, m, "quark", replace=True))["status"] == "same"
    assert len(m._photo_ids(m.photos["quark"])) == 2


async def test_add_product_barcode(hass: HomeAssistant, setup) -> None:
    """📦 Barcode nachträglich im Katalog: speichert, erkennt Doppelte, lehnt Unsinn ab."""
    m = mgr(hass)
    m.add_item("Kaffee", note="Bohnen")
    res = m.add_product_barcode("kaffee|bohnen", "4006-3813 33931")
    assert res["code"] == "4006381333931"
    bc = m.barcodes["4006381333931"]
    assert bc["name"] == "Kaffee" and bc["note"] == "Bohnen"
    assert "4006381333931" in next(p for p in m.products() if p["key"] == "kaffee|bohnen")["barcodes"]
    m.add_product_barcode("kaffee|bohnen", "4006381333931")  # gleicher Barcode beim gleichen Produkt: kein Fehler
    m.add_item("Tee")
    with pytest.raises(ValueError):
        m.add_product_barcode("tee", "4006381333931")  # gehört schon zu Kaffee
    with pytest.raises(ValueError):
        m.add_product_barcode("tee", "12")
    with pytest.raises(ValueError):
        m.add_product_barcode("gibtsnicht", "4006381333900")


async def test_alias_for_several_products(hass: HomeAssistant, setup) -> None:
    """🏷️ Ein Spitzname darf zu mehreren Produkten gehören."""
    m = mgr(hass)
    m.add_item("Batterien", note="AA")
    m.add_item("Batterien", note="AAA")
    m.set_aliases("batterien|aa", ["Akku"])
    m.set_aliases("batterien|aaa", ["Akku"])
    rows = [r for r in m.as_dict()["aliases"] if r["alias"] == "akku"]
    assert sorted(r["note"] for r in rows) == ["AA", "AAA"]
    assert "akku" in next(p for p in m.products() if p["key"] == "batterien|aa")["aliases"]
    assert "akku" in next(p for p in m.products() if p["key"] == "batterien|aaa")["aliases"]
    m.update_product("batterien|aa", note="AA 1,5V")  # Umbenennen zieht den Spitznamen mit
    assert "akku" in next(p for p in m.products() if p["key"] == "batterien|aa 1,5v")["aliases"]
    m.set_aliases("batterien|aaa", [])  # nur dieses Produkt verliert ihn
    rows = [r for r in m.as_dict()["aliases"] if r["alias"] == "akku"]
    assert [r["note"] for r in rows] == ["AA 1,5V"]


async def test_item_edit_sets_aliases(hass: HomeAssistant, setup) -> None:
    """🏷️ Beim Bearbeiten eines Artikels lassen sich Spitznamen setzen; Umbenennen zieht sie mit."""
    m = mgr(hass)
    it = m.add_item("Taschentücher")
    m.update_item(it["id"], aliases=["Tempos", "Tempo"])
    prod = next(p for p in m.products() if p["key"] == "taschentücher")
    assert sorted(prod["aliases"]) == ["tempo", "tempos"]
    m.update_item(it["id"], name="Papiertücher")  # ohne aliases: Spitznamen bleiben beim alten Namen unangetastet
    m.update_item(it["id"], name="Taschentücher", aliases=["Tempos"])
    prod = next(p for p in m.products() if p["key"] == "taschentücher")
    assert prod["aliases"] == ["tempos"]
    m.update_item(it["id"], name="Tücher", aliases=["Tempos"])  # umbenannt + Spitznamen mitgeschickt
    assert "tempos" in next(p for p in m.products() if p["key"] == "tücher")["aliases"]
    m.update_item(it["id"], aliases=[])
    assert next(p for p in m.products() if p["key"] == "tücher")["aliases"] == []


async def test_own_note_per_variant(hass: HomeAssistant, setup) -> None:
    """✏️ Eigene Notiz hängt pro Variante (Name + Notiz): Batterien AA und AAA getrennt; alte Namens-Notiz wird verteilt."""
    m = mgr(hass)
    m.learn_barcode("111", "Batterien", None, None, "AA")
    m.learn_barcode("222", "Batterien", None, None, "AAA")
    m.update_product("batterien|aa", own_note="für die Fernbedienung")
    m.update_product("batterien|aaa", own_note="Schublade im Flur")
    prods = {p["key"]: p for p in m.products()}
    assert prods["batterien|aa"]["own_note"] == "Für die Fernbedienung"
    assert prods["batterien|aaa"]["own_note"] == "Schublade im Flur"
    a = m.add_item("Batterien", note="AAA")
    assert a["own_note"] == "Schublade im Flur"
    m.update_product("batterien|aa", own_note="")  # löscht nur bei AA
    assert m.own_notes["batterien|aaa"] == "Schublade im Flur"
    # alte Daten: Notiz hing am Namen -> beide Varianten bekommen sie
    m.history["batterien"]["own_note"] = "Alter Zettel"
    m.own_notes.clear()
    m._migrate_own_notes()
    assert m.own_notes["batterien|aa"] == "Alter Zettel" and m.own_notes["batterien|aaa"] == "Alter Zettel"
    assert "own_note" not in m.history["batterien"]


async def test_auto_photo_follows_rename(hass: HomeAssistant, setup, monkeypatch) -> None:
    """📸 Wird das Produkt während des Foto-Downloads umbenannt, landet das Foto beim neuen – kein Geister-Produkt."""
    import custom_components.einkaufsliste.barcode as bc

    m = mgr(hass)
    m.add_item("Cornflakes", note="Nougat Bitu")
    m.add_product_barcode("cornflakes|nougat bitu", "4006381333931")
    jpg = b"\xff\xd8\xff\xe0" + b"x" * 400 + b"\xff\xd9"

    async def fake(hass_, code):
        m.update_product("cornflakes|nougat bitu", note="Nougat Bits")  # „Daten übernehmen“ während des Downloads
        return jpg

    monkeypatch.setattr(bc, "_download_photo", fake)
    assert await bc.async_auto_photo(hass, m, "4006381333931", "cornflakes|nougat bitu")
    keys = [p["key"] for p in m.products()]
    assert keys == ["cornflakes|nougat bits"]
    assert m.products()[0]["photos"] == 1


async def test_add_product_same_name_with_note(hass: HomeAssistant, setup) -> None:
    """📦 Katalog ➕: „Batterien“ gibt es schon -> mit Eigener Notiz zum Unterscheiden anlegen, so oft man will."""
    m = mgr(hass)
    m.add_product("Batterien")
    with pytest.raises(ValueError):
        m.add_product("Batterien")  # ohne Notiz: gibt es schon
    p = m.add_product("Batterien", note="AAA")
    assert p["key"] == "batterien|aaa"
    m.add_product("Batterien", note="AA")
    with pytest.raises(ValueError):
        m.add_product("batterien", note="aa")
    keys = [x["key"] for x in m.products() if x["name"] == "Batterien"]
    assert sorted(keys) == ["batterien|aa", "batterien|aaa"]  # der nackte Name steckt hinter den Varianten
    m.update_product("batterien|aaa", note="AAA 4er")  # Umbenennen zieht die Variante mit
    assert "batterien|aaa 4er" in [x["key"] for x in m.products()] and "batterien|aaa" not in [x["key"] for x in m.products()]
    m.add_product("Batterien", note="9V", barcode="4006381333931")
    assert m.barcodes["4006381333931"]["note"] == "9V"
    await m.async_forget_product("batterien|aa")
    assert "batterien|aa" not in [x["key"] for x in m.products()]


async def test_own_note_is_identity_without_barcode(hass: HomeAssistant, setup) -> None:
    """✏️ Eigene Notiz = Erkennungsmerkmal bei Produkten ohne Barcode; mit Barcode bleibt sie getrennt."""
    m = mgr(hass)
    a = m.add_item("Batterien", own_note="AA")
    b = m.add_item("Batterien", own_note="AAA")
    assert a["id"] != b["id"] and a["note"] == "AA" and b["note"] == "AAA"
    assert not a.get("own_note")
    again = m.add_item("Batterien", own_note="AA")
    assert again["id"] == a["id"]  # gleiche Notiz = dasselbe Produkt
    # Bearbeiten: neue Eigene Notiz bei Artikel ohne Notiz wird Erkennungsmerkmal
    c = m.add_item("Kerzen")
    m.update_item(c["id"], own_note="Weiß")
    assert m.get_item(c["id"])["note"] == "Weiß"
    # mit Barcode: bleibt Eigene Notiz, kein neues Produkt
    m.learn_barcode("4006381333931", "Cola", None, None)
    d = m.add_item("Cola", own_note="Für Marco")
    assert not d.get("note") and d["own_note"] == "Für Marco"


async def test_own_note_known_stays_on_product(hass: HomeAssistant, setup) -> None:
    """Hat das Produkt die Eigene Notiz schon (alte Daten), macht erneutes Eintragen kein zweites Produkt daraus."""
    m = mgr(hass)
    a = m.add_item("Kaffee")
    m.update_product("kaffee", own_note="Fair gehandelt")
    b = m.add_item("Kaffee", own_note="Fair gehandelt")
    assert b["id"] == a["id"] and not b.get("note")


async def test_own_notes_in_state(hass: HomeAssistant, setup) -> None:
    """✏️ Eigene Notizen stehen im Zustand, damit alle Suchen in der Karte danach suchen können."""
    m = mgr(hass)
    m.learn_barcode("333", "Batterie", None, None, "9V Block")
    m.update_product("batterie|9v block", own_note="Rauchmelder")
    assert m.as_dict()["own_notes"]["batterie|9v block"] == "Rauchmelder"


async def test_catalog_in_state_and_clash_message(hass: HomeAssistant, setup) -> None:
    """Ganzer Katalog steht im Zustand (für Vorschläge); „gibt es schon“ nennt die Notiz."""
    m = mgr(hass)
    m.add_product("Batterien", note="9V Block")
    m.add_product("Batterien", note="AA")
    cat = m.as_dict()["catalog"]
    assert {"Batterien|9V Block", "Batterien|AA"} <= {f"{c['name']}|{c['note']}" for c in cat}
    with pytest.raises(ValueError, match="Batterien – AA"):
        m.update_product("batterien|9v block", note="AA")


async def test_old_notes_to_own_notes_no_clash(hass: HomeAssistant, setup) -> None:
    """Zwei Produkte gleichen Namens: alte Notiz löschen + als Eigene Notiz eintragen führt nicht zu „gibt es schon“."""
    m = mgr(hass)
    m.add_item("Batterien", note="AA")
    m.add_item("Batterien", note="AAA")
    # 1. Produkt: alte Notiz löschen, speichern – dann Eigene Notiz eintragen
    m.update_product("batterien|aa", note="")
    m.update_product("batterien", own_note="AA")
    keys = {p["key"] for p in m.products()}
    assert "batterien|aa" in keys and "batterien" not in keys
    # 2. Produkt: dasselbe – kein Zusammenstoß mit dem ersten
    m.update_product("batterien|aaa", note="")
    m.update_product("batterien", own_note="AAA")
    keys = {p["key"] for p in m.products()}
    assert {"batterien|aa", "batterien|aaa"} <= keys
    # Name nur einmal: Eigene Notiz bleibt Eigene Notiz (keine Variante)
    m.add_item("Kaffee")
    m.update_product("kaffee", own_note="Fair")
    assert "kaffee" in {p["key"] for p in m.products()}


async def test_offers_alt_type(hass: HomeAssistant, setup) -> None:
    """🔀 Barcode-Artikel ohne eigenes Angebot: Angebote für den Typ („Proteinriegel“), höchstens 4, als „Andere Marke“."""
    from custom_components.einkaufsliste import barcode as bc
    from custom_components.einkaufsliste import offers as mod
    assert bc.product_type({"generic_name_de": "Proteinriegel"}, "Erdbeer Max Balance") == "Proteinriegel"
    assert bc.product_type({"categories_tags": ["en:snacks", "de:protein-riegel"]}) == "protein riegel"
    assert bc.product_type({"generic_name_de": "Erdbeer Max Balance"}, "Erdbeer Max Balance") is None
    m = mgr(hass)
    m.learn_barcode("4001234567890", "Erdbeer Max Balance", None, None, "Eat Me!")
    m.add_item("Erdbeer Max Balance", note="Eat Me!")
    base = {"price": 1.0, "advertisers": [{"name": "Lidl"}], "description": "",
            "validityDates": [{"from": "2026-01-01T00:00:00Z", "to": "2099-01-01T00:00:00Z"}]}
    riegel = [{**base, "id": n, "price": 1.0 + n / 10, "product": {"name": "Proteinriegel Schoko"}} for n in range(6)]

    async def fake_search(session, dom, key, query, zip_code, limit=20):
        return riegel if query == "Proteinriegel" else []

    async def fake_type(hass_, code, name=None):
        return "Proteinriegel"
    with patch("custom_components.einkaufsliste.offers.asyncio.sleep"), \
         patch.object(mod.Offers, "_search", side_effect=fake_search), \
         patch("custom_components.einkaufsliste.barcode.async_product_type", side_effect=fake_type):
        m.offers_cfg = {"enabled": True, "zip": "48565", "key": "K", "stores": [], "hours": 6}
        res = await m.offers._run(m.offers_cfg)
    assert res["ok"]
    got = m.offers_data["erdbeer max balance"]
    assert len(got) == 4 and all("Proteinriegel" in o["alt"] for o in got) and got[0]["p"] == 1.0
    assert m.barcodes["4001234567890"]["type"] == "Proteinriegel"


async def test_offers_words_and_category(hass: HomeAssistant, setup) -> None:
    """🔤 „H-Milch“: Namen in Wörter zerlegen, einzeln suchen („Milch“), nach Treffern + Kategorie bewerten, höchstens 4."""
    from custom_components.einkaufsliste import offers as mod
    assert mod.name_words("H-Milch 3,5% Weihenstephan 1L") == ["milch", "weihenstephan"]
    assert mod.name_words("Eat Me! Erdbeer Max Balance") == ["erdbeer", "balance"]
    m = mgr(hass)
    cat = next(c for c in m.categories if c["name"] != "")
    m.add_item("H-Milch", category_id=cat["id"])
    base = {"advertisers": [{"name": "Lidl"}], "description": "",
            "validityDates": [{"from": "2026-01-01T00:00:00Z", "to": "2099-01-01T00:00:00Z"}]}
    milch = [{**base, "id": n, "price": 2.0 - n / 10, "product": {"name": "Frische Vollmilch"}} for n in range(6)]
    queries: list[str] = []

    async def fake_search(session, dom, key, query, zip_code, limit=20):
        queries.append(query)
        return milch if query == "milch" else []
    with patch("custom_components.einkaufsliste.offers.asyncio.sleep"), \
         patch.object(mod.Offers, "_search", side_effect=fake_search):
        m.offers_cfg = {"enabled": True, "zip": "48565", "key": "K", "stores": [], "hours": 6}
        res = await m.offers._run(m.offers_cfg)
    assert res["ok"]
    got = m.offers_data["h-milch"]
    assert "H-Milch" in queries and queries.index("H-Milch") < len(queries) - 1
    assert len(got) == 4 and all(o["alt"] == "Milch" for o in got) and got[0]["p"] == 1.5


def test_nice_hyphen_words():
    from custom_components.einkaufsliste.manager import _nice

    assert _nice("h-milch") == "H-Milch"
    assert _nice("coca-cola") == "Coca-Cola"
    assert _nice("ben-und-jerry") == "Ben-und-Jerry"
    assert _nice("iPhone-case") == "iPhone-case"  # groß/gemischt getippt bleibt
    assert _nice("  t-shirt ") == "T-Shirt"


async def test_offer_take_extra_keeps_my_product(hass: HomeAssistant, setup) -> None:
    """🔀 Ähnliches Angebot „zusätzlich“: dein Produkt bleibt offen, Angebots-Artikel kommt dazu und geht mit dem Angebot wieder."""
    from datetime import timedelta as td
    m = mgr(hass)
    now = dt_util.utcnow()
    soon = (now + td(days=2)).isoformat()
    milch = m.add_item("H-Milch", store_id=None)
    off = m.take_offer({"p": 0.99, "to": soon, "r": "Lidl", "d": "Frische Vollmilch"}, item_id=milch["id"], store_id=None, extra=True)
    assert off["name"] == "Frische Vollmilch" and off["from_offer"] and "orig" not in off
    assert not milch["checked"] and milch in m.items  # dein Produkt bleibt offen
    m.expire_offers(now + td(days=3))
    m.expire_offers(now + td(days=4, hours=1))
    assert off not in m.items  # Angebots-Artikel ist weg
    assert milch in m.items and not milch["checked"]  # dein Produkt unverändert
    # zum Vergleich „ersetzen“: Original wird abgehakt
    kaffee = m.add_item("Kaffee", store_id=None)
    jac = m.take_offer({"p": 4.99, "to": soon, "r": "Lidl", "d": "Jacobs"}, item_id=kaffee["id"], store_id=None)
    assert kaffee["checked"] and jac["orig"]["name"] == "Kaffee"


async def test_privacy_switch(hass: HomeAssistant, setup) -> None:
    """🔒 Datenschutz-Schalter: gilt für alle, steht im Zustand und bleibt nach dem Neustart."""
    m = mgr(hass)
    assert m.as_dict()["settings"]["privacy"] is False
    m.set_privacy(True)
    assert m.as_dict()["settings"]["privacy"] is True
    assert m._to_storage()["privacy"] is True
    m.set_privacy(False)
    assert m.as_dict()["settings"]["privacy"] is False


async def test_grocy_import(hass, setup, hass_ws_client, hass_read_only_access_token, aioclient_mock):
    """🥫 Grocy-Import: Vorschau (Schlüssel im Header, nicht gespeichert), Auswahl, Katalog, Barcodes, Kategorien."""
    from custom_components.einkaufsliste.grocy_import import clean_base
    assert clean_base("192.168.1.5:9283/api/") == "http://192.168.1.5:9283"
    assert clean_base("https://grocy.example.org/") == "https://grocy.example.org"
    assert clean_base("http://grocy.local/grocy/api") == "http://grocy.local/grocy"
    for bad in ("", "ftp://x", "http://user:pw@host/"):
        with pytest.raises(ValueError):
            clean_base(bad)
    m = mgr(hass)
    m.add_item("Milch")  # gibt es schon
    base = "http://grocy.local:9283/api/objects"
    aioclient_mock.get(f"{base}/products", json=[
        {"id": "1", "name": "Cookies", "product_group_id": "1"},
        {"id": "2", "name": "Milch", "product_group_id": "2"},
        {"id": "3", "name": "  Nudeln   Spaghetti ", "product_group_id": None, "active": "1"},
        {"id": "4", "name": "Altlast", "active": "0"},
        {"id": "5", "name": ""},
    ])
    aioclient_mock.get(f"{base}/product_barcodes", json=[
        {"product_id": "1", "barcode": "4006381333931"},
        {"product_id": "1", "barcode": "4006381333931"},
        {"product_id": "1", "barcode": "MDETEST24"},
        {"product_id": "3", "barcode": "22111968"},
        {"product_id": "3", "barcode": "123"},
    ])
    aioclient_mock.get(f"{base}/product_groups", json=[{"id": "1", "name": "Süßes"}, {"id": "2", "name": "Milchprodukte"}])
    client = await hass_ws_client(hass)
    await client.send_json({"id": 1, "type": "einkaufsliste/grocy/preview", "url": "grocy.local:9283", "api_key": "GEHEIM"})
    res = await client.receive_json()
    assert res["success"], res
    rows = {r["name"]: r for r in res["result"]["rows"]}
    assert set(rows) == {"Cookies", "Milch", "Nudeln Spaghetti"}  # inaktiv und namenlos fehlen
    assert rows["Cookies"]["barcodes"] == ["4006381333931"] and rows["Cookies"]["group"] == "Süßes"
    assert rows["Nudeln Spaghetti"]["barcodes"] == ["22111968"] and rows["Nudeln Spaghetti"]["group"] is None
    assert rows["Milch"]["exists"] is True and rows["Cookies"]["exists"] is False
    assert res["result"]["inactive"] == 1 and res["result"]["bad_codes"] == 2
    assert aioclient_mock.mock_calls[0][3]["GROCY-API-KEY"] == "GEHEIM"
    assert "GEHEIM" not in str(m.as_dict()) and "GEHEIM" not in str(m._to_storage())  # Schlüssel wird nicht gespeichert
    # übernehmen: Cookies + Nudeln (Milch gibt es schon -> übersprungen)
    await client.send_json({"id": 2, "type": "einkaufsliste/grocy/import", "make_categories": True, "rows": [
        {"name": "Cookies", "group": "Süßes", "barcodes": ["4006381333931"]},
        {"name": "Milch", "group": "Milchprodukte", "barcodes": []},
        {"name": "Nudeln Spaghetti", "group": None, "barcodes": ["22111968", "4006381333931"]},
    ]})
    res = await client.receive_json()
    assert res["success"] and res["result"] == {"added": 2, "exists": 1, "failed": 0, "codes_added": 2,
                                                "codes_skipped": 1, "categories_made": 1}, res
    keys = {p["key"]: p for p in m.products()}
    assert "cookies" in keys and keys["cookies"]["barcodes"] == ["4006381333931"]
    assert m.category_by_id(keys["cookies"]["category_id"])["name"] == "Süßes"
    assert not any(c["name"] == "Milchprodukte" for c in m.categories)  # Milch wurde übersprungen -> keine Kategorie
    # nur Admins
    ro = await hass_ws_client(hass, hass_read_only_access_token)
    await ro.send_json({"id": 1, "type": "einkaufsliste/grocy/preview", "url": "x", "api_key": "y"})
    assert (await ro.receive_json())["error"]["code"] == "unauthorized"


async def test_grocy_errors(hass, setup, hass_ws_client, aioclient_mock):
    """🥫 Grocy-Fehler kommen als verständliche Meldung (falscher Schlüssel, falsche Adresse, nicht erreichbar)."""
    import aiohttp
    client = await hass_ws_client(hass)
    aioclient_mock.get("http://g1/api/objects/products", status=401)
    aioclient_mock.get("http://g2/api/objects/products", status=404)
    aioclient_mock.get("http://g3/api/objects/products", exc=aiohttp.ClientError())
    aioclient_mock.get("http://g4/api/objects/products", text="<html>kein json</html>")
    for n, (host, text) in enumerate([("g1", "Schlüssel"), ("g2", "kein Grocy"), ("g3", "nicht erreichbar"), ("g4", "lesbare")], 1):
        await client.send_json({"id": n, "type": "einkaufsliste/grocy/preview", "url": host, "api_key": "k"})
        res = await client.receive_json()
        assert not res["success"] and text in res["error"]["message"], res
    await client.send_json({"id": 9, "type": "einkaufsliste/grocy/preview", "url": "g1", "api_key": " "})
    assert "Schlüssel" in (await client.receive_json())["error"]["message"]
