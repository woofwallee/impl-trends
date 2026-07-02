# Implementation Trends — web app

A static, client-side dashboard. Andrew imports his monthly HubSpot Implementation
export and sees the trends HubSpot can't produce for a custom object. **All data
stays in the browser — nothing is uploaded anywhere.** No server, no API, no login.

Files: `index.html`, `app.js`, and the `vendor/` folder (Chart.js + html2canvas,
bundled locally so the app has no runtime dependency and works offline). Push all of it.

## What it shows
- **Open backlog** (by type) — trended. Backfilled from a single import.
- **Speed to go-live** (avg PO → live/complete, by go-live month) — trended. Backfilled.
- **Where work is piling up** — top stages by avg days sitting, with month-over-month
  change. Point-in-time; builds up as imports accumulate.

## The export the app expects (records, not a report)
CRM → Implementations → All records → Export → **CSV**, include **All properties on
records**, open **and** closed, no filters. Name it `implementations_YYYY-MM-DD.csv`.
The Import screen lists the exact required fields and the data assumptions
(durations in HubSpot milliseconds; live **date** = customer live; **stage** move
to Live/Complete = exited the pipeline).

The app ships with bundled sample data (`sample-data.csv`) that auto-loads on
first launch for demos — Reset clears it, then import a real export.

Any date range works — the pickers are day-level (weeks, quarters, custom), and
every panel recomputes with a comparison against the equal-length prior period.

## Monthly use (Andrew)
1. In HubSpot, export all Implementation records (open + closed) with these columns,
   saved as `implementations_YYYY-MM-01.csv`:
   Record ID · Implementation Name · Implementation Type · Implementation pipeline stage ·
   Time in current stage · Date entered current stage · PO Date · Implementation Live/Complete ·
   Duration between PO date and Live/Complete Date · Object create date/time
2. Open the app, drag the CSV onto the import box.
3. Dashboard updates instantly. Re-importing a month replaces it.
4. **Back up history** saves a JSON file — keep it in GD's own Drive so history
   survives a browser/computer change (Restore loads it back).

## Deploy to GitHub Pages (Ethan)
1. New **public** repo (public keeps Pages free; the repo holds only code, no GD data),
   e.g. `implementation-trends`.
2. Put `index.html`, `app.js`, and the `vendor/` folder at the repo root and push.
3. Repo → Settings → Pages → Source = `main` / root.
4. Live at `https://woofwallee.github.io/implementation-trends/`. Send Andrew the link.

Works offline too — the file can just be opened locally if a URL is ever blocked.

## Adjusting to the real export
If HubSpot's export headers differ from the defaults, edit the `CONFIG.columns`
map at the top of `app.js` (left = internal name, right = exact export header).
Duration columns are assumed to be milliseconds; if the real export gives days or a
string, adjust `parseDurationDays` / `CONFIG.durationColsMs`. This is the one thing
to confirm against a real export.

## Governance note
This is a GD business tool built with a personal AI assistant. Before it goes
"official," clear it with your Team Manager / AI Governance Committee per GD's AI
Acceptable Use Policy, and disclose AI involvement. Keeping it client-side with no
data upload and no API token is deliberate — it minimizes the HIPAA surface.
