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
- `testCapacityCheck {data}` — dry-run capacity decision against
  `sim_bookings` (dummy data). Never calls Smoobu. Used for testing the
  threshold/override logic safely.
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
- `capacity-test.html` — fires `testCapacityCheck` repeatedly against dummy
  data to prove the threshold/alert logic works before trusting it live.
- `webhook-live-test.html` — fires the REAL `newReservation` action. Has a
  confirm dialog because it can actually call `blockDates` for real.
- `price-block-console.html` — Price Setter (flat/sequence/random pricing
  across a date range, editable preview, apply) + block/rate console,
  listings grouped by property, actions retry once automatically then offer
  a manual retry button on permanent failure.
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
- `testCapacityCheck` reads from `sim_bookings` (dummy data).
  `handleSmoobuWebhook` reads live Smoobu occupancy via `getBookings`. These
  are deliberately separate — never let a real decision be made from dummy
  data, and never expect the dummy-data test path to reflect real Smoobu
  state.
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
- **Our DB is the source of truth.** Real Smoobu bookings live in `sim_bookings` with id `smoobu-<smoobu id>` (details.price = host earning = price - commission-included). `newReservation` records them; `syncLiveBookings {from,to}` and the tracker's Settings > Import from Smoobu backfill missing ones. Smoobu's list includes cancelled bookings (`type: cancellation`); imports keep them, Duke cancels manually.
- `handleSmoobuWebhook` now counts capacity from `sim_bookings` (not live Smoobu), then blocks via Smoobu. `getOccupiedApartments` ignores Smoobu cancellations.
- `cancelReservation`/`deleteReservation` webhooks archive the booking into `cancelled_bookings` (restorable: `getCancelledBookings`, `restoreBooking`) and raise an alert; `updateReservation` only alerts. Blocked/placeholder bookings are ignored.
- Alerts live in meta key `alerts` (`getAlerts`, `dismissAlert`); shown as the red bar on the tracker.
- Pages: `sim-booking-tracker.html`, `price-block.html` (tabs: Price Setter / Block Dates), `earnings.html`, `import-bookings.html` (standalone copy of the tracker's import dialog), `capacity-test.html`, `webhook-live-test.html`.
- **Auto-delete (live):** on `newReservation` the worker saves the booking, then DELETEs it from Smoobu (`/api/reservations/{id}`) so the calendar opens online, marking `details.smoobu_deleted_at` first; cancel webhooks for that id within 1h are ignored (no archive, no alert). It never deletes unless the DB save succeeded. Capacity check then runs on our DB; blocking hits all free listings of the property.
- Telegram credentials are Cloudflare secrets (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`), no longer in code. `updateReservation`: unknown id = treated as a new reservation; known id = our copy updated (manual calendar edits kept), capacity re-checked, quietly re-deleted from Smoobu.
- **Capacity audit:** cron every 15 min (`wrangler.toml` [triggers]) + `runAudit` on demand and after tracker edits. Counts capacity from our DB (60 days, settings in meta `audit_settings`: autoBlock default off, days), and gets open/closed per listing from Smoobu's rates endpoint (`getRates`, one call; array params must be sent as `apartments%5B0%5D=id` — plain `apartments[]` gives 401). `available:0` also covers linked/related units, which the reservations list misses. Webhook block calls are now checked; failures raise an error alert + Telegram.
- **Stuck-block warning (alert only):** the audit also flags dates where our DB is under capacity but a block we created (guest 'Blocked Period' / placeholder email) is still on Smoobu (alert type `stuck`, Telegram too). It never unblocks anything.
