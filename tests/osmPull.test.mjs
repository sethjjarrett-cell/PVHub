/* What OpenStreetMap knows about the ground round the site. */

import {
  classify, kvOf, queryBox, overpassQuery, overpassLink, stitchRings, clipPolygon, clipLine,
  lineLength, stripAround, shareOf, readOverpass, byKind, nearestOnBoundary, compass, OSM_MARGIN, LINE_STRIP,
} from "../src/osmPull.js";
import { makeGeoRef, localToLonLat } from "../src/sitePull.js";
import { area, pointInPolygon } from "../src/roofGeom.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log("  FAIL:", m); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
const near = (a, b, tol, m) => ok(Math.abs(a - b) <= tol, `${m} (got ${a}, want ${b} ±${tol})`);

console.log("\n--- what the tags mean ---");
eq(classify({ power: "line", voltage: "132000" }).kind, "easement", "an overhead line is an easement");
eq(classify({ power: "line" }).shape, "line", "and a line, not an area");
eq(classify({ waterway: "stream" }).label, "Stream", "a stream is named as one");
eq(classify({ waterway: "riverbank" }).shape, "area", "a riverbank is an area");
eq(classify({ natural: "water", water: "pond" }).label, "Pond", "a pond");
eq(classify({ building: "yes" }).kind, "building", "any building tag is a building");
eq(classify({ barrier: "hedge" }).kind, "trees", "a hedge is kept with the trees");
eq(classify({ barrier: "hedge" }).shape, "line", "and is a line even when it closes round a field");
eq(classify({ leisure: "nature_reserve" }).kind, "protected", "a nature reserve is protected");
eq(classify({ highway: "track" }), null, "a farm track means nothing here");
eq(classify({ historic: "no" }), null, "and historic=no is not historic");
eq(kvOf("132000;33000"), 132, "the highest voltage on a shared line");
eq(kvOf("400"), 0.4, "LV in kilovolts");
eq(kvOf(""), null, "no tag, no voltage");

const geo = makeGeoRef({ lat: 52, lon: -1, x0: 0, y0: 0, source: "kml" });
const boundary = [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 300 }, { x: 0, y: 300 }];
const LL = (p) => { const [lon, lat] = localToLonLat(p, geo); return { lat, lon }; };

console.log("\n--- the question ---");
{
  const box = queryBox(boundary, geo);
  ok(box.n > box.s && box.e > box.w, "north above south and east of west");
  near(box.rect.x0, -OSM_MARGIN, 1e-9, "the box reaches the margin past the boundary");
  near(box.centre.lat, LL({ x: 200, y: 150 }).lat, 1e-9, "centred on the boundary's box");
  ok(box.n > 52 && box.s < 52 - 0.002, "local y runs south, so the boundary lies south of its origin");
  const q = overpassQuery(box);
  ok(/^\[out:json\]/.test(q), "asks for JSON");
  ok(q.includes(`(${Math.round(box.s * 1e6) / 1e6},`), "the box is south, west, north, east");
  ok(/power"="substation"\]\(around:20000,/.test(q), "and for substations within 20 km");
  ok(/out geom;/.test(q) && /out center tags;/.test(q), "geometry for features, centres for substations");
  ok(overpassLink(q).startsWith("https://overpass-api.de/api/interpreter?data=%5Bout%3Ajson"), "the link carries it encoded");
  eq(queryBox([], geo), null, "no boundary, no box");
  eq(queryBox(boundary, null), null, "no georeference, no box");
}

console.log("\n--- rings from a multipolygon ---");
{
  const A = { x: 0, y: 0 }, B = { x: 10, y: 0 }, Cc = { x: 10, y: 10 }, D = { x: 0, y: 10 };
  const { rings, open } = stitchRings([[A, B], [Cc, B], [Cc, D, A]]);
  eq(rings.length, 1, "three ways, one reversed, make one ring");
  near(area(rings[0]), 100, 1e-9, "of the right area");
  eq(open.length, 0, "with nothing left open");
  const o = stitchRings([[A, B], [Cc, D]]);
  eq(o.rings.length, 0, "ways that never close make no ring");
  eq(o.open.length, 2, "and are returned as open rather than closed by a guess");
}

console.log("\n--- clipping ---");
{
  const R = { x0: 0, y0: 0, x1: 10, y1: 10 };
  const sq = [{ x: 5, y: 5 }, { x: 15, y: 5 }, { x: 15, y: 15 }, { x: 5, y: 15 }];
  near(area(clipPolygon(sq, R)), 25, 1e-9, "a square overlapping the corner keeps its quarter");
  eq(clipPolygon([{ x: 20, y: 20 }, { x: 30, y: 20 }, { x: 30, y: 30 }], R).length, 0, "a shape outside is gone");
  const z = clipLine([{ x: -5, y: 5 }, { x: 5, y: 5 }, { x: 5, y: 20 }, { x: 8, y: 20 }, { x: 8, y: 5 }], R);
  eq(z.length, 2, "a line that leaves the box and comes back is two pieces");
  near(lineLength(z[0]) + lineLength(z[1]), 10 + 5, 1e-9, "the parts inside, and only those");
  near(lineLength([{ x: 0, y: 0 }, { x: 3, y: 4 }]), 5, 1e-12, "a 3-4-5 line is five long");
}

console.log("\n--- a line as a strip ---");
{
  const s = stripAround([{ x: 0, y: 0 }, { x: 100, y: 0 }], 1);
  near(area(s), 100, 1e-9, "a hundred-metre line a metre wide is a hundred square metres");
  ok(pointInPolygon({ x: 50, y: 0.4 }, s) && !pointInPolygon({ x: 50, y: 0.6 }, s), "half a metre either side");
  const L = stripAround([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }], 2);
  near(area(L), 400, 1e-6, "a right-angled bend keeps its width round the corner");
  const pin = stripAround([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 0.5 }], 1);
  ok(pin.every((p) => p.x < 102 && p.x > -2), "a hairpin's mitre is capped rather than thrown across the field");
  eq(stripAround([{ x: 0, y: 0 }], 1), [], "a single point is no strip");
}

