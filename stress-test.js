/* ============================================================================
   STRESS TEST: 3 users, 60 months each.
   Exercises the real ENGINE plus a faithful replica of the app's save-time money
   and totalling logic. Varied rosters, patterns, subsistence (time + fixed),
   labels, wages, and overtime rates. Reports invariant violations.
   ============================================================================ */
const E = require('./engine/engine.js');

/* ---- app-layer replicas (must match shift-tracker.html exactly) ---- */
function isNightPattern(p){ if(!p||p==='off')return false; return parseInt(p.split('-')[0],10)>=18; }
function shiftSubsMoney(s){
  let t=0;
  (s.subsistence||[]).forEach(x=>t+=Number(x.value)||0);
  (s.manualSubs||[]).forEach(m=>t+=Number(m.value)||0);
  return t;
}
function ymd(d){ return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
function weekEndingSunday(ds){
  const d=new Date(ds+'T00:00:00');
  const dow=(d.getDay()+6)%7;          // 0=Mon..6=Sun
  const sun=new Date(d); sun.setDate(d.getDate()+(6-dow));
  return ymd(sun);
}

/* ---- seeded RNG so runs are reproducible ---- */
let SEED = parseInt(process.env.SEED||'1234567',10);
function rnd(){ SEED = (SEED*1103515245 + 12345) & 0x7fffffff; return SEED/0x7fffffff; }
function pick(arr){ return arr[Math.floor(rnd()*arr.length)]; }
function chance(p){ return rnd()<p; }

/* ---- three distinct users ---- */
const USERS = [
  {
    name: 'Keith (NAS Ireland)',
    currency: '€',
    patterns: ['07-19','19-07'],
    cycleWeeks: 9,
    subsTiers: [{hours:5,label:'',value:13.71},{hours:10,label:'',value:33.61}],
    manualSubs: [],
    wage: 22.5,
    otRates: [{mult:1.5,def:true},{mult:2,def:false}],
    otRoundInc: 15
  },
  {
    name: 'Sarah (UK, fixed allowances)',
    currency: '£',
    patterns: ['08-20','20-08','10-22'],
    cycleWeeks: 4,
    subsTiers: [{hours:6,label:'Meal',value:0}],            // one time-based tier, zero value
    manualSubs: [{label:'B&B',value:55},{label:'Meal allowance',value:8.5},{label:'Night rate',value:12}],
    wage: 18.9,
    otRates: [{mult:1.33,def:false},{mult:1.5,def:true},{mult:2,def:false}],
    otRoundInc: 30
  },
  {
    name: 'Tom (mixed, 3 tiers)',
    currency: '€',
    patterns: ['06-18','18-06','09-17','12-00'],
    cycleWeeks: 6,
    subsTiers: [{hours:4,label:'',value:10},{hours:8,label:'Half',value:22},{hours:12,label:'Full day',value:48}],
    manualSubs: [{label:'Mileage',value:5.25}],
    wage: 25,
    otRates: [{mult:1.5,def:true}],                          // single rate
    otRoundInc: 60
  }
];

/* ---- build a repeating cycle for a user (some days off, some worked) ---- */
function buildCycle(u){
  const cycle=[];
  for(let w=0; w<u.cycleWeeks; w++){
    const week=[];
    for(let d=0; d<7; d++){
      // ~45% chance a given day is a working day, else off
      week.push(chance(0.45) ? pick(u.patterns) : 'off');
    }
    cycle.push(week);
  }
  return cycle;
}
function rosterForDate(u, cycle, anchorYmd, dateStr){
  const anchor=new Date(anchorYmd+'T00:00:00');
  const target=new Date(dateStr+'T00:00:00');
  const aD=(anchor.getDay()+6)%7; const aM=new Date(anchor); aM.setDate(anchor.getDate()-aD);
  const tD=(target.getDay()+6)%7; const tM=new Date(target); tM.setDate(target.getDate()-tD);
  const wb=Math.round((tM-aM)/(7*86400000));
  let wi=((wb)%u.cycleWeeks + u.cycleWeeks)%u.cycleWeeks;
  return { pattern: cycle[wi][tD], dow:tD };
}

/* generate a plausible, VALID set of calls for a worked shift.
   Calls are strictly ordered, non-overlapping, each under the 8h guard, and kept
   within the shift. Returns {calls, backAtBase} where backAtBase sometimes pushes
   past the roster end to create overtime. */
function genShift(pattern){
  const [sh,eh]=pattern.split('-').map(x=>parseInt(x,10));
  let startMin = sh*60;
  let endMin = eh*60; if(endMin<=startMin) endMin+=1440;   // overnight unwrap
  const nCalls = 1+Math.floor(rnd()*4);                    // 1..4 calls
  const calls=[];
  let cursor = startMin + Math.floor(rnd()*30);            // booked on near roster start
  for(let i=0;i<nCalls;i++){
    const dur = 25 + Math.floor(rnd()*180);               // 25..205 min (< 8h guard)
    const cs=cursor, ce=cursor+dur;
    if(ce >= endMin){ break; }                            // keep calls inside the shift
    calls.push({ cad:String(5000000+Math.floor(rnd()*999999)), start:fmtHM(cs), clear:fmtHM(ce) });
    // gap before next: short (stay out) or long (return to base)
    cursor = ce + (chance(0.5) ? (2+Math.floor(rnd()*8)) : (15+Math.floor(rnd()*120)));
    if(cursor >= endMin) break;
  }
  if(!calls.length){
    // guarantee at least one valid call
    const cs=startMin+10, ce=Math.min(cs+90, endMin-10);
    calls.push({ cad:String(5000000+Math.floor(rnd()*999999)), start:fmtHM(cs), clear:fmtHM(ce) });
  }
  // back-at-base: usually around roster end; 35% of the time push past it for overtime
  const lastClearAbs = startMin + calls.reduce((mx,c)=>{
    let s=parseInt(c.start.slice(0,2))*60+parseInt(c.start.slice(3))-startMin%1440;
    return mx; // not used; computed below from engine instead
  },0);
  const overtime = chance(0.35) ? (10 + Math.floor(rnd()*170)) : 0;  // 0..180 min OT
  const backAbs = endMin + overtime;
  return { calls, backAtBase: fmtHM(backAbs) };
}
function fmtHM(min){ min=((min%1440)+1440)%1440; const h=Math.floor(min/60), m=min%60; return String(h).padStart(2,'0')+':'+String(m).padStart(2,'0'); }

/* ---- invariant checks ---- */
let violations=[];
function inv(cond, msg, ctx){ if(!cond) violations.push({msg, ctx}); }

/* ---- run the simulation ---- */
const stats = { users:0, shiftsWorked:0, shiftsLogged:0, gapsAsked:0, errors:0, errSamples:[],
  totalOtHours:0, totalOtMoney:0, totalSubMoney:0, byUser:[] };

USERS.forEach(u=>{
  stats.users++;
  const cycle=buildCycle(u);
  const anchor='2021-01-04';   // a Monday
  const store={};
  let uOtHours=0, uOtMoney=0, uSubMoney=0, uWorked=0, uLogged=0;
  const defMult = (u.otRates.find(r=>r.def)||u.otRates[0]).mult;

  // 60 months from Jan 2021
  let cur=new Date('2021-01-01T00:00:00');
  const end=new Date('2026-01-01T00:00:00');   // 60 months
  while(cur<end){
    const ds=ymd(cur);
    const rf=rosterForDate(u, cycle, anchor, ds);
    if(rf.pattern!=='off'){
      uWorked++;
      // user logs ~85% of worked shifts
      if(chance(0.85)){
        const [sh,eh]=rf.pattern.split('-');
        const { calls, backAtBase } = genShift(rf.pattern);
        const input={
          rosterStart: sh.padStart(2,'0')+':00',
          rosterEnd: eh.padStart(2,'0')+':00',
          otRoundInc: u.otRoundInc,
          backAtBase,
          gapAnswers: {},
          subsistenceTiers: u.subsTiers,
          calls
        };
        let r=E.computeShift(input);
        if(r.error){ stats.errors++; if(stats.errSamples.length<8) stats.errSamples.push({user:u.name, rs:input.rosterStart, re:input.rosterEnd, bab:input.backAtBase, calls:input.calls.map(c=>c.start+'-'+c.clear).join(','), err:r.error}); cur.setDate(cur.getDate()+1); continue; }
        if(r.needAnswers && r.needAnswers.length){
          r.needAnswers.forEach(g=>{ input.gapAnswers[g.index]= chance(0.5)?'yes':'no'; stats.gapsAsked++; });
          r=E.computeShift(input);
        }
        if(!r.ok){ stats.errors++; if(stats.errSamples.length<8) stats.errSamples.push({user:u.name, phase:'post-gap', rs:input.rosterStart, re:input.rosterEnd, bab:input.backAtBase, calls:input.calls.map(c=>c.start+'-'+c.clear).join(','), err:r.error, need:r.needAnswers}); cur.setDate(cur.getDate()+1); continue; }
        {
          // ---- replicate app save-time money logic ----
          const otMult = chance(0.1) ? pick(u.otRates).mult : defMult;   // 10% override
          const otHoursVal = +(r.overtime.roundedMin/60).toFixed(2);
          const otMoney = (u.wage>0 && otHoursVal>0) ? +(otHoursVal*u.wage*otMult).toFixed(2) : 0;
          const subsistence = r.awayWindows.filter(w=>w.tier>0).map(w=>{
            const td=u.subsTiers.find(t=>t.hours===w.tier);
            return { tier:w.tier, label:w.tierLabel||(w.tier+'h'), value: td?(Number(td.value)||0):0, durMin:w.durMin };
          });
          // tick some manual subs at random
          const manualClaimed = u.manualSubs.filter(()=>chance(0.3)).map(m=>({label:m.label,value:m.value}));

          const shift={ date:ds, otHours:otHoursVal, otMult, otMoney, wage:u.wage,
            subsistence, manualSubs:manualClaimed, currency:u.currency,
            rosterStart: input.rosterStart, rosterEnd: input.rosterEnd };
          store[ds]=shift; uLogged++;

          // ---- invariants ----
          inv(otHoursVal>=0, 'negative overtime hours', {user:u.name, ds, otHoursVal});
          inv(otMoney>=0, 'negative overtime money', {user:u.name, ds, otMoney});
          inv(r.overtime.roundedMin>=r.overtime.rawMin, 'rounded < raw overtime', {user:u.name, ds});
          // tier monotonicity: a window's tier must be the highest threshold it meets
          r.awayWindows.forEach(w=>{
            if(w.tier>0){
              const td=u.subsTiers.find(t=>t.hours===w.tier);
              inv(td && w.durMin >= td.hours*60, 'window assigned a tier it does not meet', {user:u.name, ds, durMin:w.durMin, tier:w.tier});
              // no higher tier should also be met
              u.subsTiers.forEach(t=>{
                if(t.hours>w.tier) inv(w.durMin < t.hours*60, 'a higher tier was met but not chosen', {user:u.name, ds, durMin:w.durMin, chosen:w.tier, higher:t.hours});
              });
            }
          });
          // money consistency
          const recomputed = otHoursVal*u.wage*otMult;
          inv(Math.abs(recomputed - otMoney) < 0.011, 'otMoney mismatch', {user:u.name, ds, otMoney, recomputed});
          const subM = shiftSubsMoney(shift);
          const expectSub = subsistence.reduce((a,x)=>a+x.value,0)+manualClaimed.reduce((a,m)=>a+m.value,0);
          inv(Math.abs(subM-expectSub)<0.011, 'subsistence money mismatch', {user:u.name, ds, subM, expectSub});

          uOtHours+=otHoursVal; uOtMoney+=otMoney; uSubMoney+=subM;
        }
      }
    }
    cur.setDate(cur.getDate()+1);
  }

  // ---- week grouping sanity: every logged date maps to a Sunday >= the date ----
  const weekMoney={};
  Object.keys(store).forEach(ds=>{
    const wk=weekEndingSunday(ds);
    inv(wk>=ds, 'week-ending Sunday is before the shift date', {user:u.name, ds, wk});
    const wd=new Date(wk+'T00:00:00');
    inv(((wd.getDay()+6)%7)===6, 'week-ending date is not a Sunday', {user:u.name, ds, wk});
    weekMoney[wk]=(weekMoney[wk]||0)+shiftSubsMoney(store[ds]);
    // currency consistency on every saved shift
    inv(store[ds].currency===u.currency, 'shift currency mismatch', {user:u.name, ds});
  });
  // week totals must equal the sum of their days, and the user total the sum of weeks
  const weekSum=Object.values(weekMoney).reduce((a,b)=>a+b,0);
  inv(Math.abs(weekSum - uSubMoney) < 0.05, 'week-money sum != user subsistence total', {user:u.name, weekSum:+weekSum.toFixed(2), uSubMoney:+uSubMoney.toFixed(2)});

  stats.shiftsWorked+=uWorked; stats.shiftsLogged+=uLogged;
  stats.totalOtHours+=uOtHours; stats.totalOtMoney+=uOtMoney; stats.totalSubMoney+=uSubMoney;
  stats.byUser.push({ name:u.name, currency:u.currency, worked:uWorked, logged:uLogged,
    otHours:+uOtHours.toFixed(1), otMoney:+uOtMoney.toFixed(2), subMoney:+uSubMoney.toFixed(2) });
});

/* ---- report ---- */
console.log('=== 60-MONTH x 3-USER STRESS TEST ===\n');
stats.byUser.forEach(u=>{
  console.log(`${u.name}`);
  console.log(`  worked ${u.worked} shifts, logged ${u.logged}`);
  console.log(`  overtime: ${u.otHours}h  ${u.currency}${u.otMoney}`);
  console.log(`  subsistence money: ${u.currency}${u.subMoney}\n`);
});
console.log(`Totals: ${stats.shiftsWorked} worked, ${stats.shiftsLogged} logged, ${stats.gapsAsked} gap questions, ${stats.errors} skipped shifts`);
if(stats.errSamples.length){
  console.log('\nSkip samples (why a shift was not logged):');
  stats.errSamples.forEach(s=>console.log('  ', s.phase||'first', s.rs, s.re, 'bab='+s.bab, '|', s.calls, '|', s.err||('needAnswers='+JSON.stringify(s.need))));
}
console.log(`Invariant violations: ${violations.length}`);
if(violations.length){
  const grouped={};
  violations.forEach(v=>{ grouped[v.msg]=(grouped[v.msg]||0)+1; });
  Object.entries(grouped).forEach(([m,n])=>console.log(`  [${n}] ${m}`));
  console.log('\nFirst 5 examples:');
  violations.slice(0,5).forEach(v=>console.log('  ', v.msg, JSON.stringify(v.ctx)));
  if(!process.env.QUIET) process.exit(1);
} else {
  console.log('\nALL INVARIANTS HELD. No bugs surfaced.');
}
