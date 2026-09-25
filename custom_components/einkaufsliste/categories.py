"""Eingebautes Wörterbuch: rät die Kategorie aus dem Produktnamen."""

from __future__ import annotations

from typing import Any

# (Stichworte im Namen deiner Kategorie, Produkte die dazugehören)
# Kurze Wörter (bis 3 Buchstaben) müssen als ganzes Wort vorkommen,
# längere dürfen auch in zusammengesetzten Wörtern stecken (z. B. „Vollmilch“).
DICTIONARY: list[tuple[tuple[str, ...], tuple[str, ...]]] = [
    (
        ("obst", "gemüse", "gemuese"),
        (
            "apfel", "äpfel", "banane", "birne", "orange", "mandarine", "clementine", "zitrone",
            "limette", "traube", "erdbeere", "himbeere", "heidelbeere", "blaubeere", "kiwi",
            "mango", "ananas", "melone", "pfirsich", "nektarine", "kirsche", "pflaume", "obst",
            "tomate", "gurke", "paprika", "salat", "rucola", "zwiebel", "knoblauch", "kartoffel",
            "karotte", "möhre", "zucchini", "aubergine", "brokkoli", "blumenkohl", "kohlrabi",
            "rotkohl", "weißkohl", "spitzkohl", "pilz", "champignon", "lauch", "porree",
            "sellerie", "radieschen", "avocado", "ingwer", "petersilie", "schnittlauch",
            "basilikum", "kräuter", "gemüse", "süßkartoffel", "kürbis", "spargel", "fenchel",
        ),
    ),
    (
        ("back", "brot"),
        (
            "brot", "brötchen", "baguette", "toast", "croissant", "brezel", "laugen", "semmel",
            "kuchen", "torte", "knäcke", "zwieback", "wrap", "tortilla", "fladenbrot",
            "ciabatta", "berliner", "muffin", "donut", "hefezopf", "stuten", "waffel",
        ),
    ),
    (
        ("kühl", "kuehl", "milch"),
        (
            "milch", "joghurt", "jogurt", "quark", "käse", "butter", "sahne", "schmand",
            "creme fraiche", "crème fraîche", "frischkäse", "mozzarella", "feta", "gouda",
            "parmesan", "ei", "eier", "margarine", "pudding", "kefir", "skyr", "hefe",
            "schlagsahne", "kochsahne", "camembert", "hüttenkäse", "mascarpone", "ricotta",
            "grillkäse", "halloumi", "tofu", "hummus",
        ),
    ),
    (
        ("fleisch", "wurst", "fisch"),
        (
            "fleisch", "hack", "hähnchen", "huhn", "hühnchen", "pute", "schnitzel", "steak",
            "wurst", "würstchen", "salami", "schinken", "speck", "bacon", "aufschnitt",
            "frikadelle", "gulasch", "braten", "kotelett", "filet", "lachs", "fisch", "garnele",
            "krabben", "hering", "forelle", "chicken", "nuggets", "leberkäse", "mett",
        ),
    ),
    (
        ("tk", "tiefkühl", "tiefkuehl"),
        (
            "tk", "tiefkühl", "pizza", "eis", "eiscreme", "pommes", "fischstäbchen",
            "kroketten", "rahmspinat", "schlemmerfilet", "eiswürfel", "flammkuchen",
            "rösti", "baguettes", "tiefkühlgemüse", "backfisch",
        ),
    ),
    (
        ("vorrat", "konserve"),
        (
            "nudeln", "spaghetti", "pasta", "penne", "fusilli", "lasagne", "reis", "mehl",
            "zucker", "salz", "pfeffer", "öl", "olivenöl", "essig", "konserve", "dose", "mais",
            "bohnen", "linsen", "kichererbsen", "thunfisch", "tomatenmark", "passierte",
            "ketchup", "senf", "mayo", "mayonnaise", "brühe", "gewürz", "müsli", "haferflocken",
            "cornflakes", "honig", "marmelade", "konfitüre", "nutella", "kaffee", "tee",
            "kakao", "soße", "sauce", "pesto", "backpulver", "vanillezucker", "grieß",
            "couscous", "suppe", "erdnussbutter", "sirup",
        ),
    ),
    (
        ("süß", "suess", "snack"),
        (
            "schokolade", "schoko", "chips", "gummibärchen", "gummibär", "bonbon", "keks",
            "süßigkeit", "riegel", "nüsse", "erdnüsse", "popcorn", "flips", "lakritz",
            "praline", "salzstangen", "cracker", "kaugummi", "marshmallow",
        ),
    ),
    (
        ("getränk", "getraenk"),
        (
            "wasser", "sprudel", "saft", "schorle", "cola", "fanta", "sprite", "limo",
            "limonade", "bier", "wein", "sekt", "eistee", "energy", "radler", "mineralwasser",
            "kasten", "kiste", "whisky", "wodka", "likör", "prosecco", "smoothie",
        ),
    ),
    (
        ("drogerie",),
        (
            "zahnpasta", "zahnbürste", "zahnseide", "mundspülung", "shampoo", "duschgel",
            "seife", "deo", "creme", "windel", "feuchttücher", "rasier", "tampon", "binden",
            "wattepads", "wattestäbchen", "taschentücher", "pflaster", "sonnencreme",
            "haargel", "spülung", "lotion", "bodylotion", "handcreme", "nagellack", "makeup",
            "schminke", "haarspray", "kontaktlinsen",
        ),
    ),
    (
        ("haushalt",),
        (
            "spülmittel", "waschmittel", "weichspüler", "müllbeutel", "müllsack", "küchenrolle",
            "alufolie", "frischhaltefolie", "backpapier", "schwamm", "putzmittel", "reiniger",
            "spülmaschinentabs", "tabs", "klopapier", "toilettenpapier", "batterie",
            "batterien", "glühbirne", "kerze", "servietten", "gefrierbeutel", "entkalker",
            "spültücher", "lappen", "wc", "glasreiniger",
        ),
    ),
]


def category_hints(categories: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Wörterbuch auf deine eigenen Kategorien umgerechnet (für die Karte)."""
    hints = []
    for cat_words, products in DICTIONARY:
        cat = next(
            (c for c in categories if any(w in c["name"].lower() for w in cat_words)), None
        )
        if cat is not None:
            hints.append({"id": cat["id"], "words": list(products)})
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
