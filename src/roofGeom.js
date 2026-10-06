/* =====================================================================
   ROOF GEOMETRY

   A roof plane is a polygon that is not flat. Everything here follows
   from that one fact, and most of the care in this file is about not
   quietly treating the plan view as if it were the real thing.

   Two coordinate systems, and the conversion between them is where the
   mistakes live:

     PLAN     what you draw and what a site survey gives you. x east,
              y north, metres. A 4 m module lying up a 35° roof covers
              3.28 m of plan, not 4 m.

     SURFACE  the roof's own 2D system, (u, v), both in TRUE length.
              u runs along the eave, v runs up the slope. Modules are
              laid out here, because a module does not foreshorten —
              the roof does.

   The coupling the designer needs runs both ways. Give it a pitch and
   it moves the node heights; move a node height and it refits the
   pitch. Neither is the master.

   No React, no dependencies — testable from node.
   ===================================================================== */

const TAU = Math.PI * 2;
const d2r = (d) => (d * Math.PI) / 180;
const r2d = (r) => (r * 180) / Math.PI;

/* ---------------------------------------------------------------
   1.  POLYGON BASICS
   --------------------------------------------------------------- */

/** Signed area. Positive is anticlockwise in a y-up system. */
export function signedArea(poly) {
  let a = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const p = poly[i], q = poly[(i + 1) % n];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

export const area = (poly) => Math.abs(signedArea(poly));

/** Anticlockwise winding, so inward normals are consistent downstream. */
export function normalise(poly) {
  return signedArea(poly) < 0 ? [...poly].reverse() : [...poly];
}

export function centroid(poly) {
  const a = signedArea(poly);
  if (Math.abs(a) < 1e-12) {
    const n = poly.length || 1;
    return { x: poly.reduce((s, p) => s + p.x, 0) / n, y: poly.reduce((s, p) => s + p.y, 0) / n };
  }
  let cx = 0, cy = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const p = poly[i], q = poly[(i + 1) % n];
    const f = p.x * q.y - q.x * p.y;
    cx += (p.x + q.x) * f; cy += (p.y + q.y) * f;
  }
  return { x: cx / (6 * a), y: cy / (6 * a) };
}

export function bbox(poly) {
  const xs = poly.map((p) => p.x), ys = poly.map((p) => p.y);
  return { minX: Math.min(...xs), maxX: Math.max(...xs),
    minY: Math.min(...ys), maxY: Math.max(...ys) };
}

/** Crossing-number test. Points exactly on an edge count as inside. */
export function pointInPolygon(pt, poly, eps = 1e-9) {
  let inside = false;
  for (let i = 0, n = poly.length, j = n - 1; i < n; j = i++) {
    const a = poly[j], b = poly[i];
    /* On the edge: treat as inside rather than letting floating point
       decide, because a module corner landing exactly on a setback line
       should not flicker in and out. */
    const cross = (b.x - a.x) * (pt.y - a.y) - (b.y - a.y) * (pt.x - a.x);
    const within = Math.min(a.x, b.x) - eps <= pt.x && pt.x <= Math.max(a.x, b.x) + eps
      && Math.min(a.y, b.y) - eps <= pt.y && pt.y <= Math.max(a.y, b.y) + eps;
    if (Math.abs(cross) < eps && within) return true;
    if ((a.y > pt.y) !== (b.y > pt.y)) {
      const x = a.x + ((pt.y - a.y) / (b.y - a.y)) * (b.x - a.x);
      if (pt.x < x) inside = !inside;
    }
  }
  return inside;
}

const onSeg = (p, q, r) =>
  q.x <= Math.max(p.x, r.x) + 1e-12 && q.x >= Math.min(p.x, r.x) - 1e-12
  && q.y <= Math.max(p.y, r.y) + 1e-12 && q.y >= Math.min(p.y, r.y) - 1e-12;
const orient = (p, q, r) => {
  const v = (q.y - p.y) * (r.x - q.x) - (q.x - p.x) * (r.y - q.y);
  return Math.abs(v) < 1e-12 ? 0 : (v > 0 ? 1 : 2);
};

