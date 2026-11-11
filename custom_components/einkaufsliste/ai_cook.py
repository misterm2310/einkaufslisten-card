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

from .nutrition import clean_nutrition

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
                     use_list: bool, wishes: str = "", count: int = 3,
                     servings: int | None = None) -> list[dict[str, Any]]:
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
    try:
        people = int(servings) if servings else 0
    except (TypeError, ValueError):
        people = 0
    pantry = [n for n in manager.ai_pantry if n.lower() not in [x.lower() for x in names]]
    wish_line = ((f"Immer im Haus (darfst du voraussetzen): {', '.join(pantry)}\n" if pantry else "")
                 + (f"Niemals verwenden oder vorschlagen (Allergie/Abneigung): {', '.join(manager.ai_avoid)}\n" if manager.ai_avoid else "")
                 + (f"Wünsche: {wish}\n" if wish else "")
                 + (f"Rechne die Mengen für {people} Personen.\n" if 1 <= people <= 20 else ""))
    text = PROMPT.format(items="\n".join(f"- {n}" for n in names), wishes=wish_line, n=max(1, min(int(count), 5)))
    return parse_ideas(await _ask(hass, agent, text))


async def _ask(hass: HomeAssistant, agent: str, text: str) -> str:
    """Frage an den KI-Assistenten schicken, Antwort-Text zurück (Fehler als verständliche ValueError)."""
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
    return speech


NUT_PROMPT = (
    "Du bist Ernährungsberater. Schätze die Nährwerte PRO PORTION für dieses Rezept ({servings} Portionen):\n{items}\n"
    "Antworte NUR mit JSON, ohne Text davor oder danach, genau in dieser Form (Zahlen ohne Einheit):\n"
    '{{"kcal":0,"protein":0,"fat":0,"carbs":0,"sugar":0,"fiber":0,"salt":0}}\n'
    "kcal in Kilokalorien, alles andere in Gramm."
)


def parse_nutrition(text: str) -> dict[str, float]:
    """🧮 Aus der KI-Antwort die Nährwerte holen (auch mit ```json … ``` drumherum)."""
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", str(text or "").strip(), flags=re.I)
    a, b = text.find("{"), text.rfind("}")
    try:
        data = json.loads(text[a : b + 1]) if 0 <= a < b else None
    except ValueError:
        data = None
    nut = clean_nutrition(data.get("nutrition", data) if isinstance(data, dict) else None)
    if not nut:
        raise ValueError("Die KI hat keine lesbaren Nährwerte geliefert. Bitte nochmal versuchen.")
    return nut


async def async_nutrition(hass: HomeAssistant, manager: EinkaufslisteManager, items: list[str],
                          servings: int | None = None) -> dict[str, float]:
    """🤖🧮 Nährwerte pro Portion vom KI-Assistenten schätzen lassen (Rezept-Editor)."""
    agent = manager.ai_agent if manager.ai_on else None
    if not agent:
        raise ValueError("KI-Kochen ist aus. Ein Admin kann es in den ⚙️ Einstellungen → Extras einschalten.")
    if manager.privacy:
        raise ValueError("🔒 Der Datenschutz ist an – deshalb wird nichts an eine KI geschickt.")
    lines = _clean_list(list(items), MAX_INGREDIENTS, 120)
    if not lines:
        raise ValueError("Trag erst Zutaten ein – sonst kann die KI nichts schätzen.")
    try:
        people = int(servings) if servings else 0
    except (TypeError, ValueError):
        people = 0
    text = NUT_PROMPT.format(servings=people if 1 <= people <= 99 else 1, items="\n".join(f"- {n}" for n in lines))
    return parse_nutrition(await _ask(hass, agent, text))


PHOTO_MAX_BYTES = 6 * 1024 * 1024
PHOTO_INSTRUCTIONS = (
    "Das Bild zeigt ein Rezept (gedruckt, Screenshot oder Handschrift). Lies es genau ab und gib es auf Deutsch zurück: "
    "Name des Gerichts (nur die echte Überschrift, keine App-Leisten oder Benutzernamen), Portionen, Dauer in Minuten, "
    "Zutaten (eine Zeile pro Zutat mit Menge, z. B. \"400 g Nudeln\"), Zubereitungsschritte (ein Eintrag pro Schritt, "
    "ohne Nummerierung). Erfinde nichts dazu; was du nicht lesen kannst, lässt du weg."
)
PHOTO_STRUCTURE = {
    "name": {"description": "Name des Gerichts", "selector": {"text": None}, "required": True},
    "servings": {"description": "Portionen (Zahl)", "selector": {"number": {"min": 1, "max": 99}}},
    "minutes": {"description": "Dauer in Minuten", "selector": {"number": {"min": 0, "max": 1440}}},
    "ingredients": {"description": "Zutaten mit Menge, eine pro Eintrag", "selector": {"text": {"multiple": True}}, "required": True},
    "steps": {"description": "Zubereitungsschritte, einer pro Eintrag", "selector": {"text": {"multiple": True}}, "required": True},
}


