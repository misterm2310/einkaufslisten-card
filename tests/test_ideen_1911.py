"""Tests für die Ideen vom 19.11.: teilweise gekauft, Rezept-Sterne, Statistik, Reparatur-Hinweise, Gast-Link."""

from datetime import timedelta

import pytest

from homeassistant.core import HomeAssistant
from homeassistant.helpers import issue_registry as ir
from homeassistant.util import dt as dt_util

from custom_components.einkaufsliste.const import DOMAIN
from custom_components.einkaufsliste import guest as guest_mod

from .test_einkaufsliste import mgr, setup  # noqa: F401 – Fixture

API = "/api/einkaufsliste/gast"


async def test_partial_purchase(hass: HomeAssistant, setup) -> None:  # noqa: F811
    m = mgr(hass)
    events = []
    hass.bus.async_listen("einkaufsliste_item_bought", lambda e: events.append(e.data))
    item = m.add_item("Milch", m.find_store("aldi"), quantity="3x")
    res = m.check_partial(item["id"], 2, "Marco")
    await hass.async_block_till_done()
    assert res["bought"] == "2x" and m.get_item(item["id"])["quantity"] == "1x"
    assert m.get_item(item["id"])["checked"] is False
    assert events[-1]["quantity"] == "2x" and events[-1]["bought_by"] == "Marco"
    assert m.log[-1]["a"] == "partial"
    # Einheit bleibt: 3 Pck. -> 1 Pck.
    hefe = m.add_item("Hefe", quantity="3 Pck.")
    m.check_partial(hefe["id"], "2")
    assert m.get_item(hefe["id"])["quantity"] == "1 Pck."
    # alles bekommen = normal abhaken
    m.check_partial(item["id"], 1)
    assert m.get_item(item["id"])["checked"] is True
    # Mit „etwas“ kann man nicht rechnen
    salz = m.add_item("Salz", quantity="etwas")
    with pytest.raises(ValueError):
        m.check_partial(salz["id"], 1)
    with pytest.raises(ValueError):
        m.check_partial(hefe["id"], 0)


async def test_partial_via_websocket(hass: HomeAssistant, setup, hass_ws_client) -> None:  # noqa: F811
    m = mgr(hass)
    item = m.add_item("Eier", quantity="10x")
    client = await hass_ws_client(hass)
    await client.send_json({"id": 1, "type": "einkaufsliste/item/partial", "item_id": item["id"], "got": 6})
    msg = await client.receive_json()
    assert msg["success"] and msg["result"]["quantity"] == "4x"


async def test_recipe_stars(hass: HomeAssistant, setup, hass_ws_client) -> None:  # noqa: F811
    m = mgr(hass)
    r = m.add_recipe("Lasagne", [{"name": "Nudeln"}])
    client = await hass_ws_client(hass)
    await client.send_json({"id": 1, "type": "einkaufsliste/recipe/update", "recipe_id": r["id"], "stars": 5})
    assert (await client.receive_json())["success"]
    assert m.recipe_by_id(r["id"])["stars"] == 5
    await client.send_json({"id": 2, "type": "einkaufsliste/recipe/update", "recipe_id": r["id"], "stars": 0})
    assert (await client.receive_json())["success"]
    assert "stars" not in m.recipe_by_id(r["id"])
    await client.send_json({"id": 3, "type": "einkaufsliste/recipe/update", "recipe_id": r["id"], "stars": 6})
    assert not (await client.receive_json())["success"]



