/* Tests for the PVsyst simulation-report reader.
   The fixture is the text of a real PVsyst 8.1 report — a grid-connected,
   fixed-tilt, self-consumption run — extracted with the same
   line-grouping the browser uses, so what is parsed here is
   byte-identical to what the application sees. The project name, site,
   country, author and coordinates have been replaced with placeholders,
   because this repository is public and the report is a client's. Every
   line's structure is untouched, which is what the parsing depends on. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  parsePvsystReport, parsePvsystDate, recordFromReport, recordTitle,
  findDuplicates, lossMatrix, fieldSpread, projectsToCsv, projectsToJson,
  projectsFromJson, REPORT_FIELDS, isSameRun, dedupeAgainst,
} from "../src/pvsystReport.js";

const here = dirname(fileURLToPath(import.meta.url));
const TEXT = readFileSync(join(here, "fixtures", "pvsyst-report-fixed-tilt.txt"), "utf8");

let pass = 0, fail = 0;
const eq = (got, want, what) => {
  const ok = Object.is(got, want);
  if (ok) pass += 1; else { fail += 1; console.log(`  FAIL ${what}\n    got  ${got}\n    want ${want}`); }
};
const near = (got, want, tol, what) => {
  const ok = typeof got === "number" && Math.abs(got - want) <= tol;
  if (ok) pass += 1; else { fail += 1; console.log(`  FAIL ${what}: got ${got}, want ${want}±${tol}`); }
};
const ok = (cond, what) => { if (cond) pass += 1; else { fail += 1; console.log(`  FAIL ${what}`); } };

console.log("\n--- parsing a real fixed-tilt report ---");
const r = parsePvsystReport(TEXT);
ok(r.ok, "report recognised");
const f = r.fields;

/* identity */
eq(f.pvsystVersion, "8.1.7", "PVsyst version");
eq(f.project, "Example Solar Project Testland", "project");
eq(f.variant, "Preliminary Design EX - Self Consumption - N S", "variant");
eq(f.author, "Example Engineering Ltd (Testland)", "author");
eq(f.simulatedAt, "16/10/26 14:00", "simulation date");
eq(f.simulatedIso, "2026-10-16", "simulation date as ISO");
eq(f.systemKind, "Grid-Connected System", "system kind");
eq(f.mounting, "Tables on a building", "mounting");

/* site */
near(f.lat, -15.1, 1e-6, "latitude");
near(f.lon, 28.1, 1e-6, "longitude");
eq(f.altitude, 1246, "altitude");
eq(f.timezone, "UTC+2", "time zone");
near(f.albedo, 0.2, 1e-9, "albedo");
eq(f.siteName, "Example Solar Project", "site name");
eq(f.country, "Testland", "country");
ok(/Solargis/.test(f.weatherSource || ""), "weather source names Solargis");

/* size — the figures the tracker exists to compare */
eq(f.moduleCount, 1008, "module count");
eq(f.pnomDc, 600, "DC capacity kWp");
eq(f.inverterCount, 3, "inverter count");
eq(f.pnomAc, 450, "AC capacity kWac");
/* Derived from 600 / 450, so 1.333 — the report rounds its own printed
   figure to 1.33. The derived one is used because the printed label is
   ambiguous across reports; it must still agree with what was printed. */
near(f.pnomRatio, 1.3333, 0.001, "DC/AC ratio derived from the plant totals");
near(f.pnomRatio, 1.33, 0.005, "and agrees with the figure the report prints");
ok(/derived/.test(r.src.pnomRatio), "and says it was derived");
eq(f.moduleArea, 2604, "module area");
eq(f.moduleWp, 595, "module rating Wp");
eq(f.inverterKwac, 150, "inverter unit rating kWac");
eq(f.stringCount, 56, "strings");
eq(f.modulesInSeries, 18, "modules in series");
eq(f.moduleMfr, "Suntech", "module manufacturer");
eq(f.inverterMfr, "Sungrow", "inverter manufacturer");
eq(f.moduleModel, "STP595S-C72/Nsh+_1500V", "module model");
eq(f.inverterModel, "SG150CX", "inverter model");

near(f.pnomDc / f.pnomAc, f.pnomRatio, 0.005, "the ratio is that division");
/* likewise the module count against modules-in-series x strings */
eq(f.stringCount * f.modulesInSeries, f.moduleCount, "strings x series = module count");
/* and the nameplate against count x unit rating */
near(f.moduleCount * f.moduleWp / 1000, f.pnomDc, 0.5, "modules x Wp = DC capacity");
near(f.inverterCount * f.inverterKwac, f.pnomAc, 0.5, "inverters x kWac = AC capacity");