/**
 * A PROPER crossing: the segments pass through each other. Touching at
 * a point and lying along each other do not count.
 *
 * This is the one containment wants. A module laid flush against the
 * setback line shares an edge with it, and treating that as a collision
 * rejects every module on the perimeter — which silently costs the
 * outer ring of a roof and looks like a module that simply would not
 * fit.
 */
export function segmentsProperlyCross(p1, q1, p2, q2) {
  const o1 = orient(p1, q1, p2), o2 = orient(p1, q1, q2);
  const o3 = orient(p2, q2, p1), o4 = orient(p2, q2, q1);
  return o1 !== o2 && o3 !== o4 && o1 !== 0 && o2 !== 0 && o3 !== 0 && o4 !== 0;
}

/** Do two closed segments cross? Collinear overlap and touching count. */
export function segmentsCross(p1, q1, p2, q2) {
  const o1 = orient(p1, q1, p2), o2 = orient(p1, q1, q2);
  const o3 = orient(p2, q2, p1), o4 = orient(p2, q2, q1);
  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && onSeg(p1, p2, q1)) return true;
  if (o2 === 0 && onSeg(p1, q2, q1)) return true;
  if (o3 === 0 && onSeg(p2, p1, q2)) return true;
  if (o4 === 0 && onSeg(p2, q1, q2)) return true;
  return false;
}

/** Does any edge of A properly cross any edge of B? Touching does not. */
export function polysCross(a, b) {
  for (let i = 0; i < a.length; i++) {
    const p1 = a[i], q1 = a[(i + 1) % a.length];
    for (let j = 0; j < b.length; j++) {
      if (segmentsProperlyCross(p1, q1, b[j], b[(j + 1) % b.length])) return true;
    }
  }
  return false;
}

/** A fully inside B: every vertex in, and no edges crossing. */
export function polyInside(a, b) {
  for (const p of a) if (!pointInPolygon(p, b)) return false;
  return !polysCross(a, b);
}

/** A and B overlap at all: cross, or either contains the other. */
export function polysOverlap(a, b) {
  if (polysCross(a, b)) return true;
  /* Centroids rather than vertices, because two shapes sharing an edge
     have vertices on each other's boundary, which pointInPolygon counts
     as inside. A module resting exactly against a keep-out line is not
     inside it. */
  if (pointInPolygon(centroid(a), b)) return true;
  if (pointInPolygon(centroid(b), a)) return true;
  return false;
}

