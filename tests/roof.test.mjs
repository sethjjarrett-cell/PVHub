/* Roof geometry and the DXF writer. Geometry is checked against shapes
   whose answer is known by hand; the DXF against its own structure,
   since the only other check is opening it in AutoCAD. */
import {
  signedArea, area, normalise, centroid, bbox, pointInPolygon, segmentsCross,
  polysCross, polyInside, polysOverlap, offsetPolygon, rect,
  fitPlane, heightsFromPitch, zAt, surfaceFrame, toPlan, toSurface,
  surfaceArea, autoFill, bestFill,
} from '../src/roofGeom.js';
import { buildDxf, roofToDxf, countEntities, polyline3d, ROOF_LAYERS } from '../src/dxf.js';

let pass = 0, fail = 0;
const ok = (n, c, got) => { if (c) { pass++; console.log(`  PASS ${n}`); }
  else { fail++; console.log(`  FAIL ${n}` + (got !== undefined ? `  got ${got}` : '')); } };
const near = (n, a, b, t = 1e-6) => ok(n, Math.abs(a - b) <= t, a);

const sq = [{x:0,y:0},{x:10,y:0},{x:10,y:8},{x:0,y:8}];

console.log('--- polygon basics ---');
near('area of a 10x8 rectangle', area(sq), 80);
ok('anticlockwise winding is positive', signedArea(sq) > 0, signedArea(sq));
ok('clockwise input is normalised', signedArea(normalise([...sq].reverse())) > 0);
{ const c = centroid(sq); near('centroid x', c.x, 5); near('centroid y', c.y, 4); }
{ const b = bbox(sq); ok('bbox', b.minX===0 && b.maxX===10 && b.minY===0 && b.maxY===8); }
ok('a point inside is inside', pointInPolygon({x:5,y:4}, sq));
ok('a point outside is outside', !pointInPolygon({x:11,y:4}, sq));
ok('a point on an edge counts as inside', pointInPolygon({x:10,y:4}, sq));
ok('a point on a corner counts as inside', pointInPolygon({x:0,y:0}, sq));

console.log('\n--- intersection ---');
ok('crossing segments cross', segmentsCross({x:0,y:0},{x:2,y:2},{x:0,y:2},{x:2,y:0}));
ok('parallel segments do not', !segmentsCross({x:0,y:0},{x:2,y:0},{x:0,y:1},{x:2,y:1}));
ok('touching endpoints count', segmentsCross({x:0,y:0},{x:2,y:0},{x:2,y:0},{x:4,y:0}));
ok('a small square inside a big one does not cross it', !polysCross(rect(2,2,2,2), sq));
ok('and is reported inside', polyInside(rect(2,2,2,2), sq));
ok('a square poking out is not inside', !polyInside(rect(9,2,4,2), sq));
ok('overlap catches containment without crossing', polysOverlap(rect(2,2,2,2), sq));
ok('disjoint squares do not overlap', !polysOverlap(rect(20,20,2,2), sq));

console.log('\n--- offset ---');
{ const o = offsetPolygon(sq, -1);
  ok('inset is not degenerate', !o.degenerate);
  near('a 1 m inset of 10x8 gives 8x6', area(o.poly), 48, 1e-6); }
{ const o = offsetPolygon(sq, 0.5);
  near('a 0.5 m outset gives 11x9', area(o.poly), 99, 1e-6); }
{ const o = offsetPolygon(sq, -5);
  ok('an inset that eats the shape is flagged', o.degenerate); }
{ const tri = [{x:0,y:0},{x:4,y:0},{x:0,y:3}];
  const o = offsetPolygon(tri, -0.5);
  ok('a triangle insets without flipping', !o.degenerate && area(o.poly) < area(tri),
    area(o.poly).toFixed(3)); }

