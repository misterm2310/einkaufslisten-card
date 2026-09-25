<img src="docs/icon.png" width="96" align="right" alt="Icon">

# 🛒 Einkaufsliste für Home Assistant

**Die Familien-Einkaufsliste direkt im Dashboard.** Du bekommst mehrere Geschäfte, Kategorien, Rezepte und Live-Sync auf allen Handys. Hinter jedem Artikel steht, wer ihn eingetragen hat. Was gekauft ist, wird abgehakt und bleibt als „schon mal gekauft“ in der Liste. So ist es beim nächsten Mal mit einem Tipp wieder drauf.

![Vorschau](docs/screenshot.png)

---

## ✨ Was kann das Ding?

| Funktion | So klappt's |
|---|---|
| 🏪 **Mehrere Geschäfte** | Netto, Aldi, Lidl, Rewe und DM sind vorbereitet, weitere legst du einfach in der Karte an. Oben hat jedes Geschäft seinen eigenen Reiter. |
| 🗂️ **Kategorien** | Obst & Gemüse, Backwaren, TK-Ware und so weiter. Offene **und** erledigte Artikel werden danach sortiert. |
| 👨‍👩‍👧‍👦 **Für die ganze Familie** | Jeder, der sich in Home Assistant anmelden kann, kann mitmachen. |
| ⭕ **Abhaken per Kreis** | Nur ein Tipp auf den Kreis hakt ab. Ein Tipp auf den Namen macht nichts, das verhindert Verdrücker. |
| ♻️ **Nichts geht verloren** | Abgehakte Artikel bleiben unten unter „Erledigt – schon mal gekauft“. Tippst du den Kreis nochmal an, steht der Artikel wieder auf der Liste. Die Kategorien sind dort eingeklappt, ein Tipp klappt sie auf. |
| 🏷️ **„(X)“ hinter dem Artikel** | Dahinter steht, wer den Artikel eingetragen oder wieder auf die Liste genommen hat. |
| 📝 **Notiz & 👤 Für wen** | Beides kannst du direkt beim Eintragen angeben, zum Beispiel *Käse · 📝 gerieben · 👤 für Oma*. |
| 🚫 **Keine Doppelten** | Jeder Artikel steht nur einmal auf der Liste. Ein zweites Mal geht nur mit **anderer Notiz**, **anderem „für wen“** oder **anderem Geschäft** (z. B. Milch bei Aldi und Milch bei Netto). |
| 🍽️ **Rezepte** | Leg ein Rezept an, zum Beispiel „Freitags Fisch“ mit allen Zutaten. Ein Tipp auf **Auf die Liste**, dann hakst du an, **welche Zutaten** du brauchst. |
| 🧹 **Automatisch aufräumen** | An einem festen Tag wird alles **abgehakt**, was mindestens 7 Tage drinsteht. **Gelöscht wird nichts.** |
| ⚡ **Live-Sync** | Trägt jemand etwas ein, steht es sofort auf allen Handys. Ohne Neuladen. |
| 📸 **Fotos** | Ein Foto zum Artikel („genau diese Marke!“), auswählbar direkt beim Eintragen. |
| 🔍 **Barcode** | In der Home-Assistant-App scannen: zu Hause zum **Eintragen** (auch mehrere hintereinander), im Laden zum **Abhaken**. |
| 📖 **Kategorie raten** | Tippst du „Joghurt“, springt die Kategorie von selbst auf Kühlregal, bei „Pizza“ auf TK-Ware. Dafür gibt es ein eingebautes Wörterbuch mit rund 250 Produkten. Wählst du selbst etwas aus, hat das Vorrang. |
| 🔁 **„War aus!“** | Gab's bei Aldi nicht? Tipp am Artikel auf **⇄** und dann auf **Netto**, und der Artikel wandert rüber. |
| 📍 **Nächstes Geschäft** | Bist du bei einem Geschäft, springt die Liste automatisch auf dessen Reiter. Jeder sieht dabei sein eigenes Geschäft. |
| 🛒 **Laden-Modus** | Ein Tipp auf den Wagen oben: große Zeilen, dicke Kreise, das Eingabefeld ist weg. Nur noch abhaken, auch mit einer Hand am Einkaufswagen. |
| 🔗 **Doppelt-Finder** | Stehen „Tomate“ und „Tomaten“ (oder „Klopapier“ und „Toilettenpapier“) gleichzeitig drauf, fragt die Liste: **Zusammenlegen?** |
| ✨ **Ordentliche Namen** | Aus „  milch “ wird automatisch „Milch“. |
| 🔎 **Merkt sich Produkte** | Beim Tippen kommen Vorschläge, Geschäft und Kategorie werden automatisch ausgefüllt. Tippst du einen Vorschlag an, kommen auch Menge, Notiz und „für wen“ mit. |

