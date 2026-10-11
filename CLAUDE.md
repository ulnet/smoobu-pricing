# Smoobu Capacity / Pricing / Blocking System

## What this is
Duke manages short-term rental properties on Smoobu. Each physical property
(e.g. "Property 1", "Graville") contains several rooms, and each room is its
own Smoobu listing with its own listing ID. The goal: when a new reservation
comes in on any listing, look up which property it belongs to, check that
property's occupancy against its own threshold, and if hit, block the rest
of that property's listings on Smoobu for those dates — automatically.

The old system (`Code.gs`, a Google Apps Script bound to a Google Sheet) did
this with one global threshold across the whole portfolio, no per-property
logic, and no live webhook. That system is being retired. This repo is its
replacement: a Cloudflare Worker + D1 database, with per-property thresholds,
per-day overrides, and a real live Smoobu webhook already wired and firing.

## Architecture
- One Cloudflare Worker: `smoobu-proxy-v2` (`worker.js`), ES module format,
  `export default { async fetch(request, env) {...} }`.
- One D1 database: `smoobu_db`, bound to the Worker as `env.DB`.
- Smoobu API access is HMAC-signed server-side in the Worker
  (`env.SMOOBU_API_KEY` / `env.SMOOBU_API_SECRET`, Cloudflare secret bindings
  — never in code).
- Every client-side tool is a single self-contained HTML file: vanilla JS,
  no build step, no framework. Deployed as static files or opened directly
  in a phone browser. Each POSTs `{action, ...}` as JSON (sent as
  `text/plain;charset=utf-8` to dodge CORS preflight — do not change this to
  `application/json` without also checking every page's fetch calls, we hit
  a real bug here once already) to the Worker and gets `{...}` JSON back.
- CORS is wide open (`Access-Control-Allow-Origin: *`), no API secret
  required to call the Worker itself — only the Smoobu-facing calls are
  authenticated, via the HMAC signing inside the Worker.

## D1 schema
`smoobu_db` also contains tables from an unrelated project (`users`, `apps`,
`admin_sessions`, `settings`, `menu_items`, `pages`) sharing the same
database — ignore those. Ours:

- **`sim_bookings`** — dummy/test booking data for exercising the UI and
  capacity logic without touching anything real. Columns: `id`,
  `reference_id`, `apartment_id`/`apartment_name` (original, untouched),
  `arrival`/`departure` (original), `m_apartment_id`/`m_apartment_name`
  (simulated/editable), `m_arrival`/`m_departure` (simulated/editable),
  `guest_name`, `channel`, `room_number`, `details` (JSON: contact, note,
  guests, actual_review{rating,text}, host_review{rating,text}),
  `created_at`.
- **`meta`** — generic key/value store (`key` TEXT PRIMARY KEY, `value` TEXT
  JSON), used instead of a new table per small concept. Keys in use:
  - `apartments` → array of `{id, name, listingIds[], threshold}`. This is
    the property model — `listingIds` are Smoobu listing IDs (strings)
    belonging to that property. A listing can only belong to ONE property;
    this is enforced in the UI, not the database.
  - `manual_listings` → array of `{id, name}` for listings not pulled from
    Smoobu's own API (manually defined test/placeholder listings).