console.log('\n--- the plane, both directions ---');
{ /* A 30 deg south-facing roof: height falls going south (-y). */
  const nodes = [{x:0,y:0,z:0},{x:10,y:0,z:0},{x:10,y:8,z:8*Math.tan(Math.PI/6)},{x:0,y:8,z:8*Math.tan(Math.PI/6)}];
  const p = fitPlane(nodes);
  near('pitch comes back as 30', p.pitch, 30, 1e-9);
  near('azimuth comes back as due south', p.azimuth, 180, 1e-9);
  ok('a true plane reports planar', p.planar && p.residual < 1e-9, p.residual);
  near('zAt reproduces a node', zAt(p, 10, 8), 8*Math.tan(Math.PI/6), 1e-9); }
{ const nodes = [{x:0,y:0,z:0},{x:10,y:0,z:10*Math.tan(Math.PI/9)},{x:10,y:8,z:10*Math.tan(Math.PI/9)},{x:0,y:8,z:0}];
  const p = fitPlane(nodes);
  near('an east-facing roof reads 20 deg', p.pitch, 20, 1e-9);
  near('and azimuth 270 (falls to the west)', p.azimuth, 270, 1e-9); }
{ const flat = [{x:0,y:0,z:3},{x:10,y:0,z:3},{x:10,y:8,z:3},{x:0,y:8,z:3}];
  const p = fitPlane(flat);
  near('a flat roof is 0 pitch', p.pitch, 0, 1e-9); }
{ const noisy = [{x:0,y:0,z:0},{x:10,y:0,z:0},{x:10,y:8,z:4},{x:0,y:8,z:4.3}];
  const p = fitPlane(noisy);
  ok('a non-planar roof is reported as such', !p.planar, p.residual.toFixed(4));
  ok('and still returns a best-fit pitch', p.pitch > 0 && p.pitch < 90, p.pitch.toFixed(2)); }
ok('fewer than three nodes gives no plane', fitPlane([{x:0,y:0,z:0},{x:1,y:1,z:1}]) === null);
ok('collinear nodes give no plane',
  fitPlane([{x:0,y:0,z:0},{x:1,y:0,z:1},{x:2,y:0,z:2}]) === null);

console.log('\n--- pitch drives the nodes, nodes drive the pitch ---');
{ const flat = sq.map((p) => ({ ...p, z: 0 }));
  const moved = heightsFromPitch(flat, 35, 180, { x: 0, y: 0, z: 2 });
  const back = fitPlane(moved);
  near('set 35 deg, read 35 deg back', back.pitch, 35, 1e-9);
  near('azimuth survives the round trip', back.azimuth, 180, 1e-9);
  near('the anchor keeps its height', moved[0].z, 2, 1e-9);
  ok('the north edge is higher than the south', moved[3].z > moved[0].z); }
{ const flat = sq.map((p) => ({ ...p, z: 0 }));
  for (const az of [0, 45, 90, 180, 270, 315]) {
    const m = heightsFromPitch(flat, 22, az, { x: 5, y: 4, z: 5 });
    const b = fitPlane(m);
    near(`azimuth ${az} survives`, b.azimuth, az, 1e-6);
    near(`pitch survives at azimuth ${az}`, b.pitch, 22, 1e-9);
  } }

console.log('\n--- surface coordinates ---');
{ const f = surfaceFrame(30, 180, { x: 0, y: 0 });
  const p = toPlan(f, 0, 10);
  near('10 m up a 30 deg slope covers 8.66 m of plan', Math.hypot(p.x, p.y), 10*Math.cos(Math.PI/6), 1e-9);
  const s = toSurface(f, p);
  near('round trip u', s.u, 0, 1e-9);
  near('round trip v', s.v, 10, 1e-9);
  const q = toPlan(f, 5, 0);
  near('along the eave there is no foreshortening', Math.hypot(q.x, q.y), 5, 1e-9); }
near('surface area of a 30 deg roof exceeds its plan', surfaceArea(sq, 30), 80/Math.cos(Math.PI/6), 1e-9);

