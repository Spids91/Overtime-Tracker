# Ambulance Overtime &amp; Subsistence Tracker

A tool for Irish ambulance paramedics (NAS) to track **overtime** and **subsistence**
per shift, building a personal record over time. Built personal-first, with a
multi-user / multi-station data model so it can grow into a product later.

Separate project from Aireva Medic (the PHECC study app). Do not conflate them.

## The core idea

The ambulance MDT (Getac rugged tablet) shows a per-shift list of completed calls,
each with a CAD number, a start time and a clear time. That machine-rendered text
photographs cleanly and can be OCR'd into a reliable call timeline.

But the photo gives the **call timeline only**. It does not contain where the crew
cleared, or when they were physically back at base. Those facts are what actually
determine overtime and subsistence, and only the user knows them. So the stance is:

> **The app assists, the user asserts.**
> The photo builds the skeleton. The user confirms locations and resolves the
> ambiguous gaps. The engine computes. Nothing about money is decided silently.

This is also what makes a claim **defensible**: a record the user confirmed and
stands behind in front of a supervisor or union, never "the algorithm says you're
owed X."

## Architecture (read this before adding features)

```
engine/engine.js        the BRAIN. Pure calculation, no UI, no framework.
engine/engine.test.js   locked results from real shifts. Run before every commit.
web/shift-tracker.html   the SKIN. Gathers inputs, renders engine output. Nothing more.
test-data/               MDT photos + known pay outcomes for verification.
```

**The engine is the portable asset.** It is plain JavaScript that has no idea
whether it runs in a web page, an iPhone, or an Android phone. When this goes
native (React Native / Capacitor), `engine.js` moves across **unchanged** and only
the skin is rebuilt. Keep all rules in the engine. Never let calculation logic
leak into the HTML, or that portability is lost.

The web shell loads the engine with `<script src="../engine/engine.js">`, so there
is a single source of truth. Do not paste a copy of the engine into the page.

## The rules (engine v1)

**Subsistence**
- Away-from-station clock starts at **first call-out**, runs continuously.
- **10-minute grace:** a base visit under 10 minutes does not reset the clock.
- A confirmed **10+ minute** base return is a **full reset**: clock zeroes, a
  fresh away-window starts on the next call-out.
- Each away-window is tiered independently. **The 10h payment replaces the 5h,
  it is not cumulative.**

**Overtime**
- Hours only, no money (sidesteps per-user pay scales).
- = back-at-base time minus rostered end. The last call's clear time is **not**
  the end of shift if they cleared away from base.
- **One round-up at the very end**, to a station increment (0 / 15 / 30 / 60 min),
  always rounding up.

**Gaps the engine cannot resolve**
- The app can never *know* a base return happened, only whether a gap was long
  enough that it *could* have (`gap - driveBack - driveOut >= 10`). Those gaps are
  surfaced as one-tap questions. The engine refuses to produce a final answer
  until every possible-return gap is answered.

## Running the tests

```
node engine/engine.test.js
```

17 assertions across two real shifts and the unit rules. If you change a rule and
a past shift's result changes, the test fails on purpose. Investigate before
committing.

## Open questions (do not treat the rules as final until these are answered)

1. **Subsistence policy wording.** Official definition of "away from station", and
   confirmation the clock starts at first call-out, not leaving the building. This
   is the load-bearing rule and is currently an assumption.
2. **Overtime mechanics.** Confirmed: past rostered end, round up, station-set
   increment. Confirm there are no bands or minimums beyond that.
3. **Subsistence shown as tier/count vs euro amount.** Currently tier/count, to
   match the overtime "hours only" decision.
4. **Drive-time table.** Hand-built for known hospitals (more reliable than a
   routing API for a personal tool). A routing API is only for the wider product.
5. Eircode list (hospitals) + station locations, to be added.

## Locations &amp; drive-times (`data/`)

Drive-times are **accepted standard journey times** (the agreed figure a crew
claims, normal-traffic return-leg driving), not GPS times. See `data/README.md`.

- `data/locations.json` — stations, hospitals, per-route standards.
- `data/overpass-query.txt` — free OSM pull (no API key) to seed the national list.
- `scripts/build-locations.js` — merges OSM data in, derives **labelled estimate**
  drive-times, and **never overwrites a `confirmed` route**. User knowledge wins.

A routing API is deliberately NOT used: it costs money and produces precise
traffic-adjusted times, which is the opposite of the defensible shared standard a
claim needs. Estimates from coordinates are rough and labelled `unverified`; the
user corrects them to the real accepted standard.

## CAD number handling (data protection)

A CAD number plus shift date and call times is **personal data** under GDPR (an
indirect identifier the HSE/NAS can resolve to a specific 999 call and patient),
even though a member of the public cannot look it up without system access.

Rules this app follows:
- CAD numbers are shown to the user while they work the shift (they need them for
  the official timesheet), then **deleted, not retained**. The overtime/subsistence
  maths never needs the CAD number, only times and locations.
- No CAD numbers in anything that leaves the device without a lawful basis: no
  analytics, no logs, no cloud sync. When OCR is added, the photo goes to the
  vision API with zero server-side retention and is not stored.
- Releasing to other paramedics makes you a data controller. Get data-protection
  advice (privacy notice, lawful basis, DPC guidance) BEFORE multi-user launch.
  Health-adjacent data raises the bar; this is flagged, not yet handled.

## OCR (not built yet, deliberately)

Manual entry first, to prove the money maths before adding a layer that can misread
a digit. The MDT photos parse cleanly (see `test-data/`). When OCR is added it must
land in editable fields for user confirmation, never feed the engine directly, and
the API key must live in a backend proxy, never in this repo.

## Principles

- Never invent operational or policy data (rules, rates, drive times). Surface what
  is known, let the domain expert confirm against official policy.
- Anything that computes money owed by an employer must be defensible.
- Build the thing used every shift first. Prove the engine. Then generalise.