---

## 🧹 Das Aufräumen, einfach erklärt

Stell dir vor, der Aufräum-Tag ist **Sonntag** und das Mindestalter ist **7 Tage**.

| Eingetragen am | 1. Sonntag danach | 2. Sonntag danach |
|---|---|---|
| **Dienstag** | erst 5 Tage alt, **bleibt offen** | 12 Tage alt, **wird abgehakt** |
| **Samstag** | erst 1 Tag alt, **bleibt offen** | 8 Tage alt, **wird abgehakt** |
| **Sonntag** (nach dem Aufräumen) | genau 7 Tage alt, **wird abgehakt** | – |

Jeder Artikel bleibt also **mindestens eine Woche** offen. Unter jedem Artikel zeigt die Karte mit 🧹 an, **an welchem Tag** er automatisch abgehakt wird. Danach steht er unter „Erledigt“ und du kannst ihn jederzeit mit einem Tipp zurückholen.

> 💡 Nimmst du einen Artikel wieder auf die Liste, fängt die Woche von vorne an.
> 💡 Hat Home Assistant zur Aufräumzeit geschlafen (Neustart, Update), wird das Aufräumen beim nächsten Start nachgeholt.
> 🗑️ Richtig löschen kannst du einen Artikel nur von Hand: **⚙️ Zahnrad → Artikel ganz löschen**. Dort gibt es auch ein Suchfeld.

Tag, Uhrzeit und Mindestalter stellst du hier ein:
**Einstellungen → Geräte & Dienste → Einkaufsliste → Konfigurieren**

---

## 📦 Installation (Schritt für Schritt)

### Schritt 1: In HACS hinzufügen
1. **HACS** öffnen.
2. Oben rechts auf die **drei Punkte ⋮** und dann auf **Benutzerdefinierte Repositories** tippen.
3. Bei Repository `https://github.com/misterm2310/einkaufslisten-card` eintragen, als Typ **Integration** wählen und **Hinzufügen** tippen.
4. Nach **Einkaufsliste** suchen, auf **Herunterladen** tippen und danach **Home Assistant neu starten**.

<details>
<summary>Ohne HACS (von Hand)</summary>

Kopiere den Ordner `custom_components/einkaufsliste` nach `/config/custom_components/einkaufsliste` und starte Home Assistant neu.
</details>

### Schritt 2: Integration einrichten
1. **Einstellungen → Geräte & Dienste → Integration hinzufügen**
2. Nach **Einkaufsliste** suchen.
3. Aufräum-Tag, Uhrzeit und Mindestalter wählen und **Absenden**. Fertig! 🎉

### Schritt 3: Karte aufs Dashboard
1. Dashboard öffnen, dann **Bearbeiten → Karte hinzufügen**.
2. Nach **Einkaufsliste** suchen und die Karte auswählen. Fertig.

```yaml
type: custom:einkaufsliste-card
```

> 🎨 Ab Home Assistant **2026.3** erscheint die Integration mit ihrem eigenen Icon (🛒✅) unter Geräte & Dienste.
> 🙌 Du musst **keine** Ressource von Hand eintragen. Die Integration trägt die Karte beim Start selbst unter **Einstellungen → Dashboards → Ressourcen** ein und hält sie bei Updates aktuell.
> Hast du sie früher schon von Hand eingetragen, ist das kein Problem: Der Eintrag wird einfach übernommen.
> Sieht die Karte nach einem Update komisch aus? Dann in der App einmal **nach unten ziehen** oder im Browser den Cache leeren (Strg+F5).

