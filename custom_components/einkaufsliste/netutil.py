"""Kleine Helfer fürs Herunterladen und Prüfen von Fotos."""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any


def track_task(hass: Any, tasks: set, coro: Any) -> asyncio.Task:
    """Hintergrund-Aufgabe starten und merken, damit sie beim Beenden abgebrochen werden kann."""
    task = hass.async_create_task(coro)
    tasks.add(task)
    task.add_done_callback(tasks.discard)
    return task


def cancel_tasks(tasks: set) -> None:
    """Alle gemerkten Aufgaben abbrechen (außer der, die gerade selbst läuft)."""
    me = asyncio.current_task()
    for task in list(tasks):
        if task is not me and not task.done():
            task.cancel()
    tasks.intersection_update({me} if me in tasks else set())


async def read_limited(stream, limit: int) -> bytes | None:
    """Den ganzen Inhalt bis zum Ende lesen (nicht nur das erste Stück). Zu groß -> None."""
    buf = bytearray()
    async for chunk in stream.iter_chunked(65536):
        buf += chunk
        if len(buf) > limit:
            return None
    return bytes(buf)


def photo_complete(raw: bytes) -> bool:
    """Ist das Bild vollständig? (JPEG: Ende-Marke, PNG: IEND, WebP: Größe aus dem Kopf)"""
    if raw[:3] == b"\xff\xd8\xff":
        return b"\xff\xd9" in raw[-64:]
    if raw[:8] == b"\x89PNG\r\n\x1a\n":
        return b"IEND" in raw[-16:]
    if raw[8:12] == b"WEBP":
        return int.from_bytes(raw[4:8], "little") + 8 <= len(raw)
    return False


def photo_file_complete(path: Path) -> bool:
    """Wie photo_complete, liest aber nur Anfang und Ende der Datei."""
    try:
        size = path.stat().st_size
        with path.open("rb") as fh:
            head = fh.read(16)
            fh.seek(max(0, size - 64))
            tail = fh.read(64)
    except OSError:
        return True  # fehlende Dateien meldet „Alles ok?“ an anderer Stelle
    if head[:3] == b"\xff\xd8\xff":
        return b"\xff\xd9" in tail
    if head[:8] == b"\x89PNG\r\n\x1a\n":
        return b"IEND" in tail[-16:]
    if head[8:12] == b"WEBP":
        return int.from_bytes(head[4:8], "little") + 8 <= size
    return True
