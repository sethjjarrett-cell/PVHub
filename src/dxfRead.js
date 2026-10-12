/* =====================================================================
   DXF READER

   Enough of DXF to get geometry back out of a drawing somebody else
   made. That is a much smaller problem than writing a general CAD
   importer, because what is wanted here is specific: closed outlines to
   use as a site boundary or a roof plane, and open runs to measure as
   cable routes.

   DXF is group-code pairs — a code on one line, its value on the next —
   so reading is a walk down that list collecting entities. What varies
   between producers is which entity they chose for a polygon, so all
   four are handled:

     LWPOLYLINE   the modern one. Vertices are repeated code 10/20
                  pairs inside the entity itself.
     POLYLINE     the R12 one. A header entity, then separate VERTEX
                  entities, then SEQEND. Carries z per vertex.
     LINE         two points. Many exports draw a boundary as a pile of
                  unconnected lines, so there is a stitcher below.
     SOLID/3DFACE occasionally used for panels; read as quads.

   Blocks and INSERTs are NOT expanded. A drawing whose boundary lives
   inside a block reference comes back empty rather than wrong, and the
   reader says so — quietly returning nothing from a file that visibly
   contains a boundary would be the worst of the available behaviours.
   ===================================================================== */

/** Walk the file into a flat list of {code, value} pairs. */
function tokenise(text) {
  const lines = String(text).split(/\r?\n/);
  const out = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = Number(lines[i].trim());
    if (!Number.isFinite(code)) {
      /* A file with an odd line somewhere resynchronises rather than
         giving up: step one line and try again. */
      i -= 1;
      continue;
    }
    out.push({ code, value: lines[i + 1] });
  }
  return out;
}

const n = (v) => { const x = Number(String(v).trim()); return Number.isFinite(x) ? x : 0; };

/**
 * Parse a DXF into entities.
 *
 * Returns the entity list, the layers seen, and a note of anything
 * recognised but not expanded, so the caller can tell the difference
 * between "this file has no boundary" and "this file has one and I
 * cannot see it".
 */
