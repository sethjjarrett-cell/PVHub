/* The string sizing maths, lifted out of App.jsx so the guided flow and
   the String Sizing tab share one copy. These assertions are mostly the
   CLAUDE.md conventions written as code: if someone "simplifies" the
   averaging, the flooring or the divisibility fallback, this fails. */
import { sizeStrings, RISE_TABLE } from "../src/stringSizing.js";

let pass = 0, fail = 0;
const eq = (g, w, what) => {
  if (Object.is(g, w)) pass += 1;
  else { fail += 1; console.log(`  FAIL ${what}\n    got  ${JSON.stringify(g)}\n    want ${JSON.stringify(w)}`); }
};
const near = (g, w, tol, what) => {
  if (typeof g === "number" && Math.abs(g - w) <= tol) pass += 1;
  else { fail += 1; console.log(`  FAIL ${what}: got ${g}, want ${w}±${tol}`); }
};
const ok = (c, what) => { if (c) pass += 1; else { fail += 1; console.log(`  FAIL ${what}`); } };

const MOD = { voc: 49.97, vmp: 41.23, isc: 16.48, imp: 15.77, pmax: 650,
  bVoc: -0.22, bVmp: -0.29, gPmax: -0.26, aIsc: 0.045, vSysMax: 1500,
  vmpNoct: null, noct: null, cells: null, ideality: null };
const INV = { vMax: 1500, fpLo: 600, trackLo: 500, vStart: 550, iMppt: 40,
  connMax: 12, nMppt: 12, acKva: 350 };
const base = (over = {}) => sizeStrings({
  mod: MOD, inv: INV, tSrc: [{ lo: -5, hi: 38 }, { lo: -2, hi: 41 }],
  siteT: { riseIdx: 2, margin: 2 }, frameP: 9, nSel: null, ...over });

console.log("\n--- the rise table ---");
eq(RISE_TABLE.length, 3, "three mounting styles");
ok(RISE_TABLE.every((r) => Number.isFinite(r.rise) && r.label), "each has a rise and a label");
/* A roof with no gap runs hottest, a pole runs coolest. If that order
   ever inverts, every hot-weather minimum moves the wrong way. */
ok(RISE_TABLE[0].rise > RISE_TABLE[2].rise, "a tight roof runs hotter than a freefield pole");

console.log("\n--- temperature extremes are never averaged ---");
const r = base();
eq(r.tLo, -5, "T_low is the MINIMUM across sources, not their mean");
eq(r.tHi, 41, "T_high is the MAXIMUM across sources");
/* Averaging would give -3.5 and 39.5 and soften exactly the extreme the
   check exists to catch. */
ok(r.tLo < -3.5 && r.tHi > 39.5, "and both are more extreme than the average would be");
eq(r.tcMin, -7, "cell minimum is T_low minus the margin");
eq(r.tcMax, 41 + 25 + 2, "cell maximum is T_high plus the rise plus the margin");
eq(r.rise, 25, "the rise comes from the chosen mounting style");
/* One source only: the min and max are that source. */
const one = base({ tSrc: [{ lo: 0, hi: 30 }] });
eq(one.tLo, 0, "a single source is its own minimum");
eq(one.tHi, 30, "and its own maximum");
/* A null reading is skipped rather than treated as zero, which would
   drag T_low down to a temperature nobody reported. */
const holey = base({ tSrc: [{ lo: null, hi: 40 }, { lo: -1, hi: null }] });
eq(holey.tLo, -1, "a null low is skipped, not read as zero");
eq(holey.tHi, 40, "and a null high likewise");

console.log("\n--- the voltage window ---");
near(r.vocCold1, 49.97 * (1 + (-0.22 / 100) * (-7 - 25)), 1e-9, "Voc rises as it gets colder");
ok(r.vocCold1 > MOD.voc, "so cold Voc is above the nameplate");
near(r.vmpHot1, 41.23 * (1 + (-0.29 / 100) * (68 - 25)), 1e-9, "Vmp falls as it gets hotter");
ok(r.vmpHot1 < MOD.vmp, "so hot Vmp is below the nameplate");
eq(r.ceiling, 1500, "the ceiling is the lower of inverter and module system voltage");
const lowMod = base({ mod: { ...MOD, vSysMax: 1000 } });
eq(lowMod.ceiling, 1000, "a 1000 V module caps a 1500 V inverter");