/* geometry */
near(f.tilt, 3, 1e-9, "tilt");
near(f.azimuth, 2, 1e-9, "azimuth");
eq(f.orientationCount, 2, "two orientations (east/west split)");
near(f.gcr, 95.9, 1e-9, "GCR");
near(f.pitch, 1.18, 1e-9, "shed spacing");

/* yield */
eq(f.producedKwh, 1035984, "produced energy");
eq(f.specificYield, 1727, "specific yield");
near(f.pr, 80.48, 1e-9, "performance ratio");
eq(f.usedKwh, 3059070, "used energy");
near(f.solarFraction, 33.87, 1e-9, "solar fraction");
near(f.globHor, 2141.9, 1e-9, "annual GlobHor");
near(f.globInc, 2146.3, 1e-9, "annual GlobInc");
near(f.globEff, 2023.0, 1e-9, "annual GlobEff");
near(f.tAmb, 20.6, 1e-9, "annual mean ambient");

/* specific yield is stated and derivable; they must agree */
near(f.producedKwh / f.pnomDc, f.specificYield, 2, "produced / kWp = specific yield");

console.log("\n--- the monthly balance table ---");
eq(r.monthly.length, 12, "twelve months read");
eq(r.monthly[0].month, "January", "first month");
near(r.monthly[0].GlobHor, 170.6, 1e-9, "January GlobHor");
near(r.monthly[0].T_Amb, 21.2, 1e-9, "January ambient");
eq(r.monthly[0].EArray, 84043, "January EArray");
near(r.monthly[11].GlobHor, 184.0, 1e-9, "December GlobHor");
/* the columns were read off the header, not assumed */
ok(r.monthlyCols.includes("GlobHor") && r.monthlyCols.includes("EArray"),
  "column names taken from the header row");
/* this is a self-consumption run, so E_Grid is zero all year and the
   production lives in EArray — a reader that assumed E_Grid was the
   yield would report this plant as generating nothing */
ok(r.monthly.every((m) => m.E_Grid === 0), "E_Grid is zero throughout (no reinjection)");
const sumArray = r.monthly.reduce((a, m) => a + m.EArray, 0);
near(sumArray, 1067499, 12, "monthly EArray sums to the annual figure");

console.log("\n--- the loss diagram ---");
const byAlias = (a) => r.losses.find((l) => l.alias === a);
ok(r.losses.length >= 15, `loss rows found (${r.losses.length})`);
near(byAlias("Near shading").pct, -0.37, 1e-9, "near shading loss");
near(byAlias("Soiling").pct, -3.0, 1e-9, "soiling loss");
near(byAlias("IAM (incidence)").pct, -2.47, 1e-9, "IAM loss");
near(byAlias("Temperature").pct, -7.94, 1e-9, "temperature loss");
near(byAlias("LID").pct, -1.0, 1e-9, "LID loss");
near(byAlias("Mismatch").pct, -2.1, 1e-9, "mismatch loss");
near(byAlias("DC wiring").pct, -1.49, 1e-9, "DC ohmic loss");
near(byAlias("Inverter efficiency").pct, -1.64, 1e-9, "inverter efficiency loss");
near(byAlias("Inverter clipping").pct, -0.44, 1e-9, "inverter clipping loss");
near(byAlias("AC wiring").pct, -0.14, 1e-9, "AC ohmic loss");
near(byAlias("Unused energy").pct, -1.17, 1e-9, "unused energy (no reinjection)");
near(byAlias("Module quality").pct, 0.6, 1e-9, "module quality is a gain here, not a loss");
near(byAlias("Transposition gain").pct, 0.2, 1e-9, "transposition gain onto the plane");
/* a row this reader has no alias for is still captured, under PVsyst's
   own wording — the whole point of reading the diagram generically */
ok(r.losses.some((l) => !l.alias), "unrecognised loss rows are kept rather than dropped");

/* The diagram must contain the diagram and nothing else. The array-loss
   PARAMETERS page carries lines of the same shape, and reading the whole
   document turned "Loss Fraction 2.00 % at STC" into a loss row called
   "at STC" and the module efficiency into a +23% gain. Both would then
   appear as columns in every comparison. */
eq(r.losses.length, 20, "exactly the diagram's rows, no more");
for (const junk of ["at STC", "at MPP", "PV conversion"]) {
  ok(!r.losses.some((l) => l.label === junk),
    `"${junk}" is not treated as a loss row`);
}
ok(!r.losses.some((l) => /Module temperature according to/.test(l.label)),
  "the thermal-model description is not treated as a loss row");
