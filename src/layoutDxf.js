/* =====================================================================
   THE LAYOUT, OUT AS A DRAWING — AND WHAT IT SAYS ABOUT CABLE GROUPING

   Two jobs that happen to share the same geometry.

   The drawing is the easy one: boundary, blocks, frames, roads, the
   routed cable, the substations and the point of connection, each on
   its own layer, as a DXF. It is the general arrangement to take into
   AutoCAD and work on, not a construction issue.

   The second job is the one worth having. The cable tools ask "how many
   circuits are routed together", and until now that was a number the
   user typed from memory. The routed layout already knows: every LV run
   from an inverter back to its substation follows the corridor graph,
   many of them share the same stretch of trench, and the busiest
   stretch is what the grouping factor has to be looked up on. Counting
   the runs over each segment turns a guess into a measurement.

   The number that comes out is CIRCUITS ROUTED TOGETHER, in the sense
   IEC 60364-5-52 B.52.18/19 NOTE 3 means it — a circuit with m
   conductors per pole in parallel still counts as m circuits, and that
   multiplication belongs to the cable tool, not here. This module
   counts routes sharing a trench and nothing else.

   No React — testable from node.
   ===================================================================== */

import { buildDxf, polyline3d, line3d, text3d, circle3d, ACI } from "./dxf.js";

/* ---------------------------------------------------------------
   1.  TRENCH OCCUPANCY
   --------------------------------------------------------------- */

/* Segments are keyed on their rounded endpoints so that two runs down
   the same corridor land on the same key. A millimetre of floating
   point drift between two paths that are geometrically identical would
   otherwise read as two separate trenches carrying one circuit each,
   which is exactly the wrong answer. */
const keyOf = (a, b, q) => {
  const ax = Math.round(a.x / q), ay = Math.round(a.y / q);
  const bx = Math.round(b.x / q), by = Math.round(b.y / q);
  /* Order-independent: a trench does not care which way the cable runs. */
  return ax < bx || (ax === bx && ay <= by)
    ? `${ax},${ay}|${bx},${by}` : `${bx},${by}|${ax},${ay}`;
};

/**
 * How many routes share each stretch of trench.
 *
 * Returns the busiest count, which is the one the derating factor must
 * be looked up on, plus the whole distribution — because the maximum
 * decides the cable size and the distribution decides what it costs. A
 * site where one short segment carries forty circuits and everything
 * else carries four is a different problem from one where half the
 * route carries forty: the first is solved by splitting that segment,
 * the second is not.
 */
export function analyseTrenches(paths, { quantise = 0.05, minLength = 1e-6 } = {}) {
  const seg = new Map();
  let routes = 0;
  for (const path of paths || []) {
    if (!path || path.length < 2) continue;
    routes++;
    /* A route that doubles back over itself must not count twice on the
       same segment, so each route contributes to a key once. */
    const seen = new Set();
    for (let i = 0; i + 1 < path.length; i++) {
      const a = path[i], b = path[i + 1];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (!(len > minLength)) continue;
      const k = keyOf(a, b, quantise);
      if (seen.has(k)) continue;
      seen.add(k);
      const cur = seg.get(k);
      if (cur) cur.count++;
      else seg.set(k, { count: 1, length: len, a, b });
    }
  }
  const segments = [...seg.values()];
  if (!segments.length) {
    return { routes, segments: [], maxCircuits: 0, totalLength: 0,
      histogram: [], lengthAtMax: 0, weightedMean: 0, busiest: null };
  }
  const maxCircuits = Math.max(...segments.map((s) => s.count));
  const totalLength = segments.reduce((a, s) => a + s.length, 0);
  const byCount = new Map();
  for (const s of segments) {
    const e = byCount.get(s.count) || { circuits: s.count, length: 0, segments: 0 };
    e.length += s.length; e.segments++;
    byCount.set(s.count, e);
  }
  const histogram = [...byCount.values()].sort((a, b) => a.circuits - b.circuits);
  const lengthAtMax = byCount.get(maxCircuits)?.length ?? 0;
  /* Length-weighted mean occupancy: what a typical metre of trench
     carries, as against what the worst metre carries. */
  const weightedMean = totalLength > 0
    ? segments.reduce((a, s) => a + s.count * s.length, 0) / totalLength : 0;
  const busiest = segments.reduce((m, s) => (s.count > m.count ? s : m), segments[0]);
  return { routes, segments, maxCircuits, totalLength, histogram,
    lengthAtMax, weightedMean, busiest };
}

/**
 * The same question for the MV side, kept separate on purpose.
 *
 * LV and MV never share a grouping lookup — different standard,
 * different soil base, different table — so mixing their occupancy into
 * one figure would produce a number that belongs to neither.
 */
export const analyseMv = (mvPaths, opts) => analyseTrenches(mvPaths, opts);

/* ---------------------------------------------------------------
   2.  THE DRAWING
   --------------------------------------------------------------- */

