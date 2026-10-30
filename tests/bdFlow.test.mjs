/* The guided business-development flow: which step is next, what each
   one still wants, and the guards that stop a wrong number reaching a
   client. The engineering lives elsewhere — this is the path through it. */
import {
  STEPS, stepById, assess, stepState, nextStep, derive, summarise,
  sanityChecks, SANITY,
} from "../src/bdFlow.js";

let pass = 0, fail = 0;
const eq = (g, w, what) => {
  if (Object.is(g, w)) pass += 1;
  else { fail += 1; console.log(`  FAIL ${what}\n    got  ${JSON.stringify(g)}\n    want ${JSON.stringify(w)}`); }
};
const ok = (c, what) => { if (c) pass += 1; else { fail += 1; console.log(`  FAIL ${what}`); } };

const FULL = {
  lat: -25.66, lon: 30.23, areaHa: 60, tempPulled: true,
  moduleWp: 650, inverterKwac: 350, nInverter: 16, modulesInSeries: 27,
  pitchM: 7, tiltDeg: 20, collectorWidthM: 4.7, specificYield: 1800,
  moduleCount: 9000, capexPerWp: 0.55,
};

console.log("\n--- the steps run in dependency order ---");
eq(STEPS.length, 7, "seven steps");
ok(STEPS.every((s, i) => s.n === i + 1), "numbered in order");
ok(STEPS.every((s) => s.title && s.asks && s.gives), "each says what it asks and what it gives");
/* The ordering that matters: the sweep decides the pitch, and the pitch
   is an INPUT to the layout — so the sweep comes first. The layout then
   says how many kWp fit, which the sweep's per-kWp yield multiplies. */
const idx = (id) => STEPS.findIndex((s) => s.id === id);
ok(idx("sweep") < idx("layout"), "the sweep comes before the layout, because it sets the pitch");
ok(idx("layout") < idx("yield"), "and the layout before the yield, because it sets the capacity");
ok(idx("string") < idx("sweep"), "string length is settled before the sweep that uses it");
ok(idx("yield") < idx("quote"), "and the energy before the money");
/* Every declared dependency must name a step that exists and comes
   earlier, or the flow could point at something unreachable. */
for (const s of STEPS) {
  for (const need of s.needs) {
    ok(stepById(need) !== null, `${s.id} needs ${need}, which exists`);
    ok(idx(need) < idx(s.id), `and ${need} comes before ${s.id}`);
  }
}
eq(stepById("nope"), null, "an unknown step id gives null");

console.log("\n--- an empty project ---");
const empty = assess({});
eq(nextStep(empty).id, "site", "the first thing asked for is the site");
eq(stepState("site", empty), "todo", "site is to do");
eq(stepState("string", empty), "blocked", "string sizing is blocked behind it");
eq(stepState("quote", empty), "blocked", "and so is the quote");
ok(empty.site.missing.includes("coordinates"), "it names the coordinates as missing");
ok(empty.site.missing.includes("site area"), "and the area");
ok(empty.kit.missing.length === 2, "and both pieces of kit");

console.log("\n--- nothing is defaulted ---");
/* A step with no data reports what is missing. It must never report
   itself done on the strength of a substituted figure. */
for (const s of STEPS) ok(!assess({})[s.id].done, `${s.id} is not done on an empty project`);
const zeroArea = assess({ lat: 1, lon: 1, areaHa: 0 });
eq(zeroArea.site.done, false, "a zero area is missing, not a site");
const zeroWp = assess({ moduleWp: 0, inverterKwac: 350 });
eq(zeroWp.kit.done, false, "a zero module rating is missing, not a module");

console.log("\n--- the sweep can be outstanding without stopping the work ---");
/* A PVsyst run is hours on someone else's machine. Waiting for it
   before finding out whether the site even holds the target is the
   wrong way round, so the layout runs on a provisional pitch. */
const waiting = assess({ ...FULL, specificYield: null });
eq(stepState("sweep", waiting), "provisional", "the sweep reads as provisional, not blocked");
eq(stepState("layout", waiting), "done", "the layout still completes");
eq(waiting.layout.onProvisionalPitch, true, "and records that its pitch was assumed");
eq(stepState("yield", waiting), "blocked", "but the yield waits for a real specific yield");
ok(waiting.sweep.missing.includes("PVsyst's specific yield"), "which it names");
const landed = assess(FULL);
eq(stepState("sweep", landed), "done", "results arriving settles the sweep");
eq(landed.layout.onProvisionalPitch, false, "and the layout is no longer on an assumed pitch");
eq(nextStep(landed), null, "a complete project has no next step");

