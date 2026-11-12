/* ---------------------------------------------------------------
   What the site will not let the layout do, and how traffic gets in.

   Two things live here, both in the layout's local metre grid.

   Exclusion zones. Ground inside the boundary that modules may not
   occupy: an overhead line's easement, a pond, a building, a hedgerow
   to keep, an ecology or heritage area. Each carries its own buffer,
   because the distance to keep from a pond and from a 132 kV line are
   set by different people for different reasons, and neither is this
   tool's to guess. A zone also says whether buried cable and a road
   may cross it: under an overhead line they usually may, with consent;
   through a pond they may not.

   The access road. The stations take a heavy delivery each and a
   visit every year after; the grid point takes its own. The road that
   has to be built is the tree of shortest routes from the site
   entrance to each of them, along the same corridor graph the cable is
   routed on. Every other corridor is spacing between rows, not built
   road, and the distinction is the civils quantity.

   The three graph helpers at the bottom were in App.jsx. They moved
   here so the road tree can be tested without a browser, and App.jsx
   imports them back.

   No React.
   --------------------------------------------------------------- */

import { pointInPolygon, segmentsProperlyCross, distanceToBoundary, area } from "./roofGeom.js";

/* The kinds are labels and a default for crossing. None carries a
   buffer: the network operator sets an easement, the environment
   agency a watercourse margin, the ecologist a hedgerow's, and a
   number written here would be quoted as though one of them had. */
export const ZONE_KINDS = {
  easement: { name: "Overhead line or easement", crossable: true,
    hint: "The network operator sets the width either side of the line. Buried cable and an access road may usually cross beneath it, with their consent; modules may not stand in it." },
  water: { name: "Watercourse or pond", crossable: false,
    hint: "The margin to keep is usually set by the drainage or environment authority." },
  building: { name: "Building or structure", crossable: false, hint: "" },
  trees: { name: "Woodland or hedgerow to keep", crossable: false,
    hint: "The root protection area is usually wider than the canopy." },
  protected: { name: "Ecology, heritage or archaeology", crossable: false, hint: "" },
  other: { name: "Other", crossable: false, hint: "" },
};

const fin = (v) => Number.isFinite(v);
const EPS = 1e-6;

/** Strictly inside: on the edge is not inside. Touching is not crossing
 *  here either — a frame laid flush against a buffer line is clear. */
const strictlyInside = (p, poly) => pointInPolygon(p, poly) && distanceToBoundary(p, poly) > EPS;

/** A zone as entered, made safe to test against. */
export function makeZone(z = {}) {
  const pts = (z.pts || []).filter((p) => fin(p?.x) && fin(p?.y));
  const kind = ZONE_KINDS[z.kind] ? z.kind : "other";
  const buffer = fin(+z.buffer) && +z.buffer > 0 ? +z.buffer : 0;
  return {
    id: z.id || `z${Math.random().toString(36).slice(2, 9)}`,
    name: z.name || ZONE_KINDS[kind].name,
    kind, buffer, pts,
    crossable: typeof z.crossable === "boolean" ? z.crossable : ZONE_KINDS[kind].crossable,
    /* Where it came from, when it was read from a map rather than drawn,
       so the same feature is not added twice. */
    ...(typeof z.osm === "string" ? { osm: z.osm } : {}),
  };
}

/** Bounding boxes, worked out once rather than per frame tested. */
export function prepareZones(zones) {
  return (zones || []).map(makeZone).filter((z) => z.pts.length >= 3).map((z) => {
    const xs = z.pts.map((p) => p.x), ys = z.pts.map((p) => p.y);
    return { ...z, box: { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) } };
  });
}

/**
 * Does a frame, grown by a zone's buffer, overlap the zone?
 *
 * The frame is grown rather than the zone shrunk outward, because
 * growing a rectangle is exact and offsetting an arbitrary polygon is
 * not — `offsetPolygon` goes degenerate on a deep offset, and a buffer
 * round a long thin easement is exactly that case. A square grow is a
 * little more cautious than a round one at the zone's corners, which
 * is the safe side.
 */
export function rectHitsZone(x, y, w, h, z) {
  const b = z.buffer || 0;
  const x0 = x - b, y0 = y - b, x1 = x + w + b, y1 = y + h + b;
  if (z.box && (x1 <= z.box.x0 || x0 >= z.box.x1 || y1 <= z.box.y0 || y0 >= z.box.y1)) return false;
  const poly = z.pts;
  const r = [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
  if (r.some((c) => strictlyInside(c, poly))) return true;
  if (poly.some((p) => p.x > x0 + EPS && p.x < x1 - EPS && p.y > y0 + EPS && p.y < y1 - EPS)) return true;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], c = poly[(i + 1) % poly.length];
    for (let k = 0; k < 4; k++) if (segmentsProperlyCross(a, c, r[k], r[(k + 1) % 4])) return true;
  }
  /* Neither shape's corners are strictly inside the other and no edges
     cross: they are apart, or they are the same rectangle. The centre
     settles which. */
  return strictlyInside({ x: (x0 + x1) / 2, y: (y0 + y1) / 2 }, poly);
}

