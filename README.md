# 🛒 Einkaufsliste für Home Assistant

**Die Familien-Einkaufsliste direkt im Dashboard.** Mehrere Geschäfte, Kategorien, Live-Sync auf allen Handys, und hinter jedem Artikel steht, wer ihn eingetragen hat. Einmal pro Woche räumt sie sich automatisch auf, aber erst, wenn ein Eintrag mindestens eine Woche drinsteht.

![Vorschau](docs/screenshot.png)

---

## ✨ Was kann das Ding?

| Funktion | So klappt's |
|---|---|
| 🏪 **Mehrere Geschäfte** | Netto, Aldi, Lidl, Rewe, DM sind vorbereitet. Weitere legst du einfach in der Karte an. Oben gibt es für jedes Geschäft einen Reiter. |
| 🗂️ **Kategorien** | Obst & Gemüse, Backwaren, TK-Ware, Getränke … Die Liste wird automatisch danach sortiert. |
| 👨‍👩‍👧‍👦 **Für die ganze Familie** | Jeder, der sich in Home Assistant anmelden kann, kann mitmachen. |
| ✅ **Abhaken** | Antippen = abgehakt. Nochmal antippen = der Haken ist raus und der Artikel steht wieder auf der Liste. |
| 🔁 **Wieder drauf** | Trägst du etwas ein, das schon abgehakt auf der Liste steht, wird einfach der Haken rausgenommen. Es gibt keine doppelten Einträge. |
| 🏷️ **„(X)“ hinter dem Artikel** | *Milch (Sandra)*: So siehst du, wer's eingetragen hat. |
| 🧹 **Automatisch aufräumen** | An einem festen Tag, aber erst, wenn ein Eintrag **mindestens 7 Tage** drinsteht (Tage einstellbar). |
| ⚡ **Live-Sync** | Sandra trägt etwas ein, und bei dir steht's sofort auf dem Handy. Ohne Neuladen. |
| 🧠 **Merkt sich Produkte** | Beim Tippen kommen Vorschläge. Das Geschäft und die Kategorie werden automatisch ausgefüllt. |

---

## 🧹 Das Aufräumen, einfach erklärt

Stell dir vor, der Aufräum-Tag ist **Sonntag** und das Mindestalter **7 Tage**.

| Eingetragen am | 1. Sonntag danach | 2. Sonntag danach |
|---|---|---|
| **Dienstag** | erst 5 Tage alt, **bleibt stehen** | 12 Tage alt, **wird gelöscht** |
| **Samstag** | erst 1 Tag alt, **bleibt stehen** | 8 Tage alt, **wird gelöscht** |
| **Sonntag** (nach dem Aufräumen) | genau 7 Tage alt, **wird gelöscht** | – |

Die Regel ist also: Jeder Artikel darf **mindestens eine Woche** auf der Liste bleiben. Unter jedem Artikel zeigt die Karte mit 🧹 an, **an welchem Tag** er rausfliegt.

> 💡 Wird ein Artikel wieder auf die Liste gesetzt (Haken raus), zählt die Woche ab dem Moment neu.
> 💡 Hat Home Assistant zur Aufräumzeit geschlafen (Neustart, Update), wird das Aufräumen beim nächsten Start nachgeholt.

Aufräum-Tag, Uhrzeit, Mindestalter und „nur abgehakte löschen“ stellst du hier ein:
**Einstellungen → Geräte & Dienste → Einkaufsliste → Konfigurieren**

---

## 📦 Installation (Schritt für Schritt)

### Schritt 1: In HACS hinzufügen
1. **HACS** öffnen
2. Oben rechts auf die **drei Punkte ⋮** tippen, dann **Benutzerdefinierte Repositories**
3. Als Repository `https://github.com/misterm2310/einkaufslisten-card` eintragen, als Typ **Integration** wählen, dann **Hinzufügen**
4. Nach **Einkaufsliste** suchen, **Herunterladen** und danach **Home Assistant neu starten**

<details>
<summary>Ohne HACS (von Hand)</summary>

Den Ordner `custom_components/einkaufsliste` nach `/config/custom_components/einkaufsliste` kopieren (zum Beispiel mit dem File-Editor oder Samba) und Home Assistant neu starten.
</details>

### Schritt 2: Integration einrichten
1. **Einstellungen → Geräte & Dienste → Integration hinzufügen**
2. Nach **Einkaufsliste** suchen
3. Aufräum-Tag, Uhrzeit und Mindestalter wählen und **Absenden** tippen. Fertig! 🎉

### Schritt 3: Karte aufs Dashboard
1. Dashboard öffnen, dann **Bearbeiten** und **Karte hinzufügen**
2. Nach **Einkaufsliste** suchen und auswählen, fertig.

Oder per YAML:

```yaml
type: custom:einkaufsliste-card
title: Einkaufsliste
```

