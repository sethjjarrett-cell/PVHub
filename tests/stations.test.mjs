/* Transformer stations: one plan, read by everything that draws,
   routes or counts a station. */

import {
  MODULAR_WAYS, chooseSubstations, stationPlan, stationIndexer, describePlan,
  parseKvaList, unitsByKva, describeKva,
} from "../src/stations.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log("  FAIL:", m); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

console.log("\n--- the modular catalogue ---");
eq(chooseSubstations(26, MODULAR_WAYS).combo, [14, 14], "26 inverters take 14 + 14");
eq(chooseSubstations(34, MODULAR_WAYS).combo, [20, 14], "34 take 20 + 14");
eq(chooseSubstations(10, MODULAR_WAYS).combo, [10], "10 fill one ten-way unit exactly");
eq(chooseSubstations(11, MODULAR_WAYS).combo, [14], "11 take one fourteen, not a ten and a spare unit");
eq(chooseSubstations(24, MODULAR_WAYS).combo, [14, 10], "24 take 14 + 10, with no way spare");
eq(chooseSubstations(24, MODULAR_WAYS).spare, 0, "and none spare");
eq(chooseSubstations(0, MODULAR_WAYS).combo, [], "no inverters, no stations");
eq(chooseSubstations(12, []).combo, [], "no sizes to choose from gives nothing rather than a guess");
for (let n = 1; n <= 120; n++) {
  const p = chooseSubstations(n, MODULAR_WAYS);
  const sum = p.combo.reduce((a, b) => a + b, 0);
  if (sum < n || p.spare !== sum - n) { ok(false, `${n} inverters: combo ${p.combo} does not cover them`); break; }
  if (n === 120) ok(true, "every count from 1 to 120 is covered, with the spare stated correctly");
}

console.log("\n--- the two modes ---");
{
  const m = stationPlan(24, {});
  eq(m.mode, "modular", "a project with no mode saved reads as modular, which is what it was");
  eq(m.combo, [14, 10], "and gets the stations it always had");

  const f = stationPlan(24, { stationMode: "fixed", invertersPerTx: 4 });
  eq(f.combo, [4, 4, 4, 4, 4, 4], "fixed at four ways gives six stations of four");
  eq(f.spare, 0, "with nothing spare");

  const f2 = stationPlan(26, { stationMode: "fixed", invertersPerTx: 12 });
  eq(f2.combo, [12, 12, 12], "26 at twelve ways needs a third station");
  eq(f2.spare, 10, "and leaves ten ways spare on it");

  eq(stationPlan(24, { stationMode: "modular", invertersPerTx: 4 }).combo, [14, 10],
     "in modular mode the ways input does not apply");
  eq(stationPlan(5, { stationMode: "fixed", invertersPerTx: 0 }).combo, [1, 1, 1, 1, 1],
     "a zero is floored at one way rather than dividing by it");
  eq(stationPlan(0, { stationMode: "fixed", invertersPerTx: 4 }).combo, [], "nothing to group gives no stations");
}

console.log("\n--- which station an inverter is on ---");
{
  const ix = stationIndexer(24, {});                      // 14 + 10
  eq([0, 13, 14, 23].map(ix), [0, 0, 1, 1], "the first fourteen are on station one, the rest on two");
  const fx = stationIndexer(10, { stationMode: "fixed", invertersPerTx: 4 });
  eq([0, 3, 4, 7, 8, 9].map(fx), [0, 0, 1, 1, 2, 2], "fixed fours: 0-3, 4-7, then the short one");
  eq(ix(99), 1, "an index past the end stays on the last station rather than inventing one");

  /* The property the whole file exists for: the indexer and the plan
     are the same grouping, for every count and both modes. */
  let agree = true;
  for (const cfg of [{}, { stationMode: "fixed", invertersPerTx: 4 }, { stationMode: "fixed", invertersPerTx: 7 }]) {
    for (let n = 1; n <= 90; n++) {
      const plan = stationPlan(n, cfg), at = stationIndexer(n, cfg);
      const counts = plan.combo.map(() => 0);
      for (let i = 0; i < n; i++) counts[at(i)]++;
      const used = plan.combo.map((w, s) => (s < plan.combo.length - 1 ? w : n - plan.combo.slice(0, -1).reduce((a, b) => a + b, 0)));
      if (JSON.stringify(counts) !== JSON.stringify(used)) { agree = false; break; }
    }
  }
  ok(agree, "the indexer fills each station exactly as the plan sizes it, for every count");
}