def pick_ai_task(hass: HomeAssistant, agent: str | None) -> str | None:
    """Passenden ai_task-Eintrag wählen: derselbe Anbieter wie der gewählte Assistent, sonst der erste."""
    from homeassistant.helpers import entity_registry as er

    ents = sorted(s.entity_id for s in hass.states.async_all("ai_task"))
    if not ents:
        return None
    reg = er.async_get(hass)
    want = reg.async_get(agent) if agent else None
    if want and want.config_entry_id:
        for eid in ents:
            e = reg.async_get(eid)
            if e and e.config_entry_id == want.config_entry_id:
                return eid
    return ents[0]


def parse_photo_recipe(data: Any) -> dict[str, Any]:
    """Antwort von ai_task.generate_data in feste Felder bringen (alles geprüft und gekürzt)."""
    if not isinstance(data, dict):
        raise ValueError("Die KI hat das Foto nicht lesen können. Bitte nochmal versuchen.")

    def lines(v: Any, limit: int, size: int) -> list[str]:
        if isinstance(v, str):
            v = v.splitlines()
        return _clean_list(v if isinstance(v, list) else [], limit, size)

    def num(v: Any, lo: int, hi: int) -> int | None:
        try:
            n = int(float(v))
        except (TypeError, ValueError):
            return None
        return n if lo <= n <= hi else None

    out = {
        "name": " ".join(str(data.get("name") or "").split())[:80],
        "ingredients": lines(data.get("ingredients"), MAX_INGREDIENTS, 120),
        "steps": lines(data.get("steps"), 60, 600),
        "servings": num(data.get("servings"), 1, 99),
        "minutes": num(data.get("minutes"), 0, 1440),
    }
    if not out["ingredients"] and not out["steps"]:
        raise ValueError("Die KI hat auf dem Foto kein Rezept erkannt. Bitte nochmal versuchen (gerade und hell fotografieren).")
    return out


async def async_photo_recipe(hass: HomeAssistant, manager: EinkaufslisteManager, images: list[bytes]) -> dict[str, Any]:
    """📷🤖 Rezeptfoto(s) vom KI-Assistenten lesen lassen (ai_task.generate_data mit Bild)."""
    import uuid
    from pathlib import Path

    agent = manager.ai_agent if manager.ai_on else None
    if not agent:
        raise ValueError("KI-Kochen ist aus. Ein Admin kann es in den ⚙️ Einstellungen → Extras einschalten.")
    if manager.privacy:
        raise ValueError("🔒 Der Datenschutz ist an – deshalb wird nichts an eine KI geschickt.")
    task = pick_ai_task(hass, agent)
    if not task:
        raise ValueError("In Home Assistant gibt es keine „KI-Aufgabe“ (ai_task). Sie wird für Fotos gebraucht – bitte beim KI-Anbieter einrichten.")
    base = (getattr(hass.config, "media_dirs", None) or {}).get("local")
    if not base:
        raise ValueError("Home Assistant hat keinen lokalen Medien-Ordner – der wird gebraucht, um das Foto an die KI zu geben.")
    folder = Path(base) / ".einkaufsliste_tmp"
    files: list[Path] = []
    try:
        def write() -> list[Path]:
            folder.mkdir(parents=True, exist_ok=True)
            for raw in images:
                p = folder / f"{uuid.uuid4().hex}.jpg"
                p.write_bytes(raw)
                files.append(p)
            return files

        await hass.async_add_executor_job(write)
        attachments = [{"media_content_id": f"media-source://media_source/local/.einkaufsliste_tmp/{p.name}",
                        "media_content_type": "image/jpeg"} for p in files]
        try:
            async with asyncio.timeout(TIMEOUT * 2):
                result = await hass.services.async_call(
                    "ai_task", "generate_data",
                    {"entity_id": task, "task_name": "Rezept aus Foto", "instructions": PHOTO_INSTRUCTIONS,
                     "structure": PHOTO_STRUCTURE, "attachments": attachments},
                    blocking=True, return_response=True)
        except TimeoutError as err:
            raise ValueError("Die KI hat zu lange gebraucht. Bitte nochmal versuchen.") from err
        except HomeAssistantError as err:
            _LOGGER.warning("KI-Foto: %s antwortet nicht: %s", task, err)
            raise ValueError("Die KI-Aufgabe in Home Assistant hat nicht geantwortet – kann der Anbieter Bilder lesen?") from err
    finally:
        def cleanup() -> None:
            for p in files:
                p.unlink(missing_ok=True)
            try:
                folder.rmdir()
            except OSError:
                pass

        await hass.async_add_executor_job(cleanup)
    return parse_photo_recipe((result or {}).get("data"))
