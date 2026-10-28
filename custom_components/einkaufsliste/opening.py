"""🕒 Hat das Geschäft gerade offen? Gleiche Regeln wie in der Karte (Öffnungszeiten + Feiertage je Bundesland)."""

from __future__ import annotations

import re
from datetime import date, datetime, timedelta
from typing import Any

_HHMM = re.compile(r"^(\d\d):(\d\d)$")
_STATES = ("BW", "BY", "BE", "BB", "HB", "HH", "HE", "MV", "NI", "NW", "RP", "SL", "SN", "ST", "SH", "TH")


def _min(hhmm: Any) -> int | None:
    m = _HHMM.match(hhmm or "") if isinstance(hhmm, str) else None
    return int(m[1]) * 60 + int(m[2]) if m else None


def _ranges(day: Any) -> list[list[str]] | None:
    """Ein Tag: None = zu, [von, bis] (alt) oder [[von, bis], …]."""
    if not day:
        return None
    return [day] if isinstance(day[0], str) else day


def easter(year: int) -> date:
    """Ostersonntag (Gauß)."""
    a, b, c = year % 19, year // 100, year % 100
    d, e, f = b // 4, b % 4, (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i, k = c // 4, c % 4
    l = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * l) // 451
    mo, da = (h + l - 7 * m + 114) // 31, (h + l - 7 * m + 114) % 31 + 1
    return date(year, mo, da)


def holiday_name(day: date, state: str | None) -> str | None:
    """🎌 Gesetzlicher Feiertag im Bundesland (oder None)."""
    if state not in _STATES:
        return None
    fix = {(1, 1): "Neujahr", (1, 5): "Tag der Arbeit", (3, 10): "Tag der Deutschen Einheit",
           (25, 12): "1. Weihnachtstag", (26, 12): "2. Weihnachtstag"}
    if state in ("BW", "BY", "ST"):
        fix[(6, 1)] = "Heilige Drei Könige"
    if state in ("BE", "MV"):
        fix[(8, 3)] = "Frauentag"
    if state == "SL":
        fix[(15, 8)] = "Mariä Himmelfahrt"
    if state == "TH":
        fix[(20, 9)] = "Weltkindertag"
    if state in ("BB", "HB", "HH", "MV", "NI", "SN", "ST", "SH", "TH"):
        fix[(31, 10)] = "Reformationstag"
    if state in ("BW", "BY", "NW", "RP", "SL"):
        fix[(1, 11)] = "Allerheiligen"
    if (day.day, day.month) in fix:
        return fix[(day.day, day.month)]
    diff = (day - easter(day.year)).days
    mov = {-2: "Karfreitag", 1: "Ostermontag", 39: "Christi Himmelfahrt", 50: "Pfingstmontag"}
    if state == "BB":
        mov[0], mov[49] = "Ostersonntag", "Pfingstsonntag"
    if state in ("BW", "BY", "HE", "NW", "RP", "SL"):
        mov[60] = "Fronleichnam"
    if diff in mov:
        return mov[diff]
    if state == "SN" and day.month == 11 and day.weekday() == 2 and 16 <= day.day <= 22:
        return "Buß- und Bettag"
    return None


def open_now(hours: Any, now: datetime, state: str | None = None) -> dict[str, Any] | None:
    """{"open": True, "until": "20:00"} / {"open": False, "next": "08:00", "day": 0..6, "today": bool, "holiday": …} / None = unbekannt."""
    today = now.date()
    if not isinstance(hours, list) or len(hours) != 7:
        hn = holiday_name(today, state)
        return {"open": False, "holiday": hn} if hn else None
    cur = now.hour * 60 + now.minute
    wd = now.weekday()

    def next_day(extra: dict[str, Any]) -> dict[str, Any]:
        for k in range(1, 15):  # nächster Öffnungstag (Feiertage überspringen)
            day = today + timedelta(days=k)
            rng = None if holiday_name(day, state) else _ranges(hours[(wd + k) % 7])
            if rng:
                return {**extra, "open": False, "next": rng[0][0], "day": (wd + k) % 7, "today": False}
        return {**extra, "open": False}

    hn = holiday_name(today, state)
    if hn:
        return next_day({"holiday": hn})
    ranges = _ranges(hours[wd]) or []
    for rng in ranges:
        a, b = _min(rng[0]), _min(rng[1])
        if a is not None and b is not None and a <= cur < b:
            return {"open": True, "until": rng[1]}
    later = next((r for r in ranges if (_min(r[0]) or 0) > cur), None)
    if later:
        return {"open": False, "next": later[0], "today": True}
    return next_day({})


def store_open(store: dict[str, Any], now: datetime) -> dict[str, Any]:
    """Geschäft (mit oder ohne Filialen): offen, sobald EINE Filiale offen hat. state None = unbekannt."""
    state = store.get("holiday_state")
    branches = store.get("branches") if isinstance(store.get("branches"), list) and store.get("branches") else None
    if not branches:
        info = open_now(store.get("hours"), now, state)
        return {"state": None if info is None else info["open"], "info": info, "branches": None}
    infos = [(b, open_now(b.get("hours"), now, state)) for b in branches]
    known = [i for _, i in infos if i is not None]
    st = True if any(i["open"] for i in known) else (False if known and len(known) == len(infos) else None)
    return {"state": st, "info": None, "branches": infos}
