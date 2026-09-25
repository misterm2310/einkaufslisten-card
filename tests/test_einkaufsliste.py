"""Tests für die Einkaufsliste (echtes Home Assistant im Testmodus)."""

from datetime import datetime, timedelta
from unittest.mock import patch

from freezegun.api import FrozenDateTimeFactory
import pytest
from pytest_homeassistant_custom_component.common import MockConfigEntry

from homeassistant.core import HomeAssistant
from homeassistant.setup import async_setup_component
from homeassistant.util import dt as dt_util

from custom_components.einkaufsliste.const import DOMAIN

TZ = "Europe/Berlin"


@pytest.fixture
async def setup(hass: HomeAssistant):
    await hass.config.async_set_time_zone(TZ)
    assert await async_setup_component(hass, "http", {})
    hass.config.components.add("frontend")
    entry = MockConfigEntry(
        domain=DOMAIN,
        title="Einkaufsliste",
        options={
            "cleanup_weekday": 6,
            "cleanup_time": "03:00:00",
            "min_age_days": 7,
            "only_checked": False,
        },
    )
    entry.add_to_hass(hass)
    with patch("custom_components.einkaufsliste.add_extra_js_url") as js:
        assert await hass.config_entries.async_setup(entry.entry_id)
        await hass.async_block_till_done()
    assert js.called
    return entry


def mgr(hass):
    return hass.data[DOMAIN]["manager"]


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
    assert first["type"] == "event" and first["event"]["items"] == []

    await client.send_json(
        {"id": 2, "type": "einkaufsliste/item/add", "name": "Milch", "store_id": aldi, "quantity": "2"}
    )
    event = await client.receive_json()  # live-Update kommt vor dem Ergebnis
    assert event["type"] == "event"
    res = await client.receive_json()
    assert res["success"], res
    item = res["result"]
    assert item["added_by"] == hass_admin_user.name
    assert item["quantity"] == "2"
    await hass.async_block_till_done()
    state = hass.states.get("sensor.einkaufsliste_offene_artikel")
    assert state.state == "1"
    assert state.attributes["pro_geschaeft"]["Aldi"] == 1
    assert state.attributes["artikel"][0]["name"] == "Milch"

    # Doppelt hinzufügen -> kein Duplikat
    await client.send_json({"id": 3, "type": "einkaufsliste/item/add", "name": "milch", "store_id": aldi})
    await client.receive_json()
    assert (await client.receive_json())["success"]
    assert len(m.items) == 1

    # Abhaken
    await client.send_json({"id": 4, "type": "einkaufsliste/item/toggle", "item_id": item["id"]})
    await client.receive_json()
    res = await client.receive_json()
    assert res["result"]["checked"] is True

    # leerer Name -> Fehler
    await client.send_json({"id": 5, "type": "einkaufsliste/item/add", "name": "  "})
    res = await client.receive_json()
    assert not res["success"] and res["error"]["code"] == "invalid"


async def test_person_name_is_used(hass, setup, hass_admin_user):
    hass.states.async_set(
        "person.marco", "home", {"user_id": hass_admin_user.id, "friendly_name": "Marco"}
    )
    await hass.services.async_call(
        DOMAIN, "add_item", {"name": "Brot"}, blocking=True, context=_ctx(hass_admin_user)
    )
    assert mgr(hass).items[0]["added_by"] == "Marco"


def _ctx(user):
    from homeassistant.core import Context

    return Context(user_id=user.id)


async def test_readd_unchecks_and_resets(hass, setup, freezer: FrozenDateTimeFactory):
    m = mgr(hass)
    item = m.add_item("Butter", added_by="Marco")
    m.set_checked(item["id"], True, "Sandra")
    assert item["checked"] and item["checked_by"] == "Sandra"
    freezer.tick(timedelta(hours=2))
    again = m.add_item("Butter", added_by="Joy")
    assert again is item
    assert item["checked"] is False and item["added_by"] == "Joy"


async def test_accidental_uncheck_keeps_name(hass, setup, freezer):
    m = mgr(hass)
    item = m.add_item("Käse", added_by="Marco")
    added_at = item["added_at"]
    m.set_checked(item["id"], True, "Sandra")
    freezer.tick(timedelta(seconds=20))
    m.set_checked(item["id"], False, "Sandra")
    assert item["added_by"] == "Marco" and item["added_at"] == added_at


async def test_uncheck_later_is_readd(hass, setup, freezer):
    m = mgr(hass)
    item = m.add_item("Eier", added_by="Marco")
    m.set_checked(item["id"], True, "Marco")
    freezer.tick(timedelta(days=1))
    m.set_checked(item["id"], False, "Sandra")
    assert item["added_by"] == "Sandra"


async def test_cleanup_min_one_week(hass, setup, freezer):
    """Di eingetragen -> erster So bleibt, zweiter So löscht."""
    m = mgr(hass)
    tz = dt_util.get_time_zone(TZ)
    freezer.move_to(datetime(2026, 9, 22, 18, 0, tzinfo=tz))  # Dienstag
    m.add_item("Nudeln")
    # 1. Sonntag 27.09. 03:00 -> erst 5 Tage, bleibt
    m.cleanup(reference=datetime(2026, 9, 27, 3, 0, tzinfo=tz), scheduled=True)
    assert [i["name"] for i in m.items] == ["Nudeln"]
    freezer.move_to(datetime(2026, 9, 27, 10, 0, tzinfo=tz))  # Sonntag nach dem Aufräumen
    m.add_item("Zahnpasta")
    # 2. Sonntag 04.10. -> Nudeln 12 Tage weg, Zahnpasta 7 Tage (So->So) weg
    m.cleanup(reference=datetime(2026, 10, 4, 3, 0, tzinfo=tz), scheduled=True)
    assert m.items == []


