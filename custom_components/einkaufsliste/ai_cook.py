"""🤖 „Was kann ich damit kochen?“ – fragt den KI-Assistenten, den du in Home Assistant eingerichtet hast.

Es wird nur die Zutatenliste (Namen) und ein kurzer Auftrag an den gewählten Assistenten geschickt – über den
Home-Assistant-Dienst conversation.process. Ob der Assistent in der Cloud oder lokal läuft, entscheidest du
mit der Wahl des Assistenten. Standardmäßig ist das Ganze aus.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from typing import TYPE_CHECKING, Any

from homeassistant.exceptions import HomeAssistantError

if TYPE_CHECKING:
    from homeassistant.core import HomeAssistant

    from .manager import EinkaufslisteManager

_LOGGER = logging.getLogger(__name__)

TIMEOUT = 90
MAX_INGREDIENTS = 60

PROMPT = (
    "Du bist ein Kochhelfer. Ich habe diese Zutaten zu Hause oder auf der Einkaufsliste:\n{items}\n"
    "{wishes}"
    "Schlage bis zu {n} einfache Gerichte vor. Nimm vor allem diese Zutaten; übliche Vorräte (Salz, Pfeffer, Öl, "
    "Wasser) darfst du voraussetzen. Antworte NUR mit JSON, ohne Text davor oder danach, genau in dieser Form:\n"
    '{{"ideas":[{{"name":"Name des Gerichts","time":"z. B. 25 Min.","servings":2,'
    '"have":["Zutat mit Menge, die ich schon habe"],"missing":["Zutat mit Menge, die ich noch kaufen muss"],'
    '"steps":["Schritt 1","Schritt 2"]}}]}}\n'
    "Schreibe alles auf Deutsch. Jede Zutat als kurze Zeile wie \"2 Zwiebeln\" oder \"Nudeln\"."
)


def _clean_list(value: Any, limit: int, size: int = 80) -> list[str]:
    out: list[str] = []
    for x in value if isinstance(value, list) else []:
        t = " ".join(str(x or "").split())[:size]
        if t and t.lower() not in [o.lower() for o in out]:
            out.append(t)
        if len(out) >= limit:
            break
    return out


def parse_ideas(text: str) -> list[dict[str, Any]]:
    """Aus der Antwort der KI die Gerichte holen (auch wenn sie ```json … ``` oder Text drumherum schreibt)."""
    text = str(text or "").strip()
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text, flags=re.I)
    a, b = text.find("{"), text.rfind("}")
    if a < 0 or b <= a:
        raise ValueError("Die KI hat keine lesbare Antwort geliefert. Bitte nochmal versuchen.")
    try:
        data = json.loads(text[a : b + 1])
    except ValueError as err:
        raise ValueError("Die KI hat keine lesbare Antwort geliefert. Bitte nochmal versuchen.") from err
    ideas: list[dict[str, Any]] = []
    for raw in (data.get("ideas") if isinstance(data, dict) else data) or []:
        if not isinstance(raw, dict):
            continue
        name = " ".join(str(raw.get("name") or "").split())[:80]
        if not name:
            continue
        try:
            servings = int(raw.get("servings") or 0)
        except (TypeError, ValueError):
            servings = 0
        ideas.append({
            "name": name,
            "time": " ".join(str(raw.get("time") or "").split())[:30],
            "servings": servings if 1 <= servings <= 99 else None,
            "have": _clean_list(raw.get("have"), 30),
            "missing": _clean_list(raw.get("missing"), 30),
            "steps": _clean_list(raw.get("steps"), 25, 400),
        })
        if len(ideas) >= 5:
            break
    if not ideas:
        raise ValueError("Die KI hat keine Gerichte vorgeschlagen. Bitte nochmal versuchen (oder andere Zutaten).")
    return ideas


async def async_cook(hass: HomeAssistant, manager: EinkaufslisteManager, ingredients: list[str],
                     use_list: bool, wishes: str = "", count: int = 3) -> list[dict[str, Any]]:
    agent = manager.ai_agent if manager.ai_on else None
    if not agent:
        raise ValueError("KI-Kochen ist aus. Ein Admin kann es in den ⚙️ Einstellungen → Extras einschalten.")
    if manager.privacy:
        raise ValueError("🔒 Der Datenschutz ist an – deshalb wird nichts an eine KI geschickt.")
    names = _clean_list(list(ingredients), MAX_INGREDIENTS)
    if use_list:
        for it in manager.items:
            if not it["checked"] and it["name"].lower() not in [n.lower() for n in names]:
                names.append(it["name"][:80])
        names = names[:MAX_INGREDIENTS]
    if not names:
        raise ValueError("Trag ein paar Zutaten ein (oder nimm die Einkaufsliste mit) – sonst weiß die KI nicht, womit sie kochen soll.")
    wish = " ".join(str(wishes or "").split())[:200]
    text = PROMPT.format(items="\n".join(f"- {n}" for n in names),
                         wishes=f"Wünsche: {wish}\n" if wish else "", n=max(1, min(int(count), 5)))
    try:
        async with asyncio.timeout(TIMEOUT):
            result = await hass.services.async_call(
                "conversation", "process", {"text": text, "agent_id": agent, "language": "de"},
                blocking=True, return_response=True)
    except TimeoutError as err:
        raise ValueError("Die KI hat zu lange gebraucht. Bitte nochmal versuchen.") from err
    except HomeAssistantError as err:
        _LOGGER.warning("KI-Kochen: Assistent %s antwortet nicht: %s", agent, err)
        raise ValueError("Der KI-Assistent in Home Assistant hat nicht geantwortet – ist er richtig eingerichtet?") from err
    resp = (result or {}).get("response") or {}
    speech = (((resp.get("speech") or {}).get("plain") or {}).get("speech")) or ""
    if resp.get("response_type") == "error" and not speech.strip().startswith(("{", "[", "`")):
        raise ValueError(f"Der KI-Assistent meldet einen Fehler: {speech[:120] or 'unbekannt'}")
    return parse_ideas(speech)