export const LAYOUT_LAYERS = [
  { name: "PV-BOUNDARY", colour: ACI.white },
  { name: "PV-BLOCK", colour: ACI.green },
  { name: "PV-FRAME", colour: ACI.blue },
  { name: "PV-ROAD", colour: ACI.grey },
  { name: "PV-CABLE-LV", colour: ACI.cyan },
  { name: "PV-CABLE-MV", colour: ACI.magenta },
  { name: "PV-TRENCH-BUSY", colour: ACI.red },
  { name: "PV-SUBSTATION", colour: ACI.yellow },
  { name: "PV-INVERTER", colour: ACI.orange },
  { name: "PV-POI", colour: ACI.red },
  { name: "PV-TEXT", colour: ACI.yellow },
];

const asRect = (r) => [
  { x: r.x, y: r.y }, { x: r.x + r.w, y: r.y },
  { x: r.x + r.w, y: r.y + r.h }, { x: r.x, y: r.y + r.h },
];

/**
 * The general arrangement.
 *
 * Frames are optional and off by default: a 300 MW site is tens of
 * thousands of rectangles, which makes a file nobody can open and tells
 * the reader nothing the block outlines do not. The blocks, the roads
 * and the cable routes are the drawing; the modules are something to
 * array in afterwards, in the CAD package, where that is a one-line
 * operation.
 *
 * Everything is written flat at z = 0. A ground-mount site plan is a
 * plan — the frames have a tilt but it is a property of the mounting,
 * not of the arrangement, and carrying a fake z would imply a terrain
 * model that is not here.
 */
export function layoutToDxf({
  boundary = [], blocks = [], frames = [], roads = [],
  cabling = null, poi = null, trenches = null,
  includeFrames = false, includeTrenchLoad = true,
  textHeight = 2.5, title = null,
}) {
  const ents = [];

  if (boundary.length >= 3) ents.push(polyline3d("PV-BOUNDARY", boundary));

  for (const r of roads) {
    if (r.points?.length >= 2) ents.push(polyline3d("PV-ROAD", r.points, !!r.closed));
    else if (r.x !== undefined) ents.push(polyline3d("PV-ROAD", asRect(r)));
  }

  for (const b of blocks) {
    const pts = b.outline?.length >= 3 ? b.outline : asRect(b);
    ents.push(polyline3d("PV-BLOCK", pts));
    if (b.inv !== undefined) {
      ents.push(text3d("PV-TEXT", { x: b.x + 0.5, y: b.y + 0.5, z: 0 },
        textHeight, `INV ${b.inv}`));
    }
  }

  if (includeFrames) {
    for (const f of frames) ents.push(polyline3d("PV-FRAME", asRect(f)));
  }

  if (cabling) {
    for (const p of cabling.paths || []) {
      if (p.length >= 2) ents.push(polyline3d("PV-CABLE-LV", p, false));
    }
    for (const p of cabling.mvPaths || []) {
      if (p.length >= 2) ents.push(polyline3d("PV-CABLE-MV", p, false));
    }
    for (const s of cabling.subs || []) {
      ents.push(circle3d("PV-SUBSTATION", { x: s.x, y: s.y, z: 0 }, textHeight * 1.6));
      ents.push(text3d("PV-TEXT", { x: s.x + textHeight * 2, y: s.y, z: 0 },
        textHeight, `SUB ${s.ways}W / ${s.used} USED`));
    }
    for (const m of cabling.markers || []) {
      ents.push(circle3d("PV-INVERTER", { x: m.x, y: m.y, z: 0 }, textHeight * 0.7));
    }
  }

  /* The busiest trenches drawn on their own layer, because the drawing
     is where a grouping problem is actually legible — a red line down
     the middle of the site says more than a factor in a table. */
  if (includeTrenchLoad && trenches?.segments?.length) {
    const hot = trenches.maxCircuits;
    for (const s of trenches.segments) {
      if (s.count < hot) continue;
      ents.push(line3d("PV-TRENCH-BUSY", { ...s.a, z: 0 }, { ...s.b, z: 0 }));
    }
    if (trenches.busiest) {
      const mid = { x: (trenches.busiest.a.x + trenches.busiest.b.x) / 2,
        y: (trenches.busiest.a.y + trenches.busiest.b.y) / 2, z: 0 };
      ents.push(text3d("PV-TEXT", mid, textHeight, `${hot} CIRCUITS`));
    }
  }

  if (poi) {
    ents.push(circle3d("PV-POI", { x: poi.x, y: poi.y, z: 0 }, textHeight * 2));
    ents.push(text3d("PV-TEXT", { x: poi.x + textHeight * 2.5, y: poi.y, z: 0 }, textHeight, "POI"));
  }

  if (title) {
    const ys = boundary.length ? Math.max(...boundary.map((p) => p.y)) : 0;
    const xs = boundary.length ? Math.min(...boundary.map((p) => p.x)) : 0;
    ents.push(text3d("PV-TEXT", { x: xs, y: ys + textHeight * 3, z: 0 }, textHeight * 1.4, title));
  }

  return buildDxf(LAYOUT_LAYERS, ents);
}
