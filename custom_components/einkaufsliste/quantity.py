"""🔢 Mengen: „3 milch“ -> Milch · 3x, „1l“/„1 Liter“ -> „1 L“, „500gr“ -> „500 g“."""

from __future__ import annotations

import re

# Schreibweise -> ordentliche Einheit
_UNIT_MAP: dict[str, str] = {}
for canon, variants in {
    "x": ("x", "×", "mal", "stk", "stück", "st", "stck"),
    "g": ("g", "gr", "gramm"),
    "kg": ("kg", "kilo", "kilogramm"),
    "mg": ("mg",),
    "ml": ("ml", "milliliter"),
    "cl": ("cl",),
    "dl": ("dl",),
    "L": ("l", "ltr", "liter"),
    "EL": ("el", "essl", "esslöffel"),
    "TL": ("tl", "teel", "teelöffel"),
    "Pck.": ("pck", "pkt", "päckchen", "packung", "packungen", "pack"),
    "Prise": ("prise", "prisen"),
    "Dose": ("dose",),
    "Dosen": ("dosen",),
    "Becher": ("becher",),
    "Bund": ("bund",),
    "Flasche": ("flasche",),
    "Flaschen": ("flaschen",),
    "Kiste": ("kiste",),
    "Kisten": ("kisten",),
    "Glas": ("glas",),
    "Gläser": ("gläser",),
    "Rolle": ("rolle",),
    "Rollen": ("rollen",),
    "Beutel": ("beutel",),
    "Tüte": ("tüte",),
    "Tüten": ("tüten",),
    "Scheiben": ("scheiben",),
    "Zehen": ("zehe", "zehen"),
}.items():
    for v in variants:
        _UNIT_MAP[v] = canon

_NUM = r"\d+(?:[.,]\d+)?(?:\s*/\s*\d+)?"
_UNITS = "|".join(sorted((re.escape(u) for u in _UNIT_MAP), key=len, reverse=True))
_QTY = re.compile(rf"^\s*(?P<num>{_NUM})\s*(?P<unit>(?:{_UNITS})\.?)?\s*$", re.IGNORECASE)
_START = re.compile(rf"^\s*(?P<num>{_NUM})\s*(?:(?P<unit>(?:{_UNITS}))\.?(?=\s)|(?=\s))\s*(?P<rest>.+)$", re.IGNORECASE)
_END = re.compile(rf"^(?P<rest>.+?)\s+(?P<num>{_NUM})\s*(?P<unit>(?:{_UNITS}))?\.?\s*$", re.IGNORECASE)


def _fmt(num: str, unit: str | None) -> str:
    num = re.sub(r"\s+", "", num)
    canon = _UNIT_MAP.get((unit or "").lower().rstrip("."), None) if unit else None
    if canon is None or canon == "x":
        return f"{num}x"
    return f"{num} {canon}"


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
    return _fmt(m.group("num"), m.group("unit"))


def split_qty(name: str | None) -> tuple[str | None, str | None]:
    """Menge aus dem Namen holen: „3 milch“, „milch 3x“, „500g mehl“ -> (Name, Menge)."""
    if not name:
        return name, None
    text = " ".join(str(name).split())
    for rx in (_START, _END):
        m = rx.match(text)
        if not m:
            continue
        rest = m.group("rest").strip(" ,-")
        if not re.search(r"[A-Za-zÄÖÜäöüß]", rest):
            continue
        # „Cola 2“ ja, aber nicht „Xbox 360“: am Ende nur kleine Zahlen ohne Einheit
        if rx is _END and not m.group("unit"):
            try:
                if float(m.group("num").replace(",", ".").split("/")[0]) > 50:
                    continue
            except ValueError:
                continue
        return rest, _fmt(m.group("num"), m.group("unit"))
    return text, None
