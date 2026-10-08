"""📧 Produkte per E-Mail auf die Liste.

Home Assistant bringt die Integration „IMAP“ mit: Sie schaut in ein Postfach und meldet jede neue Mail
als Ereignis („imap_content“). Hier hören wir darauf: Kommt eine Mail von einem erlaubten Absender in
das gewählte Postfach, wird jede Zeile ein Artikel – genau wie beim „Text einfügen“.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import html
import logging
import quopri
import re
from datetime import datetime, timedelta
from email.utils import parseaddr
from typing import Any

from homeassistant.core import Event, HomeAssistant, callback

from .netutil import cancel_tasks, track_task

_LOGGER = logging.getLogger(__name__)

EVENT_IMAP = "imap_content"
_TAG = re.compile(r"<[^>]+>")
_BR = re.compile(r"<\s*(br|/p|/div|/li|/tr)\b[^>]*>", re.I)
# ab hier kommt nur noch Zitat / Signatur / Werbung
_STOP = re.compile(
    r"^(--\s*$|_{5,}|-{5,}|am .+ schrieb|on .+ wrote:|von:\s|from:\s|gesendet von|sent from|diese e-mail wurde)",
    re.I,
)


# jede Art Zeilenumbruch (manche Mail-Apps schicken \r, \u2028 & Co.)
_LINES = re.compile(r"\r\n|[\r\n\v\f\x85\u2028\u2029]")
# 👋 A) Grußformel mitten im (zusammengeklebten) Text: ab hier ist Schluss
_GREET_INLINE = re.compile(
    r"(mit\s+)?(freundliche[mn]?|herzliche[mn]?|liebe[n]?|viele[n]?|beste[n]?|schöne[n]?|sonnige[n]?)\s+gr(ü|ue)(ß|ss)(e|en)?\b"
    r"|\b(best|kind|warm)\s+regards\b|\bmfg\b",
    re.I,
)
# 👋 A) kurzer Gruß als ganze Zeile („LG“, „Danke!“, „Tschüss Marco“)
_GREET_LINE = re.compile(
    r"^(lg|vg|glg|gruß|gruss|grüße|gruesse|danke(schön)?|vielen dank|tschüss|tschüs|ciao|bye|cheers|bis (dann|später|bald)"
    r"|thanks|thank you|regards)\b[\s,!.:]*([\w\u00c0-\u017f-]+[\s,!.]*){0,2}$",
    re.I,
)
# 👋 Anrede oben („Hallo Schatz,“) – wird übersprungen
_HELLO = re.compile(r"^(hallo|hi|hey|moin|servus|guten (morgen|tag|abend)|liebe[rs]?|hello|dear)\b.{0,40}$", re.I)


def _is_sentence(line: str) -> bool:
    """✂️ B) Sieht aus wie ein Satz statt wie ein Artikel? („Einen schönen Tag noch!“)"""
    words = line.split()
    return len(words) >= 9 or (len(words) >= 4 and line.rstrip()[-1:] in ".!?")


def decode_part(data: Any, encoding: str | None) -> str:
    """Teil einer Mail (aus imap.fetch_part) in lesbaren Text verwandeln."""
    if data is None:
        return ""
    raw: bytes
    enc = (encoding or "").lower()
    text = data if isinstance(data, str) else None
    try:
        if enc == "base64":
            raw = base64.b64decode(data if isinstance(data, (bytes, str)) else b"", validate=False)
        elif enc == "quoted-printable":
            raw = quopri.decodestring(data.encode("latin-1", "replace") if isinstance(data, str) else data)
        elif isinstance(data, bytes):
            raw = data
        else:
            return text or ""
    except (binascii.Error, ValueError):
        return text or ""
    for cs in ("utf-8", "cp1252"):
        try:
            return raw.decode(cs)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", "replace")


def mail_sources(hass: HomeAssistant) -> list[dict[str, Any]]:
    """Alle eingerichteten IMAP-Postfächer."""
    return [
        {"entry_id": e.entry_id, "name": e.title or e.data.get("username") or "IMAP"}
        for e in hass.config_entries.async_entries("imap")
    ]


MAX_MAIL_CHARS = 200_000


def mail_text(text: str | None, subject: str | None = None) -> str:
    """Nur die Einkaufszeilen: ohne HTML, Zitate, Signatur und „Gesendet von meinem iPhone“."""
    raw = (text or "")[:MAX_MAIL_CHARS]  # riesige Mails nicht durch Regex jagen
    if "<" in raw and ">" in raw and re.search(r"<(html|body|div|p|br|span|table)\b", raw, re.I):
        raw = _BR.sub("\n", raw)
        raw = re.sub(r"<(style|script)[^>]*>.*?</\1>", "", raw, flags=re.I | re.S)
        raw = html.unescape(_TAG.sub("", raw))
    lines: list[str] = []
    for line in _LINES.split(raw):
        stripped = line.strip().replace("\u00a0", " ")
        if _STOP.match(stripped):
            break
        cut = _GREET_INLINE.search(stripped)
        if cut:  # „Milch Mit freundlichen Grüßen …“ -> nur „Milch“
            stripped = stripped[: cut.start()].strip()
        if stripped and not stripped.startswith(">") and not (cut is None and _GREET_LINE.match(stripped)):
            if not (not lines and _HELLO.match(stripped) and (stripped.endswith(",") or len(stripped.split()) <= 3)):
                if not _is_sentence(stripped) and stripped.rstrip(" .!"):
                    lines.append(stripped.rstrip(" .!"))
        if cut or (stripped and _GREET_LINE.match(stripped)):
            break
    if not lines and subject:  # nur der Betreff? Dann eben der
        lines = [s.strip() for s in re.split(r"[,;]", subject) if s.strip() and not _HELLO.match(s.strip())]
    return "\n".join(lines[:60])


def _find_store(manager: Any, text: str, whole: bool) -> str | None:
    """Geschäft im Text finden: whole=True → die Zeile ist genau der Name („Aldi“ oder „Aldi:“)."""
    t = (text or "").strip().lower()
    if whole:
        t = t.rstrip(":").strip()
        return next((st["id"] for st in manager.stores if st["name"].strip().lower() == t), None)
    for st in manager.stores:  # im Betreff reicht das Wort („Einkauf bei Aldi“)
        if re.search(r"(?<!\w)" + re.escape(st["name"].strip().lower()) + r"(?!\w)", t):
            return st["id"]
    return None


def mail_groups(manager: Any, text: str, subject: str | None, default_store: str | None) -> list[tuple[str | None, str]]:
    """🏪 Zeilen nach Geschäft sortieren: Betreff = Geschäft für alles, Überschrift „Aldi:“ gilt bis zur nächsten."""
    store = _find_store(manager, subject or "", whole=False) or default_store
    groups: list[tuple[str | None, list[str]]] = [(store, [])]
    for line in text.split("\n"):
        head = _find_store(manager, line, whole=True)
        if head:
            groups.append((head, []))
            continue
        m = re.match(r"^([^:]{1,40}):\s*(.+)$", line)  # „Netto: Milch, Brot“ in einer Zeile
        head = _find_store(manager, m.group(1), whole=True) if m else None
        if head:
            groups.append((head, []))
            line = m.group(2)
        # „Milch, Butter; Brot“ = drei Artikel (aber „1,5 %“ bleibt zusammen)
        groups[-1][1].extend(p.strip() for p in re.split(r",\s+|;", line) if p.strip())
    return [(sid, "\n".join(lines)) for sid, lines in groups if lines]


class MailImport:
    """Hört auf neue Mails aus der IMAP-Integration."""

    def __init__(self, hass: HomeAssistant, manager: Any) -> None:
        self.hass = hass
        self.manager = manager
        self._unsub = None
        self._seen: list[str] = []
        self._tasks: set[asyncio.Task] = set()
        self._stopped = False

    @callback
    def start(self) -> None:
        self.stop()
        self._stopped = False
        if self.manager.mail_import:
            self._unsub = self.hass.bus.async_listen(EVENT_IMAP, self._on_mail)

    @callback
    def stop(self) -> None:
        self._stopped = True
        cancel_tasks(self._tasks)
        if self._unsub:
            self._unsub()
            self._unsub = None

    @callback
    def _on_mail(self, event: Event) -> None:
        # ⚠️ Der Absender („From“) wird NICHT geprüft/beglaubigt: Wer die Adresse eines erlaubten Absenders fälscht,
        # kann Artikel auf die Liste setzen. Darum nur Postfächer verwenden, die Fälschungen (SPF/DKIM) selbst aussortieren.
        cfg = self.manager.mail_import
        data = event.data
        if not cfg or data.get("entry_id") != cfg.get("entry_id"):
            return
        # 📬 „initial: false“ heißt nur „HA schickt dieselbe letzte Mail nochmal“ (gleiche Message-ID) – das kann auch
        # eine ganz neue Mail sein. Darum nicht pauschal wegwerfen, sondern über eigene Nummer|Datum-Liste auf Doppelte prüfen.
        key = f"{data.get('uid')}|{data.get('date')}"
        if key in self._seen or key in self.manager.mail_seen:
            return
        if data.get("initial") is False:
            sent = data.get("date")
            if isinstance(sent, datetime) and sent.tzinfo is not None and datetime.now(sent.tzinfo) - sent > timedelta(days=2):
                return  # alte Mail, die HA nur wieder aufwärmt
        self._seen = (self._seen + [key])[-50:]
        self.manager.mail_seen = (self.manager.mail_seen + [key])[-50:]
        self.manager._changed()
        name, address = parseaddr(str(data.get("sender") or ""))
        address = address.lower()
        allowed = [s.lower() for s in cfg.get("senders", [])]
        if address not in allowed:
            _LOGGER.info("📧 Mail von %s ignoriert – steht nicht bei den erlaubten Absendern", address or "?")
            return
        track_task(self.hass, self._tasks, self._import(data, cfg, name, address))

    async def _body(self, data: dict[str, Any], entry_id: str) -> str | None:
        """📬 Mailtext selbst holen, wenn er fehlt oder ohne Zeilenumbrüche ankommt (z. B. Samsung-Mail-App)."""
        text = data.get("text") or ""
        if text.strip() and _LINES.search(text.strip()):
            return text
        uid = data.get("uid")
        if not uid:
            return text
        found: dict[str, str] = {}
        for idx, info in (data.get("parts") or {}).items():
            ctype = str((info or {}).get("content_type") or "").lower()
            if ctype not in ("text/plain", "text/html") or ctype in found:
                continue
            try:
                resp = await self.hass.services.async_call(
                    "imap", "fetch_part", {"entry": entry_id, "uid": str(uid), "part": str(idx)},
                    blocking=True, return_response=True,
                )
            except Exception as err:  # noqa: BLE001 – ältere HA-Version / Postfach weg: mit dem Ereignis-Text weiter
                _LOGGER.debug("📧 Teil %s der Mail %s nicht abholbar: %s", idx, uid, err)
                break
            found[ctype] = decode_part((resp or {}).get("part_data"), (resp or {}).get("content_transfer_encoding"))
        plain, page = found.get("text/plain", ""), found.get("text/html", "")
        if plain.strip() and _LINES.search(plain.strip()):
            return plain
        if page.strip():
            return page
        if plain.strip():
            return plain
        if not text.strip():  # gar kein Text im Ereignis (Häkchen „text“ in den IMAP-Optionen fehlt)
            try:
                resp = await self.hass.services.async_call(
                    "imap", "fetch", {"entry": entry_id, "uid": str(uid)}, blocking=True, return_response=True
                )
                return (resp or {}).get("text") or ""
            except Exception as err:  # noqa: BLE001
                _LOGGER.debug("📧 Mail %s nicht abholbar: %s", uid, err)
        return text

    async def _import(self, data: dict[str, Any], cfg: dict[str, Any], name: str, address: str) -> None:
        subject = data.get("subject")
        body = await self._body(data, cfg["entry_id"])
        if self._stopped or self.manager.mail_import is not cfg:
            return
        # Nur der Betreff ist ein Geschäft? Dann ist er keine Einkaufszeile
        text = mail_text(body, None if _find_store(self.manager, subject or "", whole=False) else subject)
        if not text:
            _LOGGER.info("📧 Mail von %s: keine Einkaufszeilen gefunden", address)
            return
        from .transfer import import_text  # noqa: PLC0415 – erst hier, sonst Kreis-Import

        default = cfg.get("store_id") if self.manager.store_by_id(cfg.get("store_id")) else None
        added = 0
        with self.manager.acting(f"📧 {name or address}", None, "mail"):
            for store_id, part in mail_groups(self.manager, text, subject, default):
                added += import_text(self.manager, part, store_id).get("added", 0)
        if added:
            cfg["count"] = int(cfg.get("count", 0)) + added
            if not self._stopped:
                self.manager._changed()
            after = cfg.get("after", "keep")
            if after in ("seen", "delete") and data.get("uid"):  # 📬 Mail danach als gelesen markieren oder löschen
                await self._after(after, cfg["entry_id"], str(data["uid"]))

    async def _after(self, what: str, entry_id: str, uid: str) -> None:
        try:
            await self.hass.services.async_call("imap", what, {"entry": entry_id, "uid": uid}, blocking=True)
        except Exception as err:  # noqa: BLE001 – Postfach gerade nicht erreichbar o. Ä.
            _LOGGER.warning("📧 Mail %s konnte nicht %s werden: %s", uid, "gelöscht" if what == "delete" else "als gelesen markiert", err)
