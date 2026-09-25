"""Konstanten für die Einkaufsliste."""

from __future__ import annotations

DOMAIN = "einkaufsliste"
VERSION = "1.2.2"

STORAGE_KEY = f"{DOMAIN}.data"
STORAGE_VERSION = 1
SAVE_DELAY = 1

SIGNAL_UPDATED = f"{DOMAIN}_updated"
EVENT_ITEM_ADDED = f"{DOMAIN}_item_added"
EVENT_CLEANUP = f"{DOMAIN}_cleanup"

STATIC_URL = "/einkaufsliste_files"
CARD_FILENAME = "einkaufsliste-card.js"

# Optionen (Aufräumen)
CONF_CLEANUP_WEEKDAY = "cleanup_weekday"  # 0 = Montag ... 6 = Sonntag
CONF_CLEANUP_TIME = "cleanup_time"  # "HH:MM:SS"
CONF_MIN_AGE_DAYS = "min_age_days"

DEFAULT_OPTIONS = {
    CONF_CLEANUP_WEEKDAY: 6,
    CONF_CLEANUP_TIME: "03:00:00",
    CONF_MIN_AGE_DAYS: 7,
}

WEEKDAYS_DE = [
    "Montag",
    "Dienstag",
    "Mittwoch",
    "Donnerstag",
    "Freitag",
    "Samstag",
    "Sonntag",
]

# Startwerte beim ersten Einrichten (alles später in der Karte änderbar)
DEFAULT_STORES = [
    ("Netto", "#f5c400", "mdi:cart"),
    ("Aldi", "#1f8fd6", "mdi:cart"),
    ("Lidl", "#2a4fa0", "mdi:cart"),
    ("Rewe", "#c8102e", "mdi:cart"),
    ("DM", "#7a3fa8", "mdi:lotion"),
]

DEFAULT_CATEGORIES = [
    ("Obst & Gemüse", "mdi:food-apple"),
    ("Backwaren", "mdi:baguette"),
    ("Kühlregal & Milch", "mdi:cheese"),
    ("Fleisch & Wurst", "mdi:food-steak"),
    ("TK-Ware", "mdi:snowflake"),
    ("Vorrat & Konserven", "mdi:package-variant"),
    ("Süßes & Snacks", "mdi:candy"),
    ("Getränke", "mdi:bottle-soda"),
    ("Drogerie", "mdi:lotion"),
    ("Haushalt", "mdi:spray-bottle"),
    ("Sonstiges", "mdi:dots-horizontal"),
]

HISTORY_LIMIT = 400
