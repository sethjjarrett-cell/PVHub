/* =====================================================================
   DXF WRITER

   DXF is a text format, so this is string assembly and nothing more —
   no library, no backend, no binary. The file is a flat sequence of
   pairs: a group code on one line, its value on the next. Code 0 starts
   an entity, 8 names its layer, 10/20/30 are x/y/z of the first point,
   and so on. That is genuinely the whole idea.

   Written as R12 (AC1009), the oldest version that carries everything
   needed here. Newer flavours are more compact — LWPOLYLINE instead of
   POLYLINE and its train of VERTEX entities — but R12 is the one that
   every reader made in the last forty years opens without comment, and
   a roof plan is not large enough for compactness to matter. AutoCAD
   opens it directly and will save it as DWG in one step if the native
   format is wanted.

   The geometry goes out in 3D. A roof plane has real node heights and
   the modules sit on it, so writing a flat plan would throw away the
   one thing that makes the drawing worth exporting — PVsyst wants to
   know the surface is tilted, and so does anyone looking at a section.

   What a DXF carries and what it does not: geometry, layers, colours
   and text. Not module electrical data, not string assignments, not
   yield. Those are set up in whatever receives the drawing.
   ===================================================================== */

/* AutoCAD Color Index — the small fixed palette R12 understands. */
export const ACI = {
  red: 1, yellow: 2, green: 3, cyan: 4, blue: 5, magenta: 6,
  white: 7, grey: 8, ltGrey: 9, orange: 30,
};

/** One group-code pair. Everything below is built from this. */
const pair = (code, value) => `${code}\n${value}\n`;

/* Six decimals is a micrometre at these scales — past any surveying
   accuracy, and short enough to keep the file readable. */
const num = (v) => (Number.isFinite(v) ? Number(v).toFixed(6) : "0.000000");

function header() {
  return pair(0, "SECTION") + pair(2, "HEADER")
    + pair(9, "$ACADVER") + pair(1, "AC1009")
    + pair(9, "$INSUNITS") + pair(70, 6)      // 6 = metres
    + pair(0, "ENDSEC");
}

function tables(layers) {
  let s = pair(0, "SECTION") + pair(2, "TABLES")
    + pair(0, "TABLE") + pair(2, "LAYER") + pair(70, layers.length);
  for (const l of layers) {
    s += pair(0, "LAYER") + pair(2, l.name) + pair(70, 0)
      + pair(62, l.colour ?? ACI.white) + pair(6, l.lineType || "CONTINUOUS");
  }
  return s + pair(0, "ENDTAB") + pair(0, "ENDSEC");
}

/**
 * A closed 3D polyline.
 *
 * R12 spells this as a POLYLINE entity, then one VERTEX per point, then
 * a SEQEND to close the train. Flag 8 on the POLYLINE marks it 3D and
 * flag 1 marks it closed, so 9 means both; each VERTEX repeats flag 32
 * to say it belongs to a 3D polyline.
 */
export function polyline3d(layer, pts, closed = true) {
  let s = pair(0, "POLYLINE") + pair(8, layer) + pair(66, 1)
    + pair(10, "0.0") + pair(20, "0.0") + pair(30, "0.0")
    + pair(70, closed ? 9 : 8);
  for (const p of pts) {
    s += pair(0, "VERTEX") + pair(8, layer)
      + pair(10, num(p.x)) + pair(20, num(p.y)) + pair(30, num(p.z ?? 0))
      + pair(70, 32);
  }
  return s + pair(0, "SEQEND") + pair(8, layer);
}

export function line3d(layer, a, b) {
  return pair(0, "LINE") + pair(8, layer)
    + pair(10, num(a.x)) + pair(20, num(a.y)) + pair(30, num(a.z ?? 0))
    + pair(11, num(b.x)) + pair(21, num(b.y)) + pair(31, num(b.z ?? 0));
}

export function text3d(layer, p, height, value, rotation = 0) {
  return pair(0, "TEXT") + pair(8, layer)
    + pair(10, num(p.x)) + pair(20, num(p.y)) + pair(30, num(p.z ?? 0))
    + pair(40, num(height)) + pair(1, String(value)) + pair(50, num(rotation));
}

export function circle3d(layer, p, r) {
  return pair(0, "CIRCLE") + pair(8, layer)
    + pair(10, num(p.x)) + pair(20, num(p.y)) + pair(30, num(p.z ?? 0))
    + pair(40, num(r));
}

