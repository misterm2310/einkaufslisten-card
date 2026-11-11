"""🧮 Nährwerte pro Portion: aufräumen und aus schema.org/Mealie herauslesen."""

from __future__ import annotations

import re
from typing import Any

# Schlüssel in der Liste -> (höchster sinnvoller Wert, Nachkommastellen)
NUTRITION_KEYS: dict[str, tuple[float, int]] = {
    "kcal": (9999, 0),     # Energie in kcal
    "protein": (999, 1),   # Eiweiß in g
    "fat": (999, 1),       # Fett in g
    "carbs": (999, 1),     # Kohlenhydrate in g
    "sugar": (999, 1),     # davon Zucker in g
    "fiber": (999, 1),     # Ballaststoffe in g
    "salt": (99, 2),       # Salz in g
}

# schema.org (camelCase) und Mealie (mit Unterstrich) -> unser Schlüssel
_SCHEMA = {
    "calories": "kcal",
    "proteinContent": "protein", "protein_content": "protein",
    "fatContent": "fat", "fat_content": "fat",
    "carbohydrateContent": "carbs", "carbohydrate_content": "carbs",
    "sugarContent": "sugar", "sugar_content": "sugar",
    "fiberContent": "fiber", "fiber_content": "fiber",
}


def _number(value: Any) -> tuple[float, str] | None:
    """„898 kcal“, „44,8 g“, "46.7", 12 -> (Zahl, Einheit klein). Nichts Brauchbares -> None."""
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value), ""
    m = re.search(r"(\d+(?:[.,]\d+)?)\s*([a-zA-Zµμ]*)", str(value or ""))
    if not m:
        return None
    return float(m.group(1).replace(",", ".")), m.group(2).lower()


def clean_nutrition(value: Any) -> dict[str, float] | None:
    """Nur bekannte Schlüssel, Zahlen im sinnvollen Bereich, gerundet. Leer -> None."""
    if not isinstance(value, dict):
        return None
    out: dict[str, float] = {}
    for key, (top, digits) in NUTRITION_KEYS.items():
        got = _number(value.get(key))
        if got is None:
            continue
        n = round(got[0], digits)
        if 0 < n <= top:
            out[key] = int(n) if digits == 0 else n
    return out or None


def nutrition_from_schema(node: Any) -> dict[str, float] | None:
    """schema.org „NutritionInformation“ oder Mealie-„nutrition“ -> unsere Nährwerte (pro Portion)."""
    if not isinstance(node, dict):
        return None
    raw: dict[str, Any] = {}
    for src, key in _SCHEMA.items():
        if node.get(src) not in (None, "") and key not in raw:
            raw[key] = node[src]
    if "kcal" in raw:  # „3757 kJ“ statt kcal? Dann umrechnen
        got = _number(raw["kcal"])
        if got and got[1] == "kj":
            raw["kcal"] = got[0] / 4.184
    sodium = node.get("sodiumContent") or node.get("sodium_content")
    got = _number(sodium) if sodium not in (None, "") else None
    if got:  # Natrium -> Salz (× 2,5); ohne Einheit oder „mg“ = Milligramm
        grams = got[0] if got[1] == "g" else got[0] / 1000
        raw["salt"] = grams * 2.5
    return clean_nutrition(raw)
