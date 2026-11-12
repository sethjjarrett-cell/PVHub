/* The one-page preliminary report: what it says, and what it refuses to. */

import { prelimGaps, planSvg, prelimReportHtml } from "../src/prelimReport.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log("  FAIL:", m); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

const summary = {
  name: "A — 8×1 uniform blocks", dcMWp: 11.37, modules: 17496, modPower: 650, inverters: 27, invAcKw: 350,
  strings: 648, frames: 216, areaM2: 160475, flatShare: 0.94, lv: 9800, mv: 1200, mounting: "tracker",
  pitch: 5.5, collectW: 2.278, modulesPerString: 27,
  stations: [{ ways: 14, used: 14, kva: 5000 }, { ways: 14, used: 13, kva: 5000 }],
  feeders: null, radialMv: 1200, access: { length: 640, width: 5, crossings: 2 }, unreachableInv: 0,
};
const plan = {
  boundary: [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 380 }, { x: 0, y: 380 }],
  zones: [{ name: "Pond", pts: [{ x: 10, y: 10 }, { x: 40, y: 10 }, { x: 40, y: 40 }], buffer: 10 },
    { name: "Overhead line 33 kV", pts: [{ x: 0, y: 200 }, { x: 400, y: 200 }, { x: 400, y: 201 }], buffer: 0, osm: "way/1#0#0,200" }],
  blocks: [{ x: 50, y: 50, w: 100, h: 96 }], stations: [{ x: 160, y: 100 }], poi: { x: 400, y: 190 },
  entrance: { x: 0, y: 300 }, mv: [[{ x: 160, y: 100 }, { x: 400, y: 190 }]], road: [{ a: { x: 0, y: 300 }, b: { x: 160, y: 300 } }],
};
const full = {
  summary, plan, boundarySource: "kml", terrainSource: "pulled", weatherSource: "EUMETSAT SARAH-3",
  yield: { specYield: 2050, geomKeep: 0.97, keepIsEntered: true, netSpec: 1988.5, annualGWh: 22.6, cf: 0.27, dataset: "PVGIS-SARAH3" },
  lat: 52, lon: -1, date: "12 November 2026", moduleName: "Test 650 <bifacial>", title: "Test site",
};

console.log("\n--- what it owns up to ---");
{
  const g = prelimGaps(full);
  ok(!g.some((x) => x.level === "gap" && /yield/i.test(x.text)), "with a baseline loaded, yield is not listed as missing");
  ok(g.some((x) => /30 m screening/.test(x.text)), "pulled terrain is called a screening surface");
  ok(g.some((x) => x.level === "assumed" && /1 of 2 exclusions has no buffer/.test(x.text)), "a zone with no buffer is counted");
  ok(g.some((x) => /No prices/.test(x.text)), "and the absence of prices is stated, not hidden");

  const bare = prelimGaps({ summary: { ...summary, access: null }, plan: { ...plan, zones: [] }, boundarySource: "drawn" });
  ok(bare.some((x) => x.level === "assumed" && /drawn/.test(x.text)), "a drawn boundary is an assumed position");
  ok(bare.some((x) => x.level === "gap" && /No terrain/.test(x.text)), "no terrain is a gap");
  ok(bare.some((x) => x.level === "gap" && /No yield/.test(x.text)), "no baseline is a gap");
  ok(bare.some((x) => x.level === "gap" && /entrance/.test(x.text)), "no entrance, no road quantity");
  ok(bare.some((x) => /OpenStreetMap/.test(x.text)), "and an empty exclusion list points at the OSM import");
  ok(prelimGaps({ ...full, terrainSource: "demo" }).some((x) => x.level === "gap" && /fictional/.test(x.text)),
     "the demo terrain is never passed off as ground");
  ok(prelimGaps({ ...full, yield: { ...full.yield, keepIsEntered: false } }).some((x) => x.level === "assumed" && /calibration/.test(x.text)),
     "a modelled shading factor is an assumption");
  ok(prelimGaps({ ...full, summary: { ...summary, mounting: "ew" } }).some((x) => /G45/.test(x.text)),
     "east-west frames carry their known fault");
  ok(prelimGaps({ ...full, summary: { ...summary, unreachableInv: 3 } }).some((x) => /3 inverters are cut off/.test(x.text)),
     "uncabled inverters are listed");
}

console.log("\n--- the plan ---");
{
  const svg = planSvg(plan);
  ok(svg.startsWith("<svg") && svg.endsWith("</svg>"), "an SVG");
  eq((svg.match(/<polygon/g) || []).length, 2 + 1 + 1, "two exclusions, a block and the boundary");
  ok(/>50 m</.test(svg), "a scale bar of a round length, no more than a fifth of the site (80 m here)");
  ok(/>N</.test(svg), "and a north arrow");
  eq(planSvg({ boundary: [] }), "", "no boundary, no plan");
}

console.log("\n--- the page ---");
{
  const h = prelimReportHtml(full);
  ok(h.startsWith("<!doctype html>") && h.includes('lang="en-GB"'), "a standalone British English page");
  ok(/@page \{ size: A4/.test(h), "set for A4");
  ok(h.includes("NOT FOR CONSTRUCTION"), "that says what it is not");
  ok(h.includes("11.37 MWp") && h.includes("17,496 × 650 W"), "with the plant's figures as the layout gave them");
  ok(h.includes("Test 650 &lt;bifacial&gt;"), "names escaped");
  ok(h.includes("9.45 MVA") && h.includes("1.20"), "AC capacity and DC/AC from the inverters");
  ok(h.includes("1,989 kWh/kWp") && h.includes("2,050 from PVGIS"), "the yield, and where it came from");
  ok(/do not have the same standing/.test(h), "with the standing of each half stated");
  ok(h.includes("10.00 MVA"), "station MVA from real transformer ratings when every station has one");
  ok(h.includes("© OpenStreetMap contributors, ODbL"), "OSM attribution wherever its data is used");
  const none = prelimReportHtml({ summary: { ...summary, stations: [{ ways: 14, used: 14 }] }, plan, boundarySource: "dxf" });
  ok(/No yield is given/.test(none), "no baseline: no yield figure at all, rather than a typical one");
  ok(!/kWh\/kWp/.test(none), "not even a specific yield");
  ok(/not assessed/.test(none), "flat ground is not claimed without terrain");
  ok(/1 station<\/td>/.test(none), "and station MVA is not invented from ways");
  ok(!/[—]{2}/.test(h), "no doubled dashes from missing values");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
