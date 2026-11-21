# Dynamic Canvas Engine (DCE) — VierApparatus

A **local-first programmatic design studio**: draw a template once, bind its elements to fields of a content
database, and render hundreds or thousands of unique graphics in the background — packaged as a ZIP.

No backend, no account, no telemetry. Everything (records, templates, images, fonts, batch history) lives in the
browser's IndexedDB. After the first load the app also reloads offline (service worker caches the app shell).

```
Templates ──design──▶ .njs  ◀──bind──  Content Plan (records, custom fields, relations)
                        │                       │
                        └──────── Batch Runner ─┘  filter · select · format · size · file names
                                       │
                         worker pool (OffscreenCanvas) ─▶ PNG / JPEG / SVG / PDF / HTML ─▶ ZIP (+ manifest.json)
```

## Install it like a normal program (Windows)

Download / copy **`Dynamic-Canvas-Engine-Setup-<version>.exe`** (built into `C:\Users\<you>\DCE-release`, outside the project folder on purpose - see below), double-click it, read the Terms and the MIT licence and click **I Agree**
(the installer cannot continue without it), choose who it is for and a folder, finish. You get a desktop shortcut and a Start-menu entry with the
VierApparatus icon, and the app starts with one click — **no `npm`, no browser tab, no relay command**. It works fully offline;
only Buffer, Gemini and reading the websites you add need the internet; the local relay that does this is built in and starts by itself.

* Data lives in `%APPDATA%\Dynamic Canvas Engine` (Help → *Open the data folder*). Uninstalling does **not** delete it.
* The installer is unsigned, so Windows SmartScreen shows "unknown publisher" (More info → Run anyway). Removing that warning
  needs a paid code-signing certificate; see "Releasing" below.
* Only one copy can run at a time; the app uses 127.0.0.1 port 47625 (its private address — keeps your data in one place) and 8788 (relay).

### Building the installer yourself

```bash
npm install
npm run dist:win     # builds the web app, prepares the licence page, packs ~/DCE-release/Dynamic-Canvas-Engine-Setup-<version>.exe (override with DCE_OUT)
npm run desktop      # run the desktop app straight from source (no installer)
npm run icons        # re-create build/icon.ico from public/icon.svg (only if the icon changes)
node tests/e2e/desktop.mjs   # smoke-test the packaged app (uses a throw-away data folder)
```

### Releasing / updating later

1. Change `version` in `package.json`, run `npm run dist:win`, run `node tests/e2e/desktop.mjs`.
2. Upload the `.exe` (for example as a GitHub Release) and publish its SHA-256 (`certutil -hashfile <file> SHA256`).
3. Users install the new version over the old one; their data is kept.
4. Optional: code signing (an Authenticode certificate) removes the SmartScreen warning; add it in the `win` section of
   `package.json` (electron-builder docs: "Code Signing"). Auto-update is not built in.

### Credits, licence and terms

Concept and product requirements (PRD): **Muhammad Satrio**. Free and open source under the MIT licence (`LICENSE`).
`TERMS.txt` is shown on the installer's licence page (must be accepted) and in Settings → About: provided as is, no warranty,
no responsibility for anything that happens during installation or use, check your system requirements first. The brand
names / logos are not covered by the MIT licence. *This is a general-purpose template, not legal advice — have a lawyer
review it if you need certainty for your country.*

## Run it

```bash
npm install
npm run dev          # http://localhost:5173 (development)
npm run build        # type-check + production build into dist/
npm run preview      # serve dist/ on :4173
npm test             # 99 unit tests (engine, data layer, document model, content pipeline, relay)
npm run e2e          # drives dist/ in real Chromium (run `npm run build` first) — see "Testing"
npm run relay        # local relay for Buffer + page reading (see "Connections & automations" and "Content pipeline")
npm run bench        # real-browser benchmarks → tests/perf/out/results.json
```

Requires Node 20+. The first start opens a **sample workspace**: a fictional scientific-equipment catalogue
(6 records, 8 images, a 1080×1080 "Product Announcement" template with data bindings and a working batch
configuration). Settings → *Remove sample data* deletes it; *Restore sample data* brings it back.

## What is in the box

| Module | What it does |
|---|---|
| **Templates / Editor** | WYSIWYG vector editor on Fabric.js 6: rectangle, ellipse, line, polygon, star, text, image, image frame, pen with **Bézier curves** (click = corner, click-and-drag = smooth curve) and a point editor (drag points and handles, double-click a point to switch corner ⇄ smooth, double-click the line to add a point, Delete removes, Alt+drag breaks handle symmetry); layers panel with drag-and-drop ordering, rename, lock, hide, group / ungroup; multi-select, align / distribute, snap-to-grid + alignment guides, zoom / pan / fit, undo / redo (120 steps), copy / paste / duplicate, keyboard shortcuts (Help ⓘ in the top bar lists them), direct text editing (double-click), `.njs` import / export. |
| **Data binding** | Text templates `{{content.title\|upper}}`, image binding, fill-colour binding, visibility conditions (`exists(content.discount)`), per-binding fallbacks, template variables (`template.primary_color`), placeholder schema (label, type, required, default, max length). Bound elements are marked on the canvas; *Data preview* shows a real record; *Output preview* shows the exact batch output. |
| **Layout constraints** | A live **"how much fits"** estimate (characters / words for the current font, size, spacing and frame, plus the auto-shrink range) and the real fit for the preview record. Max characters / lines, min / max font size, fallback text, overflow policies **truncate · auto-shrink · multi-line · expand · hide**; image fit **cover · contain · fill · crop**, focal point, fallback image, missing-image behaviour (hide / placeholder / fail the record). |
| **Content Plan** | Spreadsheet-style virtualised grid (only visible rows are in the DOM): one click selects a cell (shift-click / drag for a range, arrow keys, Enter edits), **Ctrl+C / Ctrl+V exchange tab-separated data with Excel, Google Sheets and LibreOffice** (type-checked on paste; rows past the end create records after confirmation), right-click menu, ⤢ button opens the detail panel, inline editing, column resize / visibility, sort, search, AND/OR filter builder, bulk select + bulk update, custom fields (12 types), CSV / JSON import wizard (map → validate → confirm, bad rows reported not imported), CSV / JSON export, detail drawer with Markdown editor + sanitised preview + live design preview, relations to assets and templates. |
| **Assets** | Upload / drag-and-drop / import from URL, SVG is rasterised, thumbnails generated at import (the grid never decodes full-size images), dimensions, aspect, size, tags, categories, search, "used by" lists, delete with impact warning. |
| **Batch Runner** | Template + filter + record selection (all filtered / selected / range / single) + format + size + file-name pattern → bounded worker pool → streaming ZIP. Real progress, throughput, ETA, pause / resume / cancel (partial ZIP kept), history, failed-record inspector and **retry only the failures**. |
| **External bundle** | `dce-render-bundle/` with `template.njs`, `data.json`, `assets/`, `render.py` (Pillow), README — for servers / very large jobs. |
| **Render plugins** | Build-time extension point (`src/engine/plugins.ts`): a `plugin` node names a registered plugin and carries its parameters; ships with a *Progress bar* example. Plugins are TypeScript registered at start-up — templates and data files can never inject code. |
| **Tables** | Beyond the Content Plan you can create any number of tables (sidebar → *New table*) with the same grid, copy / paste, filters and exports. Field types like Airtable: single / long text, Markdown, number, currency, percent, rating, checkbox, date, date & time, single / multi select, email, phone, URL, image, **link to another table**, **synced field**, created time, last-modified time, auto number, JSON. Add fields with the **+** at the end of the header; right-click a header to sort, hide, edit or delete. |
| **Connections** | Settings → Connections: a Gemini API key and several Buffer accounts, each with encrypted properties (`BUFFER_API_KEY`, `BUFFER_CHANNEL_ID_INSTAGRAM`, …); a picker switches the active account. Values are hidden — double-click or right-click to reveal / copy / replace / delete. |
| **Automations** | If / then rules like Airtable: *when a record matches these conditions* → *create a Buffer post* (text from fields, optional image URL) → *publish in the next queue slot, N minutes / hours / days later, or at the date & time stored in a field* → *set Status = Posted and store the post id*. Dry run, run-now, per-record history, pause-all. |
| **Content pipeline** | Daily, hands-off social posting from public web pages: your websites (add / delete any, e.g. vierapparatus.com) → one unused page per run → post written by **Gemini** → rule check + second-model fact check → simulate, hold for approval, or schedule in **Buffer** (with the page image). Run log, retries, alerts, dashboard, exports. See "Content pipeline". |
| **Settings** | Storage use, sample data, fonts (import WOFF2 / TTF / OTF, or add a Google font once and keep it offline), erase-all. |

## Architecture

