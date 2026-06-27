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
  const r = E.computeShift(input);
  check('computes without needing gap answers', r.ok, true);
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
   CASE 3 — unit rules in isolation
---------------------------------------------------------------------------- */
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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