ok(!r.losses.some((l) => l.pct > 1),
  "no row claims a gain larger than 1% (the module efficiency used to)");

console.log("\n--- array parameters read only where unambiguous ---");
near(f.moduleEffPct, 23.03, 1e-9, "module efficiency at STC");
near(f.ucConst, 18, 1e-9, "thermal Uc");
near(f.uvWind, 0, 1e-9, "thermal Uv");
near(f.arrayResMohm, 20, 1e-9, "global array resistance");
/* The soiling, LID, quality and mismatch fractions share one line in a
   three-column block, so flattened text cannot say which is which. They
   are deliberately absent rather than guessed: reading the first match
   returned 0.10% (the strings mismatch) as the soiling loss. The loss
   diagram carries all four correctly. */
eq(f.soilingPct, undefined, "the ambiguous soiling input is not guessed at");
near(byAlias("Soiling").pct, -3.0, 1e-9, "and the diagram has the real soiling figure");

console.log("\n--- energy milestones ---");
const mile = (s) => r.milestones.find((m) => m.label.includes(s));
eq(mile("Array nominal energy").kwh, 1213299, "array nominal energy");
eq(mile("Array virtual energy").kwh, 1072159, "array virtual energy at MPP");
eq(mile("Available Energy").kwh, 1049747, "available energy at inverter output");
/* the milestones must descend — if they do not, the rows were mismatched */
ok(mile("Array nominal energy").kwh > mile("Array virtual energy").kwh
  && mile("Array virtual energy").kwh > mile("Available Energy").kwh,
  "milestones descend down the diagram");

console.log("\n--- honesty about what was not found ---");
ok(Array.isArray(r.missing), "missing list present");
ok(!r.missing.includes("producedKwh"), "a field that was found is not listed missing");
/* Long enough to clear the "no text at all" guard — this is a report
   that WAS read, just one with no yield in it. */
const partial = parsePvsystReport(["PVsyst V8.1.7", "Project: Half A Report", "Simulation report",
  ...Array.from({ length: 30 }, (_, i) => `some other line ${i}`)].join("\n"));
ok(!partial.ok, "a report with no yield is not reported as understood");
ok(partial.warnings.length > 0, "and says why");
const notReport = parsePvsystReport("Some other PDF entirely\nwith no header");
ok(!notReport.ok && notReport.error, "a non-PVsyst PDF is rejected with a reason");

console.log("\n--- dates ---");
eq(parsePvsystDate("16/10/26 14:00").iso, "2026-10-16", "dd/mm/yy parsed");
eq(parsePvsystDate("01/01/25").iso, "2025-01-01", "date without a time");
eq(parsePvsystDate("rubbish"), null, "unparseable date returns null, not today");

console.log("\n--- records, duplicates and comparison ---");
const a = recordFromReport(r, { fileName: "report-a.pdf" });
const b = recordFromReport(r, { fileName: "report-a-again.pdf" });
ok(a.id !== b.id, "re-importing the same report makes a separate record");
eq(recordTitle(a), "Example Solar Project Testland — Preliminary Design EX - Self Consumption - N S",
  "record title joins project and variant");
eq(findDuplicates([a, b]).length, 1, "the two are flagged as the same project and variant");

const c = recordFromReport(r, { fileName: "other.pdf" });
c.fields = { ...c.fields, project: "Other Site", specificYield: 1500, pnomDc: 2000 };
const spread = fieldSpread([a, c], "specificYield");
eq(spread.n, 2, "spread counts both records");
eq(spread.min, 1500, "spread minimum");
eq(spread.max, 1727, "spread maximum");
eq(spread.highest.fields.project, "Example Solar Project Testland", "highest record identified");
const noField = fieldSpread([a, c], "nonexistentField");
eq(noField.n, 0, "a field nobody has gives an empty spread");
eq(noField.absent, 2, "and counts the records that lack it");

/* a record missing a loss row reads as absent, never as zero — a zero
   would say "no loss here", which is a different claim */
const d = recordFromReport(r, {});
d.losses = d.losses.filter((l) => l.alias !== "Soiling");
const mat = lossMatrix([a, d]);
const soil = mat.find((m) => m.key === "Soiling");
near(soil.values[0], -3.0, 1e-9, "record with soiling keeps its value");
eq(soil.values[1], null, "record without soiling reads null, not 0");