```
src/
  engine/        DOM-free, shared by editor · main-thread previews · batch workers
    types.ts njs.ts        .njs schema, zod validation, migrations, round-trip
    expr.ts binding.ts     safe expression language (no eval) · {{token|filter}} · file-name patterns
    textfit.ts             measure → wrap → shrink / truncate / expand / hide (memoised)
    scene.ts               document + record → resolved drawable items (+ issues, never throws)
    draw.ts svg.ts pdf.ts  Canvas2D · SVG · minimal PDF writer
    render.ts fonts.ts     OffscreenCanvas pipeline, PNG/JPEG/SVG/HTML, font loading
  editor/        Fabric layer (DceObject), controller (history, tools, snapping), model.ts (pure doc ops), panels
  db/            Dexie schema, repo (records store, templates, assets), filter engine, CSV/JSON importer, seed
  batch/         runner (worker pool, ZIP, retry), bundle exporter, render.py source
  workers/       render.worker.ts
  pages/ ui/     Content Plan, Templates, Assets, Batch, Settings · design system components
tests/           unit (vitest) · e2e (Playwright, real Chromium) · perf (benchmarks)
```

**One renderer.** `scene.ts` turns *(template, record)* into resolved items; `draw.ts` paints them. The editor's only
Fabric class, `DceObject`, calls exactly the same `buildItem` + `drawItemLocal`, so what you see on the canvas is the
batch output — not an approximation built from Fabric's own text and shapes. Fabric supplies selection, handles,
rotation and hit-testing only. Fabric objects are never serialised; `.njs` is the persisted truth.

**Deterministic.** Same template + same data + same options → identical bytes (verified: exporting and re-importing a
template and rendering both gives the same result; unit tests assert identical SVG).

**Memory.** Workers decode an image only when needed and keep ≤ 24 bitmaps; the shared canvas is reused; results are
transferred (not copied); finished ZIP chunks are folded into Blobs so the JS heap stays flat; the PDF reorder buffer is
bounded; *Stream ZIP to disk* (File System Access API) avoids holding the archive at all.

## The `.njs` format

```jsonc
{
  "format": "vierapparatus-dce", "version": "1.0.0",
  "meta":   { "id": "…", "name": "Product Announcement", "author": "VierApparatus", "created_at": "…", "updated_at": "…" },
  "canvas": { "width": 1080, "height": 1080, "background": "#FFFFFF" },
  "placeholders": [ { "key": "content.title", "type": "text", "label": "Product Title", "required": true,
                      "max_length": 60, "overflow_strategy": "auto_shrink", "min_font_size": 28 } ],
  "nodes": [ { "id": "…", "type": "text", "name": "Title", "x": 56, "y": 236, "width": 440, "height": 190,
               "rotation": 0, "visible": true, "locked": false, "opacity": 1, "layer": 6,
               "style": { "fontFamily": "Jost", "fontSize": 64, "fontWeight": 600, "fill": "#231F20" },
               "binding": { "text": { "template": "{{content.title}}", "fallback": "Product name" } },
               "constraints": { "overflow": "auto_shrink", "minFontSize": 28, "maxLines": 3, "maxChars": 60 } } ],
  "assets": [ { "id": "…", "name": "logo.png", "mime": "image/png", "data": "data:image/png;base64,…" } ],
  "constraints": { "snapGrid": 10, "palette": ["#4570B6", "#CAEBFB", "#231F20", "#FFFFFF"] }
}
```

* Node types: `rect ellipse line text image polygon star frame path group`. Groups nest children (absolute coordinates).
* Validation (zod) on every import, with readable messages; duplicate ids are repaired; unknown properties at every level
  are **preserved** (round-trip tested); a newer *major* version is refused, a newer minor/patch is accepted with a warning.
* Migrations are a registered list (`MIGRATIONS`); the `0.9.0 → 1.0.0` entry exists to exercise the mechanism (a synthetic
  pre-release layout) and is covered by a test. Real files are written as 1.0.0.
* Exported `.njs` files embed referenced assets as data URIs (≤ 12 MB), so a template moves between machines complete.

## Tables, links and synced fields

* A **link** field connects records of two tables and is two-sided: linking A → B also fills the matching field in B (created for you).
* A **synced field** mirrors a field of the linked record (`Link field → Source field`). It has the source's type, so filters, sorting,
  exports and template bindings treat it like any other field. Change the source in table A and the copy in table B follows; edit the
  copy in B and the source in A changes (and every other mirror with it). With several linked records the first one is mirrored.
* Deleting a link / source field lists what depends on it and removes those fields too. Deleting a record unlinks it everywhere.
* All writes (typing, paste, bulk edit, automations) go through one path (`db/tables.ts` → pure `db/links.ts`), covered by unit tests.

## Connections & automations (Buffer)

**Encryption.** API keys and channel ids are encrypted with AES-256-GCM (Web Crypto) before they are stored; the key is a
*non-extractable* `CryptoKey` kept in a separate IndexedDB (`dce-vault`), so neither the app nor a database export can read it.
Screens never receive plain text: values are masked and decrypted only when you reveal one (15 s) or when a post is sent.
*Honest limits:* this stops casual viewing, screenshots, database dumps and backups; it does **not** stop malware or a malicious
extension running inside the same browser profile, and clearing site data destroys the vault key (re-enter the keys).

**Why a relay.** `api.buffer.com` sends no CORS headers (verified), so a browser page cannot call it. `npm run relay` starts
`server/relay.mjs` — ~60 lines, no dependencies — on `127.0.0.1:8788`. It forwards `POST /buffer` to the fixed upstream only,
allows CORS only for `localhost` / `127.0.0.1` origins, never stores or logs keys, and caps bodies at 1 MB. The key travels
browser → relay (loopback) → Buffer in an `Authorization: Bearer` header.

**How an automation behaves.**
1. *A record fires once when it starts matching.* If it stops matching and matches again, it fires again.
2. The post is created in Buffer immediately with its publish time (`customScheduled` + `dueAt`, or `addToQueue`), so Buffer
   publishes on time even if DCE is closed afterwards. Date-only values mean 09:00 local time; a time already in the past is
   skipped (logged) unless you choose "add to the queue".
3. Failures are logged with Buffer's message and retried after 2 minutes, at most 3 times.
4. Enabling an automation asks what to do with records that **already** match (send them too / only new matches) — never an
   accidental burst. *Dry run* shows exactly what would be sent. *Pause all* stops everything.
5. Matching is evaluated while DCE is open (at start-up it catches up, then every 20 s and 1.5 s after any change).
6. Images: Buffer fetches them itself, so the image field must hold a **public https:// URL**; local assets cannot be uploaded.

## Content pipeline (website page → Gemini → checks → Buffer)

This answers the "AI Automation Candidate Assessment" (daily social post from a website) **without n8n or Make**: the scheduler,
the run log, the retry rules, the approval queue and the Buffer delivery are DCE's own automation engine. Open **Content pipeline**
in the sidebar.

```
sitemap / RSS ──▶ pick ONE unused page ──▶ read it politely ──▶ Gemini writes the post ──▶ rule check ──▶ 2nd-model fact check
 (relay /fetch)   (never a URL twice)      (robots.txt, ≤1/s)    hook · 2–4 lines · CTA     (6 rules)        (fails closed)
                                                                  · link · 3–5 hashtags
        ──▶ Simulation (nothing sent) │ Approval (you click Approve) │ Auto-publish ──▶ Buffer (+ image) ──▶ run log · alerts
```

**First-time setup (5 minutes, no environment variables — everything is in the app)**
1. *Settings → Gemini*: paste a free key from Google AI Studio (aistudio.google.com → Get API key). It is stored encrypted like the Buffer keys. *Test key & list models* proves it works.
2. *Settings → Connections*: add your Buffer account + key, *Test connection & list channels*, *Add all as properties* (only needed for Approval / Auto).
3. *Content pipeline → Sources*: **vierapparatus.com** and the PlacidWay assessment source are pre-filled. **Delete either one, add any other website** with *Add website* (address, optional sitemap / feed, "only addresses containing …"). *Check* reads the sitemap and shows how many pages qualify (no AI used).
4. *Overview*: choose the mode, tick a **test channel or a Page you own**, press **Run now**. Open the *Posts* tab to read the result. Turn on the *Daily schedule* when you are happy.

**Watching and stopping a run.** While a run goes, its current stage and a timestamped log are shown at the top of the Overview page, and as a banner on every other page, so leaving a page never hides it. *Stop run* (on the banner, the Overview or the Run log) cancels it at once, including a Gemini or page request that is still waiting. A stopped run is recorded as *stopped by you* and is not retried that day. Stop cannot take back a request that has already reached Buffer: it takes effect before that point. A run that was still going when the app was closed shows as *interrupted*. Gemini calls time out after 2 minutes, page reads after 40 seconds, and a run with no progress for 45 seconds says so.

**Buffer channels.** The checklist is read from your Buffer account. Every channel is shown by service and name (for example *LinkedIn · Vier Apparatus*), the account is checked when the page opens, and *Refresh from Buffer* checks again. A channel new in Buffer is saved automatically, with its id encrypted. A saved channel that Buffer no longer returns is flagged and can be removed. A channel that was saved by hand with the same id is recognised and is never added twice.

**Sync to a table.** On the Posts tab, pick a table or create *Social posts*. Each post becomes one row whose id is the post id: it is written when the post is made, updated when its status changes, and synced again after every run, approval, rejection and edit. The pipeline's columns (Title, Source, Source URL, Status, Post text, Channels, Details, Model, Created, Buffer post id) are rewritten each time; any column you add to that table is kept. The sync is one-way: edits you make to the pipeline's columns are overwritten by the next sync. Deleting a post record also removes its row.