---

## ✍️ Artikel eintragen

```
[ Was brauchen wir?        ] [✅]
  🔢   📝   👤   📷   ▥
[🛒 Geschäft ] [📦 Kategorie ]
```

1. Den Namen eintippen, zum Beispiel „Milch“. Die **Kategorie** wird meistens schon von selbst ausgewählt. 📖
2. Mehr Angaben? Einfach das passende **Symbol** antippen, dann geht nur dieses Feld auf:
   - **🔢 Menge**: Schnellknöpfe **[1x] [2x] [3x] [4x] [6x] [10x]** oder ✏️ für eine eigene Menge wie „500 g“
   - **📝 Notiz**, zum Beispiel „Bio“
   - **👤 Für wen?**: Einfach die Person antippen (nur, wenn Personen angelegt sind)
   - **📷 Foto** aus der Galerie
   - **▥ Barcode scannen** (nur in der Home-Assistant-App)
3. Auf den **grünen Haken ✅** tippen. Fertig!

Doch nicht? Rechts in der Leiste erscheint ein roter **Radiergummi 🧽**. Ein Tipp darauf leert alle Felder auf einmal.

Was du gewählt hast, steht direkt am Symbol, zum Beispiel **🔢 2x · 👤 Oma**. Bei der Notiz zeigt ein **blauer Punkt**, dass etwas drinsteht. Nach dem Eintragen klappt alles wieder zu. ✨

---

## 👆 Bedienung in der Liste

- **⭕ Kreis antippen:** abhaken
- **⇄ antippen:** „War aus!“, also in ein anderes Geschäft verschieben
- **Artikel lange drücken** (am PC: Rechtsklick): Es öffnet sich ein Menü (klappt nach 8 Sekunden ohne Tipp von selbst wieder zu) mit ✏️ **Bearbeiten** · ⇄ **Verschieben** („War aus!“) · 🔢 **Menge** · 📷 **Foto** · ▥ **Barcode**
- **Auf die Menge tippen** (zum Beispiel „2x“): Es erscheint **[−] 2x [＋]** zum schnellen Ändern
- **✨ und rote Blase:** Artikel, die **andere** eingetragen haben, seit du zuletzt geschaut hast, bekommen ein ✨. Am Geschäfts-Reiter steht dann zum Beispiel **„+2“**. Tippst du den Reiter an, verschwindet die Blase, aber **nur bei dir**. Jeder hat seine eigene, wie bei WhatsApp. 🔴
- **Farbstreifen:** Jede Kategorie hat ihre Farbe (links am Artikel). Die Farben änderst du im ⚙️ Zahnrad bei den Kategorien.
- **Zeit:** Bei Artikeln von heute steht „gerade eben“, „vor 5 Min“ oder „vor 2 Std“.
- **🛒 Laden-Modus:** Oben auf den **Einkaufswagen** tippen. Die Zeilen und Kreise werden groß, das Eingabefeld verschwindet, und oben steht „Laden-Modus“. Nochmal tippen (oder **Beenden**) schaltet zurück. Jedes Handy merkt sich das für sich.
- **🔗 Doppelt-Finder:** Stehen zwei Artikel mit fast gleichem Namen beim selben Geschäft, zum Beispiel „Tomate“ und „Tomaten“, erscheint oben eine Frage. **Zusammenlegen** macht daraus einen Artikel, und Mengen wie 2x + 3x werden zu **5x** zusammengezählt. **Passt so** fragt bei diesem Paar nie wieder.
- **📱 Kompakt-Modus:** Im Karten-Editor einschalten. Dann gibt's kleinere Zeilen ohne Zusatz-Infos, und mehr passt auf den Bildschirm.

---

## 🍽️ Rezepte

