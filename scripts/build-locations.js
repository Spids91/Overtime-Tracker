#!/usr/bin/env node
/* ============================================================================
   build-locations.js
   Merge an OSM Overpass export (GeoJSON or raw Overpass JSON) into
   data/locations.json. Adds stations and hospitals with coordinates, and
   derives ESTIMATE drive-times for station<->hospital pairs.

   GUARANTEES (the whole point):
   - A driveTime with source "confirmed" is NEVER touched. User knowledge wins.
   - Derived times are written with source "estimate" and a clear flag, so the
     UI can show them as unverified. They are starting points, not facts.
   - Estimate = straight-line km * ROAD_FACTOR / AVG_KMH, rounded. This is
     deliberately rough and labelled as such. Real accepted standards come from
     the user, not from this number.

   USAGE: node scripts/build-locations.js <osm-file> [--write]
   Without --write it prints a summary and writes locations.preview.json so you
   can inspect before committing. With --write it updates data/locations.json.
============================================================================ */
const fs = require('fs');
const path = require('path');

const ROAD_FACTOR = 1.35;   // straight-line -> road distance fudge (Irish roads, mixed)
const AVG_KMH = 70;         // normal-traffic average incl. towns + motorway, return legs

const here = path.join(__dirname, '..', 'data');
const locPath = path.join(here, 'locations.json');

const osmFile = process.argv[2];
const doWrite = process.argv.includes('--write');
if (!osmFile) { console.error('Usage: node scripts/build-locations.js <osm-file> [--write]'); process.exit(1); }

const loc = JSON.parse(fs.readFileSync(locPath, 'utf8'));
const raw = JSON.parse(fs.readFileSync(osmFile, 'utf8'));

/* ---- normalize OSM input (accept GeoJSON or Overpass JSON) ---------------- */
function extractElements(raw) {
  if (raw.elements) { // Overpass JSON
    return raw.elements.map(e => ({
      tags: e.tags || {},
      lat: e.lat ?? e.center?.lat ?? null,
      lng: e.lon ?? e.center?.lon ?? null,
    }));
  }
  if (raw.features) { // GeoJSON
    return raw.features.map(f => {
      let lat = null, lng = null;
      const g = f.geometry || {};
      if (g.type === 'Point') { [lng, lat] = g.coordinates; }
      else if (g.coordinates) { // polygon/line: use first coord as rough center
        const flat = g.coordinates.flat(Infinity);
        lng = flat[0]; lat = flat[1];
      }
      return { tags: f.properties || {}, lat, lng };
    });
  }
  return [];
}

const elements = extractElements(raw);

/* ---- classify + filter to Republic (rough longitude/name guard) ---------- */
// NI is mostly north of ~54.0 lat AND specific counties; we keep it simple and
// flag rather than hard-drop, so nothing is silently lost.
function isLikelyNI(tags, lat) {
  const addr = (tags['addr:county'] || tags['is_in:county'] || '').toLowerCase();
  const niCounties = ['antrim','armagh','down','fermanagh','londonderry','derry','tyrone'];
  return niCounties.some(c => addr.includes(c));
}

const stations = [], hospitals = [];
for (const el of elements) {
  const t = el.tags;
  const amenity = t.amenity;
  const name = t.name || t['name:en'] || null;
  if (!name || el.lat == null) continue;
  const rec = {
    name,
    eircode: t['addr:postcode'] || null,
    lat: round5(el.lat), lng: round5(el.lng),
    ni_flag: isLikelyNI(t, el.lat) || undefined,
    source: 'osm',
  };
  if (amenity === 'ambulance_station') stations.push(rec);
  else if (amenity === 'hospital') {
    rec.ed = (t.emergency === 'yes') || undefined;
    hospitals.push(rec);
  }
}

/* ---- merge: match by name fuzzily, else add new --------------------------- */
function slug(s){ return s.toLowerCase().replace(/[^a-z0-9]+/g,''); }
function mergeInto(existingArr, incoming, prefix) {
  let added = 0, matched = 0;
  for (const inc of incoming) {
    const hit = existingArr.find(e => slug(e.name).includes(slug(inc.name)) || slug(inc.name).includes(slug(e.name)));
    if (hit) {
      // fill coords/eircode ONLY if we don't already have them; never downgrade
      if (hit.lat == null && inc.lat != null) { hit.lat = inc.lat; hit.lng = inc.lng; }
      if (!hit.eircode && inc.eircode) hit.eircode = inc.eircode;
      if (hit.source === 'seed') hit.source = 'osm-matched';
      matched++;
    } else {
      existingArr.push({ id: `${prefix}_${slug(inc.name).slice(0,24)}`, ...inc });
      added++;
    }
  }
  return { added, matched };
}

const sRes = mergeInto(loc.stations, stations, 'stn');
const hRes = mergeInto(loc.hospitals, hospitals, 'hosp');

/* ---- derive ESTIMATE drive-times for station<->hospital pairs ------------- */
function haversineKm(a, b) {
  const R = 6371, toR = d => d * Math.PI / 180;
  const dLat = toR(b.lat - a.lat), dLng = toR(b.lng - a.lng);
  const s = Math.sin(dLat/2)**2 + Math.cos(toR(a.lat))*Math.cos(toR(b.lat))*Math.sin(dLng/2)**2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
function estimateMinutes(a, b) {
  const km = haversineKm(a, b) * ROAD_FACTOR;
  return Math.round(km / AVG_KMH * 60);
}

const existingPairs = new Set(loc.driveTimes.map(d => `${d.from}->${d.to}`));
let estAdded = 0, protectedCount = 0;
for (const stn of loc.stations) {
  if (stn.lat == null) continue;
  for (const hosp of loc.hospitals) {
    if (hosp.lat == null) continue;
    const key = `${stn.id}->${hosp.id}`;
    const existing = loc.driveTimes.find(d => d.from === stn.id && d.to === hosp.id);
    if (existing && existing.source === 'confirmed') { protectedCount++; continue; } // NEVER overwrite
    const mins = estimateMinutes(stn, hosp);
    if (existing) { existing.minutes = mins; existing.source = 'estimate'; existing.flag = 'unverified'; }
    else { loc.driveTimes.push({ from: stn.id, to: hosp.id, minutes: mins, source: 'estimate', flag: 'unverified' }); estAdded++; }
  }
}

function round5(n){ return n == null ? null : Math.round(n * 1e5) / 1e5; }

/* ---- output --------------------------------------------------------------- */
const summary = {
  stations: { matched: sRes.matched, added: sRes.added, total: loc.stations.length },
  hospitals: { matched: hRes.matched, added: hRes.added, total: loc.hospitals.length },
  driveTimes: { confirmed_protected: protectedCount, estimates_added: estAdded, total: loc.driveTimes.length },
};
console.log(JSON.stringify(summary, null, 2));
console.log(`\nConfirmed routes left untouched: ${protectedCount}. Estimates are labelled "unverified".`);

const outPath = doWrite ? locPath : path.join(here, 'locations.preview.json');
fs.writeFileSync(outPath, JSON.stringify(loc, null, 2));
console.log(`\nWrote ${doWrite ? 'data/locations.json (committed)' : 'data/locations.preview.json (preview only — inspect, then re-run with --write)'}`);