**What Gemini receives and what it writes.** Gemini never sees the sitemap and never browses. For each run the app reads one page and sends Gemini only that page's title, description and the first ~6,000 characters of its readable text, plus the instructions. Gemini returns JSON (hook, 2–4 short lines, a call to action, 3–5 hashtags). The app adds the link itself and joins the parts into one text. Buffer posts that text to every ticked channel, so a ticked LinkedIn channel receives the same text. Illustration only — written by hand from the real text of one VierApparatus article, **not** Gemini output (no live Gemini call has been made yet):

```
How much does it take to stop bacteria from growing?

Scientists answer this with the minimum inhibitory concentration (MIC).
MIC is the lowest tested concentration that stops visible growth under set lab conditions.
It is used in microbiology, medicine and antibiotic-resistance research.

Read the full guide to see how MIC is measured.
https://vierapparatus.com/articles/what-is-minimum-inhibitory-concentration-mic

#Microbiology #Science #AntibioticResistance
```

**Mapping to the assessment**

| Requirement | How it is done |
|---|---|
| Daily trigger + manual run | *Daily schedule* (time of day) and **Run now**. Runs while DCE is open; if it was closed at that time the run happens when you open it. |
| Extract title / URL / summary / body / image | The site's **sitemap** (or RSS / Atom) lists pages; the chosen page's Open Graph tags + readable paragraphs give title, description, image and body (`src/pipeline/extract.ts`). *Why this way:* a sitemap is the site's own machine-readable page list with change dates — one request, no CSS selectors to rot, no pagination, no JavaScript rendering, and it is what sites invite crawlers to use. Scraping listing pages is the fallback this tool deliberately avoids. |
| One item per run, never the same URL twice | Every page that became a post (sent / pending / rejected / simulated) is stored with its normalised URL (no `#`, no `utm_*`, no trailing slash). Newest unused page first; with several sources they take turns; a different site section than the last post is preferred (variety). |
| Post format | Gemini returns JSON `{hook, lines[2–4], cta, hashtags[3–5]}`; the **link is added by code**, never typed by the model, so it cannot be wrong or invented. Hook + lines + CTA must be ≤ 500 characters (setting). |
| Guardrails | **Layer 1 — rules** (instant, free, deterministic): structure, length, hashtag count, exactly one link and it is the source URL, **no medical-claim / outcome-promise wording** (editable phrase list: cure, guaranteed, risk-free, 100%, best results …), and **every number or price must appear in the source page**. **Layer 2 — a separate Gemini call** that sees only the page and the finished post and answers "is every statement supported, any medical claim or promise?". Failed drafts go back to the writer with the exact reasons (up to 3 drafts). If the reviewer cannot answer, the post is **not** published (fail closed). *Why two layers:* rules catch what must never happen, deterministically; the model catches subtle unsupported claims that no phrase list can. |
| Publish / schedule with image | Buffer `createPost` through the relay: next queue slot or a fixed time of day, with the page's `og:image` when it is a public https URL. Several channels can be ticked (cross-post, e.g. Facebook + LinkedIn; Instagram is skipped when the page has no image). |
| Auto vs approval | *Simulation* (default), *Approval* (post waits on the Posts tab; edit → rules re-run → **Approve & send**), *Auto-publish*. A source can be marked **Simulation only** — it is never sent anywhere, in any mode. Buffer's public API documents no draft mode, so "approval" is implemented in DCE: nothing reaches Buffer until you approve. |
| Run log | *Run log* tab: every run (scheduled, manual, retry) with source, page, post text, Buffer post id, result and a step-by-step trace. |
| Retries + alerts | Gemini quota / outage: 2 s → 6 s → 15 s back-off. Site down: 3 s → 8 s. A failed *scheduled* run is retried after 5 minutes, at most 3 attempts a day. Bad key / expired Buffer token / robots block are **not** retried. The alert is a banner on the page, a red dot in the sidebar and a desktop notification, and says what to do. |
| robots.txt, ≤ 1 request/second, public pages only | Enforced by the relay's `/fetch` (`server/relay-core.cjs`), not by trust: robots.txt is fetched and obeyed (longest match, `Allow`/`Disallow`, `*`, `$`, `Crawl-delay`; a 5xx on robots.txt = do not read), a host may be read only if it is one of your sources (re-checked on every redirect), a hard 1.1 s gap between two requests to the same host, local / private addresses are refused at connect time, 3 MB / 15 s caps, text types only. Covered by unit tests and an e2e that proves a disallowed page is never requested. |
| Never post to PlacidWay | Posts go only to Buffer channels **you** chose. The PlacidWay source is *Simulation only* by default and cannot be sent anywhere until you switch that off. |
| Dashboard / stretch | *Overview* tiles and the *Posts* tab list pending / sent / simulated / rejected / failed. Variety (section rotation, source rotation) and cross-posting are built. **Engagement read-back is not implemented** (Buffer's metrics are for personal API keys only and their query shape is undocumented in the public guide). |

**Deliverables.** *Posts → Export workflow (.json)* writes the pipeline settings and sources (no keys). *Posts → Export posts (.md)* writes
every generated post with its real source URL and the checks it passed — run the pipeline in **Simulation** on the two sources to produce
the three sample posts without publishing anything. The README you are reading is the setup / architecture document; the screen recording is
yours to make (Run now → Posts tab → Approve in Buffer test channel).

**Privacy and honesty.** The text of the page being promoted is sent to Google's Gemini API to write the post (on the free tier Google may use
such content to improve its products — use sources you are happy to share). Only the page text goes — never your keys, records or other data.
Tested with mock Gemini / Buffer / website servers and the real relay and app (`tests/e2e/pipeline.mjs`, 22 checks); the read side was also run
against the live sitemaps of vierapparatus.com and placidway.com (read-only). **Not exercised: a live Gemini call and a live Buffer account** — run
*Test key* and a Simulation run first.

## Website connector (VierApparatus admin ↔ DCE)

The website's **Master Admin → Website connector** page and DCE talk through a generic HTTP connection. Nothing on this
computer is opened to the internet: DCE asks the website for new items over outgoing HTTPS, every 60 seconds while the app is
open (or at once with *Check now*). The website never calls DCE.

**One place: Automations.** Website events and table rules are the same kind of automation, shown in one list (sidebar →
*Automations*, Airtable-style). An automation is **When** something happens, then **Then** its actions run in order for that
item. The triggers are a table record that matches its conditions, or an event a connected website reports. Each action starts
with its **connection**, and the actions offered follow from that connection:
* **Buffer** → create a post (channel, text with `{{field}}`, image, timing).
* **Gemini** → ask Gemini and fill columns (a prompt with `{{column|what to write}}`, written into a table).
* **An API** → send a request (method, path, body with `{{field}}`, and optionally store the answer in a field).
* **Content pipeline** → write and check a post with the pipeline settings.
* **This app's tables** → add or update a row, set a field, sync posts, render with a template.

When a connection is tested, DCE records what it allows: a website token's permissions, an API's published operations (OpenAPI,
if it publishes one), the Buffer channels and the Gemini models. Anything a connection does not allow is shown but cannot be
chosen, with the reason. Every run is in one history list, step by step.

*Webhooks:* DCE runs on your computer without an open port, so it cannot receive requests from the internet by itself. It can
call any service (the send-a-request action), and it receives the website's events by asking the website every 60 seconds. A
service that must call DCE directly needs a public address, for example a webhook on the website that queues events for DCE.
That is not built yet.

**Setup**
1. *Website:* sign in as the owner (Master Admin) → **Website connector** → create a token with the permissions
   `events:read` and `jobs:run`. The token (`vca_…`) is shown **once**; the website keeps only its hash. Revoke it there at any time.
2. *DCE:* *Settings → Websites and HTTP connections* → add a website: its address (for example `https://vierapparatus.com`),
   the token, *Save*, then *Test connection*. It reports which permissions the token has and names any that are missing.
3. *DCE:* *Automations* → *New automation* → a preset: a website article is published, a website product is reviewed or
   published, or a record's Status becomes "Ready to post". The preset fills in the connections you have set up (and a template
   for the render step, if you pick one). It stays off until you turn it on.

**What happens for a website event.** Each new website event (article published, product published, product reviewed) runs the
automation's actions in order, for that one item: write the social post (the Content pipeline's text, in the mode set on that
page; Simulation by default), add a row to a table, let Gemini fill columns from the prompt, sync the posts to a table, render
the row with a template. A failed action stops the item, and the history shows which action and why. Running the same item again
updates the same row, and a page that already has a post is not posted twice (its run is marked *skipped*).

**Prompts with placeholders.** A Gemini step reads `{{column|description}}` placeholders in its prompt. Each placeholder becomes
a column of the table and Gemini returns one value for each. An answer that is not the expected JSON, or that leaves one value
empty, writes nothing. Example: `Write {{summary|two short sentences in plain English}} and a {{hook|one line}}.`

