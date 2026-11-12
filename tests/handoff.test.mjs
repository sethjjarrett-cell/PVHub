/* What the layout hands to the tools downstream of it, and what it
   declines to. */

import {
  hasLayout, offerRows, lvRunsFromLayout, mvRunsFromLayout, guidedFromLayout, GUIDED_ROWS,
  sweepFromLayout, SWEEP_ROWS, networkFromLayout,
} from "../src/handoff.js";
import { solveNetwork, checkCable } from "../src/faultNetwork.js";
import { buildBom } from "../src/bom.js";
import { ratioFor } from "../src/pvsystBatch.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log("  FAIL:", m); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
const near = (a, b, tol, m) => ok(Math.abs(a - b) <= tol, `${m} (got ${a}, want ${b} ±${tol})`);

/* A layout as the Layout tab reports it: 25 inverters on two 14-way
   stations, the second one short. */
const L = {
  modules: 16200, dcMWp: 10.53, modPower: 650, inverters: 25, invAcKw: 350, invVac: 800,
  strings: 600, modulesPerString: 27, stringsPerInverter: 24, frames: 200,
  areaM2: 181050, pitch: 5.5, collectW: 2.384, mounting: "tracker", tilt: 20,
  lv: 4420, mv: 288,
  stations: [
    { ways: 14, used: 14, lv: [40, 85, 120, 160, 210, 95, 60, 30, 140, 180, 220, 75, 110, 150], mv: 188 },
    { ways: 14, used: 11, lv: [55, 90, 130, 170, 205, 65, 35, 145, 185, 80, 115], mv: 100 },
  ],
};
const bare = { modules: 16200, modPower: 650, inverters: 25, invAcKw: 350, stations: [] };

console.log("\n--- is there a layout at all ---");
ok(hasLayout(L), "a layout with modules on it is one");
ok(!hasLayout(null), "nothing is not");
ok(!hasLayout({ modules: 0 }), "and nor is an empty boundary");

console.log("\n--- LV runs for the AC cable tab ---");
{
  const r = lvRunsFromLayout(L);
  eq(r.count, 25, "one run per inverter");
  eq(r.longest, 220, "the longest, which is the one volt drop is checked on");
  eq(r.shortest, 30, "the shortest");
  near(r.mean, 118, 1, "and the mean, which the losses scale with");
  eq(r.total, 2950, "summed, they are the cable to buy");
  eq(lvRunsFromLayout(bare), null, "a layout with no routed cable hands over no length, not zero");
  eq(lvRunsFromLayout(null), null, "and no layout hands over nothing");
}

console.log("\n--- MV runs ---");
{
  const m = mvRunsFromLayout(L, { refInstall: "direct", refSize: 240 });
  eq(m.runs.length, 2, "one run per station");
  eq(m.runs[0], { branch: 1, from: "TS1", to: "POC", inv: 14, install: "direct", size: 240, dist: 188 },
     "each to the grid point, carrying its own inverters, on the tab's own size and method");
  eq(m.runs[1].inv, 11, "the short station carries only what is on it");
  eq(m.kva, 350, "with the inverter rating the layout was drawn with");
  eq(m.total, 288, "and the total matches the layout's routed MV length");
  eq(mvRunsFromLayout(L).runs[0].size, 150, "with no reference chosen it keeps the tab's defaults");
  eq(mvRunsFromLayout(bare), null, "no routed stations, no runs");
  const noPoi = { ...L, stations: L.stations.map((s) => ({ ...s, mv: null })) };
  eq(mvRunsFromLayout(noPoi), null, "stations with no route to a grid point hand over nothing");
}