console.log('\n--- auto-fill ---');
const MOD = { moduleW: 1.0, moduleL: 2.0 };
{ /* 10x8 plan, flat, no setback, 1x2 modules, no gaps: exactly 40. */
  const r = autoFill({ outline: sq, pitch: 0, azimuth: 180, ...MOD,
    gapU: 0, gapV: 0, setback: 0, ridgeSetback: 0, eaveSetback: 0, offsetU: 0, offsetV: 0 });
  ok('a clean 10x8 takes 40 of 1x2', r.modules.length === 40, r.modules.length);
  near('coverage is total', r.coverage, 1, 1e-6);
  ok('rows and columns are counted', r.rows === 4 && r.cols === 10, `${r.rows}x${r.cols}`); }
{ const r = autoFill({ outline: sq, pitch: 0, azimuth: 180, ...MOD,
    gapU: 0, gapV: 0, setback: 1, ridgeSetback: 1, eaveSetback: 1 });
  ok('a 1 m setback cuts it to 8x6 of usable area', Math.abs(r.usableArea - 48) < 1e-6, r.usableArea);
  /* 8 x 6 holds 24 of 1 x 2, but only at the right grid phase: the
     default origin is the centroid, which puts the rows half a module
     out and loses one. That is not a defect in the fill, it is why the
     origin is swept — and why the tool shows the swept answer. */
  ok('at the default phase it fits what that phase allows', r.modules.length === 16, r.modules.length);
  const b = bestFill({ outline: sq, pitch: 0, azimuth: 180, ...MOD,
    gapU: 0, gapV: 0, setback: 1, ridgeSetback: 1, eaveSetback: 1 }, 8);
  ok('sweeping the phase finds the full 24', b.range.max === 24, b.range.max); }
{ /* Foreshortening must reduce the count on a pitched roof for the same
     plan, because each module covers less plan but the plan is fixed. */
  const flat = autoFill({ outline: sq, pitch: 0, azimuth: 180, ...MOD, gapU: 0, gapV: 0, setback: 0, ridgeSetback: 0, eaveSetback: 0 });
  const steep = bestFill({ outline: sq, pitch: 45, azimuth: 180, ...MOD, gapU: 0, gapV: 0, setback: 0, ridgeSetback: 0, eaveSetback: 0 }, 6);
  ok('a pitched plan of the same size fits more modules', steep.range.max > flat.modules.length,
    `${steep.range.max} vs ${flat.modules.length}`);
  ok('because its true surface is larger',
    steep.best.result.surfaceArea > steep.best.result.planArea); }
{ const r = autoFill({ outline: sq, pitch: 0, azimuth: 180, ...MOD, gapU: 0, gapV: 0,
    setback: 0, ridgeSetback: 0, eaveSetback: 0,
    obstructions: [{ poly: rect(4, 3, 2, 2), buffer: 0.5 }] });
  ok('an obstruction removes modules', r.modules.length < 40, r.modules.length);
  ok('and none of the survivors touch its buffer',
    r.modules.every((m) => !polysOverlap(m.quad, r.keepOuts[0].poly))); }
{ const r = autoFill({ outline: sq, pitch: 0, azimuth: 180, ...MOD, setback: 6 });
  ok('a setback that eats the roof returns nothing and says so',
    r.modules.length === 0 && r.warnings.some((w) => /leaves nothing/.test(w))); }
{ const r = autoFill({ outline: sq, pitch: 0, azimuth: 180, moduleW: 20, moduleL: 20, setback: 0 });
  ok('a module too big to fit returns none with a reason',
    r.modules.length === 0 && r.warnings.some((w) => /No module fits/.test(w))); }
{ const flush = autoFill({ outline: sq, pitch: 0, azimuth: 180, ...MOD, gapU: 0, gapV: 0,
    setback: 0, ridgeSetback: 0, eaveSetback: 0, mounting: "flush" });
  const tilt = autoFill({ outline: sq, pitch: 0, azimuth: 180, ...MOD, gapU: 0, gapV: 0,
    setback: 0, ridgeSetback: 0, eaveSetback: 0, mounting: "tilted", moduleTilt: 20, shadeLimit: 18 });
  ok('tilting costs modules through row spacing', tilt.modules.length < flush.modules.length,
    `${tilt.modules.length} vs ${flush.modules.length}`);
  ok('and the self-shading pitch is reported', tilt.selfShade && tilt.selfShade.rowPitch > 2,
    tilt.selfShade?.rowPitch?.toFixed(2)); }
{ /* Every module must be inside the usable area and none may overlap. */
  const r = autoFill({ outline: sq, pitch: 25, azimuth: 150, ...MOD, setback: 0.5 });
  ok('every placed module is inside the usable area',
    r.modules.every((m) => polyInside(m.quad, r.usable)), r.modules.length);
  let clash = 0;
  for (let i = 0; i < r.modules.length; i++)
    for (let j = i + 1; j < r.modules.length; j++)
      if (polysCross(r.modules[i].quad, r.modules[j].quad)) clash++;
  ok('no two modules overlap', clash === 0, clash); }
{ const L = [{x:0,y:0},{x:12,y:0},{x:12,y:4},{x:5,y:4},{x:5,y:9},{x:0,y:9}];
  const r = autoFill({ outline: L, pitch: 0, azimuth: 180, ...MOD, setback: 0.3 });
  ok('an L-shaped roof fills and stays inside', r.modules.length > 0
    && r.modules.every((m) => polyInside(m.quad, r.usable)), r.modules.length); }