**Jobs from the website.** The Website connector page can send two jobs: *Write a social post* (run the Content pipeline for one
event) and *Send to DCE now* (replay an event through its automations). DCE takes up to five jobs per check and reports each
result, or the reason it failed, back to the website.

**Limits and safety**
* Requests go through the local helper (`POST /http`), which reaches only the connection's own address, over https, never
  follows redirects and refuses private or local addresses. Plain http is accepted only for `127.0.0.1` / `localhost` (testing).
* One check runs at a time per connection: a check started while one is running joins it.
* Each check reads at most 50 events and takes at most 5 jobs.
* Tokens, the Gemini key and the Buffer keys are encrypted like every other secret.

**Tested, not exercised live.** `tests/e2e/website.mjs` (7 checks) runs the real app and the real relay against a mock website
and a mock Gemini server: the connection and its permissions, a preset automation, an article event → post, row, Gemini fill,
sync and render, a second check that repeats nothing, and the history with each step. `tests/unit/connector.test.ts` (15 tests) covers the
placeholders, the Gemini answer check, event reading and the HTTP helper's rules. **Not exercised: the live VierApparatus site,
a live Gemini key and a live social account.**

## Tables: master fields, carousels, synced marks, cloud destinations, asset tools (1.7.0)

**Master Field.** Every table names its records with one field, its Master Field. By default it is the leftmost field. Right-click another field's header and choose **Set as Master Field**: that field moves to the first column and stays in view while you scroll sideways. A synced field cannot be the Master Field, and the Master Field cannot be turned into a synced field. Other tables show a record by its Master Field when they link to it.

**Synced fields.** A ⚡ mark sits beside each synced field's name. Hover over it for `Linked to: Table name → Field name`. The sidebar marks tables that contain synced fields.

**Carousel tables.** *New table → Carousel table*: choose the source table, the field that holds each image's URL, and how many consecutive images make one carousel (1–3 … 1–20, or a custom number). DCE then creates a separate table with one record per carousel, named by its Master Field ("Carousel 1", "Carousel 2" …). Its *Carousel* field holds the URLs of that carousel, comma separated, ready for Buffer. Two fields are added to the source table: **Carousel Page** (shows `Page N of Carousel M`, read from the carousel's Master Field, so a rename shows at once) and **Page number**.
* With 100 images and 10 per carousel there are exactly 10 carousel records; the source keeps its 100 records.
* When images are added, changed or removed, the carousels are rebuilt from the source. A carousel with no image left is removed. The carousel records keep their ids, so nothing is duplicated, and any custom fields you add to a carousel table are kept.
* A record without a URL is not part of any carousel. The last carousel may hold fewer images.
* Order: the order in which the source records were created.

**Batch Runner destinations.** In the *Where the files go* panel, choose one of:
* **Download ZIP only** (as before).
* **Upload to Cloudflare R2.** Add the bucket under *Settings → Cloud destinations*: the S3 endpoint, the bucket, the public address (`https://pub-….r2.dev` or your own domain; without it the links would not open), an optional folder inside the bucket, and an access key id and secret with *Object Read & Write*. Uploads are signed (AWS Signature Version 4) and sent through the local relay.
* **Upload to a Google Drive folder.** In Google Cloud, create an OAuth client of type *Desktop app* and enable the Google Drive API. Under *Settings → Cloud destinations*, enter its client ID and secret and press *Connect*: your browser opens Google's sign-in, which returns to this computer. DCE asks for the `drive` scope, which is needed to upload into folders you did not create. Then give the folder: paste its link (or id) and press *Check folder*, or browse your folders.

For either destination, the link of every file is written into the **Uploaded link** field (a URL field, created when it is missing) of the record it belongs to, in the table you choose. Files are sent one at a time. A file with the same name in the folder is replaced, not duplicated. A problem is counted against its record with its reason: the upload failed, the file is online but its link could not be written, or the record is not in the chosen table. Retrying failed records re-renders them to ZIP only.

**Asset tools.**
* **Remove background** (images in *Assets*): the background is the colour of the image's border; pixels of that colour connected to the border become transparent, with a soft edge. The result is a new transparent PNG; the original stays. This works for plain or evenly lit backgrounds (product photos on white, logos, icons). It does not separate a subject from a busy background; that needs a segmentation model, which is not part of this release.
* **Trace to SVG**: converts the image to vector shapes of its colours (low, medium or high detail). Made for flat illustrations, icons and logos. The SVG is stored as an asset.
* **Edit SVG** for SVG assets: the vector editor described in the next section. Each saved SVG also keeps a PNG of itself, so a traced or edited SVG draws in templates and in the batch renderer.

**Tested.** Unit tests: carousel grouping, the cloud routes against mock Google and mock R2 (signing, folder links, uploads with replacement, the sign-in flow), and the asset routines. End to end: carousel creation, the Carousel Page text, live regrouping on delete, the Master Field, the synced mark and the rule against a synced master (`tests/e2e/carousel.mjs`); the Batch Runner destinations with mock R2 and mock Google (`tests/e2e/cloud.mjs`). The existing editor, batch, connect and website suites still pass.
**Not verified:** a live Google Drive account, a live R2 bucket, and how Buffer handles Drive or R2 links. The background removal and tracing quality on real photographs.

## Closing slides, fill handle, vector SVG editor (1.8.0)

**Closing slide for carousels.** In *New table → Carousel table*, choose **Closing slide**: any image in *Assets* that has a public address. Each carousel then holds the table's images in its first slots and the closing image as its last slide. With 1–10, slides 1–9 are images from the table and slide 10 is the closing image, in every carousel. The *Carousel* field lists the URLs in that order for Buffer; the *Images* count is the number of slides. Giving the closing image a new address updates every carousel that ends with it. If the closing image is deleted or loses its address, that carousel table keeps its last good records and shows one warning until the image has an address again.

**Public address in Assets.** The detail panel of an image shows **Public address**, which Buffer and the carousels use; without one, the address the image was imported from is used. Save it with *Save* or Enter; *Copy* copies it. Each card shows its address.

**Fill handle (spreadsheet fill).** Select cells, then drag the small square at the bottom-right corner of the selection down. The selection repeats in the rows below it. With **Shift or Ctrl** held, a column of plain numbers counts on instead: 5 → 6, 7, 8; 10, 20 → 30, 40 (the step is the difference of the last two). Other columns are copied. Dragging past the last row creates new records, after a confirmation, as paste does. Links, images and read-only fields are handled exactly as in paste.

**Vector SVG editor** (*Assets → an SVG asset → Edit SVG*):
* Click a shape to select it, then drag its points (squares) and handles (circles). Moving a point carries its handles with it, and a Bézier curve keeps its shape.
* Click the small **+** on a line to add a point there; the curve is split without changing its shape. Delete removes the selected point, or the whole shape when no point is selected.
* The fill colour of the selected shape, and *Colours in this drawing*, which recolours every shape of one colour at once. The x and y of a selected point can be typed.
* Undo and Redo (Ctrl+Z, Ctrl+Y), zoom, and a *Code* tab with the SVG text.
* *Save changes* writes the same asset, so every template that draws it shows the new version. *Save as new asset* keeps the original.
* An uploaded SVG file is rasterised on import, as before. To edit a drawing, trace an image to SVG, or save an edited SVG.

**Tested.** Unit tests (`npx vitest run --no-file-parallelism`): carousel grouping with a closing slide, the SVG document model (reading and writing paths, moving points and handles, inserting and deleting points, colours), and the fill values (copying, counting on). End to end (`tests/e2e/fill-svg-closing.mjs`, 9 checks): the fill handle copies, counts with Shift and creates records past the last row; a closing-slide carousel, and its update when the closing image's address changes; the SVG editor's drag, recolour, save and undo, with nothing saved while editing.
**Not verified:** very large traced drawings (thousands of shapes) and touch screens.

## Template images from a web address in a record field (1.9.0)

**Choosing the field.** In the template editor, select an image element, press *Choose…* and switch to **From a record field**. Pick a field of the table (a text, URL or image field). The element then takes its image from each record's value:
* an `https://` address is downloaded when the batch runs (and for the preview), then drawn like an uploaded image. Nothing is added to *Assets*;
* the name or id of an uploaded image uses that image;
* a record whose field is empty uses the element's fallback, or the static image chosen before.

**How the download works.** The page first tries the address directly. If the server does not allow that (no CORS, which is most image hosts), the local helper downloads it. The helper accepts JPEG, PNG, WebP and GIF only, judged by the bytes (not by the file name or the type the server claims); it refuses SVG (it can contain scripts) and web pages; it refuses addresses in private networks, follows at most five redirects, and stops at 25 MB or 30 s per image. Downloads of the same address are reused during a session.

**When a download fails.** The record fails in the batch with the reason (not found, refused, not an image, …). It is not drawn with the fallback, so a wrong link cannot pass unnoticed.

**Removing the background (1.9.1).** In the Data tab, under *Image binding*, tick **Automatically delete image background**. When the image is drawn (the preview and the batch), the background that touches the image's border is made transparent, so the product stands on the frame's colour or on the template. It works on plain or white backgrounds, as the Remove background tool in Assets does; a busy photo background is not separated. The file, the record and the Assets library are not changed. A ticked field also cuts out its fallback image.