async def test_recipe_stars_per_person(hass: HomeAssistant, setup, hass_ws_client) -> None:  # noqa: F811
    """⭐ beta.4: jeder bewertet selbst, am Rezept steht der Durchschnitt; alte Einzel-Sterne werden abgelöst."""
    m = mgr(hass)
    r = m.add_recipe("Pizza", [{"name": "Mehl"}])
    m.update_recipe(r["id"], stars=4)  # alte Einzel-Bewertung
    assert m.recipe_by_id(r["id"])["ratings"] == {"_alt": {"s": 4}}
    m.rate_recipe(r["id"], "u1", "Marco", 5)
    rec = m.recipe_by_id(r["id"])
    assert "_alt" not in rec["ratings"] and rec["stars"] == 5 and rec["stars_n"] == 1
    m.rate_recipe(r["id"], "u2", "Kind", 2)
    m.rate_recipe(r["id"], "u3", "Oma", 5)
    rec = m.recipe_by_id(r["id"])
    assert rec["stars"] == 4.0 and rec["stars_n"] == 3 and rec["ratings"]["u2"] == {"s": 2, "n": "Kind"}
    m.rate_recipe(r["id"], "u2", "Kind", 3)  # eigene Bewertung ändern, nicht doppelt
    assert m.recipe_by_id(r["id"])["stars"] == 4.3 and m.recipe_by_id(r["id"])["stars_n"] == 3
    m.rate_recipe(r["id"], "u1", "Marco", 0)  # eigene weg
    assert m.recipe_by_id(r["id"])["stars_n"] == 2
    m.rate_recipe(r["id"], "u2", None, 0)
    m.rate_recipe(r["id"], "u3", None, 0)
    assert not {"stars", "stars_n", "ratings"} & set(m.recipe_by_id(r["id"]))
    # über die Websocket-Verbindung zählt der angemeldete Benutzer
    client = await hass_ws_client(hass)
    await client.send_json({"id": 1, "type": "einkaufsliste/recipe/rate", "recipe_id": r["id"], "stars": 4})
    msg = await client.receive_json()
    assert msg["success"] and msg["result"]["stars"] == 4 and msg["result"]["stars_n"] == 1
    await client.send_json({"id": 2, "type": "einkaufsliste/recipe/rate", "recipe_id": r["id"], "stars": 9})
    assert not (await client.receive_json())["success"]

async def test_stats_summary(hass: HomeAssistant, setup) -> None:  # noqa: F811
    m = mgr(hass)
    aldi = m.find_store("aldi")
    for name in ("Milch", "Milch", "Brot"):
        it = m.add_item(name, aldi, added_by="Anna")
        m.set_checked(it["id"], True, "Marco")
        if name == "Milch":
            m.set_checked(it["id"], False, "Anna")
    m.set_spend(True)
    with m.acting("Marco", None, "card"):
        m.add_purchase(aldi, "23,40")
    s = m.stats_summary()
    assert s["items"][0] == ["Milch", 2]
    assert s["buyers"] == [["Marco", 3]]
    assert s["stores"][0]["name"] == "Aldi" and s["stores"][0]["n"] == 3 and s["stores"][0]["eur"] == 23.4
    assert len(s["months"]) == 12 and s["months"][-1]["n"] == 3 and s["months"][-1]["eur"] == 23.4


async def test_repair_issues(hass: HomeAssistant, setup) -> None:  # noqa: F811
    m = mgr(hass)
    reg = ir.async_get(hass)
    m.offers_cfg = {"enabled": True, "ok": False, "error": "kaputt", "zip": "48565"}
    m._changed()
    assert reg.async_get_issue(DOMAIN, "offers_down") is not None
    m.offers_cfg["ok"] = True
    m._changed()
    assert reg.async_get_issue(DOMAIN, "offers_down") is None
    m.grocy = {"url": "http://grocy", "a_on": True, "status": {"ok": False, "msg": "Grocy lehnt den API-Schlüssel ab – bitte prüfen."}}
    m._changed()
    issue = reg.async_get_issue(DOMAIN, "grocy_key")
    assert issue is not None and issue.translation_placeholders["url"] == "http://grocy"
    m.grocy["a_on"] = False  # ausgeschaltet = Hinweis weg
    m._changed()
    assert reg.async_get_issue(DOMAIN, "grocy_key") is None


_IDS = iter(range(100, 10000))


async def _make_link(hass, client, **extra):
    await client.send_json({"id": next(_IDS), "type": "einkaufsliste/guest/create", "pin": "4711", **extra})
    msg = await client.receive_json()
    assert msg["success"], msg
    return msg["result"]