console.log("\n--- export and round trip ---");
const csv = projectsToCsv([a, c]);
const head = csv.split("\n")[0];
ok(head.includes("Specific yield"), "CSV header carries the field labels");
ok(head.includes("Loss: Near shading (%)"), "CSV header carries a column per loss row");
eq(csv.split("\n").length, 3, "one header and two rows");
ok(csv.split("\n")[1].includes("1727"), "the specific yield is in the row");

const round = projectsFromJson(projectsToJson([a, c]));
ok(round.ok, "JSON round trip parses");
eq(round.records.length, 2, "both records survive");
eq(round.records[0].fields.producedKwh, 1035984, "a value survives the round trip");
eq(round.records[0].losses.length, a.losses.length, "the loss diagram survives");
eq(round.records[0].monthly.length, 12, "the monthly table survives");
eq(round.records[0].src.producedKwh, a.src.producedKwh, "the source line survives");

const bad = projectsFromJson("{not json");
ok(!bad.ok && bad.error, "bad JSON is rejected with a reason");
const empty = projectsFromJson('{"format":"x"}');
ok(!empty.ok, "JSON with no record list is rejected");
const mixed = projectsFromJson(JSON.stringify({ records: [a, null, { nope: 1 }] }));
eq(mixed.records.length, 1, "entries that are not records are skipped");
eq(mixed.skipped, 2, "and counted");

console.log("\n--- field catalogue ---");
const keys = REPORT_FIELDS.map((x) => x.key);
eq(new Set(keys).size, keys.length, "no duplicate field keys");
ok(REPORT_FIELDS.every((x) => x.label && x.group), "every field has a label and a group");
ok(REPORT_FIELDS.filter((x) => x.headline).length >= 6, "there are headline fields for the table");
ok(REPORT_FIELDS.every((x) => x.kind === "text" || typeof x.dp === "number"),
  "every numeric field states its decimal count rather than guessing at render time");


/* =====================================================================
   THE OTHER REPORT SHAPES
   Three real reports, not one. Each broke something the first did not:
   a plant quoted in MWp with inverters in kVA, a plant built from
   several sub-arrays with different string lengths, and a bifacial
   ground mount whose loss diagram carries rear-side rows.
   ================================================================== */
const SUB = readFileSync(join(here, "fixtures", "pvsyst-report-subarrays.txt"), "utf8");
const BIF = readFileSync(join(here, "fixtures", "pvsyst-report-bifacial-mw.txt"), "utf8");

console.log("\n--- a plant built from several sub-arrays ---");
const rs = parsePvsystReport(SUB);
const fs2 = rs.fields;
ok(rs.ok, "sub-array report recognised");
eq(fs2.moduleCount, 11300, "module count is the plant's, from the summary");
eq(fs2.subArrayCount, 3, "three sub-array blocks found");
/* The bug this fixture exists for: taking the first "Modules N x M In
   series" described sub-array one (390 x 27 = 10,530) as though it were
   the plant (11,300). Nothing downstream would have caught it. */
eq(fs2.stringCount, 420, "strings are summed across sub-arrays, not taken from the first");
ok(fs2.stringCount !== 390, "and are not sub-array one's figure");
eq(fs2.modulesInSeries, undefined, "no single string length is reported when they differ");
ok(rs.warnings.some((w) => /String length varies/.test(w)), "and the report says why");
ok(rs.warnings.some((w) => /27/.test(w) && /22/.test(w)), "naming the lengths found");
eq(fs2.pnomDc, 7571, "DC capacity");
eq(fs2.pnomAc, 4480, "AC capacity");
near(fs2.pnomRatio, 1.69, 0.005, "DC/AC derived from the plant totals");
near(fs2.pnomDc / fs2.pnomAc, fs2.pnomRatio, 0.001, "and it is genuinely that division");
eq(fs2.producedKwh, 6465365, "produced energy");
eq(fs2.specificYield, 854, "specific yield");
near(fs2.producedKwh / fs2.pnomDc, fs2.specificYield, 2, "produced / kWp = specific yield");
eq(rs.monthly.length, 12, "twelve months");
ok(rs.losses.length >= 20, `loss rows (${rs.losses.length})`);
eq(fs2.orientationCount, 2, "east and west orientations");