console.log('\n--- best fit sweep ---');
{ const b = bestFill({ outline: sq, pitch: 0, azimuth: 180, ...MOD, gapU: 0.02, gapV: 0.02,
    setback: 0.3, ridgeSetback: 0.3, eaveSetback: 0.3 }, 4);
  ok('the sweep tries both orientations and several offsets', b.tried === 32, b.tried);
  ok('the best is at least as good as the worst', b.range.max >= b.range.min,
    `${b.range.min}..${b.range.max}`);
  ok('nudging the origin changes the count', b.range.max > b.range.min,
    `${b.range.min}..${b.range.max}`); }

console.log('\n--- DXF ---');
{ const d = buildDxf([{ name: "TEST", colour: 1 }], [polyline3d("TEST", [{x:0,y:0,z:0},{x:1,y:0,z:1}])]);
  ok('starts with a SECTION', d.startsWith("0\nSECTION\n"));
  ok('ends with EOF', d.trimEnd().endsWith("EOF"));
  ok('declares R12', d.includes("AC1009"));
  ok('declares metres', d.includes("$INSUNITS"));
  ok('carries the layer', d.includes("0\nLAYER\n") && d.includes("2\nTEST\n"));
  const c = countEntities(d);
  ok('one polyline', c.POLYLINE === 1, c.POLYLINE);
  ok('two vertices', c.VERTEX === 2, c.VERTEX);
  ok('one seqend', c.SEQEND === 1, c.SEQEND);
  const lines = d.split("\n");
  ok('group codes and values alternate', lines.length % 2 === 1, lines.length); }
{ const r = autoFill({ outline: sq, pitch: 30, azimuth: 180, ...MOD, setback: 0.3 });
  const nodes = heightsFromPitch(sq.map((p) => ({ ...p, z: 0 })), 30, 180, { x: 0, y: 0, z: 3 });
  const plane = fitPlane(nodes);
  const dxf = roofToDxf({ planes: [{ name: "PLANE 1", outline: nodes, usable: r.usable,
    modules: r.modules, keepOuts: r.keepOuts, obstructions: [], plane,
    pitch: 30, azimuth: 180 }] });
  const c = countEntities(dxf);
  ok('a polyline per module plus outline and setback',
    c.POLYLINE === r.modules.length + 2, `${c.POLYLINE} vs ${r.modules.length + 2}`);
  ok('vertices are four per closed quad plus the outlines',
    c.VERTEX === r.modules.length * 4 + nodes.length + r.usable.length,
    c.VERTEX);
  ok('seqends match polylines', c.SEQEND === c.POLYLINE, `${c.SEQEND} vs ${c.POLYLINE}`);
  ok('node circles are written', c.CIRCLE === nodes.length, c.CIRCLE);
  ok('text is written', c.TEXT > 0, c.TEXT);
  ok('all the roof layers are declared', ROOF_LAYERS.every((l) => dxf.includes(`2\n${l.name}\n`)));
  /* The z of every module vertex must sit on the plane, or the drawing
     is a lie about a tilted roof. */
  const lines = dxf.split("\n");
  let worst = 0, checked = 0;
  for (let i = 0; i + 5 < lines.length; i += 2) {
    if (lines[i].trim() === "10" && lines[i+2]?.trim() === "20" && lines[i+4]?.trim() === "30") {
      const x = Number(lines[i+1]), y = Number(lines[i+3]), z = Number(lines[i+5]);
      if (!Number.isFinite(x+y+z) || (x === 0 && y === 0 && z === 0)) continue;
      worst = Math.max(worst, Math.abs(zAt(plane, x, y) - z)); checked++;
    }
  }
  ok('every exported point lies on the roof plane', worst < 1e-5, worst);
  ok('and plenty of points were checked', checked > r.modules.length * 4, checked); }
{ const dxf = roofToDxf({ planes: [] });
  ok('an empty drawing is still a valid file',
    dxf.includes("ENTITIES") && dxf.trimEnd().endsWith("EOF")); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