console.log("\n--- the guided flow ---");
{
  const g = guidedFromLayout(L, { lat: -15.36, lon: 28.28 });
  const p = g.patch;
  eq(p.moduleCount, 16200, "the module count is the layout's own");
  eq(p.nInverter, 25, "the inverter count");
  eq(p.modulesInSeries, 27, "the string length");
  eq(p.areaHa, 18.1, "the area, in hectares");
  eq(p.pitchM, 5.5, "the pitch");
  eq(p.collectorWidthM, 2.38, "the collector width");
  eq(p.lat, -15.36, "and the site's coordinates");
  ok(!("tiltDeg" in p), "a tracker hands over no tilt, because it has none to give");
  eq(p.transformerKva, 4900, "every station is 14 ways, so the unit is 14 × 350 kVA");
  eq(g.notes.length, 0, "and there is nothing to caveat");

  eq(guidedFromLayout({ ...L, mounting: "fixed" }).patch.tiltDeg, 20, "a fixed array does hand over its tilt");

  /* Mixed station sizes: there is no single unit, and the BOM divides by one. */
  const mixed = { ...L, stations: [{ ways: 14, used: 14, lv: [50], mv: 100 }, { ways: 10, used: 10, lv: [60], mv: 90 }] };
  const gm = guidedFromLayout(mixed);
  ok(!("transformerKva" in gm.patch), "mixed station sizes hand over no transformer size");
  ok(/10 and 14 ways/.test(gm.notes[0]), "and say why");

  eq(guidedFromLayout(null), null, "no layout, no hand-over");
  ok(!("lat" in guidedFromLayout(L).patch), "no site pin, no coordinates");

  /* The point of the exercise: the BOM built from the hand-over is the
     layout's plant, not a retyped approximation of it. */
  const bom = buildBom({ ...p, modulesPerTable: 81, pilesPerTable: 9 });
  const line = (k) => bom.lines.find((l) => l.item === k);
  eq(line("PV modules").qty, 16200, "the BOM counts the layout's modules");
  eq(line("Inverters").qty, 25, "its inverters");
  eq(line("Strings").qty, 600, "and 16,200 over 27 is 600 strings");
  eq(line("Transformers").qty, 2, "on two transformers, as drawn");

  const rows = offerRows(GUIDED_ROWS, { moduleCount: 9000, nInverter: 25 }, p);
  const row = (k) => rows.find((r) => r.key === k);
  ok(row("moduleCount").differs, "a figure typed differently is shown as differing");
  ok(!row("nInverter").differs, "one already in step is not");
  eq(row("moduleCount").now, "9000", "with what is entered now");
  eq(row("moduleCount").next, "16200", "against what the layout says");
  ok(!rows.some((r) => r.key === "tiltDeg"), "and a figure the layout does not have is not offered at all");
  eq(row("areaHa").now, "—", "an empty field reads as a dash, not as undefined");
}

console.log("\n--- the PVsyst sweep ---");
{
  const s = sweepFromLayout(L);
  eq(s.patch.mount, "tracker", "the mounting carries across");
  eq(s.patch.nParallel, 600, "strings are the modules over the string length");
  eq(s.patch.nInverter, 25, "with the layout's inverters");
  ok(!("baseTilt" in s.patch), "and no base tilt for a tracker");
  eq(s.notes.length, 0, "nothing left over");
  const rr = ratioFor({ ...s.patch });
  eq(rr.dcKwp, 10530, "the plant PVsyst is given is the layout's 10.53 MWp");
  near(rr.ratio, 10530 / (25 * 350), 0.001, "and its DC/AC is the layout's own");

  const odd = sweepFromLayout({ ...L, modules: 16210, mounting: "fixed" });
  eq(odd.patch.nParallel, 600, "strings floor: ten odd modules do not make one");
  ok(/10 modules in the layout do not make up a string/.test(odd.notes[0]), "and the ten are reported");
  eq(odd.patch.baseTilt, 20, "a fixed array hands over its tilt as the base variant's");
  eq(sweepFromLayout({ ...L, mounting: "ew" }).patch.mount, "ew", "east-west stays east-west");
  ok(SWEEP_ROWS.every((r) => r.key in s.patch || r.key === "baseTilt"), "every row offered is one the hand-over can fill");
}

