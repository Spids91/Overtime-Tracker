/* ============================================================================
   SHIFT ENGINE  v1
   Pure calculation. No DOM, no UI, no framework. Plain JS in, plain object out.
   This is the file that moves to React Native / Capacitor UNCHANGED when the
   project goes native. The brain. The UI is a swappable skin around it.

   Rules implemented (all confirmed with Keith):
   - Subsistence away-clock starts at FIRST CALL-OUT, runs continuously.
   - 10-minute grace: a base visit under 10 min does NOT reset the clock.
   - A confirmed 10+ min base return is a FULL RESET: clock zeroes, a fresh
     away-window starts on the next call-out.
   - Each away-window is tiered independently. 10h REPLACES 5h, not cumulative.
   - Overtime = back-at-base minus rostered end, ONE round-up at the very end,
     station increment (0/15/30/60), always rounds UP.
   - The app can never KNOW a base return happened, only whether the gap was long
     enough that it COULD have. Those gaps are surfaced as questions; the engine
     will not compute a final answer until every possible-gap is answered.
============================================================================ */

const GRACE_MIN = 10;       // minimum minutes at base to count as a return
const TIER5_MIN = 300;      // 5h
const TIER10_MIN = 600;     // 10h
const MAX_CALL_MIN = 480;   // 8h: a single call longer than this is almost certainly a mistyped time

/* ---- time helpers --------------------------------------------------------- */
// "HH:MM:SS" or "HH:MM" -> minutes from midnight (float, seconds preserved)
function parseTime(t) {
  if (!t) return null;
  const p = t.split(':').map(Number);
  return p[0] * 60 + p[1] + (p[2] ? p[2] / 60 : 0);
}
// Given a flat array of minute values in intended chronological order, add 1440
// each time the sequence steps backwards, so an overnight shift stays monotonic.
function unwrap(seq) {
  const out = [];
  let add = 0, prev = -Infinity;
  for (const v of seq) {
    let x = v + add;
    if (x < prev) { add += 1440; x = v + add; }
    out.push(x);
    prev = x;
  }
  return out;
}
function roundUp(min, inc) { return inc ? Math.ceil(min / inc) * inc : min; }

/* ---- gap analysis --------------------------------------------------------- */
// For each consecutive pair of calls, if there's a gap of GRACE_MIN (10 min) or
// more between one call clearing and the next starting, we ask the user "did you
// get back to base and stand down 10+ min?". We don't try to guess from drive
// distances whether a return was physically possible: some bases sit right beside
// a hospital, so even a short gap can be a genuine return. Asking on every real
// gap keeps the call with the user, who actually knows, and ensures no qualifying
// subsistence break is silently missed. This is "app assists, user asserts".
function analyzeGaps(events) {
  const gaps = [];
  for (let i = 0; i < events.length - 1; i++) {
    const clearAt = events[i].clearM;
    const nextStart = events[i + 1].startM;
    const gap = nextStart - clearAt;
    const possible = gap >= GRACE_MIN;     // any gap of 10+ min is worth asking about
    gaps.push({ index: i, clearAt, nextStart, gap, possible });
  }
  return gaps;
}

