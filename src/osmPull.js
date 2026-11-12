/* ---------------------------------------------------------------
   What OpenStreetMap knows about the ground round the site.

   The exclusions a layout most often misses are the ones somebody has
   already mapped: the overhead line across the corner, the stream
   along the bottom field, the farm buildings, the wood to keep, the
   nature reserve next door. OpenStreetMap carries all of them, and the
   Overpass API answers a question about a box in one request.

   Everything read here is a candidate, not a fact. The layout offers
   the candidates by kind and nothing becomes an exclusion until it is
   added, and none comes with a buffer: OSM says where a line runs, not
   how wide its easement is. An empty answer is reported as what it
   usually is in open country, unmapped rather than clear.

   A line in OSM has no width. A power line, a stream or a hedge comes
   in as a strip one metre wide along the mapped line, which is the
   shape "as drawn", and the zone's buffer is where its real width goes.

   Overpass sends the cross-origin header, so a page can ask it
   directly. The direct request can still fail on a network that
   blocks it, so the query is also offered as a link and the answer
   can be handed back, exactly as PVGIS's is.

   Data © OpenStreetMap contributors, under the Open Database Licence;
   the interface says so wherever it shows any.

   No React.
   --------------------------------------------------------------- */

import { lonLatToLocal, localToLonLat } from "./sitePull.js";
import { pointInPolygon, area, distanceToBoundary, segmentsCross } from "./roofGeom.js";

const fin = (v) => Number.isFinite(v);

export const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
export const OSM_ATTRIBUTION = "© OpenStreetMap contributors, ODbL";

/* How far past the boundary to look. Clipping a mapped shape to the box
   is exact for any buffer up to this distance, because the parts cut
   away are at least this far from every frame. */
export const OSM_MARGIN = 250;
/* How far to look for a substation. */
export const SUBSTATION_RADIUS = 20000;
/* The width a mapped line comes in at. */
export const LINE_STRIP = 1;

/* What each tag means for a layout. `line` features are strips. */
const RULES = [
  { test: (t) => t.power === "line", kind: "easement", shape: "line", label: "Overhead line" },
  { test: (t) => t.power === "minor_line", kind: "easement", shape: "line", label: "Overhead distribution line" },
  { test: (t) => t.power === "cable", kind: "easement", shape: "line", label: "Buried power cable" },
  { test: (t) => t.waterway === "riverbank", kind: "water", shape: "area", label: "River" },
  { test: (t) => /^(river|stream|canal|ditch|drain)$/.test(t.waterway || ""), kind: "water", shape: "line",
    label: (t) => ({ river: "River", stream: "Stream", canal: "Canal", ditch: "Ditch", drain: "Drain" })[t.waterway] },
  { test: (t) => t.natural === "water" || /^(reservoir|basin)$/.test(t.landuse || ""), kind: "water", shape: "area",
    label: (t) => (t.water === "pond" ? "Pond" : t.landuse === "reservoir" || t.water === "reservoir" ? "Reservoir" : "Water") },
  { test: (t) => t.natural === "wetland", kind: "water", shape: "area", label: "Wetland" },
  { test: (t) => !!t.building, kind: "building", shape: "area", label: "Building" },
  { test: (t) => t.natural === "wood" || t.landuse === "forest", kind: "trees", shape: "area", label: "Woodland" },
  { test: (t) => t.natural === "tree_row", kind: "trees", shape: "line", label: "Tree row" },
  { test: (t) => t.barrier === "hedge", kind: "trees", shape: "line", label: "Hedge" },
  { test: (t) => t.boundary === "protected_area" || t.leisure === "nature_reserve", kind: "protected", shape: "area",
    label: "Protected area" },
  { test: (t) => t.historic && t.historic !== "no", kind: "protected", shape: "area", label: "Historic site" },
];

/** What a set of OSM tags means here, or null if nothing. */
export function classify(tags = {}) {
  for (const r of RULES) {
    if (r.test(tags)) {
      return { kind: r.kind, shape: r.shape, label: typeof r.label === "function" ? r.label(tags) : r.label };
    }
  }
  return null;
}

/** Kilovolts from an OSM voltage tag ("132000;33000"), the highest. */
export function kvOf(tag) {
  if (!tag) return null;
  const vs = String(tag).split(/[;,]/).map((s) => parseFloat(s)).filter((v) => v > 0);
  return vs.length ? Math.max(...vs) / 1000 : null;
}