console.log("\n--- how a plan reads ---");
eq(describePlan(stationPlan(24, {})), "14 + 10", "mixed sizes are listed");
eq(describePlan(stationPlan(24, { stationMode: "fixed", invertersPerTx: 4 })), "6 × 4", "equal sizes are multiplied");
eq(describePlan(stationPlan(10, {})), "10", "one station is just its size");
eq(describePlan({ combo: [] }), "—", "no stations is a dash, not a zero");

console.log("\n--- transformer units by kVA ---");
{
  eq(parseKvaList("3150, 4000; 5000 kVA"), [3150, 4000, 5000], "a typed list reads, whatever separates it");
  eq(parseKvaList("4000, 0, -5, x, 4000"), [4000], "zeros, negatives, words and repeats are dropped");
  eq(parseKvaList(""), [], "an empty list is empty");

  const u = unitsByKva([3150, 4000, 5000], 350);
  eq(u, [{ kva: 3150, ways: 9 }, { kva: 4000, ways: 11 }, { kva: 5000, ways: 14 }],
     "each unit takes the inverters that fit inside its rating, floored");
  eq(unitsByKva([3500], 350), [{ kva: 3500, ways: 10 }], "exactly ten inverters fit a 3500 kVA unit");
  eq(unitsByKva([200, 4000], 350), [{ kva: 4000, ways: 11 }], "a unit smaller than one inverter is dropped");
  eq(unitsByKva([3600, 3800], 350), [{ kva: 3600, ways: 10 }], "two sizes giving the same ways keep the smaller");
  eq(unitsByKva([3800, 3900], 350).map((x) => x.ways), [10, 11], "while 3900 kVA does take an eleventh");
  eq(unitsByKva([4000], 0), [], "no inverter rating, no units");

  const p = stationPlan(25, { stationMode: "kva", unitKva: "3150, 4000, 5000", invKva: 350 });
  eq(p.mode, "kva", "the mode is kept");
  eq(p.combo.reduce((a, b) => a + b, 0) >= 25, true, "the plan covers all 25 inverters");
  eq(p.kva.length, p.combo.length, "and carries a kVA for every station");
  eq(p.combo, [14, 11], "25 inverters take one 14-way and one 11-way unit");
  eq(describeKva(p), "5000 + 4000 kVA", "which are 5000 and 4000 kVA");
  eq(p.spare, 0, "with nothing spare");

  const one = stationPlan(18, { stationMode: "kva", unitKva: "4000", invKva: 350 });
  eq(describeKva(one), "2 × 4000 kVA", "one size, repeated, reads as a multiple");
  eq(one.spare, 4, "and the spare ways are counted");

  ok(/inverter's rating/.test(stationPlan(10, { stationMode: "kva", unitKva: "4000" }).miss),
     "with no inverter rating the plan names what is missing");
  ok(/at least as large as one inverter/.test(stationPlan(10, { stationMode: "kva", unitKva: "200", invKva: 350 }).miss),
     "and with only units too small, says so");
  eq(stationPlan(10, { stationMode: "kva", unitKva: "200", invKva: 350 }).combo, [], "rather than inventing a station");

  /* The indexer agrees with the plan in this mode too. */
  const cfg = { stationMode: "kva", unitKva: "3150, 5000", invKva: 350 };
  for (const n of [1, 9, 13, 23, 40]) {
    const plan = stationPlan(n, cfg), at = stationIndexer(n, cfg);
    const counts = plan.combo.map(() => 0);
    for (let i = 0; i < n; i++) counts[at(i)]++;
    ok(counts.every((c, i) => c <= plan.combo[i]) && counts.reduce((a, b) => a + b, 0) === n,
       `${n} inverters are spread over the kVA plan without overloading a unit`);
  }
  eq(describeKva(stationPlan(10, {})), null, "a plan with no kVA has no kVA description");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
