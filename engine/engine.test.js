/* ============================================================================
   ENGINE TESTS
   These lock in known-good results from REAL shifts. If a future change to the
   rules breaks one of these, the test screams. That is the whole point: an app
   that computes money owed must not let a quiet edit change a past answer.

   Run with:  node engine/engine.test.js
   (No test framework needed. Plain assertions, exits non-zero on failure.)
============================================================================ */
const E = require('./engine.js');

let passed = 0, failed = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { passed++; console.log('  PASS  ' + name); }
  else { failed++; console.log('  FAIL  ' + name + '\n        got : ' + JSON.stringify(got) + '\n        want: ' + JSON.stringify(want)); }
}

/* ----------------------------------------------------------------------------
   CASE 1 — IMAGE 3 shift (verified against Keith's real pay: TODO confirm payslip)
   07-19 roster, 1-hour overtime round-up.
   Last call cleared at Mullingar RH, ~5 min drive back to Mullingar station.
   Expected: away 09:36 -> 19:08 = 9h 32m, 5h tier. Overtime 8 min -> 1h.
---------------------------------------------------------------------------- */
(function imageThree() {
  console.log('\nCASE 1: image-3 shift');
  const input = {
    rosterStart: '07:00', rosterEnd: '19:00', otRoundInc: 60,
    backAtBase: '19:07:50',
    driveTimes: { 'Mullingar RH': 5, 'Other': 20 },
    calls: [
      { cad: '5884356', start: '09:36:15', clear: '11:44:45', loc: 'Other' },
      { cad: '5884584', start: '12:18:18', clear: '14:23:16', loc: 'Other' },
      { cad: '5884742', start: '14:23:49', clear: '14:29:01', loc: 'Other' },
      { cad: '5884801', start: '14:29:08', clear: '15:43:19', loc: 'Other' },
      { cad: '5884892', start: '15:43:58', clear: '17:00:17', loc: 'Other' },
      { cad: '5885129', start: '17:47:02', clear: '19:02:50', loc: 'Mullingar RH' },
    ],
    gapAnswers: {},
  };
  const r0 = E.computeShift(input);
  // With the wider "ask when plausible" rule, the engine now surfaces gaps it used
  // to silently assume. For image 3 the real answer is "stayed out" (continuous away
  // periods), and answering so must reproduce the verified pay outcome.
  const ga = {}; r0.needAnswers.forEach(g => ga[g.index] = 'no');
  const r = E.computeShift({ ...input, gapAnswers: ga });
  check('computes after answering gaps', r.ok, true);
  check('one away window', r.awayWindows.length, 1);
  check('away window duration ~9h32m', Math.round(r.awayWindows[0].durMin), 572); // seconds carried through
  check('subsistence tier', r.awayWindows[0].tier, 5);
  check('subsistence summary', r.subsistence.summary, '1x5h');
  check('overtime raw ~8 min', Math.round(r.overtime.rawMin), 8); // 7m50s actual
  check('overtime rounded (hours)', r.overtime.hours, 1);
})();

/* ----------------------------------------------------------------------------
   CASE 2 — IMAGE 1 shift. Has long inter-call gaps that COULD allow a base
   return, so the engine should ASK rather than decide. With every gap answered
   "stayed out", it is one continuous away-window.
   NOTE: locations/drive-times are placeholders; this case tests the LOGIC
   (gap detection, single window), not a verified pay outcome.
---------------------------------------------------------------------------- */
(function imageOne() {
  console.log('\nCASE 2: image-1 shift (logic test, not pay-verified)');
  const base = {
    rosterStart: '07:00', rosterEnd: '19:00', otRoundInc: 60,
    backAtBase: '18:26:00',
    driveTimes: { 'Other': 20 },
    calls: [
      { cad: '5886259', start: '09:42:00', clear: '11:23:57', loc: 'Other' },
      { cad: '5886421', start: '11:49:17', clear: '11:59:21', loc: 'Other' },
      { cad: '5886445', start: '12:07:31', clear: '12:32:39', loc: 'Other' },
      { cad: '5886492', start: '12:32:59', clear: '14:18:57', loc: 'Other' },
      { cad: '5886698', start: '14:52:18', clear: '15:01:54', loc: 'Other' },
      { cad: '5886870', start: '16:47:11', clear: '18:20:55', loc: 'Other' },
    ],
    gapAnswers: {},
  };
  const first = E.computeShift(base);
  check('flags at least one possible-return gap', first.needAnswers.length > 0, true);
  check('blocks compute until answered', first.ok, false);

  // answer every flagged gap "stayed out"
  const ga = {}; first.needAnswers.forEach(g => ga[g.index] = 'no');
  const r = E.computeShift({ ...base, gapAnswers: ga });
  check('computes once gaps answered', r.ok, true);
  check('single continuous window when never returned', r.awayWindows.length, 1);

  // now answer the big 15:01->16:47 gap "returned" -> should split into 2 windows
  const bigGap = first.needAnswers.find(g => Math.round(g.gap) >= 90);
  if (bigGap) {
    const ga2 = { ...ga, [bigGap.index]: 'yes' };
    const r2 = E.computeShift({ ...base, gapAnswers: ga2 });
    check('a confirmed return splits into a fresh window', r2.awayWindows.length >= 2, true);
  }
})();

