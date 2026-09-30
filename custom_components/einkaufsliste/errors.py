"""🐞 Fehler-Protokoll: sammelt Warnungen und Fehler der Integration, damit man sie in ⚙️ lesen und kopieren kann."""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .manager import EinkaufslisteManager

LOGGER_NAME = __package__ or "custom_components.einkaufsliste"


class ErrorLogHandler(logging.Handler):
    """Hängt sich an das Protokoll der Integration und reicht WARNING und schlimmer an den Manager weiter."""

    def __init__(self, manager: EinkaufslisteManager) -> None:
        super().__init__(level=logging.WARNING)
        self.manager = manager

    def emit(self, record: logging.LogRecord) -> None:
        try:
            text = record.getMessage()
            if record.exc_info and record.exc_info[1] is not None:
                err = record.exc_info[1]
                text += f" ({type(err).__name__}: {err})"
            where = record.name.rsplit(".", 1)[-1] if record.name else "?"
            self.manager.log_error(where, text)
        except Exception:  # noqa: BLE001 – das Protokoll darf nie selbst etwas kaputt machen
            pass


def attach(manager: EinkaufslisteManager) -> logging.Handler:
    handler = ErrorLogHandler(manager)
    logging.getLogger(LOGGER_NAME).addHandler(handler)
    return handler


def detach(handler: logging.Handler) -> None:
    logging.getLogger(LOGGER_NAME).removeHandler(handler)
