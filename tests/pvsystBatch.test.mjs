/* The batch parameter file PVhub writes for PVsyst.

   The loop is: decide the sweep here, run it in PVsyst, read the results
   back with batchAnalyser. So the two halves must agree on the file
   shape, and that agreement is what most of this checks. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  BATCH_PARAMS, paramById, customParam, range, sweepRows,
  buildBatchParamsCsv, parseBatchParamsCsv, pvsystStamp, runInstructions,
} from "../src/pvsystBatch.js";
import { parseBatchCsv } from "../src/batchAnalyser.js";

const here = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const eq = (g, w, what) => {
  if (Object.is(g, w)) pass += 1;
  else { fail += 1; console.log(`  FAIL ${what}\n    got  ${JSON.stringify(g)}\n    want ${JSON.stringify(w)}`); }
};
const ok = (c, what) => { if (c) pass += 1; else { fail += 1; console.log(`  FAIL ${what}`); } };

console.log("\n--- the parameter catalogue ---");
ok(BATCH_PARAMS.length >= 2, "there are parameters to sweep");
ok(BATCH_PARAMS.every((p) => p.group && p.id && p.label), "each has a heading, an id and a label");
/* Only headings actually observed in a PVsyst file are marked confirmed.
   A guessed heading produces a file PVsyst accepts and a sweep that
   moves nothing, which is worse than refusing to guess. */
ok(BATCH_PARAMS.every((p) => p.confirmed === true), "every shipped parameter is one observed in a real file");
eq(paramById("tilt").group, "Plane", "tilt sits under the Plane heading");
eq(paramById("tilt").sub, "tilt", "with sub-heading tilt");
eq(paramById("pitch").group, "Sheds 3D", "pitch sits under Sheds 3D");
eq(paramById("pitch").unit, "m", "and is in metres");
eq(paramById("nope"), null, "an unknown id gives null rather than a default");

const cu = customParam("Bifacial", "ground albedo", "", "Albedo");
eq(cu.confirmed, false, "a hand-typed column is never marked confirmed");
ok(/check the heading/i.test(cu.note), "and says it needs checking");
eq(customParam("", "x", "", ""), null, "a column with no heading is refused");

console.log("\n--- building a sweep ---");
eq(range(10, 12, 1).join(","), "10,11,12", "an inclusive integer range");
eq(range(10, 11, 0.5).join(","), "10,10.5,11", "a fractional range");
/* Repeated addition of 0.1 drifts; the values must stay clean because
   they are written into a file a human reads. */
eq(range(10, 10.3, 0.1).join(","), "10,10.1,10.2,10.3", "0.1 steps do not drift");
eq(range(20, 15, 1).join(","), "20,19,18,17,16,15", "a descending range");
eq(range(5, 5, 1).join(","), "5", "a range of one value");
eq(range(5, 10, 0).length, 0, "a zero step gives nothing rather than hanging");
eq(range(NaN, 10, 1).length, 0, "a bad bound gives nothing");

const tilt = paramById("tilt"), pitch = paramById("pitch");
const axes = [{ param: tilt, values: [15, 20] }, { param: pitch, values: [10, 11, 12] }];
const rows = sweepRows(axes);
eq(rows.length, 6, "two tilts by three pitches is six cases");
eq(rows[0].join(","), "15,10", "first case");
eq(rows[1].join(","), "15,11", "the last axis varies fastest, as in PVsyst's own files");
eq(rows[5].join(","), "20,12", "last case");
eq(sweepRows([]).length, 0, "no axes, no rows");
eq(sweepRows([{ param: tilt, values: [] }]).length, 0, "an axis with no values contributes nothing");

console.log("\n--- the written file ---");
const csv = buildBatchParamsCsv({
  project: "Eland.PRJ", baseVariant: "VCF", variantComment: "SAT Pitch 8m",
  axes, comment: "PVhub sweep", modified: "30/10/26 09:00",
});
const lines = csv.split("\r\n");
ok(/^PVsyst simulations Batch mode/.test(lines[0]), "starts with PVsyst's own banner");
ok(lines.some((l) => /^Project;;;Eland\.PRJ/.test(l)), "names the project");
ok(lines.some((l) => /^Variants based on;;VCF;SAT Pitch 8m/.test(l)), "names the base variant");
ok(lines.some((l) => /File modified on 30\/10\/26 09:00/.test(l)), "carries a timestamp");
ok(csv.includes("\r\n"), "CRLF line endings, as PVsyst writes");
/* Nothing outside ASCII is written. The degree and squared signs only
   occur in RESULT column units, which a parameter file does not carry,
   so there is no encoding to get wrong. */
ok(!/[^\x00-\x7F]/.test(csv), "the file is pure ASCII, so Windows-1252 and UTF-8 agree");