/* ---------------------------------------------------------------
   The question
   --------------------------------------------------------------- */

/** The box to ask about, in degrees, from the boundary in local metres. */
export function queryBox(polygon, geo, margin = OSM_MARGIN) {
  if (!polygon || polygon.length < 3 || !geo) return null;
  const xs = polygon.map((p) => p.x), ys = polygon.map((p) => p.y);
  const rect = { x0: Math.min(...xs) - margin, y0: Math.min(...ys) - margin,
    x1: Math.max(...xs) + margin, y1: Math.max(...ys) + margin };
  /* Local y runs south, so the top of the rectangle is the north edge. */
  const [w, n] = localToLonLat({ x: rect.x0, y: rect.y0 }, geo);
  const [e, s] = localToLonLat({ x: rect.x1, y: rect.y1 }, geo);
  const [lon, lat] = localToLonLat({ x: (rect.x0 + rect.x1) / 2, y: (rect.y0 + rect.y1) / 2 }, geo);
  return { s, w, n, e, rect, centre: { lat, lon } };
}

const r6 = (v) => Math.round(v * 1e6) / 1e6;

/** The Overpass QL for a box: the features in it, and substations near it. */
export function overpassQuery(box, radius = SUBSTATION_RADIUS) {
  const bb = `(${r6(box.s)},${r6(box.w)},${r6(box.n)},${r6(box.e)})`;
  const around = `(around:${Math.round(radius)},${r6(box.centre.lat)},${r6(box.centre.lon)})`;
  return [
    "[out:json][timeout:90];",
    "(",
    `  way["power"~"^(line|minor_line|cable)$"]${bb};`,
    `  way["waterway"~"^(river|stream|canal|ditch|drain|riverbank)$"]${bb};`,
    `  way["natural"~"^(water|wetland|wood|tree_row)$"]${bb};`,
    `  relation["natural"~"^(water|wetland|wood)$"]${bb};`,
    `  way["landuse"~"^(reservoir|basin|forest)$"]${bb};`,
    `  relation["landuse"~"^(reservoir|basin|forest)$"]${bb};`,
    `  way["barrier"="hedge"]${bb};`,
    `  way["building"]${bb};`,
    `  way["boundary"="protected_area"]${bb};`,
    `  relation["boundary"="protected_area"]${bb};`,
    `  way["leisure"="nature_reserve"]${bb};`,
    `  relation["leisure"="nature_reserve"]${bb};`,
    `  way["historic"]${bb};`,
    ");",
    "out geom;",
    "(",
    `  node["power"="substation"]${around};`,
    `  way["power"="substation"]${around};`,
    `  relation["power"="substation"]${around};`,
    ");",
    "out center tags;",
  ].join("\n");
}

export const overpassLink = (q) => `${OVERPASS_URL}?data=${encodeURIComponent(q)}`;