export function parseDxf(text) {
  const toks = tokenise(text);
  const entities = [];
  const layers = new Set();
  const skipped = new Map();
  let i = 0;

  /* Skip to the ENTITIES section if there is one; a bare entity list
     also parses, which some exporters produce. */
  const entStart = toks.findIndex((t, k) =>
    t.code === 2 && t.value.trim() === "ENTITIES" && toks[k - 1]?.value.trim() === "SECTION");
  if (entStart >= 0) i = entStart + 1;

  let cur = null, pendingPoly = null;

  const flush = () => {
    if (!cur) return;
    if (cur.type === "VERTEX" && pendingPoly) {
      pendingPoly.points.push({ x: cur.x ?? 0, y: cur.y ?? 0, z: cur.z ?? 0 });
    } else if (cur.type === "SEQEND") {
      if (pendingPoly) { entities.push(pendingPoly); pendingPoly = null; }
    } else if (cur.type === "POLYLINE") {
      pendingPoly = { type: "POLYLINE", layer: cur.layer, closed: !!(cur.flags & 1), points: [] };
    } else if (cur.type === "LWPOLYLINE") {
      entities.push({ type: "LWPOLYLINE", layer: cur.layer,
        closed: !!(cur.flags & 1), points: cur.points || [] });
    } else if (cur.type === "LINE") {
      entities.push({ type: "LINE", layer: cur.layer,
        points: [{ x: cur.x ?? 0, y: cur.y ?? 0, z: cur.z ?? 0 },
          { x: cur.x1 ?? 0, y: cur.y1 ?? 0, z: cur.z1 ?? 0 }] });
    } else if (cur.type === "SOLID" || cur.type === "3DFACE") {
      const p = [[cur.x, cur.y, cur.z], [cur.x1, cur.y1, cur.z1],
        [cur.x2, cur.y2, cur.z2], [cur.x3, cur.y3, cur.z3]]
        .filter((q) => q[0] !== undefined)
        .map((q) => ({ x: q[0] ?? 0, y: q[1] ?? 0, z: q[2] ?? 0 }));
      if (p.length >= 3) entities.push({ type: cur.type, layer: cur.layer, closed: true, points: p });
    } else if (cur.type === "CIRCLE") {
      entities.push({ type: "CIRCLE", layer: cur.layer,
        centre: { x: cur.x ?? 0, y: cur.y ?? 0, z: cur.z ?? 0 }, r: cur.r ?? 0 });
    } else if (cur.type === "TEXT" || cur.type === "MTEXT") {
      entities.push({ type: "TEXT", layer: cur.layer,
        at: { x: cur.x ?? 0, y: cur.y ?? 0, z: cur.z ?? 0 }, text: cur.text || "" });
    } else if (cur.type === "INSERT") {
      skipped.set("INSERT", (skipped.get("INSERT") || 0) + 1);
    } else if (cur.type && cur.type !== "SEQEND") {
      skipped.set(cur.type, (skipped.get(cur.type) || 0) + 1);
    }
    cur = null;
  };

  for (; i < toks.length; i++) {
    const { code, value } = toks[i];
    if (code === 0) {
      const v = value.trim();
      flush();
      if (v === "ENDSEC" || v === "EOF") {
        if (pendingPoly) { entities.push(pendingPoly); pendingPoly = null; }
        if (v === "EOF") break;
        continue;
      }
      cur = { type: v, layer: "0" };
      continue;
    }
    if (!cur) continue;
    switch (code) {
      case 8: cur.layer = value.trim(); layers.add(cur.layer); break;
      case 70: cur.flags = n(value); break;
      case 1: cur.text = value; break;
      case 40: cur.r = n(value); break;
      case 10:
        if (cur.type === "LWPOLYLINE") {
          (cur.points = cur.points || []).push({ x: n(value), y: 0, z: 0 });
        } else cur.x = n(value);
        break;
      case 20:
        if (cur.type === "LWPOLYLINE" && cur.points?.length) {
          cur.points[cur.points.length - 1].y = n(value);
        } else cur.y = n(value);
        break;
      case 30: cur.z = n(value); break;
      case 11: cur.x1 = n(value); break;
      case 21: cur.y1 = n(value); break;
      case 31: cur.z1 = n(value); break;
      case 12: cur.x2 = n(value); break;
      case 22: cur.y2 = n(value); break;
      case 32: cur.z2 = n(value); break;
      case 13: cur.x3 = n(value); break;
      case 23: cur.y3 = n(value); break;
      case 33: cur.z3 = n(value); break;
      default: break;
    }
  }
  flush();
  if (pendingPoly) entities.push(pendingPoly);

  return {
    entities, layers: [...layers].sort(),
    skipped: [...skipped.entries()].map(([type, count]) => ({ type, count })),
  };
}

/** Closed outlines, optionally from one layer, largest first. */
export function closedPolygons(parsed, { layer = null, minPoints = 3 } = {}) {
  const out = [];
  for (const e of parsed.entities) {
    if (layer && e.layer !== layer) continue;
    if (!e.points || e.points.length < minPoints) continue;
    if (e.type === "LINE") continue;
    if (!e.closed && e.points.length < 3) continue;
    out.push({ layer: e.layer, type: e.type, points: dedupe(e.points), closed: !!e.closed });
  }
  return out.sort((a, b) => Math.abs(polyArea(b.points)) - Math.abs(polyArea(a.points)));
}

const polyArea = (p) => {
  let a = 0;
  for (let i = 0, N = p.length; i < N; i++) {
    const q = p[i], r = p[(i + 1) % N];
    a += q.x * r.y - r.x * q.y;
  }
  return a / 2;
};

const dedupe = (pts, eps = 1e-7) => {
  const out = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && Math.hypot(p.x - last.x, p.y - last.y) < eps) continue;
    out.push(p);
  }
  if (out.length > 2) {
    const a = out[0], b = out[out.length - 1];
    if (Math.hypot(a.x - b.x, a.y - b.y) < eps) out.pop();
  }
  return out;
};

/**
 * Stitch loose LINE entities into rings.
 *
 * Plenty of drawings have a boundary that looks closed and is actually
 * a few dozen separate lines that happen to meet. Joining them by
 * proximity recovers the outline; the tolerance is generous because
 * hand-drawn CAD rarely snaps perfectly, and anything that does not
 * close is returned as an open chain rather than silently forced shut.
 */
