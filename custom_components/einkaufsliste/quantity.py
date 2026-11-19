"""🔢 Mengen einheitlich schreiben.

„3 milch“ -> Milch · 3x, „3el“ -> „3 EL“, „500gr“ -> „500 g“, „1/2 tl“ -> „0,5 TL“,
„2 bis 3 el“ -> „2-3 EL“, „2 tasse“ -> „2 Tassen“, „1 zehen“ -> „1 Zehe“.

Die Karte (einkaufsliste-card.js) hat genau dieselben Regeln (normQty) –
wer hier etwas ändert, ändert es dort bitte auch.
"""

from __future__ import annotations

import math
import re

# (Einzahl, Mehrzahl, Schreibweisen) – Einzahl bei genau 1, sonst Mehrzahl
# (englische Schreibweisen wie „tbsp“, „cans“ oder „cloves“ gehen auch – für englische Nutzer)
UNIT_DEFS: tuple[tuple[str, str, tuple[str, ...]], ...] = (
    ("x", "x", ("x", "×", "mal", "stk", "stück", "st", "stck", "pc", "pcs", "piece", "pieces")),
    ("g", "g", ("g", "gr", "gramm", "gram", "grams")),
    ("kg", "kg", ("kg", "kilo", "kilogramm", "kilos")),
    ("mg", "mg", ("mg", "milligramm")),
    ("ml", "ml", ("ml", "milliliter")),
    ("cl", "cl", ("cl",)),
    ("dl", "dl", ("dl",)),
    ("L", "L", ("l", "ltr", "liter", "litre", "litres", "liters")),
    ("EL", "EL", ("el", "essl", "esslöffel", "tbsp", "tbs")),
    ("TL", "TL", ("tl", "teel", "teelöffel", "tsp")),
    ("Msp.", "Msp.", ("msp", "messerspitze", "messerspitzen")),
    ("Pck.", "Pck.", ("pck", "pkt", "päckchen", "packung", "packungen", "pack", "packs", "package", "packages", "packet", "packets")),
    ("Prise", "Prisen", ("prise", "prisen", "pinch", "pinches")),
    ("Dose", "Dosen", ("dose", "dosen", "can", "cans", "tin", "tins")),
    ("Becher", "Becher", ("becher", "tub", "tubs")),
    ("Bund", "Bund", ("bund", "bunch", "bunches")),
    ("Flasche", "Flaschen", ("flasche", "flaschen", "bottle", "bottles")),
    ("Kiste", "Kisten", ("kiste", "kisten", "crate", "crates")),
    ("Glas", "Gläser", ("glas", "gläser", "jar", "jars")),
    ("Rolle", "Rollen", ("rolle", "rollen")),
    ("Beutel", "Beutel", ("beutel", "bag", "bags")),
    ("Tüte", "Tüten", ("tüte", "tüten")),
    ("Scheibe", "Scheiben", ("scheibe", "scheiben", "slice", "slices")),
    ("Zehe", "Zehen", ("zehe", "zehen", "clove", "cloves")),
    ("Tasse", "Tassen", ("tasse", "tassen", "cup", "cups")),
    ("Schluck", "Schluck", ("schluck", "schlucke")),
    ("Schuss", "Schuss", ("schuss",)),
    ("Spritzer", "Spritzer", ("spritzer",)),
    ("Tropfen", "Tropfen", ("tropfen", "drop", "drops")),
    ("Handvoll", "Handvoll", ("handvoll", "handful", "handfuls")),
    ("Stange", "Stangen", ("stange", "stangen", "stick", "sticks")),
    ("Kopf", "Köpfe", ("kopf", "köpfe", "head", "heads")),
    ("Würfel", "Würfel", ("würfel", "cube", "cubes")),
    ("Zweig", "Zweige", ("zweig", "zweige", "sprig", "sprigs")),
    ("Blatt", "Blatt", ("blatt", "blätter", "leaf", "leaves")),
    ("Knolle", "Knollen", ("knolle", "knollen", "bulb", "bulbs")),
    ("Kugel", "Kugeln", ("kugel", "kugeln", "scoop", "scoops")),
    ("Schale", "Schalen", ("schale", "schalen", "tray", "trays")),
    ("Netz", "Netze", ("netz", "netze")),
)

