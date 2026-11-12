/* Exclusion zones and the access road. */

import {
  ZONE_KINDS, makeZone, prepareZones, rectHitsZone, rectClear, segmentBlocked, inBlockingZone,
  nearestNode, shortestFrom, routeTree, tightCrossings,
} from "../src/siteConstraints.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log("  FAIL:", m); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
const near = (a, b, tol, m) => ok(Math.abs(a - b) <= tol, `${m} (got ${a}, want ${b} ±${tol})`);

const sq = (x, y, s) => [{ x, y }, { x: x + s, y }, { x: x + s, y: y + s }, { x, y: y + s }];

console.log("\n--- a zone as entered ---");
{
  const z = makeZone({ kind: "water", pts: sq(0, 0, 10) });
  eq(z.buffer, 0, "no buffer is given unless one is entered");
  eq(z.crossable, false, "a pond is not crossable by default");
  ok(makeZone({ kind: "easement", pts: sq(0, 0, 10) }).crossable, "an easement is, by default");
  eq(makeZone({ kind: "easement", crossable: false, pts: sq(0, 0, 10) }).crossable, false, "and the default can be overridden");
  eq(makeZone({ kind: "nonsense", pts: [] }).kind, "other", "an unknown kind becomes other");
  eq(makeZone({ buffer: -5, pts: [] }).buffer, 0, "a negative buffer is no buffer");
  eq(makeZone({ buffer: "12", pts: [] }).buffer, 12, "a buffer typed as text is read as a number");
  ok(Object.values(ZONE_KINDS).every((k) => !("buffer" in k)), "no kind carries a buffer of its own");
  eq(prepareZones([{ pts: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }]).length, 0, "two points are not a zone");
  eq(prepareZones([{ pts: sq(5, 5, 10) }])[0].box, { x0: 5, y0: 5, x1: 15, y1: 15 }, "the bounding box is worked out once");
}

console.log("\n--- does a frame overlap a zone ---");
{
  const [pond] = prepareZones([{ kind: "water", pts: sq(100, 100, 50) }]);
  ok(!rectHitsZone(0, 0, 10, 4, pond), "a frame well away is clear");
  ok(rectHitsZone(120, 120, 10, 4, pond), "a frame inside is not");
  ok(rectHitsZone(95, 120, 10, 4, pond), "a frame straddling the edge is not");
  ok(rectHitsZone(90, 90, 80, 80, pond), "a frame that swallows the whole zone is not");
  ok(!rectHitsZone(90, 120, 10, 4, pond), "a frame flush against the edge is clear: touching is not crossing");
  ok(rectHitsZone(100, 100, 50, 50, pond), "a frame exactly the shape of the zone overlaps it");

  const [buffered] = prepareZones([{ kind: "water", pts: sq(100, 100, 50), buffer: 15 }]);
  ok(!rectHitsZone(80, 120, 4.9, 4, buffered), "outside the buffer is clear");
  ok(rectHitsZone(82, 120, 4, 4, buffered), "inside the buffer is not");
  ok(rectHitsZone(100 - 15 - 3, 100 - 15 - 3, 4, 4, buffered),
     "at a corner the buffer reaches out square, which is the cautious side");

  /* A long thin easement, the case an offset polygon goes wrong on. */
  const [line] = prepareZones([{ kind: "easement", pts: [{ x: 0, y: 49 }, { x: 1000, y: 49 }, { x: 1000, y: 51 }, { x: 0, y: 51 }], buffer: 20 }]);
  ok(rectHitsZone(500, 27, 10, 4, line), "a frame eighteen metres from a two-metre easement is caught by a twenty-metre buffer");
  ok(!rectHitsZone(500, 25, 10, 4, line), "one exactly twenty metres away is clear: the buffer line is touched, not crossed");
  ok(!rectHitsZone(500, 20, 10, 4, line), "and one beyond it is clear");

  /* A concave zone: the notch is clear ground. */
  const [ell] = prepareZones([{ pts: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 30 }, { x: 30, y: 30 }, { x: 30, y: 100 }, { x: 0, y: 100 }] }]);
  ok(!rectHitsZone(50, 50, 20, 20, ell), "a frame in the notch of an L-shaped zone is clear");
  ok(rectHitsZone(10, 50, 10, 10, ell), "a frame in its arm is not");

  ok(rectClear(0, 0, 10, 4, []), "with no zones everything is clear");
  ok(!rectClear(120, 120, 10, 4, [line, pond]), "against several, any one is enough to block");
}