**Tested.** Unit (`tests/unit/remote-image.test.ts`, 14): the recognition of image bytes, the refusals, redirects, the size limit, private addresses, and the helper's route. End to end (`tests/e2e/remote-images.mjs`, 3 checks): the picker saves the field, the batch downloads through the helper (the mock server sends no CORS headers), follows a redirect, and fails the records whose image is missing or is a web page, each with its reason.
**Not verified:** a live image host, and very large batches (thousands of different addresses) in the packaged app.

## Asset library, background removal, traced drawings, rulers, vector pack (1.10.0)

**Folders.** *Assets* has a folder list on the left: *All assets*, one button per folder with its count, *New folder*, and *Delete folder* (its assets move to “Uncategorised”; nothing is deleted). An upload goes into the folder that is open.

**Vector drawings.** An uploaded SVG is kept as a vector: its drawing text is the asset (open it with *Edit SVG*), and a PNG of it is made for the templates. Before 1.10.0 uploaded SVGs were rasterised.

**VierApparatus vector pack.** *Install vector pack* adds 50 drawings with no background to the folder “VierAsset”: 20 pieces of lab equipment (microscope, centrifuge, micropipette, flasks, burette, balance, incubator, spectrophotometer, …) and 30 science drawings (phylogenetic trees, molecules, cells, bacteria, a DNA helix, a virus, an atom, charts). Every shape is a filled path, so each point can be edited. Installing again adds only what is missing. The drawings are generated by `scripts/vier-pack/build.mjs`.

**Background removal.** The background is learned from the picture's border as several colours, each with its own tolerance, so a soft backdrop works too. Colours are compared in CIE L*a*b*. The removal starts at the border and stops at outlines, so a light product on a white backdrop keeps its own light parts (the platter of a balance). *Assets → Remove background* has a live before/after preview, the tolerance slider, and *Also remove background-coloured areas inside the outline* for line art (the white inside a drawn flask). The template option *Automatically delete image background* uses the same method at the default tolerance.
**Limit:** a product whose colour is close to its backdrop (clear glass on a blue backdrop, a white plastic tube on white) goes with the backdrop; colour alone cannot tell them apart.

**Traced drawings you can edit.** *Trace to SVG* has two modes: *Colour areas* (flat illustrations, logos) and *Line art* (the ink of a drawing becomes outline shapes, the paper is dropped). The traced file has no invisible layer and no outline stroke, so changing a shape's fill changes the whole shape. Its points are edited in the SVG editor.

**Web addresses (1.10.1).** *Assets → From URL* and the template images accept a Google Drive share link (`drive.google.com/file/d/…/view`). The file must be shared as “Anyone with the link”; DCE then downloads the file itself, through the local helper, and names it “Google Drive image …”. If Google sends a page instead of the file, the import says so.

**Rulers.** The template editor shows rulers along the top and the left, in document pixels, with marks that follow the zoom and a red mark at the pointer. Drag from a ruler to pull out a guide; drag a guide to move it; drag it back onto its ruler to remove it; click the *px* corner to clear all. Guides are a view aid and are not saved in the template.

**Tested.** Unit: the background method (8 tests: colour model, gradient backdrop, noise, enclosed areas, tolerance), the trace clean-up (4), the folder list, the ruler marks and the pack (7: every drawing parses as filled paths, none is a background-sized shape). End to end (`tests/e2e/library-rulers.mjs`, 6 checks): folders and vector uploads, the pack install (50, and no duplicates on a second install), tracing and editing a traced image (fill changed, saved into the same asset, no stroke), the Remove background preview, and the rulers with a guide pulled out and removed.
**Not verified:** the background method on many real product photos (checked by eye on a sample of catalogue photos, not against masks); touch input for the rulers.

## Formulas, undo and folder import (1.11.0)

**Formula fields.** *Fields → Add custom field →* **Calculated → Formula**. A formula starts with `=`. `[Column]` is the value of a column in the same row, `A1` is the first column of the first row (the same addresses as a spreadsheet, columns in field order, rows in creation order), `A1:A10` is a range. Operators are `+ - * / ^ &`, `%` and the comparisons `= <> < >`; functions are listed in the editor (SUM, AVERAGE, ROUND, IF, IFERROR, AND, OR, CONCATENATE, LEFT, MID, …). A formula cell is calculated when the table is shown, and a formula can use another formula's result.

**Editing a formula.** Double-click a formula cell and type. The ⤢ button opens the large editor: the formula with its live result for this row, a syntax message that holds Save back, buttons that insert a column or a function at the cursor, and Ctrl+Enter to save.

**Formulas in amounts and numbers.** A currency, percent or number cell also takes a formula (`=[Qty]*1.5`) and shows its result. A currency cell's ⤢ button opens the same editor.

**Undo and redo.** Ctrl+Z undoes the last change to a table: a cell, a row added or deleted, a field added, changed or deleted. Ctrl+Y or Ctrl+Shift+Z redoes it. The Undo and Redo buttons in the toolbar do the same. The last 100 changes are kept while the app is open (not after a restart). Typing inside a cell keeps the browser's own undo.

**Browse folder (Assets).** *Browse folder…* next to *Install vector pack* opens the system folder dialog. Every SVG, PNG, JPEG, WebP and GIF in the folder goes into the library, in a folder named after it; other files are skipped. A drawing already in the library is not added again. The VierApparatus pack line no longer carries its description text.