console.log("\n--- the fault study ---");
{
  const f = networkFromLayout(L, { ac: { vdSize: 300, par: 2, tCond: 90 }, source: { ukPct: 6, xOverR: 10 } });
  eq(f.station, 1, "the station with the most inverters is the one studied");
  eq(f.net.source.kva, 4900, "its transformer is 14 ways of 350 kVA");
  eq(f.net.source.uSecV, 800, "at the inverter's AC voltage");
  eq(f.net.source.u0V, 462, "which is 462 V to earth");
  eq(f.net.source.ukPct, 6, "the impedance is kept from the study, not invented");
  eq(f.net.nodes.length, 2, "two feeders, not fourteen");
  eq([f.shortest, f.longest], [30, 220], "the shortest and the longest of that station");
  eq(f.net.nodes[0].cable.lengthM, 30, "routed lengths on each");
  eq(f.net.nodes[1].cable.size, 300, "on the cable the AC tab chose");
  eq(f.net.nodes[1].cable.parallel, 2, "with its parallel count");
  eq(f.net.nodes[0].cable.peSize, null, "no protective conductor is assumed");
  eq(f.net.nodes[0].device, {}, "and no protective device");
  ok(f.notes.some((n) => /impedance is not something a layout knows/.test(n)), "the impedance is named as not known");
  ok(f.notes.some((n) => /unearthed \(IT\)/.test(n)), "and so is the earthing the study assumes");

  /* It must solve, and it must refuse to pass on what was not entered. */
  const solved = solveNetwork(f.net);
  const near1 = solved.nodes.get("near"), far1 = solved.nodes.get("far");
  ok(near1.ik3max > far1.ik3max, "the nearest feeder sees the higher fault current");
  ok(near1.ik3max < solved.source.ik3max, "and both sit below the transformer's");
  ok(near1.miss.some((m) => /protective conductor size/.test(m)), "the missing protective conductor is named");
  const chk = checkCable({ node: f.net.nodes[0], solved, source: solved.source });
  eq(chk.dev.reaches, null, "with no device there is no verdict on whether it operates");
  eq(chk.peOk, null, "and none on a protective conductor that is not there");
  ok(chk.line.pass === true || chk.line.pass === false, "while the line conductor, which is known, is checked");

  eq(networkFromLayout(L, {}).net.source.ukPct, null, "with no study to keep it from, the impedance stays empty");
  eq(networkFromLayout(bare, {}), null, "a layout with no routed cable builds no network");
  const one = networkFromLayout({ ...L, stations: [{ ways: 10, used: 1, lv: [70], mv: 50 }] }, {});
  eq(one.net.nodes.length, 1, "a station with one inverter gives one feeder, not the same one twice");
  ok(networkFromLayout({ ...L, invVac: null }, { source: { uSecV: 400 } }).notes.some((n) => /voltage is not set/.test(n)),
     "an inverter with no AC voltage leaves the study's own and says so");
}

console.log("\n--- stations sized from real transformers ---");
{
  const K = { ...L, stations: L.stations.map((s) => ({ ...s, kva: 5000 })) };
  eq(guidedFromLayout(K).patch.transformerKva, 5000, "the transformer's own rating is handed over, not ways × inverter");
  eq(networkFromLayout(K, {}).net.source.kva, 5000, "and the fault study is built on it");
  const mixedKva = { ...L, stations: [{ ...L.stations[0], kva: 5000 }, { ...L.stations[1], kva: 4000 }] };
  ok(!("transformerKva" in guidedFromLayout(mixedKva).patch), "two sizes of unit hand over no single size");
  ok(guidedFromLayout(mixedKva).notes.length > 0, "and say why");
}

console.log("\n--- feeders, when the layout chained its stations ---");
{
  const F = { ...L, radialMv: 288, feeders: [{ mva: 8.75, runs: [
    { from: 1, to: 0, len: 180.4, used: 11 }, { from: 0, to: null, len: 100.2, used: 14 }] }] };
  const m = mvRunsFromLayout(F, { refInstall: "direct", refSize: 300 });
  eq(m.feeders, 1, "the hand-over says it is one feeder");
  eq(m.runs, [
    { branch: 1, from: "TS2", to: "TS1", inv: 11, install: "direct", size: 300, dist: 180 },
    { branch: 1, from: "TS1", to: "POC", inv: 14, install: "direct", size: 300, dist: 100 },
  ], "as one branch, far end first, each run carrying the inverters that join at its own end");
  eq(m.total, 280, "with its own total");
  eq(m.radial, 288, "and the radial total beside it, for comparison");
  eq(mvRunsFromLayout(L).feeders, 0, "a layout with no feeders still hands over radials");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