export function stitchLines(parsed, { layer = null, tol = 0.05 } = {}) {
  const segs = parsed.entities
    .filter((e) => e.type === "LINE" && (!layer || e.layer === layer))
    .map((e) => ({ a: e.points[0], b: e.points[1], used: false }));
  const near = (p, q) => Math.hypot(p.x - q.x, p.y - q.y) <= tol;
  const chains = [];
  for (const s of segs) {
    if (s.used) continue;
    s.used = true;
    const chain = [s.a, s.b];
    let grew = true;
    while (grew) {
      grew = false;
      for (const t of segs) {
        if (t.used) continue;
        const head = chain[0], tail = chain[chain.length - 1];
        if (near(tail, t.a)) { chain.push(t.b); t.used = true; grew = true; }
        else if (near(tail, t.b)) { chain.push(t.a); t.used = true; grew = true; }
        else if (near(head, t.b)) { chain.unshift(t.a); t.used = true; grew = true; }
        else if (near(head, t.a)) { chain.unshift(t.b); t.used = true; grew = true; }
      }
    }
    const closed = chain.length > 3 && near(chain[0], chain[chain.length - 1]);
    if (closed) chain.pop();
    chains.push({ points: dedupe(chain), closed, layer: layer || "mixed" });
  }
  return chains.sort((a, b) => Math.abs(polyArea(b.points)) - Math.abs(polyArea(a.points)));
}

/**
 * The best candidate for a site boundary or roof outline.
 *
 * Prefers a closed polyline, falls back to stitched lines, and prefers
 * the largest by area on the grounds that a boundary contains
 * everything else in the drawing. Reports what it chose and what else
 * it saw, because picking the wrong ring out of a busy drawing is a
 * mistake the user has to be able to notice.
 */
export function pickOutline(parsed, { layer = null, tol = 0.05 } = {}) {
  const polys = closedPolygons(parsed, { layer }).filter((p) => p.closed || p.points.length >= 3);
  const stitched = stitchLines(parsed, { layer, tol }).filter((c) => c.closed && c.points.length >= 3);
  const all = [...polys.map((p) => ({ ...p, source: p.type })),
    ...stitched.map((c) => ({ ...c, source: "stitched lines" }))];
  if (!all.length) return { outline: null, candidates: [], reason: reasonFor(parsed) };
  all.sort((a, b) => Math.abs(polyArea(b.points)) - Math.abs(polyArea(a.points)));
  return {
    outline: all[0].points.map((p) => ({ x: p.x, y: p.y, z: p.z ?? 0 })),
    source: all[0].source, layer: all[0].layer,
    areaM2: Math.abs(polyArea(all[0].points)),
    candidates: all.slice(0, 8).map((c) => ({ layer: c.layer, source: c.source,
      points: c.points.length, areaM2: Math.abs(polyArea(c.points)) })),
    reason: null,
  };
}

function reasonFor(parsed) {
  const ins = parsed.skipped.find((s) => s.type === "INSERT");
  if (ins) {
    return `No closed outline was found, but the file has ${ins.count} block reference`
      + `${ins.count === 1 ? "" : "s"} in it. Block contents are not expanded, so a boundary `
      + "drawn inside a block is invisible here — explode it in CAD and export again.";
  }
  if (!parsed.entities.length) return "The file parsed but contains no entities at all.";
  return "No closed polyline, and the loose lines in the file do not join into a ring. "
    + "Check the outline is actually closed, or raise the join tolerance.";
}

/** Total length of every open run on a layer — a cable route check. */
export function routeLengths(parsed, { layer = null } = {}) {
  let total = 0; let runs = 0;
  for (const e of parsed.entities) {
    if (layer && e.layer !== layer) continue;
    if (!e.points || e.points.length < 2) continue;
    runs++;
    for (let i = 0; i + 1 < e.points.length; i++) {
      total += Math.hypot(e.points[i + 1].x - e.points[i].x, e.points[i + 1].y - e.points[i].y);
    }
    if (e.closed && e.points.length > 2) {
      const a = e.points[e.points.length - 1], b = e.points[0];
      total += Math.hypot(b.x - a.x, b.y - a.y);
    }
  }
  return { runs, totalLength: total };
}
