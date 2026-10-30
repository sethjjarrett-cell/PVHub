/* The bill of materials: quantities, never money. A rate per watt ages
   badly and gets quoted back at you; a count of tables and transformers
   is a fact about the design that a supplier can price. */
import { buildBom, bomToCsv, BOM_INPUTS, BOM_EXCLUSIONS, asciify } from "../src/bom.js";

let pass = 0, fail = 0;
const eq = (g, w, what) => {
  if (Object.is(g, w)) pass += 1;
  else { fail += 1; console.log(`  FAIL ${what}\n    got  ${JSON.stringify(g)}\n    want ${JSON.stringify(w)}`); }
};
const ok = (c, what) => { if (c) pass += 1; else { fail += 1; console.log(`  FAIL ${what}`); } };

const PLANT = { moduleCount: 9000, moduleWp: 650, modulesInSeries: 27,
  nInverter: 16, inverterKwac: 350, modulesPerTable: 28, pilesPerTable: 6,
  transformerKva: 3150 };
const line = (b, item) => b.lines.find((l) => l.item === item);

console.log("\n--- no money anywhere ---");
const src = (await import("node:fs")).readFileSync("src/bom.js", "utf8");
/* The same refusal the costing tool makes. A plausible embedded rate
   ends up in a board paper with nobody remembering where it came from. */
ok(!/\bprice\s*[:=]|costPer|ratePerW|£\d|\$\d|€\d/.test(src),
  "the module carries no price, rate or currency figure");
const b = buildBom(PLANT);
ok(b.lines.every((l) => !/price|cost|£|\$/i.test(JSON.stringify(l))),
  "and no line mentions money");

console.log("\n--- the quantities ---");
eq(line(b, "PV modules").qty, 9000, "modules come straight from the layout");
ok(/not a density assumption/.test(line(b, "PV modules").how),
  "and say they are a count, not an area estimate");
eq(line(b, "Inverters").qty, 16, "inverters as configured");
eq(line(b, "Inverters").spec, "350 kWac each", "with their rating");

console.log("\n--- rounding goes the way the money goes ---");
/* A part-filled string is not a string: floor. A part-filled table is
   still a table you buy: ceiling. Getting either backwards misstates
   the order. */
eq(line(b, "Strings").qty, 333, "strings FLOOR — 9000/27 is 333 and a bit");
eq(line(b, "Mounting tables").qty, 322, "tables CEIL — 9000/28 is 321 and a bit");
ok(/left over/.test(line(b, "Strings").spec), "the leftover modules are called out");
ok(b.assumptions.some((a) => /do not make up a full string/.test(a)),
  "and raised as an assumption, because they are modules bought and unconnected");
ok(/last table carries 12/.test(line(b, "Mounting tables").spec),
  "the part-filled table says how full it is");
/* 9072 = 27 x 28 x 12, so it divides exactly by both the string length
   and the table size — the one case where neither rounding bites. */
const exact = buildBom({ ...PLANT, moduleCount: 9072 });
eq(line(exact, "Mounting tables").qty, 324, "an exact multiple needs no rounding");
eq(line(exact, "Mounting tables").spec, "all tables full", "and says so");
eq(line(exact, "Strings").qty, 336, "and the strings come out whole");
eq(line(exact, "Strings").spec, null, "with nothing left over to report");

console.log("\n--- piles follow the tables ---");
eq(line(b, "Piles").qty, 322 * 6, "piles are tables times piles per table");
const noPiles = buildBom({ ...PLANT, pilesPerTable: 0 });
eq(line(noPiles, "Piles"), undefined, "no piles-per-table, no pile line");
ok(noPiles.missing.some((m) => /piles per table/.test(m)),
  "it is listed as missing rather than guessed at");

console.log("\n--- transformers, and how hard they are working ---");
eq(line(b, "Transformers").qty, 2, "5600 kW over 3150 kVA units is two, rounded up");
ok(/88\.9% loaded/.test(line(b, "Transformers").spec), "with the loading stated");
/* A plant that buys a unit it barely uses should see that before
   ordering, not after. */
const slack = buildBom({ ...PLANT, nInverter: 10, transformerKva: 3150 });
eq(line(slack, "Transformers").qty, 2, "3500 kW still needs two units");
ok(slack.assumptions.some((a) => /doing nothing/.test(a)),
  "and 55% loading is flagged as a lot of unused unit");