console.log("\n--- how much of the site ---");
{
  near(shareOf(boundary, [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 300 }, { x: 0, y: 300 }]), 0.5, 1e-9,
       "the western half covers half the site");
  eq(shareOf(boundary, [{ x: 500, y: 0 }, { x: 600, y: 0 }, { x: 600, y: 100 }]), 0, "a shape outside covers none");
}

/* An answer as Overpass would give it. */
const way = (id, tags, pts) => ({ type: "way", id, tags, geometry: pts.map(LL) });
const answer = (elements) => JSON.stringify({ version: 0.6, generator: "Overpass API", osm3s: {}, elements });
const box = queryBox(boundary, geo);
const read = (els) => readOverpass(answer(els), { geo, box, boundary });

console.log("\n--- reading an answer ---");
{
  const r = read([
    way(1, { power: "line", voltage: "33000" }, [{ x: -500, y: 100 }, { x: 900, y: 100 }]),
    way(2, { natural: "water", water: "pond" }, [{ x: 50, y: 50 }, { x: 90, y: 50 }, { x: 90, y: 90 }, { x: 50, y: 90 }, { x: 50, y: 50 }]),
    way(3, { building: "barn" }, [{ x: 420, y: 10 }, { x: 440, y: 10 }, { x: 440, y: 30 }, { x: 420, y: 30 }, { x: 420, y: 10 }]),
    way(4, { highway: "track" }, [{ x: 0, y: 0 }, { x: 100, y: 0 }]),
    { type: "node", id: 9, lat: LL({ x: 3200, y: 150 }).lat, lon: LL({ x: 3200, y: 150 }).lon,
      tags: { power: "substation", name: "Ashby", voltage: "132000;33000", operator: "DNO" } },
    { type: "way", id: 10, center: LL({ x: 200, y: -8000 }), tags: { power: "substation", voltage: "11000" } },
  ]);
  ok(r.ok, "a good answer reads");
  const line = r.candidates.find((c) => c.osm === "way/1");
  eq(line.kind, "easement", "the line is an easement");
  eq(line.name, "Overhead line 33 kV", "named with its voltage");
  near(line.len, 400 + 2 * OSM_MARGIN, 1e-6, "clipped to the box, boundary plus margin each side");
  near(area(line.pts), line.len * LINE_STRIP, 1e-6, "and a metre wide");
  ok(line.inside, "it crosses the site");
  const pond = r.candidates.find((c) => c.osm === "way/2");
  near(pond.area, 1600, 1e-6, "the pond's area survives the round trip through degrees");
  eq(pond.pts.length, 4, "a closed way loses its repeated last point");
  near(pond.share, 1600 / 120000, 0.004, "and covers about 1.3% of the site");
  const barn = r.candidates.find((c) => c.osm === "way/3");
  ok(!barn.inside, "a barn beyond the fence is outside the site");
  near(barn.gap, 20, 1e-6, "twenty metres from it, which a buffer could still reach");
  eq(r.ignored, 1, "the farm track is counted as ignored, not silently");
  eq(r.substations.length, 2, "both substations");
  eq(r.substations[0].name, "Ashby", "nearest first");
  eq(r.substations[0].kv, 132, "with its highest voltage");
  near(r.substations[0].dist, 3000, 1e-3, "three kilometres from the middle of the site");
  eq(r.substations[1].name, null, "an unnamed one stays unnamed rather than being given a name");
  const g = byKind(r.candidates);
  eq(g.map((k) => k.kind).sort(), ["building", "easement", "water"], "grouped by kind");
  eq(g.find((k) => k.kind === "building").near, 1, "with what is inside and what is only near counted apart");
}