_UNIT_MAP: dict[str, tuple[str, str]] = {}
for _one, _many, _variants in UNIT_DEFS:
    for _v in _variants:
        _UNIT_MAP[_v] = (_one, _many)

UNIT_WORDS = tuple(_UNIT_MAP)  # alle erlaubten Schreibweisen (klein)

_FRAC = {"½": 0.5, "¼": 0.25, "¾": 0.75, "⅓": 1 / 3, "⅔": 2 / 3, "⅛": 0.125}
_FR = "[½¼¾⅓⅔⅛]"
# eine Zahl: „1½“, „1 1/2“, „1,5“, „1.5“, „1/2“, „½“
NUM1 = rf"(?:\d+\s*{_FR}|\d+\s+\d+\s*/\s*\d+|\d+(?:[.,]\d+)?(?:\s*/\s*\d+)?|{_FR})"
# eine Zahl oder ein Bereich: „2-3“, „2 – 3“, „2 bis 3“
NUM = rf"{NUM1}(?:\s*(?:-|–|—|bis)\s*{NUM1})?"
_RANGE = re.compile(rf"^(?P<a>{NUM1})(?:\s*(?:-|–|—|bis)\s*(?P<b>{NUM1}))?$", re.IGNORECASE)

_UNITS = "|".join(sorted((re.escape(u) for u in _UNIT_MAP), key=len, reverse=True))
_QTY = re.compile(rf"^\s*(?P<num>{NUM})\s*(?P<unit>(?:{_UNITS})\.?)?\s*$", re.IGNORECASE)
_START = re.compile(rf"^\s*(?P<num>{NUM})\s*(?:(?P<unit>(?:{_UNITS}))\.?(?=\s)|(?=\s))\s*(?P<rest>.+)$", re.IGNORECASE)
_END = re.compile(rf"^(?P<rest>.+?)\s+(?P<num>{NUM})\s*(?P<unit>(?:{_UNITS}))?\.?\s*$", re.IGNORECASE)
# „Milch (2)“ / „Mehl (500 g)“ – so schreiben es z. B. OurGroceries und andere Apps
_PAREN = re.compile(rf"^(?P<rest>.+?)\s*\(\s*(?P<num>{NUM})\s*(?P<unit>(?:{_UNITS}))?\.?\s*\)\s*$", re.IGNORECASE)


def _value(text: str) -> float | None:
    """Eine Zahl lesen: „1½“ -> 1.5, „1 1/2“ -> 1.5, „1/2“ -> 0.5, „1,5“ -> 1.5."""
    t = text.strip()
    if m := re.fullmatch(rf"(\d*)\s*({_FR})", t):
        return int(m.group(1) or 0) + _FRAC[m.group(2)]
    if m := re.fullmatch(r"(\d+)\s+(\d+)\s*/\s*(\d+)", t):
        return int(m.group(1)) + int(m.group(2)) / int(m.group(3)) if int(m.group(3)) else None
    if m := re.fullmatch(r"(\d+)\s*/\s*(\d+)", t):
        return int(m.group(1)) / int(m.group(2)) if int(m.group(2)) else None
    if m := re.fullmatch(r"([1-9]\d*)\.(\d{3})", t):  # „1.000“ = tausend
        return float(m.group(1) + m.group(2))
    try:
        return float(t.replace(",", "."))
    except ValueError:
        return None


def _num_text(v: float) -> str:
    """1.0 -> „1“, 0.5 -> „0,5“, 1/3 -> „0,33“ (höchstens 2 Nachkommastellen)."""
    v = math.floor(v * 100 + 0.5) / 100
    if v == int(v):
        return str(int(v))
    return str(v).replace(".", ",")


