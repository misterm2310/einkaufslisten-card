"""⚠️ Rückruf-Warnung: Feed lesen, mit Einkäufen abgleichen, melden (ohne echtes Netz)."""

from datetime import timedelta

import pytest
from pytest_homeassistant_custom_component.common import MockConfigEntry

from homeassistant.core import HomeAssistant
from homeassistant.setup import async_setup_component
from homeassistant.util import dt as dt_util

from custom_components.einkaufsliste import recalls as mod
from custom_components.einkaufsliste.const import DOMAIN

FEED = """<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Lebensmittelwarnung.de - Alle Bundesländer</title>
<item><title>Gemahlener Kaffee mit Karamellgeschmack, 250 Gramm</title>
<link>https://www.lebensmittelwarnung.de/___lebensmittelwarnung.de/Meldungen/2026/10_Oktober/kaffee.html</link>
<pubDate>{recent}</pubDate>
<description><![CDATA[<img src="x.jpg"/><b>Hersteller:</b> Bialetti<br/>Grund: Rückstände &amp; Kontaminanten]]></description>
<guid>https://www.lebensmittelwarnung.de/___lebensmittelwarnung.de/Meldungen/2026/10_Oktober/kaffee.html</guid></item>
<item><title>Milchschnitte Dekor, 10 Stück</title>
<link>https://www.lebensmittelwarnung.de/___lebensmittelwarnung.de/Meldungen/2026/10_Oktober/deko.html</link>
<pubDate>{recent}</pubDate><description>Fremdkörper</description>
<guid>https://www.lebensmittelwarnung.de/___lebensmittelwarnung.de/Meldungen/2026/10_Oktober/deko.html</guid></item>
<item><title>Butter, 250 Gramm</title>
<link>https://www.lebensmittelwarnung.de/___lebensmittelwarnung.de/Meldungen/2026/06_Juni/butter.html</link>
<pubDate>{old}</pubDate><description>Uralt</description>
<guid>https://www.lebensmittelwarnung.de/___lebensmittelwarnung.de/Meldungen/2026/06_Juni/butter.html</guid></item>
<item><title>Ohne Link</title><link>https://example.com/fake</link></item>
</channel></rss>"""


def _feed() -> str:
    now = dt_util.utcnow()
    return FEED.format(recent=now.strftime("%a, %d %b %Y %H:%M:%S +0000"),
                       old=(now - timedelta(days=120)).strftime("%a, %d %b %Y %H:%M:%S +0000"))


@pytest.fixture
async def m(hass: HomeAssistant):
    assert await async_setup_component(hass, "http", {})
    hass.config.components.update({"frontend", "lovelace"})
    entry = MockConfigEntry(domain=DOMAIN, title="Einkaufsliste")
    entry.add_to_hass(hass)
    from unittest.mock import patch
    with patch("custom_components.einkaufsliste.frontend.add_extra_js_url"):
        assert await hass.config_entries.async_setup(entry.entry_id)
        await hass.async_block_till_done()
    return hass.data[DOMAIN]["manager"]


def test_parse_feed_and_match():
    warnings = mod.parse_feed(_feed())
    assert [w["title"] for w in warnings] == [
        "Gemahlener Kaffee mit Karamellgeschmack, 250 Gramm", "Milchschnitte Dekor, 10 Stück", "Butter, 250 Gramm"]  # fremder Link fliegt raus
    assert "Bialetti" in warnings[0]["text"] and "<" not in warnings[0]["text"] and "&amp;" not in warnings[0]["text"]
    assert mod.match("Kaffee", warnings[0])
    assert not mod.match("Milch", warnings[1])  # „Milchschnitte“ ist keine Milch
    assert not mod.match("Tee", warnings[0])  # zu kurz – kein taugliches Suchwort
    with pytest.raises(ValueError):
        mod.parse_feed('<!DOCTYPE x [<!ENTITY a "b">]><rss/>')


async def test_recall_hit_notifies_once(hass: HomeAssistant, m, aioclient_mock) -> None:
    events = []
    hass.bus.async_listen("einkaufsliste_rueckruf", lambda e: events.append(e.data))
    kaffee = m.add_item("Kaffee")
    m.set_checked(kaffee["id"], True)  # gekauft
    m.add_item("Milch")  # offen, nicht gekauft – zählt nicht
    aioclient_mock.get(mod.FEED_URL, text=_feed())

    assert (await m.recalls.run())["enabled"] is False  # aus = keine Abfrage
    assert aioclient_mock.call_count == 0
    m.set_recalls(True)
    info = await m.recalls.run()
    await hass.async_block_till_done()
    assert info["ok"] and info["checked"] == 3
    assert [h["products"] for h in info["hits"]] == [["Kaffee"]]
    assert events and events[0]["products"] == ["Kaffee"] and "Kaffee" in events[0]["title"]
    from homeassistant.components.persistent_notification import _async_get_or_create_notifications
    note = _async_get_or_create_notifications(hass)[mod.NOTIFY_ID]
    assert "Kaffee" in note["message"] and "lebensmittelwarnung.de" in note["message"]

    await m.recalls.run()  # zweites Mal: dieselbe Warnung wird nicht noch einmal gemeldet
    await hass.async_block_till_done()
    assert len(events) == 1 and len(m.recalls_info()["hits"]) == 1

    m.dismiss_recall(info["hits"][0]["id"])
    assert m.recalls_info()["hits"] == []
    assert m.as_dict()["settings"]["recalls"]["enabled"]


async def test_recall_respects_privacy_and_errors(hass: HomeAssistant, m, aioclient_mock) -> None:
    m.set_recalls(True)
    m.set_privacy(True)
    await m.recalls.run()
    assert aioclient_mock.call_count == 0  # 🔒 Datenschutz: nichts abfragen
    m.set_privacy(False)
    aioclient_mock.get(mod.FEED_URL, status=503)
    info = await m.recalls.run()
    assert info["ok"] is False and "503" in info["error"]


async def test_old_purchases_do_not_count(hass: HomeAssistant, m) -> None:
    kaffee = m.add_item("Kaffee")
    m.set_checked(kaffee["id"], True)
    m.set_recalls(True)
    later = dt_util.utcnow() + timedelta(days=mod.BOUGHT_DAYS + 1)
    warnings = mod.parse_feed(_feed())
    for w in warnings:
        w["date"] = later.isoformat()
    assert m.recalls.check(warnings, now=later)["hits"] == []