/** Ask Overpass directly. Returns the text, or why not. */
export async function fetchOverpass(q, { timeoutMs = 60000 } = {}) {
  const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
  try {
    const r = await fetch(OVERPASS_URL, {
      method: "POST", body: `data=${encodeURIComponent(q)}`,
      headers: { "Content-Type": "application/x-www-form-urlencoded" }, signal: ctl?.signal,
    });
    const text = await r.text();
    if (!r.ok) {
      return { ok: false, msg: r.status === 429 || r.status === 504
        ? "Overpass is busy and turned the request away. Try again in a minute, or use the link."
        : `Overpass answered ${r.status}. Use the link below instead.` };
    }
    return { ok: true, text };
  } catch (e) {
    return { ok: false, msg: "Overpass could not be reached from this page. The network may block it; "
      + "the link below asks the same question in a tab." };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/* ---------------------------------------------------------------
   Geometry
   --------------------------------------------------------------- */

const same = (a, b) => Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6;

/**
 * Join a multipolygon's outer ways into closed rings. Ways come in any
 * order and either direction. A run that never closes is returned in
 * `open` rather than closed by a straight line that OSM never drew.
 */
export function stitchRings(ways) {
  const left = ways.filter((w) => w.length >= 2).map((w) => w.slice());
  const rings = [], open = [];
  while (left.length) {
    let ring = left.shift();
    let grew = true;
    while (!same(ring[0], ring[ring.length - 1]) && grew) {
      grew = false;
      const end = ring[ring.length - 1];
      for (let i = 0; i < left.length; i++) {
        const w = left[i];
        if (same(w[0], end)) { ring = ring.concat(w.slice(1)); }
        else if (same(w[w.length - 1], end)) { ring = ring.concat(w.slice(0, -1).reverse()); }
        else continue;
        left.splice(i, 1); grew = true; break;
      }
    }
    if (ring.length >= 4 && same(ring[0], ring[ring.length - 1])) rings.push(ring.slice(0, -1));
    else open.push(ring);
  }
  return { rings, open };
}

/** Sutherland–Hodgman against an axis-aligned rectangle. */
export function clipPolygon(poly, r) {
  const edges = [
    [(p) => p.x >= r.x0, (a, b) => ({ x: r.x0, y: a.y + ((b.y - a.y) * (r.x0 - a.x)) / (b.x - a.x) })],
    [(p) => p.x <= r.x1, (a, b) => ({ x: r.x1, y: a.y + ((b.y - a.y) * (r.x1 - a.x)) / (b.x - a.x) })],
    [(p) => p.y >= r.y0, (a, b) => ({ x: a.x + ((b.x - a.x) * (r.y0 - a.y)) / (b.y - a.y), y: r.y0 })],
    [(p) => p.y <= r.y1, (a, b) => ({ x: a.x + ((b.x - a.x) * (r.y1 - a.y)) / (b.y - a.y), y: r.y1 })],
  ];
  let out = poly;
  for (const [inside, cut] of edges) {
    const src = out; out = [];
    for (let i = 0; i < src.length; i++) {
      const a = src[i], b = src[(i + 1) % src.length];
      const ia = inside(a), ib = inside(b);
      if (ia) out.push(a);
      if (ia !== ib) out.push(cut(a, b));
    }
    if (!out.length) break;
  }
  return out;
}

/**
 * A polyline clipped to a rectangle, as the pieces that lie inside it
 * (Liang–Barsky per segment). A stream that leaves the box and comes
 * back is two pieces, not one joined across the outside.
 */
export function clipLine(line, r) {
  const pieces = [];
  let cur = null;
  for (let i = 0; i + 1 < line.length; i++) {
    const a = line[i], b = line[i + 1];
    const dx = b.x - a.x, dy = b.y - a.y;
    let t0 = 0, t1 = 1, keep = true;
    for (const [p, q] of [[-dx, a.x - r.x0], [dx, r.x1 - a.x], [-dy, a.y - r.y0], [dy, r.y1 - a.y]]) {
      if (p === 0) { if (q < 0) { keep = false; break; } continue; }
      const t = q / p;
      if (p < 0) { if (t > t1) { keep = false; break; } if (t > t0) t0 = t; }
      else { if (t < t0) { keep = false; break; } if (t < t1) t1 = t; }
    }
    if (!keep) { if (cur) { pieces.push(cur); cur = null; } continue; }
    const s = { x: a.x + t0 * dx, y: a.y + t0 * dy }, e = { x: a.x + t1 * dx, y: a.y + t1 * dy };
    if (cur && same(cur[cur.length - 1], s)) cur.push(e);
    else { if (cur) pieces.push(cur); cur = [s, e]; }
    if (t1 < 1) { pieces.push(cur); cur = null; }
  }
  if (cur) pieces.push(cur);
  return pieces.filter((p) => p.length >= 2);
}

export const lineLength = (l) => l.reduce((a, p, i) => (i ? a + Math.hypot(p.x - l[i - 1].x, p.y - l[i - 1].y) : 0), 0);

/**
 * A polyline as a strip `width` wide. Corners are mitred, and the mitre
 * is capped at twice the half-width so a hairpin in a stream does not
 * throw a spike across the field.
 */
export function stripAround(line, width = LINE_STRIP) {
  const pts = line.filter((p, i) => i === 0 || !same(p, line[i - 1]));
  if (pts.length < 2) return [];
  const h = width / 2;
  const nrm = (a, b) => { const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy); return { x: -dy / L, y: dx / L }; };
  const left = [], right = [];
  for (let i = 0; i < pts.length; i++) {
    const n0 = i > 0 ? nrm(pts[i - 1], pts[i]) : null;
    const n1 = i < pts.length - 1 ? nrm(pts[i], pts[i + 1]) : null;
    let n = n0 && n1 ? { x: n0.x + n1.x, y: n0.y + n1.y } : (n0 || n1);
    const L = Math.hypot(n.x, n.y);
    let k = h;
    if (n0 && n1) {
      if (L < 1e-9) n = n0;
      else { n = { x: n.x / L, y: n.y / L }; const c = n.x * n0.x + n.y * n0.y; k = Math.min(h / Math.max(c, 1e-9), 2 * h); }
    }
    left.push({ x: pts[i].x + n.x * k, y: pts[i].y + n.y * k });
    right.push({ x: pts[i].x - n.x * k, y: pts[i].y - n.y * k });
  }
  return left.concat(right.reverse());
}

/* ---------------------------------------------------------------
   The answer
   --------------------------------------------------------------- */

/** How much of the boundary a shape covers, by sampling. */
export function shareOf(boundary, poly, n = 40) {
  if (!boundary || boundary.length < 3 || !poly || poly.length < 3) return 0;
  const xs = boundary.map((p) => p.x), ys = boundary.map((p) => p.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  let inB = 0, inBoth = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const p = { x: x0 + ((i + 0.5) / n) * (x1 - x0), y: y0 + ((j + 0.5) / n) * (y1 - y0) };
      if (!pointInPolygon(p, boundary)) continue;
      inB++;
      if (pointInPolygon(p, poly)) inBoth++;
    }
  }
  return inB ? inBoth / inB : 0;
}

