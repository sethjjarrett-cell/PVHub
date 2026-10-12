/* Trench occupancy, the layout export, and the DXF reader — including a
   round trip through our own writer, which is the only honest way to
   check the two agree. */
import { analyseTrenches, analyseMv, layoutToDxf, LAYOUT_LAYERS } from '../src/layoutDxf.js';
import { parseDxf, closedPolygons, stitchLines, pickOutline, routeLengths } from '../src/dxfRead.js';
import { roofToDxf, buildDxf, polyline3d, countEntities } from '../src/dxf.js';

let pass = 0, fail = 0;
const ok = (n, c, got) => { if (c) { pass++; console.log(`  PASS ${n}`); }
  else { fail++; console.log(`  FAIL ${n}` + (got !== undefined ? `  got ${got}` : '')); } };
const near = (n, a, b, t = 1e-6) => ok(n, Math.abs(a - b) <= t, a);

console.log('--- trench occupancy ---');
{ /* Three runs down a shared spine, then branching. The spine carries
     three circuits; each branch carries one. */
  const paths = [
    [{x:0,y:0},{x:10,y:0},{x:10,y:5}],
    [{x:0,y:0},{x:10,y:0},{x:10,y:-5}],
    [{x:0,y:0},{x:10,y:0},{x:15,y:0}],
  ];
  const t = analyseTrenches(paths);
  ok('three routes counted', t.routes === 3, t.routes);
  ok('the spine carries three', t.maxCircuits === 3, t.maxCircuits);
  near('total trench length is the union, not the sum', t.totalLength, 10 + 5 + 5 + 5);
  ok('the busiest segment is the spine',
    Math.hypot(t.busiest.b.x - t.busiest.a.x, t.busiest.b.y - t.busiest.a.y) === 10);
  near('length at the maximum is the spine only', t.lengthAtMax, 10);
  const h3 = t.histogram.find((h) => h.circuits === 3);
  const h1 = t.histogram.find((h) => h.circuits === 1);
  ok('histogram splits 3 and 1', h3 && h1 && h3.segments === 1 && h1.segments === 3,
    JSON.stringify(t.histogram)); }
{ /* Length-weighted mean is not the same as the maximum, and that is the
     point of reporting both. */
  const paths = [
    [{x:0,y:0},{x:1,y:0},{x:101,y:0}],
    [{x:0,y:0},{x:1,y:0}],
    [{x:0,y:0},{x:1,y:0}],
  ];
  const t = analyseTrenches(paths);
  ok('max is 3 on the short stub', t.maxCircuits === 3, t.maxCircuits);
  ok('but a typical metre carries far less', t.weightedMean < 1.1,
    t.weightedMean.toFixed(3)); }
{ /* Floating point drift between identical routes must not read as two
     separate trenches. */
  const a = [{x:0,y:0},{x:10,y:0}];
  const b = [{x:0,y:0},{x:10.0000001,y:0}];
  const t = analyseTrenches([a, b]);
  ok('drift does not split a shared trench', t.maxCircuits === 2, t.maxCircuits);
  ok('and only one segment is recorded', t.segments.length === 1, t.segments.length); }
{ /* Direction must not matter — a trench does not care which way the
     cable runs down it. */
  const t = analyseTrenches([[{x:0,y:0},{x:5,y:0}], [{x:5,y:0},{x:0,y:0}]]);
  ok('reversed routes share the trench', t.maxCircuits === 2, t.maxCircuits); }
{ /* A route that doubles back over itself counts once on that segment. */
  const t = analyseTrenches([[{x:0,y:0},{x:5,y:0},{x:0,y:0},{x:5,y:0}]]);
  ok('a doubling-back route counts once', t.maxCircuits === 1, t.maxCircuits); }
{ const t = analyseTrenches([]);
  ok('no paths gives zeroes, not NaN', t.maxCircuits === 0 && t.totalLength === 0
    && t.busiest === null); }
{ const t = analyseTrenches([[{x:0,y:0}], [{x:1,y:1},{x:1,y:1}]]);
  ok('degenerate paths are ignored', t.segments.length === 0, t.segments.length); }
{ ok('the MV analysis is the same function', typeof analyseMv === 'function'); }

