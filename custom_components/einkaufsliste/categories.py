"""Eingebautes Wörterbuch: rät die Kategorie aus dem Produktnamen."""

from __future__ import annotations

import json
import logging
import re
from pathlib import Path
from typing import Any

_LOGGER = logging.getLogger(__name__)
_FILE = Path(__file__).parent / "data" / "kategorien.json"


def load_dictionary(path: Path = _FILE) -> list[dict[str, Any]]:
    """📖 Wörterbuch aus data/kategorien.json – jeder kann es ergänzen, ohne Python anzufassen.

    Pro Kategorie: "match" = Stichworte im Namen DEINER Kategorie, "words" = Produkte je Sprache.
    "de" darf in zusammengesetzten Wörtern stecken („Vollmilch“), alle anderen Sprachen nur als ganzes Wort.
    """
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as err:
        _LOGGER.error("📖 Kategorie-Wörterbuch %s nicht lesbar: %s", path, err)
        return []
    out = []
    for cat in raw.get("categories", []):
        match = [str(w).lower() for w in cat.get("match") or [] if str(w).strip()]
        words = cat.get("words") or {}
        if not match or not isinstance(words, dict):
            continue
        out.append({
            "key": str(cat.get("id") or ""),
            "match": match,
            "de": [str(w).lower() for w in words.get("de") or []],
            "other": [str(w).lower() for lang, ws in words.items() if lang != "de" for w in ws or []],
        })
    return out


# Einmal beim Laden der Integration (Home Assistant lädt Integrationen im Hintergrund, nicht im Event-Loop)
DICTIONARY: list[dict[str, Any]] = load_dictionary()


def category_hints(categories: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Wörterbuch auf deine eigenen Kategorien umgerechnet (für die Karte)."""
    hints = []
    for entry in DICTIONARY:
        cat = next(
            (c for c in categories if any(w in c["name"].lower() for w in entry["match"])), None
        )
        if cat is not None:  # "en" = alle anderen Sprachen (nur ganze Wörter)
            hints.append({"id": cat["id"], "key": entry.get("key", ""), "words": list(entry["de"]), "en": list(entry["other"])})
    return hints


def _best_in(text: str, hints: list[dict[str, Any]], min_len: int, whole: bool) -> str | None:
    best: tuple[int, str | None] = (0, None)
    for hint in hints:
        for word in hint["words"]:
            if len(word) < min_len or len(word) <= best[0]:
                continue
            hit = (text == word) if (whole and len(word) <= 3) else (word in text)
            if hit:
                best = (len(word), hint["id"])
        for word in hint.get("en", ()):
            if len(word) < min_len or len(word) <= best[0]:
                continue
            if re.search(rf"(?<![a-zäöüß]){re.escape(word)}(?:s|es)?(?![a-zäöüß])", text):
                best = (len(word), hint["id"])
    return best[1]


def guess_category(name: str, categories: list[dict[str, Any]]) -> str | None:
    """Kategorie-ID raten.

    1. Lange Wörter (ab 8 Buchstaben) im ganzen Namen, z. B. „Milchschokolade“.
    2. Sonst Wort für Wort von vorne: das erste Wort mit Treffer entscheidet,
       z. B. „Pizza Salami“ -> Pizza -> TK-Ware.
    """
    hints = category_hints(categories)
    text = (name or "").lower().strip()
    if not text:
        return None
    found = _best_in(text.replace("-", ""), hints, 8, False)
    if found:
        return found
    for token in text.replace("-", " ").split():
        found = _best_in(token, hints, 1, True)
        if found:
            return found
    return None