/* ----------------------------------------------------------------------------
   CASE 7 — overnight shift with calls before, across, and after midnight.
   The anchor-to-roster-start logic must keep them in true time order and not
   produce impossible multi-day windows.
---------------------------------------------------------------------------- */
(function overnight() {
  console.log('\nCASE 7: overnight shift across midnight');
  const input = {
    rosterStart: '19:00', rosterEnd: '07:00', otRoundInc: 30, backAtBase: '07:30',
    driveTimes: { A: 15 }, gapAnswers: {},
    calls: [
      { cad: 'N1', start: '20:30', clear: '22:15', loc: 'A' },
      { cad: 'N2', start: '23:40', clear: '01:20', loc: 'A' }, // straddles midnight
      { cad: 'N3', start: '03:10', clear: '05:45', loc: 'A' },
    ],
  };
  let r = E.computeShift(input);
  if (!r.ok && r.needAnswers.length) { const ga = {}; r.needAnswers.forEach(g => ga[g.index] = 'no'); r = E.computeShift({ ...input, gapAnswers: ga }); }
  check('events stay in time order', r.events.map(e => e.cad).join(','), 'N1,N2,N3');
  check('one sane away window (<24h)', r.awayWindows.length === 1 && r.awayWindows[0].durMin < 1440, true);
  check('away window is 11h', Math.round(r.awayWindows[0].durMin), 660);
  check('overnight tier is 10h', r.awayWindows[0].tier, 10);
  check('overnight overtime 30m', r.overtime.roundedMin, 30);

  // even if entered out of order, anchor sort fixes it
  const scrambled = E.computeShift({ ...input, gapAnswers: { 0:'no',1:'no' },
    calls: [input.calls[2], input.calls[0], input.calls[1]] });
  check('scrambled overnight still orders N1,N2,N3', scrambled.events.map(e=>e.cad).join(','), 'N1,N2,N3');
})();

/* ----------------------------------------------------------------------------
   CASE 8 — sanity guard: an impossibly long call (mistyped time) is flagged,
   not silently turned into a huge subsistence window.
---------------------------------------------------------------------------- */
(function badCallGuard() {
  console.log('\nCASE 8: implausible call duration guard');
  const r = E.computeShift({
    rosterStart: '08:00', rosterEnd: '17:00', otRoundInc: 0, backAtBase: '17:30',
    driveTimes: { A: 20 }, gapAnswers: {},
    calls: [
      { cad: '1', start: '09:00', clear: '11:00', loc: 'A' },
      { cad: '2', start: '14:00', clear: '02:30', loc: 'A' }, // 12.5h: mistyped
    ],
  });
  check('flags the bad call instead of computing', r.ok, false);
  check('returns an error message', !!r.error, true);
  // a legitimately long-ish call (under 8h) still computes
  const ok = E.computeShift({
    rosterStart: '08:00', rosterEnd: '20:00', otRoundInc: 0, backAtBase: '20:00',
    driveTimes: { A: 20 }, gapAnswers: {},
    calls: [{ cad: '1', start: '09:00', clear: '16:00', loc: 'A' }], // 7h, allowed
  });
  check('7h call still computes', ok.ok, true);
})();

/* ----------------------------------------------------------------------------
   CASE 9 — configurable subsistence tiers.
---------------------------------------------------------------------------- */
(function customTiers() {
  console.log('\nCASE 9: configurable subsistence tiers');
  const tiers = [{ hours: 4, label: '' }, { hours: 8, label: 'Full day' }];
  const mk = calls => ({ rosterStart:'08:00', rosterEnd:'20:00', otRoundInc:0, backAtBase:'20:00',
    gapAnswers:{0:'no'}, subsistenceTiers: tiers, calls });
  // ~11h away (09:00→20:00 back) hits the 8h "Full day" tier
  let r = E.computeShift(mk([{cad:'1',start:'09:00',clear:'12:00'},{cad:'2',start:'13:00',clear:'16:00'}]));
  check('long window hits highest tier', r.awayWindows[0].tier, 8);
  check('custom label applied', r.awayWindows[0].tierLabel, 'Full day');
  // a true 5h window (09:00→14:00) hits 4h tier, blank label → "4h"
  let r2 = E.computeShift({ rosterStart:'08:00', rosterEnd:'20:00', otRoundInc:0, backAtBase:'14:00',
    gapAnswers:{0:'no'}, subsistenceTiers: tiers, calls:[{cad:'1',start:'09:00',clear:'11:00'},{cad:'2',start:'12:00',clear:'14:00'}] });
  check('5h window hits 4h tier', r2.awayWindows[0].tier, 4);
  check('blank label defaults to Xh', r2.awayWindows[0].tierLabel, '4h');
  // default (no tiers supplied) still 5/10
  let r3 = E.computeShift({ rosterStart:'08:00', rosterEnd:'20:00', otRoundInc:0, backAtBase:'20:00',
    gapAnswers:{0:'no'}, calls:[{cad:'1',start:'09:00',clear:'13:00'},{cad:'2',start:'14:00',clear:'18:30'}] });
  check('default tiers unchanged (10h)', r3.awayWindows[0].tier, 10);
})();
(function units() {
  console.log('\nCASE 3: unit rules');
  check('roundUp 8min to 60', E.roundUp(8, 60), 60);
  check('roundUp exact passthrough', E.roundUp(37, 0), 37);
  check('roundUp 31 to 15 -> 45', E.roundUp(31, 15), 45);
  check('10h replaces 5h threshold at 600', E.TIER10_MIN, 600);
  // overnight unwrap: 23:50 then 00:20 should become 1430, 1460
  check('unwrap handles midnight', E.unwrap([23 * 60 + 50, 20]), [1430, 1460]);
})();

