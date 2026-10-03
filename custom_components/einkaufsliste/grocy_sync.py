"""🥫 Grocy dauerhaft abgleichen (zwei getrennte Schalter, je nach Wunsch einzeln oder beide).

A = 🛒 Einkaufsliste: Die Einkaufsliste von Grocy und unsere Liste gleichen sich ab (wie beim Alexa-/To-do-Abgleich):
    move = herüberholen und in Grocy löschen · keep = bei beiden behalten, Abhaken in beide Richtungen ·
    sync = voller Abgleich, was wir eintragen, kommt auch zu Grocy.
B = 📦 Produkte: Neue Grocy-Produkte kommen regelmäßig von allein in den Katalog (nichts wird überschrieben oder gelöscht).

Grocy kennt keine Push-Meldungen, deshalb schauen wir alle 3 Minuten nach. Änderungen bei uns gehen sofort rüber.
"""

from __future__ import annotations

from datetime import timedelta
import logging
import re
from typing import Any

import aiohttp

from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers.event import async_call_later, async_track_time_interval
from homeassistant.util import dt as dt_util

from .const import SIGNAL_UPDATED
from .grocy_import import _get, _request, async_fetch, clean_base, import_rows

_LOGGER = logging.getLogger(__name__)

MODES = ("move", "keep", "sync")
POLL_MINUTES = 3
WHO = "Grocy"