/** Shortest distance from a point to a segment. */
function distToSegment(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const L2 = dx * dx + dy * dy;
  if (L2 < 1e-18) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Shortest distance from a point to a polygon's boundary. */
export function distanceToBoundary(p, poly) {
  let best = Infinity;
  for (let i = 0, n = poly.length; i < n; i++) {
    best = Math.min(best, distToSegment(p, poly[i], poly[(i + 1) % n]));
  }
  return best;
}

/**
 * Offset a polygon by d — inward for negative, outward for positive.
 *
 * Mitred: each edge is pushed along its own normal and consecutive
 * offset lines are intersected. Exact for a convex outline, which most
 * roof planes are, and good for a simple concave one. It does NOT
 * handle the case where an inset is deep enough to collapse part of the
 * shape or split it in two; that needs a full straight-skeleton offset,
 * and the caller is told when the result looks degenerate rather than
 * being handed a self-intersecting polygon as if it were fine.
 */
export function offsetPolygon(poly, d) {
  const p = normalise(poly);
  const n = p.length;
  if (n < 3 || Math.abs(d) < 1e-12) return { poly: p, degenerate: false };
  const lines = [];
  for (let i = 0; i < n; i++) {
    const a = p[i], b = p[(i + 1) % n];
    const ex = b.x - a.x, ey = b.y - a.y;
    const len = Math.hypot(ex, ey);
    if (len < 1e-12) continue;
    /* Anticlockwise winding puts the interior on the left of each
       edge, so the inward normal is (-ey, ex)/len. */
    const nx = -ey / len, ny = ex / len;
    /* n points inward, and the sign convention here is negative-inward,
       so the displacement is -n·d: d = -0.3 moves the edge 0.3 m into
       the shape, d = +0.3 moves it out. */
    lines.push({ ax: a.x - nx * d, ay: a.y - ny * d, dx: ex / len, dy: ey / len });
  }
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const L1 = lines[i], L2 = lines[(i + 1) % lines.length];
    const den = L1.dx * L2.dy - L1.dy * L2.dx;
    if (Math.abs(den) < 1e-9) {
      /* Parallel edges: no corner to cut, take the shared endpoint. */
      out.push({ x: L2.ax, y: L2.ay });
      continue;
    }
    const t = ((L2.ax - L1.ax) * L2.dy - (L2.ay - L1.ay) * L2.dx) / den;
    out.push({ x: L1.ax + L1.dx * t, y: L1.ay + L1.dy * t });
  }
  /* An inset deep enough to eat the shape produces a mitre that turns
     itself inside out. Checking the winding catches a single inversion
     but not a double one — inset a 10 x 8 by 6 and the corners cross
     twice, giving a small polygon with correct winding and a perfectly
     plausible area that is nowhere near 6 m from the original edges.
     So the test is the one that actually defines an offset: every point
     of the result must be at least |d| from the original boundary. */
  const before = area(p), after = out.length >= 3 ? area(out) : 0;
  const flipped = out.length >= 3 && Math.sign(signedArea(out)) !== Math.sign(signedArea(p));
  let tooClose = false;
  if (out.length >= 3) {
    const tol = Math.abs(d) * 1e-6 + 1e-9;
    for (const q of out) {
      if (distanceToBoundary(q, p) < Math.abs(d) - tol) { tooClose = true; break; }
    }
  }
  const degenerate = out.length < 3 || after < 1e-6 || flipped || tooClose
    || (d < 0 && after > before);
  return { poly: out, degenerate };
}

/** A rectangle as a polygon, for obstructions and modules. */
export const rect = (x, y, w, h) => [
  { x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h },
];

/* ---------------------------------------------------------------
   2.  THE PLANE — pitch, azimuth and node heights, coupled
   --------------------------------------------------------------- */

/**
 * Fit z = ax + by + c through the nodes, least squares.
 *
 * Three nodes define a plane exactly; more than three generally do not
 * lie on one, and a real roof surveyed to the nearest centimetre never
 * does. Rather than refuse, it fits the best plane and reports the
 * worst residual, so the designer can see whether the roof is actually
 * planar or whether they have caught a hip, a valley or a typo.
 */
export function fitPlane(nodes) {
  const pts = nodes.filter((p) => Number.isFinite(p.z));
  if (pts.length < 3) return null;
  let Sxx = 0, Sxy = 0, Syy = 0, Sx = 0, Sy = 0, Sz = 0, Sxz = 0, Syz = 0;
  const n = pts.length;
  for (const p of pts) {
    Sxx += p.x * p.x; Sxy += p.x * p.y; Syy += p.y * p.y;
    Sx += p.x; Sy += p.y; Sz += p.z;
    Sxz += p.x * p.z; Syz += p.y * p.z;
  }
  const M = [[Sxx, Sxy, Sx], [Sxy, Syy, Sy], [Sx, Sy, n]];
  const V = [Sxz, Syz, Sz];
  const det = M[0][0] * (M[1][1] * M[2][2] - M[1][2] * M[2][1])
    - M[0][1] * (M[1][0] * M[2][2] - M[1][2] * M[2][0])
    + M[0][2] * (M[1][0] * M[2][1] - M[1][1] * M[2][0]);
  if (Math.abs(det) < 1e-12) return null;      // all nodes collinear in plan
  const solve = (col) => {
    const A = M.map((r, i) => r.map((v, j) => (j === col ? V[i] : v)));
    return (A[0][0] * (A[1][1] * A[2][2] - A[1][2] * A[2][1])
      - A[0][1] * (A[1][0] * A[2][2] - A[1][2] * A[2][0])
      + A[0][2] * (A[1][0] * A[2][1] - A[1][1] * A[2][0])) / det;
  };
  const a = solve(0), b = solve(1), c = solve(2);
  let worst = 0;
  for (const p of pts) worst = Math.max(worst, Math.abs(a * p.x + b * p.y + c - p.z));
  const slope = Math.hypot(a, b);
  const pitch = r2d(Math.atan(slope));
  /* The gradient (a, b) points uphill, so downslope is its negation.
     Azimuth is measured from north (+y) clockwise through east (+x),
     which puts due south at 180° as the rest of the tool expects. */
  let azimuth = slope < 1e-9 ? 180 : r2d(Math.atan2(-a, -b));
  azimuth = ((azimuth % 360) + 360) % 360;
  return { a, b, c, pitch, azimuth, residual: worst, planar: worst < 0.01 };
}