> 🙌 Du musst **keine** Ressource von Hand eintragen. Die Integration bringt die Karte automatisch mit.
> Sollte die Karte nach einem Update komisch aussehen: in der App einmal **nach unten ziehen** oder den Browser-Cache leeren (Strg+F5).

---

## 👨‍👩‍👧‍👦 Die Familie dazuholen

- Jedes Familienmitglied braucht einen **eigenen Home-Assistant-Benutzer** (Einstellungen → Personen → Benutzer). Admin-Rechte sind **nicht** nötig.
- Der Name in Klammern kommt von der **Person**, die mit dem Benutzer verknüpft ist (Einstellungen → Personen). Ist keine Person verknüpft, wird der Benutzername genommen.
- In der Karte kannst du einstellen, wie der Name angezeigt wird: ganzer Name, nur Vorname oder Kürzel.

---

## ⚙️ Karten-Optionen

Alles lässt sich bequem im visuellen Editor einstellen. Hier die Optionen für YAML-Fans:

| Option | Standard | Was macht das? |
|---|---|---|
| `title` | `Einkaufsliste` | Überschrift |
| `store` | `all` | `all` zeigt alle Geschäfte mit Reitern. Trägst du hier die ID eines Geschäfts ein, zeigt die Karte **nur dieses Geschäft** (am einfachsten im Editor auswählen). |
| `show_added_by` | `true` | „(Name)“ hinter dem Artikel anzeigen |
| `added_by_style` | `name` | `name` (Max Mustermann), `first` (Max), `initials` (MM) |
| `show_checked` | `true` | Abgehakte Artikel unten im Bereich „Im Wagen / erledigt“ zeigen |
| `show_dates` | `true` | „seit Di“ und das 🧹-Löschdatum anzeigen |
| `show_settings` | `true` | Zahnrad für Geschäfte und Kategorien anzeigen (zum Beispiel für das Kinder-Tablet ausschalten) |

**Geschäfte & Kategorien bearbeiten:** Tipp auf das ⚙️-Zahnrad in der Karte. Dort kannst du Geschäfte und Kategorien anlegen, umbenennen, einfärben, sortieren (▲▼) und löschen.

---

## 🤖 Für Automationen

### Sensor
`sensor.einkaufsliste_offene_artikel` gibt die Anzahl der offenen Artikel an und hat diese Attribute:

| Attribut | Inhalt |
|---|---|
| `pro_geschaeft` | z. B. `{"Aldi": 3, "Netto": 1}` |
| `artikel` | Liste mit `name`, `menge`, `geschaeft`, `kategorie`, `von` |
| `abgehakt` | Anzahl abgehakter Artikel |
| `naechstes_aufraeumen` | Zeitpunkt des nächsten Aufräumens |

### Aktionen
| Aktion | Was passiert |
|---|---|
| `einkaufsliste.add_item` | Setzt einen Artikel auf die Liste (`name`, optional `store`, `category`, `quantity`, `added_by`) |
| `einkaufsliste.check_item` | Hakt einen Artikel ab (`name`, optional `store`) |
| `einkaufsliste.remove_item` | Löscht einen Artikel (`name`, optional `store`) |
| `einkaufsliste.clear_checked` | Löscht alle abgehakten Artikel |
| `einkaufsliste.cleanup` | Räumt sofort nach den Regeln auf; mit `force: true` wird **alles** gelöscht |

```yaml
action: einkaufsliste.add_item
data:
  name: Milch
  store: Aldi
  category: Kühlregal & Milch
  quantity: 2 Liter
```

### Events
| Event | Wann |
|---|---|
| `einkaufsliste_item_added` | Ein Artikel wurde hinzugefügt oder wieder auf die Liste gesetzt (`name`, `store`, `category`, `quantity`, `added_by`, `readded`) |
| `einkaufsliste_cleanup` | Es wurde aufgeräumt (`removed`, `names`, `remaining`, `scheduled`, `force`) |

Fertige Beispiele (Push-Nachricht bei neuem Artikel, Erinnerung am Aldi, Aufräum-Bericht, Skript für einen NFC-Tag) findest du im Ordner [`examples/`](examples/).

---

## ❓ Häufige Fragen

**Wo werden die Daten gespeichert?**
Lokal in deinem Home Assistant (`/config/.storage/einkaufsliste.data`). Es gibt keine Cloud und nichts geht nach draußen. Deine Backups sichern die Liste automatisch mit.

**Ich hab aus Versehen etwas abgehakt!**
Einfach nochmal antippen. Innerhalb von 5 Minuten gilt das als Versehen: Der Name und das Datum bleiben dann wie vorher.

**Die Karte sagt „Integration nicht eingerichtet“.**
Dann fehlt Schritt 2. Einmal unter Geräte & Dienste die Integration **Einkaufsliste** hinzufügen.

---

## 🧪 Für Entwickler

```bash
pip install -r requirements_test.txt
pytest
```

Lizenz: MIT · Gebaut mit ❤️ und viel zu vielen Einkaufszetteln.
