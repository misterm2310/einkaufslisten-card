"""📱 Alte-iPhone-Check: Läuft der Browser-Code auch auf iOS 15?

Safari kann Lookbehind in Suchmustern ((?<=…) und (?<!…)) erst ab iOS 16.4.
Steht so ein Muster im Code, lädt iOS 15 die ganze Datei nicht und die Karte bleibt weg (Issue #20).
"""

from __future__ import annotations

import re
from pathlib import Path

WWW = Path(__file__).resolve().parent.parent / "custom_components" / "einkaufsliste" / "www"
LOOKBEHIND = re.compile(r"\(\?<[=!]")


def _browser_files() -> list[Path]:
    files = [p for p in WWW.rglob("*") if p.suffix in (".js", ".mjs", ".html")]
    assert files, "Keine Browser-Dateien gefunden"
    return files


def test_no_regex_lookbehind_for_old_safari() -> None:
    funde = []
    for path in _browser_files():
        for nr, zeile in enumerate(path.read_text(encoding="utf-8", errors="ignore").splitlines(), 1):
            if LOOKBEHIND.search(zeile):
                funde.append(f"{path.relative_to(WWW)}:{nr}")
    assert not funde, "Lookbehind bricht die Karte auf iOS < 16.4: " + ", ".join(funde)