/**
 * The other direction: impose a pitch and azimuth, and move the nodes.
 *
 * One node (or the centroid) is held as the anchor, because a plane
 * needs a height as well as an angle — otherwise the roof is the right
 * shape at the wrong altitude.
 */
export function heightsFromPitch(nodes, pitch, azimuth, anchor = null) {
  const m = Math.tan(d2r(pitch));
  /* Downslope unit vector in plan, from the azimuth convention above. */
  const dx = Math.sin(d2r(azimuth)), dy = Math.cos(d2r(azimuth));
  const base = anchor || { ...centroid(nodes), z: nodes.find((p) => Number.isFinite(p.z))?.z ?? 0 };
  const z0 = Number.isFinite(base.z) ? base.z : 0;
  return nodes.map((p) => ({
    ...p,
    z: z0 - m * ((p.x - base.x) * dx + (p.y - base.y) * dy),
  }));
}

/** Height of the plane at any plan point. */
export const zAt = (plane, x, y) => plane.a * x + plane.b * y + plane.c;

/* ---------------------------------------------------------------
   3.  SURFACE COORDINATES
   --------------------------------------------------------------- */

/**
 * The frame a module grid is laid out in.
 *
 *   e  along the eave, horizontal, no foreshortening
 *   d  downslope in plan; a true length v up the slope covers
 *      v·cos(pitch) of plan, which is the whole reason this exists
 */
export function surfaceFrame(pitch, azimuth, origin) {
  const dx = Math.sin(d2r(azimuth)), dy = Math.cos(d2r(azimuth));
  return {
    origin, pitch, azimuth,
    ex: dy, ey: -dx,            // along the eave, perpendicular to downslope
    dx, dy,                     // downslope in plan
    cos: Math.cos(d2r(pitch)),  // plan foreshortening up the slope
  };
}

/** Surface (u along eave, v up the slope, both true) to plan. */
export function toPlan(f, u, v) {
  return {
    x: f.origin.x + u * f.ex - v * f.cos * f.dx,
    y: f.origin.y + u * f.ey - v * f.cos * f.dy,
  };
}

/** Plan back to surface, for working out where a drawn point sits. */
export function toSurface(f, p) {
  const rx = p.x - f.origin.x, ry = p.y - f.origin.y;
  const u = rx * f.ex + ry * f.ey;
  const vPlan = -(rx * f.dx + ry * f.dy);
  return { u, v: f.cos > 1e-9 ? vPlan / f.cos : vPlan };
}

/** True surface area of a plan polygon lying on the plane. */
export const surfaceArea = (poly, pitch) => area(poly) / Math.cos(d2r(pitch));

/* ---------------------------------------------------------------
   4.  AUTO-FILL  —  put modules on the roof
   --------------------------------------------------------------- */

