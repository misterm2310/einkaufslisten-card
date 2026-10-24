"""📖 README-Check: Passen die deutsche und die englische Anleitung zusammen?

Verglichen wird nur, was nicht übersetzt wird: Aufbau (Überschriften, Tabellenzeilen, Code-Blöcke,
Aufklapper, Bilder, Links) Abschnitt für Abschnitt, dazu Entitäten, Ereignisse und Karten-Optionen.
Fehlt in einer Sprache ein Abschnitt, eine Tabellenzeile oder ein Beispiel, wird der Test rot.
Zusätzlich muss jede dokumentierte Karten-Option auch in der Karte vorkommen.
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DE = ROOT / "README.md"
EN = ROOT / "README.en.md"
CARD = ROOT / "custom_components" / "einkaufsliste" / "www" / "einkaufsliste-card.js"

HEADING = re.compile(r"^(#{1,6}) ")
CODE_BLOCK = re.compile(r"^```.*?^```", re.M | re.S)
# Spenden-Knöpfe tragen die Sprache in der Adresse („Spenden“/„Donate“) – die zählen nicht als Unterschied
BADGE = re.compile(r"^https://img\.shields\.io/")


def _sections(path: Path) -> list[tuple[str, str]]:
    """README in Abschnitte schneiden: (Überschrift, Text darunter). Überschriften in Code-Blöcken zählen nicht."""
    sections: list[tuple[str, list[str]]] = [("(Anfang)", [])]
    in_code = False
    for line in path.read_text(encoding="utf-8").split("\n"):
        if line.startswith("```"):
            in_code = not in_code
        if not in_code and HEADING.match(line):
            sections.append((line, []))
            continue
        sections[-1][1].append(line)
    return [(head, "\n".join(lines)) for head, lines in sections]


def _shape(body: str) -> dict:
    """Was in beiden Sprachen gleich sein muss."""
    return {
        "Tabellenzeilen": sum(1 for line in body.split("\n") if line.startswith("|")),
        "Code-Blöcke": len(CODE_BLOCK.findall(body)),
        "Aufklapper": body.count("<details>"),
        "Bilder": sorted(re.findall(r"(docs/[\w.-]+\.(?:png|jpg|gif|webp))", body)),
        "Links": sorted(u for u in re.findall(r"\]\((https?://[^)\s]+)\)", body) if not BADGE.match(u)),
    }


def _text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def _entities(text: str) -> set[str]:
    return set(re.findall(r"\b((?:sensor|binary_sensor|todo|event)\.einkaufsliste_[a-z0-9_]+)", text))


def _events(text: str) -> set[str]:
    """Ereignisse wie einkaufsliste_timer_fertig (ohne Entitäts-Namen davor)."""
    return set(re.findall(r"(?<![.\w])(einkaufsliste_[a-z_]+)\b", CODE_BLOCK.sub("", text))) | set(
        re.findall(r"event_type: (einkaufsliste_[a-z_]+)", text)
    )


def _card_options(text: str) -> set[str]:
    """Die Schlüssel aus der Tabelle „Karten-Optionen“ (Zeilen wie | `store` | …)."""
    return set(re.findall(r"^\| `([a-z_]+)` \|", text, re.M))


def test_same_headings():
    de = [HEADING.match(h).group(1) if HEADING.match(h) else "" for h, _ in _sections(DE)]
    en = [HEADING.match(h).group(1) if HEADING.match(h) else "" for h, _ in _sections(EN)]
    assert len(de) == len(en), f"Deutsch hat {len(de) - 1} Überschriften, Englisch {len(en) - 1}"
    assert de == en, "Die Überschriften-Ebenen (#, ##, ###) passen nicht zusammen"


def test_same_shape_per_section():
    problems = []
    for (head_de, body_de), (head_en, body_en) in zip(_sections(DE), _sections(EN)):
        shape_de, shape_en = _shape(body_de), _shape(body_en)
        for key, value in shape_de.items():
            if value != shape_en[key]:
                problems.append(f"{head_de} ↔ {head_en}: {key} {value} ≠ {shape_en[key]}")
    assert not problems, "README.md und README.en.md weichen ab:\n" + "\n".join(problems)


def test_same_entities_events_and_options():
    de, en = _text(DE), _text(EN)
    assert _entities(de) == _entities(en), f"Entitäten: {sorted(_entities(de) ^ _entities(en))}"
    assert _events(de) == _events(en), f"Ereignisse: {sorted(_events(de) ^ _events(en))}"
    assert _card_options(de) == _card_options(en), f"Karten-Optionen: {sorted(_card_options(de) ^ _card_options(en))}"


def test_documented_options_exist_in_card():
    card = CARD.read_text(encoding="utf-8")
    missing = sorted(o for o in _card_options(_text(DE)) if not re.search(rf"\b{o}\b", card))
    assert not missing, f"In der README, aber nicht in der Karte: {missing}"


def test_check_finds_a_missing_row(tmp_path):
    """Gegenprobe: Eine fehlende Tabellenzeile im Englischen muss auffallen."""
    lines = _text(EN).split("\n")
    row = next(i for i, line in enumerate(lines) if line.startswith("| `store`"))
    broken = tmp_path / "README.en.md"
    broken.write_text("\n".join(lines[:row] + lines[row + 1 :]), encoding="utf-8")
    pairs = zip(_sections(DE), _sections(broken))
    assert any(_shape(a)["Tabellenzeilen"] != _shape(b)["Tabellenzeilen"] for (_, a), (_, b) in pairs)
