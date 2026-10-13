"""Öffnungszeiten aus OpenStreetMap: Text lesen und Suche (ohne echtes Netz)."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from custom_components.einkaufsliste.osm_hours import async_search_hours, parse_opening_hours


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
            {"lat": 52.1, "lon": 7.4, "tags": {"name": "K&K Supermarkt", "opening_hours": "Mo-Sa 07:00-21:00", "addr:city": "Borghorst", "addr:street": "Hauptstr.", "addr:housenumber": "1"}},
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


async def test_search_privacy_and_short_name(hass):
    with pytest.raises(ValueError):
        await async_search_hours(hass, MagicMock(privacy=True), "K&K")
    with pytest.raises(ValueError):
        await async_search_hours(hass, MagicMock(privacy=False), "K")
