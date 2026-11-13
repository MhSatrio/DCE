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

| Suite | Command | Covers |
|---|---|---|
| Unit (142) | `npm test` | automations (what each connection allows, the website-event gate, presets, templates and escaping, schedules, OpenAPI operations, migration of the earlier shapes), website connector (placeholders and prompt, checking Gemini's answer, reading events and pages, the HTTP helper's host / redirect / scheme rules), linked / synced fields (both directions, delete, unlink), AES-GCM vault round-trip + tamper detection, automation timing / trigger semantics / GraphQL escaping, safe expressions & injection attempts, **content pipeline** (sitemap / RSS / HTML parsing, guardrail rules, write → check → rewrite loop with fake models, schedule / retry rules, never-twice selection, robots.txt matching, private-address blocking, 1 request/second throttling against a local server), bindings, text fitting, `.njs` round-trip / validation / migration, scene resolution, SVG/PDF structure, CSV parser, filter operators, importer, document model (group, reorder, align, DnD) |
| Editor e2e (30) | `npm run build && node tests/e2e/editor.mjs` | real mouse/keyboard: draw every tool, type into text, bind fields, constraints, undo/redo, snapping, layers (hide, lock, rename, DnD), group/ungroup, copy/paste, pen, zoom, data preview, save → reload → persisted |
| Data + batch e2e (30) | `node tests/e2e/batch.mjs` | CSV import with bad rows, inline edit, filter builder, bulk update, CSV/JSON export + re-import, malformed CSV, custom field, sanitised Markdown, asset upload/delete, `.njs` export → import identical, single PNG, JPEG/SVG/HTML/PDF (single + multi-page), 100-record ZIP, pause/resume/cancel, failed-record inspect → fix → retry, missing values, Python bundle actually executed, sample-data removal, WOFF2 font import, revert-to-saved, offline reload |
| Tables / connections / automations e2e (16) | `node tests/e2e/connect.mjs` | starts a **mock Buffer API** and the **real relay**: relay CORS / auth rules, encrypted-at-rest keys (checked in IndexedDB), reveal / copy / replace menu, account picker, channel discovery, custom table + every field type, two-sided links, synced fields in both directions, delete-with-dependents, automation payload / schedule / status update / no duplicates, failure + back-off, safe enabling, pause, persistence after reload |
| Content pipeline e2e (26) | `node tests/e2e/pipeline.mjs` | mock website (sitemap, robots.txt, thin / disallowed / overreaching pages), **mock Gemini**, **mock Buffer**, the **real relay**: seeded sources can be deleted and a new one added, encrypted Gemini key, wrong key → clear alert and nothing sent, a robots-disallowed page is never requested and requests are ≥ 1 s apart, thin page / fact-check failure / banned wording are rejected and the next page is used, quota error retried, simulation never calls Buffer, approval holds until Approve, an edit that breaks a rule cannot be sent, reject, auto-publish with fixed time, expired Buffer token, simulation-only source, site down, "nothing new", daily schedule runs once, exports contain no secrets, model list / retired-model alert / Auto fix, live run log and Stop (leave the page and come back), channel list from Buffer (new channels saved, removed ones flagged, ids encrypted), sync to a table (one row per post, no duplicates) |
| Website connector e2e (7) | `node tests/e2e/website.mjs` | mock website (connector API, article page), **mock Gemini**, the **real relay** and the real app: connection + permissions test, preset workflow, article event → post, row, Gemini fill, sync, render, a second check repeats nothing, run log with each step |
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
* The **Batch Runner renders from the Content Plan only**; custom tables feed automations, filters and exports but not (yet) template rendering. The CSV/JSON *import wizard* is Content-Plan-only — for custom tables paste from a spreadsheet.
* **Formula and rollup/count fields** are not implemented (synced fields cover mirroring); a link mirrors the first linked record.
* **Automations only run while DCE is open** in a browser tab (and catch up when it is opened). Unattended 24/7 scheduling would need a server. Buffer (publishing) and Gemini (writing) are built in; other services would be new action types.
* The Buffer GraphQL schema was taken from Buffer's public docs (`createPost`, `account.organizations`, `channels`); it was exercised against a mock of that schema, **not against a live Buffer account** — use *Test connection* and a *dry run* first.

* **Content pipeline:** Stop cannot take back a Buffer request that has already been sent; the sync to a table is one-way; the channel list is read when the page opens or when you press Refresh (it is not live); pages that need JavaScript to show their text are not supported (no headless browser by design); only the first ~6,000 characters of a page reach the model; sitemap indexes are followed for at most 3 child sitemaps (article-like ones first); the banned-phrase list and the number check are heuristics (English), which is why the second model call exists; a live Gemini / Buffer run has not been exercised; Google retires Gemini models over time (`gemini-2.5-flash` stopped working for new keys in November 2026, which is why a run can report “model not found”). The default is *Auto* — the newest Flash model the key lists; *Overview → Gemini model → Refresh list* shows every model the key can use, and you can pick one; Buffer has no documented draft mode (approval is held inside DCE); engagement read-back is not implemented; the schedule needs DCE to be open.

## Brand

Colours `#4570B6` (primary), `#CAEBFB`, `#231F20`, `#FFFFFF`; Jost (bundled, variable weight). The application icon is the
real VierApparatus `icon.svg` from the website project; the UI follows the website's tokens (blue primary buttons → ink on
hover, sky table headers, 3 px blue focus rings).
