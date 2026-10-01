"""🔁 To-do-Liste automatisch herüberholen.

Man wählt in ⚙️ → Import eine To-do-Liste aus Home Assistant (z. B. die Alexa-Einkaufsliste aus der
Integration „Alexa Devices“). Alles, was dort landet („Alexa, setz Milch auf die Einkaufsliste“), wandert
sofort in die Einkaufsliste und wird in der To-do-Liste wieder gelöscht. Ganz ohne Automation.
"""

from __future__ import annotations

import logging
from typing import Any

from homeassistant.core import Event, HomeAssistant, callback
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers.event import async_call_later, async_track_state_change_event

from .const import SIGNAL_UPDATED

# Wie abgeglichen wird:
#   move = herüberholen und dort löschen (Alexa ist nur der Briefkasten)
#   keep = bei beiden behalten, Abhaken wird in beide Richtungen abgeglichen
#   sync = voller Abgleich: zusätzlich kommt alles aus der Einkaufsliste auch dorthin
MODES = ("move", "keep", "sync")

_LOGGER = logging.getLogger(__name__)

# So heißt der Eintrager im Verlauf und unter dem Artikel (nach der Integration der To-do-Liste)
_SOURCE_NAMES = {
    "alexa_devices": "Alexa",
    "google_tasks": "Google Tasks",
    "bring": "Bring!",
    "todoist": "Todoist",
    "shopping_list": "HA-Einkaufsliste",
    "local_todo": "To-do-Liste",
    "ourgroceries": "OurGroceries",
    "anylist": "AnyList",
}


def source_name(hass: HomeAssistant, entity_id: str) -> str:
    """„Alexa“ statt „todo.alexa_einkaufsliste“ – so sieht jeder, woher der Artikel kam."""
    entry = er.async_get(hass).async_get(entity_id)
    if entry and entry.platform in _SOURCE_NAMES:
        return _SOURCE_NAMES[entry.platform]
    state = hass.states.get(entity_id)
    return (state.name if state else None) or entity_id.split(".", 1)[-1]