1. In der Karte oben auf das **⚙️-Zahnrad** tippen und dort bei **Rezepte** auf **Neues Rezept** tippen. Bearbeiten und Löschen geht dort über den ✏️-Stift.
2. Einen Namen vergeben, zum Beispiel „Freitags Fisch“.
3. Die Zutaten eintragen. Pro Zutat kannst du Menge, Notiz, „für wen“, Geschäft und Kategorie angeben. Lässt du Geschäft und Kategorie auf **„Wie zuletzt“**, wird genommen, was bei diesem Produkt zuletzt benutzt wurde.
4. **Speichern**.
5. Zum Einkaufen oben auf die **Kochmütze 👨‍🍳** tippen. Ein Tipp auf **Auf die Liste**, dann fragt die Liste: **„Was davon brauchst du?“** Hake die Zutaten an, die fehlen (was schon auf der Liste steht, ist nicht angehakt), und tipp auf **„✅ 3 auf die Liste“**.

Rezept-Zutaten kommen **zusätzlich** auf die Liste, als eigener Eintrag. Steht zum Beispiel schon Mozzarella für den normalen Einkauf drauf, bekommst du einen zweiten Eintrag:
- **Mozzarella**
- **Mozzarella** · 🍽️ Freitags Fisch

Tippst du zweimal auf dasselbe Rezept, kommt nichts doppelt dazu.

Unter jedem Artikel steht klein, zu welchem Rezept er gehört (🍽️ Freitags Fisch).

✅ **Hakst du eine Rezept-Zutat ab, verschwindet sie ganz.** Sie taucht also nicht unten bei „Erledigt“ auf. Das gilt auch beim automatischen Aufräumen. Normale Artikel bleiben wie gewohnt unter „Erledigt“ stehen.

---

## 📍 Nächstes Geschäft zuerst

Die Liste springt automatisch auf den Reiter des Geschäfts, bei dem **du** gerade bist.
1. Leg für jedes Geschäft eine **Zone** an: **Einstellungen → Bereiche, Beschriftungen & Zonen → Zonen → Zone hinzufügen** (zum Beispiel „Aldi“, direkt über den Laden gelegt).
2. In der Karte aufs **⚙️ Zahnrad** tippen. Unter jedem Geschäft wählst du bei **📍** die passende Zone aus.
3. Fertig! Kommst du in die Nähe, springt die Liste auf „📍 Aldi“. Gehst du wieder weg, zeigt sie wieder „Alle“.

- **Jeder sieht sein eigenes Geschäft:** Die Karte nimmt den Standort der **Person, die gerade draufschaut**. Stehst du beim Netto und jemand anderes beim Aldi, sieht jeder „seinen“ Laden.
- Dafür muss die Person ihren **Standort über die Companion-App** senden. Wer das nicht tut, sieht einfach ganz normal „Alle“.
- Ausschalten kannst du das im Karten-Editor bei **„📍 Automatisch zum Geschäft springen“**.

---

## 📸 Fotos zum Artikel

Damit keiner mehr die falschen Nudeln mitbringt. 😄
1. **Direkt beim Eintragen:** Tippe in der Symbol-Leiste unter dem Eingabefeld auf **📷** und wähle ein Foto aus. Das Symbol wird blau. Tippst du jetzt auf den **grünen Haken ✅**, kommt das Foto gleich mit. (Nochmal aufs blaue 📷 tippen, und das Foto ist wieder raus.)
2. **Oder später:** Den Artikel **lange drücken** und auf **📷 Foto** tippen. Das Foto wählst du aus der Galerie.
3. Fertig! Hinter dem Artikel erscheint ein kleines **📷**. Tippst du darauf, geht das Foto groß auf. Noch ein Tipp, und es ist wieder zu.

- Das Foto **bleibt beim Produkt**, auch nach dem Abhaken und Wieder-Reinnehmen. Einmal knipsen reicht.
- Auch **Rezept-Zutaten** können ein Foto haben: Das geht im Rezept über den 📷-Knopf neben der Zutat.
- Fotos werden noch auf dem Handy **automatisch verkleinert**, auf ungefähr 100 KB.
- Gespeichert wird alles **nur bei dir** unter `/config/einkaufsliste_fotos` und mit deinen Backups gesichert.
- Löschst du einen Artikel ganz (⚙️ → Artikel ganz löschen), ist auch das Foto weg. Außer eine Rezept-Zutat braucht es noch.

