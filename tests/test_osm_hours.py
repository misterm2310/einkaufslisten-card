"""Öffnungszeiten aus OpenStreetMap: Text lesen und Suche (ohne echtes Netz)."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from custom_components.einkaufsliste.osm_hours import async_search_hours, parse_opening_hours, parse_osm_ref


def test_parse_simple_week():
    h = parse_opening_hours("Mo-Sa 08:00-20:00; Su off")
    assert h[0] == [["08:00", "20:00"]] and h[5] == [["08:00", "20:00"]] and h[6] is None


def test_parse_split_and_override():
    h = parse_opening_hours("Mo-Fr 07:00-12:30,14:30-18:00; Sa 07:00-13:00; PH off")
    assert h[0] == [["07:00", "12:30"], ["14:30", "18:00"]]
    assert h[5] == [["07:00", "13:00"]] and h[6] is None
    h = parse_opening_hours("Mo-Su 08:00-20:00; We 08:00-12:00")  # später überschreibt früher
    assert h[2] == [["08:00", "12:00"]] and h[3] == [["08:00", "20:00"]]


def test_parse_comma_rules_and_24():
    h = parse_opening_hours("Mo-Fr 08:00-12:00, Sa 09:00-12:00")
    assert h[0] == [["08:00", "12:00"]] and h[5] == [["09:00", "12:00"]] and h[6] is None
    assert parse_opening_hours("Mo 08:00-24:00")[0] == [["08:00", "23:59"]]
    assert parse_opening_hours("24/7")[6] == [["00:00", "23:59"]]


@pytest.mark.parametrize(
    "raw",
    [None, "", "off", "Mo-Fr sunrise-sunset", "Mo-Fr 20:00-02:00", "week 2-52 Mo 08:00-12:00", "Mo-Fr 08:00-12:00 \"nach Absprache\"", "Jan Mo 08:00-12:00", "Mo-Fr 25:00-26:00", "PH 08:00-12:00"],
)
def test_parse_unsupported_gives_none(raw):
    assert parse_opening_hours(raw) is None


async def test_search(hass):
    answer = {
        "elements": [
            {"lat": 52.1, "lon": 7.4, "tags": {"name": "K&K Supermarkt", "opening_hours": "Mo-Sa 07:00-21:00", "phone": "+49 2552 1234;+49 2552 999", "website": "kuk.de/borghorst", "addr:city": "Borghorst", "addr:street": "Hauptstr.", "addr:housenumber": "1"}},
            {"center": {"lat": 52.0, "lon": 7.5}, "tags": {"name": "K&K Burgsteinfurt", "opening_hours": "kompliziert"}},
            {"tags": {"shop": "x"}},
        ]
    }
    resp = MagicMock(status=200)
    resp.json = AsyncMock(return_value=answer)
    session = MagicMock()
    session.post = AsyncMock(return_value=resp)
    manager = MagicMock(privacy=False)
    with patch("custom_components.einkaufsliste.osm_hours.async_get_clientsession", return_value=session):
        res = await async_search_hours(hass, manager, "K&K")
    assert [r["place"] for r in res] and len(res) == 2
    assert any(r["hours"] and r["hours"][0] == [["07:00", "21:00"]] for r in res)
    assert any(r["hours"] is None and r["raw"] == "kompliziert" for r in res)
    assert "K&K" in session.post.call_args.kwargs["data"]["data"]
    kk = next(r for r in res if r["hours"])
    assert kk["phone"] == "+49 2552 1234" and kk["website"] == "https://kuk.de/borghorst"
    assert next(r for r in res if not r["hours"])["phone"] is None


async def test_search_privacy_and_short_name(hass):
    with pytest.raises(ValueError):
        await async_search_hours(hass, MagicMock(privacy=True), "K&K")
    with pytest.raises(ValueError):
        await async_search_hours(hass, MagicMock(privacy=False), "K")


async def test_search_falls_back_to_next_server(hass):
    bad = MagicMock(status=504)
    good = MagicMock(status=200)
    good.json = AsyncMock(return_value={"elements": [{"lat": 52.1, "lon": 7.4, "tags": {"name": "K&K", "opening_hours": "Mo-Sa 08:00-20:00"}}]})
    session = MagicMock()
    session.post = AsyncMock(side_effect=[bad, good])
    with patch("custom_components.einkaufsliste.osm_hours.async_get_clientsession", return_value=session):
        res = await async_search_hours(hass, MagicMock(privacy=False), "K&K")
    assert len(res) == 1 and session.post.call_count == 2


async def test_search_all_servers_down(hass):
    bad = MagicMock(status=504)
    session = MagicMock()
    session.post = AsyncMock(return_value=bad)
    with patch("custom_components.einkaufsliste.osm_hours.async_get_clientsession", return_value=session):
        with pytest.raises(ValueError, match="überlastet"):
            await async_search_hours(hass, MagicMock(privacy=False), "K&K")


def test_parse_holiday_in_day_list_and_split_days():
    """🇨🇭 Issue #30: „Su,PH off“ und „Mo-We,Fr …“ kommen in OSM ständig vor."""
    h = parse_opening_hours("Mo-Sa 08:00-18:30; Su,PH off")
    assert h[0] == [["08:00", "18:30"]] and h[5] == [["08:00", "18:30"]] and h[6] is None
    h = parse_opening_hours("Mo-We,Fr 08:00-18:30; Th 08:00-21:00; Sa 08:00-17:00")
    assert h[0] == h[2] == h[4] == [["08:00", "18:30"]] and h[3] == [["08:00", "21:00"]] and h[6] is None
    h = parse_opening_hours("Mo-Fr 08:00-12:00,13:30-18:30; Sa 08:00-16:00; Su,PH closed")
    assert h[0] == [["08:00", "12:00"], ["13:30", "18:30"]] and h[6] is None
    h = parse_opening_hours("Mo,We 09:00-12:00, Fr 14:00-18:00")
    assert h[0] == h[2] == [["09:00", "12:00"]] and h[4] == [["14:00", "18:00"]] and h[1] is None