/* ----------------------------------------------------------------------------
   CASE 4 — minute-precision input (seconds dropped for manual entry).
   A call starting the same minute the previous one cleared must NOT create a
   negative gap or a phantom overnight jump. Tier logic only cares about 5h/10h,
   so minute precision is sufficient.
---------------------------------------------------------------------------- */
(function minutePrecision() {
  console.log('\nCASE 4: minute-precision boundaries');
  const r = E.computeShift({
    rosterStart: '07:00', rosterEnd: '19:00', otRoundInc: 60, backAtBase: '11:30',
    driveTimes: { A: 20 }, gapAnswers: {},
    calls: [
      { cad: '1', start: '09:42', clear: '11:23', loc: 'A' },
      { cad: '2', start: '11:23', clear: '11:25', loc: 'A' }, // same minute as prev clear
    ],
  });
  check('computes ok with same-minute boundary', r.ok, true);
  check('no phantom overnight jump', r.awayWindows[0].durMin < 1440, true);
  check('same-minute gap is zero, not negative', r.gaps[0].gap, 0);
  check('zero gap is not a possible return', r.gaps[0].possible, false);
})();

/* ----------------------------------------------------------------------------
   CASE 5 — wider gap detection. A real return that the OLD rule missed because
   it subtracted a speculative drive-out. Now: gap - driveBack >= 10 => ASK.
---------------------------------------------------------------------------- */
(function widerGap() {
  console.log('\nCASE 5: ask when a return is plausible');
  // 30-min gap, 15-min drive back. Old rule: 30-15-15=0 -> never asked (wrong).
  // New rule: 30-15=15 >=10 -> asks.
  const input = {
    rosterStart: '07:00', rosterEnd: '22:00', otRoundInc: 0, backAtBase: '21:00',
    driveTimes: { A: 15 }, gapAnswers: {},
    calls: [
      { cad: '1', start: '08:00', clear: '13:30', loc: 'A' },
      { cad: '2', start: '14:00', clear: '19:30', loc: 'A' },
    ],
  };
  const r0 = E.computeShift(input);
  check('now asks about the 30-min gap', r0.needAnswers.length, 1);
  // answer "returned" -> two windows, 2x5h
  const yes = E.computeShift({ ...input, gapAnswers: { 0: 'yes' } });
  check('confirmed return splits to 2x5h', yes.subsistence.summary, '2x5h');
  // answer "stayed out" -> one continuous window, 1x10h
  const no = E.computeShift({ ...input, gapAnswers: { 0: 'no' } });
  check('stayed out merges to 1x10h', no.subsistence.summary, '1x10h');
})();

/* ----------------------------------------------------------------------------
   CASE 6 — out-of-order calls are sorted by start time, not taken as-given.
---------------------------------------------------------------------------- */
(function ordering() {
  console.log('\nCASE 6: out-of-order calls');
  const inOrder = E.computeShift({
    rosterStart: '07:00', rosterEnd: '19:00', otRoundInc: 0, backAtBase: '19:00',
    driveTimes: { A: 10 }, gapAnswers: {},
    calls: [
      { cad: '1', start: '08:00', clear: '12:00', loc: 'A' },
      { cad: '2', start: '14:00', clear: '17:00', loc: 'A' },
    ],
  });
  const scrambled = E.computeShift({
    rosterStart: '07:00', rosterEnd: '19:00', otRoundInc: 0, backAtBase: '19:00',
    driveTimes: { A: 10 }, gapAnswers: {},
    calls: [
      { cad: '2', start: '14:00', clear: '17:00', loc: 'A' }, // out of order
      { cad: '1', start: '08:00', clear: '12:00', loc: 'A' },
    ],
  });
  check('scrambled first window starts at 08:00 not 14:00',
    Math.round(scrambled.events[0].startM), Math.round(inOrder.events[0].startM));
})();

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
