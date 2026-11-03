"""🕒 Hat das Geschäft gerade offen? Gleiche Regeln wie in der Karte (Öffnungszeiten + Feiertage aus dem HA-Feiertagskalender)."""

from __future__ import annotations

import re
from datetime import date, datetime, timedelta
from typing import Any

_HHMM = re.compile(r"^(\d\d):(\d\d)$")


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


def holiday_name(day: date, holidays: dict[str, str] | None) -> str | None:
    """🎌 Feiertag laut HA-Integration „Feiertage“ (Kalender, z. B. calendar.deutschland_nrw) – oder None."""
    return (holidays or {}).get(day.isoformat()) if isinstance(holidays, dict) else None


def open_now(hours: Any, now: datetime, state: dict[str, str] | None = None) -> dict[str, Any] | None:
    """{"open": True, "until": "20:00"} / {"open": False, "next": "08:00", "day": 0..6, "today": bool, "holiday": …} / None = unbekannt."""
    today = now.date()
    if not isinstance(hours, list) or len(hours) != 7:
        return None  # ohne Zeiten: unbekannt (Feiertage zählen nur mit Zeiten)
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


def store_open(store: dict[str, Any], now: datetime, holidays: dict[str, str] | None = None) -> dict[str, Any]:
    """Geschäft (mit oder ohne Filialen): offen, sobald EINE Filiale offen hat. state None = unbekannt.

    🎌 Feiertage gelten für alle Geschäfte (aus dem HA-Feiertagskalender); das alte Bundesland je Geschäft ist weg.
    """
    state = holidays
    branches = store.get("branches") if isinstance(store.get("branches"), list) and store.get("branches") else None
    if not branches:
        info = open_now(store.get("hours"), now, state)
        return {"state": None if info is None else info["open"], "info": info, "branches": None}
    infos = [(b, open_now(b.get("hours"), now, state)) for b in branches]
    known = [i for _, i in infos if i is not None]
    st = True if any(i["open"] for i in known) else (False if known and len(known) == len(infos) else None)
    return {"state": st, "info": None, "branches": infos}