console.log("\n--- may a cable or road cross ---");
{
  const zs = prepareZones([
    { kind: "water", pts: sq(100, 0, 50), buffer: 30 },
    { kind: "easement", pts: [{ x: 300, y: -100 }, { x: 310, y: -100 }, { x: 310, y: 300 }, { x: 300, y: 300 }] },
  ]);
  ok(segmentBlocked({ x: 50, y: 25 }, { x: 200, y: 25 }, zs), "a route straight through the pond is blocked");
  ok(!segmentBlocked({ x: 50, y: -10 }, { x: 200, y: -10 }, zs), "one past it is not, buffer or no buffer");
  ok(!segmentBlocked({ x: 250, y: 25 }, { x: 400, y: 25 }, zs), "under the overhead line is allowed");
  ok(segmentBlocked({ x: 110, y: 10 }, { x: 140, y: 40 }, zs), "a route lying wholly inside the pond is blocked");
  ok(segmentBlocked({ x: 100, y: 0 }, { x: 150, y: 50 }, zs), "so is one from corner to corner across it");
  ok(!segmentBlocked({ x: 100, y: 0 }, { x: 150, y: 0 }, zs), "but one along its edge is not");
  ok(inBlockingZone({ x: 120, y: 20 }, zs), "a point in the pond is in a blocking zone");
  ok(!inBlockingZone({ x: 305, y: 20 }, zs), "a point under the line is not");
}

/* A grid graph, as buildCableGraph makes one: corridors at y = 0, 100,
   200 (ci) and block edges at x = 0, 50, 100, 150 (ui). Corridor edges
   join neighbours on one corridor; crossing edges join corridors. */
function grid(blocked = () => false) {
  const ys = [0, 100, 200], xs = [0, 50, 100, 150];
  const nodes = [], at = new Map();
  ys.forEach((y, ci) => xs.forEach((x, ui) => { at.set(`${ci}:${ui}`, nodes.length); nodes.push({ x, y, ci, ui, adj: [] }); }));
  const link = (a, b) => {
    if (a === undefined || b === undefined) return;
    const p = nodes[a], q = nodes[b];
    if (blocked(p, q)) return;
    const d = Math.hypot(q.x - p.x, q.y - p.y);
    p.adj.push([b, d]); q.adj.push([a, d]);
  };
  for (let ci = 0; ci < 3; ci++) for (let ui = 0; ui < 3; ui++) link(at.get(`${ci}:${ui}`), at.get(`${ci}:${ui + 1}`));
  for (let ui = 0; ui < 4; ui++) for (let ci = 0; ci < 2; ci++) link(at.get(`${ci}:${ui}`), at.get(`${ci + 1}:${ui}`));
  return { nodes, at };
}

console.log("\n--- shortest paths ---");
{
  const g = grid();
  eq(nearestNode(g, { x: 48, y: 97 }).i, g.at.get("1:1"), "the nearest node is the one closest to the point");
  ok(!isFinite(nearestNode(g, { x: NaN, y: 0 }).d), "a point with no coordinates has no nearest node");
  const { dist } = shortestFrom(g, g.at.get("0:0"));
  eq(dist[g.at.get("2:3")], 350, "corner to corner is 150 across and 200 up");
  const none = shortestFrom(g, -1);
  ok(![...none.dist].some(Number.isFinite), "from no node, nothing is reachable");
}