console.log("\n--- a plant quoted in MWp with inverters in kVA ---");
const rb = parsePvsystReport(BIF);
const fb = rb.fields;
ok(rb.ok, "bifacial report recognised");
/* "Pnom total 77.75 MWp" — a kWp-only pattern read nothing at all. */
eq(fb.pnomDc, 77750, "MWp is normalised to kWp");
eq(fb.pnomDcUnit, "kWp", "and recorded as a real-power unit");
/* "Total power 52480 kVA" — apparent power, which is NOT kWac. */
eq(fb.pnomAc, 52480, "kVA is read");
eq(fb.pnomAcUnit, "kVA", "and kept as kVA rather than relabelled kWac");
eq(fb.inverterKwac, 320, "inverter unit rating in kVA");
eq(fb.moduleCount, 119610, "module count");
eq(fb.stringCount, 4430, "strings");
eq(fb.modulesInSeries, 27, "a uniform string length is reported");
eq(fb.stringCount * fb.modulesInSeries, fb.moduleCount, "strings x series = modules");
/* The ratio trap: this plant is curtailed, so the report prints
   "Grid lim. Pnom ratio 1.558" as well as a DC:AC of 1.48. Taking a
   "Pnom ratio" by pattern returns the grid figure and overstates the
   array against its inverters by 5%. */
near(fb.pnomRatio, 1.482, 0.005, "DC/AC is the plant's own division, not the grid limit");
ok(fb.pnomRatio < 1.5, "and is not the 1.558 grid-limited figure");
ok(/derived/.test(rb.src.pnomRatio), "the ratio shows that it was derived");
ok(rb.src.pnomRatio.includes("kVA"), "and names the unit it divided by");
eq(fb.producedKwh, 73166288, "produced energy");
eq(fb.specificYield, 941, "specific yield");
near(fb.producedKwh / fb.pnomDc, fb.specificYield, 2, "produced / kWp = specific yield");
ok(/Solargis/.test(fb.weatherSource || ""), "weather source read although it shares a line");
ok(/strings/i.test(fb.nearShadingModel || ""), "the 'According to strings' shading model is read");
near(fb.gcr, 65.6, 1e-9, "GCR");
near(fb.pitch, 10.9, 1e-9, "row pitch");
/* A bifacial diagram carries rear-side rows the first report has no
   concept of. They must survive under PVsyst's own wording. */
ok(rb.losses.some((l) => /rear side/i.test(l.label)), "rear-side loss rows are kept");
ok(rb.losses.some((l) => /Medium voltage transfo/i.test(l.label)), "MV transformer loss kept");
ok(rb.losses.length >= 28, `a fuller diagram than the roof report (${rb.losses.length} rows)`);

console.log("\n--- reports that cannot be read say why ---");
const noText = parsePvsystReport("\n\n   \n\n");
ok(!noText.ok, "an empty extraction is not ok");
ok(/no text in this PDF/i.test(noText.error), "and is called out as a PDF with no text");
ok(/Print to PDF/i.test(noText.error), "naming the usual cause");
ok(/Export the report/i.test(noText.error), "and the fix");
const wrongKind = parsePvsystReport(Array.from({ length: 40 }, (_, i) => `line ${i} of some other document`).join("\n"));
ok(!wrongKind.ok, "a text PDF that is not a PVsyst report is not ok");
ok(/does not look like a PVsyst/i.test(wrongKind.error), "and says so");
ok(!/no text/i.test(wrongKind.error), "without blaming the extraction");

console.log("\n--- the same report twice is not two projects ---");
const base = recordFromReport(r, { fileName: "a.pdf" });
const same = recordFromReport(parsePvsystReport(TEXT), { fileName: "a-copy.pdf" });
ok(isSameRun(base, same), "same project, variant and timestamp is the same run");
const other = recordFromReport(rs, { fileName: "b.pdf" });
ok(!isSameRun(base, other), "a different project is not");

/* A re-run of the same variant carries a different simulation time, and
   that one must come in — the change between two runs is the point. */
const rerun = recordFromReport(parsePvsystReport(TEXT), { fileName: "a-rerun.pdf" });
rerun.fields = { ...rerun.fields, simulatedAt: "20/10/26 09:15" };
ok(!isSameRun(base, rerun), "a re-run at a different time is a different run");

const d1 = dedupeAgainst([base], [same, other, rerun]);
eq(d1.kept.length, 2, "the duplicate is dropped, the new project and the re-run are kept");
eq(d1.duplicates.length, 1, "one duplicate reported");
eq(d1.duplicates[0].rec.fileName, "a-copy.pdf", "and it is named");
eq(d1.kept.map((x) => x.fileName).sort().join(","), "a-rerun.pdf,b.pdf", "the right two survive");

/* Two copies in the SAME drop must also collapse, not just against what
   is already tracked. */
const d2 = dedupeAgainst([], [base, same]);
eq(d2.kept.length, 1, "duplicates within one import are caught too");
eq(d2.duplicates.length, 1, "and counted");
const d3 = dedupeAgainst([], []);
eq(d3.kept.length, 0, "nothing in, nothing out");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