class GrocySync:
    """Gleicht im Hintergrund mit Grocy ab (Einstellungen: manager.grocy)."""

    def __init__(self, hass: HomeAssistant, manager: Any) -> None:
        self.hass = hass
        self.manager = manager
        self._unsub = None
        self._unsub_list = None
        self._debounce = None
        self._busy = False
        self._again = False
        self._products: dict[str, str] = {}  # Grocy-Produkt-ID -> Name (zwischengemerkt)
        self._products_at = 0.0

    # ------------------------------------------------------------------ Start / Stop
    @callback
    def start(self) -> None:
        self.stop()
        cfg = self.manager.grocy
        if not (cfg.get("url") and cfg.get("api_key") and (cfg.get("a_on") or cfg.get("b_on"))):
            return
        self._unsub = async_track_time_interval(self.hass, self._tick, timedelta(minutes=POLL_MINUTES))
        if cfg.get("a_on") and cfg.get("a_mode", "keep") != "move":  # Änderungen bei uns gleich nach Grocy
            self._unsub_list = async_dispatcher_connect(self.hass, SIGNAL_UPDATED, self._on_list_change)
        self.hass.async_create_task(self.run())

    @callback
    def stop(self) -> None:
        for name in ("_unsub", "_unsub_list", "_debounce"):
            unsub = getattr(self, name)
            if unsub:
                unsub()
                setattr(self, name, None)

    @callback
    def _tick(self, _now: Any) -> None:
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

        self._debounce = async_call_later(self.hass, 2.0, _fire)

    # ------------------------------------------------------------------ Ablauf
    async def run(self, force_b: bool = False) -> dict[str, Any]:
        """Einmal abgleichen. Gibt den Zustand zurück: {"ok", "msg", "a", "b"}."""
        if self._busy:
            self._again = True
            return dict(self.manager.grocy.get("status") or {})
        self._busy = True
        a = b = 0
        ok, msg = True, ""
        try:
            while True:
                self._again = False
                cfg = self.manager.grocy
                if not (cfg.get("url") and cfg.get("api_key")):
                    break
                try:
                    base = clean_base(cfg["url"])
                    session = async_get_clientsession(self.hass)
                    if cfg.get("a_on"):
                        a += await self._lists(session, base, cfg)
                    if cfg.get("b_on"):
                        b += await self._new_products(cfg, force_b)
                except ValueError as err:
                    ok, msg = False, str(err)
                except Exception as err:  # noqa: BLE001 – der Abgleich darf nie die Integration stören
                    _LOGGER.warning("Grocy-Abgleich ging schief: %s", err, exc_info=True)
                    ok, msg = False, f"Unerwarteter Fehler ({type(err).__name__}) – Details im Protokoll."
                if not self._again:
                    break
        finally:
            self._busy = False
        self._status(ok, msg, a, b)
        return dict(self.manager.grocy.get("status") or {})

    def _status(self, ok: bool, msg: str, a: int, b: int) -> None:
        cfg = self.manager.grocy
        if not cfg:
            return
        old = cfg.get("status") or {}
        new = {"ok": ok, "msg": msg, "at": dt_util.utcnow().isoformat()}
        cfg["status"] = new
        cfg["checked_at"] = new["at"]
        if a:
            cfg["count_a"] = int(cfg.get("count_a", 0)) + a
        if b:
            cfg["count_b"] = int(cfg.get("count_b", 0)) + b
        if a or b or old.get("ok") != ok or old.get("msg") != msg:
            self.manager._changed()

    # ------------------------------------------------------------------ 📦 B: neue Produkte
    async def _new_products(self, cfg: dict[str, Any], force: bool) -> int:
        last = dt_util.parse_datetime(cfg.get("last_b") or "")
        hours = int(cfg.get("b_hours") or 6)
        if not force and last is not None and dt_util.utcnow() - last < timedelta(hours=hours):
            return 0
        res = await async_fetch(self.hass, cfg["url"], cfg["api_key"])
        m = self.manager
        new = [r for r in res["rows"] if r["name"].lower() not in m.history]
        added = 0
        if new:
            with m.acting(WHO, None, "sync"):
                added = import_rows(m, new, bool(cfg.get("b_cats", True)))["added"]
        cfg["last_b"] = dt_util.utcnow().isoformat()
        return added

    # ------------------------------------------------------------------ 🛒 A: Einkaufsliste
    async def _names(self, session: aiohttp.ClientSession, base: str, key: str, need: set[str]) -> dict[str, str]:
        """Produkt-ID -> Name. Wird zwischengemerkt; unbekannte IDs holen die Liste neu."""
        now = dt_util.utcnow().timestamp()
        if (need - set(self._products)) or now - self._products_at > 1800:
            data = await _get(session, base, key, "objects/products")
            self._products = {str(p.get("id")): " ".join(str(p.get("name") or "").split())
                              for p in (data or []) if isinstance(p, dict)}
            self._products_at = now
        return self._products

    @staticmethod
    def _amount(value: Any) -> float:
        try:
            return float(str(value).replace(",", "."))
        except (TypeError, ValueError):
            return 1.0

    async def _lists(self, session: aiohttp.ClientSession, base: str, cfg: dict[str, Any]) -> int:
        key = cfg["api_key"]
        list_id = str(cfg.get("list_id") or 1)
        mode = cfg.get("a_mode") if cfg.get("a_mode") in MODES else "keep"
        raw = await _get(session, base, key, "objects/shopping_list")
        rows = [r for r in (raw or []) if isinstance(r, dict) and str(r.get("shopping_list_id") or "1") == list_id]
        names = await self._names(session, base, key, {str(r["product_id"]) for r in rows if r.get("product_id")})
        by_id = {str(r["id"]): r for r in rows if r.get("id") is not None}
        m = self.manager
        links: dict[str, dict[str, Any]] = cfg.setdefault("links", {})  # Grocy-Zeile -> {"item", "done"}
        items = {i["id"]: i for i in m.items}
        store_id = cfg.get("a_store_id") if m.store_by_id(cfg.get("a_store_id")) else None
        added = changed = 0

        def text_of(row: dict[str, Any]) -> str:
            name = names.get(str(row.get("product_id"))) if row.get("product_id") else ""
            return " ".join(str(name or row.get("note") or "").split())[:80].rstrip()

        async def delete(row_id: str) -> bool:
            try:
                await _request(session, "DELETE", base, key, f"objects/shopping_list/{row_id}")
                return True
            except ValueError as err:
                _LOGGER.debug("Grocy-Zeile %s nicht gelöscht: %s", row_id, err)
                return False

        with m.acting(WHO, None, "sync"):
            # 1. Schon verknüpfte Paare abgleichen
            handled = set(links)
            for rid in list(links):
                link = links[rid]
                item, row = items.get(link["item"]), by_id.get(rid)
                if link.get("moved"):  # „Holen & löschen“: nur noch das Löschen nachholen
                    if row is None or await delete(rid):
                        del links[rid]
                        changed += 1
                    continue
                if item is None and row is None:
                    del links[rid]
                    changed += 1
                    continue
                if item is None:  # bei uns gelöscht -> in Grocy auch weg
                    if await delete(rid):
                        del links[rid]
                        changed += 1
                    continue
                if row is None:  # in Grocy gelöscht/abgehakt -> bei uns abhaken
                    if not item["checked"]:
                        m.set_checked(item["id"], True, by=WHO)
                    del links[rid]
                    changed += 1
                    continue
                if str(row.get("done") or "0") in ("1", "true", "True") and not item["checked"]:
                    m.set_checked(item["id"], True, by=WHO)  # in Grocy als erledigt markiert
                    changed += 1
                if item["checked"]:  # bei uns abgehakt -> Zeile in Grocy löschen
                    if await delete(rid):
                        del links[rid]
                        changed += 1
            for rid in [r for r in by_id if r not in links and r in handled]:
                del by_id[rid]  # in diesem Lauf schon erledigt/gelöscht -> nicht als „neu“ wieder holen
            linked_items = {v["item"] for v in links.values()}
            # 2. Neues aus Grocy
            for rid, row in by_id.items():
                if rid in links or str(row.get("done") or "0") in ("1", "true", "True"):
                    continue
                text = text_of(row)
                if not text:
                    continue
                twin = None
                if mode != "move":
                    twin = next((i for i in m.items if not i["checked"] and i["id"] not in linked_items
                                 and i["name"].lower() == text.lower()), None)
                if twin is None:
                    amount = self._amount(row.get("amount"))
                    qty = f"{int(amount)}x" if amount > 1 and amount == int(amount) else None
                    try:
                        twin = m.add_item(text, store_id=store_id, quantity=qty, added_by=WHO, notify=True)
                        added += 1
                    except ValueError as err:
                        _LOGGER.debug("„%s“ nicht übernommen: %s", text, err)
                        continue
                if mode == "move":
                    links[rid] = {"item": twin["id"], "done": False, "moved": True}
                    if await delete(rid):
                        del links[rid]
                else:
                    links[rid] = {"item": twin["id"], "done": False}
                    linked_items.add(twin["id"])
                changed += 1
            # 3. Voller Abgleich: Offenes von uns nach Grocy
            if mode == "sync":
                by_name = {n.lower(): pid for pid, n in names.items() if n}
                for item in list(m.items):
                    if item["checked"] or item["id"] in linked_items or item.get("recipe_id"):
                        continue
                    pid = by_name.get(item["name"].lower())
                    q = re.match(r"\s*(\d+(?:[.,]\d+)?)", str(item.get("quantity") or ""))
                    body: dict[str, Any] = {"shopping_list_id": int(list_id), "amount": self._amount(q.group(1)) if q else 1}
                    if pid:
                        body["product_id"] = int(pid)
                    else:
                        body["note"] = item["name"]
                    try:
                        res = await _request(session, "POST", base, key, "objects/shopping_list", body=body)
                    except ValueError as err:
                        _LOGGER.debug("„%s“ nicht zu Grocy gebracht: %s", item["name"], err)
                        continue
                    new_id = (res or {}).get("created_object_id")
                    if new_id is not None:
                        links[str(new_id)] = {"item": item["id"], "done": False}
                        linked_items.add(item["id"])
                        changed += 1
        if len(links) > 1000:
            for rid in list(links)[: len(links) - 1000]:
                del links[rid]
        if changed or added:
            m._changed()
        return added