console.log("\n--- N_max floors, N_min uses the full-power bound ---");
eq(r.nMax, Math.floor(1500 / r.vocCold1), "N_max is the floor of ceiling over cold Voc");
ok(r.nMax * r.vocCold1 <= 1500, "so the string cannot over-volt on the coldest morning");
ok((r.nMax + 1) * r.vocCold1 > 1500, "and one more module would");
eq(r.nMin, Math.ceil(INV.fpLo / r.vmpHot1), "N_min is the ceiling of the FULL-POWER bound over hot Vmp");
/* The tracking bound is lower and using it would widen the window and
   let a string sit below full power on a hot afternoon. */
ok(INV.trackLo < INV.fpLo, "the tracking bound is the lower of the two, in this fixture");
ok(r.nMin > Math.ceil(INV.trackLo / r.vmpHot1), "and N_min is stricter than it would give");

console.log("\n--- N_rec trades modules for frame divisibility ---");
eq(r.nRec % 9, 0, "the recommendation lands on a whole frame bay");
ok(r.nRec <= r.nMax, "without exceeding the electrical maximum");
ok(r.nRec >= r.nMin, "or dropping below the hot-weather minimum");
eq(r.recDivisible, true, "and it reports that it is divisible");
/* When the divisible candidate would drop below N_min, the electrical
   maximum wins and the interface is told it is not divisible. */
/* fpLo 1000 puts N_min at 28 while N_max is 28 and the divisible
   candidate is 27 — a valid window where divisibility must give way. */
const tight = sizeStrings({ mod: MOD, inv: { ...INV, fpLo: 1000 },
  tSrc: [{ lo: -5, hi: 41 }], siteT: { riseIdx: 2, margin: 2 }, frameP: 9, nSel: null });
eq(tight.valid, true, "the window is valid");
ok(tight.nMin > tight.nMax - (tight.nMax % 9), "the divisible candidate falls below N_min here");
eq(tight.nRec, tight.nMax, "so the electrical maximum is recommended instead");
eq(tight.recDivisible, false, "and it is reported as not divisible");

console.log("\n--- parallel strings take the lower limit ---");
eq(r.byIsc, Math.floor(INV.iMppt / MOD.isc), "the current headroom gives one bound");
eq(r.strPar, Math.min(INV.connMax, r.byIsc), "and the result is the lower of it and the connectors");
const fewConn = base({ inv: { ...INV, connMax: 1 } });
eq(fewConn.strPar, 1, "a tight connector limit wins");
const bigConn = base({ inv: { ...INV, iMppt: 200, connMax: 3 } });
eq(bigConn.strPar, 3, "and a tight connector limit wins again when current is plentiful");
const noConn = base({ inv: { ...INV, connMax: null } });
eq(noConn.strPar, noConn.byIsc, "with no connector figure, current alone decides");

console.log("\n--- the beta-Vmp waterfall ---");
eq(r.method, "Datasheet value", "a published beta_Vmp is used as given");
const derived = base({ mod: { ...MOD, bVmp: null } });
near(derived.bVmpUsed, -0.26 - 0.045, 1e-9, "without one, gamma_Pmax minus alpha_Isc");
ok(/Derived/.test(derived.method), "and the method says it was derived");
const none = base({ mod: { ...MOD, bVmp: null, gPmax: null, aIsc: null } });
eq(none.bVmpUsed, null, "with no route at all, nothing is invented");
eq(none.bad, true, "the result is flagged bad");
ok(/NO ROUTE/.test(none.method), "and the method says so rather than guessing");

console.log("\n--- a hand-picked N overrides the recommendation ---");
const picked = base({ nSel: 20 });
eq(picked.N, 20, "the chosen N is used");
eq(picked.nRec, r.nRec, "while the recommendation is still reported beside it");
near(picked.vocColdN, 20 * r.vocCold1, 1e-9, "and the string voltages follow the chosen N");

console.log("\n--- an impossible window is reported, not papered over ---");
const impossible = sizeStrings({ mod: MOD, inv: { ...INV, vMax: 400 },
  tSrc: [{ lo: -20, hi: 45 }], siteT: { riseIdx: 0, margin: 5 }, frameP: 1, nSel: null });
eq(impossible.valid, false, "N_max below N_min is not a valid window");
eq(impossible.nRec, null, "so there is no recommendation");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