console.log("\n--- a multipolygon wood with a clearing ---");
{
  const ring = (pts) => pts.map(LL);
  const r = read([{ type: "relation", id: 77, tags: { natural: "wood", name: "Long Covert" }, members: [
    { type: "way", ref: 1, role: "outer", geometry: ring([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }]) },
    { type: "way", ref: 2, role: "outer", geometry: ring([{ x: 0, y: 0 }, { x: 0, y: 100 }, { x: 100, y: 100 }]) },
    { type: "way", ref: 3, role: "inner", geometry: ring([{ x: 40, y: 40 }, { x: 60, y: 40 }, { x: 60, y: 60 }, { x: 40, y: 40 }]) },
  ] }]);
  eq(r.candidates.length, 1, "two outer ways make one wood");
  near(r.candidates[0].area, 10000, 1e-3, "of a hectare");
  eq(r.candidates[0].name, "Long Covert · Woodland", "named as mapped, and what it is");
  ok(r.warnings.some((w) => /holes/.test(w)), "the clearing is not kept, and that is said");
}

console.log("\n--- answers that must be refused ---");
{
  eq(readOverpass("not json", { geo, box, boundary }).ok, false, "text that is not JSON");
  ok(/error page/.test(readOverpass("<?xml version='1.0'?><osm>", { geo, box, boundary }).msg), "an XML answer is named as one");
  eq(readOverpass(JSON.stringify({ a: 1 }), { geo, box, boundary }).ok, false, "JSON without elements");
  const far = read([way(5, { building: "yes" }, [{ x: 50000, y: 0 }, { x: 50020, y: 0 }, { x: 50020, y: 20 }, { x: 50000, y: 0 }])]);
  eq(far.ok, false, "an answer saved for somewhere else");
  ok(/somewhere else/.test(far.msg), "is refused as being about somewhere else");
  const farSubs = read([{ type: "node", id: 1, ...LL({ x: 90000, y: 0 }), tags: { power: "substation" } }]);
  eq(farSubs.ok, false, "even when all it holds is a substation 90 km away");
  const empty = read([]);
  ok(empty.ok && empty.candidates.length === 0, "an empty answer reads, as nothing mapped");
  const open = read([way(6, { natural: "water" }, [{ x: 10, y: 10 }, { x: 30, y: 10 }, { x: 30, y: 30 }])]);
  eq(open.candidates.length, 0, "a water area that does not close is left out");
  ok(open.warnings.some((w) => /not close/.test(w)), "and that is said");
}

console.log("\n--- towards a substation ---");
{
  const q = nearestOnBoundary({ x: 3200, y: 150 }, boundary);
  eq([q.x, q.y], [400, 150], "the grid point goes on the boundary nearest the substation");
  near(q.dist, 2800, 1e-9, "leaving 2.8 km off site");
  near(nearestOnBoundary({ x: 100, y: 100 }, boundary).dist, 100, 1e-9, "from inside, the nearest edge");
  eq(compass({ x: 0, y: 0 }, { x: 0, y: -10 }), "north", "negative y is north");
  eq(compass({ x: 0, y: 0 }, { x: 10, y: 10 }), "south-east", "and positive x and y south-east");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
