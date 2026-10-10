<img src="docs/icon.png" width="96" align="right" alt="Icon">

# 🛒 Shopping list for Home Assistant

🇩🇪 **Deutsch?** → [README auf Deutsch](README.md)

**The family shopping list right in your dashboard.** Several stores, categories, recipes and live sync on every phone. Every item shows who added it. Bought things get checked off and stay as “bought before”, so next time they are back on with a single tap.

> 🌍 The card was written in German and speaks English whenever your Home Assistant is not set to German (or with `language: en`). On a fresh English install the default stores, categories and recipe groups are English too. Your own entries are never translated. Spot a German leftover? Please open an issue.

![Preview – shopping list light and dark](docs/screenshot.png)

<details><summary>🛒 See shop mode</summary>

![Shop mode](docs/screenshot-laden.png)

</details>

---

## ✨ What can it do?

| Feature | How it works |
|---|---|
| 🏪 **Several stores** | Each store gets its own tab. When your location says you're at a store, the list jumps there. |
| 🗂️ **Categories** | Fruit & vegetables, frozen … The list guesses the category itself (“yogurt” → dairy). |
| 👨‍👩‍👧‍👦 **For the whole family** | Everyone with an HA user can join, no admin rights needed. Live on every phone. |
| ♻️ **Nothing gets lost** | Checked items move down to “Done”. Tap the circle again = back on the list. |
| 🏷️ **For whom & who** | *Cheese (for Grandma)* – and in small print who added it. |
| ⚡ **Quick entry** | “3 milk” or “500 g flour” – quantity and name are recognised, one entry is always one product. Suggestions bring back everything from last time. After just **1–2 letters** you also get suggestions from a built-in list of ~1400 common products (with category, German only). |
| 🍽️ **Recipes** | Ingredients onto the list with one tap, scaled for x people. Cook mode, photos, sharing and import (links and US measures too). |
| 🔍 **Barcodes** | Scan in the HA app or with the phone camera in the offline app: add at home, check off in the store. |
| 🔁 **“Was out!”** | ⇄ on the item: here again next time, or move it to another store. The list notices what's often missing. |
| 🛒 **Shop mode** | Big rows, checking off only – one hand on the cart. At the bottom “Just ticked off”: ticked something by mistake? Tap ↩️ and it is back with its note and quantity. |
| 📱 **Offline app** | The complete card as a phone app that opens without a connection. Changes are sent later. |
| ⏲️ **Cooking times** | Cheat sheet by appliance: 🍲 stove, 🔥 oven, 💨 air fryer. |
| 🧹 **Cleanup** | Once a week old items get **checked off**, nothing is deleted. On/off, day and time right in the card (⚙️ → Cleanup). |
| 👁️ **List view** | Decide what an item shows (quantity, notes, who, when, photo, star …) – default for everyone in ⚙️, **per person** at the very bottom with “👁️ View” (no PIN). |
| 🟢 **Top bar** | On every page: connected / waiting / offline, 🔓 lock now (with PIN) and the version. |
| 🔒 **PIN** | Settings (the gear) only with a PIN – the list stays open for everyone. |
| 📌 **Sidebar** | If you like, its own entry in the sidebar on the left (the list on the full page, no dashboard of its own). **Off** by default: Devices & services → Einkaufsliste → Configure → “Show in sidebar”. |
| 📸 **Text from photo** | Photograph a shopping note or receipt; the card reads the text right on the device (handwriting only with luck – text can be corrected first). Headings like “Aldi:” on the note assign items to that store; with a receipt you can tap the right amount if there are several. Also: 🩺 health light (also as sensor `sensor.einkaufsliste_gesundheit`), 🐞 error log, 🧲 merge products. |
| 🌍 **German & English** | The card speaks the language of Home Assistant. |

Empty input fields show an example (for the quantity one that fits the product, e.g. “2 L”), and the guides come in light and dark (like the card). Plus lots of small things: photos per product, nicknames (“Kleenex” = tissues), learned typos, store brands when scanning, duplicate finder, history, backup, a mascot 🛒😊 and more.