/** Is a frame clear of every zone? `zones` should be prepared. */
export function rectClear(x, y, w, h, zones) {
  if (!zones || !zones.length) return true;
  for (const z of zones) if (rectHitsZone(x, y, w, h, z)) return false;
  return true;
}

/**
 * May a cable or a road run straight from p to q?
 *
 * Only zones marked as not crossable stop it, and the buffer does not
 * apply: the buffer keeps modules back from a pond, and a cable that
 * stays out of the pond itself is the question here.
 */
export function segmentBlocked(p, q, zones) {
  if (!zones || !zones.length) return false;
  const mid = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
  for (const z of zones) {
    if (z.crossable) continue;
    if (z.box && (Math.max(p.x, q.x) <= z.box.x0 || Math.min(p.x, q.x) >= z.box.x1
      || Math.max(p.y, q.y) <= z.box.y0 || Math.min(p.y, q.y) >= z.box.y1)) continue;
    if (strictlyInside(p, z.pts) || strictlyInside(q, z.pts) || strictlyInside(mid, z.pts)) return true;
    for (let i = 0; i < z.pts.length; i++) {
      if (segmentsProperlyCross(p, q, z.pts[i], z.pts[(i + 1) % z.pts.length])) return true;
    }
  }
  return false;
}

/** Whether a point sits inside a zone nothing may cross. */
export const inBlockingZone = (p, zones) =>
  (zones || []).some((z) => !z.crossable && strictlyInside(p, z.pts));

/** Area of each zone, and how much of it falls inside the boundary. */
export function zoneAreas(zones) {
  return (zones || []).map((z) => ({ id: z.id, m2: z.pts && z.pts.length >= 3 ? area(z.pts) : 0 }));
}

/* ---------------------------------------------------------------
   The route graph: nearest node, shortest paths, the tree of routes
   --------------------------------------------------------------- */

export function nearestNode(graph, p) {
  let best = -1, bd = Infinity;
  if (!p || !fin(p.x) || !fin(p.y)) return { i: -1, d: Infinity };
  for (let i = 0; i < graph.nodes.length; i++) {
    const n = graph.nodes[i];
    const d = Math.hypot(n.x - p.x, n.y - p.y);
    if (d < bd) { bd = d; best = i; }
  }
  return { i: best, d: bd };
}

/** Dijkstra from one source over the route graph. */
export function shortestFrom(graph, src) {
  const n = graph.nodes.length;
  const dist = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const seen = new Uint8Array(n);
  if (src < 0 || src >= n) return { dist, prev };
  dist[src] = 0;
  for (let it = 0; it < n; it++) {
    let u = -1, bd = Infinity;
    for (let i = 0; i < n; i++) if (!seen[i] && dist[i] < bd) { bd = dist[i]; u = i; }
    if (u < 0) break;
    seen[u] = 1;
    for (const [v, w] of graph.nodes[u].adj) {
      if (dist[u] + w < dist[v]) { dist[v] = dist[u] + w; prev[v] = u; }
    }
  }
  return { dist, prev };
}

export function pathPoints(graph, prev, from) {
  const pts = [];
  let c = from, guard = 0;
  while (c >= 0 && guard++ < 5000) { pts.push({ x: graph.nodes[c].x, y: graph.nodes[c].y }); c = prev[c]; }
  return pts;
}

/**
 * The tree of shortest routes from one point to several nodes.
 *
 * Shared stretches are counted once: two stations down the same
 * corridor need one road, not two. So the length is the union of the
 * edges used, plus the stub from the entrance to the graph — the same
 * rule as trench length against cable length.
 *
 * Each edge is classed by what it runs along. A corridor edge stays on
 * one corridor; a crossing edge goes from one corridor to the next
 * through the gap between two blocks, which was sized for cable and
 * maintenance access rather than a delivery lorry. Those crossings are
 * counted, because each is a place where the layout has to open a gap
 * up to road width for the route to be buildable.
 *
 * Targets the source cannot reach are listed, never dropped: a station
 * cut off behind a pond is a finding about the layout.
 */
