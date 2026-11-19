"""🩺 Reparatur-Hinweise in Home Assistant (Einstellungen → System → Reparaturen).

Probleme, die man sonst nur in der Karte sieht, stehen zusätzlich dort, wo Home Assistant alle Baustellen sammelt:
ungültiger Grocy-Schlüssel, Grocy nicht erreichbar, Marktguru-Angebote oder die Rückruf-Warnung gerade nicht abrufbar.
Ist das Problem weg (oder die Funktion ausgeschaltet), verschwindet der Hinweis von selbst.
Nur Hinweise – es wird nichts automatisch „repariert“.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import issue_registry as ir

from .const import DOMAIN

if TYPE_CHECKING:
    from .manager import EinkaufslisteManager

# Alle Hinweise, die es geben kann (Schlüssel = translation_key in strings.json → issues)
ISSUES = ("grocy_key", "grocy_unreachable", "offers_down", "recalls_down")


def wanted_issues(m: EinkaufslisteManager) -> dict[str, dict[str, str]]:
    """Welche Hinweise sollen gerade stehen? (Schlüssel → Platzhalter für den Text)"""
    out: dict[str, dict[str, str]] = {}
    grocy = m.grocy or {}
    status = grocy.get("status") or {}
    if grocy.get("url") and (grocy.get("a_on") or grocy.get("b_on")) and status.get("ok") is False:
        msg = str(status.get("msg") or "")
        key = "grocy_key" if "Schlüssel" in msg or "API key" in msg else "grocy_unreachable"
        out[key] = {"url": str(grocy.get("url") or ""), "error": msg[:200]}
    offers = m.offers_cfg or {}
    if offers.get("enabled") and offers.get("ok") is False:
        out["offers_down"] = {"error": str(offers.get("error") or "")[:200]}
    recalls = m.recalls_cfg or {}
    if recalls.get("enabled") and recalls.get("ok") is False:
        out["recalls_down"] = {"error": str(recalls.get("error") or "")[:200]}
    return out


@callback
def sync_issues(hass: HomeAssistant, m: EinkaufslisteManager, cache: dict[str, Any]) -> None:
    """Reparatur-Hinweise an den Stand anpassen. Schreibt nur, wenn sich etwas geändert hat (läuft bei jeder Änderung)."""
    want = wanted_issues(m)
    if cache.get("sig") == want:
        return
    cache["sig"] = want
    for key in ISSUES:
        if key in want:
            ir.async_create_issue(
                hass, DOMAIN, key, is_fixable=False, is_persistent=False,
                severity=ir.IssueSeverity.WARNING, translation_key=key, translation_placeholders=want[key],
            )
        else:
            ir.async_delete_issue(hass, DOMAIN, key)


@callback
def clear_issues(hass: HomeAssistant) -> None:
    """Integration entfernt: alle Hinweise weg."""
    for key in ISSUES:
        ir.async_delete_issue(hass, DOMAIN, key)