---

## 🔍 Barcode scannen (in der Home-Assistant-App)

Der ▥-Knopf in der Symbol-Leiste weiß von selbst, wo du bist:

### 🏠 Zu Hause: eintragen
1. Auf **▥** tippen. Der **Scanner der App** geht auf.
2. Packung in den Rahmen halten. Name (mit Marke) und Kategorie werden ausgefüllt.
3. Auf den **grünen Haken ✅** tippen. Fertig!

**📦 Mehrere auf einmal (Serien-Scan am Kühlschrank):** Tippe im Scanner unten auf **„📦 Mehrere scannen“**. Jetzt einfach eine Packung nach der anderen scannen, *piep, piep, piep*. Jede kommt **sofort** auf die Liste, und der Scanner zeigt kurz „✅ Milch ist drauf“. Am Ende auf **„✔ Fertig“** tippen.
- Kennt niemand den Barcode, kommt er als **„❓ Unbekannt 1234“** auf die Liste und blinkt orange. Benenne ihn später einmal um (lange drücken → Bearbeiten). Ab dann kennt die Liste diesen Barcode für immer. 🧠

### 🛒 Im Laden: abhaken
Bist du bei einem Geschäft, das eine **📍 Zone** hat, wird der ▥-Knopf **grün mit ✓**. Dann gilt:
1. Auf **▥** tippen.
2. Jede Packung scannen, bevor sie in den Wagen kommt. Der passende Artikel wird **automatisch abgehakt** („✅ Milch abgehakt“).
3. Am Ende auf **„✔ Fertig“** tippen.

### Gut zu wissen
- Weil die **App** die Kamera öffnet (nicht der Browser), klappt das auch über `http://`. Du musst **nichts umstellen**.
- Den ▥-Knopf gibt es nur in der **Home-Assistant-App** (Android/iPhone). Am PC-Browser ist er ausgeblendet.
- Die Produktnamen kommen aus den freien Datenbanken **Open Food Facts**, **Open Beauty Facts** und **Open Products Facts**. Dafür braucht dein Home Assistant **Internet**.
- **Unbekannter Barcode beim Einzel-Scan:** Tipp den Namen einmal selbst ein, und die Liste merkt ihn sich. Das gilt auch, wenn du einen gefundenen Namen änderst, zum Beispiel „Milch“ statt „Weihenstephan H-Milch 1,5 %“.
- **📸 Produktfoto automatisch:** Hat der Artikel noch **kein eigenes Foto**, holt die Liste nach dem Scannen das Packungsbild aus der Datenbank. Ein eigenes Foto wird **nie** überschrieben. Nicht jedes Produkt hat dort ein Bild.
- **Barcode für einen Artikel, der schon auf der Liste steht:** Artikel **lange drücken → ▥ Barcode** und die Packung scannen.

---

## 👨‍👩‍👧‍👦 Die Familie dazuholen

- Jedes Familienmitglied braucht einen **eigenen Home-Assistant-Benutzer** (Einstellungen → Personen → Benutzer). Admin-Rechte sind **nicht** nötig.
- Der Name in Klammern kommt von der **Person**, die mit dem Benutzer verknüpft ist (Einstellungen → Personen). Ist keine Person verknüpft, wird der Benutzername genommen.
- Die Personen für das Feld **„Für wen?“** trägst du selbst ein: in der Karte auf das **⚙️-Zahnrad** tippen und bei **Personen** hinzufügen (z. B. Oma, Papa, Kita). Dann wählst du sie beim Eintragen einfach aus der Liste aus, am PC und am Handy gleich.
- Solange keine Personen angelegt sind, ist das Feld „Für wen?“ ausgeblendet.
- Benennst du eine Person um, wird der Name automatisch überall mitgeändert.

---

## ⚙️ Karten-Optionen

Alles lässt sich bequem im visuellen Editor einstellen. Für YAML-Fans:

| Option | Standard | Was macht das? |
|---|---|---|
| `show_title` | `true` | `false` blendet den Titel oben aus |
| `title` | `Einkaufsliste` | Überschrift |
| `store` | `all` | `all` zeigt alle Geschäfte mit Reitern. Wählst du im Editor ein Geschäft aus, zeigt die Karte **nur dieses Geschäft**. |
| `show_added_by` | `true` | „(Name)“ hinter dem Artikel anzeigen |
| `added_by_style` | `name` | `name` (Max Mustermann), `first` (Max) oder `initials` (MM) |
| `show_checked` | `true` | Bereich „Erledigt – schon mal gekauft“ anzeigen |
| `show_dates` | `true` | „seit Di“ und das 🧹-Datum anzeigen |
| `show_recipes` | `true` | Kochmützen-Knopf für Rezepte anzeigen |
| `compact` | `false` | 📱 Kompakt-Modus: kleinere Zeilen ohne Zusatz-Infos |
| `auto_store` | `true` | 📍 Automatisch zum Geschäft springen, bei dem man gerade ist |
| `show_settings` | `true` | Zahnrad für Geschäfte und Kategorien anzeigen (zum Beispiel fürs Kinder-Tablet ausschalten) |

**Geschäfte, Kategorien & Personen:** Tipp auf das ⚙️-Zahnrad. Dort kannst du alles anlegen, umbenennen, sortieren (▲▼) und löschen. Geschäfte kannst du außerdem einfärben.
**Icons:** Tippe einfach den Namen ein, ohne „mdi:“, zum Beispiel `hund`, `dog` oder `fish`. Die passenden Icons erscheinen direkt als Vorschau zum Antippen.

---

## 🤖 Für Automationen

### Sensor
`sensor.einkaufsliste_offene_artikel` zeigt die Anzahl der offenen Artikel und hat diese Attribute:

| Attribut | Inhalt |
|---|---|
| `pro_geschaeft` | z. B. `{"Aldi": 3, "Netto": 1}` |
| `artikel` | Liste mit `name`, `menge`, `notiz`, `fuer`, `geschaeft`, `kategorie`, `von` |
| `abgehakt` | Anzahl der erledigten Artikel |
| `naechstes_aufraeumen` | Zeitpunkt des nächsten Aufräumens |

### Aktionen
| Aktion | Was passiert |
|---|---|
| `einkaufsliste.add_item` | Setzt einen Artikel auf die Liste (`name`, optional `store`, `category`, `quantity`, `note`, `for_whom`, `added_by`) |
| `einkaufsliste.add_recipe` | Setzt alle Zutaten eines Rezepts auf die Liste (`name`) |
| `einkaufsliste.check_item` | Hakt einen Artikel ab (`name`, optional `store`) |
| `einkaufsliste.remove_item` | Löscht einen Artikel ganz (`name`, optional `store`) |
| `einkaufsliste.cleanup` | Räumt jetzt nach den Regeln auf. Mit `force: true` wird **alles** abgehakt |

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
| `einkaufsliste_item_added` | Ein Artikel wurde hinzugefügt oder wieder auf die Liste genommen (`name`, `store`, `category`, `quantity`, `note`, `for_whom`, `recipe`, `added_by`, `readded`) |
| `einkaufsliste_cleanup` | Es wurde aufgeräumt (`checked`, `names`, `still_open`, `scheduled`, `force`) |

---

## ❓ Häufige Fragen

**Wo werden die Daten gespeichert?**
Lokal in deinem Home Assistant (`/config/.storage/einkaufsliste.data`). Keine Cloud, nichts geht nach draußen. Deine Backups sichern die Liste automatisch mit.

**Die Karte sagt „Integration nicht eingerichtet“.**
Dann fehlt noch Schritt 2: unter Geräte & Dienste die Integration **Einkaufsliste** hinzufügen.

---

## 🧪 Für Entwickler

```bash
pip install -r requirements_test.txt
pytest
```

Lizenz: MIT · Produktdaten: [Open Food Facts](https://world.openfoodfacts.org) (ODbL) · Gebaut mit ❤️ und viel zu vielen Einkaufszetteln.