**🗣️ With Alexa:** “Alexa, add milk to my shopping list” – and the milk lands on *this* list (see [Alexa & other lists](#-alexa--other-lists)).

---

## 📦 Installation

1. Open **HACS** → top right **⋮ → Custom repositories**.
2. Add `https://github.com/misterm2310/einkaufslisten-card`, type **Integration**.
3. Search for **Einkaufsliste**, **Download**, **restart Home Assistant**.
4. **Settings → Devices & services → Add integration → Einkaufsliste** → Submit, done. 🎉 (Cleanup day and time are set later in the card: ⚙️ → Cleanup.)
5. Dashboard → **Edit → Add card → Einkaufsliste**.

```yaml
type: custom:einkaufsliste-card
```

> 🙌 No need to add a resource by hand – the integration does it.
> Card looks odd after an update? Pull down to refresh in the app or press Ctrl+F5 in the browser.

<details><summary>Without HACS (manually)</summary>

Copy `custom_components/einkaufsliste` to `/config/custom_components/einkaufsliste` and restart Home Assistant.
</details>

---

## 👆 How to use it

**Adding:** type a name, tap the green ✔. The buttons below: 🔢 quantity · ✏️ own note · 👤 for whom · 📷 photo (on the phone: 📷 camera · 🖼️ gallery · 📋 paste – over https the camera opens right inside the card; in the HA app over the local http address the gallery opens straight away. On a PC: a window to drag into, **Ctrl + V** (e.g. a screenshot of a flyer) or choose a file) · ⭐ all favourites onto the list (mark a product with “⭐ Favourite” when editing; whatever is already on it is not added twice) · 🧽 clear. Store and category are usually picked correctly already. A store is missing? Pick **“➕ New store …”** in the list – just type the name, the rest later in ⚙️.

**In the list:**
- ⭕ **Circle** = check off. Under “Done” once more = back on the list.
- 👆 **Swipe** (on the phone): swipe a row **to the left** = check off ✔, swipe a done row **to the right** = back on the list ↩.
- ↩️ **Checked off by accident?** “Undo” shows at the bottom for 3 seconds (only for whoever checked it off). After “Scan several” / “Scan & check off” “Undo” shows for 5 seconds for the item scanned last.
- ⇄ = was out (stays open marked “was out”, or moves to another store).
- 🤷 **“Anywhere”** = items without a fixed store. They show up in **every** store tab (tagged “🤷 Anywhere”) – wherever you happen to be. Check off = gone everywhere. Moving one to a store with ⇄ simply relocates it, nothing is left under “Done”. The other way round works too: ⇄ → **🤷 Anywhere**. Checked off in a store tab, it belongs to that store from then on (there under “Done”, gone from the others) – and comes back there next time.
- **Long-press** = menu: edit, move, quantity, category, photo, barcode, info.
- **Tap the quantity** = [−] 2x [＋].
- ✨ = new since you last looked; the red number on a tab shows how much is new there.
- The **shopping cart** at the top left takes you back to the shopping list from anywhere (recipes, settings …).
- At the very bottom, below the list, **📖 Guide** opens a guide for the whole family – including the app link to copy.

**In the store:** the **🏪 store** at the top right switches on **shop mode**. No connection? Keep checking off, the bar at the top shows ⏳ in orange and everything is sent later. The **💡 icon** (between 💳 and the 🏪 store) keeps the screen on in shop mode – it switches off by itself when you leave. **In the HA app** this only works with its own setting: *Settings → Companion App → “Keep screen On”*.

**Recipes:** create them in ⚙️ → Recipes (ingredients just like on the list, or paste an ingredient list or a recipe link). The **chef's hat** at the top: **Add to list** → tick what's missing → done. Also 👥 people or 🍕 trays scaling, **🔥 Cook** (step by step), **Share** (e.g. WhatsApp) and **⏲️ cooking times**. Checked recipe ingredients disappear completely. The buttons are icons only; ⚙️ → Extras → **Labels** or a long press shows the text.

---

## 🔍 Scanning barcodes

The ▥ button at the top knows where you are:
- 🏠 **At home:** scan a pack → name, brand and category are filled in → ✔. With **“📦 Scan several”** every pack goes straight onto the list. Unknown ones are added as “❓ Unknown” – rename once and the list knows the barcode.
- ▥ **Assign a barcode later** (long-press → Barcode): if the product has a different name in the database than with you, you can choose individually whether name and/or note are taken over.
- 🛒 **In the store** (store with a 📍 zone): every scanned pack is checked off on the list.

**Where does it work?**
- In the **Home Assistant app** (Android/iPhone) with its scanner – works over `http://` too.
- In the **offline app** with the phone camera. The first time, the phone asks whether the page may use the camera. Without a connection it only recognizes barcodes the list already knows; adding and checking off still work (sent later).
- No scanner in a desktop browser.

Product names come from **Open Food Facts**, **Open Beauty Facts** and **Open Products Facts** (Home Assistant needs internet for that). Store brands such as Milsani, ja! or Balea go straight to the right store; add your own per store in ⚙️ → Stores.

---

## 📱 Offline app

The **complete card** as its own app on your home screen – with recipes, cook mode, cooking times, settings and camera scanner. It opens **without a connection** with the last state.

1. Copy the address: in **⚙️ → App & info → Offline app** or in the **guide** (“📖 Guide” button at the very bottom) – so everyone without the gear can get it too.
2. Paste it into the phone's **browser** (Chrome or Safari, not the HA app).
3. Log in with your own Home Assistant user.
4. Browser menu → **“Add to Home screen”**.

**↩️ Back button:** goes back step by step inside the app (closes windows, one level up in the settings, ends shop mode). Only on the plain list does the app close. This also applies to the **HA card on the dashboard**: Back closes one window after the other before the page is left.

**📱 Quick menu (Android):** long-press the app icon → ✍️ Add · 🛍️ Shop mode · 📷 Scan – the app opens right at that spot. (iPhones don't offer this for web apps.)

**Needs a connection:** looking up new barcodes, product info, recipe links, new photos, backup.

**🔄 Sending while the app is closed:** on **Android with Chrome** the app sends remembered changes even when it's closed – Android wakes it up briefly once there's a connection again (Android decides exactly when; with strict battery saving it can take a while). **iPhones** can't do this; there it's sent the next time you open the app. Each app has its own queue: what the offline app remembered is only sent by the offline app.

Good to know: it needs an **https** address (e.g. Nabu Casa). If two people change the same thing at once, the last change wins. iPhones sometimes clear a web app's offline storage after weeks without use – just open it once with a connection.

---

## ⚙️ Settings (gear)

The settings are a **list with groups** – **📋 My list · 🎛️ Extras · 💾 Data · 🩺 Health · 📱 App & info** – and only **one level deep**. A **search field** at the very top finds rows by name or topic (“photo”, “mail”, “backup”, “sensor”). Each group is a **box** with a short preview of what's inside, and every row has a **coloured icon** – like the settings menu on your phone. The groups start **collapsed**: tap one to open it, the previous one closes (the search opens matching ones by itself). Simple on/off things (🛒😊 Mascot, 💳 Loyalty cards, 🧾 Purchase log, 📍 Automatic shop mode, 🏷️ Labels) have a **switch right in the row**; the row itself opens the explanation with the same switch at the top. Go back with the round **←** at the top. At the bottom there is the **📖 Settings guide** button; the guide for shopping and recipes is separate, up front (cart or “Guide” button).

| Row | What's inside |
|---|---|
| 🏪 **Stores** | A list, one store per row. **⌃ ⌄** right in the list = order of the tabs. Tap = name, color, icon, 📍 zones (several, e.g. for several branches), 🏷️ store brands and 🗺️ **category order** (default: same everywhere – or its own, the way you walk through the store). Without an icon of its own the list uses the zone's icon (if it has one), otherwise 🛒. |
| 🗂️ **Categories** · 👥 **People** | Like stores: first the list (sort with ⌃⌄, add new ones below), then tap one = rename, colour, icon (just type “dog”, no “mdi:”), delete. The fields sit one below the other. |
| 👁️ **List view** (under 📱 App & info) | At the very top **🏷️ Labels** (text under the icons, just for you; otherwise ⚙️ → Extras → Labels applies), then **font size** and tick or untick: quantity, notes, for whom, who added/checked it, date, 🧹 day, store, recipe, photo, ⭐, ▥, offers, “was out”, ⇄ button, ✨ and category colour. In ⚙️ the **default for everyone**. Also: **font size** (Smaller / Standard / Larger) and **hiding** the input fields (What do I need, stores, categories, icon bar) and the store bar on top – for a calm list on a tablet. Everyone sets their **own view** at the very bottom with **“👁️ View”** (next to “📖 Guide”) – no gear or PIN (applies to your HA user on all devices). |
| 👨‍🍳 **Recipes** | Two tabs: **Recipes** (new, edit, delete) and **Recipe groups**. The instructions have **one line per step** (with a photo); steps can be **moved** by dragging the **⠿** (or with ↑ ↓) – the photos move along. |
| 📦 **Products** | Everything the list knows: rename, category, default store, nicknames, photos, barcodes, learned typos, delete completely. Plus “Newly scanned” to check, 🔽 filters (no category, no photo, per store …) and **➕** (new product) and **▥** (by barcode: scan, confirm the name). The filter **🗓️ Not bought for 3 months** (last checked off, otherwise last added; nothing that is on the list or in a recipe) shows products to tidy up – delete them one by one or **all at once**. On a PC: click selects, ↑↓ browses, double-click/Enter edits – the same in **shopping list**, **recipes** and **deleted** (space checks off, Esc goes back, the ⚙️ PIN confirms with Enter). · **▥ Add barcode** (in the product: type the number – Enter confirms – or scan it; afterwards the list looks it up in the database) · **🗄️ Reload data** (product with a barcode: shows name, note, Nutri-Score and allergens from the database next to your data; you tick name, note and/or photo individually) · **✏️ Own note** (the only note field you type yourself, stays with the product, is never overwritten by the database; the 📝 note now comes only from the barcode; old, self-typed notes are shown as ✏️ automatically; in the catalogue the barcode note follows the name, otherwise the ✏️ one) · **🔄 Fetch everything again** (cloud icon at “All products”: you choose photo (preselected), name and/or note, then it goes through all products with a barcode one by one; your own photos and ✏️ Own note stay; short pauses, retries on errors, all barcodes are tried; at the end a report per product: adjusted, already the same, database knows nothing/unreachable, no photo) · **🔎 Search** finds by name, notes, nicknames, barcode number, category, store and learned typos · **🏷️ Nicknames** can also be entered when editing an item (long-press → Edit, several separated by commas) |
| 💾🩺 **Data & Health** | **All good?** (finds broken entries; for each finding 🔧 Fix, ✏️ Change it myself and – where needed – a choice, or tick and repair everything at once) · **Import & backup** (lists from other apps – once or 🔁 automatically –, backup as .zip; file import and backup for admins) · **History** (who did what and when, “📈 Often not available”, hide with ✖) · **Cleanup** (on/off, day, time, minimum age) · **📊 Resources** (how much space data and photos take, plus the 📊 load display) |
| 🎛️📱 **Extras, App & info** | **🏷️ Offers** (Extras, see below) · **Offline app** (your address with a copy button) · **Mascot** 🛒😊 (the switch applies to everyone) · **📍 Automatic shop mode** (the switch applies to all devices, also in the offline app; the location stays with each person: it only switches on when *your* phone enters the zone) · **💳 Loyalty cards** (the switch applies to everyone; scan (QR, **Aztec** or barcode), type or **photograph** Payback & co., “for everyone” or “only me”, shown big, also in shop mode; the format comes automatically from the scanner; a photo is stored only on your Home Assistant and does not help with “rolling codes” that keep changing) · **🧾 Purchase log** (the switch applies to everyone, see below) · **Protection** (4–8 digit PIN for the gear; forgot it? Devices & services → Einkaufsliste → Configure → “Reset PIN”, admins only – honestly: protection against accidental changes, not a safe – details in “🔐 Honestly, about security” below). While the gear is unlocked, a 🔓 shows in the bar at the very top next to the version number – tap it to lock right away · **Light / dark** (offline app only: automatic, light or dark) · **🛡️ Privacy** (what stays at home, what goes to the internet; admins switch “Privacy on” for all devices) · **🏷️ Labels** (short text under the icons, switch in ⚙️ → Extras, applies to everyone; even without the switch, **pressing and holding** an icon briefly shows its name) |
| 🆕 **What's new** | What changed in the current version. Also in the guide. |
| 🙏 **Credits** | Version, who made it, links to GitHub and “Report a bug”. Also in the guide. |

### 🔐 Honestly, about security
- **The PIN only protects the user interface.** It keeps kids and slips away from the gear. On the server it is **not** enforced for non-admin users: anyone with a Home Assistant user who talks to the interface (API) directly can reach the settings without the PIN. Wrong guesses are slowed down: **after 5 wrong tries the PIN is locked for 60 seconds**. Still not a safe.
- **The email import trusts the sender address.** The “From” of an email is not authenticated and can be faked. So use a **dedicated mailbox** whose address nobody knows.
- **🔒 Privacy** (⚙️ → App & info → Privacy, admins only): no camera, no photos, no barcode scanner, no AI cooking – so no photos and no AI requests leave your Home Assistant. The barcode lookup at Open Food Facts, 🏷️ Offers and refreshing product data are blocked too (enforced on the server, not only in the card). Only the **recipe import from a link** is **not** blocked – it only runs when you start it yourself. What goes where is listed in ⚙️ → Privacy.

### 🧹 Cleanup, simply explained
On cleanup day everything that has been open for at least 7 days (adjustable) gets **checked off**. Example Sunday: added on Tuesday → only 5 days old on the first Sunday, stays → checked off on the second Sunday. Each item shows 🧹 with its date. Nothing is deleted. **On/off**, day, time and minimum age: in the card under **⚙️ → Cleanup** (applies to everyone). When it is off, the 🧹 date below the items disappears too.

**🧽 Delete list (admins only):** under ⚙️ → Cleanup pick a store (or “All stores”), then **“Delete done items”** (only what is checked off) or **“Empty list”** (open and done – good on Sunday for the new week). A question with the number comes first. The **catalogue stays**: products still show up as suggestions while typing, photos, barcodes, notes and favourites stay. Cannot be undone.

**📊 Load display:** ⚙️ → “Resources” shows “📊 Load” at the bottom with changes per minute, packets sent and the size of one packet (also in the attributes of `sensor.einkaufsliste_gesundheit`).

**⚡ Less load:** many quick changes (e.g. ticking off several items in a row) are now bundled into **one** packet to cards and apps (at most every 0.3 seconds) instead of resending the whole list on every change. For load problems there is a diagnosis: the health sensor shows `aenderungen_gesamt`, `aenderungen_pro_minute`, `pakete_an_karten_gesamt` and `laufzeit_minuten` in its attributes. If `aenderungen_pro_minute` stays high, something keeps changing – please report it as an issue.

**🗂️ Own categories per store:** on a store's page (⚙️ → Stores) choose “All categories as everywhere” or “Own categories”. With “Own” you tick which categories exist in this store and can create a new one just for it. The list of that tab and the category picker then show only those; items from an unticked category show under “No category” there (the item's own category stays unchanged). Works together with the own category order.

**💣 Factory reset (admins only):** At the very bottom of ⚙️ → Cleanup, **“Factory reset – delete everything”** puts really everything back like a fresh install: list, catalogue, photos, stores, categories, people, recipes, loyalty cards, Grocy/to-do connections and all switches. Only the PIN stays. Two safety questions, **cannot be undone**.

**❓ Starting fresh after removing the integration:** Home Assistant does **not delete data** when you remove an integration – that is why everything (also products imported from Grocy) is still there after “remove, restart, reinstall”. Two ways: (1) use the **Factory reset** button before removing, or (2) after removing, delete the file `.storage/einkaufsliste.data` and the folder `einkaufsliste_fotos` in your config folder (stop or restart Home Assistant around it).

**🧹 Delete everything (admins only):** under ⚙️ → Cleanup, **“Delete catalogue & list completely”** deletes the shopping list and the whole catalogue with all photos, barcodes, nicknames, own notes, favourites and learned typos. Two safety questions, **cannot be undone** – make a backup first. Stores, categories, people, recipes, loyalty cards and settings stay.

### 📍 Nearest store first
Create a **zone** per store (Settings → Areas, labels & zones → Zones) and pick it in ⚙️ → Stores → tap the store → 📍. Several branches? Just pick several zones for the same store. Whoever shares their location via the companion app lands on the right tab in the store.

### 🗣️ Alexa & other lists
The shopping list can **empty another Home Assistant to-do list automatically**: everything that lands there moves over right away and is deleted there.

1. Set up the **“Alexa Devices”** integration in Home Assistant. The Alexa shopping list then shows up as a to-do list in HA.
2. In the card: **⚙️ → Data → Import & backup → From other apps → 🔁 Bring over automatically**, pick the Alexa list (and a store if you like), **Turn on**. 🔒 Only admins can turn it on or change it.
3. From now on: “Alexa, add milk to my shopping list” → milk is on the list, with “🔁 Alexa” as the one who added it.
4. **Pick how lists are matched:**
   - 🗑️ **Fetch & delete there** – Alexa is just the mailbox.
   - 🔗 **Keep on both** – on both lists; checking off (or removing in Alexa) happens on both sides.
   - 🔄 **Full sync** – like 🔗, and everything you add in the shopping list also goes to Alexa (“Milk (2 L)” – Alexa doesn't know stores, notes or photos). Then “Alexa, what's on my shopping list?” reads it all out. **Several lists with a store** (e.g. Bring! Lidl, Bring! Aldi): each one only gets the items of **its** store. A list without a store (“Anywhere”) gets the “Anywhere” items and everything from stores without their own list. Move an item to another store and it moves over there too.

   Honestly: if you rename something in Alexa, the list can't match it reliably – it may become a new entry.

This works with any to-do list in HA (Google Tasks, Bring!, Todoist, the HA shopping list …). Honestly: “Hey Google, …” writes to Google Keep, which has no official Home Assistant connection – so it doesn't work that way with Google.

### 🥫 Fetch products from Grocy
Using Grocy? You can bring your products into the catalogue: **⚙️ → Data → Import & backup → Grocy**. Type the address (e.g. `http://192.168.1.20:9283`) and the **API key** (in Grocy: user → *Manage API keys*), **Fetch products**, untick what should stay out in the preview, **Import**. What comes over: **name**, **barcodes** (only real digit barcodes) and the **product group** (becomes the category, created if you like). Stock, shelf life and locations stay out, and whatever already exists here is not overwritten. For the one-time fetch the key is **not stored**. 🔒 Admins only; Home Assistant must be able to reach Grocy.

**🔄 Continuous sync** (same tab, below): two parts, **each on or off on its own** – or both:
- 🛒 **Shopping list** (every 3 minutes): *Fetch & delete there* (the Grocy list stays empty, everything lands with you), *Keep on both* (what you tick off here disappears in Grocy; what is gone in Grocy gets ticked off here) or *Full sync* (your open items also go to Grocy). Shop and Grocy list number selectable.
- 📦 **New products** (every 1–24 hours): new Grocy products land in the catalogue by themselves – nothing is overwritten or deleted.

For this the API key is kept on the server (never on phones, never in backups). “Remove connection” deletes it again. *Note: so far built against Grocy's API description only, not a real Grocy – feedback welcome.*

### 📄 Catalogue from CSV
**⚙️ → Import & backup → From other apps → 📄 Catalogue from CSV or list** (admins only): a CSV or text file (or pasted lines) becomes **products in the catalogue** – not items on the shopping list. Columns `Name; Category; Barcode; Note`, with or without a header row (any order if there is a header). Separator `;` `,` or tab. The card tells you how many products it recognised before importing. Whatever already exists is not overwritten.

### 🤖 “What can I cook?” (with AI)
**⚙️ → Extras → AI cooking** (admin only, **off** by default): choose an **AI assistant from Home Assistant** (e.g. OpenAI, Google, Anthropic or local Ollama) and switch it on or off with **Turn on / Turn off** (the assistant stays remembered). Two fields (admin only) remember **“Always at home”** (salt, oil, flour … goes with every request) and **“Never suggest”** (allergies, dislikes); do not enter names of people. Then **Recipes** shows the button “What can I cook?” at the top left, next to the cooking times. Type ingredients – also things that are not in the catalogue – and optionally include the open items of the list. “👥 For … people” sets the number of people, and while typing you get catalogue suggestions (at most 2). For every suggestion: **Missing items to the list** or **Save as recipe**; tapping an ingredient moves it between “You have” and “Missing”. 🔒 The **ingredient names** go to the chosen assistant (cloud: over the internet, local: stays at home); with **Privacy** switched on nothing is sent. AI answers can be wrong. *Not tried against a real AI assistant yet – only tested with a stand-in.*

### 📝 Note templates
**⚙️ → Extras → Note templates**: small buttons under the ✏️ Own note field (“Organic”, “lactose-free”, “large pack” …). They only appear once you type the first letter and show only the matching ones; a tap replaces what you typed with the template. You maintain the texts yourself, for all devices.

### 🗣️ Siri / Shortcuts (iPhone)
In the Shortcuts app create a new shortcut, choose the Home Assistant app’s **“Call service”** action, service `einkaufsliste.add_item`, data `name: Milk` (set the name to “Ask each time”). Named “Shopping”, “Hey Siri, Shopping” is enough. To tick off use `einkaufsliste.check_item`. *Not tested on an iPhone; action names can differ slightly depending on the app version.*

### 🧾 Purchase log
Turn it on in **⚙️ → Extras → Purchase log** (applies to everyone, **off** by default). A **🧾 button** then appears at the top of the card (and one in the history). **➕ Add:** after shopping, enter store, amount and date – the list fills in **who** and **when**. **📊 Overview:** in total, **per store** and **per month**, with filters for **person**, **store** and **date** (quick buttons *This month / Last month / All*). Independent of the lists – the amount is entered by hand or read from a **receipt**: **📷 Read receipt** (photo) or **📄 Read PDF** (digital receipt as PDF). The card suggests **store, date and total**, you check and save; the PDF stays on the device. A PDF that is only an image is not read – photograph the receipt instead. Tested only with self-made sample receipts, so with real receipts the recognition can be off (hence the check). Everyone in the family sees everything; entered wrong → ✖. **🎉 Ask automatically (option):** in the same box you can switch on that the Add dialog opens by itself as soon as everything on the list is checked off (store already selected, applies to everyone). Turning it off only hides the display, the entries stay saved.

### 🏷️ Offers from the flyers (unofficial)
Turn it on in **⚙️ → Extras → Offers** (admins only): postal code, only certain stores if you like, how often to check (every 3–24 hours). If something on your list is on offer right now, the item gets a small **🏷️** at the front – tap or long-press → **Offers** shows store, price, old price and how long it's valid. **🛒 Buy here** creates the offer item at that store – with the offer's name and “🏷️ 1.19 € until Sat” in its **own field** (not in the note; “from Mon” if it starts later) – and checks off the original product. Items from offers are gone completely when checked off. When the offer ends, an item created by it is deleted 1 day later and your original product goes back on the list (offer on your own product: only the offer goes away) (store not on your list yet: add it or use “Anywhere”).

**🔀 Similar offers:** if there is no offer for exactly an item's name (barcode names are very precise, e.g. “UHT milk” or “Strawberry Max Balance”), the list splits the name into words (without numbers, quantities and filler words), searches them one by one and scores the hits by matched words; brand, product type from the database (only if it knows it), nicknames and your category help. At most 4 hits, marked **🔀** “Similar”. If there is one for exactly that item, only that is shown. A **red broom** on an item shows from one working day (Mon–Fri) before the automatic check-off that it's about to happen.

**Searching offers:** type the product at the top (e.g. “coffee”) → below the suggestions **🏷️ Show offers for “coffee”** → **➕ Add to list**. When an offer expires the item stays – only the offer price disappears, and **⌛ Offer over** shows for 1 day.

⚠️ **Honestly:** the offers come from **Marktguru**, but **unofficially** – without any agreement with Marktguru. The shopping list simply opens the Marktguru website the way your browser does (there's no access key in the code). This can **stop working at any time without warning**; then ⚙️ says “unavailable right now” and the list keeps running normally. Only the names of open items and your postal code are looked up. It's **off** by default.

### 📧 Onto the list by email
1. Create a **separate email address** just for the shopping list and set up the **“IMAP”** integration in Home Assistant with it.
2. In the card: **⚙️ → Data → Import & backup → 📧 Email**: pick the mailbox, a store if you like, what happens to the email afterwards (📬 leave · 👁️ mark as read · 🗑️ delete), enter the **allowed senders** (at least one), **Turn on**. 🔒 Admins only.
3. Send an email to that address – **one item per line** (“milk”, “6 eggs” …). Several in one line work too: “milk, butter, bread”. Greetings (“Hi …”, “Best regards”), signatures, quotes, “Sent from my iPhone” and whole sentences are skipped, quantities are recognized. If the email arrives without line breaks (some phone mail apps), the list fetches it again properly from the mailbox. The history shows 📧.
4. **Send the store along:** a store in the **subject** (“Aldi”, “Shopping at Aldi”) puts everything there. Or use a **heading** in the email: `Aldi:` – the things below – then `DM:` … Also in one line: `Netto: milk, bread`. Unknown names go to the chosen store.

Honestly: senders can be faked – so use an address that isn't public. Depending on the mailbox it takes a few seconds to minutes until an email arrives. Only emails that actually put something on the list are marked as read or deleted – others stay. With Gmail, “delete” may mean “archive” depending on your settings.

---

## 🎛️ Card options

Everything works in the visual editor. For YAML fans:

| Option | Default | What it does |
|---|---|---|
| `store` | `all` | `all` = all stores with tabs, or one store only |
| `show_title` | `true` | `false` hides the cart icon (guide) at the top – the mascot 🛒😊 is hidden too |
| `show_added_by` | `true` | show who added an item |
| `added_by_style` | `name` | `name`, `first` or `initials` |
| `show_checked` | `true` | show the “Done” section |
| `show_dates` | `true` | show “since Tue” and the 🧹 date |
| `show_recipes` | `true` | show the chef's hat |
| `show_settings` | `true` | show the gear (e.g. off for a kids' tablet) |
| `compact` | `false` | smaller rows without extra info |
| `auto_store` | `true` | jump to the store you are at |
| `language` | `auto` | `auto` = like Home Assistant, `de` or `en` |

---

## 🤖 For automations

| Entity | What it shows |
|---|---|
| `sensor.einkaufsliste_offene_artikel` | all open items (attributes per store, items, checked, next cleanup) |
| `sensor.einkaufsliste_<store>` | one sensor **per store**: open items there, attribute `artikel` |
| `binary_sensor.einkaufsliste_etwas_zu_kaufen` (English HA: `…_something_to_buy`) | on as soon as anything is open |
| `sensor.einkaufsliste_zuletzt_eingetragen` (English HA: `…_last_added`) | last added item with `von` (who), `wann` (when), `geschaeft` (store) |

| Action | What happens |
|---|---|
| `einkaufsliste.add_item` | puts an item on the list (`name`, optional `store`, `category`, `quantity`, `note`, `for_whom`, `added_by`) |
| `einkaufsliste.add_recipe` | puts all ingredients of a recipe on the list (`name`) |
| `einkaufsliste.check_item` | checks an item off (`name`, optional `store`) |
| `einkaufsliste.remove_item` | deletes an item (`name`, optional `store`) |
| `einkaufsliste.cleanup` | cleans up now; `force: true` checks off everything |

Events: `einkaufsliste_item_added`, `einkaufsliste_cleanup`.

```yaml
# Example: message when you arrive at Aldi and something is on the list there
triggers:
  - trigger: zone
    entity_id: person.anna
    zone: zone.aldi
    event: enter
conditions:
  - condition: numeric_state
    entity_id: sensor.einkaufsliste_aldi
    above: 0
actions:
  - action: notify.mobile_app_annas_phone
    data:
      message: "🛒 There are {{ states('sensor.einkaufsliste_aldi') }} things on the list at Aldi"
```

---

## ❓ FAQ

**Where is the data stored?** Locally in Home Assistant (`/config/.storage/einkaufsliste.data`, photos in `/config/einkaufsliste_fotos`). No cloud. Your HA backups include it; ⚙️ → Data → Import & backup gives you an extra .zip.

**The card says “Integration not set up”.** Then step 4 of the installation is missing.

**Why are my categories German?** The integration was set up while Home Assistant was in German. Just rename them in ⚙️ → Categories – the guessing works by keywords in the category name (e.g. “Dairy”, “Frozen”, “Drinks”).

**Can I add store brands or category words for my country?** Yes, without programming: both live in their own files under `custom_components/einkaufsliste/data/` – `eigenmarken.json` (country as set in HA → chain → brands; unknown country = all combined) and `kategorien.json` (keywords in the category name + products per language, e.g. `de`, `en`, `nl`). Add yours and send a pull request 🙏

---

## 💙 Do you like the shopping list?

It is and stays **free**. If you like, you can send me a small donation via PayPal – completely voluntary: [paypal.me/MarcoStrickmann](https://paypal.me/MarcoStrickmann). The link is also under ⚙️ → Credits. Thank you! 🙏

[![PayPal](https://img.shields.io/badge/PayPal-Donate-0070BA?logo=paypal&logoColor=white)](https://paypal.me/MarcoStrickmann)

## 💡 Ideas, wishes and bugs

- **An idea or a wish?** Post it in the [Discussions](https://github.com/misterm2310/einkaufslisten-card/discussions) (category **Ideas**). Anyone can agree with 👍 and join in. **Polls** run there too.
- **Something not working?** Open an [issue](https://github.com/misterm2310/einkaufslisten-card/issues). Helpful: your version (under ⚙️ → Credits), what you did and what happened. The **🐞 Error log** (⚙️ → Health) often has the answer already; it can be copied with one tap.

---

## 🧪 For developers

**Adding store brands and the category dictionary – without programming:** both live in their own files under `custom_components/einkaufsliste/data/`:
- `eigenmarken.json` – by country (`DE`, `AT`, `CH` …, as set in HA under Settings → System → General) → chain → brands. Unknown country = all combined.
- `kategorien.json` – per category the keywords in the category name (`match`) and the products per language (`words`: `de`, `en`, `nl`, `fr` … are welcome).

Just add yours and send a pull request 🙏

```bash
pip install -r requirements_test.txt
pytest
```

---

License: MIT · Product data: [Open Food Facts](https://world.openfoodfacts.org) (ODbL) · Offline app icons: [Material Design Icons](https://pictogrammers.com) (Apache 2.0) · Offline app barcode reader: [ZXing-js](https://github.com/zxing-js/library) (Apache 2.0)