- **`date_overrides`** — per-property, per-date threshold override + a
  global per-day note. Columns: `apartment_id` (real property id, or the
  literal string `__day__` as a sentinel meaning "this row is a global note,
  not tied to one property"), `date`, `threshold_override`, `notes`.
  Primary key `(apartment_id, date)`. Rows with a past date are deleted
  automatically on every read (no cron needed).
- **`expenses`** — for profit tracking. `id`, `date`, `amount`,
  `description`, `property_id` (optional), `created_at`.
- **`bookings`** — pre-existing table from before this project started,
  used by `insertBooking()`. Not part of the current design; ignore unless
  specifically asked about it.

## Worker actions (`worker.js`)
GET supports `action=getSimBookings` and `action=getApartments` as query
params. Everything else is POST with `{action, ...}`:

- `getSimBookings`, `addSimBooking`, `updateSimBooking` (accepts a partial
  patch — only sends the fields provided), `deleteSimBooking`
- `getMeta {key}`, `setMeta {key, value}`
- `getApartments` (real Smoobu listings, live), `getBookings {params}`,
  `blockDates {apartmentId, arrivalDate, departureDate}`,
  `setRate {apartmentId, from, to, price}`
- `getDateOverrides`, `setDateOverride {apartment_id, date,
  threshold_override, notes}`
- `newReservation {data}` — **the real, live webhook handler.**
  `handleSmoobuWebhook()`. Resolves the listing to its property, checks
  live Smoobu occupancy for that property's listings (NOT `sim_bookings`),
  and calls `blockDates` for real if threshold is hit. Sends a Telegram
  alert on an actual block. Skips: Smoobu-flagged blocked periods, our own
  synthetic blocks (`email === 'blocked@placeholder.local'`), and anything
  with no guest name (treated as test/incomplete data).
- `getExpenses`, `addExpense {date, amount, description, property_id}`,
  `deleteExpense {id}`

## Files
- `worker.js` — the Worker, deploy via Cloudflare dashboard (or wrangler,
  see below).
- `sim-booking-tracker.html` — the main test/simulation UI: Properties
  management (name, listing IDs, threshold), a rolling 31-day calendar
  (Grand Total row, per-property subtotal rows, per-day threshold
  overrides/notes via a shared modal), Add/Edit Booking modals supporting
  multiple date ranges per guest in one go.
- `earnings.html` — earnings by month and month-to-date (allocates each
  booking's total price evenly across its nights, then sums whichever
  nights fall in the selected range), per-property breakdown, a simple
  daily bar chart, and an expenses table for profit = earnings - expenses.

## Conventions (apply to any code written in this project)
- Mark major sections with `// ### 1 --- (brief comment)`; sub-steps use
  letter suffixes (`// ### 2b ---`). Keep the dash separator to 2-3 dashes.
- No inline explanatory comments beyond the section tags.
- Short variable names for local/throwaway vars; descriptive names only for
  things reused across scopes.
- Minimal blank-line padding — blank lines only between numbered sections.
- For small changes, prefer a Find/Replace-style patch over regenerating a
  whole file. Full-file rewrites are for genuinely broad changes.
- Don't explain process while writing code — explain after it's ready.
- Only write/modify code when explicitly asked to.

## Known gotchas (don't relearn these the hard way)
- A `204` response must never have a body — an early version of the
  Worker's OPTIONS handler violated this, which silently broke every POST
  from a browser (preflight failure reads as a generic "Failed to fetch"
  with zero useful detail). Fixed; don't reintroduce.
- Never let a real blocking decision be made from simulator data: rows with id `simgen-…` (written by the pricing simulator) are excluded from every capacity count (webhook, G.Total, audit) and hidden in the tracker.
- `table-layout:fixed` sizes columns off the FIRST row's cells — if a
  calendar-style table has a colspan'd header row first, use an explicit
  `<colgroup>` or columns render inconsistent widths.
- A cell's `overflow:hidden` will clip an absolutely-positioned child even
  if that child is sized to extend beyond the cell — if you want a label to
  visually span multiple cells, give the cell itself `overflow:visible` and
  let the actual ellipsis/width logic live on an inline-block child.

## Status / what's live right now
The real Smoobu webhook is registered and pointed at this Worker, and
`handleSmoobuWebhook` runs live — it can and will call Smoobu's block API
for real when a property's threshold is hit. Telegram alerts fire on any
real block. `Code.gs` is being manually disabled by Duke; don't assume it's
still receiving traffic. No `wrangler`/CLI deployment set up yet — that's a
first task worth doing in Claude Code rather than continuing to hand-paste
into the Cloudflare dashboard editor.

## Updates since the notes above (supersede anything conflicting)
- Deploy with wrangler: `npx wrangler deploy` in this folder (`wrangler.toml` binds `smoobu_db` as `DB`). Run it yourself after worker changes.
- **Our DB is the source of truth.** Real Smoobu bookings live in `sim_bookings` with id `smoobu-<smoobu id>` (details.price = host earning = price - commission-included). `newReservation` records them; `import-bookings.html` (the only import UI; the tracker has none) backfills missing ones. Smoobu's list includes cancelled bookings (`type: cancellation`); imports keep them, Duke cancels manually.
- `handleSmoobuWebhook` now counts capacity from `sim_bookings` (not live Smoobu), then blocks via Smoobu. `getOccupiedApartments` ignores Smoobu cancellations.
- `cancelReservation`/`deleteReservation` webhooks archive the booking into `cancelled_bookings` (restorable: `getCancelledBookings`, `restoreBooking`) and raise an alert; `updateReservation` only alerts. Blocked/placeholder bookings are ignored.
- Alerts live in meta key `alerts` (`getAlerts`, `dismissAlert`); shown as the red bar on the tracker.
- Pages: `sim-booking-tracker.html`, `price-block.html` (tabs: Price Setter / Block Dates), `earnings.html`, `import-bookings.html` (the only import UI), `db-view.html`, `pricing.html`, `shell.html`, plus shared `api.js`.
- **Auto-delete (live):** on `newReservation` the worker saves the booking, then DELETEs it from Smoobu (`/api/reservations/{id}`) so the calendar opens online, marking `details.smoobu_deleted_at` first; cancel webhooks for that id within 1h are ignored (no archive, no alert). It never deletes unless the DB save succeeded. Capacity check then runs on our DB; blocking hits all free listings of the property.
- Telegram credentials are Cloudflare secrets (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`), no longer in code. `updateReservation`: unknown id = treated as a new reservation; known id = our copy updated (manual calendar edits kept), capacity re-checked, quietly re-deleted from Smoobu.
- **Capacity audit:** cron every 15 min (`wrangler.toml` [triggers]) + `runAudit` on demand and after tracker edits. Counts capacity from our DB (60 days, settings in meta `audit_settings`: autoBlock default off, days), and gets open/closed per listing from Smoobu's rates endpoint (`getRates`, one call; array params must be sent as `apartments%5B0%5D=id` — plain `apartments[]` gives 401). `available:0` also covers linked/related units, which the reservations list misses. Webhook block calls are now checked; failures raise an error alert + Telegram.
- **Stuck-block warning (alert only):** the audit also flags dates where our DB is under capacity but a block we created (guest 'Blocked Period' / placeholder email) is still on Smoobu (alert type `stuck`, Telegram too). It never unblocks anything.
- **G.Total (portfolio) threshold:** meta key `global_threshold` ({threshold}), settings dialog in the tracker. Checked independently of each property's own threshold on every reservation (`capacityBlock`'s `global` field) and in the audit (a synthetic `__global__` "property" in `runAudit`); when hit, blocks every free listing across every property. Off when 0/blank.
- **Audit snapshot for the calendar:** `runAudit` now also writes meta key `audit_snapshot` ({risks, stucks}); `getAuditSnapshot` reads it. The tracker shows a ⚠ (capacity full but open on Smoobu) or 🔒 (stuck block) on each property's subtotal cells from this, refreshed after `runAudit` runs.
- **cancelOnSmoobu {id}**: cancels a booking that IS in our `sim_bookings` (id must exist there) on Smoobu, DB untouched. **unblockOnSmoobu {id}**: deletes a Smoobu reservation only after confirming via GET that it's a system block (`is-blocked-booking`/`Blocked Period`/placeholder email) — refuses otherwise. Both used by `import-bookings.html`'s "still live on Smoobu" and "blocked but threshold not met" sections.
- Add Booking's guest-name field now autofills the contact number from that guest's most recent booking (`guestContacts` map, built in `refreshGuestDatalist`).
- Tracker: click two empty calendar cells in the same property to open Add Booking prefilled with that date range (`cellPick`/`emptyCellClick`).
- **Action feedback (tracker):** the generic modal (Add/Edit Booking, Day dialog) now has its own `#modalStatus` line — Save/Delete disable both buttons, show "Saving…"/"Deleting…", and only close the modal ~450ms after a real success; a worker error or validation failure keeps the modal open with the message shown, so nothing silently fails behind the overlay. `onSave`/`onDelete` callbacks must `return` their promise (and can return `{error:'...'}` for client-side validation) for this to work. Manage Properties / property summary reuse the same `#modalStatus`. Reset button (Settings) now disables itself and reports "Resetting…"/"Reset done."/an error via the top status line.
- Fixed `sim-booking-tracker.html`'s `callWorker` back to `text/plain;charset=utf-8` (it had drifted to `application/json`, see the CORS gotcha above) and to read the response as text-then-JSON like the other pages, for consistency.
- **G.Total is derived, not a setting (supersedes the `global_threshold` note above):** its threshold for a date = sum of every property's effective threshold (per-day overrides included). `globalCapacityBlock` runs FIRST in `capacityBlock`; if hit it blocks every free listing portfolio-wide and returns immediately (per-property check skipped). The audit computes the same per-day sum (`globalHit`) and uses it so legitimate global blocks aren't flagged as stuck. The old `global_threshold` meta key and the tracker's "G.Total threshold" button/dialog are gone. Tracker G.Total row shows the summed cap per day (yellow superscript when overrides change it) and turns red when hit.
- Tracker calendar header: compact range label ("1 Oct – 31 Oct", full dates on hover) and a **Today** button that returns the window to the default (starts yesterday). Day dialog has a **Reset to default** button for a property's threshold override.
- **`blockDates` was never routed in the worker's POST handler** (only used internally) — so price-block.html's Block tab and any UI block silently failed with "Unknown or missing action" (and the console logged it as OK). Route added; `price-block.html` now treats `{error}` / non-2xx Smoobu replies as failures (retry once, then Retry button). Smoobu errors come back as `{status, body:{title, detail}}`.
- **`clearThresholdOverrides {date?}`** clears every per-property threshold override (all dates, or one date); day notes kept. Used by Settings > "Reset all thresholds" and the Day dialog's "Reset ALL properties for this day". Tracker: clicking a ⚠ on a property subtotal opens a modal listing that property's full-but-open ranges (from `audit_snapshot`) with "Block selected" (per-range result/error shown, then `runAudit` refreshes the flags).
- **Thresholds UI (supersedes the earlier reset notes):** default threshold per property is edited only in the property summary (tap the property name) and when adding a property; Manage Properties no longer has a threshold column/Save (listing changes autosave with status) and Settings no longer has "Reset all thresholds". Per-date adjustments: tap a day (Day dialog), or tap the **month name** in the calendar header (label is horizontally sticky so you always see the month) → modal with one box per property applying an override across that month's visible days via `setThresholdRange {apartment_id, from, to, threshold}` (value equal to the property default, or null, clears it). `clearThresholdOverrides` is still used by the Day dialog.

## Dynamic pricing engine (pricing.html + pricing/)
- Page: `pricing.html` (tabs: Strategies & apartments / Calendar & overrides / Simulator & save / Live run & log). Drafts live in the browser until **Save as active** (meta keys `pricing_strategies`, `pricing_apartments`, `pricing_calendar`, `pricing_settings`). Sim date/hour/test bookings (`simgen-` ids, shown as blue T) never reach live runs.
- Modules: `engine.js` (pure pricing math), `factors/` (occupancy, pace, leadtime, hourly, dow), `extras/` (calendar season/events, orphan signed %, maxChange, minNotice), `plan.js` (shared plan builder + table setup), `sim.js` (simulation actions, sim_ tables), `run.js` (live runner: `runPricing`, `priceAfterBooking`, `getPricingStatus`), `smoobu.js` (groups changes into rate operations), `snapshot.js` (read-only `smoobu_rate_snapshot`).
- Price order: base x (1 + sum of strategy factors % + calendar season %) x event multiplier, then per listing/date random spread, orphan %, max-change cap (vs Smoobu's current price), notice floor, min/max clamp last. Locks (`price_locks`, per listing, written by Price Setter's lock checkbox) and apartment overrides (`price_overrides`) bypass all of it.
- **Live safety:** engine writes nothing unless `pricing_settings.enabled` AND the apartment's `live` flag (`pricing_apartments[id].live`) are set; otherwise it only logs dry-run rows (`price_log` mode `dry`, deduped via `price_state`). `runPricing` manual action defaults to forceDry; `preview:true` + `draft` returns planned changes and writes nothing. Crons (`wrangler.toml`): `0 * * * *` near (today/tomorrow), `0 3 * * *` far (rest of horizon), `*/15` stays the capacity audit. Booking webhooks and tracker add/update/delete trigger `priceAfterBooking` for that apartment.
- Baseline is Smoobu's current rates (`getRates`); closed/booked nights (`available:0`) are skipped. Writes use POST /api/rates with multiple operations per listing (Smoobu limit 700 requests/min). Failed writes raise an alert + Telegram.
- **Alerts/Telegram/modals are per PROPERTY + date range, never per listing** (a property is closed or open as a whole). `runAudit` packs open/stuck listings into property-level ranges `{prop, propId, from, to, nights, listings, items:[{lid,from,to}]}` (items are only used to know which listings to block); audit_state keys are `P|propId|from|to` / `S|propId|from|to`. Webhook/G.Total block alerts name properties ("all properties blocked: Property 1, Graville"), listing ids only appear in failure detail. The tracker's ⚠ modal lists property ranges and "Block property for selected dates" blocks every item; Import Bookings' "blocked but threshold not met" groups by property+dates and unblocks all underlying blocks.
- **One merged alert per audit run:** `runAudit` now replaces (via `replaceAlerts`) a single `risk` alert and a single `stuck` alert listing every property and date range, and sends ONE Telegram message only when a range is new (auto-block: one summary alert + one Telegram, plus one merged error if some failed). Tracker: the ⚠ "full but open" flag now lives on the **G.Total row** (tap = modal of every property's ranges, grouped by property, with Block selected); property rows keep only the 🔒 stuck flag. G.Total row is lighter than the date row. Under the calendar, `renderNotes()` lists day notes + booking notes from today onward (click a row to jump the calendar).
- **G.Total mode (meta `audit_settings.globalMode`, set in the tracker's Capacity check dialog):** `all` (default; G.Total hit blocks every property, checked first), `propertyFirst` (the full property is blocked by the per-property rule first, then all properties), `off` (G.Total never blocks and is ignored by the audit). Both ⚠ (full but open) and 🔒 (stuck) flags now live on the G.Total row; stuck snapshot entries carry `blocks:[{id,lid,from,to}]` (our Smoobu block reservations) so the 🔒 dialog can "Unblock selected" via `unblockOnSmoobu`. `auditSoon()` (after any manual add/edit/delete/override) re-runs the audit in ~0.7s and auto-opens the ⚠ dialog when that edit produced a new full-but-open range.
- **Blocking rules are two independent switches (supersede `globalMode`):** `audit_settings.blockProperty` (default true: block a property when it reaches its own threshold) and `audit_settings.blockTotal` (default true: block ALL properties when the portfolio total reaches the summed threshold; checked first). Both off = no automatic blocking. The audit's "full" test, G.Total flags and stuck detection follow the same switches; an old `globalMode:'off'` is read as blockTotal=false. Property names can be edited in Manage Properties (name box, saves on change) and the property summary; the property `id` never changes, so overrides/history stay attached.
- **Cleanup + hardening (current):** removed `capacity-test.html`, `webhook-live-test.html`, `README.md`, the `testCapacityCheck` and `syncLiveBookings` actions and the old `global_threshold` meta key. Alerts now live in their own `alerts` table (auto-created, old meta list imported once, pruned to 200). `simgen-` rows never take part in capacity decisions.
- **Access key:** every page loads `api.js` (`apiPost` sends `token`; it asks for the key once per browser, kept in localStorage `api_token`). The worker enforces it only when the secret `API_TOKEN` exists (`wrangler secret put API_TOKEN`; `wrangler secret delete API_TOKEN` turns enforcement off). Exempt: service-binding calls (request host `smoobu-proxy-v2`, i.e. direct-site) and Smoobu's four webhook actions (`newReservation`, `updateReservation`, `cancelReservation`, `deleteReservation`); those can be locked with the secret `WEBHOOK_KEY` once Smoobu's webhook URL is changed to end in `/?k=<key>`.
- **Reset (tracker Settings)** asks for the access key and verifies it with the worker's `checkKey` action (returns `{success, enforced}`; when no `API_TOKEN` secret exists any key passes). The property summary dialog only edits name/threshold now. Notes table uses short dates (`12 Oct`, `'27` suffix only when not this year).
- **gmail-contacts/** restored into the repo as its own deploy unit (`cd gmail-contacts && npx wrangler deploy`; secrets `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and now `GMAIL_ACCOUNT` = the Google account allowed to connect, previously a hard-coded constant). The main worker calls it through the `GMAIL` service binding, fire-and-forget. **The GitHub repo is PUBLIC** — never commit emails, guest data or secrets.