console.log("\n--- the numbers, and how each was reached ---");
const d = derive(FULL);
eq(d.dcKwp, 5850, "DC is modules x Wp");
eq(d.acKw, 5600, "AC is inverters x rating");
eq(d.dcac, 1.045, "DC/AC is that division");
/* The standing rule: PVsyst gives kWh per kWp, the layout gives the
   kWp. Multiplying them is why the two run separately. */
eq(d.annualMwh, 10530, "annual energy is specific yield x capacity");
eq(d.capex, Math.round(5850 * 1000 * 0.55), "capex is capacity x rate");
ok(/9000 modules/.test(d.dcKwpHow), "the capacity shows its arithmetic");
ok(/from PVsyst/.test(d.annualHow) && /from the layout/.test(d.annualHow),
  "and the energy names both sources");
const partial = derive({ moduleCount: 100 });
eq(partial.dcKwp, null, "a missing module rating gives null, not a guess");
eq(partial.annualMwh, null, "and nothing downstream is invented either");
eq(partial.dcKwpHow, null, "with no derivation to show");

console.log("\n--- the guards a BD will not think to apply ---");
eq(sanityChecks(FULL).length, 0, "a sound project raises nothing");
/* Each of these looks fine on screen and is obviously wrong to anyone
   who sizes plants. */
const tooFew = sanityChecks({ ...FULL, nInverter: 4 });
ok(tooFew.some((c) => c.field === "dcac" && c.severity === "bad"),
  "four inverters on this array is caught");
ok(/too low|too big/.test(tooFew[0].text), "and the message says which way round");
const tooMany = sanityChecks({ ...FULL, nInverter: 40 });
ok(tooMany.some((c) => c.field === "dcac"), "forty inverters is caught too");
ok(/too many|too small/.test(tooMany.find((c) => c.field === "dcac").text),
  "with the opposite advice");
ok(sanityChecks({ ...FULL, specificYield: 18000 }).some((c) => c.field === "specificYield"),
  "a specific yield off by a factor of ten is caught");
ok(sanityChecks({ ...FULL, pitchM: 4.9 }).some((c) => c.field === "pitchM"),
  "a pitch tighter than the collector is caught");
ok(/axis to axis/.test(sanityChecks({ ...FULL, pitchM: 4.9 }).find((c) => c.field === "pitchM").text),
  "and it suggests the likely cause");
ok(sanityChecks({ ...FULL, capexPerWp: 550 }).some((c) => c.field === "capexPerWp"),
  "a rate entered per kWp instead of per Wp is caught");
ok(sanityChecks({ ...FULL, areaHa: 2 }).some((c) => c.field === "areaHa"),
  "5.85 MWp on two hectares is caught as physically impossible");
/* Wide on purpose: these catch a wrong number, not a bold one. */
eq(sanityChecks({ ...FULL, nInverter: 13 }).length, 0, "a DC/AC of 1.29 is left alone");
ok(SANITY.dcac[0] < 1.0 && SANITY.dcac[1] > 1.5, "the DC/AC guard is wider than any typical band");
const band = sanityChecks({ ...FULL, nInverter: 13 }, { dcacBand: [1.0, 1.1] });
ok(band.some((c) => c.field === "dcac"), "a caller can tighten the band to its mount type");

console.log("\n--- the headline ---");
const sum = summarise(FULL);
eq(sum.ready, true, "a complete project is ready to quote");
eq(sum.provisional, false, "and not provisional");
ok(/MWp/.test(sum.text), "the headline is in MWp once past a megawatt");
ok(/MWh a year/.test(sum.text), "and names the annual energy");
eq(sum.caveat, null, "with no caveat");
const prov = summarise({ ...FULL, specificYield: null });
eq(prov.ready, false, "without a simulated yield it is not ready");
ok(prov.provisional, "it is marked provisional");
ok(/not been simulated/.test(prov.caveat), "and the caveat says why");
ok(/before this goes to a client/.test(prov.caveat), "and what that means");
const nothing = summarise({});
eq(nothing.ready, false, "an empty project is not ready");
ok(/Not enough yet/.test(nothing.text), "and says so plainly");
ok(summarise({ ...FULL, nInverter: 4 }).checks.length > 0,
  "the headline carries the sanity checks with it");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