**Copying a formula (1.12.0).** Copying a formula cell (Ctrl+C or the cell menu's Copy) copies its result, the number a spreadsheet would show, so a paste into a spreadsheet or into another cell gives the value. Pasting a value over a formula cell replaces the formula. To copy the formula itself, use **Copy formula** in the large editor (⤢), or the copy button next to the formula in the record details. Exports write the formula text too; importing that text gives back a formula.

**Tested.** Unit: the formula engine (19 tests: references, precedence, `-2^2`, rounding, IF, Excel error codes, text, self-reference as #CIRC!). End to end: `tests/e2e/table-formulas.mjs` (13 checks: a formula field, typing in formula, currency and number cells, the large editor and its Copy formula, the record details, copying a cell gives its result, nested results, undo and redo of field, cell and row changes, no console errors) and `tests/e2e/assets-folder.mjs` (4 checks: the folder import, a second import adds nothing).

## Downloads, ruler guides and automation output (1.13.0)

**Download a template as a file.** The download button on a template card, and *Download* in the editor's toolbar, open one menu: the **.njs design file**, or the drawing as **PNG**, **JPEG**, **PDF**, **SVG** or **HTML**. The drawing is the render the Batch Runner uses, at the template's own size, with its sample record; the editor uses the record picked in its preview and includes unsaved changes. The `.njs` file still embeds the assets.

**Ruler guides are magnets.** A guide pulled from a ruler stays until it is dragged back onto its ruler (or *Clear all guides* is pressed). An element moved near a guide snaps its left, centre or right edge (or its top, middle or bottom) onto it, within 10 screen pixels, before the grid and before the edges of other elements. The magnet button turns it off. Guides are a view aid: they are not saved in the template, and resizing does not snap to them yet.

**Automation renders can upload.** A *Render with the batch runner* step has the same *Where the files go* choice as the Batch Runner: download the ZIP, upload to a Cloudflare R2 bucket, or upload to a Google Drive folder. The link of every file is written into the Uploaded link field of its record (or the field you choose). Without an upload the ZIP is downloaded, as before; with an upload it is downloaded only when *Also keep a ZIP download* is ticked. The upload is checked before anything is rendered, and the run history says where the files went.

**Tested.** End to end: `tests/e2e/template-export.mjs` (5 checks: the menu, each format's file type and size, the editor's menu with unsaved changes), `tests/e2e/ruler-guides.mjs` (6 checks: a guide from each ruler, the magnet stops an element on it and not on the grid, snapping off, a guide removed by dragging it back, guides not saved), and `tests/e2e/cloud.mjs` (7 checks, including an automation step that renders every record and uploads it to the mock R2).

## Saved views (unreleased, after 1.23.1)

The **Views** button next to the search box saves the current search, filter, sort and hidden fields of a table under a name. Opening a view restores all four; saving under the same name (any capitals) replaces it; the button shows the name of the view that is open. **Show everything** clears the search, filter and sort. A table can have up to 30 views. Views belong to this browser (they are kept in the app's settings, not in the table), so they do not change exports or what other tables see.

**Tested.** `tests/unit/views.test.ts` (3) and `tests/e2e/views.mjs` (7 checks in the real app: save, clear, open, keep after a reload, replace by name, delete).

## Deleting a record with its files, one link at a time (1.23.1)

A field can hold several links. Each one is read on its own: a comma, a semicolon, a space or a new line separates them, so a carousel record with four links has four files.

Before anything is deleted, every link is checked. When one link is not a file of a connected Cloudflare R2 bucket, nothing is deleted, the records keep all their links, and the history names every link that is not in the bucket. Before, the step deleted the files before the bad link, so the record was left half deleted.

When all links are files of the bucket, each file is deleted with its own request, its link is removed from every record that holds it, and then the record is deleted.

**Known issue, not changed here.** Carousel records are numbered by their position. When “Carousel 1” is deleted, the next two slides become “Carousel 1” again, and the groups shift. Deleting it a second time would delete those slides’ files. Fixing this changes how carousel records are identified, and automations that fire on records depend on that, so it needs a decision first.

**Tested.** `tests/e2e/cloud.mjs`: a field with four links separated by a comma, a semicolon and a new line (each file deleted, in order, and the link removed from the other record); a field with a link outside the bucket (nothing deleted, the record keeps its links, the history names the link); a real carousel of five slides, two to a group (Carousel 1 deleted with its two files, and no carousel keeps a deleted file).

## Dead image links are caught before they reach Buffer (1.23.0)

**What happened.** Five images of one carousel group were not in the R2 bucket any more (HTTP 404 on both the development address and the custom domain), while the records still linked them. Buffer could not load them, so its post failed with “Please update the media URL to be publicly accessible”. The other images in the same bucket opened on both addresses, so the address was not the cause. The most likely cause is the “Delete a record” step: it deleted the carousel group and its files, and the source records kept their links.

**What changed.**
- A delete step removes the deleted files’ links from every record that holds them, the same as the retention rule did. No record keeps a link to a file that is gone.
- Before a Buffer post, every image address is opened. An address that does not open its image stops the step, with the reason, before anything is sent. A dry run reports the same problem.
- An image uploaded to R2 is opened at its public address before its link is written. If it does not open, the file counts as failed and the record keeps its old link.
- A link on a Cloudflare development address (`pub-….r2.dev`) is sent with the bucket’s current public address for the same file, when that address opens it. To use this, add the R2 connection again with your custom domain as its public address (connections cannot be edited yet); new uploads use that address too.
- The R2 settings warn when the public address is a development address.

**Not covered.** Buffer fetches an image again when the post goes out, so an image deleted after the post is made can still fail at that time. Delete after the post is published (see the conditions of each action).

**Tested.** `tests/unit/r2-addresses.test.ts`; `tests/e2e/connect.mjs` (a missing image stops the post before Buffer; a Drive file link is sent as its direct address); `tests/e2e/cloud.mjs` (the mock bucket serves its files, so uploads are read back).

## Each action has its own condition (1.22.0)

Every “Then” action can have an **Only when** condition, like a trigger’s conditions (the same field, operator and value rules, all or any of them). The action runs only for an item that matches it. For an item that does not match, the action is shown as skipped in the history and the actions after it still run. If no action matches an item, the run is shown as skipped. An action with no condition runs for every item, as before.

This lets one automation act on different items at different times: for example, post when the status is “Ready to post”, and delete the R2 files only when the status is “Published”. A status change starts the automation again when the trigger is “When a record changes” on that field, so an action runs once per change and no item is handled twice for the same action.

**Tested.** `tests/unit/step-filter.test.ts` (no condition, and/or, empty values, a website item’s field named like a built-in field) and `tests/e2e/automation-update.mjs` (three records, two actions with different conditions: each action changes only its own records, the skipped actions are shown in the history, and the editor shows “Only when”).

## Google Drive file links go to Buffer (1.21.0)

A Buffer post can now take a Google Drive **file** link. DCE sends it the way the Google Apps Script scheduler does: the link becomes Google’s direct-download address for that file (`https://drive.usercontent.google.com/download?id=…&export=download`). This replaces the 1.18.0 rule that refused every Drive link. The run sends the converted address; the link stored in the record is not changed.

Still refused, with the reason in the run: a Drive **folder** or page (a folder is not one image), a Google Docs page, and a Dropbox share link.

**Not verified against Buffer.** Buffer’s acceptance of the direct address was not tested live, because a test would create a real scheduled post. If Buffer refuses an image, the run fails with Buffer’s message. The file must be shared as “Anyone with the link”; otherwise Google returns a web page. Google may also show a warning page instead of a large file (not tested). Cloudflare R2 remains the reliable choice for Buffer.

**Tested.** `tests/unit/buffer-images.test.ts` (the conversion and the refusals), `tests/e2e/connect.mjs` (a Drive folder is refused before anything is sent; a Drive file link reaches Buffer as the direct address), `tests/e2e/automation-update.mjs` (the warning counts the addresses Buffer cannot read and goes when they are fixed).

## Carousels stay in step with their images (1.20.0)

**Why Buffer still read Google Drive links.** A carousel table keeps its own copy of the image addresses (its *Carousel (image URLs)* field), made from the source table's link field. The copy was refreshed on each change to the source, but when several source rows changed at once (a batch upload to R2), a refresh that started while another was running was dropped, so the copy kept the older Drive links. The Buffer step reads that copy.

**What the app does now.** A refresh that arrives while another runs is not dropped: it runs again afterwards, so the last change is always applied. When the app starts, every carousel table is brought up to date with its source, which corrects copies that an older version left. The warning about Drive or Dropbox links on an automation counts the records as they are now and goes away when the links change, while the page is open. The automation page, the destination panel and the field and new-table dialogs redraw when the records, tables or fields they show change.

**Tested.** `tests/unit/coalesce.test.ts` (3 checks: a request during a run is not lost, a single request runs once, keys do not wait for each other), `tests/e2e/carousel.mjs` (8 checks: a stale link is replaced at start-up) and `tests/e2e/automation-update.mjs` (6 checks: the warning goes while the page is open when a record gets a public picture).

## Uploaded files that are deleted (1.19.0)

**Keep the uploaded files for a set time.** In the Batch Runner and in an automation's *Where the files go* (Cloudflare R2), choose *Keep them until I delete them*, *Delete them after N hours*, or *Delete them at a date and time*. Each file is remembered with the moment it is due.

**The due files are deleted.** While DCE is open (like the automations, which run only then), a due file is deleted from the bucket, and its link is removed from its record. The record stays. A file the bucket refuses is kept in the list, with the reason, and tried again. Only files that DCE uploaded, in the connection's folder, are ever deleted.

**Delete a record.** A new automation action, *Delete a record*, works like *Update a record*: the record that started the automation, or the records where a field has a value. *Also delete the Cloudflare R2 files in this field* deletes each record's files first, then the record. A file that is not in a connected bucket, or that the bucket refuses to delete, stops the step and keeps the record, so no link is left pointing at nothing. A dry run shows what would be deleted.

**Tested.** `tests/e2e/cloud.mjs` (10 checks: a batch that deletes after an hour remembers its files with the time due, a due file is deleted with a signed request and its link removed, an automation deletes a record and its R2 file, and refuses a file outside the bucket), `tests/unit/retention.test.ts` (5 checks: the due time, the key of a public address, a foreign address refused). The DELETE request has been checked against the mock R2, not against a live Cloudflare bucket.

## Buffer images must be public files (1.18.0)

**Why a post failed with “Image could not be read from its URL”.** The links that the Batch Runner writes to Google Drive are Drive share links (`drive.google.com/uc?export=view&id=…`). They give a web page or a redirect, not the image file. Buffer reads each image itself, without a Google sign-in, so it cannot read them. Buffer's guide for hosting media says the address must point straight at a public file, and names Google Drive and Dropbox share links as the addresses that fail.

**What the app does now.** A *Create a post* step refuses a Google Drive or Dropbox address before it calls Buffer, and the run says which address and why. The step shows a warning when records of its table hold such links, and the Batch Runner's Drive destination says so. Nothing is sent, and the run is recorded as failed.

**The fix.** Upload the images to Cloudflare R2 with a public address (Batch Runner → Upload to Cloudflare R2, into the link field the Buffer step uses), then run the automation again. R2 public addresses are direct files, which Buffer can read.

**Tested.** `tests/unit/buffer-images.test.ts` (the checker: Drive and Dropbox refused, a public file accepted) and `tests/e2e/connect.mjs` (18 checks: a Drive link is refused before anything reaches Buffer, a carousel of public links is sent in order).

## Automations: schedules, Instagram, post ids and Update a record (1.16.0)

**A schedule starts from now.** Switching a schedule on, changing its time, days or number of rows, or changing an automation's trigger starts it from that moment: the occurrences that already passed are not run. Before this version, changing the trigger of an enabled automation ran every matching row at once. An automation that has never been armed is armed on its first check and runs from the next occurrence.

**Rows each time** runs the next rows in table order each time the schedule is due. One row a day at the chosen time is *Rows each time: One row*.

**Instagram posts have a type.** When the channel is Instagram, choose Post, Story or Reel; the type is sent with the post, together with `shouldShareToFeed` (true for posts and reels, false for stories), which Buffer requires. The Content pipeline sends feed posts.

**Post id.** *Store the post id in* lists the text, long text and link fields of the table. *Create “Buffer post id”* adds a text field the first time it is used. The id is stored when Buffer accepts the post, so a post that Buffer refuses leaves the field empty.

**Update a record** (formerly *Set a field*). *Which record* is the record that started the automation, or the records where a field has a value (for example, Name is Bravo). *Add another field* sets more fields of the same record. Only the chosen record or records change, never the whole field.

**Tested.** `tests/e2e/automation-update.mjs` (5 checks: a changed schedule does not run what passed, a changed trigger runs nothing, Update a record changes only the record found, the editor's choices), `tests/e2e/order-fields-export.mjs` (10 checks, including a one-row-a-day run through the engine), `tests/e2e/connect.mjs` (17 checks, including the Instagram type and the post id choice), and `tests/unit/buffer-images.test.ts` (6 checks, including the Instagram type in the request). The request to Buffer has not been checked against Buffer's live API.

## Table order, copy, Excel and typed automation values (1.15.0)

**The order of a table is kept.** Each row has a saved place in its table. Rows that were made together, rows from before this version, and rows added later keep their order after a restart and after every change. A new row goes to the end. A row moves up or down from its menu, when no sort, filter or search is on. The carousel slides follow this order. Rows from before this version get a place the first time the app loads, in the order they are shown then. The order that was shown before an earlier restart cannot be recovered, so check the Carousel Plan once and move any slide that is out of place.

**Columns move.** The Fields panel has up and down buttons, and each column's menu has Move left and Move right. Built-in columns move too. The new place is saved, and undo covers it.

**Copy the whole table.** *Copy table* copies every row, or the selected rows when some are selected. Ctrl+C copies the selected rows, also when the focus is on the select-all box.

**Excel.** *Export → Excel file (.xlsx)* saves the rows in table order, with a bold header that stays on screen, numbers as numbers, and dates and date-times as Excel dates.

**Automation values are typed.** A *Set a field* step shows the input of the field's type: a choice list for a select (a value that is not one of its choices stops the step), a date picker, a number, a formula, an image, a template, or text. A value with a `{{field}}` placeholder stays text, filled in when the step runs. An *Add or update a row* value is checked against its column the same way. Link fields are not offered.

**A weekly schedule can run one row at a time.** The *Rows each time* choice is all matching rows at once (as before), one row, or a set number. Each time it is due, it runs the next rows in table order; the others wait for the next time.

**Tested.** `tests/e2e/order-fields-export.mjs` (10 checks: the order after a restart, a row moved from its menu, a value edit and a new row, a column moved, Copy table and Ctrl+C from the select-all box, the Excel file, the typed value, the weekly schedule one row at a time through the engine, a built-in column moved), `tests/unit/order-xlsx.test.ts` (the order rules, the schedule slices, the Excel parts and cells), and the packaged app (`tests/e2e/desktop.mjs`, 10 checks).

## Buffer images and record details (1.14.0)

**Buffer posts take their images by link.** A *Create a post* step has *Image: No image / Send by link*. With *Send by link*, choose the field that holds the image addresses: one public `https://` address, or several separated by commas or new lines (a carousel, up to 10 images). A Google Drive link written by the Batch Runner works. Every address is sent to Buffer as one image of the post, in the order of the field. Addresses that are not public `https://` are left out, and the step says so. The field list offers the fields that can hold text, so a number field such as *Images* is not offered.

**Record details are wider and easier to read.** The drawer is 36% of the window wide (between 440 and 620 pixels). Each field's name is above its input, and the inputs use the normal reading size.

**Tested.** `tests/e2e/connect.mjs` (17 checks, the new one sends a carousel of two links and checks both are in the request, in order), `tests/unit/buffer-images.test.ts` (the link list: separators, Drive links, non-https addresses, the ten-image limit, one asset per image), and the packaged app (`tests/e2e/desktop.mjs`, 9 checks, including the step's choice and the drawer width).

## Data: templates, tables and built-in fields (1.11.x)

**One data table per template.** The editor's Data tab starts with *Records come from*: choose the table first. The bound fields are then the fields of that table, shown as `Label · content.key`. `content.<key>` is the value of the record being rendered, from whichever table it belongs to. The Batch Runner, the editor's data preview, the template list's preview and the thumbnail all use the template's table; the batch screen shows the table, it does not choose another one. Templates made before this choice draw from the Content Plan.

**Built-in fields are editable.** Title, Status, Publish Date and the other built-in fields can be renamed and their choices changed (Edit name and choices, from the column menu or the Fields panel). Their key (used in bindings and storage) and type stay fixed. Each field can also start hidden when its table opens, and can have a *Default for new records and imports* (the Status field defaults to Draft).

**Copy for AI.** The Fields panel copies a field's settings on its row (and its key when you click the key); the field dialog copies the binding key; *Copy table structure (for AI)* copies the table name, record count, Master Field and every field as plain text.

**Renaming and deleting tables.** The Content Plan can be renamed (its name is kept as the setting `table.content.name`) but not deleted. Deleting a custom table moves the templates that drew from it back to the Content Plan. A filter condition on a field the table does not have is removed when the batch changes its table, and the batch says so.

**What stays fixed on purpose:** the internal table id `content` (never shown), the storage keys of the built-in fields (`title`, `status`, …), and the `content.` namespace in templates. Each of these is a stable name that bindings and stored data depend on; everything a person sees (names, choices, defaults, visibility) comes from the table's own settings.

## Binding syntax & safety

* Text: `{{content.title}}` · filters `|upper |lower |title |trim |slug |truncate:40 |default:N/A |number:2 |date`.
* Scopes: `content.*` (record fields incl. custom), `template.*` (template variables), `index` / `batch.index` in file names.
* Conditions: `exists(x)`, `empty(x)`, `len(x)`, `!`, `&& ||` (or `and`/`or`/`not`), `== != < <= > >=`, `contains` —
  numbers and ISO dates compare naturally. Parsed by a hand-written tokenizer + recursive-descent parser; **no `eval`,
  no `Function`**, prototype keys are unreachable. Invalid expressions keep the element visible and report a warning.
* Missing values never crash a render: fallback text → placeholder default → empty + warning. A placeholder marked
  **required** with no fallback fails *that record* (it appears in the job's failure list with the reason).
* Markdown is rendered with `marked` and sanitised with DOMPurify (scripts, handlers, styles, forms removed). CSV export
  neutralises leading `=` / `@`. Imports are size-limited and validated; a malformed file never partially imports.

## Output formats

PNG (optional transparency) · JPEG (quality) · SVG (fonts and right-sized images embedded, text kept as text) ·
HTML (self-contained SVG page) · PDF (one per record, or one multi-page file) · ZIP with `manifest.json`
(`filename, record_id, template_id, output_format, status, warnings, error`). File names come from a pattern
(`{{content.slug}}.png`), are sanitised and de-duplicated (`a.png`, `a-2.png`).

## Testing

Unit tests: `npm test` (300 tests in 25 files, 1.11.x).

| Suite | Command | Covers |
|---|---|---|
| Unit (314) | `npm test` | automations (what each connection allows, the website-event gate, presets, templates and escaping, schedules, OpenAPI operations, migration of the earlier shapes), website connector (placeholders and prompt, checking Gemini's answer, reading events and pages, the HTTP helper's host / redirect / scheme rules), linked / synced fields (both directions, delete, unlink), AES-GCM vault round-trip + tamper detection, automation timing / trigger semantics / GraphQL escaping, safe expressions & injection attempts, **content pipeline** (sitemap / RSS / HTML parsing, guardrail rules, write → check → rewrite loop with fake models, schedule / retry rules, never-twice selection, robots.txt matching, private-address blocking, 1 request/second throttling against a local server), bindings, text fitting, `.njs` round-trip / validation / migration, scene resolution, SVG/PDF structure, CSV parser, filter operators, importer, document model (group, reorder, align, DnD) |
| Editor e2e (30) | `npm run build && node tests/e2e/editor.mjs` | real mouse/keyboard: draw every tool, type into text, bind fields, constraints, undo/redo, snapping, layers (hide, lock, rename, DnD), group/ungroup, copy/paste, pen, zoom, data preview, save → reload → persisted |
| Data + batch e2e (30) | `node tests/e2e/batch.mjs` | CSV import with bad rows, inline edit, filter builder, bulk update, CSV/JSON export + re-import, malformed CSV, custom field, sanitised Markdown, asset upload/delete, `.njs` export → import identical, single PNG, JPEG/SVG/HTML/PDF (single + multi-page), 100-record ZIP, pause/resume/cancel, failed-record inspect → fix → retry, missing values, Python bundle actually executed, sample-data removal, WOFF2 font import, revert-to-saved, offline reload |
| Tables / connections / automations e2e (17) |
| Automation updates e2e (5) | `node tests/e2e/automation-update.mjs` | a changed schedule starts from now; a changed trigger runs nothing; Update a record changes only the record found by a value; the editor's record and field choices |
| Order, fields, copy, Excel and typed automation values e2e (10) | `node tests/e2e/order-fields-export.mjs` | rows keep their order through a restart; a row and a column move from their menus; Copy table; the Excel file opens with its header, order and numbers; a set-field value is a choice list; a weekly schedule runs one row each time | `node tests/e2e/connect.mjs` | starts a **mock Buffer API** and the **real relay**: relay CORS / auth rules, encrypted-at-rest keys (checked in IndexedDB), reveal / copy / replace menu, account picker, channel discovery, custom table + every field type, two-sided links, synced fields in both directions, delete-with-dependents, automation payload / schedule / status update / no duplicates, failure + back-off, safe enabling, pause, persistence after reload |
| Content pipeline e2e (26) | `node tests/e2e/pipeline.mjs` | mock website (sitemap, robots.txt, thin / disallowed / overreaching pages), **mock Gemini**, **mock Buffer**, the **real relay**: seeded sources can be deleted and a new one added, encrypted Gemini key, wrong key → clear alert and nothing sent, a robots-disallowed page is never requested and requests are ≥ 1 s apart, thin page / fact-check failure / banned wording are rejected and the next page is used, quota error retried, simulation never calls Buffer, approval holds until Approve, an edit that breaks a rule cannot be sent, reject, auto-publish with fixed time, expired Buffer token, simulation-only source, site down, "nothing new", daily schedule runs once, exports contain no secrets, model list / retired-model alert / Auto fix, live run log and Stop (leave the page and come back), channel list from Buffer (new channels saved, removed ones flagged, ids encrypted), sync to a table (one row per post, no duplicates) |
| Website connector e2e (7) | `node tests/e2e/website.mjs` | mock website (connector API, article page), **mock Gemini**, the **real relay** and the real app: connection + permissions test, preset workflow, article event → post, row, Gemini fill, sync, render, a second check repeats nothing, run log with each step |
| Formulas & table undo e2e (13) | `node tests/e2e/table-formulas.mjs` | formula field from the Calculated group, typing a formula in a formula, currency and number cells, the large formula editor (live result, syntax check, Insert, Ctrl+Enter), nested results, Ctrl+Z / Ctrl+Y over field, cell and row changes, no console errors |
| Dynamic data e2e (10) | `node tests/e2e/dynamic-data.mjs` | a template chooses its data table, then the field of that table; the batch and the preview use that table; a built-in field is renamed (its key and type stay); fields and table structure are copied for an AI prompt; the Content Plan is renamed (not deleted); deleting a table re-points its templates |
| Template download e2e (5) | `node tests/e2e/template-export.mjs` | the card's and the editor's Download menu: the .njs design file, PNG, JPEG, PDF, SVG and HTML at the template's size, named after it; unsaved changes included |
| Ruler guides e2e (6) | `node tests/e2e/ruler-guides.mjs` | guides pulled from the rulers; an element stops on a guide (not on the grid); the magnet off; a guide dragged back onto its ruler is removed; guides are not saved |
| Cloud destinations e2e (7) | `node tests/e2e/cloud.mjs` | mock R2 and mock Google Drive: the Batch Runner's uploads and links, the Drive folder replace, and an automation render that uploads every record |
| Assets folder import e2e (4) | `node tests/e2e/assets-folder.mjs` | Browse folder: drawings and pictures go into a folder named after it, other files skipped, a second import adds nothing, the pack line has no description |
| Benchmarks | `npm run bench` | see below |

## Measured performance

Numbers below were measured by `tests/perf/bench.mjs` on the development machine (headless Chromium, production build);
re-run it on yours — throughput depends on template complexity and CPU.

<!-- BENCH:START -->
Machine: AMD Ryzen 5 7520U with Radeon Graphics, 8 logical cores, 7 GB RAM · headless Chromium **without GPU** (software rasterisation) · 2026-11-05.
The sample template has 18 elements (shapes, 5 text frames with auto-shrink, one 800×800 image, one logo).
Target from the brief — ≥ 5 simple 1080×1080 PNG renders per second — is exceeded roughly ten-fold; a heavier template (more
images, large auto-shrink paragraphs) will be slower, and nothing here is a promise for such templates.

| Measurement | Result |
|---|---|
| Seed 1,000 / 10,000 records (bulk IndexedDB write) | 458 ms / 2730 ms |
| Grid ready after reload — 1,000 / 11,006 records | 877 ms / 1053 ms |
| Rows in the DOM (virtualised) — 1,000 / 11,006 records | 29 / 1006 / 29 / 11006 |
| Smooth scroll, 90 px/frame — p50 / p95 frame (1k) | 16.2 ms / 70.1 ms |
| Smooth scroll, 90 px/frame — p50 / p95 frame (11k) | 16.6 ms / 57.3 ms |
| Jump-scroll top→bottom in 121 frames (worst case) — p50 / p95 (11k) | 50 ms / 116.6 ms |
| Search a phrase, typing → filtered grid (includes a 150 ms debounce) — 1,000 / 11,006 records | 244 ms, 19 matches / 261 ms, 57 matches |
| Sort 1,000 / 11,006 records by title (header click → re-sorted grid) | 207 ms / 250 ms |
| Indexed filter (Status = Draft) on 11,006 records, Batch page | 2,201 match in 143 ms (includes the 80 ms debounce) |
| Open a template in the editor → first paint | 544 ms |
| One record → 1080×1080 PNG on the main thread (preview) | 55 ms |
| 100 records → PNG ZIP (4 workers) | 3704 ms wall, **55.41/s**, 24.9 MB |
| 100 records, 1 worker | 3474 ms wall, 32.81/s |
| 1,000 records → PNG ZIP (4 workers) | 15128 ms wall, **72.81/s**, 250.1 MB, main-thread JS heap peak 86 MB, whole browser process tree peak 1244 MB |
| 1,000 records while 11,006 are stored | 16425 ms wall, 69.66/s, JS heap peak 213 MB, process tree peak 1346 MB |

"Jump-scroll" teleports ~90 rows per frame and is a stress test, not a normal scroll. Frame times are dominated by software
rasterisation in headless Chromium (CPU profile of the 1k grid: about two thirds of the time is native paint and layout, JS is the smaller part); on a GPU-backed browser they are lower.
Memory: finished ZIP chunks are folded into Blobs, so the main-thread JS heap stayed ≈ 86 MB for a 250 MB archive
(it was ≈ 265 MB before that change). Worker memory is inside the "process tree" figure.
<!-- BENCH:END -->

## Limitations (honest list)

* **Browser support:** developed and tested on Chromium (OffscreenCanvas, `canvas.letterSpacing`, module workers).
  Firefox/Safari are untested.
* **PDF** pages are JPEG-compressed raster images of the render (text is not selectable). Vector PDF is future work.
* **Bézier editing** has cubic anchors/handles; no boolean path operations, no stroke-to-outline.
* **No gradients, shadows, blend modes, or per-glyph text styling** (one style per text frame).
* **Groups** are one level of visual grouping in the editor (click selects the whole group; ungroup to edit members); nested
  groups render correctly but are edited by ungrouping first.
* **Expand** grows the frame only; elements below do not reflow.
* **`render.py`** is a *compatible subset*, not a second engine: no letter spacing, TTF/OTF only (put Jost in `fonts/`), text
  metrics differ slightly from the browser; SVG/PDF/HTML are browser-only. Pixel parity is not claimed.
* **Generated files are not stored** in IndexedDB (by design). Download the ZIP when a job finishes; history keeps the log.
* **Google Fonts** download needs network once (offline afterwards); it could not be exercised offline in tests.
* **Streaming to disk** needs a Chromium browser with the File System Access API and a user gesture; otherwise the ZIP is
  assembled in (Blob-backed) memory. Very large jobs (> ~2 GB) should use the option or the external bundle.
* Every template draws its records from **one table** (its data table, chosen in the editor’s Data tab). A binding cannot reach into a second table through a link yet (no lookup fields). The CSV/JSON *import wizard* is Content-Plan-only — for custom tables paste from a spreadsheet.
* **Formula and rollup/count fields** are not implemented (synced fields cover mirroring); a link mirrors the first linked record.
* **Automations only run while DCE is open** in a browser tab (and catch up when it is opened). Unattended 24/7 scheduling would need a server. Buffer (publishing) and Gemini (writing) are built in; other services would be new action types.
* The Buffer GraphQL schema was taken from Buffer's public docs (`createPost`, `account.organizations`, `channels`); it was exercised against a mock of that schema, **not against a live Buffer account** — use *Test connection* and a *dry run* first.

* **Content pipeline:** Stop cannot take back a Buffer request that has already been sent; the sync to a table is one-way; the channel list is read when the page opens or when you press Refresh (it is not live); pages that need JavaScript to show their text are not supported (no headless browser by design); only the first ~6,000 characters of a page reach the model; sitemap indexes are followed for at most 3 child sitemaps (article-like ones first); the banned-phrase list and the number check are heuristics (English), which is why the second model call exists; a live Gemini / Buffer run has not been exercised; Google retires Gemini models over time (`gemini-2.5-flash` stopped working for new keys in November 2026, which is why a run can report “model not found”). The default is *Auto* — the newest Flash model the key lists; *Overview → Gemini model → Refresh list* shows every model the key can use, and you can pick one; Buffer has no documented draft mode (approval is held inside DCE); engagement read-back is not implemented; the schedule needs DCE to be open.

## Brand

Colours `#4570B6` (primary), `#CAEBFB`, `#231F20`, `#FFFFFF`; Jost (bundled, variable weight). The application icon is the
real VierApparatus `icon.svg` from the website project; the UI follows the website's tokens (blue primary buttons → ink on
hover, sky table headers, 3 px blue focus rings).