/**
 * Fill a roof plane with modules.
 *
 * The sequence is the one any roof-mount layout tool follows, and each
 * step is a real constraint rather than a preference:
 *
 *   1  inset the outline by the edge setback — fire access, wind zone
 *      at the perimeter, and somewhere for the installer to stand
 *   2  take the ridge and eave setbacks separately, because they are
 *      usually different numbers: the ridge wants clearance for a
 *      flashing or a tile vent, the eave wants the gutter kept clear
 *   3  buffer every obstruction by its own keep-out and remove it
 *   4  lay a grid in SURFACE coordinates, so module dimensions are
 *      true, and project each module to plan
 *   5  keep a module only if it is wholly inside the usable area and
 *      clear of every obstruction. Partly-on is not on.
 *
 * Row pitch is the module's own length for a flush array, because one
 * plane cannot shade itself, and the self-shading pitch for a tilted
 * one. That single difference is most of why a flush roof fits so many
 * more modules than a tilted one.
 */
export function autoFill({
  outline, obstructions = [], nodes = null,
  pitch = 30, azimuth = 180,
  moduleW = 1.134, moduleL = 2.278, orientation = "portrait",
  gapU = 0.02, gapV = 0.02,
  setback = 0.3, ridgeSetback = 0.3, eaveSetback = 0.3,
  obstructionBuffer = 0.5,
  mounting = "flush", moduleTilt = 15, shadeLimit = 18,
  offsetU = 0, offsetV = 0,
  maxModules = 4000,
}) {
  const warnings = [];
  const poly = normalise(outline);
  if (poly.length < 3) return { modules: [], usable: [], warnings: ["the outline needs at least three nodes"] };

  /* 1 — the perimeter setback. */
  const inset = offsetPolygon(poly, -Math.abs(setback));
  if (inset.degenerate) {
    return { modules: [], usable: [], warnings: [
      `A ${setback} m setback leaves nothing of this plane. Reduce it, or the roof is too small to use.`] };
  }
  let usable = inset.poly;

  /* 2 — ridge and eave get their own setbacks, applied along the slope
     direction only. A roof's top and bottom edges are different things
     from its sides and are rarely given the same clearance. */
  const extraRidge = Math.abs(ridgeSetback) - Math.abs(setback);
  const extraEave = Math.abs(eaveSetback) - Math.abs(setback);
  if (Math.abs(extraRidge) > 1e-9 || Math.abs(extraEave) > 1e-9) {
    const f0 = surfaceFrame(pitch, azimuth, centroid(usable));
    const vs = usable.map((p) => toSurface(f0, p).v);
    const vMax = Math.max(...vs), vMin = Math.min(...vs);
    usable = usable.map((p) => {
      const s = toSurface(f0, p);
      let v = s.v;
      if (Math.abs(s.v - vMax) < 1e-6) v -= Math.max(0, extraRidge);
      if (Math.abs(s.v - vMin) < 1e-6) v += Math.max(0, extraEave);
      return toPlan(f0, s.u, v);
    });
    if (area(usable) < 1e-6) {
      return { modules: [], usable: [], warnings: ["the ridge and eave setbacks meet — nothing is left"] };
    }
  }

  /* 3 — obstruction keep-outs. */
  const keepOuts = [];
  for (const ob of obstructions) {
    const g = ob.poly && ob.poly.length >= 3 ? ob.poly : null;
    if (!g) continue;
    const buf = ob.buffer ?? obstructionBuffer;
    const grown = Math.abs(buf) > 1e-9 ? offsetPolygon(g, Math.abs(buf)) : { poly: normalise(g), degenerate: false };
    keepOuts.push({ ...ob, poly: grown.poly });
  }

  /* 4 — the grid, in surface coordinates. */
  const mw = orientation === "portrait" ? moduleW : moduleL;   // along the eave
  const ml = orientation === "portrait" ? moduleL : moduleW;   // up the slope
  if (!(mw > 0) || !(ml > 0)) return { modules: [], usable, warnings: ["module dimensions are zero"] };

  let rowPitch, selfShade = null;
  if (mounting === "tilted") {
    const beta = d2r(moduleTilt);
    const alpha = d2r(Math.max(1, shadeLimit));
    const footprint = ml * Math.cos(beta);
    const height = ml * Math.sin(beta);
    rowPitch = footprint + height / Math.tan(alpha);
    selfShade = { footprint, height, rowPitch, gcr: rowPitch > 0 ? ml / rowPitch : 0 };
  } else {
    rowPitch = ml + gapV;
  }

  const bb = bbox(usable);
  const diag = Math.hypot(bb.maxX - bb.minX, bb.maxY - bb.minY);
  const f = surfaceFrame(pitch, azimuth, centroid(usable));
  const span = Math.ceil((diag / Math.cos(d2r(pitch)) + Math.max(mw, ml) * 2) / Math.min(mw + gapU, rowPitch)) + 2;

  const modules = [];
  const colStep = mw + gapU;
  let truncated = false;
  for (let j = -span; j <= span && !truncated; j++) {
    const v0 = j * rowPitch + offsetV;
    for (let i = -span; i <= span; i++) {
      const u0 = i * colStep + offsetU;
      /* The module's four corners in surface coordinates, projected. */
      const quad = [
        toPlan(f, u0, v0), toPlan(f, u0 + mw, v0),
        toPlan(f, u0 + mw, v0 + ml), toPlan(f, u0, v0 + ml),
      ];
      if (!polyInside(quad, usable)) continue;
      let blocked = false;
      for (const k of keepOuts) if (polysOverlap(quad, k.poly)) { blocked = true; break; }
      if (blocked) continue;
      modules.push({ quad, u: u0, v: v0, row: j, col: i,
        centre: { x: (quad[0].x + quad[2].x) / 2, y: (quad[0].y + quad[2].y) / 2 } });
      if (modules.length >= maxModules) { truncated = true; break; }
    }
  }
  if (truncated) warnings.push(
    `Stopped at ${maxModules} modules. Either the plane is enormous or the module dimensions are wrong.`);

  /* Renumber rows and columns from the bottom-left of what survived, so
     the numbering means something on a drawing. */
  if (modules.length) {
    const minRow = Math.min(...modules.map((m) => m.row));
    const minCol = Math.min(...modules.map((m) => m.col));
    for (const m of modules) { m.row -= minRow - 1; m.col -= minCol - 1; }
  }

  const rows = new Set(modules.map((m) => m.row)).size;
  const cols = new Set(modules.map((m) => m.col)).size;
  if (!modules.length) warnings.push(
    "No module fits. Try landscape, a smaller setback, or check the plane is big enough for one module.");

  return {
    modules, usable, keepOuts, frame: f, rowPitch, selfShade,
    rows, cols, moduleW: mw, moduleL: ml,
    planArea: area(poly), usableArea: area(usable),
    surfaceArea: surfaceArea(poly, pitch),
    coverage: area(poly) > 0 ? (modules.length * mw * ml * Math.cos(d2r(pitch))) / area(poly) : 0,
    warnings,
  };
}

/**
 * Try the obvious variations and report which fits most.
 *
 * Nudging the grid origin changes the count on a small roof far more
 * than it has any right to — a 50 mm shift can win or lose a whole
 * column — so sweeping the offset is not fiddling, it is the difference
 * between a fair answer and an arbitrary one.
 */
export function bestFill(params, steps = 6) {
  const tries = [];
  for (const orientation of ["portrait", "landscape"]) {
    const mw = orientation === "portrait" ? params.moduleW : params.moduleL;
    const ml = orientation === "portrait" ? params.moduleL : params.moduleW;
    for (let i = 0; i < steps; i++) {
      for (let j = 0; j < steps; j++) {
        const r = autoFill({ ...params, orientation,
          offsetU: (i / steps) * (mw + (params.gapU ?? 0.02)),
          offsetV: (j / steps) * (ml + (params.gapV ?? 0.02)) });
        tries.push({ orientation, offsetU: (i / steps) * mw, offsetV: (j / steps) * ml,
          count: r.modules.length, result: r });
      }
    }
  }
  tries.sort((a, b) => b.count - a.count);
  return { best: tries[0], tried: tries.length,
    range: { min: tries[tries.length - 1].count, max: tries[0].count } };
}
