# Shift Tracker — Overtime & Subsistence

A private, device-local tool for ambulance paramedics (NAS Ireland, and UK crews)
to work out **overtime** and **subsistence** per shift, build a personal record,
and transcribe the figures onto the paper timesheet.

Everything runs and stays on the user's own device. Nothing is uploaded or sent
to a server.

## The core idea

> **The app assists, the user asserts.**

The app produces defensible computed figures (overtime hours, subsistence tiers,
money totals). The user checks them and writes them onto the paper timesheet.
Nothing is auto-submitted to management. Overtime hours are the primary figure;
money is secondary and informational.

## What it does

- **Shift entry** — record a shift's calls (CAD number, start, clear), the roster
  pattern, and the actual back-at-base time.
- **Engine** — computes overtime (rounded, from actual return vs roster end) and
  subsistence (continuous away-time, tiered, higher tier replaces lower).
- **Roster** — a repeating cycle plus one-off, non-repeating **exceptions**
  (OT, swap, annual leave, sick) shown on a month calendar.
- **Settings** — user-defined shift patterns, subsistence tiers (hours + label +
  value), manual subsistence payments (e.g. B&B), currency, hourly wage and
  overtime rates (with a default that auto-applies).
- **My weeks** — shifts grouped by week-ending Sunday, with subsistence money
  totals per week and per month; copy-to-clipboard for the paysheet.
- **MDT scan** — on-device OCR (Tesseract) reads an MDT incident photo, extracts
  AS1 + 7-digit CADs and their HH:MM:SS time pairs, and drops them into the
  call list after the user confirms. Runs locally; nothing leaves the phone.
- **Backup & restore** — export/import a JSON backup to the user's own device,
  optionally excluding incident (CAD) numbers.

## Layout

```
web/shift-tracker.html   the app (single self-contained file)
engine/engine.js         the portable calculation engine (pure JS, no UI)
engine/engine.test.js    engine unit tests
stress-test.js           multi-user, multi-month stress harness
package.json             npm config (test script)
```

## Running

The app is a single HTML file; open web/shift-tracker.html in a browser, or
host the folder (e.g. GitHub Pages). It needs no build step and fetches nothing
at runtime, except the OCR engine for the MDT scan, which currently loads from a
CDN (to be bundled locally before going offline/native).

Tests:

```
npm test            # engine unit tests
node stress-test.js # 3-user, 60-month simulation
```

## Principles

- Engine logic is tested in Node before being wired to the UI.
- Design changes are prototyped statically, then ported in one pass.
- Never invent operational or policy data (rules, rates). Surface what the user
  asserts; compute defensible figures from it.
- Device-local by default. Keep the privacy position strong.

## On the horizon

- Bundle the OCR engine locally for true offline use.
- PWA (manifest + service worker), then Capacitor wrap for the app stores.