class TodoSync:
    """Beobachtet eine To-do-Liste und holt neue Einträge in die Einkaufsliste."""

    def __init__(self, hass: HomeAssistant, manager: Any) -> None:
        self.hass = hass
        self.manager = manager
        self._unsub = None
        self._busy = False
        self._again = False
        self._retry = None
        self._unsub_list = None
        self._debounce = None

    @callback
    def start(self) -> None:
        self.stop()
        cfgs = self.manager.todo_syncs
        if not cfgs:
            return
        self._unsub = async_track_state_change_event(self.hass, [c["entity_id"] for c in cfgs], self._on_change)
        if any(c.get("mode", "move") != "move" for c in cfgs):  # 🔗 Änderungen in der Einkaufsliste auch dorthin
            self._unsub_list = async_dispatcher_connect(self.hass, SIGNAL_UPDATED, self._on_list_change)
        self.hass.async_create_task(self.run())  # gleich einmal nachschauen

    @callback
    def stop(self) -> None:
        if self._unsub:
            self._unsub()
            self._unsub = None
        if self._unsub_list:
            self._unsub_list()
            self._unsub_list = None
        if self._debounce:
            self._debounce()
            self._debounce = None
        if self._retry:
            self._retry()
            self._retry = None

    @callback
    def _on_change(self, event: Event) -> None:
        new = event.data.get("new_state")
        if new is None or str(new.state) in ("unavailable", "unknown"):
            return
        cfg = next((c for c in self.manager.todo_syncs if c["entity_id"] == event.data.get("entity_id")), None)
        if cfg is None or (str(new.state) == "0" and cfg.get("mode", "move") == "move"):
            return
        self.hass.async_create_task(self.run())

    @callback
    def _on_list_change(self) -> None:
        if self._busy:  # unsere eigenen Änderungen beim Abgleichen
            return
        if self._debounce:
            self._debounce()

        @callback
        def _fire(_now: Any) -> None:
            self._debounce = None
            self.hass.async_create_task(self.run())

        self._debounce = async_call_later(self.hass, 1.5, _fire)

    async def run(self) -> int:
        """Offene Einträge holen, eintragen, dort löschen. Gibt die Anzahl zurück."""
        if self._busy:
            self._again = True
            return 0
        self._busy = True
        total = 0
        try:
            while True:
                self._again = False
                for cfg in list(self.manager.todo_syncs):
                    total += await self._once(cfg)
                if not self._again:
                    break
        finally:
            self._busy = False
        return total

    async def _once(self, cfg: dict[str, Any]) -> int:
        if cfg.get("mode", "move") != "move":
            return await self._reconcile(cfg)
        entity_id = cfg["entity_id"]
        state = self.hass.states.get(entity_id)
        if state is None or state.state in ("unavailable", "unknown"):
            return 0
        try:
            resp = await self.hass.services.async_call(
                "todo", "get_items", {"entity_id": entity_id, "status": ["needs_action"]},
                blocking=True, return_response=True,
            )
        except Exception as err:  # noqa: BLE001 – Liste gerade nicht erreichbar: später nochmal
            _LOGGER.debug("To-do-Liste %s nicht lesbar: %s", entity_id, err)
            self._later()
            return 0
        entries = (resp or {}).get(entity_id, {}).get("items", [])
        if not entries:
            return 0
        who = source_name(self.hass, entity_id)
        done: list[str] = []
        added = 0
        with self.manager.acting(who, None, "sync"):
            for entry in entries:
                text = str(entry.get("summary") or "").strip()
                if text and len(text) <= 80:
                    try:
                        store_id = cfg.get("store_id") if self.manager.store_by_id(cfg.get("store_id")) else None
                        self.manager.add_item(text, store_id=store_id, added_by=who, notify=True)
                        added += 1
                    except ValueError as err:
                        _LOGGER.debug("„%s“ nicht übernommen: %s", text, err)
                done.append(entry.get("uid") or text)
        if added:
            cfg["count"] = int(cfg.get("count", 0)) + added
            self.manager._changed()
        if done:
            try:  # erst eintragen, dann dort löschen – so geht nichts verloren
                await self.hass.services.async_call(
                    "todo", "remove_item", {"entity_id": entity_id, "item": done}, blocking=True
                )
            except Exception as err:  # noqa: BLE001
                _LOGGER.warning("Einträge in %s konnten nicht gelöscht werden: %s", entity_id, err)
        return added

    @callback
    def _later(self) -> None:
        if self._retry:
            return

        @callback
        def _fire(_now: Any) -> None:
            self._retry = None
            self.hass.async_create_task(self.run())

        self._retry = async_call_later(self.hass, 300, _fire)

    # ------------------------------------------------------------------ 🔗 Abgleich (keep / sync)
    async def _items(self, entity_id: str) -> list[dict[str, Any]] | None:
        try:
            resp = await self.hass.services.async_call(
                "todo", "get_items", {"entity_id": entity_id, "status": ["needs_action", "completed"]},
                blocking=True, return_response=True,
            )
        except Exception as err:  # noqa: BLE001
            _LOGGER.debug("To-do-Liste %s nicht lesbar: %s", entity_id, err)
            self._later()
            return None
        return list((resp or {}).get(entity_id, {}).get("items", []))

    async def _call(self, service: str, data: dict[str, Any]) -> bool:
        try:
            await self.hass.services.async_call("todo", service, data, blocking=True)
            return True
        except Exception as err:  # noqa: BLE001
            _LOGGER.debug("todo.%s ging nicht: %s", service, err)
            return False

    @staticmethod
    def label(item: dict[str, Any]) -> str:
        """So heißt ein Artikel auf der anderen Liste: „Milch (2 L)“."""
        qty = item.get("quantity")
        return f"{item['name']} ({qty})" if qty and qty != "1x" else item["name"]

    async def _reconcile(self, cfg: dict[str, Any]) -> int:
        entity_id = cfg["entity_id"]
        state = self.hass.states.get(entity_id)
        if state is None or state.state in ("unavailable", "unknown"):
            return 0
        todo = await self._items(entity_id)
        if todo is None:
            return 0
        m = self.manager
        links: dict[str, dict[str, Any]] = cfg.setdefault("links", {})  # Eintrag drüben (uid) -> {"item", "done"}
        items = {i["id"]: i for i in m.items}
        by_uid = {t.get("uid"): t for t in todo if t.get("uid")}
        who = source_name(self.hass, entity_id)
        changed = added = 0
        with m.acting(who, None, "sync"):
            # 1. Verknüpfte Paare abgleichen
            for uid in list(links):
                link = links[uid]
                item, t = items.get(link["item"]), by_uid.get(uid)
                if item is None and t is None:
                    del links[uid]
                    changed += 1
                    continue
                if item is None:  # bei uns gelöscht (z. B. abgehakte Rezept-Zutat) -> dort auch weg
                    await self._call("remove_item", {"entity_id": entity_id, "item": [uid]})
                    del links[uid]
                    changed += 1
                    continue
                if t is None:  # dort gelöscht („Alexa, streich Milch …“) -> bei uns abhaken
                    if not item["checked"]:
                        m.set_checked(item["id"], True, by=who)
                    del links[uid]
                    changed += 1
                    continue
                t_done, i_done = t.get("status") == "completed", bool(item["checked"])
                if t_done != link["done"]:  # dort geändert
                    if i_done != t_done:
                        m.set_checked(item["id"], t_done, by=who)
                    link["done"] = t_done
                    changed += 1
                elif i_done != link["done"]:  # bei uns geändert
                    await self._call("update_item", {"entity_id": entity_id, "item": uid,
                                                     "status": "completed" if i_done else "needs_action"})
                    link["done"] = i_done
                    changed += 1
            linked_items = {v["item"] for v in links.values()}
            # 2. Neues von drüben
            store_id = cfg.get("store_id") if m.store_by_id(cfg.get("store_id")) else None
            for t in todo:
                uid = t.get("uid")
                if not uid or uid in links or t.get("status") == "completed":
                    continue
                text = str(t.get("summary") or "").strip()
                if not text or len(text) > 80:
                    continue
                twin = next((i for i in m.items if not i["checked"] and i["id"] not in linked_items
                             and self.label(i).lower() == text.lower()), None)
                if twin is None:
                    try:
                        twin = m.add_item(text, store_id=store_id, added_by=who, notify=True)
                        added += 1
                    except ValueError as err:
                        _LOGGER.debug("„%s“ nicht übernommen: %s", text, err)
                        continue
                links[uid] = {"item": twin["id"], "done": False}
                linked_items.add(twin["id"])
                changed += 1
            # 3. Voller Abgleich: Offenes von uns auch dorthin
            if cfg.get("mode") == "sync":
                pushed: dict[str, str] = {}
                for item in m.items:
                    if item["checked"] or item["id"] in linked_items:
                        continue
                    lab = self.label(item)
                    if await self._call("add_item", {"entity_id": entity_id, "item": lab}):
                        pushed[lab.lower()] = item["id"]
                if pushed:
                    for t in await self._items(entity_id) or []:
                        key = str(t.get("summary") or "").strip().lower()
                        if t.get("uid") and t["uid"] not in links and key in pushed:
                            links[t["uid"]] = {"item": pushed.pop(key), "done": t.get("status") == "completed"}
                    changed += 1
        if len(links) > 1000:  # nicht endlos wachsen
            for uid in list(links)[: len(links) - 1000]:
                del links[uid]
        if added:
            cfg["count"] = int(cfg.get("count", 0)) + added
        if changed or added:
            m._changed()
        return added