/* ---- main compute --------------------------------------------------------- */
/*
  Input shape:
  {
    calls:       [{ cad, start:"HH:MM:SS", clear:"HH:MM:SS", loc }, ...]  (time order)
    rosterStart: "HH:MM",
    rosterEnd:   "HH:MM",
    backAtBase:  "HH:MM:SS" | null,   // final leg; if null, last clear is used
    otRoundInc:  0|15|30|60,
    gapAnswers:  { gapIndex: "yes"|"no" }
  }

  Output shape:
  {
    ok: boolean,
    needAnswers: [gap, ...],      // possible gaps not yet answered (ok=false if any)
    error: string | null,
    awayWindows: [{ start, end, durMin, tier:0|5|10 }],
    subsistence: { count5, count10, summary },
    overtime:    { rawMin, roundedMin, hours, rosterEndM, backM },
    ledger:      [{ atMin, text, kind }],   // human-readable trace
    events:      [...]                       // normalized, unwrapped
  }
  All *M values are minutes-from-first-callout-midnight (unwrapped).
*/
function computeShift(input) {
  const valid = (input.calls || []).filter(c => c.start && c.clear);
  if (!valid.length) return fail('Add at least one call with start and clear times.');
  if (!input.rosterEnd) return fail('Set the rostered end time.');

  const ga = input.gapAnswers || {};

  // Anchor every call to the shift's roster start so overnight shifts work.
  // A call whose clock time is before the roster start belongs to the NEXT day
  // (past midnight), so we add 1440 to it. This gives each call a true
  // "minutes since shift start" value, which sorts correctly even when calls
  // span midnight (e.g. 20:30, 23:40, 01:20, 03:10). Without an anchor, a naive
  // clock sort would place 01:20 before 20:30 and scramble the night.
  const anchor = input.rosterStart ? parseTime(input.rosterStart) : 0;
  const dayAdjusted = c => {
    let s = parseTime(c.start);
    if (s < anchor) s += 1440;          // before roster start => next calendar day
    return s;
  };
  const ordered = [...valid].sort((a, b) => dayAdjusted(a) - dayAdjusted(b));

  // Build unwrapped event times. We compute each call's start/clear relative to the
  // anchor: both get +1440 if before the roster start. A call that STRADDLES midnight
  // (starts 23:40, clears 01:20) gets its clear pushed to the next day too.
  const events = ordered.map(c => {
    let startM = parseTime(c.start);
    let clearM = parseTime(c.clear);
    if (startM < anchor) startM += 1440;
    if (clearM < anchor) clearM += 1440;
    if (clearM < startM) clearM += 1440;   // clear after midnight relative to its start
    return { cad: c.cad, startM, clearM };
  });

  // Sanity guard: a single call running longer than MAX_CALL_MIN is almost certainly
  // a mistyped time, not a real incident. Flag it rather than silently computing a
  // huge subsistence window. This protects a user from a fat-fingered clear time
  // producing a wildly wrong claim.
  const badCall = events.find(e => (e.clearM - e.startM) > MAX_CALL_MIN);
  if (badCall) {
    return fail(`Call ${badCall.cad || ''} has start ${fmtClock(badCall.startM)} and clear ${fmtClock(badCall.clearM)}, which is over ${Math.round(MAX_CALL_MIN/60)} hours. Check the times.`);
  }

  const gaps = analyzeGaps(events);
  const needAnswers = gaps.filter(g => g.possible && !ga[g.index]);
  if (needAnswers.length) {
    return { ok: false, needAnswers, error: null, gaps,
             awayWindows: [], subsistence: null, overtime: null, ledger: [], events };
  }

  // ---- away windows (subsistence) ----
  const ledger = [];
  const windows = [];
  let winStart = events[0].startM;
  ledger.push({ atMin: winStart, kind: 'away', text: 'Away clock starts (first call-out)' });

  for (let i = 0; i < events.length - 1; i++) {
    const g = gaps[i];
    const returned = g.possible && ga[g.index] === 'yes';
    if (returned) {
      windows.push({ start: winStart, end: events[i].clearM });
      ledger.push({ atMin: events[i].clearM, kind: 'reset', text: 'Returned to base 10+ min, clock resets' });
      winStart = events[i + 1].startM;
      ledger.push({ atMin: winStart, kind: 'away', text: 'Away clock restarts (next call-out)' });
    }
    // not returned: clock runs through the gap (grace), nothing logged
  }

  // close final window at back-at-base (or last clear if not supplied)
  const lastClear = events[events.length - 1].clearM;
  let backM = lastClear;
  if (input.backAtBase) {
    let b = parseTime(input.backAtBase);
    const dayBase = Math.floor(lastClear / 1440) * 1440;
    backM = dayBase + b;
    if (backM < lastClear) backM += 1440;   // rolled past midnight
  }
  windows.push({ start: winStart, end: backM });
  ledger.push({ atMin: backM, kind: 'away', text: 'Back at base, final away window closes' });

  // tier each window independently against the configured subsistence tiers.
  // Tiers: [{hours, label}], highest qualifying threshold wins (higher replaces lower,
  // not cumulative). Defaults to the standard 5h/10h if none supplied.
  const tiers = (input.subsistenceTiers && input.subsistenceTiers.length)
    ? input.subsistenceTiers.slice().sort((a, b) => a.hours - b.hours)
    : [{ hours: 5, label: '5h' }, { hours: 10, label: '10h' }];
  const tierCounts = {};   // label -> count
  const awayWindows = windows.map(w => {
    const durMin = w.end - w.start;
    let chosen = null;
    for (const t of tiers) {
      if (durMin >= t.hours * 60) chosen = t;   // highest qualifying threshold wins
    }
    const tier = chosen ? chosen.hours : 0;
    const tierLabel = chosen ? (chosen.label || `${chosen.hours}h`) : null;
    if (chosen) tierCounts[tierLabel] = (tierCounts[tierLabel] || 0) + 1;
    return { start: w.start, end: w.end, durMin, tier, tierLabel };
  });
  // legacy counts kept for callers still reading them (default 5h/10h case)
  const count5 = awayWindows.filter(w => w.tier === 5).length;
  const count10 = awayWindows.filter(w => w.tier === 10).length;
  const summary = Object.keys(tierCounts).length
    ? tiers.slice().reverse()
        .map(t => { const l = t.label || `${t.hours}h`; return tierCounts[l] ? `${tierCounts[l]}x${l}` : ''; })
        .filter(Boolean).join(' + ')
    : 'none';

  // ---- overtime ----
  const rEnd = parseTime(input.rosterEnd);
  const rStart = parseTime(input.rosterStart);
  let rosterEndM = Math.floor(events[0].startM / 1440) * 1440 + rEnd;
  if (rStart != null && rEnd <= rStart) rosterEndM += 1440; // overnight roster
  if (rosterEndM < events[0].startM) rosterEndM += 1440;
  const rawMin = Math.max(0, backM - rosterEndM);
  const roundedMin = roundUp(rawMin, input.otRoundInc || 0);

  // ---- sanity warnings ----
  // Physically implausible figures usually mean a misread time or a day-wrap error fed
  // bad input. Surface them so the UI can flag rather than present them as fact.
  const warnings = [];
  const MAX_PLAUSIBLE_WINDOW = 18 * 60;   // a single continuous away-window over 18h is suspect
  const MAX_PLAUSIBLE_OT = 16 * 60;       // over 16h overtime on one shift is suspect
  awayWindows.forEach((w, i) => {
    if (w.durMin > MAX_PLAUSIBLE_WINDOW)
      warnings.push(`Away window ${i + 1} is ${(w.durMin / 60).toFixed(1)}h, which is unusually long. Check the call times for a misread.`);
  });
  if (rawMin > MAX_PLAUSIBLE_OT)
    warnings.push(`Overtime is ${(rawMin / 60).toFixed(1)}h, which is unusually high. Check the back-at-base time and call times.`);

  return {
    ok: true, needAnswers: [], error: null, gaps, warnings,
    awayWindows,
    subsistence: { count5, count10, summary },
    overtime: { rawMin, roundedMin, hours: roundedMin / 60, rosterEndM, backM },
    ledger, events
  };

  function fail(msg) {
    return { ok: false, needAnswers: [], error: msg,
             awayWindows: [], subsistence: null, overtime: null, ledger: [], events: [] };
  }
}

/* ---- formatting helpers (handy for any UI, still pure) -------------------- */
function fmtClock(min) { min = ((min % 1440) + 1440) % 1440; const h = Math.floor(min / 60), m = Math.round(min % 60); return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`; }
function fmtDur(min) { const h = Math.floor(min / 60), m = Math.round(min % 60); return h && m ? `${h}h ${m}m` : h ? `${h}h` : `${m}m`; }

/* ---- exports (works as ES module, CommonJS, or plain browser global) ------ */
const ENGINE = { computeShift, analyzeGaps, parseTime, unwrap, roundUp, fmtClock, fmtDur,
                 GRACE_MIN, TIER5_MIN, TIER10_MIN };
if (typeof module !== 'undefined' && module.exports) module.exports = ENGINE;
if (typeof window !== 'undefined') window.ENGINE = ENGINE;