console.log("\n--- the access road ---");
{
  const g = grid();
  const gate = { x: -10, y: 0 };
  const r = routeTree(g, gate, [
    { key: "TS1", node: g.at.get("0:3") },
    { key: "TS2", node: g.at.get("2:3") },
  ]);
  eq(r.reached, ["TS1", "TS2"], "both stations are reached");
  near(r.stub, 10, 1e-9, "a ten-metre stub from the gate to the graph");
  near(r.paths[0].len, 160, 1e-9, "TS1 is 160 m from the gate");
  near(r.paths[1].len, 360, 1e-9, "TS2 is 360 m");
  /* Shared road is counted once. One shortest tree is along the bottom
     corridor to TS1 (150) and up to TS2 (200): 350 m plus the stub,
     where the two routes summed would be 160 + 360 = 520. */
  ok(r.length < r.paths[0].len + r.paths[1].len, "the shared stretch is not counted twice");
  near(r.length, 10 + r.alongCorridors + r.throughGaps, 1e-9, "the length is the stub plus every edge used once");
  ok(r.crossings >= 2, "reaching the far corridor crosses two block rows");
  near(r.throughGaps, 200, 1e-9, "two hundred metres of it through the gaps between blocks");
  eq(r.paths[0].pts[0], gate, "each route starts at the gate");

  /* A station behind a pond. */
  const cut = grid((p, q) => (p.ci !== q.ci && p.y < 150 && q.y >= 100 && Math.max(p.ci, q.ci) === 2));
  const r2 = routeTree(cut, gate, [{ key: "TS1", node: cut.at.get("0:3") }, { key: "TS2", node: cut.at.get("2:3") }]);
  eq(r2.reached, ["TS1"], "a station the gate cannot reach is not reached");
  eq(r2.unreachable, ["TS2"], "and is listed, not dropped");
  eq(routeTree(g, null, []), null, "no gate, no road");
  eq(routeTree({ nodes: [] }, gate, []), null, "no graph, no road");
  eq(routeTree(g, gate, [{ key: "x", node: -1 }]).unreachable, ["x"], "a target with no node is unreachable, not a crash");
}

console.log("\n--- which crossings squeeze between blocks ---");
{
  /* Lanes step across x (a tracker layout): corridors at y = 0 and 100,
     blocks 40 wide in the band between them, 3 m apart. */
  const blocks = [
    { x: 0, y: 5, w: 40, h: 90 }, { x: 43, y: 5, w: 40, h: 90 }, { x: 86, y: 5, w: 40, h: 90 },
  ];
  const edge = (x) => ({ crossing: true, a: { x, y: 0 }, b: { x, y: 100 }, len: 100 });
  const r = tightCrossings([edge(40), edge(43), edge(126), edge(0)], blocks, true, 3);
  eq(r.count, 2, "the two edges either side of a three-metre gap squeeze between blocks");
  eq(r.length, 180, "for ninety metres each, the depth of the blocks, not the hundred-metre edge");
  eq(tightCrossings([edge(126)], blocks, true, 3).count, 0, "the edge past the last block has open ground beyond it");
  eq(tightCrossings([edge(0)], blocks, true, 3).count, 0, "and so does the edge before the first");
  eq(tightCrossings([edge(40)], [blocks[0]], true, 3).count, 0, "with its neighbour cleared, a gap is open ground");
  eq(tightCrossings([{ ...edge(40), crossing: false }], blocks, true, 3).count, 0, "a corridor edge is not a crossing at all");
  /* The same arrangement turned through ninety degrees, as a fixed-tilt
     layout lays it out. */
  const turned = blocks.map((b) => ({ x: b.y, y: b.x, w: b.h, h: b.w }));
  const tedge = (y) => ({ crossing: true, a: { x: 0, y }, b: { x: 100, y }, len: 100 });
  eq(tightCrossings([tedge(40), tedge(126)], turned, false, 3).count, 1, "and the axes swap for a fixed-tilt layout");
  eq(tightCrossings([edge(40)], [], true, 3).count, 0, "with no blocks, nothing is tight");

  /* An edge spanning two rows: a gap beside the lower row, open ground
     beside the upper one. Only the lower row's stretch is squeezed. */
  const tworow = [{ x: 0, y: 5, w: 40, h: 45 }, { x: 43, y: 5, w: 40, h: 45 }, { x: 0, y: 55, w: 40, h: 45 }];
  const r2 = tightCrossings([edge(40)], tworow, true, 3);
  eq(r2.count, 1, "an edge with a gap beside one of its two rows still squeezes somewhere");
  near(r2.length, 45, 1e-9, "but only for the forty-five metres of the row that has a block on each side");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