async def test_cleanup_example_exact(hass, setup, freezer):
    m = mgr(hass)
    tz = dt_util.get_time_zone(TZ)
    freezer.move_to(datetime(2026, 9, 29, 12, 0, tzinfo=tz))  # Di 29.09.
    m.add_item("Milch")
    m.cleanup(reference=datetime(2026, 10, 4, 3, 0, tzinfo=tz))  # So 04.10. (5 Tage)
    assert len(m.items) == 1
    m.cleanup(reference=datetime(2026, 10, 11, 3, 0, tzinfo=tz))  # So 11.10. (12 Tage)
    assert len(m.items) == 0


async def test_scheduler_fires_on_sunday(hass, setup, freezer):
    m = mgr(hass)
    tz = dt_util.get_time_zone(TZ)
    freezer.move_to(datetime(2026, 9, 22, 18, 0, tzinfo=tz))  # Di
    m.add_item("Nudeln")
    events = []
    hass.bus.async_listen("einkaufsliste_cleanup", lambda e: events.append(e))

    from pytest_homeassistant_custom_component.common import async_fire_time_changed

    target = datetime(2026, 9, 27, 3, 0, 0, tzinfo=tz)
    assert target.weekday() == 6
    freezer.move_to(target)
    async_fire_time_changed(hass, target)
    await hass.async_block_till_done()
    assert len(events) == 1 and events[0].data["removed"] == 0  # erst 5 Tage
    target = datetime(2026, 10, 4, 3, 0, 0, tzinfo=tz)
    freezer.move_to(target)
    async_fire_time_changed(hass, target)
    await hass.async_block_till_done()
    assert events[-1].data["removed"] == 1
    assert m.items == []


async def test_only_checked_option(hass, setup):
    m = mgr(hass)
    hass.config_entries.async_update_entry(
        setup, options={**setup.options, "only_checked": True, "min_age_days": 0}
    )
    await hass.async_block_till_done()
    m = mgr(hass)
    a = m.add_item("A")
    m.add_item("B")
    m.set_checked(a["id"], True)
    m.cleanup()
    assert [i["name"] for i in m.items] == ["B"]


async def test_services(hass, setup):
    m = mgr(hass)
    res = await hass.services.async_call(
        DOMAIN,
        "add_item",
        {"name": "Pizza", "store": "netto", "category": "tk-ware", "added_by": "Oma"},
        blocking=True,
        return_response=True,
    )
    assert res["item"]["added_by"] == "Oma"
    pizza = m.items[0]
    assert m.store_by_id(pizza["store_id"])["name"] == "Netto"
    # Verlauf merkt sich Geschäft & Kategorie
    m.remove_item(pizza["id"])
    await hass.services.async_call(DOMAIN, "add_item", {"name": "pizza"}, blocking=True)
    assert m.store_by_id(m.items[0]["store_id"])["name"] == "Netto"

    await hass.services.async_call(DOMAIN, "check_item", {"name": "Pizza"}, blocking=True)
    assert m.items[0]["checked"]
    res = await hass.services.async_call(
        DOMAIN, "clear_checked", {}, blocking=True, return_response=True
    )
    assert res["removed"] == 1

    m.add_item("X")
    res = await hass.services.async_call(
        DOMAIN, "cleanup", {"force": True}, blocking=True, return_response=True
    )
    assert res["removed"] == 1

    from homeassistant.exceptions import HomeAssistantError

    with pytest.raises(HomeAssistantError):
        await hass.services.async_call(
            DOMAIN, "add_item", {"name": "Y", "store": "Gibtsnicht"}, blocking=True
        )


async def test_groups(hass, setup, hass_ws_client):
    client = await hass_ws_client(hass)
    m = mgr(hass)
    await client.send_json(
        {"id": 1, "type": "einkaufsliste/group/add", "kind": "stores", "name": "Kaufland", "color": "#ff0000"}
    )
    res = await client.receive_json()
    assert res["success"]
    new_id = res["result"]["id"]
    item = m.add_item("Reis", store_id=new_id)
    await client.send_json({"id": 2, "type": "einkaufsliste/group/add", "kind": "stores", "name": "kaufland"})
    assert not (await client.receive_json())["success"]
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
    assert await hass.config_entries.async_unload(setup.entry_id)
    assert hass_storage["einkaufsliste.data"]["data"]["items"][0]["name"] == "Kaffee"


async def test_config_flow(hass):
    await hass.config.async_set_time_zone(TZ)
    hass.config.components.update({"frontend", "http", "websocket_api"})
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": "user"})
    assert result["type"] == "form"
    with patch("custom_components.einkaufsliste.async_setup", return_value=True), patch(
        "custom_components.einkaufsliste.async_setup_entry", return_value=True
    ):
        result = await hass.config_entries.flow.async_configure(
            result["flow_id"],
            {"cleanup_weekday": "5", "cleanup_time": "04:30:00", "min_age_days": 14, "only_checked": False},
        )
    assert result["type"] == "create_entry"
    assert result["options"]["cleanup_weekday"] == 5
    assert result["options"]["min_age_days"] == 14