def test_parse_osm_ref():
    assert parse_osm_ref("W304790824") == ("way", 304790824)
    assert parse_osm_ref(" n13031758127 ") == ("node", 13031758127)
    assert parse_osm_ref("https://www.openstreetmap.org/node/6698847448#map=19") == ("node", 6698847448)
    assert parse_osm_ref("https://nominatim.openstreetmap.org/ui/details.html?osmtype=W&osmid=304790824&class=shop") == ("way", 304790824)
    assert parse_osm_ref("Migros") is None and parse_osm_ref("W") is None


async def test_search_by_ref_and_center(hass):
    """🔢 OSM-Nummer: genau dieses Objekt holen. 📍 center: dort suchen statt Zuhause."""
    resp = MagicMock(status=200)
    resp.json = AsyncMock(return_value={"elements": [{"type": "way", "center": {"lat": 46.0, "lon": 8.95}, "tags": {"name": "Coop", "shop": "supermarket", "opening_hours": "Mo-Sa 08:00-18:30; Su,PH off"}}]})
    session = MagicMock()
    session.post = AsyncMock(return_value=resp)
    with patch("custom_components.einkaufsliste.osm_hours.async_get_clientsession", return_value=session):
        res = await async_search_hours(hass, MagicMock(privacy=False), "W304790824", center=[46.0, 8.95])
        assert "way(304790824)" in session.post.call_args.kwargs["data"]["data"]
        assert res[0]["hours"][0] == [["08:00", "18:30"]] and res[0]["distance_km"] == 0.0
        await async_search_hours(hass, MagicMock(privacy=False), "Coop", center=[46.00512, 8.95111])
        assert "46.00512,8.95111" in session.post.call_args.kwargs["data"]["data"]
