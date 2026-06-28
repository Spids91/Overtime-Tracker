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
// For each consecutive pair of calls, decide whether a 10+ min base return was
// PLAUSIBLE, and if so surface it as a question. The honest test for subsistence
// is "did they get back to base and stand down 10+ min?". We know driveBack (from
// the cleared location), but we do NOT know driveOut to the next call (it may have
// started right at base, needing no drive). So we must not assume driveOut eats the
// gap. We ask whenever gap - driveBack >= GRACE: they had time to get back and
// stand down. Erring toward asking fits "app assists, user asserts" — when unsure,
// put it to the user rather than silently deciding the money.
function analyzeGaps(events, driveTimes) {
  const gaps = [];
  for (let i = 0; i < events.length - 1; i++) {
    const clearAt = events[i].clearM;
    const nextStart = events[i + 1].startM;
    const gap = nextStart - clearAt;
    const driveBack = driveTimes[events[i].loc] ?? 20;
    const driveOut = driveTimes[events[i].loc] ?? 20; // kept for display/info only
    // plausible if there was time to drive back AND stand down 10+ min
    const possible = (gap - driveBack) >= GRACE_MIN;
    gaps.push({ index: i, clearAt, nextStart, gap, driveBack, driveOut, possible });
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
    driveTimes:  { locName: minutesToBase, ... },
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

  const dt = input.driveTimes || {};
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
    return { cad: c.cad, loc: c.loc, startM, clearM };
  });

  const gaps = analyzeGaps(events, dt);
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

  // tier each window independently; 10h replaces 5h
  let count5 = 0, count10 = 0;
  const awayWindows = windows.map(w => {
    const durMin = w.end - w.start;
    let tier = 0;
    if (durMin >= TIER10_MIN) { tier = 10; count10++; }
    else if (durMin >= TIER5_MIN) { tier = 5; count5++; }
    return { start: w.start, end: w.end, durMin, tier };
  });
  const summary = ([count10 ? `${count10}x10h` : '', count5 ? `${count5}x5h` : '']
                    .filter(Boolean).join(' + ')) || 'none';

  // ---- overtime ----
  const rEnd = parseTime(input.rosterEnd);
  const rStart = parseTime(input.rosterStart);
  let rosterEndM = Math.floor(events[0].startM / 1440) * 1440 + rEnd;
  if (rStart != null && rEnd <= rStart) rosterEndM += 1440; // overnight roster
  if (rosterEndM < events[0].startM) rosterEndM += 1440;
  const rawMin = Math.max(0, backM - rosterEndM);
  const roundedMin = roundUp(rawMin, input.otRoundInc || 0);

  return {
    ok: true, needAnswers: [], error: null, gaps,
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
