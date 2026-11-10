"""🔥 Backofen & Airfryer aus den Zubereitungs-Schritten herauslesen.

Für Doofe: Steht in einem Schritt „Backofen auf 180 °C Umluft vorheizen“ oder
„in der Heißluftfritteuse bei 200 Grad 15 Min“, macht diese Datei daraus einen
Eintrag für „Backofen & Co.“ – verknüpft mit genau diesem Schritt. Beim Airfryer
erscheint dann im Kochmodus der 🍟-Knopf für Airfryer Control.

Ehrlich: Das klappt nicht bei jedem Rezept. Darum immer im Editor kurz prüfen.
"""

from __future__ import annotations

import re
from typing import Any

MAX_ROWS = 6

_FRYER = re.compile(r"hei(?:ß|ss)luft\s*-?\s*fritteuse|air\s*-?\s*fryer|airfryer|fritteuse", re.IGNORECASE)
_OVEN = re.compile(r"back\s*-?\s*ofen|\bofen\b|\bherd\s+auf\b|\boven\b", re.IGNORECASE)
_TEMP = re.compile(r"(\d{2,3})\s*(?:°\s*c?\b|°|grad\b|degrees?\b)", re.IGNORECASE)
_MIN = re.compile(
    r"(\d{1,3})(?:\s*(?:-|–|bis)\s*(\d{1,3}))?\s*(?:min\b|min\.|minuten\b|minutes?\b|mins?\b)",
    re.IGNORECASE,
)
_HOURS = re.compile(r"(\d{1,2})(?:[.,](\d))?\s*(?:std\.?|stunden?\b|h\b|hours?\b)", re.IGNORECASE)
_PREHEAT = re.compile(r"vorheiz|vorgeheizt|preheat", re.IGNORECASE)
# „backen“, „garen“, „rösten“ … ohne Grad: gehört zum zuletzt vorgeheizten Ofen
_BAKE_WORD = re.compile(r"\b(?:backen|überbacken|garen|rösten|braten|bake|roast)\b", re.IGNORECASE)

OVEN_MODES = (
    (re.compile(r"umluft\s*\+\s*grill|umluft\s+und\s+grill", re.IGNORECASE), "Umluft + Grill"),
    (re.compile(r"umluft|fan\b|convection", re.IGNORECASE), "Umluft"),
    (re.compile(r"ober\s*-?\s*/?\s*(?:und\s*)?unterhitze|top\s*(?:and|&)\s*bottom", re.IGNORECASE), "Ober-/Unterhitze"),
    (re.compile(r"pizzastufe", re.IGNORECASE), "Pizzastufe"),
    (re.compile(r"\bunterhitze\b", re.IGNORECASE), "Unterhitze"),
    (re.compile(r"\bgrill(?:en|funktion|stufe)?\b|broil", re.IGNORECASE), "Grill"),
    (re.compile(r"hei(?:ß|ss)luft", re.IGNORECASE), "Heißluft"),
)
FRYER_MODES = (
    (re.compile(r"aufw(?:ä|ae)rm|reheat", re.IGNORECASE), "Aufwärmen"),
    (re.compile(r"\bgrill", re.IGNORECASE), "Grillen"),
    (re.compile(r"\bback|\bbake", re.IGNORECASE), "Backen"),
)


def _minutes(text: str) -> tuple[int | None, int | None]:
    m = _MIN.search(text)
    if m:
        lo, hi = int(m.group(1)), int(m.group(2)) if m.group(2) else None
        if 0 < lo <= 1440:
            return lo, hi if hi and hi > lo else None
    h = _HOURS.search(text)
    if h:
        total = int(h.group(1)) * 60 + (int(h.group(2)) * 6 if h.group(2) else 0)
        if 0 < total <= 1440:
            return total, None
    return None, None


def _mode(text: str, table: tuple) -> str | None:
    for rx, name in table:
        if rx.search(text):
            return name
    return None


def guess_heat(steps: str | list[str] | None) -> list[dict[str, Any]]:
    """Schritte durchsuchen → Einträge für „Backofen & Co.“ (höchstens 6).

    Jeder Eintrag: device, mode, temp, minutes, minutes_to, preheat, steps (Nummern ab 1).
    """
    lines = steps if isinstance(steps, list) else str(steps or "").split("\n")
    lines = [str(x).strip() for x in lines if str(x).strip()]
    rows: list[dict[str, Any]] = []
    last_oven: dict[str, Any] | None = None
    for n, line in enumerate(lines, start=1):
        fryer = bool(_FRYER.search(line))
        oven = not fryer and bool(_OVEN.search(line))
        t = _TEMP.search(line)
        temp = int(t.group(1)) if t else None
        if temp is not None and not 30 <= temp <= 300:
            temp = None
        lo, hi = _minutes(line)
        if fryer or (oven and temp):
            if not temp and not lo:
                continue  # nur erwähnt („die Fritteuse sauber machen“) – nichts zum Einstellen
            row = {
                "device": "Heißluftfritteuse" if fryer else "Backofen",
                "mode": _mode(line, FRYER_MODES) or "Heißluft" if fryer else _mode(line, OVEN_MODES),
                "temp": temp,
                "minutes": lo,
                "minutes_to": hi,
                "preheat": bool(_PREHEAT.search(line)),
                "note": None,
                "steps": [n],
            }
            rows.append(row)
            last_oven = row if not fryer else None
            continue
        # „35 Minuten backen“ ohne Grad: gehört zum Ofen von vorhin
        if last_oven is not None and lo and (_BAKE_WORD.search(line) or oven):
            if not last_oven["minutes"]:
                last_oven["minutes"], last_oven["minutes_to"] = lo, hi
            if n not in last_oven["steps"]:
                last_oven["steps"].append(n)
    return rows[:MAX_ROWS]