def _fmt(num: str, unit: str | None) -> str | None:
    """Zahl (oder Bereich) + Einheit ordentlich schreiben. None, wenn die Zahl nicht lesbar ist."""
    m = _RANGE.match(num.strip())
    if not m:
        return None
    a = _value(m.group("a"))
    b = _value(m.group("b")) if m.group("b") else None
    if a is None or (m.group("b") and b is None):
        return None
    text = _num_text(a)
    if b is not None and _num_text(b) != text:
        text += "-" + _num_text(b)
    else:
        b = None
    canon = _UNIT_MAP.get((unit or "").lower().rstrip(".")) if unit else None
    if canon is None or canon[0] == "x":
        return f"{text}x"
    one, many = canon
    last = math.floor((b if b is not None else a) * 100 + 0.5) / 100
    return f"{text} {one if last == 1 else many}"


def norm_qty(qty: str | None) -> str | None:
    """Menge einheitlich schreiben. Unbekanntes bleibt, wie es ist."""
    if qty is None:
        return None
    qty = " ".join(str(qty).split())
    if not qty:
        return None
    m = _QTY.match(qty)
    if not m:
        return qty
    return _fmt(m.group("num"), m.group("unit")) or qty


UNIT_CHOICES = tuple(one for one, _, _ in UNIT_DEFS)  # zur Auswahl (Einzahl): x, g, kg, … Netz


def unit_of(qty: str | None) -> str | None:
    """Welche Einheit hat die Menge? „2 Dosen“ -> „Dose“, „3x“ -> „x“, „etwas“ -> None."""
    m = _QTY.match(qty or "")
    if not m:
        return None
    if not m.group("unit"):
        return "x"
    canon = _UNIT_MAP.get(m.group("unit").lower().rstrip("."))
    return canon[0] if canon else None


def is_bare(qty: str | None) -> bool:
    """Nur eine Zahl ohne Einheit? („2“ ja, „2x“ / „2 L“ nein)"""
    return bool(qty) and re.fullmatch(rf"\s*{NUM}\s*", str(qty), re.IGNORECASE) is not None


def apply_unit(qty: str | None, unit: str | None) -> str | None:
    """Andere Einheit an die Zahl: („2x“, „Pck.“) -> „2 Pck.“; („1 Dose“, „x“) -> „1x“."""
    m = _QTY.match(qty or "")
    if not m or not unit or unit.lower().rstrip(".") not in _UNIT_MAP:
        return qty
    return _fmt(m.group("num"), unit) or qty


def split_qty(name: str | None) -> tuple[str | None, str | None]:
    """Menge aus dem Namen holen: „3 milch“, „milch 3x“, „500g mehl“ -> (Name, Menge)."""
    rest, qty, _bare = split_qty_ex(name)
    return rest, qty


def split_qty_ex(name: str | None) -> tuple[str | None, str | None, bool]:
    """Wie split_qty, sagt zusätzlich, ob nur eine Zahl ohne Einheit dastand („2 backpulver“)."""
    if not name:
        return name, None, False
    text = " ".join(str(name).split())
    for rx in (_PAREN, _START, _END):
        m = rx.match(text)
        if not m:
            continue
        rest = m.group("rest").strip(" ,-")
        if not re.search(r"[A-Za-zÄÖÜäöüß]", rest):
            continue
        # „Cola 2“ ja, aber nicht „Xbox 360“: am Ende nur kleine Zahlen ohne Einheit
        if rx in (_END, _PAREN) and not m.group("unit"):
            first = _RANGE.match(m.group("num").strip())
            val = _value(first.group("a")) if first else None
            if val is None or val > 50:
                continue
        qty = _fmt(m.group("num"), m.group("unit"))
        if qty is None:
            continue
        return rest, qty, not m.group("unit")
    return text, None, False


def amount_of(qty: str | None) -> float | None:
    """🔢 Wie viel ist es? „3x“ -> 3, „2 Pck.“ -> 2, „500 g“ -> 500. Bereiche („2-3“) und Text („etwas“) -> None."""
    m = _QTY.match(qty or "")
    if not m or not _RANGE.match(m.group("num").strip()) or _RANGE.match(m.group("num").strip()).group("b"):
        return None
    return _value(m.group("num"))


def with_amount(qty: str | None, value: float) -> str | None:
    """🔢 Gleiche Einheit, andere Zahl: („3 Pck.“, 1) -> „1 Pck.“, („3x“, 2) -> „2x“."""
    unit = unit_of(qty)
    return _fmt(_num_text(value).replace(",", "."), None if unit in (None, "x") else unit)
