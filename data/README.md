# Location & drive-time data

`locations.json` holds stations, hospitals, and per-route drive-time standards
used by the engine.

## What the drive-times mean

They are **accepted standard journey times in minutes**, the agreed figures a
crew would claim, normal-traffic driving (return legs, no blue lights). They are
NOT live or GPS times. Precise GPS timing would actually be worse for a claim:
the defensible number is the shared standard everyone agrees on, not a
traffic-adjusted measurement.

Each drive-time carries a `source`:
- `confirmed` — set by a user who knows the route. **Never overwritten by tooling.**
- `estimate`  — derived from OSM coordinates (straight-line x road-factor / avg speed).
                Labelled `unverified`. A starting point only. Correct it to the
                real accepted standard and it becomes `confirmed`.
- `seed`      — placeholder, no data yet.

## Refreshing from OpenStreetMap (free, no API key)

1. Open https://overpass-turbo.eu, paste `overpass-query.txt`, Run.
2. Export the result as GeoJSON to `data/osm-raw.geojson`
   (or curl the query, see the header of overpass-query.txt).
3. Preview the merge:  `node scripts/build-locations.js data/osm-raw.geojson`
   Inspect `data/locations.preview.json`.
4. Commit it:          `node scripts/build-locations.js data/osm-raw.geojson --write`

The merge fills missing coordinates/eircodes, adds new stations/hospitals, and
generates `estimate` drive-times for new pairs. Your `confirmed` routes are
protected on every run.

## Known gaps (honest)

- OSM ambulance-station coverage is community-maintained and incomplete. Treat
  the station list as a seed to verify and extend, not an authoritative roster.
  No official open dataset of NAS station locations exists publicly as of now.
- Hospital coordinates are more reliable; the authoritative source is the HSE
  Health Atlas hospital dataset (geohive.ie) if you want to cross-check.