console.log('\n--- layout export ---');
const boundary = [{x:0,y:0},{x:100,y:0},{x:100,y:80},{x:0,y:80}];
const blocks = [
  { x: 10, y: 10, w: 30, h: 20, inv: 1, mx: 25, my: 20 },
  { x: 50, y: 10, w: 30, h: 20, inv: 2, mx: 65, my: 20 },
];
const frames = [{ x: 11, y: 11, w: 4, h: 2 }, { x: 16, y: 11, w: 4, h: 2 }];
const cabling = {
  paths: [[{x:25,y:20},{x:25,y:45},{x:50,y:45}], [{x:65,y:20},{x:65,y:45},{x:50,y:45}]],
  mvPaths: [[{x:50,y:45},{x:50,y:70},{x:95,y:70}]],
  subs: [{ x: 50, y: 45, ways: 4, used: 2 }],
  markers: [{ inv: 1, x: 25, y: 20 }, { inv: 2, x: 65, y: 20 }],
};
{ const tr = analyseTrenches(cabling.paths);
  const dxf = layoutToDxf({ boundary, blocks, frames, cabling, poi: { x: 95, y: 70 },
    trenches: tr, title: "TEST SITE" });
  const c = countEntities(dxf);
  ok('valid file', dxf.startsWith("0\nSECTION\n") && dxf.trimEnd().endsWith("EOF"));
  ok('all layout layers declared', LAYOUT_LAYERS.every((l) => dxf.includes(`2\n${l.name}\n`)));
  ok('boundary, two blocks, two LV runs and one MV run',
    c.POLYLINE === 1 + 2 + 2 + 1, c.POLYLINE);
  ok('frames are off by default', !dxf.includes("PV-FRAME\n10\n11"), 'frames leaked');
  ok('substation and inverters are circles', c.CIRCLE === 1 + 2 + 1, c.CIRCLE);
  ok('the busiest trench is drawn as a LINE', c.LINE >= 1, c.LINE);
  ok('text present', c.TEXT > 0, c.TEXT);
  ok('group codes alternate', dxf.split("\n").length % 2 === 1); }
{ const dxf = layoutToDxf({ boundary, blocks, frames, includeFrames: true });
  const c = countEntities(dxf);
  ok('frames included on request', c.POLYLINE === 1 + 2 + 2, c.POLYLINE); }
{ const dxf = layoutToDxf({});
  ok('an empty layout still writes a valid file',
    dxf.includes("ENTITIES") && dxf.trimEnd().endsWith("EOF")); }

console.log('\n--- reader: round trip through our own writer ---');
{ const dxf = layoutToDxf({ boundary, blocks, cabling, poi: { x: 95, y: 70 } });
  const p = parseDxf(dxf);
  ok('layers come back', p.layers.includes("PV-BOUNDARY") && p.layers.includes("PV-CABLE-LV"),
    p.layers.join(','));
  ok('nothing was skipped', p.skipped.length === 0, JSON.stringify(p.skipped));
  const polys = closedPolygons(p, { layer: "PV-BOUNDARY" });
  ok('one closed boundary', polys.length === 1, polys.length);
  ok('with four corners', polys[0].points.length === 4, polys[0].points.length);
  near('and the right area via pickOutline',
    pickOutline(p, { layer: "PV-BOUNDARY" }).areaM2, 8000, 1e-6);
  const r = routeLengths(p, { layer: "PV-CABLE-LV" });
  ok('two LV runs measured', r.runs === 2, r.runs);
  near('their total length', r.totalLength, (25 + 25) + (25 + 15), 1e-6); }
{ /* The roof writer's output must read back too — same reader, both
     producers, so a change to either shows up here. */
  const dxf = roofToDxf({ planes: [{ name: "P1", outline:
    [{x:0,y:0,z:3},{x:6,y:0,z:3},{x:6,y:4,z:5.8},{x:0,y:4,z:5.8}],
    usable: [{x:0.3,y:0.3},{x:5.7,y:0.3},{x:5.7,y:3.7},{x:0.3,y:3.7}],
    modules: [{ quad: [{x:1,y:1},{x:2,y:1},{x:2,y:3},{x:1,y:3}] }],
    keepOuts: [], obstructions: [], plane: { a: 0, b: 0.7, c: 3 }, pitch: 35, azimuth: 180 }] });
  const p = parseDxf(dxf);
  ok('roof layers read back', p.layers.includes("PV-MODULE"), p.layers.join(','));
  const mods = closedPolygons(p, { layer: "PV-MODULE" });
  ok('one module polygon', mods.length === 1, mods.length);
  ok('z values survive', mods[0].points.every((q) => q.z > 0),
    JSON.stringify(mods[0].points.map((q) => q.z))); }

