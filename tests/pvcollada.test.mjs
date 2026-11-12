/* PVCollada 2.0 export. The XSD and Schematron check needs lxml and the
   pvlib/pvcollada schema files, so it is a manual step (CLAUDE.md); this
   checks the structure and every number that matters without them. */

import { toPvCollada, pvcMissing, frameRacks } from "../src/pvcollada.js";
import { makeGeoRef } from "../src/sitePull.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log("  FAIL:", m); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
const near = (a, b, tol, m) => ok(Math.abs(a - b) <= tol, `${m} (got ${a}, want ${b} ±${tol})`);

/* Tags open and close in order, attributes quoted: enough to catch a
   writer that drops a closing tag or an unescaped ampersand. */
function wellFormed(xml) {
  const body = xml.replace(/^<\?xml[^>]*\?>/, "");
  if (/&(?!amp;|lt;|gt;|quot;|apos;)/.test(body)) return "bare ampersand";
  const stack = [];
  for (const m of body.matchAll(/<(\/?)([A-Za-z_][\w:.-]*)([^>]*?)(\/?)>/g)) {
    const [, close, name, , self] = m;
    if (self) continue;
    if (close) { if (stack.pop() !== name) return `mismatched </${name}>`; }
    else stack.push(name);
  }
  return stack.length ? `unclosed <${stack[stack.length - 1]}>` : "ok";
}
const all = (xml, tag) => [...xml.matchAll(new RegExp(`<${tag}>([^<]*)</${tag}>`, "g"))].map((m) => m[1]);
const one = (xml, tag) => all(xml, tag)[0];

const RADc = Math.PI / 180;
function fgFor(mounting, over = {}) {
  const fg = { dAlong: 1.134, dAcross: 2.278, nP: 1, alongCount: 27, gapAlong: 0.025, crossGap: 0.02,
    endOverhang: 0.15, centreGap: 0.6, tilt: 25, clearance: 0.5, maxRot: 60, ridgeGap: 0.3,
    orientation: "portrait", mounting, ...over };
  fg.alongLen = fg.alongCount * fg.dAlong + (fg.alongCount - 1) * fg.gapAlong + 2 * fg.endOverhang + fg.centreGap;
  fg.acrossW = fg.nP * fg.dAcross + (fg.nP - 1) * fg.crossGap;
  fg.planAcross = mounting === "fixed" ? fg.acrossW * Math.cos(fg.tilt * RADc) : fg.acrossW;
  fg.modules = fg.alongCount * fg.nP;
  return fg;
}
const plan = (fg) => (fg.mounting === "fixed" ? { w: fg.alongLen, h: fg.planAcross } : { w: fg.planAcross, h: fg.alongLen });
const module = { model: "Test 650", manufacturer: "Smith & Sons", power: 650, length: 2.278, width: 1.134, depth: 0.035 };
const north = makeGeoRef({ lat: 52, lon: -1, source: "kml" });
const southG = makeGeoRef({ lat: -15.36, lon: 28.28, source: "kml" });
const created = "2026-11-12T10:00:00.000Z";

console.log("\n--- what it needs ---");
{
  const fg = fgFor("tracker"), { w, h } = plan(fg);
  const frames = [{ x: 0, y: 0, w, h }];
  eq(pvcMissing({ frames, fg, module, geo: north }), [], "a complete set needs nothing");
  ok(pvcMissing({ frames, fg, module: { ...module, depth: undefined }, geo: north }).some((s) => /depth/.test(s)),
     "a module with no depth is named as missing, never given a typical one");
  ok(pvcMissing({ frames, fg, module: { ...module, model: " " }, geo: north }).some((s) => /model name/.test(s)),
     "and one with no name");
  ok(pvcMissing({ frames: [], fg, module, geo: north }).some((s) => /layout/.test(s)), "no frames, no file");
  ok(pvcMissing({ frames, fg, module, geo: null }).some((s) => /position/.test(s)), "no position, no file");
  const ew = toPvCollada({ frames, fg: fgFor("ew"), module, geo: north, created });
  ok(!ew.ok && ew.missing.some((s) => /east-west/.test(s)), "an east-west frame is withheld until PVhub agrees with itself (G45)");
}