const hIdx = lines.findIndex((l) => l.startsWith("Ident;"));
ok(hIdx > 0, "there is an Ident header row");
eq(lines[hIdx], "Ident;Plane;Sheds 3D;Simul", "header names");
eq(lines[hIdx + 1], ";tilt;pitch;Comment", "sub-headings");
eq(lines[hIdx + 2], ";[deg];[m];", "units in brackets");
const sims = lines.filter((l) => /^SIM_/.test(l));
eq(sims.length, 6, "six SIM rows");
eq(sims[0], "SIM_1;15;10;PVhub sweep", "first row carries its values and the comment");
eq(sims[5], "SIM_6;20;12;PVhub sweep", "last row");
/* A parameter file states what to run. The outputs are PVsyst's to add
   when it writes the results file, and guessing at empty output columns
   was not verifiable against a real export. */
ok(!/E_Grid|ShdLoss|IL_Pmax/.test(csv), "no result columns are invented");

console.log("\n--- a semicolon in a comment does not break the row ---");
const risky = buildBatchParamsCsv({ axes, comment: "tilt; pitch study", modified: "01/01/26 00:00" });
const rrow = risky.split("\r\n").find((l) => /^SIM_1;/.test(l));
eq(rrow.split(";").length > 4, true, "an unquoted semicolon would add a column");
ok(/"tilt; pitch study"/.test(rrow), "so the comment is quoted");
const back = parseBatchParamsCsv(risky);
eq(back.cases[0].comment, "tilt; pitch study", "and survives being read back");

console.log("\n--- round trip ---");
const rt = parseBatchParamsCsv(csv);
ok(rt.ok, "the file reads back");
eq(rt.project, "Eland.PRJ", "project survives");
eq(rt.baseVariant, "VCF", "base variant survives");
eq(rt.variantComment, "SAT Pitch 8m", "variant comment survives");
eq(rt.params.length, 2, "both parameters recovered");
eq(rt.params[0].group, "Plane", "first parameter heading");
eq(rt.params[0].unit, "deg", "unit unwrapped from its brackets");
eq(rt.params[1].group, "Sheds 3D", "second parameter heading");
eq(rt.cases.length, 6, "all six cases");
eq(rt.cases[0].values.join(","), "15,10", "first case values");
eq(rt.cases[5].values.join(","), "20,12", "last case values");
const bad = parseBatchParamsCsv("nothing;useful\nhere;at all");
ok(!bad.ok && /Ident/.test(bad.error), "a file with no header is refused by name");

console.log("\n--- the two halves of the loop agree ---");
/* The results reader finds the header by looking for "Ident", splits
   swept parameters from outputs at the "Simul" column, and reads units
   from the bracket row. A parameter file written here must satisfy all
   of that; it legitimately fails only on having no E_Grid, because it
   carries no results yet. */
let reachedResults = false, headerError = false;
try { parseBatchCsv(csv); }
catch (e) {
  if (/No header row found/i.test(e.message)) headerError = true;
  if (/E_Grid/i.test(e.message)) reachedResults = true;
}
ok(!headerError, "the results reader finds our header row");
ok(reachedResults, "and gets all the way to looking for outputs before complaining");

/* And the real PVsyst results file still parses, so nothing here has
   disturbed the reader the loop depends on. */
const solango = readFileSync(join(here, "fixtures", "Solango_Project_BatchResults_0.CSV"));
const parsed = parseBatchCsv(new Uint8Array(solango));
ok(parsed.rows.length > 0, `PVsyst's own results file still parses (${parsed.rows.length} rows)`);
/* Our header must use the same wording PVsyst does, or a sweep written
   here would not line up with a results file read back. */
const names = (parsed.columns || []).map((c) => `${c.group}|${c.sub}`);
ok(names.includes("Plane|tilt"), "PVsyst's own file uses Plane|tilt, as we write");
ok(names.includes("Sheds 3D|pitch"), "and Sheds 3D|pitch, as we write");

console.log("\n--- the timestamp and the instructions ---");
ok(/^\d{2}\/\d{2}\/\d{2} \d{2}:\d{2}$/.test(pvsystStamp(new Date(2026, 9, 30, 9, 5))),
  "the stamp is dd/mm/yy hh:mm");
eq(pvsystStamp(new Date(2026, 0, 2, 3, 4)), "02/01/26 03:04", "single digits are padded");
const steps = runInstructions({ project: "Eland.PRJ", baseVariant: "VCF", fileName: "sweep.CSV" });
ok(steps.length >= 5, "the run instructions have real steps");
ok(steps.some((s) => /Eland\.PRJ/.test(s)), "naming the project");
ok(steps.some((s) => /sweep\.CSV/.test(s)), "and the file");
ok(steps.some((s) => /E_Grid/.test(s)), "and the output variable the analyser needs");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