/** Is a shape inside the boundary at all, rather than only near it? */
function touchesBoundary(boundary, poly) {
  if (poly.some((p) => pointInPolygon(p, boundary))) return true;
  if (boundary.some((p) => pointInPolygon(p, poly))) return true;
  /* A strip across a corner can have no vertex inside either shape. */
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    for (let k = 0; k < boundary.length; k++) {
      if (segmentsCross(a, b, boundary[k], boundary[(k + 1) % boundary.length])) return true;
    }
  }
  return false;
}

/* How far a shape sits outside the boundary, at its nearest vertex. */
const gapTo = (boundary, poly) => Math.min(...poly.map((p) => distanceToBoundary(p, boundary)));

/**
 * Read an Overpass answer for a site.
 *
 * `box` is what `queryBox` returned for the question that was asked;
 * the answer is checked against it, because a file saved for one site
 * and dropped on another is a perfectly good answer about the wrong
 * place. Returns candidates as zones-to-be and the substations nearby.
 */
export function readOverpass(text, { geo, box, boundary }) {
  let j;
  try { j = typeof text === "string" ? JSON.parse(text) : text; } catch (e) {
    return { ok: false, msg: /<html|<osm|<\?xml/i.test(String(text).slice(0, 200))
      ? "That is not the JSON answer. The query asks for JSON, so the file may be an error page; open the link again."
      : "That is not an Overpass answer: it does not read as JSON." };
  }
  if (!j || !Array.isArray(j.elements)) {
    return { ok: false, msg: "That JSON is not an Overpass answer: it has no list of elements." };
  }
  if (!geo || !box) return { ok: false, msg: "The site has no position on the earth to read the answer against." };

  const toL = (g) => lonLatToLocal([g.lon, g.lat], geo);
  const r = box.rect;
  const warnings = [];
  const raw = [];
  const subs = [];
  let anyNear = false, unknown = 0, openRings = 0;

  /* An answer for this site has something within a couple of
     kilometres of the box, judged on shapes as mapped, before clipping. */
  const R = 2000;
  const nearBox = (pts) => pts.some((p) => p.x >= r.x0 - R && p.x <= r.x1 + R && p.y >= r.y0 - R && p.y <= r.y1 + R);
  for (const el of j.elements) {
    const t = el.tags || {};
    if (t.power === "substation") {
      const c = el.type === "node" ? { lat: el.lat, lon: el.lon } : el.center;
      if (!c || !fin(c.lat) || !fin(c.lon)) continue;
      const p = toL(c);
      subs.push({ osm: `${el.type}/${el.id}`, name: t.name || t.ref || null, kv: kvOf(t.voltage),
        operator: t.operator || null, lat: c.lat, lon: c.lon, local: p,
        dist: Math.hypot(p.x - (r.x0 + r.x1) / 2, p.y - (r.y0 + r.y1) / 2) });
      continue;
    }
    const c = classify(t);
    if (!c) { unknown++; continue; }
    let shapes = [];
    if (el.type === "way" && Array.isArray(el.geometry)) {
      const pts = el.geometry.filter((g) => g && fin(g.lat) && fin(g.lon)).map(toL);
      if (!anyNear && nearBox(pts)) anyNear = true;
      if (c.shape === "line") shapes = [{ line: pts }];
      else if (pts.length >= 4 && same(pts[0], pts[pts.length - 1])) shapes = [{ poly: pts.slice(0, -1) }];
      else { openRings++; continue; }
    } else if (el.type === "relation" && Array.isArray(el.members)) {
      /* Outer rings only. An inner ring is a clearing in a wood or an
         island in a lake; leaving it out keeps modules off ground that
         may be usable, which is the cautious side, and is said. */
      const outers = el.members.filter((m) => m.type === "way" && m.role !== "inner" && Array.isArray(m.geometry))
        .map((m) => m.geometry.filter((g) => g && fin(g.lat) && fin(g.lon)).map(toL));
      if (!anyNear && outers.some(nearBox)) anyNear = true;
      const { rings, open } = stitchRings(outers);
      openRings += open.length;
      if (el.members.some((m) => m.role === "inner")) c.inner = true;
      shapes = rings.map((ring) => ({ poly: ring }));
    } else continue;

    const osm = `${el.type}/${el.id}`;
    const kv = kvOf(t.voltage);
    const name = [t.name, c.label + (kv ? ` ${kv >= 1 ? Math.round(kv) : kv} kV` : "")].filter(Boolean).join(" · ");
    shapes.forEach((s, k) => {
      if (s.line) {
        for (const piece of clipLine(s.line, r)) {
          const len = lineLength(piece);
          if (len < 1) continue;
          raw.push({ ...c, osm, name, kv, line: piece, len, pts: stripAround(piece, LINE_STRIP), part: k });
        }
      } else {
        const pts = clipPolygon(s.poly, r);
        if (pts.length < 3 || area(pts) < 1) return;
        raw.push({ ...c, osm, name, kv, pts, area: area(pts), part: k });
      }
    });
  }

  const mapped = j.elements.length - subs.length - unknown;
  const subsFar = subs.length > 0 && subs.every((x) => x.dist > SUBSTATION_RADIUS * 1.5);
  if ((mapped > 0 && !anyNear) || (mapped === 0 && subsFar)) {
    return { ok: false, msg: "This answer is about somewhere else: none of what it maps lies anywhere near "
      + "this boundary. It may have been saved for another site." };
  }

  const candidates = raw.map((c) => {
    const inside = boundary ? touchesBoundary(boundary, c.pts) : true;
    return {
      ...c, inside,
      gap: inside || !boundary ? 0 : gapTo(boundary, c.pts),
      share: boundary && c.shape === "area" && inside ? shareOf(boundary, c.pts) : 0,
    };
  });
  subs.sort((a, b) => a.dist - b.dist);

  if (openRings) {
    warnings.push(`${openRings} mapped area${openRings === 1 ? " does" : "s do"} not close and ${openRings === 1 ? "was" : "were"} `
      + "left out rather than closed with a line OSM never drew.");
  }
  if (candidates.some((c) => c.inner)) {
    warnings.push("Some areas have holes in OSM (a clearing in a wood, an island in a lake). The holes are "
      + "not kept, so that ground is excluded too: the cautious reading, and worth checking on the map.");
  }
  return { ok: true, candidates, substations: subs.slice(0, 8), warnings, ignored: unknown };
}

/** The point on a polygon's edge nearest to p. */
export function nearestOnBoundary(p, poly) {
  let best = null, bd = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy;
    const t = L2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2)) : 0;
    const q = { x: a.x + t * dx, y: a.y + t * dy }, d = Math.hypot(p.x - q.x, p.y - q.y);
    if (d < bd) { bd = d; best = q; }
  }
  return best ? { ...best, dist: bd } : null;
}

const POINTS = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"];
/** Which way p lies from o, in words. Local y runs south. */
export function compass(o, p) {
  const deg = (Math.atan2(p.x - o.x, -(p.y - o.y)) * 180) / Math.PI;
  return POINTS[Math.round(((deg + 360) % 360) / 45) % 8];
}

/** Candidates grouped by kind, for an offer panel. */
export function byKind(candidates) {
  const g = {};
  for (const c of candidates) {
    const k = (g[c.kind] ||= { kind: c.kind, items: [], inside: 0, near: 0, length: 0, area: 0, maxShare: 0 });
    k.items.push(c);
    if (c.inside) k.inside++; else k.near++;
    if (c.len) k.length += c.len;
    if (c.area) k.area += c.area;
    k.maxShare = Math.max(k.maxShare, c.share || 0);
  }
  return Object.values(g);
}