console.log("\n--- a tracker plant ---");
{
  const fg = fgFor("tracker"), { w, h } = plan(fg);
  const frames = [];
  for (let i = 0; i < 3; i++) frames.push({ x: i * 6, y: 0, w, h, block: 1 }, { x: i * 6, y: h + 2, w, h, block: 2 });
  const r = toPvCollada({ frames, fg, module, geo: north, created, acW: 1e6, project: { name: "Test <site>" } });
  ok(r.ok, "it writes");
  eq(wellFormed(r.xml), "ok", "and is well formed");
  eq(r.counts.tables, 6, "a table per frame");
  eq(r.counts.racksPerTable, 2, "two racks each, split at the centre gap as it is built");
  eq(r.counts.modules, 6 * 27, "every module, and no more");
  eq(+one(r.xml, "pv:module_count"), 162, "the count is in the project block");
  near(+one(r.xml, "pv:capacity_dc"), 162 * 650, 1e-6, "and the DC capacity in watts");
  eq(one(r.xml, "pv:name"), "Test &lt;site&gt;", "names are escaped");
  ok(r.xml.includes("Smith &amp; Sons"), "the maker too");
  eq(one(r.xml, "pv:length"), "2278", "module dimensions in millimetres, as the schema says");
  eq(one(r.xml, "pv:depth"), "35", "including the depth");
  eq(all(r.xml, "pv:rack_type"), ["tracker", "tracker"], "tracker racks");
  eq(one(r.xml, "pv:tracker_max_rotation"), "-60 60", "the rotation range, negative first");
  near(+one(r.xml, "pv:tracker_height"), 0.5 + (2.278 / 2) * Math.sin(60 * RADc), 0.001,
       "the tube at the height where the low edge meets the clearance at full rotation");
  ok(/derived/.test(r.xml), "and the file says that height was derived");
  eq(all(r.xml, "pv:module_columns").map(Number), [14, 13], "27 modules split 14 and 13 either side of the gap");
  eq(all(r.xml, "pv:inset_first_column"), ["0.15"], "the end overhang is an inset on the outer ends only");
  const ids = [...r.xml.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
  eq(ids.length, new Set(ids).size, "every id is unique");
  ok(!/<pv:tilt>/.test(r.xml), "a tracker rack carries no fixed tilt, which the business rules forbid");
  eq(/<altitude mode="absolute">/.test(r.xml), true, "the altitude is absolute, as the structure rules require");
  ok(r.notes.some((n) => /flat/.test(n)), "no terrain: the export says the plant is flat");
  /* North is −y in layout metres: the second row sits further down the screen, so further south. */
  const tr = [...r.xml.matchAll(/<translate>([^<]+)<\/translate>/g)].map((m) => m[1].split(" ").map(Number));
  ok(tr[1][1] < tr[0][1], "a frame lower on the screen is further south in the file");
  near(tr[2][0] - tr[0][0], 6, 1e-6, "and one to the right is six metres east");
}

console.log("\n--- fixed tilt, both hemispheres ---");
{
  const fg = fgFor("fixed", { nP: 2 }), { w, h } = plan(fg);
  const frames = [{ x: 0, y: 0, w, h }];
  const n = toPvCollada({ frames, fg, module, geo: north, created });
  eq(wellFormed(n.xml), "ok", "well formed");
  eq(all(n.xml, "pv:azimuth"), ["180", "180"], "north of the equator a fixed rack faces south");
  eq(all(n.xml, "pv:tilt"), ["25", "25"], "at the frame's tilt");
  eq(all(n.xml, "pv:module_rows"), ["2", "2"], "two up");
  const s = toPvCollada({ frames, fg, module, geo: southG, created });
  eq(all(s.xml, "pv:azimuth"), ["0", "0"], "south of it, north");
  const { racks } = frameRacks(fg, { south: false });
  const r0 = racks[0].pts;
  near(r0[2][2] - r0[0][2], fg.acrossW * Math.sin(25 * RADc), 1e-9, "the rack rises by its slant width times sin tilt");
  near(r0[2][1] - r0[0][1], fg.planAcross, 1e-9, "over a plan depth equal to the frame's");
  ok(r0[0][1] < r0[2][1], "with the low edge to the south in the north");
  const sr = frameRacks(fg, { south: true }).racks[0].pts;
  ok(sr[0][1] > sr[2][1], "and to the north in the south");
  const span = racks[racks.length - 1].pts[1][0] - racks[0].pts[0][0];
  near(span, fg.alongLen, 1e-9, "the racks and the gap between them add up to the frame's length");
}

console.log("\n--- terrain ---");
{
  const fg = fgFor("tracker"), { w, h } = plan(fg);
  const t = { x0: -100, y0: -100, cell: 2, nx: 301, ny: 201,
    z: Float64Array.from({ length: 301 * 201 }, (_, k) => 50 + 0.01 * (k % 301)) };
  const r = toPvCollada({ frames: [{ x: 0, y: 0, w, h }], fg, module, geo: north, terrain: t, created, maxTerrainVerts: 5000 });
  eq(wellFormed(r.xml), "ok", "well formed with a terrain");
  const vc = +one(r.xml, "pv:vertex_count");
  ok(vc <= 5000 * 1.1 && vc > 1000, "thinned to about the limit asked for");
  ok(r.notes.some((n) => /thinned/.test(n)), "and says so");
  near(+r.xml.match(/<altitude mode="absolute">([^<]+)</)[1], 50 + 0.01 * 50, 1e-6, "the altitude is the ground at the origin");
  const z = +r.xml.match(/<translate>[^ ]+ [^ ]+ ([^<]+)<\/translate>/)[1];
  near(z, 0.01 * (w / 2) / 2, 0.002, "and a table stands on the ground relative to it");
  eq(+one(r.xml, "pv:triangle_count"), +r.xml.match(/<triangles count="(\d+)" material="GroundMat"/)[1],
     "the terrain's triangle count agrees with its mesh");
}

console.log("\n--- frames that do not fit the geometry ---");
{
  const fg = fgFor("tracker"), { w, h } = plan(fg);
  const r = toPvCollada({ frames: [{ x: 0, y: 0, w, h }, { x: 9, y: 0, w: w + 1, h }], fg, module, geo: north, created });
  eq(r.counts.tables, 1, "a frame of another size is left out rather than drawn wrong");
  ok(r.notes.some((n) => /left out/.test(n)), "and named");
  const a = toPvCollada({ frames: [{ x: 0, y: 0, w, h }], fg, module, geo: makeGeoRef({ lat: 52, lon: -1 }), created });
  ok(/ASSUMED/.test(a.xml), "an assumed position is written into the file as assumed");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