console.log('\n--- reader: other producers ---');
{ /* LWPOLYLINE, which is what most modern exporters write. */
  const f = ["0","SECTION","2","ENTITIES",
    "0","LWPOLYLINE","8","SITE","70","1",
    "10","0","20","0","10","10","20","0","10","10","20","8","10","0","20","8",
    "0","ENDSEC","0","EOF"].join("\n");
  const p = parseDxf(f);
  const polys = closedPolygons(p);
  ok('LWPOLYLINE parsed', polys.length === 1 && polys[0].points.length === 4,
    JSON.stringify(polys[0]?.points));
  near('its area', pickOutline(p).areaM2, 80, 1e-9); }
{ /* Loose lines that form a ring. */
  const seg = (x1,y1,x2,y2) => ["0","LINE","8","B","10",x1,"20",y1,"30","0","11",x2,"21",y2,"31","0"];
  const f = ["0","SECTION","2","ENTITIES",
    ...seg(0,0,10,0), ...seg(10,0,10,6), ...seg(10,6,0,6), ...seg(0,6,0,0),
    "0","ENDSEC","0","EOF"].join("\n");
  const p = parseDxf(f);
  ok('lines are not closed polygons', closedPolygons(p).length === 0);
  const st = stitchLines(p, { layer: "B" });
  ok('but they stitch into a ring', st.length === 1 && st[0].closed, JSON.stringify(st.map(s=>s.closed)));
  near('with the right area', pickOutline(p).areaM2, 60, 1e-9);
  ok('pickOutline says it stitched them', pickOutline(p).source === "stitched lines"); }
{ /* Lines with a small gap — real CAD rarely snaps perfectly. */
  const seg = (x1,y1,x2,y2) => ["0","LINE","8","B","10",x1,"20",y1,"11",x2,"21",y2];
  const f = ["0","SECTION","2","ENTITIES",
    ...seg(0,0,10,0), ...seg(10.02,0,10,6), ...seg(10,6,0,6), ...seg(0,6,0,0),
    "0","ENDSEC","0","EOF"].join("\n");
  ok('a 20 mm gap still stitches at the default tolerance',
    pickOutline(parseDxf(f)).outline !== null);
  ok('but not at a tight tolerance',
    pickOutline(parseDxf(f), { tol: 0.001 }).outline === null); }
{ /* A drawing whose geometry is inside a block must say so rather than
     coming back silently empty. */
  const f = ["0","SECTION","2","ENTITIES",
    "0","INSERT","8","X","2","BOUNDARY_BLOCK","10","0","20","0",
    "0","ENDSEC","0","EOF"].join("\n");
  const p = parseDxf(f);
  ok('INSERT is recorded as skipped', p.skipped.some((s) => s.type === "INSERT"));
  const r = pickOutline(p);
  ok('and the reason mentions blocks', /block reference/.test(r.reason || ''), r.reason); }
{ const p = parseDxf("");
  ok('an empty file parses to nothing', p.entities.length === 0);
  ok('with a reason', /no entities/.test(pickOutline(p).reason || ''), pickOutline(p).reason); }
{ /* Largest ring wins — a boundary contains everything else. */
  const lw = (layer, pts, ) => { const o = ["0","LWPOLYLINE","8",layer,"70","1"];
    for (const [x,y] of pts) { o.push("10",String(x),"20",String(y)); } return o; };
  const f = ["0","SECTION","2","ENTITIES",
    ...lw("A", [[0,0],[4,0],[4,4],[0,4]]),
    ...lw("A", [[0,0],[40,0],[40,30],[0,30]]),
    "0","ENDSEC","0","EOF"].join("\n");
  const r = pickOutline(parseDxf(f));
  near('the larger ring is chosen', r.areaM2, 1200, 1e-9);
  ok('and the smaller is still listed', r.candidates.length === 2, r.candidates.length); }
{ /* 3DFACE, which some exporters use for panels. */
  const f = ["0","SECTION","2","ENTITIES",
    "0","3DFACE","8","P","10","0","20","0","30","0","11","2","21","0","31","0",
    "12","2","22","1","32","0","13","0","23","1","33","0",
    "0","ENDSEC","0","EOF"].join("\n");
  const polys = closedPolygons(parseDxf(f));
  ok('3DFACE reads as a quad', polys.length === 1 && polys[0].points.length === 4,
    polys[0]?.points?.length); }
{ /* A file with a stray odd line must resynchronise rather than die. */
  const f = ["0","SECTION","2","ENTITIES","GARBAGE",
    "0","LWPOLYLINE","8","S","70","1","10","0","20","0","10","5","20","0","10","5","20","5",
    "0","ENDSEC","0","EOF"].join("\n");
  let threw = null;
  try { const p = parseDxf(f); ok('a malformed line does not throw', p.entities.length >= 0); }
  catch (e) { threw = e; ok('a malformed line does not throw', false, e.message); } }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