export function routeTree(graph, from, targets) {
  if (!graph || !graph.nodes?.length || !from) return null;
  const entry = nearestNode(graph, from);
  if (entry.i < 0) return null;
  const { dist, prev } = shortestFrom(graph, entry.i);
  const edges = new Map();
  const paths = [];
  const reached = [], unreachable = [];
  for (const t of targets || []) {
    if (!(t.node >= 0) || !fin(dist[t.node])) { unreachable.push(t.key); continue; }
    reached.push(t.key);
    const pts = [];
    let c = t.node, guard = 0;
    while (c >= 0 && guard++ < 5000) {
      const n = graph.nodes[c];
      pts.push({ x: n.x, y: n.y });
      const p = prev[c];
      if (p >= 0) {
        const key = c < p ? `${c}-${p}` : `${p}-${c}`;
        if (!edges.has(key)) {
          const a = graph.nodes[p];
          edges.set(key, { a: { x: a.x, y: a.y }, b: { x: n.x, y: n.y },
            len: Math.hypot(n.x - a.x, n.y - a.y),
            crossing: fin(a.ci) && fin(n.ci) && a.ci !== n.ci });
        }
      }
      c = p;
    }
    pts.push({ x: from.x, y: from.y });
    paths.push({ key: t.key, pts: pts.reverse(), len: dist[t.node] + entry.d });
  }
  const list = [...edges.values()];
  const along = list.filter((e) => !e.crossing).reduce((s, e) => s + e.len, 0);
  const across = list.filter((e) => e.crossing).reduce((s, e) => s + e.len, 0);
  return {
    stub: entry.d, entryNode: entry.i,
    length: entry.d + along + across,
    alongCorridors: along, throughGaps: across,
    crossings: list.filter((e) => e.crossing).length,
    edges: list, paths, reached, unreachable,
  };
}

/**
 * Which road crossings actually squeeze between blocks.
 *
 * A crossing edge runs from one corridor to the next along the edge of
 * a block. Where there is a block on both sides of it, the road has to
 * fit in the gap between them, which was sized for cable and a walk
 * rather than a lorry. Where one side is open ground — beyond the end
 * of a row, or where an exclusion cleared the blocks — there is room
 * already, and calling that a gap to open up overstates the work.
 *
 * `vertical` is the layout's own flag: true when lanes step across x,
 * so corridors run along x and a crossing edge holds x fixed.
 */
export function tightCrossings(edges, blocks, vertical, gap) {
  const tol = Math.max(0, +gap || 0) + 0.5;
  /* Merge a set of intervals, then measure where two such sets overlap.
     A crossing edge often spans two rows, open ground beside one and a
     gap beside the other; only the stretch with a block on both sides is
     squeezed, and only that stretch is counted. */
  const merge = (iv) => {
    const out = [];
    for (const [a0, a1] of iv.sort((x, y) => x[0] - y[0])) {
      const last = out[out.length - 1];
      if (last && a0 <= last[1]) last[1] = Math.max(last[1], a1); else out.push([a0, a1]);
    }
    return out;
  };
  const overlap = (A, B) => {
    let total = 0, i = 0, j = 0;
    while (i < A.length && j < B.length) {
      const lo = Math.max(A[i][0], B[j][0]), hi = Math.min(A[i][1], B[j][1]);
      if (hi > lo) total += hi - lo;
      if (A[i][1] < B[j][1]) i++; else j++;
    }
    return total;
  };
  const tight = [];
  for (const e of edges || []) {
    if (!e.crossing) continue;
    const u = vertical ? e.a.x : e.a.y;
    const v0 = Math.min(vertical ? e.a.y : e.a.x, vertical ? e.b.y : e.b.x);
    const v1 = Math.max(vertical ? e.a.y : e.a.x, vertical ? e.b.y : e.b.x);
    const before = [], after = [];
    for (const b of blocks || []) {
      const bu0 = vertical ? b.x : b.y, bu1 = vertical ? b.x + b.w : b.y + b.h;
      const s0 = Math.max(v0, vertical ? b.y : b.x), s1 = Math.min(v1, vertical ? b.y + b.h : b.x + b.w);
      if (s1 <= s0 + 1e-6) continue;                              // not beside this stretch
      if (bu1 <= u + 1e-6 && u - bu1 <= tol) before.push([s0, s1]);
      if (bu0 >= u - 1e-6 && bu0 - u <= tol) after.push([s0, s1]);
    }
    const len = overlap(merge(before), merge(after));
    if (len > 1) tight.push({ ...e, tightLen: len });
  }
  return { count: tight.length, length: tight.reduce((a, e) => a + e.tightLen, 0), edges: tight };
}