async def test_guest_link(hass: HomeAssistant, setup, hass_ws_client, hass_client_no_auth, hass_read_only_access_token) -> None:  # noqa: F811
    m = mgr(hass)
    aldi, lidl = m.find_store("aldi"), m.find_store("lidl")
    milch = m.add_item("Milch", aldi, quantity="2x", note="laktosefrei")
    m.add_item("Brot", lidl)
    m.add_item("Batterien", None)
    # nur Admins dürfen
    ro = await hass_ws_client(hass, hass_read_only_access_token)
    await ro.send_json({"id": 1, "type": "einkaufsliste/guest/create", "pin": "4711"})
    assert not (await ro.receive_json())["success"]
    ws = await hass_ws_client(hass)
    res = await _make_link(hass, ws, store_id=aldi)
    token = res["token"]
    assert res["path"] == "/einkaufsliste/gast/#" + token
    # gespeichert ist nur die Prüfsumme – nie der Schlüssel oder die PIN
    assert token not in str(m._to_storage()) and "4711" not in str(m.guest)
    assert m.as_dict()["settings"]["guest"]["store_id"] == aldi
    http = await hass_client_no_auth()
    # Seite ist da, mit strenger Sicherheits-Regel
    page = await http.get("/einkaufsliste/gast/")
    assert page.status == 200 and "script-src 'self'" in page.headers["Content-Security-Policy"]
    assert (await http.get("/einkaufsliste/gast/../manifest.json")).status == 404
    # falscher Schlüssel
    r = await http.post(API, json={"t": "x" * 43, "do": "open", "pin": "4711"})
    assert r.status == 403
    # ohne PIN keine Daten
    r = await http.post(API, json={"t": token, "do": "list", "s": "quatsch"})
    assert r.status == 401
    r = await http.post(API, json={"t": token, "do": "open", "pin": "1234"})
    assert r.status == 401
    r = await http.post(API, json={"t": token, "do": "open", "pin": "4711"})
    assert r.status == 200
    data = await r.json()
    sid = data["s"]
    names = [i["name"] for i in data["items"]]
    assert names == ["Milch", "Batterien"]  # Aldi + Egal wo, kein Lidl
    assert set(data["items"][0]) == {"id", "name", "quantity", "note", "store", "color", "checked"}  # nichts anderes
    # abhaken
    r = await http.post(API, json={"t": token, "do": "check", "s": sid, "id": milch["id"], "checked": True})
    assert r.status == 200 and m.get_item(milch["id"])["checked"] and m.get_item(milch["id"])["checked_by"] == "Gast"
    # zurücknehmen geht (eigener Haken)
    r = await http.post(API, json={"t": token, "do": "check", "s": sid, "id": milch["id"], "checked": False})
    assert r.status == 200 and not m.get_item(milch["id"])["checked"]
    # fremder Artikel (Lidl) ist tabu
    brot = m.find_item("Brot", lidl)
    r = await http.post(API, json={"t": token, "do": "check", "s": sid, "id": brot["id"], "checked": True})
    assert r.status == 200 and not m.get_item(brot["id"])["checked"]
    # zu großer Inhalt
    r = await http.post(API, data="x" * 5000, headers={"Content-Type": "application/json"})
    assert r.status == 400
    # sperren
    await ws.send_json({"id": next(_IDS), "type": "einkaufsliste/guest/revoke"})
    assert (await ws.receive_json())["success"]
    r = await http.post(API, json={"t": token, "do": "list", "s": sid})
    assert r.status == 410
    assert m.as_dict()["settings"]["guest"] is None


async def test_guest_link_expires_and_pauses(hass: HomeAssistant, setup, hass_ws_client, hass_client_no_auth) -> None:  # noqa: F811
    m = mgr(hass)
    ws = await hass_ws_client(hass)
    await ws.send_json({"id": 1, "type": "einkaufsliste/guest/create", "pin": "4711", "hours": 48})
    assert not (await ws.receive_json())["success"]  # länger als 24 h gibt es nicht
    token = (await _make_link(hass, ws, hours=2))["token"]
    http = await hass_client_no_auth()
    for _ in range(guest_mod.FAILS_PAUSE - 1):
        assert (await http.post(API, json={"t": token, "do": "open", "pin": "0000"})).status == 401
    r = await http.post(API, json={"t": token, "do": "open", "pin": "0000"})
    assert r.status == 429
    # in der Pause hilft auch die richtige PIN nicht
    assert (await http.post(API, json={"t": token, "do": "open", "pin": "4711"})).status == 429
    # neuer Link: alter ist ungültig
    new = (await _make_link(hass, ws))["token"]
    assert (await http.post(API, json={"t": token, "do": "open", "pin": "4711"})).status == 403
    # abgelaufen
    m.guest["until"] = (dt_util.utcnow() - timedelta(minutes=1)).isoformat()
    assert (await http.post(API, json={"t": new, "do": "open", "pin": "4711"})).status == 410
    assert m.guest is None