/** Assemble a complete file from layer definitions and entity strings. */
export function buildDxf(layers, entities) {
  return header() + tables(layers)
    + pair(0, "SECTION") + pair(2, "ENTITIES")
    + entities.join("")
    + pair(0, "ENDSEC") + pair(0, "EOF");
}

/* ---------------------------------------------------------------
   The roof drawing
   --------------------------------------------------------------- */

export const ROOF_LAYERS = [
  { name: "PV-ROOF-OUTLINE", colour: ACI.white },
  { name: "PV-ROOF-SETBACK", colour: ACI.grey, lineType: "CONTINUOUS" },
  { name: "PV-OBSTRUCTION", colour: ACI.red },
  { name: "PV-OBSTRUCTION-BUFFER", colour: ACI.magenta },
  { name: "PV-MODULE", colour: ACI.blue },
  { name: "PV-MODULE-ROW", colour: ACI.cyan },
  { name: "PV-TEXT", colour: ACI.yellow },
  { name: "PV-NODE", colour: ACI.orange },
];

/**
 * Everything on a roof plane, laid out on its own layers.
 *
 * Layered so the receiving end can switch parts off: the modules alone
 * for a PVsyst import, the outline and obstructions for a survey check,
 * the lot for a drawing to issue. Each is a separate layer because that
 * is the one thing a DXF does well and a screenshot does not.
 */
export function roofToDxf({
  planes, moduleLabel = true, nodeLabels = true, textHeight = 0.25,
}) {
  const ents = [];
  for (const pl of planes) {
    const zOf = (p) => (pl.plane
      ? pl.plane.a * p.x + pl.plane.b * p.y + pl.plane.c
      : (p.z ?? 0));
    const lift = (pts) => pts.map((p) => ({ x: p.x, y: p.y, z: zOf(p) }));

    if (pl.outline?.length >= 3) ents.push(polyline3d("PV-ROOF-OUTLINE", lift(pl.outline)));
    if (pl.usable?.length >= 3) ents.push(polyline3d("PV-ROOF-SETBACK", lift(pl.usable)));

    for (const ob of pl.obstructions || []) {
      if (ob.poly?.length >= 3) ents.push(polyline3d("PV-OBSTRUCTION", lift(ob.poly)));
      if (ob.label) {
        const c = ob.poly.reduce((a, p) => ({ x: a.x + p.x / ob.poly.length, y: a.y + p.y / ob.poly.length }), { x: 0, y: 0 });
        ents.push(text3d("PV-TEXT", { ...c, z: zOf(c) }, textHeight, ob.label));
      }
    }
    for (const k of pl.keepOuts || []) {
      if (k.poly?.length >= 3) ents.push(polyline3d("PV-OBSTRUCTION-BUFFER", lift(k.poly)));
    }

    for (const m of pl.modules || []) {
      ents.push(polyline3d("PV-MODULE", lift(m.quad)));
    }

    if (nodeLabels) {
      for (const n of pl.outline || []) {
        const p = { x: n.x, y: n.y, z: zOf(n) };
        ents.push(circle3d("PV-NODE", p, textHeight * 0.4));
        /* The label is nudged clear of its node, so its height must be
           the plane's height at the nudged position — carrying the
           node's own z would float it off the roof by the gradient
           times the offset, and a drawing whose text is not on the
           surface is a drawing that fails a section check. */
        const lp = { x: p.x + textHeight * 0.6, y: p.y + textHeight * 0.6 };
        ents.push(text3d("PV-TEXT", { ...lp, z: zOf(lp) }, textHeight * 0.8, `${num(p.z)}`));
      }
    }

    if (moduleLabel && pl.modules?.length) {
      const bb = pl.outline.reduce((a, p) => ({
        minX: Math.min(a.minX, p.x), maxY: Math.max(a.maxY, p.y),
      }), { minX: Infinity, maxY: -Infinity });
      const at = { x: bb.minX, y: bb.maxY + textHeight * 2 };
      ents.push(text3d("PV-TEXT", { ...at, z: zOf(at) }, textHeight,
        `${pl.name || "ROOF"} - ${pl.modules.length} MODULES - `
        + `PITCH ${num(pl.pitch)} DEG - AZIMUTH ${num(pl.azimuth)} DEG`));
    }
  }
  return buildDxf(ROOF_LAYERS, ents);
}

/** Count the entities in a DXF, for checking a file came out whole. */
export function countEntities(dxf) {
  const out = {};
  const lines = String(dxf).split("\n");
  for (let i = 0; i + 1 < lines.length; i += 2) {
    if (lines[i].trim() === "0") {
      const v = lines[i + 1].trim();
      out[v] = (out[v] || 0) + 1;
    }
  }
  return out;
}