ok(!b.assumptions.some((a) => /doing nothing/.test(a)), "while 89% is not flagged");

console.log("\n--- a missing input is named, never filled in ---");
const bare = buildBom({});
eq(bare.lines.length, 0, "an empty plant yields no lines at all");
ok(bare.missing.some((m) => /module count/.test(m)), "and says the module count is missing");
ok(bare.missing.some((m) => /layout/.test(m)), "naming where it comes from");
const noTable = buildBom({ moduleCount: 9000, moduleWp: 650 });
eq(line(noTable, "Mounting tables"), undefined, "no modules-per-table, no table line");
ok(noTable.missing.some((m) => /modules per table/.test(m)), "listed as missing");
eq(line(noTable, "PV modules").qty, 9000, "while what IS known is still reported");
/* Partial data must never produce a zero quantity, which would read as
   "none needed" rather than "not known". */
ok(bare.lines.every((l) => l.qty > 0), "no line is ever emitted with a zero quantity");

console.log("\n--- every line shows its working ---");
ok(b.lines.every((l) => l.how && l.how.length > 8), "each line says how it was derived");
ok(b.lines.every((l) => l.item && l.unit), "and carries an item and a unit");
ok(/9000 modules at 27 in series/.test(line(b, "Strings").how), "with the actual arithmetic");

console.log("\n--- what it does not cover is said out loud ---");
ok(BOM_EXCLUSIONS.length >= 4, "there is a stated exclusion list");
ok(BOM_EXCLUSIONS.some((x) => /Cable/i.test(x)), "cable is excluded");
ok(BOM_EXCLUSIONS.some((x) => /routed layout/i.test(x)),
  "because lengths come off a routed layout, not a module count");
ok(BOM_EXCLUSIONS.some((x) => /[Cc]ivils|fencing/.test(x)), "civils are excluded");
ok(BOM_EXCLUSIONS.some((x) => /grid connection/i.test(x)), "and the grid connection");

console.log("\n--- the inputs it asks for ---");
eq(BOM_INPUTS.length, 3, "three extra inputs beyond the rest of the flow");
ok(BOM_INPUTS.every((i) => i.key && i.label && i.note), "each explains itself");
ok(BOM_INPUTS.some((i) => i.key === "transformerKva"), "including the transformer size");

console.log("\n--- the CSV a supplier gets ---");
const csv = bomToCsv(b, { project: "Example Field" });
ok(csv.includes("Example Field"), "names the project");
ok(/Item,Quantity,Unit,Specification,How it was derived/.test(csv), "has a header row");
ok(/PV modules,9000,off/.test(csv), "and the quantities");
ok(/Excluded by scope/.test(csv), "carries the exclusions, so scope is explicit to the bidder");
ok(csv.includes("\r\n"), "CRLF, for the spreadsheet it will be opened in");
const csvBare = bomToCsv(buildBom({}), {});
ok(/Not included because an input is missing/.test(csvBare),
  "a short BOM says why it is short rather than looking complete");

/* ---------------------------------------------------------------
   The exported file is pure ASCII
   --------------------------------------------------------------- */
{
  const bom = buildBom({
    moduleCount: 9000, moduleWp: 650, modulesInSeries: 28, modulesPerTable: 28,
    pilesPerTable: 6, nInverter: 16, inverterKw: 350, transformerKva: 3150,
  });
  const csv = bomToCsv(bom, { project: "Ascii check" });
  eq((csv.match(/[^\x09\x0a\x0d\x20-\x7e]/g) || []).length, 0,
     "the CSV carries no character outside printable ASCII");
  ok(/Strings,321,off,/.test(csv), "the string line survives the fold to ASCII");
  ok(/12 modules left over - short of a full string/.test(csv),
     "an em dash in the screen text becomes a hyphen in the file");

  eq(asciify("4.7 m × 2.3 m, 35°, 1.5 K·m/W"), "4.7 m x 2.3 m, 35 deg, 1.5 K.m/W",
     "the units a BOM note can carry are transliterated, not dropped");
  eq(asciify("‘quoted’ and “quoted”"), "'quoted' and \"quoted\"",
     "curly quotes become straight ones");
  eq(asciify(null), "", "a null folds to an empty string");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
