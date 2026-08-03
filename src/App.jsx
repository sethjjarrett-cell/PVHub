import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import PDF_WORKER_TEXT from "./pdfWorkerText.js";
import React, { useState, useMemo, useEffect, useRef, useCallback } from "react";

/* =====================================================================
   LAYOUT GENERATOR — Phase 2
   Block-based generation: frames grouped into inverter blocks sized
   from the string/inverter electrical config, tiled on a macro grid
   with corridors, AC collector runs to a draggable substation, and a
   set of alternative design variants ranked for comparison.
   Units: metres. North is up. Frames are axis-aligned.
   ===================================================================== */

/* ---------------- geometry utilities ---------------- */
const rad = (d) => (d * Math.PI) / 180;

function polygonArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}

function polygonCentroid(pts) {
  let x = 0, y = 0;
  for (const p of pts) { x += p.x; y += p.y; }
  return { x: x / pts.length, y: y / pts.length };
}

function bboxOf(pts) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

function pointInPolygon(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
    const hit =
      (yi > pt.y) !== (yj > pt.y) &&
      pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi) + xi;
    if (hit) inside = !inside;
  }
  return inside;
}

const orient = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
const onSeg = (a, b, c) =>
  Math.min(a.x, b.x) - 1e-9 <= c.x && c.x <= Math.max(a.x, b.x) + 1e-9 &&
  Math.min(a.y, b.y) - 1e-9 <= c.y && c.y <= Math.max(a.y, b.y) + 1e-9;

function segsIntersect(p1, p2, p3, p4) {
  const d1 = orient(p3, p4, p1);
  const d2 = orient(p3, p4, p2);
  const d3 = orient(p1, p2, p3);
  const d4 = orient(p1, p2, p4);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
      ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  if (Math.abs(d1) < 1e-9 && onSeg(p3, p4, p1)) return true;
  if (Math.abs(d2) < 1e-9 && onSeg(p3, p4, p2)) return true;
  if (Math.abs(d3) < 1e-9 && onSeg(p1, p2, p3)) return true;
  if (Math.abs(d4) < 1e-9 && onSeg(p1, p2, p4)) return true;
  return false;
}

/** Rect (already inflated by setback) fully inside polygon? */
function rectFits(x, y, w, h, poly) {
  const c = [
    { x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h },
  ];
  for (const p of c) if (!pointInPolygon(p, poly)) return false;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    for (let k = 0; k < 4; k++) {
      if (segsIntersect(a, b, c[k], c[(k + 1) % 4])) return false;
    }
  }
  return true;
}

/* ---------------- frame geometry engine ---------------- */
function computeFrameGeometry(mod, frame) {
  const warnings = [];
  const portrait = frame.orientation === "portrait";
  const dAlong = portrait ? mod.width : mod.length;   // module dim along frame axis
  const dAcross = portrait ? mod.length : mod.width;  // module dim across frame axis
  const nP = Math.max(1, Math.round(frame.config));

  let alongCount;
  if (frame.sizeMode === "length") {
    // largest whole-module count whose frame length stays within maxLength
    const usable = frame.maxLength - 2 * frame.endOverhang - frame.centreGap + frame.gapAlong;
    alongCount = Math.max(1, Math.floor(usable / (dAlong + frame.gapAlong) + 1e-9));
  } else {
    alongCount = Math.max(1, Math.round(frame.modulesPerFrame / nP));
    if (alongCount * nP !== frame.modulesPerFrame) {
      warnings.push(
        `Modules per frame adjusted ${frame.modulesPerFrame} → ${alongCount * nP} (must be a multiple of ${nP} for a ${nP}P frame).`
      );
    }
  }
  const modules = alongCount * nP;

  const alongLen =
    alongCount * dAlong +
    Math.max(0, alongCount - 1) * frame.gapAlong +
    2 * frame.endOverhang +
    frame.centreGap;
  if (frame.sizeMode === "length" && alongLen > frame.maxLength + 1e-6) {
    warnings.push(`Overhang + centre gap alone exceed the max length of ${frame.maxLength} m.`);
  }

  const acrossW = nP * dAcross + (nP - 1) * frame.crossGap;
  // collector width & plan depth by mounting:
  //  tracker: flat stow envelope; fixed: single face foreshortened by tilt;
  //  ew (East-West duo): two faces tilted E and W meeting at a ridge gap
  const collectW = frame.mounting === "ew" ? 2 * acrossW : acrossW;
  const planAcross =
    frame.mounting === "fixed" ? acrossW * Math.cos(rad(frame.tilt)) :
    frame.mounting === "ew" ? 2 * acrossW * Math.cos(rad(frame.tilt)) + (frame.ridgeGap || 0) :
    acrossW;

  return {
    dAlong, dAcross, nP, alongCount, modules,
    alongLen, acrossW, collectW, planAcross,
    gapAlong: frame.gapAlong, crossGap: frame.crossGap,
    endOverhang: frame.endOverhang, centreGap: frame.centreGap,
    mounting: frame.mounting, tilt: frame.tilt,
    clearance: frame.clearance, maxRot: frame.maxRot, ridgeGap: frame.ridgeGap || 0,
    warnings,
  };
}

function factorPairs(n) {
  const out = [];
  for (let k = 1; k <= n; k++) if (n % k === 0) out.push({ w: k, d: n / k });
  return out;
}

/* ---------------- array alignment (stagger) ----------------
   Frames ALWAYS stay true N–S (trackers rotate about a N–S axis, so
   any azimuth rotation costs yield). To follow a boundary edge or
   road, the layout instead STAGGERS: each lane's frames shift along
   the axis so frame ends step along the alignment line. Corridors and
   AC runs become diagonals; every frame remains axis-aligned.       */

/** Longest boundary edges → deduplicated direction candidates (deg, 0–180). */
function alignmentCandidates(polygon, maxN = 3) {
  if (!polygon || polygon.length < 3) return [];
  const edges = polygon
    .map((p, i) => {
      const q = polygon[(i + 1) % polygon.length];
      return { p, q, len: Math.hypot(q.x - p.x, q.y - p.y), ang: Math.atan2(q.y - p.y, q.x - p.x) };
    })
    .sort((a, b) => b.len - a.len);
  const out = [];
  for (const e of edges) {
    let deg = ((e.ang * 180) / Math.PI) % 180;
    if (deg < 0) deg += 180;
    if (out.some((o) => Math.abs(o.deg - deg) < 4 || Math.abs(o.deg - deg) > 176)) continue;
    out.push({ deg, edge: e });
    if (out.length >= maxN) break;
  }
  return out;
}

/** Stagger slope (along-axis shift per metre of lane travel) for an
    edge direction. Returns null when the edge is too close to the
    frame axis (no stagger needed / slope blows up). */
function slopeForEdge(deg, mounting) {
  const MAX = 2.75; // ≈ 70° — steeper staggers are impractical
  let m;
  if (mounting !== "fixed") {
    if (Math.abs(deg - 90) < 12) return null; // near-parallel to frame axis
    m = Math.tan(rad(deg));
  } else {
    if (deg < 12 || deg > 168) return null;   // near-parallel to E–W rows
    m = 1 / Math.tan(rad(deg));
  }
  if (!Number.isFinite(m) || Math.abs(m) > MAX) return null;
  return Math.round(m * 1000) / 1000;
}

/** Stepped outline path around a staggered block's lanes.
    laneCells: [{u, w, a, b}] — u lane coord (low side), w lane width,
    a/b slot extents. Sorted by u. Mapped to x/y per orientation.     */
function blockOutlinePoints(laneCells, vertical, pad) {
  const n = laneCells.length;
  if (!n) return "";
  const lc = laneCells;
  const ub = (i) => (lc[i].u + lc[i].w + lc[i + 1].u) / 2;
  const pts = [];
  pts.push([lc[0].u - pad, lc[0].a - pad]);
  for (let i = 0; i < n; i++) {
    const uEnd = i < n - 1 ? ub(i) : lc[i].u + lc[i].w + pad;
    pts.push([uEnd, lc[i].a - pad]);
    if (i < n - 1) pts.push([uEnd, lc[i + 1].a - pad]);
  }
  pts.push([lc[n - 1].u + lc[n - 1].w + pad, lc[n - 1].b + pad]);
  for (let i = n - 1; i >= 0; i--) {
    const uStart = i > 0 ? ub(i - 1) : lc[0].u - pad;
    pts.push([uStart, lc[i].b + pad]);
    if (i > 0) pts.push([uStart, lc[i - 1].b + pad]);
  }
  return (
    pts
      .map(([u, v], k) => `${k ? "L" : "M"} ${vertical ? u : v} ${vertical ? v : u}`)
      .join(" ") + " Z"
  );
}

/* ---------------- block-grid layout ----------------
   A block = lanesWide × framesDeep frames = one inverter.
   Blocks tile a macro grid; corridors (gapSlot) run between bands
   for access roads and AC collector runs. Edge blocks may narrow
   in whole lanes when the policy allows, so layouts step with the
   boundary instead of scattering frames.                            */
function placeBlockGrid(polygon, geo, cfg, offL, offS) {
  const vertical = geo.mounting !== "fixed"; // tracker axis N–S → lanes step E–W
  const fAcross = geo.planAcross, fLen = geo.alongLen;
  const bb = bboxOf(polygon);
  const m = cfg.stagger || 0; // along-axis shift per metre of lane travel
  const physLane = (w) => (w - 1) * cfg.pitch + fAcross;
  const physSlot = cfg.framesDeep * fLen + (cfg.framesDeep - 1) * cfg.endGap;
  const pitchLane = physLane(cfg.lanesWide) + cfg.gapLane;
  const rpc = cfg.rowsPerCorridor === 2 ? 2 : 1;
  const period = rpc * physSlot + (rpc - 1) * cfg.endGap + cfg.gapSlot;

  const widths = [cfg.lanesWide];
  if (cfg.allowNarrow) for (let w = cfg.lanesWide - 1; w >= 1; w--) widths.push(w);

  const laneMin = vertical ? bb.minX : bb.minY;
  const laneMax = vertical ? bb.maxX : bb.maxY;
  const laneMid = (laneMin + laneMax) / 2; // shear about site centre
  const staggerPad = (Math.abs(m) * (laneMax - laneMin)) / 2;

  const frames = [], blocks = [];
  const slot0 = (vertical ? bb.minY : bb.minX) - physSlot - staggerPad + offS;
  const slotEnd = (vertical ? bb.maxY : bb.maxX) + staggerPad;
  const lane0 = laneMin - physLane(cfg.lanesWide) + offL;
  const laneEnd = laneMax;

  let pair = 0;
  for (let s0 = slot0; s0 < slotEnd; s0 += period, pair++) {
    for (let r = 0; r < rpc; r++) {
      const s = s0 + r * (physSlot + cfg.endGap);
      if (s >= slotEnd) break;
      const band = pair * rpc + r;
      const corrId = rpc === 2 ? (r === 0 ? pair : pair + 1) : band;
      const side = rpc === 2 && r === 0 ? -1 : 1; // -1 corridor before row, +1 after
      const corrBase = side < 0 ? s - cfg.gapSlot / 2 : s + physSlot + cfg.gapSlot / 2;
      for (let l = lane0; l < laneEnd; l += pitchLane) {
        let placed = null;
        for (const w of widths) {
          const aligns = w === cfg.lanesWide ? [0] : [0, (cfg.lanesWide - w) * cfg.pitch];
          for (const al of aligns) {
            const l0 = l + al;
            let ok = true;
            const cells = [];
            for (let li = 0; li < w && ok; li++) {
              const lc = l0 + li * cfg.pitch;
              const shift = m * (lc + fAcross / 2 - laneMid);
              for (let sj = 0; sj < cfg.framesDeep && ok; sj++) {
                const sc = s + sj * (fLen + cfg.endGap) + shift;
                const x = vertical ? lc : sc;
                const y = vertical ? sc : lc;
                const rw = vertical ? fAcross : fLen;
                const rh = vertical ? fLen : fAcross;
                if (!rectFits(x - cfg.setback, y - cfg.setback,
                              rw + 2 * cfg.setback, rh + 2 * cfg.setback, polygon)) {
                  ok = false;
                } else {
                  const sc2 = frameSlopeCheck(cfg.terrain, x, y, rw, rh, vertical);
                  if (sc2.hardFail) ok = false;
                  else cells.push({ x, y, w: rw, h: rh, li, pen: sc2.pen });
                }
              }
            }
            if (ok && cells.length) { placed = { cells, w, l0 }; break; }
          }
          if (placed) break;
        }
        if (placed) {
          // per-lane slot extents for the stepped envelope
          const laneCells = [];
          for (let li = 0; li < placed.w; li++) {
            const sub = placed.cells.filter((c) => c.li === li);
            const u = vertical ? sub[0].x : sub[0].y;
            const a = Math.min(...sub.map((c) => (vertical ? c.y : c.x)));
            const b = Math.max(...sub.map((c) => (vertical ? c.y + c.h : c.x + c.w)));
            laneCells.push({ u, w: fAcross, a, b });
          }
          const xs = placed.cells.map((c) => c.x), ys = placed.cells.map((c) => c.y);
          const bx = Math.min(...xs), by = Math.min(...ys);
          const bx2 = Math.max(...placed.cells.map((c) => c.x + c.w));
          const by2 = Math.max(...placed.cells.map((c) => c.y + c.h));
          const id = blocks.length;
          const bPen = placed.cells.reduce((s2, c) => s2 + (c.pen || 0), 0) / placed.cells.length;
          placed.cells.forEach((c) =>
            frames.push({ x: c.x, y: c.y, w: c.w, h: c.h, block: id, pen: c.pen || 0 }));
          blocks.push({
            id, band, corrId, side, corrBase, pen: bPen,
            x: bx, y: by, w: bx2 - bx, h: by2 - by,
            laneCells,
            nFrames: placed.cells.length,
            full: placed.w === cfg.lanesWide,
            lanes: placed.w,
          });
        }
      }
    }
  }
  return { frames, blocks, laneMid };
}

function generateBlockVariant(polygon, geo, cfg) {
  const t0 = performance.now();
  if (!polygon || polygon.length < 3) return { frames: [], blocks: [], laneMid: 0, ms: 0 };
  if (!(geo.planAcross > 0 && geo.alongLen > 0 && cfg.pitch > 0)) {
    return { frames: [], blocks: [], laneMid: 0, ms: 0 };
  }
  // with terrain, search harder — the grid origin decides whether blocks
  // land on flat ground or on a slope, and that is worth more than speed
  const L_TR = cfg.terrain ? 6 : 3, S_TR = cfg.terrain ? 4 : 2;
  const rpc = cfg.rowsPerCorridor === 2 ? 2 : 1;
  const physSlot = cfg.framesDeep * geo.alongLen + (cfg.framesDeep - 1) * cfg.endGap;
  const period = rpc * physSlot + (rpc - 1) * cfg.endGap + cfg.gapSlot;
  const physLaneFull = (cfg.lanesWide - 1) * cfg.pitch + geo.planAcross;
  let best = { frames: [], blocks: [], laneMid: 0, score: -1 };
  for (let oi = 0; oi < L_TR; oi++) {
    for (let oj = 0; oj < S_TR; oj++) {
      const offL = ((physLaneFull + cfg.gapLane) * oi) / L_TR;
      const offS = (period * oj) / S_TR;
      const r = placeBlockGrid(polygon, geo, cfg, offL, offS);
      // effective frames: a frame needing grading counts for less, so an
      // offset that sits on flat ground beats one that merely fits more
      const score = cfg.terrain
        ? r.frames.reduce((s, f) => s + (1 - 1.5 * (f.pen || 0)), 0)
        : r.frames.length;
      if (score > best.score) best = { ...r, score };
    }
  }
  return { frames: best.frames, blocks: best.blocks, laneMid: best.laneMid, ms: performance.now() - t0 };
}

/* ---------------- free-fill layout (density reference) ---------------- */
function generateFreeFill(polygon, geo, pitch, endGap, setback, stagger = 0, terrainCtx = null) {
  const t0 = performance.now();
  if (!polygon || polygon.length < 3) return { frames: [], ms: 0 };
  if (!(geo.alongLen > 0 && geo.planAcross > 0 && pitch > 0)) return { frames: [], ms: 0 };
  const vertical = geo.mounting !== "fixed";
  const fw = vertical ? geo.planAcross : geo.alongLen;
  const fh = vertical ? geo.alongLen : geo.planAcross;
  const bb = bboxOf(polygon);
  const slot = (vertical ? fh : fw) + endGap;
  const laneMin = vertical ? bb.minX : bb.minY;
  const laneMax = vertical ? bb.maxX : bb.maxY;
  const laneMid = (laneMin + laneMax) / 2;
  const pad = (Math.abs(stagger) * (laneMax - laneMin)) / 2;
  const TR = 3;
  let best = { frames: [], score: -1 };
  for (let oi = 0; oi < TR; oi++) {
    for (let oj = 0; oj < TR; oj++) {
      const off1 = (pitch * oi) / TR;
      const off2 = (slot * oj) / TR;
      const frames = [];
      if (vertical) {
        let lane = 0;
        for (let x = bb.minX - fw + off1; x < bb.maxX; x += pitch, lane++) {
          const shift = stagger * (x + fw / 2 - laneMid);
          for (let y = bb.minY - fh - pad + off2 + shift; y < bb.maxY + pad; y += slot) {
            if (rectFits(x - setback, y - setback, fw + 2 * setback, fh + 2 * setback, polygon)) {
              const sc2 = frameSlopeCheck(terrainCtx, x, y, fw, fh, true);
              if (!sc2.hardFail) frames.push({ x, y, w: fw, h: fh, lane, pos: y, pen: sc2.pen });
            }
          }
        }
      } else {
        let lane = 0;
        for (let y = bb.minY - fh + off1; y < bb.maxY; y += pitch, lane++) {
          const shift = stagger * (y + fh / 2 - laneMid);
          for (let x = bb.minX - fw - pad + off2 + shift; x < bb.maxX + pad; x += slot) {
            if (rectFits(x - setback, y - setback, fw + 2 * setback, fh + 2 * setback, polygon)) {
              const sc2 = frameSlopeCheck(terrainCtx, x, y, fw, fh, false);
              if (!sc2.hardFail) frames.push({ x, y, w: fw, h: fh, lane, pos: x, pen: sc2.pen });
            }
          }
        }
      }
      if (frames.length > best.score) best = { frames, score: frames.length };
    }
  }
  return { frames: best.frames, ms: performance.now() - t0 };
}

/* ---------------- electrical annotation ---------------- */
function annotateBlockVariant(res, geo, elec, gapSlot) {
  const vertical = geo.mounting !== "fixed";
  const spf = geo.modules / Math.max(1, elec.modulesPerString);
  const sorted = [...res.blocks].sort(
    (a, b) =>
      a.band - b.band ||
      (a.band % 2 === 0
        ? (vertical ? a.x - b.x : a.y - b.y)
        : (vertical ? b.x - a.x : b.y - a.y))
  );
  const byId = new Map();
  sorted.forEach((b, i) => {
    b.inv = i;
    b.tx = Math.floor(i / Math.max(1, elec.invertersPerTx));
    b.strings = b.nFrames * spf;
    const off = Math.max(0.5, gapSlot / 2);
    // marker on the block's middle lane, on the corridor side —
    // with stagger this lands on the diagonal corridor line
    const mid = b.laneCells[Math.floor(b.laneCells.length / 2)];
    const uC = mid.u + mid.w / 2;
    const vC = b.side < 0 ? mid.a - off : mid.b + off;
    b.mx = vertical ? uC : vC;
    b.my = vertical ? vC : uC;
    byId.set(b.id, b);
  });
  for (const f of res.frames) {
    const b = byId.get(f.block);
    f.inv = b.inv; f.tx = b.tx;
    f.modules = geo.modules; f.strings = spf;
  }
  return { frames: res.frames, blocks: sorted, vertical, laneMid: res.laneMid };
}

function annotateFreeFill(res, geo, elec) {
  const vertical = geo.mounting !== "fixed";
  const spf = geo.modules / Math.max(1, elec.modulesPerString);
  const arr = [...res.frames].sort(
    (a, b) => a.lane - b.lane || (a.lane % 2 === 0 ? a.pos - b.pos : b.pos - a.pos)
  );
  let inv = 0, acc = 0;
  for (const f of arr) {
    if (acc > 0 && acc + spf > elec.stringsPerInverter + 1e-9) { inv++; acc = 0; }
    f.inv = inv; f.tx = Math.floor(inv / Math.max(1, elec.invertersPerTx));
    f.modules = geo.modules; f.strings = spf;
    acc += spf;
  }
  // pseudo-blocks: bbox + centroid marker per inverter group (no AC bands)
  const map = new Map();
  for (const f of arr) {
    const g = map.get(f.inv) || {
      id: f.inv, inv: f.inv, tx: f.tx, band: null, corrId: null, nFrames: 0, strings: 0,
      minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity, sx: 0, sy: 0,
    };
    g.nFrames++; g.strings += spf; g.penSum = (g.penSum || 0) + (f.pen || 0);
    g.minX = Math.min(g.minX, f.x); g.minY = Math.min(g.minY, f.y);
    g.maxX = Math.max(g.maxX, f.x + f.w); g.maxY = Math.max(g.maxY, f.y + f.h);
    g.sx += f.x + f.w / 2; g.sy += f.y + f.h / 2;
    map.set(f.inv, g);
  }
  const blocks = [...map.values()].map((g) => ({
    id: g.id, inv: g.inv, tx: g.tx, band: null, corrId: null,
    x: g.minX, y: g.minY, w: g.maxX - g.minX, h: g.maxY - g.minY,
    nFrames: g.nFrames, strings: g.strings, full: false, lanes: 0,
    pen: (g.penSum || 0) / g.nFrames,
    mx: g.sx / g.nFrames, my: g.sy / g.nFrames,
  }));
  return { frames: arr, blocks, vertical };
}

function txBoxesOf(blocks, pad) {
  const map = new Map();
  for (const b of blocks) {
    const g = map.get(b.tx);
    if (!g) map.set(b.tx, { id: b.tx, minX: b.x, minY: b.y, maxX: b.x + b.w, maxY: b.y + b.h });
    else {
      g.minX = Math.min(g.minX, b.x); g.minY = Math.min(g.minY, b.y);
      g.maxX = Math.max(g.maxX, b.x + b.w); g.maxY = Math.max(g.maxY, b.y + b.h);
    }
  }
  return [...map.values()].map((g) => ({
    id: g.id, x: g.minX - pad, y: g.minY - pad,
    w: g.maxX - g.minX + 2 * pad, h: g.maxY - g.minY + 2 * pad,
  }));
}

/* ---------------- AC collector runs ---------------- */
function buildAc(blocks, ss, vertical, stagger = 0, laneMid = 0) {
  const banded = blocks.filter((b) => b.corrId !== null && b.corrId !== undefined);
  if (!banded.length || !ss) return { segs: [], total: null };
  const m = stagger || 0;
  const corridors = new Map();
  for (const b of banded) {
    const along = vertical ? b.mx : b.my; // lane coordinate of the marker
    const g = corridors.get(b.corrId) || { base: b.corrBase, min: along, max: along };
    g.min = Math.min(g.min, along);
    g.max = Math.max(g.max, along);
    g.base = b.corrBase;
    corridors.set(b.corrId, g);
  }
  const ssAlong = vertical ? ss.x : ss.y;
  const ssCorr = vertical ? ss.y : ss.x;
  // corridor real coordinate at lane position t: base + m·(t − laneMid)
  const corrAt = (base, t) => base + m * (t - laneMid);
  const segs = [];
  let total = 0, iMin = Infinity, iMax = -Infinity;
  const diag = Math.sqrt(1 + m * m);
  for (const g of corridors.values()) {
    const a = Math.min(g.min, ssAlong), z = Math.max(g.max, ssAlong);
    total += (z - a) * diag;
    const va = corrAt(g.base, a), vz = corrAt(g.base, z);
    segs.push(vertical ? { x1: a, y1: va, x2: z, y2: vz }
                       : { x1: va, y1: a, x2: vz, y2: z });
    const vi = corrAt(g.base, ssAlong); // where the trunk meets this corridor
    iMin = Math.min(iMin, vi); iMax = Math.max(iMax, vi);
  }
  const tMin = Math.min(iMin, ssCorr), tMax = Math.max(iMax, ssCorr);
  total += tMax - tMin;
  segs.push(vertical ? { x1: ssAlong, y1: tMin, x2: ssAlong, y2: tMax }
                     : { x1: tMin, y1: ssCorr, x2: tMax, y2: ssCorr });
  return { segs, total };
}

function dcStats(frames, blocks) {
  if (!frames.length) return { avg: 0, max: 0 };
  const byId = new Map(blocks.map((b) => [b.inv, b]));
  let sum = 0, max = 0;
  for (const f of frames) {
    const b = byId.get(f.inv);
    if (!b) continue;
    const d = Math.abs(f.x + f.w / 2 - b.mx) + Math.abs(f.y + f.h / 2 - b.my);
    sum += d;
    if (d > max) max = d;
  }
  return { avg: sum / frames.length, max };
}

/** Tidy a placed layout into clean, uniform bands: within each row keep only
    the longest unbroken run of full blocks, then drop stub rows. Removes the
    ragged protrusions without gutting the capacity a strict rectangle would. */
function trimToRectangle(ann, invertersPerTx) {
  const full = ann.blocks.filter((b) => b.full);
  if (full.length < 3) return null;
  const vertical = ann.vertical;
  const laneOf = (b) => (vertical ? b.x : b.y);
  const spanOf = (b) => (vertical ? b.w : b.h);

  const bands = new Map();
  for (const b of full) {
    if (!bands.has(b.band)) bands.set(b.band, []);
    bands.get(b.band).push(b);
  }
  const runs = [];
  for (const [, list] of bands) {
    list.sort((a, b) => laneOf(a) - laneOf(b));
    let run = [list[0]];
    let bestRun = run;
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1];
      const gap = laneOf(list[i]) - (laneOf(prev) + spanOf(prev));
      if (gap <= spanOf(prev) * 0.6) run.push(list[i]);
      else { if (run.length > bestRun.length) bestRun = run; run = [list[i]]; }
    }
    if (run.length > bestRun.length) bestRun = run;
    runs.push(bestRun);
  }
  const lens = runs.map((r) => r.length).sort((a, b) => a - b);
  const med = lens[Math.floor(lens.length / 2)] || 1;
  const kept = runs.filter((r) => r.length >= Math.max(2, med * 0.5));
  if (!kept.length) return null;
  const keep = new Set(kept.flat().map((b) => b.id));
  if (keep.size === ann.blocks.length) return null; // nothing trimmed — not a new option
  const best = { rows: kept.length, cols: Math.max(...kept.map((r) => r.length)) };
  const chosen = ann.blocks.filter((b) => keep.has(b.id)).sort((a, b) => a.inv - b.inv);
  const remap = new Map();
  chosen.forEach((b, i) => remap.set(b.id, { inv: i, tx: Math.floor(i / Math.max(1, invertersPerTx)) }));
  return {
    vertical, laneMid: ann.laneMid,
    blocks: chosen.map((b) => ({ ...b, ...remap.get(b.id) })),
    frames: ann.frames.filter((f) => remap.has(f.block)).map((f) => ({ ...f, ...remap.get(f.block) })),
    rect: { cols: best.cols, rows: best.rows },
  };
}

/* ---------------- capacity target selection ----------------
   When a target is set (inverters / modules / DC), the generator
   still places the full candidate block set, then selects the most
   compact subset meeting the target: grown from seed blocks (nearest
   substation, site centre, medoid) with a cost metric that prefers
   staying within a corridor over jumping corridors, and full blocks
   over narrow ones. Candidates scored by achieved modules first,
   then AC extent.                                                   */
function applyCapacityTarget(ann, cap, modsPerFrame, stagger, ss, invertersPerTx) {
  if (!cap || cap.kind === "none" || !ann.blocks.length) return { ...ann, capInfo: null };
  const blocks = ann.blocks;
  const blockMods = (b) => b.nFrames * modsPerFrame;
  let budgetBlocks = Infinity, budgetMods = Infinity;
  if (cap.kind === "inverters") budgetBlocks = Math.max(1, Math.round(cap.value));
  else budgetMods = Math.max(1, Math.round(cap.value)); // 'modules' (dc pre-converted)

  const totalMods = blocks.reduce((s, b) => s + blockMods(b), 0);
  const reachable =
    cap.kind === "inverters" ? blocks.length >= budgetBlocks : totalMods >= budgetMods;
  if (!reachable) {
    return {
      ...ann,
      capInfo: {
        short: true, achievedMods: totalMods, achievedBlocks: blocks.length,
        targetMods: budgetMods === Infinity ? null : budgetMods,
        targetBlocks: budgetBlocks === Infinity ? null : budgetBlocks,
      },
    };
  }

  const cX = (b) => b.x + b.w / 2, cY = (b) => b.y + b.h / 2;
  const along = (b) => (ann.vertical ? cX(b) : cY(b));
  const corr = (b) => (ann.vertical ? cY(b) : cX(b));
  const PEN = 40; // metres-equivalent nudge to prefer full blocks
  const cost = (b, s) =>
    Math.abs(along(b) - along(s)) + 2.2 * Math.abs(corr(b) - corr(s)) +
    (b.full ? 0 : PEN) + (b.pen || 0) * 250; // steep blocks chosen last

  // seeds: geometric (substation, centroid, medoid) AND terrain-led, so a
  // cluster can form over the flattest ground rather than the middle of the site
  const seeds = [];
  const nearest = (px, py) => blocks.reduce((m, b) =>
    Math.hypot(cX(b) - px, cY(b) - py) < Math.hypot(cX(m) - px, cY(m) - py) ? b : m);
  if (ss) seeds.push(nearest(ss.x, ss.y));
  const gx = blocks.reduce((s, b) => s + cX(b), 0) / blocks.length;
  const gy = blocks.reduce((s, b) => s + cY(b), 0) / blocks.length;
  seeds.push(nearest(gx, gy));
  let medoid = blocks[0], medoidSum = Infinity;
  for (const a of blocks) {
    let s = 0;
    for (const b of blocks) s += Math.hypot(cX(a) - cX(b), cY(a) - cY(b));
    if (s < medoidSum) { medoidSum = s; medoid = a; }
  }
  seeds.push(medoid);
  // with a manageable block count, try growing from every block — this finds
  // the genuinely best contiguous cluster instead of guessing where to start
  if (blocks.length <= 140) {
    for (const b of blocks) seeds.push(b);
  } else if (blocks.some((b) => (b.pen || 0) > 0)) {
    // flattest single block, and the centre of the flattest quarter of the site
    seeds.push(blocks.reduce((m, b) => ((b.pen || 0) < (m.pen || 0) ? b : m)));
    const flat = [...blocks].sort((a, b) => (a.pen || 0) - (b.pen || 0))
      .slice(0, Math.max(1, Math.round(blocks.length / 4)));
    const fx = flat.reduce((s, b) => s + cX(b), 0) / flat.length;
    const fy = flat.reduce((s, b) => s + cY(b), 0) / flat.length;
    seeds.push(nearest(fx, fy));
  }
  const seedSet = new Set();
  const uniqSeeds = seeds.filter((b) => (seedSet.has(b.id) ? false : seedSet.add(b.id)));
  seeds.length = 0; seeds.push(...uniqSeeds);

  // adjacency: two blocks touch if their footprints are within a corridor of
  // each other. Growing only into neighbours keeps the build in one piece.
  const REACH = 1.6;
  const near = (a, b) => {
    const mx = REACH * Math.max(a.w, b.w) * 0.5 + 6;
    const my = REACH * Math.max(a.h, b.h) * 0.5 + 6;
    return Math.abs(cX(a) - cX(b)) <= (a.w + b.w) / 2 + mx &&
           Math.abs(cY(a) - cY(b)) <= (a.h + b.h) / 2 + my;
  };
  const adj = new Map(blocks.map((b) => [b.id, []]));
  for (let i = 0; i < blocks.length; i++) {
    for (let j = i + 1; j < blocks.length; j++) {
      if (near(blocks[i], blocks[j])) {
        adj.get(blocks[i].id).push(blocks[j]);
        adj.get(blocks[j].id).push(blocks[i]);
      }
    }
  }

  let best = null;
  for (const seed of seeds) {
    const sel = [seed];
    const used = new Set([seed.id]);
    let mods = blockMods(seed);
    let bx1 = seed.x, by1 = seed.y, bx2 = seed.x + seed.w, by2 = seed.y + seed.h;
    const unit = Math.max(1, seed.w * seed.h);
    const room = () => (cap.kind === "inverters"
      ? sel.length < budgetBlocks
      : mods < budgetMods);
    while (room()) {
      // candidates: unused blocks touching the cluster (compact by construction)
      let pick = null, pickCost = Infinity;
      for (const b of sel) {
        for (const n of adj.get(b.id)) {
          if (used.has(n.id)) continue;
          if (cap.kind !== "inverters" && mods + blockMods(n) > budgetMods) continue;
          // pick the neighbour that expands the footprint least — that is what
          // makes the result read as one rectangular block of plant — then
          // prefer flat ground and full-width blocks
          const nx1 = Math.min(bx1, n.x), ny1 = Math.min(by1, n.y);
          const nx2 = Math.max(bx2, n.x + n.w), ny2 = Math.max(by2, n.y + n.h);
          const grow = ((nx2 - nx1) * (ny2 - ny1) - (bx2 - bx1) * (by2 - by1)) / unit;
          const c = grow + (n.pen || 0) * 3 + (n.full ? 0 : 0.6);
          if (c < pickCost) { pickCost = c; pick = n; }
        }
      }
      if (!pick) {
        // nothing adjacent left — only then jump, and only if the target demands it
        let jump = null, jc = Infinity;
        for (const b of blocks) {
          if (used.has(b.id)) continue;
          if (cap.kind !== "inverters" && mods + blockMods(b) > budgetMods) continue;
          const c = Math.hypot(cX(b) - (bx1 + bx2) / 2, cY(b) - (by1 + by2) / 2) +
                    (b.pen || 0) * 400 + 5000;
          if (c < jc) { jc = c; jump = b; }
        }
        if (!jump) break;
        pick = jump;
      }
      sel.push(pick); used.add(pick.id); mods += blockMods(pick);
      bx1 = Math.min(bx1, pick.x); by1 = Math.min(by1, pick.y);
      bx2 = Math.max(bx2, pick.x + pick.w); by2 = Math.max(by2, pick.y + pick.h);
    }
    if (!sel.length) continue;
    const acT = buildAc(sel, ss, ann.vertical, stagger, ann.laneMid || 0).total ?? 0;
    const penT = sel.reduce((s, b) => s + (b.pen || 0), 0) / sel.length;
    const sbb = bboxOf(sel.flatMap((b) => [{ x: b.x, y: b.y }, { x: b.x + b.w, y: b.y + b.h }]));
    const hull = Math.max(1, (sbb.maxX - sbb.minX) * (sbb.maxY - sbb.minY));
    const compact = sel.reduce((s, b) => s + b.w * b.h, 0) / hull;
    const cand = { sel, mods, ac: acT, pen: penT, compact, q: 0 };
    cand.q = compact - 1.5 * penT - acT / 2e5;
    if (!best) { best = cand; continue; }
    // clearly more capacity wins; otherwise take the flatter cluster,
    // and only then the shorter cable run
    // one objective: grouped and on good ground, cable length as the decider
    cand.q = compact - 1.5 * penT - acT / 2e5;
    if (mods > best.mods * 1.02) best = cand;
    else if (mods >= best.mods * 0.98 && cand.q > best.q) best = cand;
  }
  if (!best) return { ...ann, capInfo: null };

  const chosen = [...best.sel].sort((a, b) => a.inv - b.inv); // keep snake order
  const remap = new Map();
  chosen.forEach((b, i) => {
    remap.set(b.id, { inv: i, tx: Math.floor(i / Math.max(1, invertersPerTx)) });
  });
  const blocks2 = chosen.map((b) => ({ ...b, ...remap.get(b.id) }));
  const frames2 = ann.frames
    .filter((f) => remap.has(f.block))
    .map((f) => ({ ...f, ...remap.get(f.block) }));
  return {
    frames: frames2, blocks: blocks2, vertical: ann.vertical, laneMid: ann.laneMid,
    capInfo: {
      short: false, achievedMods: best.mods, achievedBlocks: blocks2.length,
      targetMods: budgetMods === Infinity ? null : budgetMods,
      targetBlocks: budgetBlocks === Infinity ? null : budgetBlocks,
    },
  };
}

/* ---------------- terrain & slope ----------------
   Terrain arrives as scattered x,y,z points (CSV/XYZ paste or DXF
   POINT/3DFACE entities exported from Civil 3D / PVcase — DWG must be
   saved as DXF first). Points are binned to a regular grid, gaps
   filled by neighbourhood averaging, and a slope raster derived by
   central differences. Placement then resolves the gradient under
   each frame into ALONG-axis and CROSS-axis components with separate
   hard limits (reject) and soft limits (graded penalty).            */
function parseXyzText(text) {
  const pts = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /[a-df-wyz]/i.test(line.split(/[,;\s\t]+/)[0])) continue;
    const m = line.split(/[,;\s\t]+/).map(Number);
    if (m.length >= 3 && m.slice(0, 3).every((n) => Number.isFinite(n))) {
      pts.push({ x: m[0], y: m[1], z: m[2] });
    }
  }
  return pts;
}

/** Minimal ASCII DXF reader: closed LWPOLYLINEs (boundary candidates)
    plus POINT and 3DFACE entities (terrain). */
function parseDxf(text) {
  const lines = text.split(/\r?\n/);
  const polylines = [], points = [];
  let i = 0;
  const next = () => [lines[i++]?.trim(), lines[i++]?.trim()];
  while (i < lines.length - 1) {
    const [code, val] = next();
    if (code !== "0") continue;
    if (val === "LWPOLYLINE") {
      const pts = []; let closed = false, cx = null, layer = "", elev = 0;
      while (i < lines.length - 1) {
        const [c, v] = next();
        if (c === "0") { i -= 2; break; }
        if (c === "8") layer = v;
        if (c === "38") elev = Number(v);
        if (c === "70") closed = (Number(v) & 1) === 1;
        if (c === "10") cx = Number(v);
        if (c === "20" && cx !== null) { pts.push({ x: cx, y: Number(v) }); cx = null; }
      }
      if (pts.length >= 3) polylines.push({ pts, closed, layer, elev });
      // a polyline carrying an elevation is a contour — usable as terrain
      if (elev !== 0) for (const p of pts) points.push({ x: p.x, y: p.y, z: elev, layer });
    } else if (val === "POLYLINE") {
      // old-style polyline: vertices follow as separate entities
      let layer = "";
      while (i < lines.length - 1) {
        const [c, v] = next();
        if (c === "0") { i -= 2; break; }
        if (c === "8") layer = v;
      }
      const pts = [];
      while (i < lines.length - 1) {
        const [c, v] = next();
        if (c !== "0") continue;
        if (v === "VERTEX") {
          let x = 0, y = 0, z = 0;
          while (i < lines.length - 1) {
            const [c2, v2] = next();
            if (c2 === "0") { i -= 2; break; }
            if (c2 === "10") x = Number(v2);
            if (c2 === "20") y = Number(v2);
            if (c2 === "30") z = Number(v2);
          }
          pts.push({ x, y, z });
        } else { i -= 2; break; }
      }
      if (pts.length >= 3) polylines.push({ pts, closed: false, layer, elev: 0 });
      if (pts.some((p) => p.z !== 0)) for (const p of pts) points.push({ ...p, layer });
    } else if (val === "POINT") {
      let x = 0, y = 0, z = 0, layer = "";
      while (i < lines.length - 1) {
        const [c, v] = next();
        if (c === "0") { i -= 2; break; }
        if (c === "8") layer = v;
        if (c === "10") x = Number(v);
        if (c === "20") y = Number(v);
        if (c === "30") z = Number(v);
      }
      points.push({ x, y, z, layer });
    } else if (val === "3DFACE") {
      const co = {}; let layer = "";
      while (i < lines.length - 1) {
        const [c, v] = next();
        if (c === "0") { i -= 2; break; }
        if (c === "8") layer = v; else co[c] = Number(v);
      }
      for (const k of [0, 1, 2, 3]) {
        if (co[`1${k}`] !== undefined && co[`2${k}`] !== undefined) {
          points.push({ x: co[`1${k}`], y: co[`2${k}`], z: co[`3${k}`] || 0, layer });
        }
      }
    }
  }
  return { polylines, points };
}

/** Choose the terrain points: prefer a terrain-named layer, drop stray
    outliers (survey markers, origin junk) that would blow up the grid. */
function pickTerrainPoints(points) {
  if (!points.length) return { pts: [], layer: null, dropped: 0 };
  const TERR = /terrain|topo|surface|contour|elev|spot|dem|tin|ground/i;
  const byLayer = new Map();
  for (const p of points) {
    const k = p.layer || "";
    if (!byLayer.has(k)) byLayer.set(k, []);
    byLayer.get(k).push(p);
  }
  let chosen = null, name = null;
  for (const [k, v] of byLayer) {
    if (TERR.test(k) && v.length >= 4 && (!chosen || v.length > chosen.length)) {
      chosen = v; name = k;
    }
  }
  if (!chosen) {
    // else the biggest layer with real elevation variation
    for (const [k, v] of byLayer) {
      const zs = v.map((p) => p.z);
      if (v.length >= 4 && Math.max(...zs) - Math.min(...zs) > 0.5 &&
          (!chosen || v.length > chosen.length)) { chosen = v; name = k; }
    }
  }
  if (!chosen) chosen = points;
  // robust outlier rejection about the 5–95 percentile core
  const before = chosen.length;
  const q = (arr, f) => arr[Math.min(arr.length - 1, Math.max(0, Math.floor(arr.length * f)))];
  const xs = chosen.map((p) => p.x).sort((a, b) => a - b);
  const ys = chosen.map((p) => p.y).sort((a, b) => a - b);
  const x1 = q(xs, 0.05), x2 = q(xs, 0.95), y1 = q(ys, 0.05), y2 = q(ys, 0.95);
  const mx = Math.max(50, (x2 - x1) * 1.5), my = Math.max(50, (y2 - y1) * 1.5);
  const pts = chosen.filter((p) =>
    p.x >= x1 - mx && p.x <= x2 + mx && p.y >= y1 - my && p.y <= y2 + my);
  return { pts: pts.length >= 4 ? pts : chosen, layer: name, dropped: before - pts.length };
}

function buildTerrain(pts) {
  if (!pts || pts.length < 4) return null;
  const bb = bboxOf(pts);
  const area = Math.max(1, (bb.maxX - bb.minX) * (bb.maxY - bb.minY));
  let cell = Math.min(60, Math.max(2, Math.sqrt(area / pts.length) * 1.4));
  // widen the cell until the grid is a sane size rather than giving up
  const MAXCELLS = 250000;
  for (let guard = 0; guard < 40; guard++) {
    const tx = Math.ceil((bb.maxX - bb.minX) / cell) + 1;
    const ty = Math.ceil((bb.maxY - bb.minY) / cell) + 1;
    if (tx * ty <= MAXCELLS) break;
    cell *= 1.6;
  }
  const nx = Math.max(2, Math.ceil((bb.maxX - bb.minX) / cell) + 1);
  const ny = Math.max(2, Math.ceil((bb.maxY - bb.minY) / cell) + 1);
  if (nx * ny > MAXCELLS * 2) return null;
  const sum = new Float64Array(nx * ny), cnt = new Float64Array(nx * ny);
  for (const p of pts) {
    const ix = Math.min(nx - 1, Math.max(0, Math.round((p.x - bb.minX) / cell)));
    const iy = Math.min(ny - 1, Math.max(0, Math.round((p.y - bb.minY) / cell)));
    sum[iy * nx + ix] += p.z; cnt[iy * nx + ix]++;
  }
  const z = new Float64Array(nx * ny);
  const has = new Uint8Array(nx * ny);
  for (let k = 0; k < nx * ny; k++) if (cnt[k]) { z[k] = sum[k] / cnt[k]; has[k] = 1; }
  // fill gaps by repeated neighbourhood averaging
  for (let pass = 0; pass < 40; pass++) {
    let missing = 0;
    const nz = z.slice(), nh = has.slice();
    for (let iy = 0; iy < ny; iy++) for (let ix = 0; ix < nx; ix++) {
      const k = iy * nx + ix;
      if (has[k]) continue;
      let s = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const jx = ix + dx, jy = iy + dy;
        if (jx < 0 || jy < 0 || jx >= nx || jy >= ny) continue;
        const j = jy * nx + jx;
        if (has[j]) { s += z[j]; n++; }
      }
      if (n >= 2) { nz[k] = s / n; nh[k] = 1; } else missing++;
    }
    z.set(nz); has.set(nh);
    if (!missing) break;
  }
  let zmin = Infinity, zmax = -Infinity;
  for (let k = 0; k < nx * ny; k++) { if (z[k] < zmin) zmin = z[k]; if (z[k] > zmax) zmax = z[k]; }
  return { x0: bb.minX, y0: bb.minY, cell, nx, ny, z, zmin, zmax, nPts: pts.length };
}

function slopeOf(t) {
  const { nx, ny, z, cell } = t;
  const sx = new Float32Array(nx * ny), sy = new Float32Array(nx * ny);
  for (let iy = 0; iy < ny; iy++) for (let ix = 0; ix < nx; ix++) {
    const k = iy * nx + ix;
    const xl = z[iy * nx + Math.max(0, ix - 1)], xr = z[iy * nx + Math.min(nx - 1, ix + 1)];
    const yl = z[Math.max(0, iy - 1) * nx + ix], yr = z[Math.min(ny - 1, iy + 1) * nx + ix];
    sx[k] = (xr - xl) / (cell * (ix > 0 && ix < nx - 1 ? 2 : 1));
    sy[k] = (yr - yl) / (cell * (iy > 0 && iy < ny - 1 ? 2 : 1));
  }
  return { sx, sy };
}

function slopeAt(t, s, x, y) {
  const ix = Math.min(t.nx - 1, Math.max(0, Math.round((x - t.x0) / t.cell)));
  const iy = Math.min(t.ny - 1, Math.max(0, Math.round((y - t.y0) / t.cell)));
  const k = iy * t.nx + ix;
  return { sx: s.sx[k], sy: s.sy[k] };
}

/** Slope test for one frame rect. Returns {hardFail, pen 0..1}.
    vertical rows: ALONG = N–S (sy), CROSS = E–W (sx); fixed: transposed. */
function frameSlopeCheck(ctx, x, y, w, h, vertical) {
  if (!ctx) return { hardFail: false, pen: 0 };
  const { t, s, lim } = ctx;
  const pts = [];
  for (let i = 0; i <= 4; i++) for (let j = 0; j <= 2; j++) {
    pts.push([x + (w * j) / 2, y + (h * i) / 4]);
  }
  let along = 0, cross = 0;
  for (const [px, py] of pts) {
    const g = slopeAt(t, s, px, py);
    const a = Math.abs(vertical ? g.sy : g.sx) * 100;
    const c = Math.abs(vertical ? g.sx : g.sy) * 100;
    if (a > along) along = a;
    if (c > cross) cross = c;
  }
  if (along > lim.hardAlong || cross > lim.hardCross) return { hardFail: true, pen: 1 };
  const ramp = (v, lo, hi) => (v <= lo ? 0 : hi <= lo ? 1 : Math.min(1, (v - lo) / (hi - lo)));
  const pen = Math.max(
    ramp(along, lim.softAlong, lim.hardAlong),
    ramp(cross, lim.softCross, lim.hardCross)
  );
  // grading tolerance: 0 = refuse anything needing grading, 1 = full limits
  if (lim.maxPen !== undefined && pen > lim.maxPen + 1e-9) return { hardFail: true, pen: 1 };
  return { hardFail: false, pen };
}

function heatmapCells(t, s, maxCells = 3600) {
  const step = Math.max(1, Math.ceil(Math.sqrt((t.nx * t.ny) / maxCells)));
  const out = [];
  for (let iy = 0; iy < t.ny; iy += step) for (let ix = 0; ix < t.nx; ix += step) {
    const k = iy * t.nx + ix;
    const v = Math.max(Math.abs(s.sx[k]), Math.abs(s.sy[k])) * 100;
    out.push({
      x: t.x0 + (ix - 0.5) * t.cell, y: t.y0 + (iy - 0.5) * t.cell,
      w: t.cell * step, h: t.cell * step, v,
    });
  }
  return out;
}

/** Demo surface: rolling hills over a bbox, for testing without an import. */
function demoTerrain(bb) {
  const pts = [];
  for (let x = bb.minX - 20; x <= bb.maxX + 20; x += 12) {
    for (let y = bb.minY - 20; y <= bb.maxY + 20; y += 12) {
      const z =
        11 * Math.sin(x / 160) * Math.cos(y / 190) +
        6 * Math.sin((x + y) / 120) +
        2.5 * Math.cos(x / 70) * Math.sin(y / 90);
      pts.push({ x, y, z });
    }
  }
  return pts;
}

function txOutlines(blocks, vertical) {
  const groups = new Map();
  for (const b of blocks) {
    if (!b.laneCells) return null;
    if (!groups.has(b.tx)) groups.set(b.tx, new Map());
    const g = groups.get(b.tx);
    for (const lc of b.laneCells) {
      const key = Math.round(lc.u * 10);
      const e = g.get(key);
      if (!e) g.set(key, { u: lc.u, w: lc.w, a: lc.a, b: lc.b });
      else { e.a = Math.min(e.a, lc.a); e.b = Math.max(e.b, lc.b); }
    }
  }
  return [...groups.values()].map((g) =>
    blockOutlinePoints([...g.values()].sort((x, y) => x.u - y.u), vertical, 4)
  );
}

/* ---------------- road bands ----------------
   Roads run in the corridors: continuous through staggered sections
   (the whole corridor shears with the same slope) and constant
   PERPENDICULAR width — the along-axis gap is widened by √(1+m²) at
   placement time so the true road width never narrows on a diagonal. */
function buildRoads(blocks, stagger, laneMid, roadW, vertical) {
  if (!(roadW > 0)) return [];
  const m = stagger || 0;
  const halfAxis = (roadW * Math.sqrt(1 + m * m)) / 2;
  const map = new Map();
  for (const b of blocks) {
    if (b.corrId === null || b.corrId === undefined) continue;
    const u1 = vertical ? b.x : b.y;
    const u2 = vertical ? b.x + b.w : b.y + b.h;
    const g = map.get(b.corrId) || { base: b.corrBase, min: u1, max: u2 };
    g.min = Math.min(g.min, u1);
    g.max = Math.max(g.max, u2);
    g.base = b.corrBase;
    map.set(b.corrId, g);
  }
  const out = [];
  for (const g of map.values()) {
    const a = g.min - 4, z = g.max + 4;
    const va = g.base + m * (a - laneMid);
    const vz = g.base + m * (z - laneMid);
    const pts = vertical
      ? [[a, va - halfAxis], [z, vz - halfAxis], [z, vz + halfAxis], [a, va + halfAxis]]
      : [[va - halfAxis, a], [vz - halfAxis, z], [vz + halfAxis, z], [va + halfAxis, a]];
    out.push(pts.map(([x, y]) => `${x},${y}`).join(" "));
  }
  return out;
}

/* ---------------- substations, cable routing and cost ----------------
   Substations are modular single-transformer units of 10, 14 or 20 ways.
   Cables cannot cross module rows, so routing is restricted to a graph of
   the road corridors and the gaps between blocks, clipped to the site.  */
const SS_SIZES = [10, 14, 20];

/** Fewest units first, then fewest spare ways. 26 -> 14+14, 34 -> 20+14. */
function chooseSubstations(nInv, sizes = SS_SIZES) {
  if (nInv <= 0) return { units: 0, spare: 0, combo: [] };
  const big = Math.max(...sizes);
  let best = null;
  for (let units = 1; units <= Math.ceil(nInv / Math.min(...sizes)) + 1; units++) {
    if (units * big < nInv) continue;
    const rec = (i, left, acc, sum) => {
      if (left === 0) {
        if (sum >= nInv) {
          const spare = sum - nInv;
          if (!best || spare < best.spare) best = { units, spare, combo: [...acc].sort((a, b) => b - a) };
        }
        return;
      }
      for (let k = i; k < sizes.length; k++) { acc.push(sizes[k]); rec(k, left - 1, acc, sum + sizes[k]); acc.pop(); }
    };
    rec(0, units, [], 0);
    if (best) break;
  }
  return best || { units: 0, spare: 0, combo: [] };
}

/** Graph of legal cable routes: along corridors, and down the gaps between
    blocks. Never across a block, never outside the boundary. */
function buildCableGraph(blocks, polygon, stagger, laneMid, vertical) {
  const m = stagger || 0;
  const corrMap = new Map();
  for (const b of blocks) {
    if (b.corrId === null || b.corrId === undefined) continue;
    if (!corrMap.has(b.corrId)) corrMap.set(b.corrId, b.corrBase);
  }
  const corridors = [...corrMap.entries()].map(([id, base]) => ({ id, base }))
    .sort((a, b) => a.base - b.base);
  const chanSet = new Set();
  for (const b of blocks) {
    const lo = vertical ? b.x : b.y, hi = vertical ? b.x + b.w : b.y + b.h;
    chanSet.add(Math.round(lo * 100) / 100);
    chanSet.add(Math.round(hi * 100) / 100);
  }
  const channels = [...chanSet].sort((a, b) => a - b);
  if (!corridors.length || channels.length < 2) return null;

  const at = (base, u) => base + m * (u - laneMid);
  const pos = (ci, ui) => {
    const u = channels[ui], v = at(corridors[ci].base, u);
    return vertical ? { x: u, y: v } : { x: v, y: u };
  };
  const nodes = [], index = new Map();
  for (let ci = 0; ci < corridors.length; ci++) {
    for (let ui = 0; ui < channels.length; ui++) {
      const p = pos(ci, ui);
      if (!pointInPolygon(p, polygon)) continue;
      index.set(`${ci}:${ui}`, nodes.length);
      nodes.push({ ...p, ci, ui, adj: [] });
    }
  }
  const link = (a, b) => {
    if (a === undefined || b === undefined) return;
    const p = nodes[a], q = nodes[b];
    const mid = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
    if (!pointInPolygon(mid, polygon)) return;
    const d = Math.hypot(q.x - p.x, q.y - p.y);
    p.adj.push([b, d]); q.adj.push([a, d]);
  };
  for (let ci = 0; ci < corridors.length; ci++) {
    for (let ui = 0; ui + 1 < channels.length; ui++) {
      link(index.get(`${ci}:${ui}`), index.get(`${ci}:${ui + 1}`));
    }
  }
  for (let ui = 0; ui < channels.length; ui++) {
    for (let ci = 0; ci + 1 < corridors.length; ci++) {
      link(index.get(`${ci}:${ui}`), index.get(`${ci + 1}:${ui}`));
    }
  }
  return { nodes, corridors, channels };
}

function nearestNode(graph, p) {
  let best = -1, bd = Infinity;
  for (let i = 0; i < graph.nodes.length; i++) {
    const n = graph.nodes[i];
    const d = Math.hypot(n.x - p.x, n.y - p.y);
    if (d < bd) { bd = d; best = i; }
  }
  return { i: best, d: bd };
}

/** Dijkstra from one source over the route graph. */
function shortestFrom(graph, src) {
  const n = graph.nodes.length;
  const dist = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const seen = new Uint8Array(n);
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

function pathPoints(graph, prev, from) {
  const pts = [];
  let c = from, guard = 0;
  while (c >= 0 && guard++ < 5000) { pts.push({ x: graph.nodes[c].x, y: graph.nodes[c].y }); c = prev[c]; }
  return pts;
}

/** Assign inverter blocks to modular substations, place each on the route
    graph near its group, and route LV to it and MV on to the grid point. */
function planCabling(blocks, polygon, stagger, laneMid, vertical, poi, overrides) {
  const empty = { subs: [], lv: 0, mv: 0, paths: [], mvPaths: [], graph: null, combo: [] };
  if (!blocks.length || polygon.length < 3) return empty;
  const graph = buildCableGraph(blocks, polygon, stagger, laneMid, vertical);
  if (!graph || graph.nodes.length < 2) return empty;

  const plan = chooseSubstations(blocks.length);
  const ordered = [...blocks].sort((a, b) => a.inv - b.inv);   // already a snake walk
  const subs = [];
  let k = 0;
  plan.combo.forEach((ways, gi) => {
    const take = Math.min(ways, ordered.length - k);
    if (take <= 0) return;
    const group = ordered.slice(k, k + take);
    k += take;
    const cxs = group.reduce((s, b) => s + b.mx, 0) / group.length;
    const cys = group.reduce((s, b) => s + b.my, 0) / group.length;
    const ov = overrides && overrides[gi];
    const seed = ov ? ov : { x: cxs, y: cys };
    const nn = nearestNode(graph, seed);
    subs.push({
      ways, used: take, spare: ways - take, group,
      node: nn.i, x: graph.nodes[nn.i].x, y: graph.nodes[nn.i].y,
    });
  });

  // candidate inverter positions: the corridors immediately either side of a
  // block. DC run down the frames is the same either way, so put the inverter
  // on whichever side gives the shorter cable back to its substation.
  const m2 = stagger || 0;
  const corridorAt = (base, u) => base + m2 * (u - laneMid);
  const candidatesFor = (b) => {
    const u = vertical ? b.mx : b.my;
    const centre = vertical ? b.y + b.h / 2 : b.x + b.w / 2;
    const depth = vertical ? b.h : b.w;
    const opts = graph.corridors
      .map((c) => ({ v: corridorAt(c.base, u), id: c.id }))
      .filter((c) => Math.abs(c.v - centre) < depth * 0.9 + 30);
    const pts = opts.map((c) => (vertical ? { x: u, y: c.v } : { x: c.v, y: u }));
    const here = { x: b.mx, y: b.my };
    if (!pts.some((p) => Math.hypot(p.x - here.x, p.y - here.y) < 1)) pts.push(here);
    return pts;
  };

  let lv = 0;
  const paths = [];
  const markers = [];
  for (const s of subs) {
    const { dist, prev } = shortestFrom(graph, s.node);
    for (const b of s.group) {
      let best = null;
      for (const p of candidatesFor(b)) {
        const nn = nearestNode(graph, p);
        const d = dist[nn.i];
        if (!Number.isFinite(d)) continue;
        const total = d + nn.d;
        if (!best || total < best.total) best = { total, p, nn };
      }
      if (!best) continue;
      lv += best.total;
      markers.push({ inv: b.inv, x: best.p.x, y: best.p.y });
      paths.push([best.p, ...pathPoints(graph, prev, best.nn.i)]);
    }
  }

  let mv = 0;
  const mvPaths = [];
  if (poi && subs.length) {
    const pn = nearestNode(graph, poi);
    const { dist, prev } = shortestFrom(graph, pn.i);
    for (const s of subs) {
      const d = dist[s.node];
      if (!Number.isFinite(d)) continue;
      mv += d + pn.d;
      mvPaths.push([{ x: s.x, y: s.y }, ...pathPoints(graph, prev, s.node), poi]);
    }
  }
  return { subs, lv, mv, paths, mvPaths, markers, graph, combo: plan.combo, spare: plan.spare };
}

/* ---------------- formatting ---------------- */
const fmt = (v, dp = 2) =>
  Number(v).toLocaleString("en-GB", { maximumFractionDigits: dp, minimumFractionDigits: 0 });
const fmtDim = (v) => {
  const s = Number(v).toFixed(3);
  return s.replace(/\.?0+$/, "");
};
const fmtKm = (m) => (m >= 2000 ? `${fmt(m / 1000, 2)} km` : `${fmt(m, 0)} m`);
/** Area in m² up to 1 km², then km² — no hectares. */
const fmtArea = (m2) =>
  m2 >= 1e6 ? `${fmt(m2 / 1e6, 3)} km²` : `${fmt(m2, 0)} m²`;
const areaUnit = (m2) => (m2 >= 1e6 ? "km²" : "m²");
const areaVal = (m2) => (m2 >= 1e6 ? fmt(m2 / 1e6, 3) : fmt(m2, 0));

/* ---------------- example boundary ---------------- */
const EXAMPLE_BOUNDARY = [
  { x: 195, y: 10 }, { x: 415, y: 55 }, { x: 470, y: 110 }, { x: 445, y: 235 },
  { x: 480, y: 330 }, { x: 445, y: 470 }, { x: 330, y: 555 }, { x: 205, y: 540 },
  { x: 75, y: 465 }, { x: 40, y: 340 }, { x: 110, y: 290 }, { x: 60, y: 215 },
  { x: 105, y: 115 },
];

/* ---------------- palette ---------------- */
const C = {
  chrome: "#14171c", panel: "#1c2128", panel2: "#22272f", line: "#2c333d",
  text: "#dde3ea", muted: "#8b95a3", accent: "#e8820c",
  paper: "#1b1e24", grid: "#22262e", gridMajor: "#2c313b",
  boundary: "#e8820c", frame: "#8b95a3", moduleRed: "#d4564f",
  inverter: "#3fb457", transformer: "#3d95ea", ac: "#d8dade", warn: "#e0a63a",
  navy: "#31435f", navyLight: "#9fb4d8", steel: "#7d838c", soil: "#33362e", soilLine: "#5d6355",
};

/* ---------------- small UI atoms ---------------- */
function Num({ label, unit, value, onChange, step = 0.01, min, max, width }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => {
    if (draft === "" || Number(draft) !== value) setDraft(String(value));
    // eslint-disable-next-line
  }, [value]);
  return (
    <label className="fld" style={width ? { width } : undefined}>
      <span className="fld-l">{label}</span>
      <span className="fld-box">
        <input
          type="number" value={draft} step={step} min={min} max={max}
          onChange={(e) => {
            const s = e.target.value;
            setDraft(s);
            const v = Number(s);
            if (s !== "" && !Number.isNaN(v)) onChange(v);
          }}
          onBlur={() => { if (draft === "" || Number.isNaN(Number(draft))) setDraft(String(value)); }}
        />
        {unit ? <span className="fld-u">{unit}</span> : null}
      </span>
    </label>
  );
}

function Sel({ label, value, onChange, options, width }) {
  return (
    <label className="fld" style={width ? { width } : undefined}>
      <span className="fld-l">{label}</span>
      <span className="fld-box">
        <select value={value} onChange={(e) => onChange(e.target.value)}>
          {options.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </span>
    </label>
  );
}

function Section({ code, title, children }) {
  return (
    <details open className="sec">
      <summary>
        <span className="sec-code">{code}</span>
        <span className="sec-title">{title}</span>
        <span className="sec-caret">▾</span>
      </summary>
      <div className="sec-body">{children}</div>
    </details>
  );
}

function WarnList({ items }) {
  if (!items.length) return null;
  return (
    <div className="warns">
      {items.map((w, i) => (
        <div key={i} className="warn">⚠ {w}</div>
      ))}
    </div>
  );
}

/* =====================================================================
   Frame drawing — datasheet style: SECTION (post, tilted module, arc)
   above an ELEVATION (face view with modules, posts, motor, ground,
   dimension callouts). Modelled on typical tracker supplier drawings.
   ===================================================================== */
function FrameDiagram({ geo, stringsPerFrame }) {
  const W = 318, H = 288;
  const isFixed = geo.mounting === "fixed";
  const isEw = geo.mounting === "ew";
  const theta = rad(isFixed || isEw ? geo.tilt : geo.maxRot);
  const clr = Math.max(0, geo.clearance);

  const MONO = "9px ui-monospace, Menlo, Consolas, monospace";
  const MONOB = "600 9px ui-monospace, Menlo, Consolas, monospace";
  const INK = "#ccd4de";

  /* ---------- SECTION ---------- */
  const secGroundY = 108;
  const pivotHm = clr + (geo.acrossW / 2) * Math.sin(theta);
  const scaleS = Math.min(30, 62 / Math.max(0.4, pivotHm));
  const cx = 96;
  const pivotY = secGroundY - pivotHm * scaleS;
  const half = (geo.acrossW / 2) * scaleS;
  const bx1 = cx - half * Math.cos(theta), by1 = pivotY + half * Math.sin(theta);
  const bx2 = cx + half * Math.cos(theta), by2 = pivotY - half * Math.sin(theta);

  /* ---------- ELEVATION ---------- */
  const elvGroundY = 240;
  const scaleV = Math.min(20, 56 / Math.max(0.4, geo.acrossW));
  const clrPx = Math.max(4, Math.min(28, clr * scaleV));
  const bottomY = elvGroundY - clrPx;
  const stackPx = geo.acrossW * scaleV;
  const topY = bottomY - stackPx;
  const modPx = geo.dAcross * scaleV;
  const xGapPx = geo.crossGap * scaleV;

  const showAll = geo.alongCount <= 7;
  const runs = [];
  if (showAll) {
    const run = [{ k: "oh" }];
    const mid = Math.floor(geo.alongCount / 2);
    for (let i = 0; i < geo.alongCount; i++) {
      run.push({ k: "mod" });
      if (i === mid - 1 && geo.centreGap > 0) run.push({ k: "cgap" });
      else if (i < geo.alongCount - 1) run.push({ k: "gap" });
    }
    run.push({ k: "oh" });
    runs.push(run);
  } else {
    runs.push([{ k: "oh" }, { k: "mod" }, { k: "gap" }, { k: "mod" }, { k: "gap" }, { k: "mod" }]);
    if (geo.centreGap > 0) runs.push([{ k: "stub" }, { k: "cgap" }, { k: "stub" }]);
    runs.push([{ k: "mod" }, { k: "gap" }, { k: "mod" }, { k: "gap" }, { k: "mod" }, { k: "oh" }]);
  }
  const tokW = (t) =>
    t.k === "mod" ? geo.dAlong :
    t.k === "stub" ? geo.dAlong * 0.5 :
    t.k === "gap" ? Math.max(geo.gapAlong, 0.006) :
    t.k === "cgap" ? Math.max(geo.centreGap, 0.02) :
    Math.max(geo.endOverhang, 0.02);

  const BPX = 14, padL = 18, padR = 50;
  const totalM = runs.reduce((s, r) => s + r.reduce((a, t) => a + tokW(t), 0), 0);
  const breaks = runs.length - 1;
  const scaleH = totalM > 0 ? (W - padL - padR - breaks * BPX) / totalM : 1;

  const mods = [], posts = [], tubes = [], breakGl = [], motor = [];
  let firstMod = null, firstGap = null, firstOh = null;
  let x = padL;
  runs.forEach((run, ri) => {
    const runStart = x;
    const modCentres = [];
    run.forEach((t) => {
      const wPx = tokW(t) * scaleH;
      if (t.k === "mod" || t.k === "stub") {
        for (let p = 0; p < geo.nP; p++) {
          const yy = topY + p * (modPx + xGapPx);
          mods.push(
            <rect key={`m${mods.length}`} x={x} y={yy} width={wPx} height={modPx}
              fill={C.navy} stroke={C.navyLight} strokeWidth="0.8"
              strokeDasharray={t.k === "stub" ? "3 2" : undefined}
              opacity={t.k === "stub" ? 0.75 : 1} />
          );
        }
        if (t.k === "mod") {
          modCentres.push(x + wPx / 2);
          if (!firstMod) firstMod = { x, w: wPx };
        }
      } else if (t.k === "gap" && !firstGap) {
        firstGap = { x, w: wPx };
      } else if (t.k === "oh" && !firstOh) {
        firstOh = { x, w: wPx };
      } else if (t.k === "cgap") {
        motor.push(
          <g key="motor">
            <rect x={x + wPx / 2 - 5} y={(topY + bottomY) / 2 - 6} width="10" height="12"
              fill="#4a4f57" rx="1" />
            <rect x={x + wPx / 2 - 2.5} y={bottomY} width="5" height={elvGroundY - bottomY}
              fill={C.steel} />
          </g>
        );
      }
      x += wPx;
    });
    // tube visible behind modules (overhangs, gaps)
    tubes.push(
      <line key={`tb${ri}`} x1={runStart} x2={x} y1={(topY + bottomY) / 2} y2={(topY + bottomY) / 2}
        stroke="#6b7280" strokeWidth="2.5" />
    );
    // a post under the middle module of each end run
    if (modCentres.length) {
      const pc = modCentres[Math.min(1, modCentres.length - 1)];
      posts.push(
        <rect key={`p${ri}`} x={pc - 2} y={bottomY} width="4" height={elvGroundY - bottomY}
          fill={C.steel} />
      );
    }
    if (ri < runs.length - 1) {
      const bxc = x + BPX / 2;
      breakGl.push(
        <g key={`br${ri}`} stroke="#9aa0aa" strokeWidth="1" fill="none">
          <path d={`M ${bxc - 3} ${topY - 8} l -3 ${(elvGroundY - topY) / 2 + 8} l 6 8 l -3 ${(elvGroundY - topY) / 2 + 8}`} />
          <path d={`M ${bxc + 3} ${topY - 8} l -3 ${(elvGroundY - topY) / 2 + 8} l 6 8 l -3 ${(elvGroundY - topY) / 2 + 8}`} />
        </g>
      );
      x += BPX;
    }
  });
  const elvRight = x;

  /* ---------- dimension primitives ---------- */
  const DimH = ({ x1, x2, y, label, below = false }) => (
    <g stroke={INK} strokeWidth="0.9" fill="none">
      <line x1={x1} x2={x2} y1={y} y2={y} />
      <path d={`M ${x1} ${y} l 4 -2.4 M ${x1} ${y} l 4 2.4`} />
      <path d={`M ${x2} ${y} l -4 -2.4 M ${x2} ${y} l -4 2.4`} />
      <text x={(x1 + x2) / 2} y={below ? y + 10 : y - 3.5} textAnchor="middle"
        stroke="none" fill={INK} style={{ font: MONO }}>{label}</text>
    </g>
  );
  const DimV = ({ y1, y2, x: dx, label }) => {
    const small = Math.abs(y2 - y1) < 16;
    return (
      <g stroke={INK} strokeWidth="0.9" fill="none">
        <line x1={dx} x2={dx} y1={y1} y2={y2} />
        <line x1={dx - 3} x2={dx + 3} y1={y1} y2={y1} />
        <line x1={dx - 3} x2={dx + 3} y1={y2} y2={y2} />
        {!small && <path d={`M ${dx} ${y1} l -2.4 4 M ${dx} ${y1} l 2.4 4`} />}
        {!small && <path d={`M ${dx} ${y2} l -2.4 -4 M ${dx} ${y2} l 2.4 -4`} />}
        <text x={dx + 5} y={(y1 + y2) / 2 + 3} stroke="none" fill={INK}
          style={{ font: MONO }}>{label}</text>
      </g>
    );
  };
  const Lead = ({ fx, fy, tx, ty, label }) => (
    <g>
      <line x1={fx} y1={fy} x2={tx} y2={ty} stroke={INK} strokeWidth="0.9" />
      <circle cx={fx} cy={fy} r="1.4" fill={INK} />
      <text x={tx + 3} y={ty + 3} fill={INK} style={{ font: MONO }}>{label}</text>
    </g>
  );

  const header = `${geo.nP}P · ${geo.modules} MODULES · ${
    Number.isInteger(stringsPerFrame) ? stringsPerFrame : fmt(stringsPerFrame, 2)
  } STRINGS · ${isFixed ? `FIXED TILT ${fmtDim(geo.tilt)}°` : isEw ? `E–W DUO ${fmtDim(geo.tilt)}°` : "SINGLE-AXIS TRACKER"}`;

  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`}
      style={{ display: "block", background: C.paper, borderRadius: 4 }}>
      <text x={padL} y={16} fill="#8f98a5" style={{ font: MONOB, letterSpacing: "0.08em" }}>
        {header}
      </text>

      {/* ---------- SECTION ---------- */}
      <text x={padL} y={34} fill="#8f98a5" style={{ font: MONOB, letterSpacing: "0.08em" }}>
        SECTION
      </text>
      <rect x={padL} y={secGroundY} width={200} height={7} fill={C.soil} />
      <line x1={padL} x2={padL + 200} y1={secGroundY} y2={secGroundY}
        stroke={C.soilLine} strokeWidth="1.2" />
      <rect x={cx - 2.5} y={pivotY} width="5" height={secGroundY - pivotY} fill={C.steel} />
      {isEw ? (
        <g>
          <line x1={cx} y1={pivotY} x2={cx - half * Math.cos(theta)} y2={pivotY + half * Math.sin(theta)}
            stroke={C.navy} strokeWidth="5" />
          <line x1={cx} y1={pivotY} x2={cx + half * Math.cos(theta)} y2={pivotY + half * Math.sin(theta)}
            stroke={C.navy} strokeWidth="5" />
          <text x={cx - half * Math.cos(theta) - 4} y={pivotY + half * Math.sin(theta) + 12}
            fill={INK} style={{ font: MONO }} textAnchor="middle">E</text>
          <text x={cx + half * Math.cos(theta) + 4} y={pivotY + half * Math.sin(theta) + 12}
            fill={INK} style={{ font: MONO }} textAnchor="middle">W</text>
        </g>
      ) : (
        <line x1={bx1} y1={by1} x2={bx2} y2={by2} stroke={C.navy} strokeWidth="5" />
      )}
      <circle cx={cx} cy={pivotY} r="3" fill="#3b4048" />
      <path d={`M ${cx + 24} ${pivotY} A 24 24 0 0 0 ${cx + 24 * Math.cos(theta)} ${pivotY - 24 * Math.sin(theta)}`}
        fill="none" stroke={INK} strokeWidth="0.9" />
      <line x1={cx} x2={cx + 30} y1={pivotY} y2={pivotY} stroke={INK}
        strokeWidth="0.7" strokeDasharray="3 2" />
      <text x={cx + 30} y={pivotY - 10} fill={INK} style={{ font: MONO }}>
        {isFixed || isEw ? `${fmtDim(geo.tilt)}° tilt${isEw ? " E/W" : ""}` : `max ±${fmtDim(geo.maxRot)}°`}
      </text>
      <DimV y1={pivotY} y2={secGroundY} x={cx + half + 26}
        label={`${fmt(pivotHm, 2)} m axis`} />
      <DimV y1={Math.min(by1, by2) + (theta > 0 ? 2 * half * Math.sin(theta) : 0)}
        y2={secGroundY} x={Math.min(bx1, bx2) - 10}
        label={`${fmtDim(clr)} m`} />

      {/* ---------- ELEVATION ---------- */}
      <text x={padL} y={136} fill="#8f98a5" style={{ font: MONOB, letterSpacing: "0.08em" }}>
        ELEVATION
      </text>
      <rect x={padL - 4} y={elvGroundY} width={elvRight - padL + 8} height={7} fill={C.soil} />
      <line x1={padL - 4} x2={elvRight + 4} y1={elvGroundY} y2={elvGroundY}
        stroke={C.soilLine} strokeWidth="1.2" />
      {tubes}
      {posts}
      {motor}
      {mods}
      {breakGl}

      {firstMod && (
        <DimH x1={firstMod.x} x2={firstMod.x + firstMod.w} y={topY - 8}
          label={`${fmtDim(geo.dAlong)} m`} />
      )}
      {firstGap && (
        <Lead fx={firstGap.x + firstGap.w / 2} fy={topY + 3}
          tx={firstGap.x + firstGap.w / 2 + 16} ty={topY - 19}
          label={`gap ${Math.round(geo.gapAlong * 1000)} mm`} />
      )}
      {firstOh && (
        <Lead fx={firstOh.x + firstOh.w / 2} fy={(topY + bottomY) / 2}
          tx={firstOh.x + 8} ty={topY - 30}
          label={`o/h ${Math.round(geo.endOverhang * 1000)} mm`} />
      )}
      <DimH x1={padL} x2={elvRight} y={elvGroundY + 20}
        label={`${fmtDim(geo.alongLen)} m overall`} below />
      <DimV y1={topY} y2={bottomY} x={elvRight + 10} label={`${fmtDim(geo.acrossW)} m`} />
      <DimV y1={bottomY} y2={elvGroundY} x={padL + 6} label={`${fmtDim(clr)} m`} />
    </svg>
  );
}

/* =====================================================================
   Site canvas
   ===================================================================== */
function RowSpacing({ geo, pitch }) {
  const W=320,H=104,scale=Math.min(46,220/Math.max(1,pitch));
  const w=geo.planAcross*scale, p=pitch*scale, x0=(W-p-w)/2, gY=70;
  const gap=Math.max(0,pitch-geo.planAcross)*scale;
  return (<svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{background:C.paper,borderRadius:4}}>
    <line x1={x0-16} x2={x0+p+w+16} y1={gY} y2={gY} stroke={C.soilLine} strokeWidth="1.5"/>
    {[0,1].map(i=>(<rect key={i} x={x0+i*p} y={gY-14} width={w} height={12} fill={C.navy} stroke="#9fb4d8" strokeWidth="0.8"/>))}
    <g stroke="#374151" strokeWidth="1" fill="none">
      <line x1={x0+w/2} x2={x0+p+w/2} y1={gY-30} y2={gY-30}/>
      <path d={`M ${x0+w/2} ${gY-30} l 5 -3 M ${x0+w/2} ${gY-30} l 5 3 M ${x0+p+w/2} ${gY-30} l -5 -3 M ${x0+p+w/2} ${gY-30} l -5 3`}/>
      <line x1={x0+w/2} x2={x0+w/2} y1={gY-26} y2={gY-16} strokeDasharray="2 2"/>
      <line x1={x0+p+w/2} x2={x0+p+w/2} y1={gY-26} y2={gY-16} strokeDasharray="2 2"/>
    </g>
    <text x={x0+w/2+p/2} y={gY-35} textAnchor="middle" style={{font:"600 9.5px var(--mono)"}} fill={C.accent}>PITCH {fmt(pitch,2)} m (centre → centre)</text>
    <g stroke="#374151" strokeWidth="1" fill="none">
      <line x1={x0+w} x2={x0+p} y1={gY+14} y2={gY+14}/>
      <path d={`M ${x0+w} ${gY+14} l 5 -3 M ${x0+w} ${gY+14} l 5 3 M ${x0+p} ${gY+14} l -5 -3 M ${x0+p} ${gY+14} l -5 3`}/>
    </g>
    <text x={x0+w+gap/2} y={gY+30} textAnchor="middle" style={{font:"600 9.5px var(--mono)"}} fill="#374151">CLEAR GAP {fmt(Math.max(0,pitch-geo.planAcross),2)} m</text>
    <text x={x0+w/2} y={gY-19} textAnchor="middle" style={{font:"8px var(--mono)"}} fill="#9fb4d8">{fmt(geo.planAcross,2)} m</text>
  </svg>);
}

function useNarrow(bp = 900) {
  const [n, setN] = useState(typeof window !== "undefined" && window.innerWidth <= bp);
  useEffect(() => {
    const on = () => setN(window.innerWidth <= bp);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, [bp]);
  return n;
}
const COARSE = typeof window !== "undefined" &&
  window.matchMedia && window.matchMedia("(pointer: coarse)").matches;

function Iso3D({ variant, geo, polygon, terrain, slopes, tiltDeg }) {
  const W = 1000, H = 660;
  const svgRef = useRef(null);
  const dragRef = useRef(null);
  const [cam, setCam] = useState({ az: -35, el: 32, zoom: 1, px: 0, py: 0 });
  const camRef = useRef(cam); camRef.current = cam;

  const frames = variant?.frames || [];
  const base = polygon.length >= 3 ? polygon : [{ x: 0, y: 0 }, { x: 100, y: 100 }];
  const bb = bboxOf(base);
  const cx = (bb.minX + bb.maxX) / 2, cy = (bb.minY + bb.maxY) / 2;

  const zAt = (x, y) => {
    if (!terrain) return 0;
    const ix = Math.min(terrain.nx - 1, Math.max(0, Math.round((x - terrain.x0) / terrain.cell)));
    const iy = Math.min(terrain.ny - 1, Math.max(0, Math.round((y - terrain.y0) / terrain.cell)));
    return terrain.z[iy * terrain.nx + ix] - terrain.zmin;
  };

  // camera basis: orbit about the site centre
  const a = rad(cam.az), e = rad(Math.max(6, Math.min(88, cam.el)));
  const ux = Math.cos(a), uy = -Math.sin(a);                       // screen right
  const vx = -Math.sin(e) * Math.sin(a), vy = -Math.sin(e) * Math.cos(a), vz = Math.cos(e);
  const dx = Math.cos(e) * Math.sin(a), dy = Math.cos(e) * Math.cos(a), dz = Math.sin(e);

  const span = Math.max(bb.maxX - bb.minX, bb.maxY - bb.minY, 1);
  const sc = ((Math.min(W, H) * 0.82) / span) * cam.zoom;
  const P = (x, y, z) => {
    const px = x - cx, py = y - cy, pz = z || 0;
    return [
      W / 2 + (px * ux + py * uy) * sc + cam.px,
      H / 2 - (px * vx + py * vy + pz * vz) * sc + cam.py,
    ];
  };
  const depth = (x, y, z) => (x - cx) * dx + (y - cy) * dy + (z || 0) * dz;

  const items = [];

  // ---- terrain surface, coloured by gradient and shaded for form ----
  if (terrain && slopes) {
    const budget = 2600;
    const step = Math.max(1, Math.ceil(Math.sqrt(((terrain.nx - 1) * (terrain.ny - 1)) / budget)));
    const L = [0.45, -0.62, 0.64];
    for (let iy = 0; iy + step < terrain.ny; iy += step) {
      for (let ix = 0; ix + step < terrain.nx; ix += step) {
        const x0 = terrain.x0 + ix * terrain.cell, y0 = terrain.y0 + iy * terrain.cell;
        const x1 = x0 + terrain.cell * step, y1 = y0 + terrain.cell * step;
        const k = iy * terrain.nx + ix;
        const sx = slopes.sx[k], sy = slopes.sy[k];
        const g = Math.min(1, (Math.max(Math.abs(sx), Math.abs(sy)) * 100) / 15);
        // green -> amber -> red
        let R, G, B;
        if (g < 0.5) { const t = g * 2; R = 74 + 160 * t; G = 150 + 20 * t; B = 62; }
        else { const t = (g - 0.5) * 2; R = 234; G = 170 - 120 * t; B = 62 - 20 * t; }
        const nl = Math.hypot(-sx, -sy, 1);
        const diff = Math.max(0.45, (-sx * L[0] - sy * L[1] + L[2]) / nl);
        const sh = 0.55 + 0.55 * diff;
        const col = `rgb(${Math.round(Math.min(255, R * sh))},${Math.round(Math.min(255, G * sh))},${Math.round(Math.min(255, B * sh))})`;
        const c = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
        items.push({
          d: c.map((p, i) => `${i ? "L" : "M"} ${P(p[0], p[1], zAt(p[0], p[1])).join(" ")}`).join(" ") + " Z",
          fill: col, stroke: col, sw: 0.5,
          z: depth((x0 + x1) / 2, (y0 + y1) / 2, zAt((x0 + x1) / 2, (y0 + y1) / 2)),
        });
      }
    }
  } else {
    const c = [[bb.minX, bb.minY], [bb.maxX, bb.minY], [bb.maxX, bb.maxY], [bb.minX, bb.maxY]];
    items.push({
      d: c.map((p, i) => `${i ? "L" : "M"} ${P(p[0], p[1], 0).join(" ")}`).join(" ") + " Z",
      fill: "#232830", stroke: "#2c313b", sw: 1, z: -1e9,
    });
  }

  // ---- roads ----
  for (const s of variant?.roads || []) {
    const pts = s.split(" ").map((p) => p.split(",").map(Number));
    const mx = pts.reduce((t, p) => t + p[0], 0) / pts.length;
    const my = pts.reduce((t, p) => t + p[1], 0) / pts.length;
    items.push({
      d: pts.map((p, i) => `${i ? "L" : "M"} ${P(p[0], p[1], zAt(p[0], p[1]) + 0.15).join(" ")}`).join(" ") + " Z",
      fill: "#2b3039", stroke: "#525a66", sw: 0.7, z: depth(mx, my, zAt(mx, my)) + 0.2,
    });
  }

  // ---- frames as tilted panels on posts ----
  const vertical = geo.mounting !== "fixed";
  const t = rad(tiltDeg);
  const hub = (geo.clearance || 0.5) + (geo.acrossW / 2) * Math.abs(Math.sin(t));
  for (const f of frames) {
    const fx = f.x + f.w / 2, fy = f.y + f.h / 2;
    const aH = (vertical ? f.w : f.h) / 2, lH = (vertical ? f.h : f.w) / 2;
    const aC = aH * Math.cos(t), aS = aH * Math.sin(t);
    const gz = zAt(fx, fy) + hub;
    const c = vertical
      ? [[fx - aC, fy + lH, gz - aS], [fx + aC, fy + lH, gz + aS],
         [fx + aC, fy - lH, gz + aS], [fx - aC, fy - lH, gz - aS]]
      : [[fx + lH, fy - aC, gz - aS], [fx + lH, fy + aC, gz + aS],
         [fx - lH, fy + aC, gz + aS], [fx - lH, fy - aC, gz - aS]];
    const z = depth(fx, fy, gz);
    const p0 = P(fx, fy, zAt(fx, fy)), p1 = P(fx, fy, gz);
    items.push({ line: [p0, p1], stroke: "#616875", sw: 0.9, z: z - 0.01 });
    items.push({
      d: c.map((q, i) => `${i ? "L" : "M"} ${P(q[0], q[1], q[2]).join(" ")}`).join(" ") + " Z",
      fill: f.pen > 0 ? "#5a4a2c" : C.navy, stroke: f.pen > 0 ? C.warn : "#8fa6c9", sw: 0.6, z,
    });
  }

  items.sort((p, q) => p.z - q.z);

  // ---- boundary drawn over the top ----
  const bdry = base.map((p, i) =>
    `${i ? "L" : "M"} ${P(p.x, p.y, zAt(p.x, p.y) + 0.4).join(" ")}`).join(" ") + " Z";

  /* interaction: drag to orbit, shift-drag to pan, wheel to zoom */
  const onDown = (ev) => {
    dragRef.current = {
      x: ev.clientX, y: ev.clientY, cam: { ...camRef.current }, pan: ev.shiftKey || ev.button === 2,
    };
    ev.currentTarget.setPointerCapture(ev.pointerId);
  };
  const onMove = (ev) => {
    const d = dragRef.current;
    if (!d) return;
    const mx = ev.clientX - d.x, my = ev.clientY - d.y;
    if (d.pan) setCam({ ...d.cam, px: d.cam.px + mx, py: d.cam.py + my });
    else setCam({ ...d.cam, az: d.cam.az - mx * 0.35, el: Math.max(6, Math.min(88, d.cam.el + my * 0.3)) });
  };
  const onUp = () => { dragRef.current = null; };
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (ev) => {
      ev.preventDefault();
      const c = camRef.current;
      setCam({ ...c, zoom: Math.min(12, Math.max(0.25, c.zoom * Math.pow(0.9988, ev.deltaY))) });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  return (
    <div style={{ flex: 1, minHeight: 0, position: "relative", background: "#171a20" }}>
      <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`}
        style={{ width: "100%", height: "100%", display: "block", cursor: "grab", touchAction: "none" }}
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}
        onContextMenu={(ev) => ev.preventDefault()}>
        {items.map((it, i) => (
          it.line
            ? <line key={i} x1={it.line[0][0]} y1={it.line[0][1]} x2={it.line[1][0]} y2={it.line[1][1]}
                stroke={it.stroke} strokeWidth={it.sw} />
            : <path key={i} d={it.d} fill={it.fill} stroke={it.stroke} strokeWidth={it.sw}
                shapeRendering="geometricPrecision" />
        ))}
        <path d={bdry} fill="none" stroke={C.boundary} strokeWidth="1.8" />
      </svg>
      <div style={{
        position: "absolute", top: 10, left: 12, font: "10px var(--mono)", color: "#8f98a5",
        background: "rgba(23,26,32,0.88)", padding: "5px 10px", borderRadius: 4,
        border: "1px solid #2c313b", lineHeight: 1.55, pointerEvents: "none",
      }}>
        {fmt(frames.length, 0)} frames · {fmt(tiltDeg, 0)}° tilt · view {fmt(cam.az, 0)}° / {fmt(cam.el, 0)}°
        <br />{terrain
          ? `terrain ${fmt(terrain.zmax - terrain.zmin, 0)} m relief, true vertical scale`
          : "flat ground — no terrain loaded"}
        <br />drag to orbit · shift-drag to pan · scroll to zoom
      </div>
      <button className="btn" style={{ position: "absolute", top: 10, right: 12 }}
        onClick={() => setCam({ az: -35, el: 32, zoom: 1, px: 0, py: 0 })}>Reset view</button>
      {terrain && (
        <div style={{
          position: "absolute", bottom: 10, right: 12, display: "flex", alignItems: "center",
          gap: 7, background: "rgba(23,26,32,0.9)", padding: "5px 10px", borderRadius: 4,
          border: "1px solid #2c313b",
        }}>
          <span style={{ font: "600 9px system-ui", color: "#9aa3ae", letterSpacing: "0.07em" }}>SLOPE</span>
          <span style={{
            width: 76, height: 9, borderRadius: 2, display: "inline-block",
            background: "linear-gradient(90deg, rgb(74,150,62), rgb(234,170,62), rgb(234,50,42))",
          }} />
          <span style={{ font: "9px var(--mono)", color: "#9aa3ae" }}>0 → 15%+</span>
        </div>
      )}
    </div>
  );
}

function SiteCanvas({
  polygon, setPolygon, mode, setMode, draft, setDraft,
  variant, geo, viewFitToken, ss, setSs, alignEdge, showSs,
  alignLine, setAlignLine, alineDraft, setAlineDraft, heatCells, onBeforeEdit,
  cabling, setSsOver, bg, calib, onCalibPick,
}) {
  const svgRef = useRef(null);
  const wrapRef = useRef(null);
  const [vb, setVb] = useState({ x: -50, y: -50, w: 620, h: 700 });
  const vbRef = useRef(vb);
  vbRef.current = vb;
  const dragRef = useRef(null);

  const fitTo = useCallback((pts) => {
    const el = wrapRef.current;
    if (!pts || pts.length < 3 || !el) return;
    const bb = bboxOf(pts);
    const pad = Math.max(bb.maxX - bb.minX, bb.maxY - bb.minY) * 0.08 + 10;
    let w = bb.maxX - bb.minX + 2 * pad;
    let h = bb.maxY - bb.minY + 2 * pad;
    const ar = el.clientWidth / Math.max(1, el.clientHeight);
    if (w / h > ar) h = w / ar; else w = h * ar;
    setVb({
      x: (bb.minX + bb.maxX) / 2 - w / 2,
      y: (bb.minY + bb.maxY) / 2 - h / 2,
      w, h,
    });
  }, []);

  useEffect(() => { fitTo(polygon); /* eslint-disable-next-line */ }, [viewFitToken]);

  const world = (e) => {
    const r = svgRef.current.getBoundingClientRect();
    const v = vbRef.current;
    return {
      x: v.x + ((e.clientX - r.left) / r.width) * v.w,
      y: v.y + ((e.clientY - r.top) / r.height) * v.h,
    };
  };
  const pxTol = (px) => {
    const r = svgRef.current?.getBoundingClientRect();
    if (!r) return 1;
    return (px * vbRef.current.w) / r.width;
  };

  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const v = vbRef.current;
      const k = Math.pow(1.0015, e.deltaY);
      const mx = v.x + ((e.clientX - r.left) / r.width) * v.w;
      const my = v.y + ((e.clientY - r.top) / r.height) * v.h;
      const nw = Math.min(Math.max(v.w * k, 5), 50000);
      const nh = (nw / v.w) * v.h;
      setVb({ x: mx - ((mx - v.x) / v.w) * nw, y: my - ((my - v.y) / v.h) * nh, w: nw, h: nh });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const onPointerDown = (e) => {
    const p = world(e);
    if (calib?.active) { onCalibPick && onCalibPick(p); return; }
    if (showSs && mode !== "draw" && mode !== "aline" && ss && Math.hypot(ss.x - p.x, ss.y - p.y) < pxTol(COARSE ? 22 : 12)) {
      dragRef.current = { kind: "ss" };
      e.currentTarget.setPointerCapture(e.pointerId);
      return;
    }
    // align-line handles: ends rotate/reshape, middle moves the whole line
    if (mode === "edit" && alignLine) {
      const tol = pxTol(10);
      const mid = { x: (alignLine.p.x + alignLine.q.x) / 2, y: (alignLine.p.y + alignLine.q.y) / 2 };
      if (Math.hypot(alignLine.p.x - p.x, alignLine.p.y - p.y) < tol) {
        dragRef.current = { kind: "alineEnd", end: "p" };
        e.currentTarget.setPointerCapture(e.pointerId);
        return;
      }
      if (Math.hypot(alignLine.q.x - p.x, alignLine.q.y - p.y) < tol) {
        dragRef.current = { kind: "alineEnd", end: "q" };
        e.currentTarget.setPointerCapture(e.pointerId);
        return;
      }
      if (Math.hypot(mid.x - p.x, mid.y - p.y) < tol) {
        dragRef.current = { kind: "alineMove", start: p, p0: { ...alignLine.p }, q0: { ...alignLine.q } };
        e.currentTarget.setPointerCapture(e.pointerId);
        return;
      }
    }
    if (mode === "pan") {
      dragRef.current = { kind: "pan", start: p, vb0: { ...vbRef.current } };
      e.currentTarget.setPointerCapture(e.pointerId);
    } else if (mode === "edit") {
      const tol = pxTol(COARSE ? 18 : 9);
      // edge midpoints insert a new vertex, CAD-style
      for (let i = 0; i < polygon.length; i++) {
        const a = polygon[i], b = polygon[(i + 1) % polygon.length];
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        if (Math.hypot(mid.x - p.x, mid.y - p.y) < tol) {
          onBeforeEdit && onBeforeEdit();
          setPolygon((poly) => [...poly.slice(0, i + 1), mid, ...poly.slice(i + 1)]);
          dragRef.current = { kind: "vertex", idx: i + 1 };
          e.currentTarget.setPointerCapture(e.pointerId);
          return;
        }
      }
      let hit = -1;
      polygon.forEach((v, i) => {
        if (Math.hypot(v.x - p.x, v.y - p.y) < tol) hit = i;
      });
      if (hit >= 0) {
        onBeforeEdit && onBeforeEdit();
        dragRef.current = { kind: "vertex", idx: hit };
      } else {
        dragRef.current = { kind: "pan", start: p, vb0: { ...vbRef.current } };
      }
      e.currentTarget.setPointerCapture(e.pointerId);
    } else if (mode === "draw" || mode === "aline") {
      dragRef.current = { kind: "clickcheck", sx: e.clientX, sy: e.clientY };
    }
  };

  const onPointerMove = (e) => {
    const d = dragRef.current;
    if (!d) return;
    if (d.kind === "pan") {
      const r = svgRef.current.getBoundingClientRect();
      const v = d.vb0;
      const px = ((e.clientX - r.left) / r.width) * v.w + v.x;
      const py = ((e.clientY - r.top) / r.height) * v.h + v.y;
      setVb({ x: v.x - (px - d.start.x), y: v.y - (py - d.start.y), w: v.w, h: v.h });
    } else if (d.kind === "vertex") {
      const p = world(e);
      setPolygon((poly) => poly.map((v, i) => (i === d.idx ? p : v)));
    } else if (d.kind === "ss") {
      setSs(world(e));
    } else if (d.kind === "alineEnd") {
      const p = world(e);
      setAlignLine((l) => ({ ...l, [d.end]: p }));
    } else if (d.kind === "alineMove") {
      const p = world(e);
      const dx = p.x - d.start.x, dy = p.y - d.start.y;
      setAlignLine({ p: { x: d.p0.x + dx, y: d.p0.y + dy }, q: { x: d.q0.x + dx, y: d.q0.y + dy } });
    }
  };

  const onPointerUp = (e) => {
    const d = dragRef.current;
    if (d && d.kind === "clickcheck" && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 5) {
      const p = world(e);
      if (mode === "draw") {
        if (draft.length >= 3 && Math.hypot(p.x - draft[0].x, p.y - draft[0].y) < pxTol(COARSE ? 22 : 12)) {
          setPolygon(draft);
          setDraft([]);
          setMode("edit");
        } else {
          setDraft((dd) => [...dd, p]);
        }
      } else if (mode === "aline") {
        if (!alineDraft) {
          setAlineDraft(p);
        } else {
          setAlignLine({ p: alineDraft, q: p });
          setAlineDraft(null);
          setMode("edit");
        }
      }
    }
    dragRef.current = null;
  };

  const onDblClick = (e) => {
    if (mode === "draw") {
      if (draft.length >= 3) { setPolygon(draft); setDraft([]); setMode("edit"); }
      return;
    }
    if (mode !== "edit" || polygon.length <= 3) return;
    const p = world(e);
    const tol = pxTol(COARSE ? 18 : 9);
    const idx = polygon.findIndex((v) => Math.hypot(v.x - p.x, v.y - p.y) < tol);
    if (idx >= 0) { onBeforeEdit && onBeforeEdit(); setPolygon((poly) => poly.filter((_, i) => i !== idx)); }
  };

  const gridStep = useMemo(() => {
    const cands = [1, 2, 5, 10, 20, 25, 50, 100, 200, 500, 1000];
    for (const s of cands) if (vb.w / s <= 26) return s;
    return 2000;
  }, [vb.w]);

  const gridLines = useMemo(() => {
    const out = [];
    const x0 = Math.floor(vb.x / gridStep) * gridStep;
    const y0 = Math.floor(vb.y / gridStep) * gridStep;
    for (let gx = x0; gx <= vb.x + vb.w; gx += gridStep) {
      out.push(<line key={`gx${gx}`} x1={gx} x2={gx} y1={vb.y} y2={vb.y + vb.h}
        stroke={gx % (gridStep * 5) === 0 ? C.gridMajor : C.grid} strokeWidth="1" vectorEffect="non-scaling-stroke" />);
    }
    for (let gy = y0; gy <= vb.y + vb.h; gy += gridStep) {
      out.push(<line key={`gy${gy}`} x1={vb.x} x2={vb.x + vb.w} y1={gy} y2={gy}
        stroke={gy % (gridStep * 5) === 0 ? C.gridMajor : C.grid} strokeWidth="1" vectorEffect="non-scaling-stroke" />);
    }
    return out;
  }, [vb, gridStep]);

  const spacing = Math.max(geo.dAlong + geo.gapAlong, 0.05);
  const vertical = geo.mounting !== "fixed";
  const cursor = mode === "draw" || mode === "aline" ? "crosshair" : mode === "pan" ? "grab" : "default";
  const frames = variant?.frames || [];
  const blocks = variant?.blocks || [];
  const txBoxes = variant?.txBoxes || [];
  const acSegs = variant?.ac?.segs || [];

  return (
    <div ref={wrapRef} style={{ position: "relative", flex: 1, minHeight: 0 }}>
      <svg
        ref={svgRef}
        viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`}
        style={{ width: "100%", height: "100%", display: "block", background: C.paper, cursor, touchAction: "none" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDoubleClick={onDblClick}
        onContextMenu={(e) => {
          e.preventDefault();
          if (mode === "draw" && draft.length >= 3) {
            setPolygon(draft); setDraft([]); setMode("edit");
          } else if (mode === "draw") { setDraft([]); setMode("edit"); }
        }}
      >
        {bg && (
          <image href={bg.url} x={0} y={0}
            width={bg.wPx * bg.scale} height={bg.hPx * bg.scale}
            opacity={0.55} preserveAspectRatio="none" style={{ pointerEvents: "none" }} />
        )}
        {calib?.pts?.map((p, i) => (
          <circle key={`cal${i}`} cx={p.x} cy={p.y} r={pxTol(5)} fill="none"
            stroke="#4db2ff" strokeWidth="2" vectorEffect="non-scaling-stroke" />
        ))}
        {calib?.pts?.length === 2 && (
          <line x1={calib.pts[0].x} y1={calib.pts[0].y} x2={calib.pts[1].x} y2={calib.pts[1].y}
            stroke="#4db2ff" strokeWidth="1.5" strokeDasharray="6 4" vectorEffect="non-scaling-stroke" />
        )}
        <defs>
          <pattern id="modsHatchV" width="8" height={spacing} patternUnits="userSpaceOnUse">
            <rect width="8" height={spacing} fill="#232830" />
            <line x1="0" x2="8" y1="0" y2="0" stroke={C.moduleRed} strokeWidth={Math.min(0.06, spacing / 6)} />
          </pattern>
          <pattern id="modsHatchH" width={spacing} height="8" patternUnits="userSpaceOnUse">
            <rect width={spacing} height="8" fill="#232830" />
            <line x1="0" x2="0" y1="0" y2="8" stroke={C.moduleRed} strokeWidth={Math.min(0.06, spacing / 6)} />
          </pattern>
        </defs>

        {gridLines}

        {/* slope heatmap (green→amber→red by max gradient %) */}
        <g>
          {(heatCells || []).map((c, i) => {
            const v = Math.min(1, c.v / 15);
            const col = v < 0.5
              ? `rgba(${Math.round(90 + 260 * v)},${Math.round(190 - 30 * v)},70,0.42)`
              : `rgba(235,${Math.round(160 - 120 * (v - 0.5) * 2)},55,0.5)`;
            return <rect key={`hc${i}`} x={c.x} y={c.y} width={c.w} height={c.h} fill={col} />;
          })}
        </g>

        {/* road bands (constant perpendicular width, continuous through stagger) */}
        <g>
          {(variant?.roads || []).map((pts, i) => (
            <polygon key={`rd${i}`} points={pts} fill="#2b3039"
              stroke="#8f98a5" strokeWidth="1" vectorEffect="non-scaling-stroke" />
          ))}
        </g>

        {/* frames (always true N–S / E–W — stagger shifts, never rotates) */}
        <g>
          {frames.map((f, i) => (
            <rect key={i}
              x={f.x} y={f.y} width={f.w} height={f.h}
              fill={vertical ? "url(#modsHatchV)" : "url(#modsHatchH)"}
              stroke={f.pen > 0 ? C.warn : C.frame}
              strokeWidth={f.pen > 0 ? 1.6 : 1} vectorEffect="non-scaling-stroke">
              <title>
                {`Frame · ${f.modules} modules · ${fmt(f.strings, 2)} string(s) · inverter ${f.inv + 1} · transformer ${f.tx + 1}${f.pen > 0 ? ` · grade penalty ${fmt(f.pen * 100, 0)}%` : ""}`}
              </title>
            </rect>
          ))}
        </g>

        {/* routed cabling: LV inverter -> substation, MV substation -> grid point */}
        {showSs && cabling && (
          <g fill="none">
            {cabling.paths.map((p, i) => (
              <polyline key={`lv${i}`} points={p.map((q) => `${q.x},${q.y}`).join(" ")}
                stroke="#c9ced6" strokeWidth="1.1" vectorEffect="non-scaling-stroke" opacity="0.85" />
            ))}
            {cabling.mvPaths.map((p, i) => (
              <polyline key={`mv${i}`} points={p.map((q) => `${q.x},${q.y}`).join(" ")}
                stroke={C.transformer} strokeWidth="2.2" vectorEffect="non-scaling-stroke" />
            ))}
          </g>
        )}

        {/* inverter blocks (green, stepped) and transformer groups (blue) */}
        <g fill="none">
          {blocks.map((b) =>
            b.laneCells ? (
              <path key={`b${b.inv}`} d={blockOutlinePoints(b.laneCells, vertical, 1)}
                stroke={C.inverter} strokeWidth="1.4" vectorEffect="non-scaling-stroke">
                <title>{`Inverter ${b.inv + 1} · ${b.nFrames} frames · ${fmt(b.strings, 1)} strings`}</title>
              </path>
            ) : (
              <rect key={`b${b.inv}`} x={b.x - 1} y={b.y - 1} width={b.w + 2} height={b.h + 2}
                stroke={C.inverter} strokeWidth="1.4" vectorEffect="non-scaling-stroke">
                <title>{`Inverter ${b.inv + 1} · ${b.nFrames} frames · ${fmt(b.strings, 1)} strings`}</title>
              </rect>
            )
          )}
          {!showSs ? null : variant?.txPaths
            ? variant.txPaths.map((d, i) => (
                <path key={`tp${i}`} d={d} stroke={C.transformer} strokeWidth="1.8"
                  strokeDasharray="7 4" vectorEffect="non-scaling-stroke" />
              ))
            : txBoxes.map((b) => (
                <rect key={`t${b.id}`} x={b.x} y={b.y} width={b.w} height={b.h}
                  stroke={C.transformer} strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
              ))}
        </g>

        {/* inverter markers — drawn where the cabling plan put them */}
        <g>
          {blocks.map((b) => {
            const s = pxTol(7);
            const mk = cabling?.markers?.find((m) => m.inv === b.inv);
            const x = mk ? mk.x : b.mx, y = mk ? mk.y : b.my;
            return (
              <rect key={`im${b.inv}`} x={x - s / 2} y={y - s / 2} width={s} height={s}
                fill={C.inverter} stroke="#ffffff" strokeWidth="1" vectorEffect="non-scaling-stroke">
                <title>{`Inverter ${b.inv + 1} · ${fmt(b.strings, 1)} strings`}</title>
              </rect>
            );
          })}
        </g>

        {/* alignment line (purple, like a CAD reference line) */}
        {alignEdge && (() => {
          const dx = alignEdge.q.x - alignEdge.p.x, dy = alignEdge.q.y - alignEdge.p.y;
          return (
            <line
              x1={alignEdge.p.x - dx * 0.15} y1={alignEdge.p.y - dy * 0.15}
              x2={alignEdge.q.x + dx * 0.15} y2={alignEdge.q.y + dy * 0.15}
              stroke="#a06be0" strokeWidth="4" vectorEffect="non-scaling-stroke"
              strokeLinecap="round" opacity="0.85"
            />
          );
        })()}

        {/* drawn alignment line with handles (edit mode: drag ends to rotate, middle to move) */}
        {alignLine && (
          <g>
            <line x1={alignLine.p.x} y1={alignLine.p.y} x2={alignLine.q.x} y2={alignLine.q.y}
              stroke="#a06be0" strokeWidth="3" vectorEffect="non-scaling-stroke"
              strokeLinecap="round" opacity="0.9" />
            {mode === "edit" && [alignLine.p, alignLine.q,
              { x: (alignLine.p.x + alignLine.q.x) / 2, y: (alignLine.p.y + alignLine.q.y) / 2 }]
              .map((h, i) => (
                <circle key={i} cx={h.x} cy={h.y} r={pxTol(i === 2 ? 4 : 5.5)}
                  fill={i === 2 ? "#a06be0" : "#fff"} stroke="#a06be0"
                  strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
              ))}
          </g>
        )}
        {alineDraft && (
          <circle cx={alineDraft.x} cy={alineDraft.y} r={pxTol(4)}
            fill="#a06be0" opacity="0.8" />
        )}

        {/* modular substations — drag to reposition */}
        {showSs && cabling && cabling.subs.map((s, i) => {
          const w = pxTol(13);
          return (
            <g key={`sub${i}`} style={{ cursor: "move" }}
              onPointerDown={(e) => { e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId); }}
              onPointerMove={(e) => {
                if (e.buttons !== 1) return;
                const r = e.currentTarget.ownerSVGElement.getBoundingClientRect();
                const v = vbRef.current;
                setSsOver((o) => ({ ...o, [i]: {
                  x: v.x + ((e.clientX - r.left) / r.width) * v.w,
                  y: v.y + ((e.clientY - r.top) / r.height) * v.h } }));
              }}>
              <rect x={s.x - w / 2} y={s.y - w / 2} width={w} height={w} rx={pxTol(1.5)}
                fill="#12304d" stroke={C.transformer} strokeWidth="2" vectorEffect="non-scaling-stroke" />
              <text x={s.x} y={s.y + pxTol(3)} textAnchor="middle" fill="#8fc4f5"
                style={{ font: `700 ${pxTol(7)}px system-ui, sans-serif` }}>{s.ways}</text>
              <title>{`${s.ways}-way substation · ${s.used} inverters connected · ${s.spare} spare way(s)`}</title>
            </g>
          );
        })}

        {/* grid connection point */}
        {showSs && ss && (
          <g style={{ cursor: "move" }}>
            <rect x={ss.x - pxTol(COARSE ? 18 : 9)} y={ss.y - pxTol(COARSE ? 18 : 9)} width={pxTol(18)} height={pxTol(18)}
              fill={C.transformer} stroke="#ffffff" strokeWidth="1.5" vectorEffect="non-scaling-stroke">
              <title>Grid connection point — drag to move (MV runs update)</title>
            </rect>
            <text x={ss.x} y={ss.y + pxTol(3)} textAnchor="middle" fill="#ffffff"
              style={{ font: `600 ${pxTol(8)}px system-ui, sans-serif` }}>POI</text>
          </g>
        )}

        {/* boundary */}
        {polygon.length >= 3 && (
          <polygon
            points={polygon.map((p) => `${p.x},${p.y}`).join(" ")}
            fill="none" stroke={C.boundary} strokeWidth="2" vectorEffect="non-scaling-stroke"
          />
        )}
        {mode === "edit" && (
          <g>
            {polygon.map((p, i) => {
              const s = pxTol(COARSE ? 9 : 5.5);
              return (
                <rect key={`v${i}`} x={p.x - s} y={p.y - s} width={s * 2} height={s * 2}
                  fill="#fff" stroke={C.boundary} strokeWidth="1.6"
                  vectorEffect="non-scaling-stroke" style={{ cursor: "move" }}>
                  <title>Drag to move · double-click to delete</title>
                </rect>
              );
            })}
            {polygon.map((p, i) => {
              const q = polygon[(i + 1) % polygon.length];
              const s = pxTol(COARSE ? 6.5 : 3.5);
              return (
                <rect key={`m${i}`} x={(p.x + q.x) / 2 - s} y={(p.y + q.y) / 2 - s}
                  width={s * 2} height={s * 2} fill="none" stroke={C.boundary}
                  strokeWidth="1.4" opacity="0.75" vectorEffect="non-scaling-stroke"
                  style={{ cursor: "copy" }}>
                  <title>Drag to add a vertex here</title>
                </rect>
              );
            })}
          </g>
        )}

        {draft.length > 0 && (
          <g>
            <polyline
              points={draft.map((p) => `${p.x},${p.y}`).join(" ")}
              fill="none" stroke="#ffffff" strokeWidth="1.6"
              strokeDasharray="7 5" vectorEffect="non-scaling-stroke"
            />
            {draft.map((p, i) => (
              <circle key={i} cx={p.x} cy={p.y} r={pxTol(i === 0 ? 6 : 3.5)}
                fill={i === 0 ? C.accent : "#ffffff"} stroke="#ffffff"
                strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
            ))}
          </g>
        )}
      </svg>

      <div style={{
        position: "absolute", top: 10, right: 12, color: "#9aa3ae",
        font: "600 11px ui-monospace, Menlo, Consolas, monospace", letterSpacing: "0.06em",
        background: "rgba(27,30,36,0.85)", padding: "2px 8px", borderRadius: 3,
      }}>
        N ↑
      </div>
      <div style={{
        position: "absolute", bottom: 8, left: 12, color: "#9aa3ae",
        font: "11px ui-monospace, Menlo, Consolas, monospace",
        background: "rgba(27,30,36,0.85)", padding: "2px 8px", borderRadius: 3,
      }}>
        grid {gridStep} m
      </div>
      {heatCells && heatCells.length > 0 && (
        <div style={{
          position: "absolute", bottom: 8, right: 12, display: "flex", alignItems: "center",
          gap: 7, background: "rgba(27,30,36,0.88)", padding: "5px 10px", borderRadius: 4,
          border: "1px solid #2c313b",
        }}>
          <span style={{ font: "600 9px system-ui", color: "#9aa3ae", letterSpacing: "0.07em" }}>SLOPE</span>
          <span style={{
            width: 76, height: 9, borderRadius: 2, display: "inline-block",
            background: "linear-gradient(90deg, rgba(90,190,70,0.9), rgba(220,175,55,0.9), rgba(235,60,55,0.95))",
          }} />
          <span style={{ font: "9px var(--mono)", color: "#9aa3ae" }}>0 → 15%+</span>
        </div>
      )}
      {variant && heatCells && heatCells.length === 0 && (
        <div style={{
          position: "absolute", bottom: 8, right: 12, font: "10px system-ui",
          color: "#6b7280", background: "rgba(27,30,36,0.8)", padding: "3px 9px", borderRadius: 4,
        }}>
          no terrain loaded
        </div>
      )}
      {mode === "edit" && polygon.length >= 3 && (
        <div style={{
          position: "absolute", top: 10, left: "50%", transform: "translateX(-50%)",
          color: "#8f98a5", font: "11px system-ui, sans-serif",
          background: "rgba(27,30,36,0.9)", padding: "3px 11px", borderRadius: 4,
          border: "1px solid #2c313b", pointerEvents: "none",
        }}>
          Drag ■ to move a vertex · drag □ on an edge to add one · double-click a vertex to delete
        </div>
      )}
      {mode === "draw" && (
        <div style={{
          position: "absolute", top: 10, left: "50%", transform: "translateX(-50%)",
          color: "#c3cad3", font: "12px system-ui, sans-serif",
          background: "rgba(27,30,36,0.92)", padding: "4px 12px", borderRadius: 4,
          border: `1px solid ${C.gridMajor}`,
        }}>
          {draft.length === 0
            ? "Click to place the first vertex"
            : `${draft.length} vertices — click the first one, double-click, or right-click to finish · Esc to cancel`}
        </div>
      )}
      {polygon.length < 3 && draft.length === 0 && (
        <div style={{
          position: "absolute", inset: 0, display: "flex", alignItems: "center",
          justifyContent: "center", pointerEvents: "none", color: "#8f98a5",
          font: "14px system-ui, sans-serif",
        }}>
          No boundary defined — draw one, paste coordinates, or load the example.
        </div>
      )}
    </div>
  );
}

/* =====================================================================
   App
   ===================================================================== */
function LayoutTool({ module, setModule, frame, setFrame, elec, setElec, invAcKw, uiMode, reg, onSummary, inv, setInv }) {
  const [pitchCfg, setPitchCfg] = useState({ rowPitch: 5.5, endGap: 1.0, spacingMode: "pitch" });
  const [site, setSite] = useState({ setback: 10 });
  const [blockCfg, setBlockCfg] = useState({ gapLane: 3, gapSlot: 8, rowsPerCorridor: 2 });
  const [align, setAlign] = useState({ mode: "north", custom: 0 });
  const [capacity, setCapacity] = useState({ kind: "none", inverters: 24, modules: 16000, strings: 600, dcMWp: 10, acMW: 8, acRatio: 1.2 });
  const [alignLine, setAlignLine] = useState(null); // {p:{x,y}, q:{x,y}} drawn by the user
  const [alineDraft, setAlineDraft] = useState(null);
  const [terrainPts, setTerrainPts] = useState(null);
  const [slopeLim, setSlopeLim] = useState({ hardAlong: 20, softAlong: 8, hardCross: 20, softCross: 8 });
  const [showSlope, setShowSlope] = useState(true);
  const [showSs, setShowSs] = useState(true);
  const [ssOver, setSsOver] = useState({});
  const [priority, setPriority] = useState("balanced");
  const [importMsg, setImportMsg] = useState("");
  const [view3d, setView3d] = useState(false);
  const narrow = useNarrow();
  const [panelOpen, setPanelOpen] = useState(true);
  const [dxfBoundaries, setDxfBoundaries] = useState(null);
  const [geoOrigin, setGeoOrigin] = useState(null);
  const [bg, setBg] = useState(null);           // {url, wPx, hPx, scale m/px}
  const [calib, setCalib] = useState({ active: false, pts: [], dist: 100 });
  useEffect(() => {
    if (alignLine) setAlign((a) => ({ ...a, mode: "line" }));
  }, [alignLine === null]); // fires when a line first appears/disappears


  const [polygon, setPolygonRaw] = useState(EXAMPLE_BOUNDARY);
  const [ss, setSs] = useState(polygonCentroid(EXAMPLE_BOUNDARY));
  const [draft, setDraft] = useState([]);
  const [mode, setMode] = useState("edit");
  const [fitToken, setFitToken] = useState(0);
  const [importText, setImportText] = useState("");
  const [importErr, setImportErr] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);

  const hist = useRef({ past: [], future: [] });
  const pushHist = useCallback(() => {
    hist.current.past.push(JSON.stringify(polygon));
    if (hist.current.past.length > 60) hist.current.past.shift();
    hist.current.future = [];
  }, [polygon]);
  const undo = () => {
    const p = hist.current.past.pop();
    if (!p) return;
    hist.current.future.push(JSON.stringify(polygon));
    setPolygonRaw(JSON.parse(p));
  };
  const redo = () => {
    const f = hist.current.future.pop();
    if (!f) return;
    hist.current.past.push(JSON.stringify(polygon));
    setPolygonRaw(JSON.parse(f));
  };
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") { e.preventDefault(); redo(); }
      if (e.key === "Escape") { setDraft([]); setAlineDraft(null); setMode("edit"); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  const replaceBoundary = (pts) => {
    pushHist();
    setPolygonRaw(pts);
    setDraft([]);
    if (pts.length >= 3) setSs(polygonCentroid(pts));
    setFitToken((t) => t + 1);
  };

  const geo = useMemo(() => computeFrameGeometry(module, frame), [module, frame]);

  // Stupid mode: the DC/AC ratio is meaningful only if it sizes the block, so do that
  useEffect(() => {
    if (uiMode !== "stupid" || capacity.kind === "none") return;
    const stringKWp = (elec.modulesPerString * module.power) / 1000;
    if (!(invAcKw > 0) || !(stringKWp > 0)) return;
    const want = Math.max(1, Math.round(((capacity.acRatio || 1.2) * invAcKw) / stringKWp));
    if (want !== elec.stringsPerInverter) setElec({ ...elec, stringsPerInverter: want });
  }, [uiMode, capacity.kind, capacity.acRatio, invAcKw, module.power,
      elec.modulesPerString, elec.stringsPerInverter]);

  const terrain = useMemo(() => (terrainPts ? buildTerrain(terrainPts) : null), [terrainPts]);
  const slopes = useMemo(() => (terrain ? slopeOf(terrain) : null), [terrain]);
  const terrainCtx = useMemo(
    () => (terrain && slopes ? { t: terrain, s: slopes, lim: slopeLim } : null),
    [terrain, slopes, slopeLim]
  );
  const heatCells = useMemo(
    () => (terrain && slopes && showSlope ? heatmapCells(terrain, slopes) : []),
    [terrain, slopes, showSlope]
  );

  const handleImportFile = (file) => {
    if (/\.pdf$/i.test(file.name)) {
      (async () => {
        try {
          ensurePdfWorker();
          const buf = new Uint8Array(await file.arrayBuffer());
          const doc = await pdfjsLib.getDocument({ data: buf, verbosity: 0 }).promise;
          const page = await doc.getPage(1);
          const vp = page.getViewport({ scale: 2 });
          const cnv = document.createElement("canvas");
          cnv.width = vp.width; cnv.height = vp.height;
          await page.render({ canvasContext: cnv.getContext("2d"), viewport: vp }).promise;
          const scale = 1000 / cnv.width; // provisional: page spans 1 km until calibrated
          setBg({ url: cnv.toDataURL("image/png"), wPx: cnv.width, hPx: cnv.height, scale });
          setImportMsg(
            "PDF page 1 placed as an underlay at a provisional scale. Click “Calibrate scale”, " +
            "click two points a known distance apart on the drawing (use its scale bar), enter " +
            "the distance, then trace the boundary over it with the Draw tool."
          );
          try { doc.destroy(); } catch (e) { /* noop */ }
        } catch (e) { setImportMsg(`PDF could not be rendered (${e.message}).`); }
      })();
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result || "");
      try {
        if (/\.dxf$/i.test(file.name)) {
          const raw = parseDxf(text);
          // CAD is Y-up, screen is Y-down
          const polyF = raw.polylines.map((p) => ({
            ...p, pts: p.pts.map((q) => ({ x: q.x, y: -q.y })),
          }));
          const terr = pickTerrainPoints(raw.points);
          const ptsF = terr.pts.map((q) => ({ x: q.x, y: -q.y, z: q.z }));
          const closed = polyF.filter((p) => p.closed && p.pts.length >= 3);

          // one shared origin keeps boundary and terrain registered, and keeps
          // SVG maths away from 6-figure UTM coordinates
          let org = geoOrigin;
          if (!org) {
            const all = [...ptsF, ...closed.flatMap((p) => p.pts)];
            if (all.length) {
              const bb = bboxOf(all);
              org = { x: Math.floor(bb.minX), y: Math.floor(bb.minY) };
              setGeoOrigin(org);
            } else org = { x: 0, y: 0 };
          }
          const shift = (p) => ({ ...p, x: p.x - org.x, y: p.y - org.y });
          const tpAll = ptsF.map(shift);
          const tbb = tpAll.length >= 4 ? bboxOf(tpAll) : null;
          const cand = closed
            .map((p) => ({ ...p, pts: p.pts.map(shift), area: polygonArea(p.pts) }))
            .filter((p) => p.area > 100)
            .map((p) => {
              const n = (p.layer || "").toLowerCase();
              let s = 0;
              if (/site\s*boundary|boundary|red\s*line/.test(n)) s += 4;
              if (/pv\s*area|layout|array|installation/.test(n)) s += 2;
              if (/template|viewport|title|frame|sheet|trunk/.test(n)) s -= 4;
              // a boundary that sits on the terrain is far more likely the right one
              if (tbb) {
                const b = bboxOf(p.pts);
                const ov = !(b.maxX < tbb.minX || b.minX > tbb.maxX ||
                             b.maxY < tbb.minY || b.minY > tbb.maxY);
                s += ov ? 6 : -6;
              }
              return { ...p, s };
            })
            .sort((a, b) => b.s - a.s || b.area - a.area);
          // de-duplicate identical geometry
          const seen = new Set(), uniq = [];
          for (const c of cand) {
            const k = `${Math.round(c.area)}:${c.pts.length}:${Math.round(c.pts[0].x)}`;
            if (seen.has(k)) continue;
            seen.add(k); uniq.push(c);
          }
          setDxfBoundaries(uniq.length ? uniq.slice(0, 8) : null);
          const tp = tpAll;
          if (tp.length >= 4) setTerrainPts(tp);
          if (uniq.length) replaceBoundary(uniq[0].pts); // best guess applied straight away
          const zs = tp.map((p) => p.z);
          setImportMsg(
            `DXF read: ${uniq.length} closed polyline(s), ${fmt(tp.length, 0)} terrain point(s)` +
            (terr.layer ? ` from layer “${terr.layer}”` : "") +
            (terr.dropped ? `, ${terr.dropped} stray point(s) ignored` : "") + "." +
            (tp.length >= 4 ? ` Elevation ${fmt(Math.min(...zs), 0)}–${fmt(Math.max(...zs), 0)} m.` : "") +
            (uniq.length
              ? ` Boundary set to “${uniq[0].layer || "(no layer)"}” — pick another below if that is wrong.`
              : " No closed boundary polyline found.") +
            (org.x || org.y ? ` Coordinates shifted by ${fmt(org.x, 0)}, ${fmt(org.y, 0)} m to keep both layers registered.` : "")
          );
        } else {
          const raw = parseXyzText(text).map((q) => ({ x: q.x, y: -q.y, z: q.z }));
          let org = geoOrigin;
          if (!org && raw.length) {
            const bb = bboxOf(raw);
            org = { x: Math.floor(bb.minX), y: Math.floor(bb.minY) };
            setGeoOrigin(org);
          }
          const pts = raw.map((p) => ({ ...p, x: p.x - (org?.x || 0), y: p.y - (org?.y || 0) }));
          if (pts.length >= 4) { setTerrainPts(pts); setImportMsg(`Terrain: ${fmt(pts.length, 0)} points loaded.`); }
          else setImportMsg("No x,y,z rows found in that file.");
        }
      } catch (err) {
        setImportMsg("Import failed — file could not be parsed.");
      }
    };
    reader.readAsText(file);
  };
  const spf = geo.modules / Math.max(1, elec.modulesPerString);
  const fpi = spf > 0 ? Math.max(1, Math.floor(elec.stringsPerInverter / spf + 1e-9)) : 1;

  const elecWarnings = useMemo(() => {
    const w = [];
    if (!Number.isInteger(spf)) {
      w.push(
        `A full frame holds ${fmt(spf, 2)} strings (${geo.modules} ÷ ${elec.modulesPerString}) — strings will span frames. Block sizing uses the nearest whole number of frames.`
      );
    }
    if (Number.isInteger(spf) && elec.stringsPerInverter % spf !== 0) {
      w.push(
        `${elec.stringsPerInverter} strings per inverter is not a whole number of ${spf}-string frames — blocks of ${fpi} frames load each inverter to ${fpi * spf}/${elec.stringsPerInverter} strings.`
      );
    }
    if (spf > elec.stringsPerInverter) {
      w.push(`One frame carries more strings (${fmt(spf, 1)}) than an inverter accepts (${elec.stringsPerInverter}).`);
    }
    return w;
  }, [spf, fpi, geo.modules, elec]);

  const pitchWarnings = useMemo(() => {
    const w = [];
    if (pitchCfg.rowPitch < geo.planAcross) {
      w.push(`Row pitch (${fmt(pitchCfg.rowPitch)} m) is less than the frame plan width (${fmt(geo.planAcross)} m) — rows overlap.`);
    }
    return w;
  }, [pitchCfg, geo]);

  /* ---- alignment candidates & resolved stagger slope ---- */
  const alignCands = useMemo(() => {
    return alignmentCandidates(polygon)
      .map((c) => ({ ...c, m: slopeForEdge(c.deg, frame.mounting) }))
      .filter((c) => c.m !== null && Math.abs(c.m) > 0.03);
  }, [polygon, frame.mounting]);

  const resolvedAlign = useMemo(() => {
    if (align.mode === "line" && alignLine) {
      let deg = (Math.atan2(alignLine.q.y - alignLine.p.y, alignLine.q.x - alignLine.p.x) * 180 / Math.PI) % 180;
      if (deg < 0) deg += 180;
      const m = slopeForEdge(deg, frame.mounting);
      return { m: m === null ? 0 : m, edge: null, lineInvalid: m === null };
    }
    if (align.mode === "custom") {
      const a = Math.max(-70, Math.min(70, align.custom || 0));
      const mRaw = frame.mounting === "tracker"
        ? Math.tan(rad(a))
        : Math.abs(a) > 0.5 ? Math.tan(rad(90 - Math.abs(a))) * Math.sign(a) : 0;
      const m = Math.max(-2.75, Math.min(2.75, mRaw));
      return { m, edge: null };
    }
    if (align.mode.startsWith("edge")) {
      const c = alignCands[Number(align.mode.slice(4))];
      if (c) return { m: c.m, edge: c.edge };
    }
    return { m: 0, edge: null };
  }, [align, alignCands, frame.mounting, alignLine]);

  /* ---- variant generation (debounced, heavy) ---- */
  const [rawVariants, setRawVariants] = useState([]);
  useEffect(() => {
    const id = setTimeout(() => {
      const out = [];
      if (polygon.length >= 3 && geo.alongLen > 0) {
        const m0 = resolvedAlign.m;
        // resolve capacity target to a common form (blocks or modules budget)
        const cap =
          capacity.kind === "none" ? { kind: "none" } :
          capacity.kind === "inverters" ? { kind: "inverters", value: capacity.inverters } :
          capacity.kind === "ac" || capacity.kind === "acdc" ? {
            // AC capacity fixes the equipment count: one block = one inverter
            kind: "inverters",
            value: invAcKw > 0 ? Math.max(1, Math.ceil((capacity.acMW * 1000) / invAcKw)) : 1,
          } :
          capacity.kind === "modules" ? { kind: "modules", value: capacity.modules } :
          capacity.kind === "strings" ? { kind: "modules", value: capacity.strings * elec.modulesPerString } :
          { kind: "modules", value: Math.floor((capacity.dcMWp * 1e6) / Math.max(1, module.power)) };

        // candidate block shapes: factor pairs of frames-per-inverter,
        // filtered against the site extents, best three by DC-run proxy
        const bb = bboxOf(polygon);
        const vertical = geo.mounting !== "fixed";
        const slotExtent = vertical ? bb.maxY - bb.minY : bb.maxX - bb.minX;
        const laneExtent = vertical ? bb.maxX - bb.minX : bb.maxY - bb.minY;
        const pairs = factorPairs(fpi)
          .map((p) => {
            const lane = (p.w - 1) * pitchCfg.rowPitch + geo.planAcross;
            const slotD = p.d * geo.alongLen + (p.d - 1) * pitchCfg.endGap;
            return { ...p, lane, slotD, proxy: Math.hypot(lane / 2, slotD / 2) };
          })
          .filter((p) => p.slotD <= slotExtent * 0.85 && p.lane <= laneExtent * 0.85)
          .sort((a, b) => a.proxy - b.proxy)
          .slice(0, 3);
        if (!pairs.length) pairs.push({ w: fpi, d: 1 });

        const mk = (name, tags, cfg) => {
          // corridor input is TRUE perpendicular road width; staggered
          // corridors need a larger along-axis gap to keep it constant
          const mS = cfg.stagger || 0;
          const cfgF = { ...cfg, gapSlot: cfg.gapSlot * Math.sqrt(1 + mS * mS), terrain: terrainCtx };
          const r = generateBlockVariant(polygon, geo, cfgF);
          const ann = annotateBlockVariant(r, geo, elec, cfgF.gapSlot);
          const capped = applyCapacityTarget(ann, cap, geo.modules, mS, ss, elec.invertersPerTx);
          out.push({
            name, tags, kind: "block", ...capped, ms: r.ms,
            stagger: mS, roadW: cfg.gapSlot,
          });
        };

        const baseCfg = {
          pitch: pitchCfg.rowPitch, endGap: pitchCfg.endGap, setback: site.setback,
          gapLane: blockCfg.gapLane, gapSlot: blockCfg.gapSlot,
          rowsPerCorridor: blockCfg.rowsPerCorridor, stagger: m0,
        };

        pairs.forEach((p) => {
          mk(`${p.w}×${p.d} uniform blocks`, ["buildability"],
            { ...baseCfg, lanesWide: p.w, framesDeep: p.d, allowNarrow: false });
          mk(`${p.w}×${p.d} + edge in-fill`, ["density", "buildability"],
            { ...baseCfg, lanesWide: p.w, framesDeep: p.d, allowNarrow: true });
        });

        // flat-ground variants: refuse anything needing grading
        const p0 = pairs[0];
        if (terrainCtx) {
          const mkGrade = (name, tags, maxPen, cfg) => {
            const mS = cfg.stagger || 0;
            const ctx = { ...terrainCtx, lim: { ...terrainCtx.lim, maxPen } };
            const cfgF = { ...cfg, gapSlot: cfg.gapSlot * Math.sqrt(1 + mS * mS), terrain: ctx };
            const r = generateBlockVariant(polygon, geo, cfgF);
            const ann = annotateBlockVariant(r, geo, elec, cfgF.gapSlot);
            const capped = applyCapacityTarget(ann, cap, geo.modules, mS, ss, elec.invertersPerTx);
            out.push({ name, tags, kind: "block", ...capped, ms: r.ms, stagger: mS, roadW: cfg.gapSlot });
          };
          for (const p of pairs.slice(0, 2)) {
            const cfg = { ...baseCfg, lanesWide: p.w, framesDeep: p.d, allowNarrow: true };
            mkGrade(`${p.w}×${p.d} light grading`, ["groundworks"], 0.5, cfg);
            mkGrade(`${p.w}×${p.d} flat ground only`, ["groundworks", "no grading"], 0, cfg);
          }
        }

        // a deliberately uniform rectangle: ragged edges trimmed off
        for (const p of pairs.slice(0, 2)) {
          const cfg = { ...baseCfg, lanesWide: p.w, framesDeep: p.d, allowNarrow: false };
          const mS = cfg.stagger || 0;
          const cfgF = { ...cfg, gapSlot: cfg.gapSlot * Math.sqrt(1 + mS * mS), terrain: terrainCtx };
          const r = generateBlockVariant(polygon, geo, cfgF);
          const ann = annotateBlockVariant(r, geo, elec, cfgF.gapSlot);
          const rect = trimToRectangle(ann, elec.invertersPerTx);
          if (rect) {
            const capped = applyCapacityTarget(rect, cap, geo.modules, mS, ss, elec.invertersPerTx);
            out.push({
              name: `${p.w}×${p.d} uniform bands (${rect.blocks.length} blocks)`,
              tags: ["uniform", "buildability"], kind: "block", ...capped,
              ms: r.ms, stagger: mS, roadW: cfg.gapSlot,
            });
          }
        }

        // corridor pattern is a real trade-off: paired rows save land, a road on
        // every row lets substations sit alongside any band and shortens cable
        {
          const alt = blockCfg.rowsPerCorridor === 2 ? 1 : 2;
          const p = pairs[0];
          mk(`${p.w}×${p.d} ${alt === 1 ? "road every row" : "paired rows"}`,
            [alt === 1 ? "shorter cable" : "less road"],
            { ...baseCfg, lanesWide: p.w, framesDeep: p.d, allowNarrow: true, rowsPerCorridor: alt });
        }

        // wide corridors on the most compact shape
        mk(`${p0.w}×${p0.d} wide corridors`, ["access"], {
          ...baseCfg, lanesWide: p0.w, framesDeep: p0.d,
          gapSlot: blockCfg.gapSlot * 1.75, allowNarrow: true,
        });

        // inspiration: the same best shape staggered to the other logical edges
        for (const c of alignCands) {
          if (Math.abs(c.m - m0) < 0.05) continue;
          mk(`${p0.w}×${p0.d} staggered ${c.m > 0 ? "+" : ""}${fmt(c.m, 2)}`,
            [`stagger ${fmt(c.m, 2)}`],
            { ...baseCfg, lanesWide: p0.w, framesDeep: p0.d, allowNarrow: true, stagger: c.m });
        }

        // free fill reference (upper bound on density) at the chosen stagger
        const ff = generateFreeFill(polygon, geo, pitchCfg.rowPitch, pitchCfg.endGap, site.setback, m0, terrainCtx);
        const annF = annotateFreeFill(ff, geo, elec);
        const cappedF = applyCapacityTarget(annF, cap, geo.modules, m0, ss, elec.invertersPerTx);
        out.push({
          name: "Free fill (max density)", tags: ["density", "reference"],
          kind: "free", ...cappedF, ms: ff.ms, stagger: m0, roadW: 0,
        });
      }
      const kept = out.filter((v) => v.frames.length > 0);
      setRawVariants(kept);
      setActiveIdx((i) => Math.min(i, Math.max(0, kept.length - 1)));
    }, 300);
    return () => clearTimeout(id);
  }, [polygon, geo, pitchCfg, site.setback, elec, blockCfg, fpi, resolvedAlign, alignCands,
      capacity, module.power, terrainCtx, invAcKw,
      // substation moves re-run selection only when a target is active
      capacity.kind === "none" ? 0 : `${Math.round(ss.x)}:${Math.round(ss.y)}`]);

  /* ---- metrics, AC, scoring (light, reacts to substation drag) ---- */
  const areaM2 = polygon.length >= 3 ? polygonArea(polygon) : 0;

  const variants = useMemo(() => {
    const vs = rawVariants.map((v, i) => {
      const ac = buildAc(v.blocks, ss, v.vertical, v.stagger, v.laneMid || 0);
      const roads = buildRoads(v.blocks, v.stagger, v.laneMid || 0, v.roadW || 0, v.vertical);
      const txPaths = v.kind === "block" ? txOutlines(v.blocks, v.vertical) : null;
      const dc = dcStats(v.frames, v.blocks);
      const modules = v.frames.reduce((s, f) => s + f.modules, 0);
      const strings = v.frames.reduce((s, f) => s + f.strings, 0);
      const dcMWp = (modules * module.power) / 1e6;
      const inverters = v.blocks.length;
      const fill =
        inverters > 0
          ? v.blocks.reduce((s, b) => s + b.strings, 0) / (inverters * elec.stringsPerInverter)
          : 0;
      const txs = v.blocks.length ? Math.max(...v.blocks.map((b) => b.tx)) + 1 : 0;
      // spatial compactness: block footprint over the bounding box of the build
      let compact = 1;
      if (v.blocks.length) {
        const sbb = bboxOf(v.blocks.flatMap((b) => [{ x: b.x, y: b.y }, { x: b.x + b.w, y: b.y + b.h }]));
        const hull = Math.max(1, (sbb.maxX - sbb.minX) * (sbb.maxY - sbb.minY));
        compact = Math.min(1, v.blocks.reduce((s, b) => s + b.w * b.h, 0) / hull);
      }
      let build;
      if (v.kind === "block") {
        const fullShare = inverters ? v.blocks.filter((b) => b.full).length / inverters : 0;
        build = 0.38 * fullShare + 0.30 * fill + 0.32 * compact;
      } else {
        build = 0.2 * fill + 0.1 * compact; // scattered greedy grouping
      }
      const terrPen = v.frames.length
        ? v.frames.reduce((s2, f) => s2 + (f.pen || 0), 0) / v.frames.length
        : 0;
      const steepN = v.frames.filter((f) => (f.pen || 0) > 0).length;
      const flatShare = v.frames.length ? 1 - steepN / v.frames.length : 1;
      const ci = v.capInfo;
      const met = !ci ? null : ci.targetBlocks !== null
        ? ci.achievedBlocks >= ci.targetBlocks
        : ci.achievedMods >= ci.targetMods * 0.995;
      return {
        ...v, idx: i, met, ac, roads, txPaths, dc, modules, strings, dcMWp, inverters, fill, txs, build,
        compact, terrPen, steepN, flatShare,
        txBoxes: txBoxesOf(v.blocks, v.kind === "block" ? 3 : 2),
        mwKm2: areaM2 > 0 ? (dcMWp * 1e6) / areaM2 : 0,
      };
    });
    // normalised composite score
    const norm = (vals, invert = false) => {
      const ok = vals.filter((x) => x !== null && !Number.isNaN(x));
      const mn = Math.min(...ok), mx = Math.max(...ok);
      return vals.map((x) => {
        if (x === null || Number.isNaN(x)) return 0;
        if (mx - mn < 1e-9) return 0.5;
        const n = (x - mn) / (mx - mn);
        return invert ? 1 - n : n;
      });
    };
    if (vs.length) {
      const nD = norm(vs.map((v) => v.modules));
      const nB = norm(vs.map((v) => v.build));
      const nDC = norm(vs.map((v) => (v.frames.length ? v.dc.avg : null)), true);
      const nAC = norm(vs.map((v) => v.ac.total), true);
      const hasTerr = vs.some((v) => v.terrPen > 0);
      const nT = norm(vs.map((v) => v.terrPen), true);
      vs.forEach((v, i) => {
        v.bonus = v.met === true ? 1000 : 0; // meeting the target outranks everything
        let w;
        if (!hasTerr) {
          w = priority === "capacity" ? { d: 0.55, b: 0.25, dc: 0.20, ac: 0, t: 0 }
            : showSs ? { d: 0.35, b: 0.30, dc: 0.20, ac: 0.15, t: 0 }
            : { d: 0.41, b: 0.35, dc: 0.24, ac: 0, t: 0 };
        } else if (priority === "groundworks") {
          w = { d: 0.18, b: 0.18, dc: 0.09, ac: showSs ? 0.05 : 0, t: showSs ? 0.50 : 0.55 };
        } else if (priority === "capacity") {
          w = { d: 0.52, b: 0.20, dc: 0.10, ac: showSs ? 0.05 : 0, t: showSs ? 0.13 : 0.18 };
        } else {
          w = showSs ? { d: 0.28, b: 0.24, dc: 0.15, ac: 0.10, t: 0.23 }
                     : { d: 0.31, b: 0.27, dc: 0.17, ac: 0, t: 0.25 };
        }
        v.score = Math.round(100 *
          (w.d * nD[i] + w.b * nB[i] + w.dc * nDC[i] + w.ac * nAC[i] + w.t * nT[i]));
      });
    }
    return vs;
  }, [rawVariants, ss, module.power, elec.stringsPerInverter, areaM2, showSs, priority]);

  const recommendedIdx = useMemo(
    () => variants.reduce((best, v, i) =>
      (v.score + (v.bonus || 0) > (variants[best]?.score ?? -1) + (variants[best]?.bonus || 0) ? i : best), 0),
    [variants]
  );
  const cabling = useMemo(() => {
    const v = variants[Math.min(activeIdx, variants.length - 1)];
    if (!v || v.kind !== "block" || !v.blocks.length) return null;
    return planCabling(v.blocks, polygon, v.stagger, v.laneMid, v.vertical, ss, ssOver);
  }, [variants, activeIdx, polygon, ss, ssOver]);

  const feas = useMemo(() => {
    if (capacity.kind === "none" || !variants.length) return null;
    const anyMet = variants.some((v) => v.met === true);
    const bestBlocks = Math.max(...variants.map((v) => v.capInfo?.achievedBlocks ?? v.inverters));
    const tgt = variants.find((v) => v.capInfo)?.capInfo?.targetBlocks ?? null;
    return {
      anyMet, bestBlocks, tgt,
      maxAc: invAcKw > 0 ? (bestBlocks * invAcKw) / 1000 : null,
      bestDc: Math.max(...variants.map((v) => v.dcMWp)),
    };
  }, [variants, capacity.kind, invAcKw]);
  const active = variants[Math.min(activeIdx, variants.length - 1)] || null;

  useEffect(() => {
    if (!onSummary) return;
    const v = variants[Math.min(activeIdx, variants.length - 1)];
    onSummary(v ? {
      name: v.name, modules: v.modules, dcMWp: v.dcMWp, inverters: v.inverters,
      strings: v.strings, frames: v.frames.length, areaM2, flatShare: v.flatShare,
      met: v.met, capInfo: v.capInfo,
      lv: cabling?.lv ?? null, mv: cabling?.mv ?? null,
      combo: cabling?.combo ?? [], spare: cabling?.spare ?? 0,
      roadLen: (v.roads || []).length ? null : null,
      invAcKw,
    } : null);
    // eslint-disable-next-line
  }, [variants, activeIdx, cabling, areaM2, invAcKw]);

  const applyImport = () => {
    const pts = [];
    for (const raw of importText.split(/\n+/)) {
      const line = raw.trim();
      if (!line) continue;
      const m = line.split(/[,\s;\t]+/).map(Number);
      if (m.length < 2 || m.some((n) => Number.isNaN(n))) {
        setImportErr(`Could not read line: “${line}” — expected “x, y” in metres.`);
        return;
      }
      pts.push({ x: m[0], y: m[1] });
    }
    if (pts.length < 3) { setImportErr("Need at least three vertices."); return; }
    setImportErr("");
    replaceBoundary(pts);
  };

  const inverterDcKwp = elec.stringsPerInverter * elec.modulesPerString * module.power / 1000;

  const css = `
    .app * { box-sizing: border-box; }
    .app { --mono: ui-monospace, "Cascadia Code", "SF Mono", Menlo, Consolas, monospace; }
    .app ::-webkit-scrollbar { width: 10px; height: 10px; }
    .app ::-webkit-scrollbar-thumb { background: #333b46; border-radius: 6px; border: 2px solid ${C.panel}; }
    .app ::-webkit-scrollbar-track { background: transparent; }
    .sec { border-bottom: 1px solid ${C.line}; }
    .sec summary { display:flex; align-items:center; gap:10px; padding:11px 16px; cursor:pointer;
      list-style:none; user-select:none; }
    .sec summary::-webkit-details-marker { display:none; }
    .sec-code { font: 600 10px var(--mono); color:${C.accent}; letter-spacing:0.1em; min-width:26px; }
    .sec-title { font: 600 11.5px system-ui, sans-serif; color:${C.text};
      text-transform:uppercase; letter-spacing:0.09em; flex:1; }
    .sec-caret { color:${C.muted}; font-size:10px; transition: transform .15s; }
    .sec[open] .sec-caret { transform: rotate(180deg); }
    .sec-body { padding: 2px 16px 14px; display:flex; flex-wrap:wrap; gap:10px 10px; }
    .fld { display:flex; flex-direction:column; gap:4px; width:calc(50% - 5px); }
    .fld-l { font: 500 10.5px system-ui, sans-serif; color:${C.muted}; letter-spacing:0.02em; }
    .fld-box { display:flex; align-items:center; background:${C.panel2};
      border:1px solid ${C.line}; border-radius:4px; overflow:hidden; }
    .fld-box:focus-within { border-color:${C.accent}; }
    .fld-box input, .fld-box select { flex:1; min-width:0; background:transparent; border:none; outline:none;
      color:${C.text}; font: 12.5px var(--mono); padding:6px 8px; -moz-appearance:textfield; appearance:textfield; }
    .fld-box input::-webkit-outer-spin-button, .fld-box input::-webkit-inner-spin-button { -webkit-appearance:none; margin:0; }
    .fld-box select { appearance:none; -webkit-appearance:none; cursor:pointer; padding-right:16px; }
    .fld-box option { background:${C.panel2}; }
    .fld-u { font: 10px var(--mono); color:${C.muted}; padding:0 8px 0 2px; }
    .readout { width:100%; background:${C.panel2}; border:1px dashed ${C.line}; border-radius:4px;
      padding:7px 10px; font: 11.5px var(--mono); color:${C.text}; line-height:1.55; }
    .readout b { color:${C.accent}; font-weight:600; }
    .warns { width:100%; display:flex; flex-direction:column; gap:6px; }
    .warn { background:#2a2416; border:1px solid #4d3d18; color:${C.warn}; border-radius:4px;
      padding:6px 9px; font: 11px system-ui, sans-serif; line-height:1.45; }
    .btn { background:${C.panel2}; border:1px solid ${C.line}; color:${C.text}; border-radius:4px;
      font: 500 11.5px system-ui, sans-serif; padding:6px 12px; cursor:pointer; }
    .btn:hover { border-color:${C.accent}; }
    .btn.primary { background:${C.accent}; border-color:${C.accent}; color:#181206; font-weight:600; }
    .btn.on { background:${C.accent}; border-color:${C.accent}; color:#181206; font-weight:600; }
    .tbcell { padding: 7px 12px 8px; border-right:1px solid ${C.line}; min-width:76px; }
    .tbl { font: 600 8.5px system-ui, sans-serif; color:${C.muted}; text-transform:uppercase;
      letter-spacing:0.1em; margin-bottom:2px; white-space:nowrap; }
    .tbv { font: 600 14.5px var(--mono); color:${C.text}; white-space:nowrap; }
    .tbv small { font-size:10px; color:${C.muted}; font-weight:500; }
    .legend { display:flex; align-items:center; gap:5px; font: 10.5px system-ui, sans-serif; color:${C.muted};
      white-space:nowrap; }
    .sw { width:14px; height:9px; border-radius:2px; display:inline-block; flex:none; }
    textarea.coords { width:100%; height:88px; background:${C.panel2}; border:1px solid ${C.line};
      border-radius:4px; color:${C.text}; font: 11px var(--mono); padding:8px; resize:vertical; outline:none; }
    textarea.coords:focus { border-color:${C.accent}; }
    .vcard { width:100%; text-align:left; background:${C.panel2}; border:1px solid ${C.line};
      border-radius:5px; padding:9px 11px; cursor:pointer; }
    .vcard:hover { border-color:#4a5462; }
    .vcard.on { border-color:${C.accent}; background:#262117; }
    .vc-top { display:flex; align-items:center; gap:8px; }
    .vc-name { font: 600 12px system-ui, sans-serif; color:${C.text}; flex:1; }
    .vc-score { font: 700 12.5px var(--mono); color:${C.accent}; }
    .vc-tags { display:flex; gap:5px; margin-top:5px; flex-wrap:wrap; }
    .tag { font: 600 9px system-ui, sans-serif; text-transform:uppercase; letter-spacing:0.06em;
      color:${C.muted}; border:1px solid ${C.line}; border-radius:3px; padding:1.5px 6px; }
    .tag.rec { color:#181206; background:${C.accent}; border-color:${C.accent}; }
    .vc-mets { font: 11px var(--mono); color:${C.muted}; margin-top:6px; line-height:1.5; }
    .vc-mets b { color:${C.text}; font-weight:600; }
  `;

  if (reg) reg.current.layout = {
    get: () => ({ polygon, ss, align, alignLine, capacity, blockCfg, pitchCfg, site, slopeLim, terrainPts, showSlope }),
    set: (s) => {
      if (!s) return;
      if (s.polygon) setPolygonRaw(s.polygon);
      if (s.ss) setSs(s.ss);
      if (s.align) setAlign(s.align);
      setAlignLine(s.alignLine ?? null);
      if (s.capacity) setCapacity(s.capacity);
      if (s.blockCfg) setBlockCfg(s.blockCfg);
      if (s.pitchCfg) setPitchCfg(s.pitchCfg);
      if (s.site) setSite(s.site);
      if (s.slopeLim) setSlopeLim(s.slopeLim);
      setTerrainPts(s.terrainPts ?? null);
      if (s.showSlope !== undefined) setShowSlope(s.showSlope);
      setFitToken((t) => t + 1);
    },
  };
  return (
    <div className="app" style={{
      display: "flex", height: "100%", width: "100%", background: C.chrome,
      color: C.text, fontFamily: "system-ui, sans-serif", overflow: "hidden",
    }}>
      <style>{css}</style>

      {/* ================= sidebar ================= */}
      <div className="pv-side" style={{
        width: 356, minWidth: 356, background: C.panel, borderRight: `1px solid ${C.line}`,
        display: narrow && !panelOpen ? "none" : "flex", flexDirection: "column",
      }}>
        <div style={{ padding: "14px 16px 12px", borderBottom: `1px solid ${C.line}` }}>
          <div style={{ font: "700 13px var(--mono)", letterSpacing: "0.04em", color: C.text }}>
            LAYOUT GENERATOR
          </div>
          <div style={{ font: "11px system-ui, sans-serif", color: C.muted, marginTop: 3 }}>
            Phase 3 — staggered rows, paired corridors, frame sizing
          </div>
        </div>

        <div style={{ overflowY: "auto", flex: 1 }}>
          {/* 01 SITE */}
          <Section code="01" title="Site boundary">
            <Num label="Boundary setback" unit="m" value={site.setback} step={0.5} min={0}
              onChange={(v) => setSite({ ...site, setback: v })} />
            <div className="fld" style={{ justifyContent: "flex-end" }}>
              <span className="fld-l">Area</span>
              <div className="readout" style={{ padding: "6px 10px" }}>
                {polygon.length >= 3 ? fmtArea(polygonArea(polygon)) : "—"}
              </div>
            </div>
            {polygon.length >= 3 && terrain && (() => {
              const b = bboxOf(polygon);
              const ov = !(b.maxX < terrain.x0 || b.minX > terrain.x0 + terrain.nx * terrain.cell ||
                           b.maxY < terrain.y0 || b.minY > terrain.y0 + terrain.ny * terrain.cell);
              return ov ? null : (
                <div className="warn" style={{ width: "100%" }}>
                  ⚠ The terrain surface does not overlap this boundary — they are probably in
                  different coordinate systems. Re-import both from the same DXF, or clear the
                  terrain and try again.
                </div>
              );
            })()}
            {polygon.length >= 3 && (() => {
              const bb = bboxOf(polygon);
              const vert = geo.mounting !== "fixed";
              const axisExtent = vert ? bb.maxY - bb.minY : bb.maxX - bb.minX;
              const need = geo.alongLen + 2 * site.setback;
              return axisExtent < need * 1.6 ? (
                <div className="warn" style={{ width: "100%" }}>
                  ⚠ Frames are {fmt(geo.alongLen, 0)} m long but the site is only
                  {" "}{fmt(axisExtent, 0)} m across in that direction, so few rows fit.
                  Shorten the frame (step 3) or check the boundary scale — vertices drawn by
                  hand are in metres at the current zoom.
                </div>
              ) : null;
            })()}
            <div style={{ display: "flex", gap: 8, width: "100%" }}>
              <button className="btn" onClick={() => replaceBoundary(EXAMPLE_BOUNDARY)}>Load example</button>
              <button className="btn" onClick={() => { pushHist(); setPolygonRaw([]); setDraft([]); setMode("draw"); }}>Clear</button>
            </div>
            <div style={{ width: "100%", display: "flex", flexDirection: "column", gap: 8 }}>
              <label className="btn" style={{ textAlign: "center", cursor: "pointer" }}>
                Import DXF / XYZ / CSV (boundary + terrain)
                <input type="file" accept=".dxf,.csv,.xyz,.txt" style={{ display: "none" }}
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) handleImportFile(f); e.target.value = ""; }} />
              </label>
              {importMsg && <div className="readout">{importMsg}
                <br /><span style={{ color: C.muted }}>DWG must be saved as ASCII DXF first (Civil 3D / PVcase: SAVEAS → DXF). Terrain: surface → extract points, or export XYZ.</span>
              </div>}
              {polygon.length < 3 && (
                <div className="readout" style={{ border: `1px solid ${C.accent}55` }}>
                  <b>Start here.</b> Give the tool a site: draw one with the <b>Draw</b> tool
                  (click corners, right-click to close), import a DXF with boundary and
                  terrain, drop in a PDF site plan to trace over — or load the demo to see
                  how everything behaves first.
                  <div style={{ marginTop: 7 }}>
                    <button className="btn primary" onClick={() => {
                      setPolygon([
                        { x: 40, y: 60 }, { x: 620, y: 20 }, { x: 900, y: 240 },
                        { x: 860, y: 700 }, { x: 480, y: 860 }, { x: 90, y: 640 },
                      ]);
                      setImportMsg("Demo site loaded — 0.55 km² greenfield. Try both questions in Stupid mode, or explore the variants below.");
                    }}>Load demo site</button>
                  </div>
                </div>
              )}
              {polygon.length < 3 && (
                <button className="btn" style={{ width: "100%" }} onClick={() => {
                  pushHist();
                  replaceBoundary([
                    { x: 60, y: 40 }, { x: 620, y: 20 }, { x: 780, y: 240 },
                    { x: 700, y: 620 }, { x: 300, y: 700 }, { x: 40, y: 420 },
                  ]);
                  setImportMsg("Demo site loaded — an irregular ~34 ha field. Explore the variants, then draw your own.");
                }}>Load a demo site to see how it works</button>
              )}
              {bg && (
                <div style={{ width: "100%", display: "flex", flexDirection: "column", gap: 6 }}>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    <button className={`btn ${calib.active ? "on" : ""}`}
                      onClick={() => setCalib((c) => ({ ...c, active: !c.active, pts: [] }))}>
                      {calib.active ? "Picking… click 2 points" : "Calibrate scale"}
                    </button>
                    <button className="btn" onClick={() => { setBg(null); setCalib({ active: false, pts: [], dist: 100 }); }}>
                      Remove underlay
                    </button>
                  </div>
                  {calib.pts.length === 2 && (
                    <div style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
                      <Num label="That distance is" unit="m" value={calib.dist} step={10} min={1}
                        onChange={(v) => setCalib((c) => ({ ...c, dist: v }))} />
                      <button className="btn primary" onClick={() => {
                        const [a, b] = calib.pts;
                        const drawn = Math.hypot(b.x - a.x, b.y - a.y);
                        if (drawn > 0.01) {
                          const k = calib.dist / drawn;
                          setBg((g) => ({ ...g, scale: g.scale * k }));
                        }
                        setCalib({ active: false, pts: [], dist: calib.dist });
                      }}>Apply scale</button>
                    </div>
                  )}
                  <div className="readout">
                    PDF site plans carry no real-world coordinates, so the underlay needs one
                    measurement: pick two points spanning the drawing's scale bar (or any known
                    dimension), enter the true distance, then trace the boundary with Draw.
                    Areas and the layout are then genuinely to scale.
                  </div>
                </div>
              )}
              {dxfBoundaries && dxfBoundaries.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 5, width: "100%" }}>
                  <div className="tbl">Boundary candidates — best guess first</div>
                  {dxfBoundaries.map((b, i) => (
                    <button key={i} className="btn" style={{ textAlign: "left" }}
                      onClick={() => replaceBoundary(b.pts)}>
                      <b>{b.layer || "(no layer)"}</b> · {fmtArea(polygonArea(b.pts))} · {b.pts.length} pts
                    </button>
                  ))}
                </div>
              )}
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                <button className="btn" onClick={() => {
                  setTerrainPts(demoTerrain(bboxOf(polygon.length >= 3 ? polygon : EXAMPLE_BOUNDARY)));
                  setImportMsg("Demo rolling-hills surface loaded (synthetic).");
                }}>Load demo terrain</button>
                {terrain && (
                  <button className="btn" onClick={() => { setTerrainPts(null); setImportMsg(""); }}>
                    Clear terrain
                  </button>
                )}
              </div>
              {terrain && (
                <div className="readout">
                  Terrain grid <b>{terrain.nx}×{terrain.ny}</b> at <b>{fmt(terrain.cell, 1)} m</b> ·
                  elevation <b>{fmt(terrain.zmin, 0)}–{fmt(terrain.zmax, 0)} m</b> ·
                  from {fmt(terrain.nPts, 0)} points
                </div>
              )}
            </div>
            <details open style={{ width: "100%" }}>
              <summary style={{ font: "11.5px system-ui, sans-serif", color: C.muted, cursor: "pointer", padding: "2px 0" }}>
                Paste coordinates (x, y in metres — one vertex per line)
              </summary>
              <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
                <textarea className="coords" value={importText}
                  placeholder={"0, 0\n250, 40\n300, 220\n90, 260"}
                  onChange={(e) => setImportText(e.target.value)} />
                {importErr && <div className="warn">⚠ {importErr}</div>}
                <button className="btn" style={{ alignSelf: "flex-start" }} onClick={applyImport}>
                  Apply coordinates
                </button>
              </div>
            </details>
          </Section>

          {uiMode === "stupid" && (
            <Section code="02" title="The basics">
              <Sel label="Mounting" width="100%" value={frame.mounting}
                options={[
                  { value: "tracker", label: "Single-axis tracker (N–S axis)" },
                  { value: "fixed", label: "Fixed tilt (rows facing the equator)" },
                  { value: "ew", label: "East–West duo" },
                ]}
                onChange={(v) => setFrame({ ...frame, mounting: v })} />
              {frame.mounting !== "tracker" && (
                <Num label="Tilt" unit="°" value={frame.tilt} step={1} min={0} max={60}
                  onChange={(v) => setFrame({ ...frame, tilt: v })} />
              )}
              <div className="tbl" style={{ width: "100%", marginTop: 2 }}>THE KIT</div>
              <Num label="Module power" unit="W" value={module.power} step={5} min={100}
                onChange={(v) => setModule({ ...module, power: v, pmax: v })} />
              <Num label="Module length" unit="m" value={module.length} step={0.01} min={1}
                onChange={(v) => setModule({ ...module, length: v })} />
              <Num label="Module width" unit="m" value={module.width} step={0.01} min={0.5}
                onChange={(v) => setModule({ ...module, width: v })} />
              <Num label="Inverter AC" unit="kVA" value={inv?.acKva || 0} step={10} min={10}
                onChange={(v) => setInv && setInv({ ...inv, acKva: v })} />
              <details style={{ width: "100%" }}>
                <summary style={{ font: "11.5px system-ui", color: C.accent, cursor: "pointer" }}>
                  …or read them from datasheets (PDF or paste)
                </summary>
                <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
                  <div className="tbl">MODULE DATASHEET</div>
                  <DatasheetPanel kind="module" kindLabel="module" current={module}
                    onApply={(p) => setModule({ ...module, ...p, power: p.pmax ?? module.power })} />
                  <div className="tbl">INVERTER DATASHEET</div>
                  <DatasheetPanel kind="inverter" kindLabel="inverter" current={inv || {}}
                    onApply={(p) => setInv && setInv({ ...inv, ...p })} />
                </div>
              </details>
              <Sel label="Question" width="100%" value={capacity.kind === "none" ? "A" : "B"}
                options={[
                  { value: "A", label: "How much fits on this site?" },
                  { value: "B", label: "Can it meet an AC target?" },
                ]}
                onChange={(v) => setCapacity({ ...capacity, kind: v === "A" ? "none" : "acdc" })} />
              {capacity.kind !== "none" && (<>
                <Num label="Target AC" unit="MWac" value={capacity.acMW} step={0.5} min={0.1}
                  onChange={(v) => setCapacity({ ...capacity, acMW: v })} />
                <Num label="DC/AC ratio" value={capacity.acRatio} step={0.05} min={1}
                  onChange={(v) => setCapacity({ ...capacity, acRatio: v })} />
              </>)}
              <div className="readout">
                {capacity.kind === "none"
                  ? <>Draw or import a boundary and the variants below show how much this land
                      can carry. Module, inverter and frame are at sensible defaults
                      ({module.power} W modules, {fmt(invAcKw, 0)} kVA inverters,
                      {" "}{geo.modules} per frame) — switch to Engineer to change them.</>
                  : <>{fmt(capacity.acMW, 2)} MWac ÷ {fmt(invAcKw, 0)} kVA →
                      {" "}<b>{invAcKw > 0 ? Math.ceil(capacity.acMW * 1000 / invAcKw) : "—"} inverters</b>,
                      each sized to DC/AC <b>{fmt(capacity.acRatio, 2)}</b>
                      {" "}(<b>{fmt(fpi * geo.modules * module.power / 1e6, 2)} MWdc</b> per block,
                      {" "}{fpi} frames). The verdict is below.</>}
              </div>
            </Section>
          )}

          {/* 01B TERRAIN LIMITS */}
          {terrain && uiMode !== "stupid" && (
            <Section code="1B" title="Gradient limits">
              <Num label="Hard limit — along axis" unit="%" value={slopeLim.hardAlong} step={0.5} min={0}
                onChange={(v) => setSlopeLim({ ...slopeLim, hardAlong: v })} />
              <Num label="Soft limit — along axis" unit="%" value={slopeLim.softAlong} step={0.5} min={0}
                onChange={(v) => setSlopeLim({ ...slopeLim, softAlong: v })} />
              <Num label="Hard limit — across axis" unit="%" value={slopeLim.hardCross} step={0.5} min={0}
                onChange={(v) => setSlopeLim({ ...slopeLim, hardCross: v })} />
              <Num label="Soft limit — across axis" unit="%" value={slopeLim.softCross} step={0.5} min={0}
                onChange={(v) => setSlopeLim({ ...slopeLim, softCross: v })} />
              <Sel label="Priority for the recommendation" width="100%" value={priority}
                options={[
                  { value: "balanced", label: "Balanced — capacity vs groundworks" },
                  { value: "groundworks", label: "Minimise groundworks (favour flat ground)" },
                  { value: "capacity", label: "Maximise capacity (accept grading)" },
                ]}
                onChange={setPriority} />
              <div className="readout">
                A <b>flat ground only</b> variant is generated alongside the others: it refuses
                any frame that would need grading at all, trading capacity for zero earthworks.
                The priority above decides which trade-off the ★ recommendation makes.
              </div>
              <div className="readout">
                Gradient resolves into the two planes that matter: ALONG the frame axis
                ({frame.mounting !== "fixed" ? "N–S" : "E–W"} — articulated frames tolerate more)
                and ACROSS it ({frame.mounting !== "fixed" ? "E–W" : "N–S"} — the tube/table must
                stay level, so the limit is tighter). Above a hard limit a frame is rejected
                outright; between soft and hard it places with a linearly graded penalty that
                feeds the variant score and pushes Mode B clusters onto flatter ground.
                Steep-but-allowed frames outline amber.
              </div>
            </Section>
          )}

          {uiMode === "engineer" && (<>
          {/* 02 MODULE */}
          <Section code="02" title="Module">
            <Num label="Length" unit="m" value={module.length} step={0.001} min={0.1}
              onChange={(v) => setModule({ ...module, length: v })} />
            <Num label="Width" unit="m" value={module.width} step={0.001} min={0.1}
              onChange={(v) => setModule({ ...module, width: v })} />
            <Num label="Rated power" unit="Wp" value={module.power} step={5} min={1}
              onChange={(v) => setModule({ ...module, power: v })} />
          </Section>

          {/* 03 FRAME */}
          <Section code="03" title="Mounting frame">
            <Sel label="Mounting" value={frame.mounting}
              options={[
                { value: "tracker", label: "Single-axis tracker (axis N–S)" },
                { value: "fixed", label: "Fixed tilt (rows E–W, facing equator)" },
                { value: "ew", label: "East–West duo (rows N–S, faces E+W)" },
              ]}
              onChange={(v) => setFrame({ ...frame, mounting: v })} />
            <Sel label="Configuration" value={String(frame.config)}
              options={[
                { value: "1", label: "1P — one module across" },
                { value: "2", label: "2P — two modules across" },
                { value: "3", label: "3P — three modules across" },
                { value: "4", label: "4P — four modules across" },
              ]}
              onChange={(v) => setFrame({ ...frame, config: Number(v) })} />
            <Sel label="Module orientation" value={frame.orientation}
              options={[
                { value: "portrait", label: "Portrait (long side across axis)" },
                { value: "landscape", label: "Landscape (long side along axis)" },
              ]}
              onChange={(v) => setFrame({ ...frame, orientation: v })} />
            <Sel label="Frame sizing" value={frame.sizeMode}
              options={[
                { value: "count", label: "By module count" },
                { value: "length", label: "By max frame length" },
              ]}
              onChange={(v) => setFrame({ ...frame, sizeMode: v })} />
            {frame.sizeMode === "count" ? (
              <Num label="Modules per frame" value={frame.modulesPerFrame} step={1} min={1}
                onChange={(v) => setFrame({ ...frame, modulesPerFrame: Math.round(v) })} />
            ) : (
              <Num label="Max frame length" unit="m" value={frame.maxLength} step={0.5} min={1}
                onChange={(v) => setFrame({ ...frame, maxLength: v })} />
            )}
            <Num label="Module-to-module gap" unit="m" value={frame.gapAlong} step={0.005} min={0}
              onChange={(v) => setFrame({ ...frame, gapAlong: v })} />
            <Num label="Cross gap (2P/3P stack)" unit="m" value={frame.crossGap} step={0.005} min={0}
              onChange={(v) => setFrame({ ...frame, crossGap: v })} />
            <Num label="End overhang (each end)" unit="m" value={frame.endOverhang} step={0.05} min={0}
              onChange={(v) => setFrame({ ...frame, endOverhang: v })} />
            <Num label="Central structural gap" unit="m" value={frame.centreGap} step={0.05} min={0}
              onChange={(v) => setFrame({ ...frame, centreGap: v })} />
            <Num label="Ground clearance (low edge)" unit="m" value={frame.clearance} step={0.05} min={0}
              onChange={(v) => setFrame({ ...frame, clearance: v })} />
            {frame.mounting !== "tracker" && (
              <Num label="Tilt angle" unit="°" value={frame.tilt} step={1} min={0} max={60}
                onChange={(v) => setFrame({ ...frame, tilt: v })} />
            )}
            {frame.mounting === "tracker" && (
              <Num label="Max rotation" unit="°" value={frame.maxRot} step={5} min={10} max={90}
                onChange={(v) => setFrame({ ...frame, maxRot: v })} />
            )}
            {frame.mounting === "ew" && (
              <Num label="Ridge gap (between E/W faces)" unit="m" value={frame.ridgeGap} step={0.05} min={0}
                onChange={(v) => setFrame({ ...frame, ridgeGap: v })} />
            )}
            <div className="readout">
              Frame envelope&nbsp;
              <b>{fmtDim(geo.alongLen)} m</b> along axis × <b>{fmtDim(geo.acrossW)} m</b> across
              {frame.mounting === "fixed" && <> · plan depth <b>{fmtDim(geo.planAcross)} m</b></>}
              <br />
              {frame.sizeMode === "length"
                ? <><b>{geo.modules}</b> modules fit within {fmt(frame.maxLength, 1)} m ({geo.nP}P × {geo.alongCount})</>
                : <>{geo.modules} modules</>}
              &nbsp;· {fmt((geo.modules * module.power) / 1000, 2)} kWp per frame
            </div>
            <WarnList items={geo.warnings} />
          </Section>

          {/* 04 DRAWING */}
          <Section code="04" title="Frame drawing (live)">
            <div style={{ width: "100%" }}>
              <FrameDiagram geo={geo} stringsPerFrame={spf} />
            </div>
          </Section>

          {/* 05 PITCH & ALIGNMENT */}
          <Section code="05" title="Array pitch & alignment">
            <Sel label="Define spacing by" value={pitchCfg.spacingMode || "pitch"}
              options={[
                { value: "pitch", label: "Pitch (centre to centre)" },
                { value: "gap", label: "Clear gap (edge to edge)" },
              ]}
              onChange={(v) => setPitchCfg({ ...pitchCfg, spacingMode: v })} />
            {(pitchCfg.spacingMode || "pitch") === "pitch" ? (
              <Num
                label={frame.mounting !== "fixed" ? "Row pitch (E–W, centres)" : "Row pitch (N–S, centres)"}
                unit="m" value={pitchCfg.rowPitch} step={0.1} min={0.1}
                onChange={(v) => setPitchCfg({ ...pitchCfg, rowPitch: v })} />
            ) : (
              <Num label="Clear gap between rows" unit="m"
                value={Math.max(0, Math.round((pitchCfg.rowPitch - geo.planAcross) * 100) / 100)}
                step={0.1} min={0}
                onChange={(v) => setPitchCfg({ ...pitchCfg, rowPitch: v + geo.planAcross })} />
            )}
            <div style={{ width: "100%" }}><RowSpacing geo={geo} pitch={pitchCfg.rowPitch} /></div>
            <Num
              label={frame.mounting !== "fixed" ? "End gap (N–S, frame to frame)" : "End gap (E–W, frame to frame)"}
              unit="m" value={pitchCfg.endGap} step={0.1} min={0}
              onChange={(v) => setPitchCfg({ ...pitchCfg, endGap: v })} />
            <Sel label="Row stagger (frames stay true N–S)" width="100%" value={align.mode}
              options={[
                { value: "north", label: "None — square grid" },
                ...(alignLine ? [{ value: "line", label: "Drawn alignment line (drag to move/rotate)" }] : []),
                ...alignCands.map((c, i) => ({
                  value: `edge${i}`,
                  label: `Follow boundary edge ${i + 1} (slope ${c.m > 0 ? "+" : ""}${fmt(c.m, 2)})`,
                })),
                { value: "custom", label: "Custom stagger angle" },
              ]}
              onChange={(v) => setAlign({ ...align, mode: v })} />
            {align.mode === "custom" && (
              <Num label="Alignment line angle (from E–W)" unit="°" value={align.custom} step={1} min={-70} max={70}
                onChange={(v) => setAlign({ ...align, custom: v })} />
            )}
            <div className="readout">
              GCR <b>{fmt(pitchCfg.rowPitch > 0 ? geo.collectW / pitchCfg.rowPitch : 0, 3)}</b>
              &nbsp;· clear gap between rows&nbsp;
              <b>{fmtDim(Math.max(0, pitchCfg.rowPitch - geo.planAcross))} m</b>
              <br />
              Every frame stays aligned to the true {frame.mounting !== "fixed" ? "N–S axis" : "E–W rows"} for
              tracking/yield — stagger only slides frame ends along the axis
              {Math.abs(resolvedAlign.m) > 0.03 && <> (current slope <b>{fmt(resolvedAlign.m, 2)}</b>, line in purple)</>}.
              {align.mode === "line" && resolvedAlign.lineInvalid &&
                <><br />⚠ Drawn line is too close to the frame axis (or too steep) — no stagger applied.</>}
            </div>
            <WarnList items={pitchWarnings} />
          </Section>

          {/* 06 ELECTRICAL */}
          <Section code="06" title="Electrical grouping">
            <Num label="Modules per string" value={elec.modulesPerString} step={1} min={1}
              onChange={(v) => setElec({ ...elec, modulesPerString: Math.round(v) })} />
            <Num label="Strings per inverter" value={elec.stringsPerInverter} step={1} min={1}
              onChange={(v) => setElec({ ...elec, stringsPerInverter: Math.round(v) })} />
            <Num label="Inverters per transformer (ways)" value={elec.invertersPerTx} step={1} min={1}
              onChange={(v) => setElec({ ...elec, invertersPerTx: Math.round(v) })} />
            <div className="readout">
              <b>{fmt(spf, 2)}</b> strings per frame → inverter block of <b>{fpi}</b> frames
              <br />
              block DC <b>{fmt(fpi * spf * elec.modulesPerString * module.power / 1000, 0)} kWp</b>
              {invAcKw > 0 && <> · DC/AC <b>{fmt(inverterDcKwp / invAcKw, 2)}</b></>}
            </div>
            <WarnList items={elecWarnings} />
          </Section>

          </>)}
          {/* 07 TARGET */}
          {uiMode !== "stupid" && (
          <Section code="07" title="Optimisation target">
            <Sel label="Mode" width="100%" value={capacity.kind === "none" ? "A" : "B"}
              options={[
                { value: "A", label: "A — Maximise capacity (fill the site)" },
                { value: "B", label: "B — Meet design target" },
              ]}
              onChange={(v) => setCapacity({ ...capacity, kind: v === "A" ? "none" : "acdc" })} />
            {capacity.kind !== "none" && (
              <Sel label="Target type" width="100%" value={capacity.kind}
                options={[
                  { value: "acdc", label: "AC target × DC/AC ratio (common case)" },
                  { value: "dc", label: "DC capacity (MWdc)" },
                  { value: "ac", label: "AC capacity (MWac)" },
                  { value: "modules", label: "Number of modules" },
                  { value: "strings", label: "Number of strings" },
                  { value: "inverters", label: "Number of inverters" },
                ]}
                onChange={(v) => setCapacity({ ...capacity, kind: v })} />
            )}
            {capacity.kind === "dc" && (
              <Num label="Target DC" unit="MWdc" value={capacity.dcMWp} step={0.1} min={0.1}
                onChange={(v) => setCapacity({ ...capacity, dcMWp: v })} />
            )}
            {capacity.kind === "acdc" && (<>
              <Num label="Target AC" unit="MWac" value={capacity.acMW} step={0.1} min={0.1}
                onChange={(v) => setCapacity({ ...capacity, acMW: v })} />
              <Num label="DC/AC ratio" value={capacity.acRatio} step={0.05} min={1}
                onChange={(v) => setCapacity({ ...capacity, acRatio: v })} />
            </>)}
            {capacity.kind === "ac" && (
              <Num label="Target AC" unit="MWac" value={capacity.acMW} step={0.1} min={0.1}
                onChange={(v) => setCapacity({ ...capacity, acMW: v })} />
            )}
            {capacity.kind === "modules" && (
              <Num label="Target modules" value={capacity.modules} step={100} min={1}
                onChange={(v) => setCapacity({ ...capacity, modules: Math.round(v) })} />
            )}
            {capacity.kind === "strings" && (
              <Num label="Target strings" value={capacity.strings} step={10} min={1}
                onChange={(v) => setCapacity({ ...capacity, strings: Math.round(v) })} />
            )}
            {capacity.kind === "inverters" && (
              <Num label="Target inverters" value={capacity.inverters} step={1} min={1}
                onChange={(v) => setCapacity({ ...capacity, inverters: Math.round(v) })} />
            )}
            {capacity.kind !== "none" && (
              <div className="readout">
                {(() => {
                  if (capacity.kind === "acdc" || capacity.kind === "ac") {
                    const nInv = invAcKw > 0 ? Math.ceil((capacity.acMW * 1000) / invAcKw) : 0;
                    const blockDc = fpi * geo.modules * module.power / 1000;
                    const dc = nInv * blockDc / 1000;
                    const ratio = capacity.acMW > 0 ? dc / capacity.acMW : 0;
                    const want = capacity.acRatio || 1.2;
                    return <>
                      {fmt(capacity.acMW, 2)} MWac ÷ {fmt(invAcKw, 0)} kVA →
                      {" "}<b>{nInv} inverters</b> · {fmt(nInv * fpi, 0)} frames ·
                      {" "}<b>{fmt(dc, 2)} MWdc</b>{capacity.kind === "acdc" && <> (DC/AC <b>{fmt(ratio, 2)}</b>)</>}
                      {capacity.kind === "acdc" && Math.abs(ratio - want) > 0.04 && (
                        <><br />⚠ That lands at DC/AC {fmt(ratio, 2)}, not {fmt(want, 2)} —
                          change strings per inverter in step 5 to shift it.</>
                      )}
                      {invAcKw <= 0 && <><br />⚠ Set the inverter AC rating in step 2.</>}
                      <br />All <b>{nInv}</b> inverter blocks must fit or the target is not met.
                    </>;
                  }
                  const mods =
                    capacity.kind === "dc" ? Math.floor(capacity.dcMWp * 1e6 / Math.max(1, module.power)) :
                    capacity.kind === "modules" ? capacity.modules :
                    capacity.kind === "strings" ? capacity.strings * elec.modulesPerString :
                    capacity.kind === "ac" ? (invAcKw > 0 ? Math.round(capacity.acMW * 1000 / invAcKw) * fpi * geo.modules : 0) :
                    capacity.inverters * fpi * geo.modules;
                  return <>
                    ≈ <b>{fmt(mods, 0)}</b> modules · <b>{fmt(mods / Math.max(1, geo.modules), 0)}</b> frames ·
                    &nbsp;<b>{fmt(mods * module.power / 1e6, 2)} MWdc</b>
                    {capacity.kind === "ac" && invAcKw <= 0 &&
                      <><br />⚠ set the inverter AC rating in section 06 for an AC target.</>}
                    <br />The optimiser places the full candidate set, then keeps the most
                    compact cluster meeting the target (full blocks preferred, AC extent minimised).
                  </>;
                })()}
              </div>
            )}
          </Section>

          )}
          {uiMode === "engineer" && (<>
          {/* 08 BLOCKS */}
          <Section code="08" title="Blocks & corridors">
            <Num
              label={frame.mounting !== "fixed" ? "Block gap (E–W)" : "Block gap (N–S)"}
              unit="m" value={blockCfg.gapLane} step={0.5} min={0}
              onChange={(v) => setBlockCfg({ ...blockCfg, gapLane: v })} />
            <Num
              label="Road width (true perpendicular)"
              unit="m" value={blockCfg.gapSlot} step={0.5} min={0}
              onChange={(v) => setBlockCfg({ ...blockCfg, gapSlot: v })} />
            <Sel label="Access corridors" width="100%" value={String(blockCfg.rowsPerCorridor)}
              options={[
                { value: "2", label: "Every two block rows (paired, shared roads)" },
                { value: "1", label: "Every block row" },
              ]}
              onChange={(v) => setBlockCfg({ ...blockCfg, rowsPerCorridor: Number(v) })} />
            <label className="chk" style={{ display: "flex", alignItems: "center", gap: 8,
              width: "100%", font: "12px system-ui", color: C.text, cursor: "pointer" }}>
              <input type="checkbox" checked={showSs} style={{ accentColor: C.accent }}
                onChange={(e) => setShowSs(e.target.checked)} />
              Show substations and routed cabling
            </label>
            <div className="readout">
              Block shapes are explored automatically from the {fpi}-frame inverter block.
              With paired rows, the two rows sit end-gap apart with no road between —
              inverters face outward to the shared corridors top and bottom, which carry
              access and the AC runs. Drag <b>SS</b> to move the substation.
            </div>
          </Section>

          </>)}
          {uiMode === "stupid" && (
            <div className="readout" style={{ margin: "10px 16px 0", width: "calc(100% - 32px)" }}>
              <b>Stupid mode.</b> Draw a boundary, pick a mounting type, optionally set an AC
              target — read the answer. Everything else is a sensible default: good enough to
              say “that fits” or “that doesn’t”, not good enough to build from.
            </div>
          )}
          {/* 08 VARIANTS */}
          <Section code="09" title="Design variants">
            {feas && (
              <div style={{
                width: "100%", borderRadius: 5, padding: "9px 12px",
                background: feas.anyMet ? "rgba(47,158,68,0.12)" : "rgba(214,69,69,0.12)",
                border: `1px solid ${feas.anyMet ? "rgba(47,158,68,0.5)" : "rgba(214,69,69,0.5)"}`,
                font: "11.5px/1.5 system-ui, sans-serif",
                color: feas.anyMet ? "#7fd694" : "#e08b8b",
              }}>
                <b style={{ font: "700 12px system-ui", letterSpacing: "0.04em" }}>
                  {feas.anyMet ? "✓ TARGET ACHIEVABLE" : "✕ TARGET NOT ACHIEVABLE ON THIS SITE"}
                </b>
                <br />
                {feas.tgt !== null
                  ? (feas.anyMet
                      ? <>All <b>{feas.tgt}</b> inverter blocks fit — see the starred variant.</>
                      : <>Only <b>{feas.bestBlocks}</b> of <b>{feas.tgt}</b> blocks fit
                          {feas.maxAc !== null && <> — the site caps out near <b>{fmt(feas.maxAc, 2)} MWac</b></>}.
                          More land, tighter pitch, or a smaller target is needed.</>)
                  : (feas.anyMet
                      ? <>The target is met.</>
                      : <>The site tops out near <b>{fmt(feas.bestDc, 2)} MWdc</b>.</>)}
              </div>
            )}
            {variants.length === 0 && (
              <div className="readout">
                No variants — define a boundary, or the frame/pitch doesn't fit the site.
              </div>
            )}
            {variants.map((v) => (
              <button key={v.idx} className={`vcard ${active && v.idx === active.idx ? "on" : ""}`}
                onClick={() => setActiveIdx(v.idx)}>
                <div className="vc-top">
                  <span className="vc-name">{String.fromCharCode(65 + v.idx)} — {v.name}</span>
                  <span className="vc-score">{v.score}</span>
                </div>
                <div className="vc-tags">
                  {v.idx === recommendedIdx && <span className="tag rec">★ recommended</span>}
                  {v.tags.map((t) => <span key={t} className="tag">{t}</span>)}
                </div>
                <div className="vc-mets">
                  <b>{fmt(v.dcMWp, 2)} MWp</b> · {fmt(v.modules, 0)} mod · {v.inverters} inv
                  ({fmt(v.fill * 100, 0)}% fill){showSs && <> · {v.txs} tx</>}
                  <br />
                  DC run <b>{fmt(v.dc.avg, 0)} m</b> avg ·
                  {showSs && <>AC {v.ac.total === null ? "—" : <b> {fmtKm(v.ac.total)}</b>} · </>}
                  <span title="Buildability: full inverter blocks, fill and compactness combined">build <b>{fmt(v.build * 100, 0)}</b></span> · <span title="Block footprint over the bounding box of the build — higher means tighter, more constructable grouping">grouped <b>{fmt(v.compact * 100, 0)}%</b></span>
                  {terrain && <> · <b>{fmt(v.flatShare * 100, 0)}%</b> on flat ground
                    {v.steepN > 0 && <> ({v.steepN} need grading)</>}</>}
                  {v.capInfo && (
                    <>
                      <br />
                      {v.capInfo.short
                        ? <span style={{ color: C.warn }}>⚠ site limit — target not reachable</span>
                        : v.capInfo.targetBlocks !== null
                          ? <>target <b>{v.capInfo.achievedBlocks}/{v.capInfo.targetBlocks}</b> inverters</>
                          : <>target <b>{fmt(v.capInfo.achievedMods, 0)}/{fmt(v.capInfo.targetMods, 0)}</b> modules
                              ({fmt(100 * v.capInfo.achievedMods / v.capInfo.targetMods, 1)}%)</>}
                    </>
                  )}
                </div>
              </button>
            ))}
            <div className="readout">
              Score weighs density, buildability{showSs && <>, DC and AC cable runs</>}
              {!showSs && <> and DC cable runs</>}
              {variants.some((v) => v.terrPen > 0) && <>, and gradient penalty</>},
              normalised across the set. Treat it as a sorting aid, not a verdict.
            </div>
          </Section>
        </div>
      </div>

      {/* ================= viewport column ================= */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        <div style={{
          display: "flex", alignItems: "center", gap: 8, padding: "8px 12px",
          background: C.panel, borderBottom: `1px solid ${C.line}`, flexWrap: "wrap",
        }}>
          {narrow && (
            <button className={`btn ${panelOpen ? "on" : ""}`}
              onClick={() => setPanelOpen(!panelOpen)}>{panelOpen ? "✕ Inputs" : "☰ Inputs"}</button>
          )}
          {["draw", "edit", "pan"].map((m) => (
            <button key={m} className={`btn ${mode === m ? "on" : ""}`}
              onClick={() => { setMode(m); setDraft([]); setAlineDraft(null); }}>
              {m === "draw" ? "Draw boundary" : m === "edit" ? "Edit" : "Pan"}
            </button>
          ))}
          <button className={`btn ${mode === "aline" ? "on" : ""}`}
            style={{ borderColor: mode === "aline" ? undefined : "#7a2bd6" }}
            onClick={() => { setMode("aline"); setAlineDraft(null); }}>
            {alignLine ? "Redraw align line" : "Draw align line"}
          </button>
          <button className={`btn ${view3d ? "on" : ""}`} onClick={() => setView3d(!view3d)}>
            {view3d ? "2D plan" : "3D view"}
          </button>
          <button className="btn" onClick={undo} title="Ctrl+Z">↶</button>
          <button className="btn" onClick={redo} title="Ctrl+Y">↷</button>
          {alignLine && (
            <button className="btn" onClick={() => {
              setAlignLine(null);
              setAlign((a) => (a.mode === "line" ? { ...a, mode: "north" } : a));
            }}>
              Clear line
            </button>
          )}
          {mode === "draw" && draft.length >= 3 && (
            <button className="btn primary"
              onClick={() => { replaceBoundary(draft); setMode("edit"); }}>
              Close boundary
            </button>
          )}
          <div style={{ flex: 1 }} />
          <span className="hide-narrow" style={{ font: "11px system-ui, sans-serif", color: C.muted }}>
            scroll to zoom · drag to pan · double-click a vertex to delete
          </span>
          {terrain && (
            <button className={`btn ${showSlope ? "on" : ""}`}
              onClick={() => setShowSlope(!showSlope)}>Slope map</button>
          )}
          <button className="btn" onClick={() => setFitToken((t) => t + 1)}>Fit view</button>
        </div>

        {view3d ? (
          <Iso3D variant={active} geo={geo} polygon={polygon} terrain={terrain} slopes={slopes}
            tiltDeg={frame.mounting === "tracker" ? 30 : frame.tilt} />
        ) : (
        <SiteCanvas
          polygon={polygon} setPolygon={setPolygonRaw}
          mode={mode} setMode={setMode}
          draft={draft} setDraft={setDraft}
          variant={active} geo={geo} viewFitToken={fitToken}
          ss={ss} setSs={setSs} alignEdge={resolvedAlign.edge}
          alignLine={alignLine} setAlignLine={setAlignLine}
          alineDraft={alineDraft} setAlineDraft={setAlineDraft}
          heatCells={heatCells} onBeforeEdit={pushHist} showSs={showSs}
          cabling={cabling} setSsOver={setSsOver}
          bg={bg} calib={calib}
          onCalibPick={(p) => setCalib((c) => ({ ...c, pts: [...c.pts.slice(-1), p].slice(-2) }))}
        />
        )}

        {/* title block */}
        <div style={{
          display: "flex", alignItems: "stretch", background: C.panel,
          borderTop: `1px solid ${C.line}`, overflowX: "auto",
        }}>
          <div className="tbcell" style={{ minWidth: 150 }}>
            <div className="tbl">Variant</div>
            <div className="tbv" style={{ fontSize: 12.5 }}>
              {active ? `${String.fromCharCode(65 + active.idx)} — ${active.name}` : "—"}
            </div>
          </div>
          <div className="tbcell">
            <div className="tbl">Modules</div>
            <div className="tbv">{active ? fmt(active.modules, 0) : "—"}</div>
          </div>
          <div className="tbcell">
            <div className="tbl">DC capacity</div>
            <div className="tbv">{active ? fmt(active.dcMWp, 2) : "—"} <small>MWp</small></div>
          </div>
          <div className="tbcell">
            <div className="tbl">Strings</div>
            <div className="tbv">{active ? fmt(active.strings, 1) : "—"}</div>
          </div>
          <div className="tbcell">
            <div className="tbl">Inverters</div>
            <div className="tbv">
              {active ? active.inverters : "—"}{" "}
              <small>{active ? `${fmt(active.fill * 100, 0)}% fill` : ""}</small>
            </div>
          </div>

          <div className="tbcell">
            <div className="tbl">Frames</div>
            <div className="tbv">{active ? fmt(active.frames.length, 0) : "—"}</div>
          </div>
          <div className="tbcell">
            <div className="tbl">Site area</div>
            <div className="tbv">{areaVal(areaM2)} <small>{areaUnit(areaM2)}</small></div>
          </div>
          <div className="tbcell">
            <div className="tbl">DC density</div>
            <div className="tbv">
              {active && areaM2 > 0 ? fmt(active.mwKm2, 1) : "—"} <small>MW/km²</small>
            </div>
          </div>
          <div className="tbcell">
            <div className="tbl">DC run avg</div>
            <div className="tbv">{active && active.frames.length ? fmt(active.dc.avg, 0) : "—"} <small>m</small></div>
          </div>
          {showSs && (
            <>
              <div className="tbcell">
                <div className="tbl">LV route</div>
                <div className="tbv">{cabling ? fmtKm(cabling.lv) : "—"}</div>
              </div>
              <div className="tbcell">
                <div className="tbl">MV route</div>
                <div className="tbv">{cabling ? fmtKm(cabling.mv) : "—"}</div>
              </div>
              <div className="tbcell">
                <div className="tbl">Substations</div>
                <div className="tbv" style={{ fontSize: 12.5 }}>
                  {cabling && cabling.combo.length ? cabling.combo.join("+") : "—"}
                </div>
              </div>
            </>
          )}
          <div className="tbcell">
            <div className="tbl">Score</div>
            <div className="tbv" style={{ color: C.accent }}>{active ? active.score : "—"}</div>
          </div>
          {capacity.kind !== "none" && (
            <div className="tbcell">
              <div className="tbl">Target</div>
              <div className="tbv" style={{
                fontSize: 12.5,
                color: active?.met === true ? "#7fd694" : active?.met === false ? "#e08b8b" : C.text,
              }}>
                {active?.capInfo
                  ? active.capInfo.short
                    ? "site limit"
                    : active.capInfo.targetBlocks !== null
                      ? `${active.capInfo.achievedBlocks}/${active.capInfo.targetBlocks} inv`
                      : `${fmt(100 * active.capInfo.achievedMods / active.capInfo.targetMods, 1)}%`
                  : "—"}
              </div>
            </div>
          )}
          <div style={{ flex: 1 }} />
          <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "0 14px" }}>
            <span className="legend"><span className="sw" style={{ border: `2px solid ${C.boundary}` }} />boundary</span>
            <span className="legend"><span className="sw" style={{ background: "#232830", border: `1.5px solid ${C.moduleRed}` }} />frames</span>
            <span className="legend"><span className="sw" style={{ background: "#2b3039", border: `1px solid #8f98a5` }} />road</span>
            <span className="legend"><span className="sw" style={{ border: `2px solid ${C.inverter}` }} />inverter block</span>
            {showSs && (<>
              <span className="legend"><span className="sw" style={{ background: "#c9ced6", height: 3, borderRadius: 0 }} />LV route</span>
              <span className="legend"><span className="sw" style={{ background: C.transformer, height: 4, borderRadius: 0 }} />MV route</span>
              <span className="legend"><span className="sw" style={{ background: "#12304d", border: `2px solid ${C.transformer}` }} />substation</span>
              <span className="legend"><span className="sw" style={{ background: C.transformer }} />grid point</span>
            </>)}
          </div>
        </div>
      </div>
    </div>
  );
}

/* =====================================================================
   STRING SIZING TOOL — reproduces the Simandou workbook (IEC 62548
   basis): every result shown with its formula, substitution, and the
   reasoning, plus an MPPT-window widget and a design-space strip.
   ===================================================================== */
const RISE_TABLE = [
  { label: "Roof mount, gap ≤ 15 cm", rise: 35 },
  { label: "Rack mount, gap ≥ 15 cm", rise: 30 },
  { label: "Top of a pole / freefield", rise: 25 },
];

function Working({ n, title, formula, sub, result, unit, why, status }) {
  return (
    <div className="wk">
      <div className="wk-head">
        <span className="wk-n">{n}</span>
        <span className="wk-title">{title}</span>
        {status && (
          <span className={`wk-status ${status === "OK" || status === "Within window" ? "ok" : "bad"}`}>
            {status}
          </span>
        )}
      </div>
      <div className="wk-formula">{formula}</div>
      <div className="wk-sub">{sub} <b>= {result}{unit ? ` ${unit}` : ""}</b></div>
      <div className="wk-why">{why}</div>
    </div>
  );
}


function ModuleIV({ mod }) {
  const W=420,H=170,L=42,B=138,R=W-14,T=16;
  const k = Math.log(Math.max(1e-6,1-mod.imp/mod.isc))/Math.log(mod.vmp/mod.voc);
  const X=(v)=>L+(v/mod.voc)*(R-L), YI=(i)=>B-(i/mod.isc)*(B-T);
  const pmax=mod.vmp*mod.imp, YP=(p)=>B-(p/pmax)*(B-T)*0.92;
  let iv="",pv="";
  for(let j=0;j<=60;j++){const v=mod.voc*j/60;const i=mod.isc*(1-Math.pow(v/mod.voc,k));
    iv+=`${j?"L":"M"} ${X(v)} ${YI(i)} `;pv+=`${j?"L":"M"} ${X(v)} ${YP(v*i)} `;}
  return (<svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{background:C.paper,borderRadius:4}}>
    <line x1={L} y1={B} x2={R} y2={B} stroke={C.muted}/><line x1={L} y1={T} x2={L} y2={B} stroke={C.muted}/>
    <path d={iv} fill="none" stroke="#7ea2d8" strokeWidth="2"/>
    <path d={pv} fill="none" stroke={C.accent} strokeWidth="1.6" strokeDasharray="5 3"/>
    <circle cx={X(mod.vmp)} cy={YI(mod.imp)} r="3.5" fill="#7ea2d8"/>
    <text x={X(mod.vmp)-8} y={YI(mod.imp)+16} textAnchor="end" style={{font:"600 10px var(--mono)"}} fill="#ccd4de">MPP {fmt(mod.vmp,1)} V · {fmt(mod.imp,1)} A</text>
    <text x={L+4} y={T+10} style={{font:"10px var(--mono)"}} fill="#ccd4de">Isc {mod.isc} A</text>
    <text x={X(mod.voc)-4} y={B-4} textAnchor="end" style={{font:"10px var(--mono)"}} fill="#ccd4de">Voc {mod.voc} V</text>
    <text x={L+8} y={B-10} style={{font:"10px var(--mono)"}} fill={C.accent}>— — P–V (peak {fmt(pmax,0)} W)</text>
    <text x={(L+R)/2} y={H-6} textAnchor="middle" style={{font:"600 9px system-ui"}} fill="#ccd4de">VOLTAGE (V)</text>
    <text x={12} y={(T+B)/2} textAnchor="middle" transform={`rotate(-90 12 ${(T+B)/2})`} style={{font:"600 9px system-ui"}} fill="#7ea2d8">CURRENT (A)</text>
    <text x={W-6} y={(T+B)/2} textAnchor="middle" transform={`rotate(90 ${W-6} ${(T+B)/2})`} style={{font:"600 9px system-ui"}} fill={C.accent}>POWER (W)</text>
    {[0,0.25,0.5,0.75,1].map(f=>(<text key={f} x={X(mod.voc*f)} y={B+11} textAnchor="middle" style={{font:"8.5px var(--mono)"}} fill="#8f98a5">{fmt(mod.voc*f,0)}</text>))}
  </svg>);
}
function InverterWindow({ inv }) {
  const W=420,H=150,L=42,B=118,R=W-14,T=18;
  const vTop=inv.vMax*1.04, X=(v)=>L+(v/vTop)*(R-L);
  const lo=inv.trackLo??inv.fpLo*0.6;
  const d=`M ${X(lo)} ${B} L ${X(inv.fpLo)} ${T} L ${X(inv.fpHi)} ${T} L ${X(inv.vMax)} ${B-((B-T)*0.55)} L ${X(inv.vMax)} ${B}`;
  return (<svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{background:C.paper,borderRadius:4}}>
    <rect x={X(inv.fpLo)} y={T} width={X(inv.fpHi)-X(inv.fpLo)} height={B-T} fill="rgba(47,158,68,0.10)"/>
    <line x1={L} y1={B} x2={R} y2={B} stroke={C.muted}/>
    <path d={d} fill="none" stroke="#7ea2d8" strokeWidth="2"/>
    <line x1={X(inv.vMax)} y1={T} x2={X(inv.vMax)} y2={B} stroke="#d64545" strokeWidth="1.5" strokeDasharray="5 3"/>
    <text x={(X(inv.fpLo)+X(inv.fpHi))/2} y={T-5} textAnchor="middle" style={{font:"600 9px var(--mono)"}} fill="#2f9e44">FULL POWER {inv.fpLo}–{inv.fpHi} V</text>
    <text x={X(inv.vMax)} y={H-6} textAnchor="middle" style={{font:"9px var(--mono)"}} fill="#d64545">{inv.vMax} V max</text>
    <text x={X(lo)+4} y={B-8} style={{font:"9px var(--mono)"}} fill="#8f98a5">{fmt(lo,0)} V</text>
    <text x={L+4} y={T+10} style={{font:"9px var(--mono)"}} fill="#ccd4de">AVAILABLE POWER →</text>
    <text x={(L+R)/2} y={H-6} textAnchor="middle" style={{font:"600 9px system-ui"}} fill="#ccd4de">DC VOLTAGE (V)</text>
    {[500,1000,1500].filter(v=>v<=vTop).map(v=>(<text key={v} x={X(v)} y={B+11} textAnchor="middle" style={{font:"8.5px var(--mono)"}} fill="#8f98a5">{v}</text>))}
  </svg>);
}
function ClipCurve({ ilr, ilrCap }) {
  const W=420,H=170,L=44,B=134,R=W-14,T=14,IM=1.5;
  const X=(v)=>L+((v-0.95)/(IM-0.95))*(R-L);
  const clip=(v)=>v<=1?0:45.5*Math.pow(v-1,2.26);
  const cm=clip(IM), Y=(c)=>B-(c/cm)*(B-T);
  let d="";for(let j=0;j<=70;j++){const v=0.95+(IM-0.95)*j/70;d+=`${j?"L":"M"} ${X(v)} ${Y(clip(v))} `;}
  return (<svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{background:C.paper,borderRadius:4}}>
    <line x1={L} y1={B} x2={R} y2={B} stroke={C.muted}/><line x1={L} y1={T} x2={L} y2={B} stroke={C.muted}/>
    <path d={d} fill="none" stroke={C.accent} strokeWidth="2.2"/>
    <line x1={X(ilrCap)} y1={T} x2={X(ilrCap)} y2={B} stroke="#d64545" strokeWidth="1.5" strokeDasharray="5 3"/>
    <text x={X(ilrCap)+4} y={T+10} style={{font:"600 9px var(--mono)"}} fill="#d64545">cap {fmt(ilrCap,2)}</text>
    {ilr>0&&(<g><circle cx={X(Math.min(ilr,IM))} cy={Y(clip(Math.min(ilr,IM)))} r="4.5" fill="#7ea2d8" stroke="#fff" strokeWidth="1.5"/>
      <text x={X(Math.min(ilr,IM))+7} y={Y(clip(Math.min(ilr,IM)))-7} style={{font:"600 10px var(--mono)"}} fill="#ccd4de">now {fmt(ilr,2)} → {fmt(clip(ilr),2)}%</text></g>)}
    {[1,1.1,1.2,1.3,1.4,1.5].map(t=>(<text key={t} x={X(t)} y={B+12} textAnchor="middle" style={{font:"9px var(--mono)"}} fill="#ccd4de">{t}</text>))}
    {[0,Math.round(cm/2),Math.round(cm)].map(c=>(<text key={c} x={L-5} y={Y(c)+3} textAnchor="end" style={{font:"8.5px var(--mono)"}} fill="#8f98a5">{c}</text>))}
    <text x={12} y={(T+B)/2} textAnchor="middle" transform={`rotate(-90 12 ${(T+B)/2})`} style={{font:"600 9px system-ui"}} fill="#ccd4de">EST. CLIPPING (%)</text>
    <text x={(L+R)/2} y={H-2} textAnchor="middle" style={{font:"9px system-ui"}} fill={C.muted}>ILR (DC/AC) — clipping grows non-linearly past 1.0; stay left of the cap</text>
  </svg>);
}
function MpptWidget({ vocCold, vmpHot, vmpCold, ceiling, mpptLo, mpptHi, N }) {
  const W = 640, H = 190;
  const vMax = Math.max(ceiling, vocCold) * 1.06;
  const x = (v) => 56 + (v / vMax) * (W - 96);
  const okCold = vocCold <= ceiling;
  const okHot = vmpHot >= mpptLo;
  const coldVmpIn = vmpCold <= mpptHi;
  const Bar = ({ v, y, label, ok, col }) => (
    <g>
      <line x1={x(0)} x2={x(v)} y1={y} y2={y} stroke={ok ? col : "#d64545"} strokeWidth="3.5" strokeLinecap="round" />
      <circle cx={x(v)} cy={y} r="4.5" fill={ok ? col : "#d64545"} stroke={C.paper} strokeWidth="1.5" />
      <text x={x(v) > W - 170 ? x(v) - 10 : x(v) + 9} y={y - 8}
        textAnchor={x(v) > W - 170 ? "end" : "start"} fill={C.text}
        style={{ font: "600 11px var(--mono)" }}>
        {label} {fmt(v, 0)} V
      </text>
    </g>
  );
  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ display: "block" }}>
      {/* MPPT window band */}
      <rect x={x(mpptLo)} y={30} width={x(mpptHi) - x(mpptLo)} height={104}
        fill="rgba(47,158,68,0.10)" stroke="rgba(47,158,68,0.45)" strokeDasharray="4 3" />
      <text x={(x(mpptLo) + x(mpptHi)) / 2} y={24} textAnchor="middle" fill={C.muted}
        style={{ font: "600 10px var(--mono)", letterSpacing: "0.06em" }}>
        MPPT WINDOW {fmt(mpptLo, 0)}–{fmt(mpptHi, 0)} V
      </text>
      {/* ceiling */}
      <line x1={x(ceiling)} x2={x(ceiling)} y1={26} y2={140} stroke="#d64545" strokeWidth="2" strokeDasharray="6 3" />
      <text x={x(ceiling)} y={152} textAnchor="middle" fill="#d64545"
        style={{ font: "600 10px var(--mono)" }}>CEILING {fmt(ceiling, 0)} V</text>
      {/* string bars for the chosen N */}
      <Bar v={vocCold} y={54} label={`N=${N} · Voc cold`} ok={okCold} col="#7ea2d8" />
      <Bar v={vmpCold} y={86} label="Vmp cold" ok={coldVmpIn} col="#8a6fd6" />
      <Bar v={vmpHot} y={118} label="Vmp hot" ok={okHot} col={C.accent} />
      {/* axis */}
      <line x1={x(0)} x2={x(vMax)} y1={160} y2={160} stroke={C.muted} strokeWidth="1" />
      {[0, 250, 500, 750, 1000, 1250, 1500].filter((t) => t <= vMax).map((t) => (
        <g key={t}>
          <line x1={x(t)} x2={x(t)} y1={158} y2={163} stroke={C.muted} strokeWidth="1" />
          <text x={x(t)} y={176} textAnchor="middle" fill={C.muted}
            style={{ font: "10px var(--mono)" }}>{t}</text>
        </g>
      ))}
      <text x={W / 2} y={H - 2} textAnchor="middle" fill={C.muted}
        style={{ font: "10px system-ui, sans-serif" }}>String voltage (V)</text>
    </svg>
  );
}

function NumS({ label, unit, obj, set, k, step = 0.01 }) {
  return (
    <Num label={label} unit={unit} value={obj[k]} step={step}
      onChange={(v) => set({ ...obj, [k]: v })} />
  );
}

function NumO({ label, unit, value, onChange, step = 0.01, ph = "optional" }) {
  return (
    <label className="fld">
      <span className="fld-l">{label}</span>
      <span className="fld-box">
        <input type="number" value={value === null || value === undefined ? "" : value}
          step={step} placeholder={ph}
          onChange={(e) => {
            const t = e.target.value;
            if (t === "") { onChange(null); return; }
            const v = Number(t);
            if (!Number.isNaN(v)) onChange(v);
          }} />
        {unit ? <span className="fld-u">{unit}</span> : null}
      </span>
    </label>
  );
}

function StringSizingTool({ mod, setMod, inv, setInv, frameP, onAdopt, uiMode, loc, setLoc }) {
  const [tSrc, setTSrc] = useState([
    { name: "meteoblue", lo: 2, hi: 24 },
    { name: "Solargis T2m", lo: null, hi: null },
    { name: "ASHRAE extreme dry bulb", lo: null, hi: null },
    { name: "WeatherSpark / MERRA-2", lo: 2, hi: 24 },
  ]);
  const [siteT, setSiteT] = useState({ riseIdx: 2, margin: 5 });
  const [nSel, setNSel] = useState(null);
  const [years, setYears] = useState(10);
  const [wx, setWx] = useState({ state: "idle", msg: "", abs: null, mean: null });
  const [wxUrl, setWxUrl] = useState("");

  const fetchTemps = async () => {
    setWx({ state: "busy", msg: "Requesting ERA5 reanalysis…", abs: null, mean: null });
    try {
      const end = new Date(Date.now() - 7 * 864e5);
      const start = new Date(end);
      start.setFullYear(end.getFullYear() - Math.max(1, Math.round(years)));
      const iso = (d) => d.toISOString().slice(0, 10);
      const qs = `?latitude=${loc.lat}&longitude=${loc.lon}` +
        `&start_date=${iso(start)}&end_date=${iso(end)}` +
        "&daily=temperature_2m_max,temperature_2m_min&timezone=UTC";
      const hosts = [
        "https://archive-api.open-meteo.com/v1/archive",
        "https://api.open-meteo.com/v1/archive",
      ];
      let res = null, lastErr = null;
      for (const h of hosts) {
        try {
          const t = await fetch(h + qs);
          if (t.ok) { res = t; break; }
          lastErr = new Error(`HTTP ${t.status} from ${h.split("/")[2]}`);
        } catch (e) { lastErr = e; }
      }
      setWxUrl(hosts[0] + qs);
      if (!res) throw lastErr || new Error("no response");
      const d = await res.json();
      if (d.error) throw new Error(d.reason || "API error");
      const time = d?.daily?.time, hi = d?.daily?.temperature_2m_max, lo = d?.daily?.temperature_2m_min;
      if (!time?.length) throw new Error("no daily data returned");
      const rnd = (v) => Math.round(v * 10) / 10;
      // (a) monthly means of daily max / daily min — the meteoblue convention
      const mo = new Map();
      const byYear = new Map();
      for (let i = 0; i < time.length; i++) {
        if (hi[i] === null || lo[i] === null) continue;
        const m = time[i].slice(5, 7), y = time[i].slice(0, 4);
        const g = mo.get(m) || { hi: 0, lo: 0, n: 0 };
        g.hi += hi[i]; g.lo += lo[i]; g.n++;
        mo.set(m, g);
        const e = byYear.get(y) || { hi: -999, lo: 999 };
        e.hi = Math.max(e.hi, hi[i]); e.lo = Math.min(e.lo, lo[i]);
        byYear.set(y, e);
      }
      const months = [...mo.values()].filter((g) => g.n > 20).map((g) => ({ hi: g.hi / g.n, lo: g.lo / g.n }));
      if (months.length < 12) throw new Error("incomplete monthly record");
      const monHi = rnd(Math.max(...months.map((g) => g.hi)));   // warmest month, mean daily max
      const monLo = rnd(Math.min(...months.map((g) => g.lo)));   // coldest month, mean daily min
      // (b) mean annual extremes, (c) absolute extremes — offered as alternatives
      const yr = [...byYear.values()].filter((e) => e.hi > -999);
      const meanHi = rnd(yr.reduce((s, e) => s + e.hi, 0) / yr.length);
      const meanLo = rnd(yr.reduce((s, e) => s + e.lo, 0) / yr.length);
      const absHi = rnd(Math.max(...yr.map((e) => e.hi)));
      const absLo = rnd(Math.min(...yr.map((e) => e.lo)));
      setTSrc((prev) => [
        { name: `Reanalysis ${yr.length} yr monthly mean`, lo: monLo, hi: monHi },
        ...prev.filter((s) => !/^(ERA5|Reanalysis)/.test(s.name)),
      ]);
      setWx({
        state: "ok",
        mon: { hi: monHi, lo: monLo }, mean: { hi: meanHi, lo: meanLo }, abs: { hi: absHi, lo: absLo },
        msg: `${yr.length} years at ${loc.lat}, ${loc.lon}.`,
      });
    } catch (e) {
      const offline = /failed to fetch|networkerror|load failed/i.test(e.message || "");
      setWx({
        state: "err", abs: null, mean: null, offline,
        msg: offline
          ? "The browser blocked the request before it reached the server."
          : `The archive returned an error: ${e.message}`,
      });
    }
  };

  const useBasis = (key, label) => {
    const v = wx[key];
    if (!v) return;
    setTSrc((prev) => [
      { name: `Reanalysis ${label}`, lo: v.lo, hi: v.hi },
      ...prev.filter((s) => !/^(ERA5|Reanalysis)/.test(s.name)),
    ]);
  };

  const r = useMemo(() => {
    // β_Vmp derivation waterfall: datasheet → γ−α → NOCT (irradiance-corrected)
    const route2 = (mod.gPmax !== null && mod.aIsc !== null) ? mod.gPmax - mod.aIsc : null;
    const route3 =
      mod.vmpNoct !== null && mod.noct !== null && mod.cells !== null && mod.ideality !== null
        ? (((mod.vmpNoct - mod.vmp) -
            mod.cells * mod.ideality * 0.00008617 * (273.15 + mod.noct) * Math.log(0.8)) /
            mod.vmp / (mod.noct - 25)) * 100
        : null;
    const bVmpUsed = mod.bVmp !== null ? mod.bVmp : route2 !== null ? route2 : route3;
    const method = mod.bVmp !== null ? "Datasheet value"
      : route2 !== null ? "Derived: γ_Pmax − α_Isc"
      : route3 !== null ? "Derived from NOCT delta (irradiance-corrected)"
      : "NO ROUTE — enter data";

    // adopted temperature extremes: most extreme source, never averaged
    const los = tSrc.map((s) => s.lo).filter((v) => v !== null);
    const his = tSrc.map((s) => s.hi).filter((v) => v !== null);
    const tLo = los.length ? Math.min(...los) : null;
    const tHi = his.length ? Math.max(...his) : null;

    const rise = RISE_TABLE[siteT.riseIdx].rise;
    const tcMin = tLo !== null ? tLo - siteT.margin : null;
    const tcMax = tHi !== null ? tHi + rise + siteT.margin : null;
    const bad = bVmpUsed === null || tcMin === null || tcMax === null;

    const vocCold1 = bad ? 0 : mod.voc * (1 + (mod.bVoc / 100) * (tcMin - 25));
    const vmpHot1 = bad ? 1 : mod.vmp * (1 + (bVmpUsed / 100) * (tcMax - 25));
    const vmpCold1 = bad ? 0 : mod.vmp * (1 + (bVmpUsed / 100) * (tcMin - 25));
    const ceiling = Math.min(inv.vMax, mod.vSysMax || inv.vMax);
    const nMax = bad ? 0 : Math.floor(ceiling / vocCold1);
    const nMin = bad ? 1 : Math.ceil(inv.fpLo / vmpHot1);
    const valid = !bad && nMax >= nMin;
    // frame-P preference: largest N divisible by P, unless that drops below N_min
    const nDivCand = nMax - (nMax % Math.max(1, frameP));
    const nRec = !valid ? null : nDivCand >= nMin ? nDivCand : nMax;
    const recDivisible = nRec !== null && nRec % frameP === 0;
    const N = nSel !== null ? nSel : (nRec ?? 1);

    const effStart = [inv.vStart, inv.trackLo].filter((v) => v !== null);
    const startV = effStart.length ? Math.max(...effStart) : null;
    const nStart = startV !== null && !bad ? Math.ceil(startV / vmpHot1) : null;

    const byIsc = inv.iMppt !== null && mod.isc > 0 ? Math.floor(inv.iMppt / mod.isc) : null;
    const strPar = byIsc !== null && inv.connMax !== null ? Math.min(inv.connMax, byIsc)
      : byIsc !== null ? byIsc : inv.connMax;
    const pString = N * mod.pmax;
    const pMppt = strPar !== null ? strPar * pString : null;
    const pInv = pMppt !== null ? pMppt * inv.nMppt : null;
    const dcac = pInv !== null && inv.acKva ? pInv / 1000 / inv.acKva : null;

    return {
      route2, route3, bVmpUsed, method, tLo, tHi, rise, tcMin, tcMax, bad,
      vocCold1, vmpHot1, vmpCold1, ceiling, nMax, nMin, valid, nRec, recDivisible,
      nDivCand, N, vocColdN: N * vocCold1, vmpHotN: N * vmpHot1, vmpColdN: N * vmpCold1,
      startV, nStart, byIsc, strPar, pString, pMppt, pInv, dcac,
    };
  }, [mod, inv, tSrc, siteT, frameP, nSel]);

  return (
    <div className="app" style={{ display: "flex", height: "100%", minHeight: 0, background: C.chrome }}>
      <div className="pv-side" style={{
        width: 356, minWidth: 356, background: C.panel, borderRight: `1px solid ${C.line}`,
        overflowY: "auto",
      }}>
        <div style={{ padding: "14px 16px 12px", borderBottom: `1px solid ${C.line}` }}>
          <div style={{ font: "700 13px var(--mono)", letterSpacing: "0.04em" }}>STRING SIZING · REV B</div>
          <div style={{ font: "11px system-ui, sans-serif", color: C.muted, marginTop: 3 }}>
            IEC 62548 basis — cold Voc ceiling · hot Vmp full-power floor
          </div>
        </div>
        <Section code="01" title="Module (STC nameplate)">
          <NumS label="Voc" unit="V" obj={mod} set={setMod} k="voc" />
          <NumS label="Vmp" unit="V" obj={mod} set={setMod} k="vmp" />
          <NumS label="Isc" unit="A" obj={mod} set={setMod} k="isc" />
          <NumS label="Imp" unit="A" obj={mod} set={setMod} k="imp" />
          <NumS label="Pmax" unit="Wp" obj={mod} set={setMod} k="pmax" step={5} />
          <NumS label="Max system voltage" unit="V" obj={mod} set={setMod} k="vSysMax" step={50} />
          <NumS label="β Voc" unit="%/°C" obj={mod} set={setMod} k="bVoc" />
          <NumO label="β Vmp (datasheet, if published)" unit="%/°C" value={mod.bVmp}
            onChange={(v) => setMod({ ...mod, bVmp: v })} />
          <NumS label="γ Pmax" unit="%/°C" obj={mod} set={setMod} k="gPmax" />
          <NumS label="α Isc" unit="%/°C" obj={mod} set={setMod} k="aIsc" />
          {uiMode === "engineer" && (<>
          <NumO label="Vmp at NOCT (route 3)" unit="V" value={mod.vmpNoct}
            onChange={(v) => setMod({ ...mod, vmpNoct: v })} />
          <NumO label="NOCT" unit="°C" value={mod.noct}
            onChange={(v) => setMod({ ...mod, noct: v })} />
          <NumO label="Cells in series" value={mod.cells} step={1}
            onChange={(v) => setMod({ ...mod, cells: v })} />
          <NumO label="Diode ideality n" value={mod.ideality} step={0.05}
            onChange={(v) => setMod({ ...mod, ideality: v })} />
          </>)}
          <div className="readout">
            β<sub>Vmp</sub> used: <b>{r.bVmpUsed !== null ? fmt(r.bVmpUsed, 3) : "—"} %/°C</b> — {r.method}.
            The waterfall prefers the datasheet value, then γ<sub>Pmax</sub> − α<sub>Isc</sub>
            {r.route2 !== null && <> ({fmt(mod.gPmax, 2)} − ({fmt(mod.aIsc, 3)}) = {fmt(r.route2, 3)})</>},
            then the NOCT delta corrected for the 800 W/m² irradiance difference via diode physics.
          </div>
        </Section>
        <Section code="02" title="Inverter / MPPT (datasheet + P-V curve)">
          <NumS label="Max DC input" unit="V" obj={inv} set={setInv} k="vMax" step={50} />
          <NumS label="Full-power upper (P-V curve)" unit="V" obj={inv} set={setInv} k="fpHi" step={10} />
          <NumS label="Full-power lower (P-V curve)" unit="V" obj={inv} set={setInv} k="fpLo" step={10} />
          <NumO label="MPPT tracking lower" unit="V" value={inv.trackLo}
            onChange={(v) => setInv({ ...inv, trackLo: v })} />
          <NumO label="Startup voltage" unit="V" value={inv.vStart}
            onChange={(v) => setInv({ ...inv, vStart: v })} />
          <NumO label="Max current per MPPT" unit="A" value={inv.iMppt} step={1}
            onChange={(v) => setInv({ ...inv, iMppt: v })} />
          <NumO label="Max strings per MPPT (connectors)" value={inv.connMax} step={1}
            onChange={(v) => setInv({ ...inv, connMax: v })} />
          <NumS label="MPPT inputs" obj={inv} set={setInv} k="nMppt" step={1} />
          <NumO label="AC rating at design ambient" unit="kVA" value={inv.acKva} step={5}
            onChange={(v) => setInv({ ...inv, acKva: v })} />
        </Section>
        <Section code="03" title="Site location">
          <Num label="Latitude" unit="°" value={loc.lat} step={0.001}
            onChange={(v) => setLoc({ ...loc, lat: v })} />
          <Num label="Longitude" unit="°" value={loc.lon} step={0.001}
            onChange={(v) => setLoc({ ...loc, lon: v })} />
          <Num label="Years of record" value={years} step={1} min={1} max={40}
            onChange={(v) => setYears(Math.round(v))} />
          <div className="fld" style={{ justifyContent: "flex-end" }}>
            <span className="fld-l">&nbsp;</span>
            <button className="btn primary" onClick={fetchTemps} disabled={wx.state === "busy"}>
              {wx.state === "busy" ? "Fetching…" : "Get design temperatures"}
            </button>
          </div>
          {wx.state === "err" && (
            <div className="warn" style={{ width: "100%" }}>
              ⚠ {wx.msg}
              {wx.offline && (
                <>
                  <br /><br />Two usual causes, in order of likelihood:
                  <br />• the page is open from a local <b>file://</b> path — browsers block
                  cross-site requests from local files, so host it (GitHub Pages) and it works;
                  <br />• the corporate network blocks open-meteo.com.
                  {wxUrl && (
                    <>
                      <br /><br />Open this in a new tab to tell them apart — if it returns JSON,
                      it is the file:// problem, not the network:
                      <br />
                      <a href={wxUrl} target="_blank" rel="noreferrer"
                        style={{ color: C.accent, wordBreak: "break-all" }}>{wxUrl}</a>
                    </>
                  )}
                </>
              )}
              <br /><br />Temperatures can be entered by hand below either way.
            </div>
          )}
          {wx.state === "ok" && (
            <div className="readout">
              ✓ {wx.msg} Three bases computed — the monthly mean is applied by default:
              <br />• <b>monthly mean {fmt(wx.mon.lo, 1)} / {fmt(wx.mon.hi, 1)} °C</b>
              {" "}— mean daily min of the coldest month, mean daily max of the warmest
              <br />• mean annual extreme {fmt(wx.mean.lo, 1)} / {fmt(wx.mean.hi, 1)} °C
              <br />• absolute extreme {fmt(wx.abs.lo, 1)} / {fmt(wx.abs.hi, 1)} °C
              <div style={{ display: "flex", gap: 6, marginTop: 7, flexWrap: "wrap" }}>
                <button className="btn" onClick={() => useBasis("mon", "monthly mean")}>Monthly mean</button>
                <button className="btn" onClick={() => useBasis("mean", "mean annual extreme")}>Mean annual</button>
                <button className="btn" onClick={() => useBasis("abs", "absolute extreme")}>Absolute</button>
              </div>
            </div>
          )}
          <div className="readout">
            Simulated historical climate from reanalysis (ERA5 via Open-Meteo) — the same
            basis meteoblue publishes, gap-free worldwide at about 25 km, so it works where
            there is no station (ASHRAE has none in Guinea). The default applied is the
            <b> monthly mean</b>: mean daily minimum of the coldest month and mean daily
            maximum of the warmest, matching the meteoblue climate tables rather than record
            extremes. Note that this is deliberately less severe than an absolute cold
            morning, so the safety margin below is doing real work — the alternatives are one
            click away if a project needs the harder case.
          </div>
        </Section>
        <Section code="04" title="Site temperatures (most extreme source — never average)">
          {tSrc.map((s, i) => (
            <React.Fragment key={i}>
              <NumO label={`${s.name} — low`} unit="°C" value={s.lo} step={1}
                onChange={(v) => setTSrc(tSrc.map((x, j) => (j === i ? { ...x, lo: v } : x)))} />
              <NumO label={`${s.name} — high`} unit="°C" value={s.hi} step={1}
                onChange={(v) => setTSrc(tSrc.map((x, j) => (j === i ? { ...x, hi: v } : x)))} />
            </React.Fragment>
          ))}
          <div className="readout">
            Adopted: <b>{r.tLo !== null ? `${r.tLo} °C` : "—"}</b> low ·
            <b> {r.tHi !== null ? `${r.tHi} °C` : "—"}</b> high — the MIN of all lows and MAX of all
            highs. No single source is trusted; averaging would dilute exactly the extreme the
            check exists for.
          </div>
        </Section>
        <Section code="05" title="Mounting, margins & frame">
          <Sel label="Mounting (temperature rise)" width="100%"
            value={String(siteT.riseIdx)}
            options={RISE_TABLE.map((t, i) => ({ value: String(i), label: `${t.label} (+${t.rise} °C)` }))}
            onChange={(v) => setSiteT({ ...siteT, riseIdx: Number(v) })} />
          <NumS label="Safety margin (±)" unit="°C" obj={siteT} set={setSiteT} k="margin" step={1} />
          <div className="readout">
            A {frameP}P frame carries modules in rows of {frameP}, so a string length divisible
            by {frameP} keeps every string on whole frame bays — the recommendation snaps DOWN
            from the electrical maximum to the nearest divisible N, provided it stays above
            the hot-weather minimum.
          </div>
        </Section>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "18px 22px", minWidth: 0 }}>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 14 }}>
          {[
            ["Max N (cold Voc)", r.bad ? "—" : r.nMax],
            ["Min N (hot Vmp)", r.bad ? "—" : r.nMin],
            [`Recommended N (÷${frameP})`, r.valid ? r.nRec : "—"],
            ["Min N to start (info)", r.nStart ?? "—"],
            ["Strings / MPPT", r.strPar ?? "—"],
            ["DC / string", r.valid ? `${fmt(r.pString / 1000, 2)} kWp` : "—"],
            ["DC / inverter", r.pInv !== null ? `${fmt(r.pInv / 1000, 0)} kWp` : "—"],
            ["DC/AC", r.dcac !== null ? fmt(r.dcac, 2) : "—"],
          ].map(([l, v]) => (
            <div key={l} style={{
              background: C.panel, border: `1px solid ${C.line}`, borderRadius: 5,
              padding: "9px 14px", minWidth: 108,
            }}>
              <div className="tbl">{l}</div>
              <div className="tbv">{v}</div>
            </div>
          ))}
        </div>
        {r.bad && (
          <div className="warn" style={{ marginBottom: 14 }}>
            ⚠ Missing data — need a β_Vmp route and at least one temperature source (low and high).
          </div>
        )}
        {!r.bad && !r.valid && (
          <div className="warn" style={{ marginBottom: 14 }}>
            ⚠ No valid configuration — cold-limited max ({r.nMax}) is below hot-limited
            min ({r.nMin}).
          </div>
        )}
        {r.valid && (
          <div className="readout" style={{ marginBottom: 12 }}>
            {r.recDivisible
              ? <>Recommended N = <b>{r.nRec}</b> — divisible by {frameP}
                  {r.nRec < r.nMax && <> — {r.nMax - r.nRec} module(s) below the electrical max of {r.nMax}</>}
                  {r.nRec === r.nMax && <> — equals the electrical maximum</>}.</>
              : <>Recommended N = <b>{r.nRec}</b> — the divisible candidate ({r.nDivCand}) falls below
                  the hot minimum ({r.nMin}), so the electrical maximum stands; strings will span frames.</>}
            {"  "}
            <button className="btn primary" style={{ marginLeft: 8 }}
              onClick={() => onAdopt(r.nRec)}>Adopt {r.nRec} for the layout</button>
          </div>
        )}

        <div style={{ background: C.paper, borderRadius: 6, padding: "12px 10px 4px", marginBottom: 6 }}>
          <MpptWidget vocCold={r.vocColdN} vmpHot={r.vmpHotN} vmpCold={r.vmpColdN}
            ceiling={r.ceiling} mpptLo={inv.fpLo} mpptHi={inv.fpHi} N={r.N} />
        </div>

        <div style={{ margin: "10px 0 18px" }}>
          <div className="tbl" style={{ marginBottom: 6 }}>
            DESIGN SPACE — CLICK AN N TO TEST IT · DOT = DIVISIBLE BY {frameP}
          </div>
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
            {Array.from({ length: Math.max(0, r.nMax - r.nMin + 5) }, (_, i) => r.nMin - 2 + i)
              .filter((n) => n >= 1)
              .map((n) => {
                const ok = n >= r.nMin && n <= r.nMax;
                const sel = n === r.N;
                return (
                  <button key={n} onClick={() => setNSel(n)} style={{
                    width: 42, padding: "6px 0", borderRadius: 4, cursor: "pointer",
                    font: "600 12px var(--mono)",
                    background: sel ? C.accent : ok ? "rgba(47,158,68,0.16)" : "rgba(214,69,69,0.12)",
                    color: sel ? "#181206" : ok ? "#59b56f" : "#d67070",
                    border: `1px solid ${sel ? C.accent : ok ? "rgba(47,158,68,0.5)" : "rgba(214,69,69,0.35)"}`,
                  }}>
                    {n}{n % frameP === 0 && ok ? "·" : ""}
                  </button>
                );
              })}
            {nSel !== null && (
              <button className="btn" onClick={() => setNSel(null)}>Back to recommended</button>
            )}
          </div>
        </div>

        <div className="tbl" style={{ marginBottom: 8 }}>WORKINGS — EVERY NUMBER, SHOWN</div>
        <Working n="1" title="β_Vmp — derivation waterfall"
          formula={"use datasheet β_Vmp → else γ_Pmax − α_Isc → else NOCT delta, irradiance-corrected"}
          sub={mod.bVmp !== null ? `datasheet = ${mod.bVmp}` :
               r.route2 !== null ? `${fmt(mod.gPmax, 2)} − (${fmt(mod.aIsc, 3)})` :
               r.route3 !== null ? "NOCT route" : "no route"}
          result={r.bVmpUsed !== null ? fmt(r.bVmpUsed, 3) : "—"} unit="%/°C"
          why={`Most datasheets omit β_Vmp. Since P = V·I, the power coefficient splits into
          voltage and current parts, so γ_Pmax − α_Isc recovers it. The NOCT route compares
          Vmp at NOCT (800 W/m², hot cell) with STC and strips out the irradiance contribution
          using the diode equation term N·n·kT·ln(0.8) — leaving the pure temperature effect.
          Method used here: ${r.method}.`} />
        <Working n="2" title="Adopted temperature extremes"
          formula={"T_low = MIN(all source lows)   ·   T_high = MAX(all source highs)"}
          sub={`sources: ${tSrc.filter((s) => s.lo !== null || s.hi !== null).map((s) => s.name).join(", ") || "none"}`}
          result={r.tLo !== null && r.tHi !== null ? `${r.tLo} / ${r.tHi}` : "—"} unit="°C"
          why={`Multiple sources (meteoblue, Solargis, ASHRAE, WeatherSpark/MERRA-2) with the
          most extreme value governing. ASHRAE has no station in Guinea, hence the corrected
          nearby-station rows. Averaging sources would soften exactly the extreme this check
          exists to catch.`} />
        <Working n="3" title="Cell temperature extremes"
          formula={"T_cell,min = T_low − margin   ·   T_cell,max = T_high + rise + margin"}
          sub={r.tLo !== null ? `${r.tLo} − ${siteT.margin} = ${r.tcMin} °C · ${r.tHi} + ${r.rise} + ${siteT.margin}` : "—"}
          result={r.tcMax ?? "—"} unit="°C"
          why={`Cold case is ambient at dawn (no self-heating yet). Hot case adds the mounting
          rise — ${RISE_TABLE[siteT.riseIdx].label}: +${r.rise} °C — because an operating module
          runs well above ambient. The ±${siteT.margin} °C margin covers source and model
          uncertainty at both ends.`} />
        <Working n="4" title="Temperature-corrected voltages (per module)"
          formula={"V(T) = V_STC × (1 + coeff/100 × (T_cell − 25))"}
          sub={`Voc(cold): ${mod.voc} × (1 + ${mod.bVoc}/100 × (${r.tcMin} − 25)) · Vmp(hot): ${mod.vmp} × (1 + ${r.bVmpUsed !== null ? fmt(r.bVmpUsed, 3) : "—"}/100 × (${r.tcMax} − 25))`}
          result={`${fmt(r.vocCold1, 2)} / ${fmt(r.vmpHot1, 2)}`} unit="V"
          why={`Voltage rises as cells cool and sags as they heat. Voc at the coldest morning is
          the highest voltage the module ever presents; Vmp on the hottest afternoon is the
          lowest it operates at. Cold Vmp (${fmt(r.vmpCold1, 2)} V) also computed for the
          plateau check below.`} />
        <Working n="5" title="Maximum modules per string (cold over-voltage)"
          formula={"N_max = ⌊ min(inverter V_max, module V_sys) / Voc(cold) ⌋"}
          sub={`⌊ min(${inv.vMax}, ${mod.vSysMax}) / ${fmt(r.vocCold1, 2)} ⌋`}
          result={r.bad ? "—" : r.nMax}
          status={!r.bad && r.vocColdN <= r.ceiling ? "OK" : r.bad ? undefined : "FAIL"}
          why={`Hard safety limit — insulation, connectors and the inverter input stage are rated
          to the ceiling. Floor, never round: one more module would present
          ${r.bad ? "—" : fmt((r.nMax + 1) * r.vocCold1, 0)} V on the coldest morning.`} />
        <Working n="6" title="Minimum modules per string (hot full-power floor)"
          formula={"N_min = ⌈ V_fp,lower / Vmp(hot) ⌉"}
          sub={`⌈ ${inv.fpLo} / ${fmt(r.vmpHot1, 2)} ⌉`}
          result={r.bad ? "—" : r.nMin}
          status={!r.bad && r.vmpHotN >= inv.fpLo ? "OK" : r.bad ? undefined : "FAIL"}
          why={`The binding floor is the FULL-POWER window from the P-V curve, not the wider
          tracking window on the datasheet front page. Below it the inverter still tracks but
          cannot deliver rated power — yield collapses quietly on the best days.
          ${r.nStart !== null ? `For information: ${r.nStart} module(s) needed just to start against the ${fmt(r.startV, 0)} V threshold.` : ""}`} />
        <Working n="7" title="Recommended N — frame divisibility"
          formula={"N_rec = N_max − (N_max mod P)  if ≥ N_min, else N_max"}
          sub={`${r.bad ? "—" : `${r.nMax} − (${r.nMax} mod ${frameP}) = ${r.nDivCand}`} vs N_min ${r.bad ? "" : r.nMin}`}
          result={r.valid ? r.nRec : "—"}
          why={`On a ${frameP}P frame, an N divisible by ${frameP} keeps every string on whole
          bays — no strings spanning frames, cleaner harnesses, simpler commissioning. That is
          usually worth trading the odd module below the electrical maximum. If the divisible
          candidate would fall below the hot minimum, the electrical maximum stands instead.`} />
        <Working n="8" title="Cold Vmp vs full-power upper (plateau check)"
          formula={"N × Vmp(cold) ≤ V_fp,upper ?"}
          sub={`${r.N} × ${fmt(r.vmpCold1, 2)} = ${fmt(r.vmpColdN, 0)} V vs ${inv.fpHi} V`}
          result={r.vmpColdN <= inv.fpHi ? "within plateau" : "above plateau"}
          status={r.vmpColdN <= inv.fpHi ? "OK" : "Above plateau"}
          why={`Not a safety limit: above the full-power upper bound the inverter derates when
          cold until the array warms. Flagged so the small cold-morning loss is a conscious
          trade, not a surprise.`} />
        <Working n="9" title="Parallel strings & DC build-up"
          formula={"S = min(connector limit, ⌊ I_MPPT / Isc ⌋)   ·   P_inv = S × N × Pmax × n_MPPT"}
          sub={`min(${inv.connMax ?? "—"}, ${r.byIsc ?? "—"}) = ${r.strPar ?? "—"} · per string ${fmt(r.pString / 1000, 2)} kWp`}
          result={r.pInv !== null ? `${fmt(r.pInv / 1000, 0)} kWp per inverter` : "needs I_MPPT or connector limit"}
          why={`Isc is the conservative current basis. The physical connector count can bind
          before the current does — both are checked and the lower governs.
          ${r.dcac !== null ? `Against the ${inv.acKva} kVA AC rating that is a DC/AC of ${fmt(r.dcac, 2)}.` : "Enter the AC rating for a DC/AC ratio."}`} />
      </div>
    </div>
  );
}

/* =====================================================================
   Workflow shell — parameter pages feed shared state into the design
   steps. Simple mode strips each page to the essentials.
   ===================================================================== */
function Page({ children, wide }) {
  return <div className="pv-page" style={{ flex: 1, overflowY: "auto", padding: "20px 24px", minWidth: 0 }}>
    <div style={{ maxWidth: wide ? 1500 : 860 }}>{children}</div></div>;
}


/* =====================================================================
   Datasheet parsing + component library
   Parsing never applies silently: every value is shown with the line it
   came from, and multi-bin datasheets expose a column picker.
   ===================================================================== */
/* Datasheet parser v2 — template router.
   Handlers: same-line key-value (clean two-column sheets), row-position grid
   (module sheets whose labels and numbers extract separately), cid-decode
   (fonts without a Unicode map), empty detection (image-only PDFs).
   Every value carries the line it came from and a confidence grade, and the
   module grid self-validates with Pmax ≈ Vmp × Imp. */

/* Datasheet parser v2 — template router.
   Handlers: same-line key-value (clean two-column sheets), row-position grid
   (module sheets whose labels and numbers extract separately), cid-decode
   (fonts without a Unicode map), empty detection (image-only PDFs).
   Every value carries the line it came from and a confidence grade, and the
   module grid self-validates with Pmax ≈ Vmp × Imp. */

function normaliseText(raw) {
  let t = raw;
  // fonts without ToUnicode export as (cid:NN); the common offset is +31
  if (/\(cid:\d+\)/.test(t)) {
    const dec = t.replace(/\(cid:(\d+)\)/g, (_, n) => {
      const c = Number(n) + 31;
      return c >= 32 && c < 127 ? String.fromCharCode(c) : " ";
    });
    if (/(maximum|power|voltage|current|module)/i.test(dec)) t = dec;
  }
  // broken-font pdf.js extraction: digits/spaces arrive as control bytes at -31
  if (/[\x01-\x08\x0b\x0c\x0e-\x1f]/.test(t)) {
    t = t.replace(/[\x01-\x08\x0b\x0c\x0e-\x1f]/g, (c) => {  // never touch \n \r \t
      const d = c.charCodeAt(0) + 31;
      return d >= 32 && d < 127 ? String.fromCharCode(d) : " ";
    });
  }
  return t
    .replace(/(\d),(\d{3})\b/g, "$1$2") // thousands separators: 1,500 -> 1500
    .replace(/-\s+(\d)/g, "-$1")        // "- 0.29" -> "-0.29" (sign must attach)
    .replace(/[×xX*]\s*(?=\d)/g, "x")   // dimension separators
    .replace(/[，]/g, ",")
    .replace(/[~～]/g, "-");
}

const NUM = /-?\d+(?:[.,]\d+)?/g;
const nums = (s, lo = -1e12, hi = 1e12) =>
  (s.match(NUM) || []).map((x) => Number(x.replace(",", ".")))
    .filter((v) => Number.isFinite(v) && v >= lo && v <= hi);

/* ---------------- same-line key-value ---------------- */
const MOD_FIELDS = [
  { key: "pmax", label: "Pmax", unit: "W", lo: 80, hi: 1200,
    pat: /(max(?:imum)?\s*power|pmax|p\s*max|nominal power|rated power|peak power)/i },
  { key: "voc", label: "Voc", unit: "V", lo: 5, hi: 200,
    pat: /(open.{0,3}circuit voltage|voc\b|v\s*oc\b)/i },
  { key: "vmp", label: "Vmp", unit: "V", lo: 5, hi: 200,
    pat: /((max(?:imum)?[\s.]*power|mpp?)\s*voltage|vmpp?\b|v\s*mpp?\b)/i },
  { key: "isc", label: "Isc", unit: "A", lo: 0.5, hi: 60,
    pat: /(short.{0,3}circuit current|isc\b|i\s*sc\b)/i },
  { key: "imp", label: "Imp", unit: "A", lo: 0.5, hi: 60,
    pat: /((max(?:imum)?[\s.]*power|mpp?)\s*current|impp?\b|i\s*mpp?\b)/i },
  { key: "bVoc", label: "β Voc", unit: "%/°C", lo: -1.5, hi: -0.01,
    pat: /(temperature coeff\w*.{0,14}(voc|open)|tk\s*\(?\s*voc|coefficient of voc|oe\s*.{0,3}cients?\s*of\s*voc)/i },
  { key: "gPmax", label: "γ Pmax", unit: "%/°C", lo: -1.5, hi: -0.01,
    pat: /(temperature coeff\w*.{0,14}(pmax|p\s*max)|tk\s*\(?\s*p|coefficient of pmax|oe\s*.{0,3}cients?\s*of\s*p\s*max)/i },
  { key: "aIsc", label: "α Isc", unit: "%/°C", lo: 0, hi: 0.3,
    pat: /(temperature coeff\w*.{0,14}(isc|short)|tk\s*\(?\s*isc|coefficient of isc|oe\s*.{0,3}cients?\s*of\s*isc)/i },
  { key: "vSysMax", label: "Max system voltage", unit: "V", lo: 600, hi: 2500,
    pat: /(max(?:imum)?\s*.?ystem\s*.?oltage)/i },
];
const INV_FIELDS = [
  { key: "vMax", label: "Max DC input voltage", unit: "V", lo: 500, hi: 2500,
    pat: /max\w*\.?[\w\s.]*input voltage|max\w*\.?\s*(pv|dc)[\w\s.]*voltage/i,
    avoid: /mppt|range|start|min/i },
  { key: "fpLo", label: "Full-power lower", unit: "V", lo: 100, hi: 1400,
    prefer: /full\s*(load|power)/i, pat: /mpp[t]?[\w\s.]*volt\w*\s*range/i,
    first: true, softIfNoPrefer: true },
  { key: "fpHi", label: "Full-power upper", unit: "V", lo: 100, hi: 1600,
    prefer: /full\s*(load|power)/i, pat: /mpp[t]?[\w\s.]*volt\w*\s*range/i,
    last: true, softIfNoPrefer: true },
  { key: "trackLo", label: "MPPT tracking lower", unit: "V", lo: 100, hi: 1400,
    pat: /mpp[t]?[\w\s.]*volt\w*\s*range/i, avoid: /full\s*(load|power)/i, first: true },
  { key: "vStart", label: "Startup voltage", unit: "V", lo: 100, hi: 1200,
    pat: /start\w*[\s-]*(input\s*)?voltage/i, lastIf: /min/i },
  { key: "iMppt", label: "Max current per MPPT", unit: "A", lo: 5, hi: 200,
    pat: /current\s*per\s*mppt/i },
  { key: "connMax", label: "Strings per MPPT", unit: "", lo: 1, hi: 40,
    pat: /str\w*\s*per\s*mppt/i, int: true },
  { key: "nMppt", label: "Number of MPPTs", unit: "", lo: 1, hi: 60,
    pat: /number of mpp|no\.? of mpp|mpp\w*\s*(inputs|trackers)/i, int: true },
  { key: "acKva", label: "AC rating", unit: "kVA", lo: 50, hi: 6000,
    pat: /rated (ac )?(output )?(power|apparent power)|(max\w*\.?\s*)?ac\s*output\s*power|nominal ac power/i },
];

function parseKV(text, fields) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const out = {};
  for (const f of fields) {
    const pool = f.prefer && lines.some((l) => f.prefer.test(l))
      ? lines.filter((l) => f.prefer.test(l)) : lines;
    const usedPrefer = f.prefer ? pool.length !== lines.length : false;
    for (const line of pool) {
      if (f.avoid && f.avoid.test(line)) continue;
      if (!f.pat.test(line) && !(f.prefer && f.prefer.test(line))) continue;
      let vv = nums(line, f.lo, f.hi);
      if (f.int) vv = vv.filter((v) => v === Math.round(v));
      if (!vv.length) continue;
      let vals = vv;
      if (f.first) vals = [vv[0]];
      if (f.last || (f.lastIf && f.lastIf.test(line))) vals = [vv[vv.length - 1]];
      out[f.key] = {
        vals, line: line.slice(0, 96), pick: 0,
        conf: f.softIfNoPrefer && !usedPrefer ? "low" : "high",
        note: f.softIfNoPrefer && !usedPrefer
          ? "taken from the MPPT tracking range — confirm against the P-V curve" : undefined,
      };
      break;
    }
  }
  let dim = text.match(/(\d{3,4})\s*x\s*(\d{3,4})\s*x\s*(\d{1,3})\s*mm/i);
  if (!dim && fields === MOD_FIELDS) {
    for (const line of text.split(/\r?\n/)) {
      if (!/dimensi/i.test(line)) continue;
      const m = line.match(/(\d{4})\s+(\d{4})\s+(\d{2,3})\s*mm/);
      if (m) { dim = m; break; }
    }
  }
  if (dim && fields === MOD_FIELDS) {
    const a = Number(dim[1]), b = Number(dim[2]);
    out.length = { vals: [Math.max(a, b) / 1000], line: dim[0], pick: 0, conf: "high" };
    out.width = { vals: [Math.min(a, b) / 1000], line: dim[0], pick: 0, conf: "high" };
  }
  return out;
}

/* ---------------- module cell-grid: labels and numbers separated ---------- */
const GRID_LABELS = [
  { key: "pmax", re: /(max(imum)?\s*power|peak power)\s*(watt)?s?[\s\-]*\(?p/i, lo: 80, hi: 1200 },
  { key: "vmp", re: /max(imum)?\s*power\s*voltage/i, lo: 20, hi: 90 },
  { key: "imp", re: /max(imum)?\s*power\s*current/i, lo: 3, hi: 30 },
  { key: "voc", re: /open.{0,3}circuit\s*voltage/i, lo: 20, hi: 90 },
  { key: "isc", re: /short.{0,3}circuit\s*current/i, lo: 3, hi: 30 },
];

function parseModuleGrid(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  // label order from the first (STC) block
  const order = [];
  const inline = {};
  for (const ln of lines) {
    for (const L of GRID_LABELS) {
      if (order.some((o) => o.key === L.key)) continue;
      if (!L.re.test(ln)) continue;
      const all = nums(ln);
      if (all.length >= 4) {
        // pdf.js keeps label and numbers together — the row is right here
        order.push({ ...L, line: ln });
        inline[L.key] = { vals: all, line: ln };
      } else if (all.length === 0 || nums(ln, L.lo, L.hi).length === 0) {
        order.push({ ...L, line: ln });
      }
    }
    if (order.length === GRID_LABELS.length) break;
  }
  if (order.length < 4) return null;

  // pure number rows, in document order
  const rows = [];
  for (const ln of lines) {
    const stripped = ln.replace(NUM, "").replace(/[\s.,%+\-°C~x]/gi, "");
    if (stripped.length > 2) continue;
    const vv = nums(ln);
    if (vv.length >= 3) rows.push({ vals: vv, line: ln });
  }
  if (!rows.length) return null;

  // bins & stride from a repeated STC header if present
  let stride = 1, offset = 0, bins = null;
  const header = lines.find((l) => (l.match(/\bSTC\b/g) || []).length >= 2);
  if (header) {
    const toks = header.split(/\s+/).filter((t) => /^[A-Z]{2,6}$/.test(t));
    const nB = (header.match(/\bSTC\b/g) || []).length;
    stride = Math.max(1, Math.round(toks.length / nB));
    offset = Math.max(0, toks.slice(0, stride).indexOf("STC"));
    bins = nB;
  }

  // walk labels in order, consuming the next number row whose values fit
  const out = {};
  let ri = 0;
  for (const L of order) {
    if (inline[L.key]) {
      const r = inline[L.key];
      const s = bins ? Math.max(1, Math.round(r.vals.length / bins)) : stride;
      const vals = [];
      for (let i = offset; i < r.vals.length; i += s) vals.push(r.vals[i]);
      out[L.key] = { vals, line: r.line.slice(0, 96), pick: 0, conf: "medium" };
      continue;
    }
    let found = null;
    for (let j = ri; j < rows.length; j++) {
      const inRange = rows[j].vals.filter((v) => v >= L.lo && v <= L.hi).length;
      if (inRange >= rows[j].vals.length * 0.8) { found = j; break; }
    }
    if (found === null) continue;
    ri = found + 1;
    const r = rows[found];
    const s = bins ? Math.max(1, Math.round(r.vals.length / bins)) : stride;
    const vals = [];
    for (let i = offset; i < r.vals.length; i += s) vals.push(r.vals[i]);
    out[L.key] = { vals, line: r.line.slice(0, 96), pick: 0, conf: "medium" };
  }

  // clamp every row to the bin count set by the power row — strips stray tokens
  if (out.pmax && out.pmax.vals.length >= 3) {
    const nB = out.pmax.vals.length;
    for (const k of Object.keys(out)) out[k].vals = out[k].vals.slice(0, nB);
  }

  // self-validation: Pmax ≈ Vmp × Imp per bin
  let valid = null;
  if (out.pmax && out.vmp && out.imp) {
    const n = Math.min(out.pmax.vals.length, out.vmp.vals.length, out.imp.vals.length);
    let ok = 0;
    for (let i = 0; i < n; i++) {
      const p = out.pmax.vals[i], q = out.vmp.vals[i] * out.imp.vals[i];
      if (Math.abs(p - q) / p < 0.04) ok++;
    }
    valid = n > 0 && ok === n;
    if (valid) for (const k of Object.keys(out)) out[k].conf = "high";
    else for (const k of Object.keys(out)) out[k].conf = "low";
  }
  return { fields: out, valid, binCount: out.pmax ? out.pmax.vals.length : 0 };
}

/* ---------------- router ---------------- */
function parseSheet(raw, kind /* "module" | "inverter" */) {
  const text = normaliseText(raw);
  if (text.replace(/[\s\x00-\x1f]/g, "").length < 60) {
    return { empty: true, fields: {}, template: "image-only" };
  }
  const fields = parseKV(text, kind === "module" ? MOD_FIELDS : INV_FIELDS);
  let template = "two-column", valid = null, brokenFont = false;
  if (kind === "module") {
    const grid = parseModuleGrid(text);
    const core = ["pmax", "voc", "vmp", "isc", "imp"];
    if (grid && (grid.valid === true || core.filter((k) => !fields[k]).length >= 2)) {
      template = "cell-grid";
      valid = grid.valid;
      for (const [k, v] of Object.entries(grid.fields)) {
        if (grid.valid === true || !fields[k] || fields[k].conf !== "high") fields[k] = v;
      }
    }
    // broken font: the text needed decoding yet the labels stayed unreadable
    const wasShifted = /[\x01-\x08\x0b\x0c\x0e-\x1f]/.test(raw);
    if (wasShifted && core.filter((k) => !fields[k]).length >= 3) brokenFont = true;
  }
  const decoded = /\(cid:\d+\)/.test(raw) || /[\x01-\x08\x0b\x0c\x0e-\x1f]/.test(raw);
  return { empty: false, fields, template, valid, decoded, brokenFont };
}


let _workerReady = false;
function ensurePdfWorker() {
  if (_workerReady) return;
  const blob = new Blob([PDF_WORKER_TEXT], { type: "text/javascript" });
  pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(blob);
  _workerReady = true;
}

/** Browser-side text extraction, identical to the tested Node path:
    group items into visual lines by y, order by x, space on gaps. */
async function extractPdfText(data) {
  ensurePdfWorker();
  const doc = await pdfjsLib.getDocument({ data, useSystemFonts: true, verbosity: 0 }).promise;
  const out = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    const items = tc.items.filter((i) => i.str && i.str.trim().length);
    const rows = [];
    for (const it of items) {
      const y = it.transform[5], x = it.transform[4];
      let r = rows.find((q) => Math.abs(q.y - y) < 3);
      if (!r) { r = { y, parts: [] }; rows.push(r); }
      r.parts.push({ x, s: it.str, w: it.width || 0 });
    }
    rows.sort((a, b) => b.y - a.y);
    for (const r of rows) {
      r.parts.sort((a, b) => a.x - b.x);
      let line = "", lastEnd = null;
      for (const pt of r.parts) {
        if (lastEnd !== null && pt.x - lastEnd > 1.5) line += " ";
        line += pt.s;
        lastEnd = pt.x + pt.w;
      }
      out.push(line.trim());
    }
    out.push("");
  }
  try { doc.destroy(); } catch (e) { /* noop */ }
  return out.join("\n");
}

const LIB_KEY = "pvhub.library.v1";
let memLib = null;
function loadLib() {
  if (memLib) return memLib;
  try {
    const raw = window.localStorage.getItem(LIB_KEY);
    memLib = raw ? JSON.parse(raw) : { modules: [], inverters: [] };
  } catch (e) { memLib = { modules: [], inverters: [] }; }
  if (!memLib.modules) memLib.modules = [];
  if (!memLib.inverters) memLib.inverters = [];
  return memLib;
}
function saveLib(lib) {
  memLib = lib;
  try { window.localStorage.setItem(LIB_KEY, JSON.stringify(lib)); return true; }
  catch (e) { return false; }
}

function ConfBadge({ c }) {
  const col = c === "high" ? "#59b56f" : c === "medium" ? "#d9a441" : "#d67070";
  return <span style={{ font: "700 8.5px system-ui", letterSpacing: "0.06em", color: col,
    border: `1px solid ${col}55`, borderRadius: 3, padding: "1px 5px", textTransform: "uppercase" }}>{c}</span>;
}

function DatasheetPanel({ kind, current, onApply, kindLabel }) {
  const fields = kind === "module" ? MOD_FIELDS : INV_FIELDS;
  const [text, setText] = useState("");
  const [res, setRes] = useState(null);
  const [picks, setPicks] = useState({});
  const [binIdx, setBinIdx] = useState(0);

  const [pdfBusy, setPdfBusy] = useState(false);
  const [pdfMsg, setPdfMsg] = useState("");
  const runText = (t) => {
    const r = parseSheet(t, kind);
    setRes(r);
    setPicks(Object.fromEntries(Object.keys(r.fields).map((k) => [k, 0])));
    setBinIdx(0);
  };
  const run = () => runText(text);
  const onPdf = async (file) => {
    setPdfBusy(true); setPdfMsg("");
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      const t = await extractPdfText(buf);
      setText(t);
      setPdfMsg(`Read ${file.name}.`);
      runText(t);
    } catch (e) {
      setPdfMsg(`Could not read that PDF (${e.message}). Paste the table instead.`);
      setRes(null);
    } finally { setPdfBusy(false); }
  };
  const found = res?.fields || {};
  const rows = Object.entries(found);
  // aligned power-bin group: one selector drives them all
  const binN = found.pmax && found.pmax.vals.length > 1 ? found.pmax.vals.length : 0;
  const binKeys = binN
    ? ["pmax", "vmp", "imp", "voc", "isc"].filter((k) => found[k]?.vals.length === binN)
    : [];
  const valueOf = (k, v) => binKeys.includes(k) ? v.vals[binIdx] : v.vals[picks[k] ?? 0];

  const [prev, setPrev] = useState(null);
  const apply = () => {
    const patch = {};
    for (const [k, v] of rows) patch[k] = valueOf(k, v);
    setPrev({ ...current });
    onApply(patch);
    setRes(null); setText("");
  };
  const missing = res && !res.empty
    ? fields.filter((f) => !found[f.key]).map((f) => f.label) : [];

  return (
    <>
      <div className="readout">
        Open the {kindLabel} datasheet, select the specification table, copy, and paste below.
        The parser recognises the common layouts (clean two-column tables, and module sheets
        whose labels and numbers separate on copy) and shows every value with the line it came
        from — nothing applies until you confirm.
      </div>
      <textarea className="coords" style={{ height: 96 }} value={text}
        placeholder={"Paste the datasheet table here…"}
        onChange={(e) => setText(e.target.value)} />
      <div style={{ display: "flex", gap: 8, width: "100%", flexWrap: "wrap" }}>
        <label className="btn primary" style={{ cursor: pdfBusy ? "wait" : "pointer" }}>
          {pdfBusy ? "Reading PDF…" : "Upload PDF"}
          <input type="file" accept=".pdf,application/pdf" style={{ display: "none" }}
            disabled={pdfBusy}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) onPdf(f); e.target.value = ""; }} />
        </label>
        <button className="btn" onClick={run} disabled={!text.trim() || pdfBusy}>Read pasted text</button>
        {res && <button className="btn" onClick={() => { setRes(null); setText(""); setPdfMsg(""); }}>Clear</button>}
      </div>
      {pdfMsg && <div style={{ font: "11px system-ui", color: C.muted }}>{pdfMsg}</div>}

      {prev && !res && (
        <button className="btn" onClick={() => { onApply(prev); setPrev(null); }}>
          Undo last apply — restore previous values</button>
      )}
      {res?.empty && (
        <div className="warn" style={{ width: "100%" }}>
          ⚠ That paste carries no readable text — some datasheets (JA is one) are exported as
          pure images, so there is nothing to copy. For those, use a saved component from the
          library below or enter the values by hand.
        </div>
      )}
      {res && !res.empty && rows.length === 0 && (
        <div className="warn" style={{ width: "100%" }}>
          ⚠ Nothing recognised. Paste a block that includes the parameter names as well as the
          numbers, or enter the values by hand.
        </div>
      )}

      {rows.length > 0 && (
        <div style={{ width: "100%", display: "flex", flexDirection: "column", gap: 6 }}>
          {res.decoded && (
            <div className="readout">This sheet used a non-standard font encoding — it has
              been decoded automatically. Give the values a harder look than usual.</div>
          )}
          {res.brokenFont && (
            <div className="warn" style={{ width: "100%" }}>
              ⚠ This PDF uses a font without a proper character map, so its parameter names
              come out unreadable and only fragments could be recovered. Jinko sheets are the
              known case. Use a saved component from the library, or open the PDF in a viewer,
              copy the table there and paste it — viewers often decode better than extraction.
            </div>
          )}
          {res.valid === true && (
            <div style={{ font: "11px system-ui", color: "#59b56f" }}>
              ✓ Cross-checked: Pmax ≈ Vmp × Imp holds for every power bin.
            </div>
          )}
          {res.valid === false && (
            <div className="warn">⚠ Cross-check failed: Pmax ≠ Vmp × Imp — the rows may have
              paired up wrongly. Treat everything below as suspect and verify by eye.</div>
          )}

          {binN > 1 && (
            <div style={{ background: C.panel2, border: `1px solid ${C.line}`, borderRadius: 4, padding: "7px 9px" }}>
              <div style={{ font: "600 10px system-ui", color: C.muted, letterSpacing: "0.07em",
                textTransform: "uppercase", marginBottom: 5 }}>
                Power bin — one choice sets every linked row
              </div>
              <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                {found.pmax.vals.map((w, i) => (
                  <button key={i} className={`btn ${binIdx === i ? "on" : ""}`}
                    style={{ padding: "3px 10px", fontSize: 11.5 }}
                    onClick={() => setBinIdx(i)}>{w} W</button>
                ))}
              </div>
            </div>
          )}

          {rows.map(([k, v]) => {
            const f = fields.find((x) => x.key === k) ||
              { label: k === "length" ? "Length" : "Width", unit: "m" };
            const linked = binKeys.includes(k);
            return (
              <div key={k} style={{ background: C.panel2, border: `1px solid ${C.line}`,
                borderRadius: 4, padding: "6px 9px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span style={{ font: "600 11px system-ui", color: C.text, minWidth: 118 }}>{f.label}</span>
                  <b style={{ font: "12px var(--mono)", color: C.accent }}>
                    {valueOf(k, v)} {f.unit}
                  </b>
                  <ConfBadge c={v.conf || "medium"} />
                  {linked && <span style={{ font: "9px system-ui", color: C.muted }}>bin-linked</span>}
                  {!linked && v.vals.length > 1 && (
                    <span style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                      {v.vals.map((val, i) => (
                        <button key={i} className={`btn ${(picks[k] ?? 0) === i ? "on" : ""}`}
                          style={{ padding: "2px 8px", fontSize: 11 }}
                          onClick={() => setPicks({ ...picks, [k]: i })}>{val}</button>
                      ))}
                    </span>
                  )}
                </div>
                {v.note && <div style={{ font: "10px system-ui", color: C.warn, marginTop: 3 }}>⚠ {v.note}</div>}
                <div style={{ font: "10px var(--mono)", color: C.muted, marginTop: 3 }}>“{v.line}”</div>
              </div>
            );
          })}
          {missing.length > 0 && (
            <div className="warn">⚠ Not found, enter by hand: {missing.join(", ")}</div>
          )}
          <button className="btn primary" onClick={apply}>
            Apply {rows.length} value{rows.length === 1 ? "" : "s"}
          </button>
        </div>
      )}
    </>
  );
}

function LibraryPanel({ kind, current, onLoad }) {
  const [lib, setLib] = useState(loadLib());
  const [name, setName] = useState("");
  const [msg, setMsg] = useState("");
  const list = lib[kind] || [];
  const commit = (next) => {
    setLib({ ...next });
    if (!saveLib(next)) setMsg("Saved for this session only — browser storage is unavailable here.");
  };
  const save = () => {
    const n = (name || "").trim();
    if (!n) return;
    const next = { ...lib, [kind]: [...list.filter((e) => e.name !== n), { name: n, data: current }] };
    commit(next); setName(""); setMsg(`Saved “${n}”.`);
  };
  const del = (n) => commit({ ...lib, [kind]: list.filter((e) => e.name !== n) });
  const exportLib = () => {
    const blob = new Blob([JSON.stringify(lib, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "pvhub-component-library.json";
    a.click(); URL.revokeObjectURL(a.href);
  };
  const importLib = (file) => {
    const rd = new FileReader();
    rd.onload = () => {
      try {
        const d = JSON.parse(String(rd.result));
        const merge = (a = [], b = []) => {
          const m = new Map(a.map((e) => [e.name, e]));
          for (const e of b) m.set(e.name, e);
          return [...m.values()];
        };
        commit({ modules: merge(lib.modules, d.modules), inverters: merge(lib.inverters, d.inverters) });
        setMsg("Library merged.");
      } catch (e) { setMsg("That file could not be read."); }
    };
    rd.readAsText(file);
  };
  return (
    <>
      <div style={{ display: "flex", gap: 8, width: "100%" }}>
        <span className="fld-box" style={{ flex: 1 }}>
          <input value={name} placeholder="Name, e.g. Trina TSM-NEG19RC.20"
            onChange={(e) => setName(e.target.value)} />
        </span>
        <button className="btn primary" onClick={save} disabled={!name.trim()}>Save current</button>
      </div>
      {list.length > 0 && (
        <div style={{ width: "100%", display: "flex", flexDirection: "column", gap: 4 }}>
          {list.map((e) => (
            <div key={e.name} style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <button className="btn" style={{ flex: 1, textAlign: "left" }}
                onClick={() => onLoad(e.data)}>{e.name}</button>
              <button className="btn" onClick={() => del(e.name)}>×</button>
            </div>
          ))}
        </div>
      )}
      <div style={{ display: "flex", gap: 8, width: "100%" }}>
        <button className="btn" onClick={exportLib}>Export library</button>
        <label className="btn" style={{ cursor: "pointer" }}>Import
          <input type="file" accept=".json" style={{ display: "none" }}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) importLib(f); e.target.value = ""; }} />
        </label>
      </div>
      <div className="readout">
        {msg && <><b>{msg}</b><br /></>}
        Saved components live in this browser. Export the library to a file to share it with
        colleagues or move it between machines — importing merges by name.
      </div>
    </>
  );
}

function ModuleTab({ mod, setMod, uiMode }) {
  return (
    <Page>
      <div className="tbl" style={{ marginBottom: 6 }}>STEP 1 — MODULE PARAMETERS (from the datasheet)</div>
      <div style={{ font: "11px system-ui", color: C.muted, marginBottom: 10 }}>
        Steps run 1→7 but nothing is gated — every page has working defaults, so you can jump
        straight to 7 · Layout to check the array fits the site, then come back to refine.
      </div>
      <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 6 }}>
        <Section code="1A" title="Physical">
          <NumS label="Length" unit="m" obj={mod} set={setMod} k="length" step={0.001} />
          <NumS label="Width" unit="m" obj={mod} set={setMod} k="width" step={0.001} />
          <NumS label="Rated power" unit="Wp" obj={mod} set={setMod} k="power" step={5} />
          <div className="readout">
            Area <b>{fmt(mod.length * mod.width, 3)} m²</b> · efficiency
            <b> {fmt(mod.power / (mod.length * mod.width * 10), 1)}%</b>
          </div>
        </Section>
        <Section code="1B" title="Electrical (STC)">
          <NumS label="Voc" unit="V" obj={mod} set={setMod} k="voc" />
          <NumS label="Vmp" unit="V" obj={mod} set={setMod} k="vmp" />
          <NumS label="Isc" unit="A" obj={mod} set={setMod} k="isc" />
          <NumS label="Imp" unit="A" obj={mod} set={setMod} k="imp" />
          <NumS label="β Voc" unit="%/°C" obj={mod} set={setMod} k="bVoc" />
          <NumS label="γ Pmax" unit="%/°C" obj={mod} set={setMod} k="gPmax" />
          {uiMode === "engineer" && (<>
            <NumS label="α Isc" unit="%/°C" obj={mod} set={setMod} k="aIsc" />
            <NumO label="β Vmp (if published)" unit="%/°C" value={mod.bVmp}
              onChange={(v) => setMod({ ...mod, bVmp: v })} />
            <NumS label="Max system voltage" unit="V" obj={mod} set={setMod} k="vSysMax" step={50} />
          </>)}
          <div className="readout">
            These flow into every later step — string sizing uses the voltages and
            coefficients, the layout uses the physical envelope and power.
          </div>
          <div style={{ width: "100%" }}><ModuleIV mod={mod} /></div>
        </Section>
        <Section code="1C" title="Read from a datasheet">
          <DatasheetPanel kind="module" kindLabel="module" current={mod}
            onApply={(patch) => setMod({ ...mod, ...patch, power: patch.pmax ?? mod.power })} />
        </Section>
        <Section code="1D" title="Saved modules">
          <LibraryPanel kind="modules" current={mod} onLoad={(d) => setMod({ ...mod, ...d })} />
        </Section>
      </div>
    </Page>
  );
}

function InverterTab({ inv, setInv, uiMode }) {
  return (
    <Page>
      <div className="tbl" style={{ marginBottom: 10 }}>STEP 2 — INVERTER PARAMETERS (datasheet + P-V curve)</div>
      <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 6 }}>
        <Section code="2A" title="Voltage windows">
          <NumS label="Max DC input" unit="V" obj={inv} set={setInv} k="vMax" step={50} />
          <NumS label="Full-power upper (P-V curve)" unit="V" obj={inv} set={setInv} k="fpHi" step={10} />
          <NumS label="Full-power lower (P-V curve)" unit="V" obj={inv} set={setInv} k="fpLo" step={10} />
          {uiMode === "engineer" && (<>
            <NumO label="MPPT tracking lower" unit="V" value={inv.trackLo}
              onChange={(v) => setInv({ ...inv, trackLo: v })} />
            <NumO label="Startup voltage" unit="V" value={inv.vStart}
              onChange={(v) => setInv({ ...inv, vStart: v })} />
          </>)}
        </Section>
        <Section code="2B" title="Current & rating">
          <NumO label="Max current per MPPT" unit="A" value={inv.iMppt} step={1}
            onChange={(v) => setInv({ ...inv, iMppt: v })} />
          <NumS label="MPPT inputs" obj={inv} set={setInv} k="nMppt" step={1} />
          {uiMode === "engineer" && (
            <NumO label="Max strings per MPPT (connectors)" value={inv.connMax} step={1}
              onChange={(v) => setInv({ ...inv, connMax: v })} />
          )}
          <NumO label="AC rating at design ambient" unit="kVA" value={inv.acKva} step={5}
            onChange={(v) => setInv({ ...inv, acKva: v })} />
          <div className="readout">
            The AC rating drives the paralleling/clipping table and the layout's AC targets.
          </div>
          <div style={{ width: "100%" }}><InverterWindow inv={inv} /></div>
        </Section>
        <Section code="2C" title="Read from a datasheet">
          <DatasheetPanel kind="inverter" kindLabel="inverter" current={inv}
            onApply={(patch) => setInv({ ...inv, ...patch })} />
        </Section>
        <Section code="2D" title="Saved inverters">
          <LibraryPanel kind="inverters" current={inv} onLoad={(d) => setInv({ ...inv, ...d })} />
        </Section>
      </div>
    </Page>
  );
}

function FrameTab({ frame, setFrame, mod, elec, uiMode }) {
  const geo = computeFrameGeometry(mod, frame);
  const spf = geo.modules / Math.max(1, elec.modulesPerString);
  return (
    <Page>
      <div className="tbl" style={{ marginBottom: 10 }}>STEP 3 — MOUNTING FRAME</div>
      <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 6 }}>
        <Section code="3A" title="Configuration">
          <Sel label="Mounting" value={frame.mounting}
            options={[
              { value: "tracker", label: "Single-axis tracker (axis N–S)" },
              { value: "fixed", label: "Fixed tilt (rows E–W)" },
              { value: "ew", label: "East–West duo (rows N–S)" },
            ]}
            onChange={(v) => setFrame({ ...frame, mounting: v })} />
          <Sel label="Configuration" value={String(frame.config)}
            options={[1, 2, 3, 4].map((n) => ({ value: String(n), label: `${n}P — ${n} module(s) across` }))}
            onChange={(v) => setFrame({ ...frame, config: Number(v) })} />
          <Sel label="Module orientation" value={frame.orientation}
            options={[
              { value: "portrait", label: "Portrait" },
              { value: "landscape", label: "Landscape" },
            ]}
            onChange={(v) => setFrame({ ...frame, orientation: v })} />
          <Sel label="Frame sizing" value={frame.sizeMode}
            options={[
              { value: "count", label: "By module count" },
              { value: "length", label: "By max frame length" },
            ]}
            onChange={(v) => setFrame({ ...frame, sizeMode: v })} />
          {frame.sizeMode === "count" ? (
            <Num label="Modules per frame" value={frame.modulesPerFrame} step={1} min={1}
              onChange={(v) => setFrame({ ...frame, modulesPerFrame: Math.round(v) })} />
          ) : (
            <Num label="Max frame length" unit="m" value={frame.maxLength} step={0.5} min={1}
              onChange={(v) => setFrame({ ...frame, maxLength: v })} />
          )}
          {uiMode === "engineer" && (<>
            <Num label="Module gap" unit="m" value={frame.gapAlong} step={0.005} min={0}
              onChange={(v) => setFrame({ ...frame, gapAlong: v })} />
            <Num label="Cross gap" unit="m" value={frame.crossGap} step={0.005} min={0}
              onChange={(v) => setFrame({ ...frame, crossGap: v })} />
            <Num label="End overhang" unit="m" value={frame.endOverhang} step={0.05} min={0}
              onChange={(v) => setFrame({ ...frame, endOverhang: v })} />
            <Num label="Central gap" unit="m" value={frame.centreGap} step={0.05} min={0}
              onChange={(v) => setFrame({ ...frame, centreGap: v })} />
          </>)}
          {frame.mounting !== "tracker" && (
            <Num label="Tilt" unit="°" value={frame.tilt} step={1} min={0} max={60}
              onChange={(v) => setFrame({ ...frame, tilt: v })} />
          )}
          <div className="readout">
            Envelope <b>{fmtDim(geo.alongLen)} × {fmtDim(geo.acrossW)} m</b> ·
            <b> {geo.modules}</b> modules · <b>{fmt(spf, 2)}</b> strings of {elec.modulesPerString}
            {Number.isInteger(spf)
              ? <> — whole strings on the frame ✓</>
              : <> — ⚠ not a whole number of strings; adjust modules per frame or string length</>}
          </div>
          <WarnList items={geo.warnings} />
        </Section>
        <Section code="3B" title="Frame drawing (live)">
          <div style={{ width: "100%", maxWidth: 420 }}>
            <FrameDiagram geo={geo} stringsPerFrame={spf} />
          </div>
        </Section>
      </div>
    </Page>
  );
}

function ClippingTab({ mod, inv, elec, setElec, ilrCap, setIlrCap }) {
  const ac = inv.acKva || 0;
  const stringKWp = elec.modulesPerString * mod.power / 1000;
  const rows = useMemo(() => {
    if (!(ac > 0) || !(stringKWp > 0)) return [];
    const sMin = Math.max(1, Math.floor((0.8 * ac) / stringKWp));
    const sMax = Math.ceil((1.5 * ac) / stringKWp);
    const out = [];
    for (let s = sMin; s <= sMax; s++) {
      const dc = s * stringKWp;
      const ilr = dc / ac;
      const clip = ilr <= 1 ? 0 : 45.5 * Math.pow(ilr - 1, 2.26);
      out.push({ s, dc, ilr, clip });
    }
    for (let i = 1; i < out.length; i++) {
      const dDC = (out[i].dc - out[i - 1].dc) / out[i - 1].dc * 100;
      const dClip = out[i].clip - out[i - 1].clip;
      out[i].net = dDC - dClip;
    }
    return out;
  }, [ac, stringKWp]);
  const knee = rows.findIndex((r2) => r2.net !== undefined && r2.net < 0.4);
  const [actual, setActual] = useState({});
  const acts = rows.filter((r2) => actual[r2.s] !== undefined && actual[r2.s] !== null && r2.ilr <= ilrCap);
  const bestS = acts.length ? acts.reduce((m, r2) => (actual[r2.s] < actual[m.s] ? r2 : m)).s : null;
  return (
    <Page wide>
      <div className="tbl" style={{ marginBottom: 10 }}>STEP 5 — STRING PARALLELING & CLIPPING</div>
      <div style={{ display: "flex", gap: 14, alignItems: "flex-start", flexWrap: "wrap", marginBottom: 12 }}>
        <div style={{ flex: "1 1 420px", minWidth: 300, display: "flex", gap: 10, flexWrap: "wrap" }}>
        <Num label="Max acceptable ILR (DC/AC)" value={ilrCap} step={0.05} min={1}
          onChange={setIlrCap} width={190} />
        <div className="readout" style={{ flex: 1, minWidth: 260 }}>
          String {fmt(stringKWp, 2)} kWp ({elec.modulesPerString} × {mod.power} W) against
          {" "}{ac || "—"} kVA AC. Keep ILR ≤ <b>{fmt(ilrCap, 2)}</b>; clipping grows
          non-linearly and concentrates in the best hours, and with bifacial rear-gain
          uncertainty the estimate is the least trustworthy figure in a run — be conservative.
        </div>
        </div>
        <div style={{ background: C.paper, borderRadius: 6, padding: "8px 8px 2px",
          flex: "1 1 380px", minWidth: 320, maxWidth: 520 }}>
          <ClipCurve ilr={ac > 0 ? (elec.stringsPerInverter * stringKWp) / ac : 0} ilrCap={ilrCap} />
        </div>
      </div>
      {!ac && <div className="warn">⚠ Set the inverter AC rating in Step 2 first.</div>}
      {rows.length > 0 && (
        <div style={{ overflowX: "auto", width: "100%" }}><table style={{ borderCollapse: "collapse", width: "100%", minWidth: 560, font: "12px var(--mono)" }}>
          <thead><tr style={{ color: C.muted, textAlign: "left" }}>
            {["Strings", "Modules", "DC kWp", "ILR", "Model clip %", "PVsyst clip %", "Marginal net %", ""].map((h) => (
              <th key={h} style={{ padding: "6px 10px", borderBottom: `1px solid ${C.line}`, font: "600 10px system-ui", textTransform: "uppercase", letterSpacing: "0.07em" }}>{h}</th>
            ))}
          </tr></thead>
          <tbody>
            {rows.map((r2, i) => {
              const over = r2.ilr > ilrCap;
              const sel = r2.s === elec.stringsPerInverter;
              return (
                <tr key={r2.s} style={{
                  background: sel ? "rgba(232,130,12,0.12)" : "transparent",
                  color: over ? "#d67070" : C.text,
                }}>
                  <td style={{ padding: "5px 10px" }}>{r2.s}</td>
                  <td style={{ padding: "5px 10px" }}>{r2.s * elec.modulesPerString}</td>
                  <td style={{ padding: "5px 10px" }}>{fmt(r2.dc, 0)}</td>
                  <td style={{ padding: "5px 10px" }}><b>{fmt(r2.ilr, 2)}</b></td>
                  <td style={{ padding: "5px 10px", color: C.muted }}>{fmt(r2.clip, 2)}</td>
                  <td style={{ padding: "5px 10px" }}>
                    <input type="number" step="0.05" placeholder="—"
                      value={actual[r2.s] ?? ""}
                      onChange={(e) => setActual({ ...actual, [r2.s]: e.target.value === "" ? null : Number(e.target.value) })}
                      style={{ width: 70, background: C.panel2, border: `1px solid ${C.line}`, borderRadius: 4,
                        color: C.text, font: "12px var(--mono)", padding: "3px 6px", outline: "none" }} />
                    {r2.s === bestS && <span style={{ color: "#59b56f", marginLeft: 5 }}>★</span>}
                  </td>
                  <td style={{ padding: "5px 10px", color: C.muted }}>
                    {r2.net === undefined ? "—" : fmt(r2.net, 2)}
                    {i === knee ? "  ← diminishing returns" : ""}
                  </td>
                  <td style={{ padding: "5px 10px" }}>
                    <button className={`btn ${sel ? "on" : ""}`}
                      onClick={() => setElec({ ...elec, stringsPerInverter: r2.s })}>
                      {sel ? "In use" : "Use"}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table></div>
      )}
      <div style={{ font: "10.5px system-ui", color: C.muted, marginTop: 10 }}>
        The MODEL column is a parametric estimate for shape only — run the candidates in
        PVsyst/PVcase, type the real clipping into the PVSYST column, and the ★ marks the best
        run within your ILR cap. Pick it with Use; you can come back and re-pick any time — the
        choice carries into the frame and layout steps. Clipping here is a parametric estimate (zero below ILR 1.0, then ~45·(ILR−1)^2.3) for
        comparison between rows only — PVsyst governs the accepted figure. Marginal net =
        added DC % minus added clipping % per extra string; below ~0.4 the extra string buys
        little.
      </div>
    </Page>
  );
}

/* ============================================================
   Pitch yield model.

   PVGIS supplies the irradiance only: its API has no pitch, GCR or
   row-spacing parameter, so every row-geometry effect below is computed
   here. What the model resolves, per hour of a TMY:

     - backtracking rotation and the cosine penalty it costs (trackers)
     - direct beam row shading (fixed tilt, or trackers without backtrack)
     - diffuse sky view factor reduced by the row in front
     - ground-reflected front component
     - a simplified bifacial rear gain that scales with GCR

   Absolute yield is indicative. The differences between pitches are the
   trustworthy output, because they are driven by geometry rather than by
   the irradiance dataset.
   ============================================================ */

const D2R = Math.PI / 180;

/** Equation of time, minutes. */
function eqTime(n) {
  const B = (2 * Math.PI * (n - 81)) / 364;
  return 9.87 * Math.sin(2 * B) - 7.53 * Math.cos(B) - 1.5 * Math.sin(B);
}

/** Sun unit vector in East-North-Up. h is local solar hour. */
function sunVector(latDeg, n, h) {
  const phi = latDeg * D2R;
  const dec = 23.45 * D2R * Math.sin((2 * Math.PI * (284 + n)) / 365);
  const w = (h - 12) * 15 * D2R;
  const cd = Math.cos(dec), sd = Math.sin(dec);
  const cp = Math.cos(phi), sp = Math.sin(phi);
  const cw = Math.cos(w);
  return {
    x: -cd * Math.sin(w),        // east
    y: sd * cp - cd * sp * cw,   // north
    z: sd * sp + cd * cp * cw,   // up
  };
}

/** ASHRAE clear-sky irradiance — the offline fallback when PVGIS is
    unreachable, and the reference case for testing the geometry. */
function clearSky(n, elevSin) {
  if (elevSin <= 0) return { dni: 0, dhi: 0, ghi: 0 };
  const A = 1160 + 75 * Math.sin((2 * Math.PI * (n - 275)) / 365);
  const B = 0.174 + 0.035 * Math.sin((2 * Math.PI * (n - 100)) / 365);
  const C = 0.095 + 0.04 * Math.sin((2 * Math.PI * (n - 100)) / 365);
  const dni = A * Math.exp(-B / elevSin);
  const dhi = C * dni;
  return { dni, dhi, ghi: dni * elevSin + dhi };
}

/** Tracker rotation about a horizontal north-south axis.
    Positive tilts the normal toward the east. */
function trackerRotation(sun, gcr, maxRotRad, backtrack) {
  const ideal = Math.atan2(sun.x, sun.z);
  let R = Math.max(-maxRotRad, Math.min(maxRotRad, ideal));
  if (backtrack) {
    const c = Math.cos(ideal);
    if (c > 1e-6 && c < gcr) {
      // rotate back until the shadow exactly reaches the next row
      const a = Math.acos(Math.min(1, c / gcr));
      R = ideal - Math.sign(ideal) * a;
      R = Math.max(-maxRotRad, Math.min(maxRotRad, R));
    }
  }
  return R;
}

/** Fraction of the collector height shaded by the row in front.
    thetaP is the sun's projected angle in the cross-axis vertical plane. */
function shadedFraction(R, thetaP, gcr) {
  const cA = Math.cos(thetaP);
  const cB = Math.cos(R - thetaP);
  if (cA <= 1e-6 || cB <= 1e-6) return 1;
  const f = 1 - cA / (gcr * cB);
  return Math.max(0, Math.min(1, f));
}

/** Average sky view factor over the collector for an infinite array.
    Exact two-dimensional isotropic result: at a point whose masking angle
    to the top of the row in front is psi, F = (1 + cos(beta + psi))/2. */
function skyVF(betaRad, W, P, steps = 16) {
  const b = Math.abs(betaRad);
  let s = 0;
  for (let i = 0; i < steps; i++) {
    const v = ((i + 0.5) / steps) * W;   // distance from the point to the top edge
    const dx = P - v * Math.cos(b);
    const psi = dx <= 1e-6 ? Math.PI / 2 - b : Math.atan2(v * Math.sin(b), dx);
    s += (1 + Math.cos(b + psi)) / 2;
  }
  return s / steps;
}

/** Build the annual environment once: sun vectors and irradiance.
    Sun position does not depend on pitch, so this is shared across runs. */
function buildEnv(lat, lon, tmy) {
  const rows = [];
  if (tmy && tmy.length) {
    for (const r of tmy) {
      // TMY timestamps are UTC; convert to local solar time
      const h = r.hour + lon / 15 + eqTime(r.doy) / 60;
      const sun = sunVector(lat, r.doy, h);
      if (sun.z <= 0.01) continue;
      rows.push({ sun, dni: r.dni, dhi: r.dhi, ghi: r.ghi, temp: r.temp });
    }
  } else {
    for (let d = 0; d < 365; d++) {
      for (let hh = 0; hh < 24; hh++) {
        const n = d + 1, h = hh + 0.5;
        const sun = sunVector(lat, n, h);
        if (sun.z <= 0.01) continue;
        const cs = clearSky(n, sun.z);
        rows.push({ sun, dni: cs.dni, dhi: cs.dhi, ghi: cs.ghi, temp: 25 });
      }
    }
  }
  return rows;
}

/** One year of hourly simulation for a single pitch. */
function simulatePitch(env, opt) {
  const {
    pitch, collectW, mounting = "tracker", tilt = 20, maxRot = 60,
    backtrack = true, albedo = 0.2, bifaciality = 0, kRear = 0.9,
    mismatch = 1, gammaP = -0.29, noct = 45, bosLoss = 12,
  } = opt;

  const gcr = collectW / pitch;
  const maxRotRad = maxRot * D2R;
  const tiltRad = tilt * D2R;

  let poaBeam = 0, poaDiff = 0, poaGnd = 0, poaRear = 0;
  let refBeam = 0, shadeLossE = 0, btLossE = 0, eSum = 0;

  for (const row of env) {
    const sun = row.sun;
    const { dni, dhi, ghi } = row;

    let R, thetaP, cosAoi, cosAoiFree, beta;
    if (mounting === "fixed") {
      const cross = -sun.y;                       // toward the equator
      thetaP = Math.atan2(cross, sun.z);
      R = tiltRad; beta = tiltRad;
      cosAoi = Math.max(0, cross * Math.sin(tiltRad) + sun.z * Math.cos(tiltRad));
      cosAoiFree = cosAoi;
    } else {
      thetaP = Math.atan2(sun.x, sun.z);
      R = trackerRotation(sun, gcr, maxRotRad, backtrack);
      const Rfree = Math.max(-maxRotRad, Math.min(maxRotRad, thetaP));
      beta = Math.abs(R);
      cosAoi = Math.max(0, Math.sin(R) * sun.x + Math.cos(R) * sun.z);
      cosAoiFree = Math.max(0, Math.sin(Rfree) * sun.x + Math.cos(Rfree) * sun.z);
    }

    const doShade = mounting === "fixed" || !backtrack;
    const f = doShade ? shadedFraction(R, thetaP, gcr) : 0;
    const fEff = Math.min(1, f * mismatch);
    const beam = dni * cosAoi * (1 - fEff);

    poaBeam += beam;
    refBeam += dni * cosAoiFree;
    shadeLossE += dni * cosAoi * fEff;
    btLossE += Math.max(0, dni * (cosAoiFree - cosAoi));

    const diff = dhi * skyVF(beta, collectW, pitch);
    poaDiff += diff;

    const gnd = ghi * albedo * ((1 - Math.cos(beta)) / 2) * Math.max(0, 1 - gcr);
    poaGnd += gnd;

    // rear faces downward: its view of the ground mirrors the front's view
    // of the sky. Ground brightness = sunlit fraction under GHI, plus the
    // shaded remainder still receiving diffuse.
    let rear = 0;
    if (bifaciality > 0) {
      const shadowW = collectW * Math.cos(R - thetaP) / Math.max(1e-6, Math.cos(thetaP));
      const lit = Math.max(0, 1 - Math.min(1, shadowW / pitch));
      const gGround = ghi * lit + dhi * (1 - lit) * 0.5;
      rear = albedo * gGround * ((1 + Math.cos(beta)) / 2) * kRear * bifaciality;
      poaRear += rear;
    }

    const poa = beam + diff + gnd + rear;
    const tCell = row.temp + ((noct - 20) / 800) * poa;
    eSum += poa * (1 + (gammaP / 100) * (tCell - 25));
  }

  const front = poaBeam + poaDiff + poaGnd;
  const k = 1 - bosLoss / 100;
  return {
    pitch, gcr,
    poaFront: front / 1000,
    poaRear: poaRear / 1000,
    poaTotal: (front + poaRear) / 1000,
    specYield: (eSum / 1000) * k,       // kWh/kWp/yr
    shadeLoss: refBeam > 0 ? shadeLossE / refBeam : 0,
    geomLoss: refBeam > 0 ? (btLossE + shadeLossE) / refBeam : 0,
  };
}

/** Sweep a set of pitches and express everything against a reference. */
function pitchSweep(env, opt, pitches, refPitch) {
  const runs = pitches.map((p) => simulatePitch(env, { ...opt, pitch: p }));
  const ref = runs.reduce((b, r) =>
    Math.abs(r.pitch - refPitch) < Math.abs(b.pitch - refPitch) ? r : b, runs[0]);
  return runs.map((r) => {
    // on a bounded site, modules that fit scale roughly as 1/pitch
    const capRel = ref.pitch / r.pitch;
    return {
      ...r,
      dYield: ref.specYield > 0 ? (r.specYield / ref.specYield - 1) * 100 : 0,
      dLand: (r.pitch / ref.pitch - 1) * 100,
      capRel,
      energyRel: capRel * (r.specYield / (ref.specYield || 1)),
      isRef: r === ref,
    };
  });
}

/** Parse a PVGIS TMY payload into the compact form buildEnv expects. */
function parseTmy(json) {
  const rows = json?.outputs?.tmy_hourly;
  if (!Array.isArray(rows) || !rows.length) throw new Error("no hourly data in response");
  const cum = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  const out = [];
  for (const r of rows) {
    const t = String(r.time || r["time(UTC)"] || "");
    const m = t.match(/^(\d{4})(\d{2})(\d{2}):(\d{2})/);
    if (!m) continue;
    const mon = Number(m[2]), day = Number(m[3]), hour = Number(m[4]);
    const doy = cum[mon - 1] + day;
    const ghi = r["G(h)"], dni = r["Gb(n)"], dhi = r["Gd(h)"], temp = r.T2m;
    if (!(ghi >= 0) || !(dni >= 0) || !(dhi >= 0)) continue;
    out.push({ doy, hour, ghi, dni, dhi, temp: temp ?? 25 });
  }
  if (out.length < 4000) throw new Error(`only ${out.length} usable hours`);
  return out;
}


/** Specific yield against pitch, with the reference pitch marked. */
function YieldCurve({ sweep, pitch }) {
  const W = 460, H = 210, L = 52, R = 12, T = 12, B = 34;
  if (!sweep || sweep.length < 2) return null;
  const xs = sweep.map((r) => r.pitch), ys = sweep.map((r) => r.specYield);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const y0 = Math.min(...ys) * 0.995, y1 = Math.max(...ys) * 1.005;
  const px = (v) => L + ((v - x0) / Math.max(1e-9, x1 - x0)) * (W - L - R);
  const py = (v) => H - B - ((v - y0) / Math.max(1e-9, y1 - y0)) * (H - T - B);
  const d = sweep.map((r, i) => `${i ? "L" : "M"} ${px(r.pitch).toFixed(1)} ${py(r.specYield).toFixed(1)}`).join(" ");
  const ref = sweep.find((r) => r.isRef);
  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ display: "block" }}>
      <line x1={L} y1={T} x2={L} y2={H - B} stroke={C.line} strokeWidth="1" />
      <line x1={L} y1={H - B} x2={W - R} y2={H - B} stroke={C.line} strokeWidth="1" />
      {[y0, (y0 + y1) / 2, y1].map((v, i) => (
        <g key={i}>
          <line x1={L - 4} y1={py(v)} x2={L} y2={py(v)} stroke={C.line} />
          <text x={L - 7} y={py(v) + 3} textAnchor="end"
            style={{ font: "9px var(--mono)", fill: C.muted }}>{fmt(v, 0)}</text>
        </g>
      ))}
      {sweep.map((r) => (
        <text key={r.pitch} x={px(r.pitch)} y={H - B + 13} textAnchor="middle"
          style={{ font: "9px var(--mono)", fill: C.muted }}>{fmt(r.pitch, 1)}</text>
      ))}
      <path d={d} fill="none" stroke={C.accent} strokeWidth="2" />
      {sweep.map((r) => (
        <circle key={r.pitch} cx={px(r.pitch)} cy={py(r.specYield)} r="2.6"
          fill={r.isRef ? "#fff" : C.accent} />
      ))}
      {ref && (
        <line x1={px(ref.pitch)} y1={T} x2={px(ref.pitch)} y2={H - B}
          stroke="#fff" strokeWidth="1" strokeDasharray="4 4" opacity="0.5" />
      )}
      <text x={L} y={H - 4} style={{ font: "9px system-ui", fill: C.muted }}>
        PITCH (m) — reference {fmt(pitch, 2)} m
      </text>
      <text x={10} y={T + 6} transform={`rotate(-90 10 ${T + 6})`}
        style={{ font: "9px system-ui", fill: C.muted }}>SPECIFIC YIELD (kWh/kWp)</text>
    </svg>
  );
}

function ShadeTab({ frame, mod, elec, reg, loc }) {
  const geo = computeFrameGeometry(mod, frame);
  const cw = geo.collectW;
  const [metric, setMetric] = useState("yield");
  const [runs, setRuns] = useState([
    { name: "Base 5.5 m", pitch: 5.5, yld: null, shade: null, note: "" },
    { name: "Wide 6.5 m", pitch: 6.5, yld: null, shade: null, note: "" },
  ]);
  const [lat, setLat] = useState(loc?.lat ?? 8.6);
  useEffect(() => { if (loc?.lat !== undefined) setLat(loc.lat); }, [loc?.lat]);
  const [pitch, setPitch] = useState(5.5);

  // ---- PVGIS-driven pitch model ----
  const [tmy, setTmy] = useState(null);
  const [wx, setWx] = useState({ state: "idle", msg: "", url: "" });
  const [mp, setMp] = useState({
    albedo: 0.2, bifaciality: 0.8, bos: 12, maxRot: 60, backtrack: true,
    mismatch: 2, kRear: 0.9, steps: 8,
  });
  const [range, setRange] = useState(null);
  const rng = range || { lo: +(cw * 1.15).toFixed(1), hi: +(cw * 2.6).toFixed(1) };

  const fetchTmy = async () => {
    setWx({ state: "busy", msg: "Requesting typical meteorological year…", url: "" });
    const qs = `?lat=${loc?.lat ?? lat}&lon=${loc?.lon ?? 0}&outputformat=json`;
    const hosts = [
      "https://re.jrc.ec.europa.eu/api/v5_3/tmy",
      "https://re.jrc.ec.europa.eu/api/tmy",
    ];
    let last = null;
    for (const h of hosts) {
      try {
        const res = await fetch(h + qs);
        if (!res.ok) { last = new Error(`HTTP ${res.status}`); continue; }
        const rows = parseTmy(await res.json());
        setTmy(rows);
        setWx({ state: "ok", msg: `${fmt(rows.length, 0)} hours of PVGIS TMY loaded.`, url: h + qs });
        return;
      } catch (e) { last = e; }
    }
    const offline = /failed to fetch|networkerror|load failed/i.test(last?.message || "");
    setWx({
      state: "err", url: hosts[0] + qs,
      msg: offline
        ? "The browser blocked the request before it reached PVGIS."
        : `PVGIS returned an error: ${last?.message || "unknown"}`,
    });
  };

  const [pvc, setPvc] = useState({ state: "idle", ey: null, msg: "", url: "" });
  const fetchPvcalc = async () => {
    setPvc({ state: "busy", ey: null, msg: "Asking PVGIS PVcalc…", url: "" });
    const tracking = frame.mounting === "fixed" ? 0 : 1;   // 1 = horizontal N-S axis
    const qs = `?lat=${loc?.lat ?? lat}&lon=${loc?.lon ?? 0}&peakpower=1&loss=${mp.bos}` +
      `&pvtechchoice=crystSi&mountingplace=free&trackingtype=${tracking}` +
      (tracking === 0 ? `&angle=${frame.tilt}` : "") + `&usehorizon=1&outputformat=json`;
    const hosts = ["https://re.jrc.ec.europa.eu/api/v5_3/PVcalc", "https://re.jrc.ec.europa.eu/api/PVcalc"];
    let last = null;
    for (const h of hosts) {
      try {
        const res = await fetch(h + qs);
        if (!res.ok) { last = new Error(`HTTP ${res.status}`); continue; }
        const d = await res.json();
        const ey = d?.outputs?.totals?.fixed?.E_y ?? d?.outputs?.totals?.tracking?.E_y
          ?? Object.values(d?.outputs?.totals || {})[0]?.E_y;
        if (!(ey > 0)) throw new Error("no E_y in response");
        setPvc({ state: "ok", ey, msg: `PVGIS unshaded baseline ${fmt(ey, 0)} kWh/kWp (their validated PV model, horizon included).`, url: h + qs });
        return;
      } catch (e) { last = e; }
    }
    setPvc({ state: "err", ey: null, url: hosts[0] + qs,
      msg: /failed to fetch|networkerror/i.test(last?.message || "")
        ? "The browser blocked the request (file:// page or network block)."
        : `PVcalc error: ${last?.message}` });
  };

  const env = useMemo(
    () => buildEnv(loc?.lat ?? lat, loc?.lon ?? 0, tmy),
    [loc?.lat, loc?.lon, lat, tmy]
  );
  const modelOpt = useMemo(() => ({
    collectW: cw, mounting: frame.mounting === "fixed" ? "fixed" : "tracker",
    tilt: frame.tilt, maxRot: mp.maxRot, backtrack: mp.backtrack,
    albedo: mp.albedo, bifaciality: mp.bifaciality, kRear: mp.kRear,
    mismatch: frame.mounting === "fixed" ? mp.mismatch : 1,
    gammaP: mod.gPmax ?? -0.29, bosLoss: mp.bos,
  }), [cw, frame.mounting, frame.tilt, mp, mod.gPmax]);

  const sweep = useMemo(() => {
    const n = Math.max(3, Math.min(14, Math.round(mp.steps)));
    const ps = [];
    for (let i = 0; i < n; i++) ps.push(+(rng.lo + ((rng.hi - rng.lo) * i) / (n - 1)).toFixed(2));
    if (!ps.some((p) => Math.abs(p - pitch) < 0.01)) ps.push(pitch);
    ps.sort((a, b) => a - b);
    let runs = pitchSweep(env, modelOpt, ps, pitch);
    if (pvc.ey > 0) {
      // our model supplies only the ratio to an unshaded single row;
      // PVGIS PVcalc supplies the absolute baseline that ratio scales
      const free = simulatePitch(env, { ...modelOpt, pitch: 1e4, bifaciality: 0 });
      if (free.specYield > 0) {
        runs = runs.map((r) => ({ ...r, specYield: pvc.ey * (r.specYield / free.specYield) }));
      }
    }
    return runs;
  }, [env, modelOpt, rng.lo, rng.hi, mp.steps, pitch, pvc.ey]);

  const upd = (i, k, v) => setRuns(runs.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  const withVals = runs.filter((r) => r[metric === "yield" ? "yld" : "shade"] !== null);
  let bestIdx = -1;
  if (withVals.length) {
    const key = metric === "yield" ? "yld" : "shade";
    const best = metric === "yield"
      ? Math.max(...withVals.map((r) => r[key]))
      : Math.min(...withVals.map((r) => r[key]));
    bestIdx = runs.findIndex((r) => r[key] === best);
  }
  const cellIn = (v, on, step = 0.1, ph = "—") => (
    <input type="number" value={v === null || v === undefined ? "" : v} step={step} placeholder={ph}
      onChange={(e) => on(e.target.value === "" ? null : Number(e.target.value))}
      style={{ width: 84, background: C.panel2, border: `1px solid ${C.line}`, borderRadius: 4,
        color: C.text, font: "12px var(--mono)", padding: "4px 7px", outline: "none" }} />
  );

  // quick geometric screen
  const beta = rad(frame.mounting === "tracker" ? 0 : frame.tilt);
  const h = cw * Math.sin(beta);
  const gap = pitch - cw * Math.cos(beta);
  const solstice = 90 - Math.abs(lat) - 23.45;
  const shadeAng = gap > 0 ? Math.atan(h / gap) * 180 / Math.PI : 90;

  if (reg) reg.current.shade = {
    get: () => ({ runs, metric, lat, pitch }),
    set: (s) => {
      if (!s) return;
      if (s.runs) setRuns(s.runs);
      if (s.metric) setMetric(s.metric);
      if (s.lat !== undefined) setLat(s.lat);
      if (s.pitch !== undefined) setPitch(s.pitch);
    },
  };
  return (
    <Page wide>
      <div className="tbl" style={{ marginBottom: 6 }}>STEP 6 — PITCH COMPARISON (YOUR PVSYST RESULTS)</div>
      <div className="readout" style={{ marginBottom: 12 }}>
        This page doesn't simulate — you run the pitch candidates in PVsyst, enter the outputs
        here, and compare them side by side. Steps are optional: every page has working
        defaults, so anyone can jump straight to <b>7 · Layout</b> to see whether the array
        fits the site, and come back to refine pitch later.
      </div>
      <div style={{ display: "flex", gap: 10, alignItems: "flex-end", marginBottom: 10, flexWrap: "wrap" }}>
        <Sel label="Optimising for" width="230px" value={metric}
          options={[
            { value: "yield", label: "Specific yield (kWh/kWp) — higher wins" },
            { value: "shade", label: "Shading loss % — lower wins" },
          ]}
          onChange={setMetric} />
        <button className="btn" onClick={() =>
          setRuns([...runs, { name: `Run ${runs.length + 1}`, pitch: 6, yld: null, shade: null, note: "" }])}>
          + Add run
        </button>
      </div>
      <div style={{ overflowX: "auto", width: "100%" }}><table style={{ borderCollapse: "collapse", width: "100%", minWidth: 560, font: "12px var(--mono)" }}>
        <thead><tr>
          {["Run", "Pitch m", "GCR", "kWh/kWp", "Shading %", "Note", ""].map((hd) => (
            <th key={hd} style={{ padding: "6px 8px", borderBottom: `1px solid ${C.line}`,
              font: "600 10px system-ui", color: C.muted, textAlign: "left",
              textTransform: "uppercase", letterSpacing: "0.07em" }}>{hd}</th>
          ))}
        </tr></thead>
        <tbody>
          {runs.map((r, i) => (
            <tr key={i} style={{ background: i === bestIdx ? "rgba(47,158,68,0.10)" : "transparent" }}>
              <td style={{ padding: "5px 8px" }}>
                <input value={r.name} onChange={(e) => upd(i, "name", e.target.value)}
                  style={{ width: 110, background: C.panel2, border: `1px solid ${C.line}`,
                    borderRadius: 4, color: C.text, font: "12px var(--mono)", padding: "4px 7px", outline: "none" }} />
                {i === bestIdx && <span style={{ color: "#59b56f", marginLeft: 6 }}>★ best</span>}
              </td>
              <td style={{ padding: "5px 8px" }}>{cellIn(r.pitch, (v) => upd(i, "pitch", v))}</td>
              <td style={{ padding: "5px 8px", color: C.muted }}>
                {r.pitch ? fmt(cw / r.pitch, 3) : "—"}
              </td>
              <td style={{ padding: "5px 8px" }}>{cellIn(r.yld, (v) => upd(i, "yld", v), 1)}</td>
              <td style={{ padding: "5px 8px" }}>{cellIn(r.shade, (v) => upd(i, "shade", v), 0.1)}</td>
              <td style={{ padding: "5px 8px" }}>
                <input value={r.note} placeholder="e.g. bifacial gain 8.2%"
                  onChange={(e) => upd(i, "note", e.target.value)}
                  style={{ width: 170, background: C.panel2, border: `1px solid ${C.line}`,
                    borderRadius: 4, color: C.muted, font: "11px system-ui", padding: "4px 7px", outline: "none" }} />
              </td>
              <td style={{ padding: "5px 8px" }}>
                {runs.length > 1 && (
                  <button className="btn" onClick={() => setRuns(runs.filter((_, j) => j !== i))}>×</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table></div>
      <div style={{ font: "10.5px system-ui", color: C.muted, margin: "8px 0 18px" }}>
        GCR computed from the shared frame ({fmt(cw, 2)} m collector). Trade-off to keep in
        view: tighter pitch adds MWp per hectare but costs shading and (for trackers)
        backtracking losses — the winner depends on whether land or yield binds.
      </div>

      <div className="tbl" style={{ margin: "6px 0" }}>QUICK GEOMETRIC SCREEN (NO SIMULATION)</div>
      <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 6 }}>
        <Section code="6C" title="Modelled pitch comparison (PVGIS irradiance + row geometry)">
        <div className="readout">
          PVGIS has no pitch, GCR or row-spacing parameter, so it supplies the irradiance only.
          Everything to do with rows is computed here: backtracking rotation and its cosine
          penalty, beam shading, the sky view factor cut by the row in front, ground reflection,
          and a simplified bifacial rear gain. <b>Absolute yield is indicative; the differences
          between pitches are the trustworthy output</b>, because they follow from geometry
          rather than from the irradiance dataset. PVsyst remains the number of record.
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", width: "100%" }}>
          <button className="btn primary" onClick={fetchTmy} disabled={wx.state === "busy"}>
            {wx.state === "busy" ? "Fetching…" : "Fetch PVGIS TMY"}
          </button>
          <span style={{ font: "11px system-ui", color: tmy ? "#7fd694" : C.warn }}>
            {tmy ? `✓ ${wx.msg}` : "Using a clear-sky model — geometry is right, absolute yield runs high"}
          </span>
          {tmy && <button className="btn" onClick={() => { setTmy(null); setWx({ state: "idle", msg: "", url: "" }); }}>
            Back to clear-sky</button>}
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", width: "100%" }}>
          <button className="btn primary" onClick={fetchPvcalc} disabled={pvc.state === "busy"}>
            {pvc.state === "busy" ? "Fetching…" : "Fetch PVGIS yield baseline (PVcalc)"}
          </button>
          <span style={{ font: "11px system-ui", color: pvc.ey ? "#7fd694" : C.muted }}>
            {pvc.ey ? `✓ ${pvc.msg}` : "Absolute yields below come from this tool's own model until fetched"}
          </span>
        </div>
        {pvc.state === "err" && (
          <div className="warn" style={{ width: "100%" }}>⚠ {pvc.msg}
            <br /><a href={pvc.url} target="_blank" rel="noreferrer"
              style={{ color: C.accent, wordBreak: "break-all" }}>{pvc.url}</a>
          </div>
        )}
        {pvc.ey > 0 && (
          <div className="readout">
            Absolute yields in the table are now <b>PVGIS's validated model × this tool's
            geometric ratio</b>: PVcalc supplies the unshaded single-row baseline (their
            temperature, reflection, spectral and horizon handling), and the row geometry here
            supplies only the pitch-to-pitch ratio — where its approximations largely cancel.
            Bifacial rear gain remains this tool's addition; PVGIS has no bifacial model.
          </div>
        )}
        {wx.state === "err" && (
          <div className="warn" style={{ width: "100%" }}>
            ⚠ {wx.msg}
            <br /><br />Usual causes: the page is open from a local <b>file://</b> path (browsers
            block cross-site requests from local files — host it and it works), or the network
            blocks the EU JRC domain. Open this in a new tab to tell them apart:
            <br /><a href={wx.url} target="_blank" rel="noreferrer"
              style={{ color: C.accent, wordBreak: "break-all" }}>{wx.url}</a>
            <br /><br />The clear-sky model below still works offline, and the pitch
            differences from it remain usable.
          </div>
        )}

        <Num label="Reference pitch" unit="m" value={pitch} step={0.1} min={0.5}
          onChange={setPitch} />
        <Num label="Sweep from" unit="m" value={rng.lo} step={0.5} min={0.5}
          onChange={(v) => setRange({ ...rng, lo: v })} />
        <Num label="Sweep to" unit="m" value={rng.hi} step={0.5} min={1}
          onChange={(v) => setRange({ ...rng, hi: v })} />
        <Num label="Steps" value={mp.steps} step={1} min={3} max={14}
          onChange={(v) => setMp({ ...mp, steps: v })} />
        <Num label="Ground albedo" value={mp.albedo} step={0.05} min={0} max={0.9}
          onChange={(v) => setMp({ ...mp, albedo: v })} />
        <Num label="Bifaciality" value={mp.bifaciality} step={0.05} min={0} max={1}
          onChange={(v) => setMp({ ...mp, bifaciality: v })} />
        <Num label="Balance-of-system losses" unit="%" value={mp.bos} step={1} min={0} max={40}
          onChange={(v) => setMp({ ...mp, bos: v })} />
        {frame.mounting !== "fixed" ? (
          <Num label="Max tracker rotation" unit="°" value={mp.maxRot} step={5} min={10} max={75}
            onChange={(v) => setMp({ ...mp, maxRot: v })} />
        ) : (
          <Num label="Shading mismatch factor" value={mp.mismatch} step={0.5} min={1} max={5}
            onChange={(v) => setMp({ ...mp, mismatch: v })} />
        )}
        {frame.mounting !== "fixed" && (
          <label className="chk" style={{ display: "flex", alignItems: "center", gap: 8,
            width: "100%", font: "12px system-ui", color: C.text, cursor: "pointer" }}>
            <input type="checkbox" checked={mp.backtrack} style={{ accentColor: C.accent }}
              onChange={(e) => setMp({ ...mp, backtrack: e.target.checked })} />
            Backtracking enabled
          </label>
        )}

        <div style={{ width: "100%", background: C.paper, borderRadius: 6, padding: "8px 8px 2px" }}>
          <YieldCurve sweep={sweep} pitch={pitch} />
        </div>

        <div style={{ width: "100%", overflowX: "auto" }}>
          <table className="grid" style={{ minWidth: 700 }}>
            <thead><tr>
              <th>Pitch</th><th>GCR</th><th>Specific yield</th><th>Δ yield</th>
              <th>Geometric loss</th><th>Rear gain</th><th>Δ land</th>
              <th title="Bounded site: modules that fit scale roughly as 1/pitch">Rel. capacity</th>
              <th title="Relative total annual energy from the same parcel">Rel. site energy</th>
            </tr></thead>
            <tbody>
              {sweep.map((r) => (
                <tr key={r.pitch} style={{
                  background: r.isRef ? "rgba(232,130,12,0.12)" : undefined,
                  color: r.isRef ? C.accent : undefined,
                }}>
                  <td><b>{fmt(r.pitch, 2)} m</b></td>
                  <td>{fmt(r.gcr, 2)}</td>
                  <td>{fmt(r.specYield, 0)} kWh/kWp</td>
                  <td style={{ color: r.dYield > 0 ? "#7fd694" : r.dYield < 0 ? "#e08b8b" : undefined }}>
                    {r.dYield > 0 ? "+" : ""}{fmt(r.dYield, 2)}%
                  </td>
                  <td>{fmt(r.geomLoss * 100, 1)}%</td>
                  <td>{r.poaFront > 0 ? `${fmt((r.poaRear / r.poaFront) * 100, 1)}%` : "—"}</td>
                  <td>{r.dLand > 0 ? "+" : ""}{fmt(r.dLand, 0)}%</td>
                  <td>{fmt(r.capRel * 100, 0)}%</td>
                  <td>{fmt(r.energyRel * 100, 1)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="readout">
          <b>Reading the two framings.</b> If you must hit a fixed capacity, compare
          <b> Δ yield</b> against <b>Δ land</b> and the extra cable it implies: widening only
          pays if the yield gain beats the land and cabling it costs. If instead the parcel is
          fixed, <b>Rel. site energy</b> is the one to read — capacity falls as roughly 1/pitch,
          so total energy from the site almost always favours the tighter pitch, while
          <b> £/MWh</b> favours the wider one because per-Wp capex buys more output. That
          tension is the actual pitch decision.
        </div>
        <div className="readout">
          <b>Known limits.</b> The bifacial rear model is a calibrated approximation, not a
          view-factor ray trace — tune <i>bifaciality</i> and albedo against a PVsyst run before
          trusting the rear column. For fixed tilt the mismatch factor is a blunt stand-in for
          bypass-diode behaviour, which PVsyst models properly at module level. Terrain and far
          horizon shading are not applied here. Soiling, availability and inverter losses sit
          inside the single balance-of-system figure.
        </div>
      </Section>

      <Section code="6B" title="Solstice clearance check">
          <Num label="Site latitude" unit="°" value={lat} step={0.1} onChange={setLat} />
          <Num label="Row pitch to test" unit="m" value={pitch} step={0.1} min={0.1} onChange={setPitch} />
          <div className="readout">
            GCR <b>{fmt(cw / pitch, 3)}</b> · clear gap <b>{fmt(gap, 2)} m</b> ·
            solstice noon sun <b>{fmt(solstice, 1)}°</b> · shading-limit angle <b>{fmt(shadeAng, 1)}°</b>
            {shadeAng < solstice ? <> — rows clear at solstice noon ✓</> : <> — ⚠ inter-row shading at solstice noon</>}
            <br />{frame.mounting === "tracker"
              ? "Trackers backtrack around geometric shading; treat this as a coarse screen only."
              : "Coarse screen only — diffuse and morning/evening shading need PVsyst."}
          </div>
        </Section>
      </div>
    </Page>
  );
}

const SS_COST = { 10: 95000, 14: 125000, 20: 165000 };

function SummaryTab({ s, rates, setRates, mod, inv, elec, frame }) {
  if (!s) {
    return <Page wide><div className="readout">
      Nothing to summarise yet — define a site boundary on the Layout tab.
    </div></Page>;
  }
  const lv = s.lv || 0, mv = s.mv || 0;
  const cLv = (lv * rates.lv) / 1000;
  const cMv = (mv * rates.mv) / 1000;
  const cSub = (s.combo || []).reduce((a, w) => a + (SS_COST[w] || 0), 0) / 1000;
  const cMod = (s.modules * mod.power * rates.modWp) / 1000;
  const cMount = (s.modules * mod.power * rates.mountWp) / 1000;
  const cInv = (s.inverters * (s.invAcKw || 0) * rates.invKw) / 1000;
  const total = cLv + cMv + cSub + cMod + cMount + cInv;
  const perW = s.dcMWp > 0 ? (total * 1000) / (s.dcMWp * 1e6) : 0;
  const Row = ({ k, v, sub }) => (
    <tr>
      <td style={{ padding: "6px 12px", color: C.muted, font: "11.5px system-ui" }}>{k}</td>
      <td style={{ padding: "6px 12px", font: "600 12.5px var(--mono)", color: C.text, textAlign: "right" }}>{v}</td>
      <td style={{ padding: "6px 12px", color: C.muted, font: "10.5px system-ui" }}>{sub}</td>
    </tr>
  );
  const money = (k) => `${rates.cur} ${fmt(k, 0)}k`;
  return (
    <Page wide>
      <div className="tbl" style={{ marginBottom: 10 }}>STEP 8 — SUMMARY</div>
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "flex-start" }}>
        <div style={{ flex: "1 1 420px", minWidth: 340, background: C.panel,
          border: `1px solid ${C.line}`, borderRadius: 6, overflow: "hidden" }}>
          <div className="tbl" style={{ padding: "9px 12px", borderBottom: `1px solid ${C.line}` }}>
            THE DESIGN — {s.name}
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse" }}><tbody>
            <Row k="DC capacity" v={`${fmt(s.dcMWp, 2)} MWp`} sub={`${fmt(s.modules, 0)} × ${mod.power} W`} />
            <Row k="AC capacity" v={`${fmt((s.inverters * (s.invAcKw || 0)) / 1000, 2)} MVA`}
              sub={`${s.inverters} × ${fmt(s.invAcKw || 0, 0)} kVA`} />
            <Row k="DC/AC ratio" v={s.invAcKw ? fmt((s.dcMWp * 1000) / (s.inverters * s.invAcKw), 2) : "—"} sub="" />
            <Row k="Strings" v={fmt(s.strings, 0)} sub={`${elec.modulesPerString} modules each`} />
            <Row k="Frames" v={fmt(s.frames, 0)} sub={`${frame.config}P mounting`} />
            <Row k="Substations" v={(s.combo || []).join(" + ") || "—"}
              sub={`${s.spare} spare way${s.spare === 1 ? "" : "s"}`} />
            <Row k="Site area" v={fmtArea(s.areaM2)} sub={`${fmt((s.dcMWp * 1e6) / Math.max(1, s.areaM2), 1)} MW/km²`} />
            <Row k="On flat ground" v={`${fmt((s.flatShare ?? 1) * 100, 0)}%`} sub="rest needs grading" />
            <Row k="LV cable (routed)" v={fmtKm(lv)} sub="inverter → substation" />
            <Row k="MV cable (routed)" v={fmtKm(mv)} sub="substation → grid point" />
          </tbody></table>
        </div>

        <div style={{ flex: "1 1 420px", minWidth: 340, background: C.panel,
          border: `1px solid ${C.line}`, borderRadius: 6, overflow: "hidden" }}>
          <div className="tbl" style={{ padding: "9px 12px", borderBottom: `1px solid ${C.line}` }}>
            INDICATIVE COST — PLACEHOLDER RATES, REPLACE WITH YOUR OWN
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse" }}><tbody>
            <Row k="Modules" v={money(cMod)} sub={`${rates.cur}${rates.modWp}/Wp`} />
            <Row k="Mounting & install" v={money(cMount)} sub={`${rates.cur}${rates.mountWp}/Wp`} />
            <Row k="Inverters" v={money(cInv)} sub={`${rates.cur}${rates.invKw}/kW`} />
            <Row k="LV cable" v={money(cLv)} sub={`${rates.cur}${rates.lv}/m × ${fmtKm(lv)}`} />
            <Row k="MV cable" v={money(cMv)} sub={`${rates.cur}${rates.mv}/m × ${fmtKm(mv)}`} />
            <Row k="Substations" v={money(cSub)} sub={((s.combo || []).join(" + ") || "—") + " way"} />
          </tbody></table>
          <div style={{ padding: "10px 12px", borderTop: `1px solid ${C.line}`,
            display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <span className="tbl">TOTAL</span>
            <span style={{ font: "700 17px var(--mono)", color: C.accent }}>
              {rates.cur} {fmt(total / 1000, 2)} m
            </span>
          </div>
          <div style={{ padding: "0 12px 10px", font: "11px system-ui", color: C.muted }}>
            ≈ {rates.cur} {fmt(perW, 2)} per Wp installed
          </div>
        </div>
      </div>

      <div className="tbl" style={{ margin: "16px 0 8px" }}>RATES</div>
      <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 6 }}>
        <Section code="8A" title="Unit rates">
          <Num label="LV cable" unit="/m" value={rates.lv} step={1} min={0}
            onChange={(v) => setRates({ ...rates, lv: v })} />
          <Num label="MV cable" unit="/m" value={rates.mv} step={1} min={0}
            onChange={(v) => setRates({ ...rates, mv: v })} />
          <Num label="Modules" unit="/Wp" value={rates.modWp} step={0.01} min={0}
            onChange={(v) => setRates({ ...rates, modWp: v })} />
          <Num label="Mounting & install" unit="/Wp" value={rates.mountWp} step={0.01} min={0}
            onChange={(v) => setRates({ ...rates, mountWp: v })} />
          <Num label="Inverters" unit="/kW" value={rates.invKw} step={1} min={0}
            onChange={(v) => setRates({ ...rates, invKw: v })} />
          <div className="readout">
            <b>These are placeholders, not quotations.</b> Substation units map to the
            Sungrow MVS range from the datasheets — MVS3200 (10-way), MVS4480 (14-way),
            MVS6400 (20-way), all 0.8 kV LV — costed at {rates.cur}95k / {rates.cur}125k /
            {" "}{rates.cur}165k until real prices replace them.
            Replace every rate with your own before any number leaves the office. Cable
            lengths are routed along corridors and block gaps so they include the detour
            around modules, but they remain centre-line lengths — no allowance for
            terminations, slack, trenching or verticals.
          </div>
        </Section>
      </div>
    </Page>
  );
}

export default function App() {
  const [tool, setTool] = useState("module");
  const [uiMode, setUiMode] = useState("engineer");
  const [entered, setEntered] = useState(false);
  const [pvMod, setPvMod] = useState({
    length: 2.278, width: 1.134, power: 650,
    voc: 49.97, vmp: 41.67, isc: 16.3, imp: 15.6,
    bVoc: -0.25, bVmp: null, gPmax: -0.29, aIsc: 0.045, vSysMax: 1500,
    vmpNoct: null, noct: null, cells: null, ideality: null, pmax: 650,
  });
  const setMod2 = (m) => setPvMod({ ...m, pmax: m.power });
  const [pvInv, setPvInv] = useState({
    vMax: 1500, fpHi: 1330, fpLo: 880, trackLo: null, vStart: null,
    iMppt: null, connMax: null, nMppt: 12, acKva: 350,
  });
  const [elec, setElec] = useState({ modulesPerString: 27, stringsPerInverter: 24, invertersPerTx: 4 });
  const [frame, setFrame] = useState({
    mounting: "tracker", config: 1, orientation: "portrait",
    sizeMode: "count", modulesPerFrame: 81, maxLength: 96, ridgeGap: 0.35,
    gapAlong: 0.025, crossGap: 0.02, endOverhang: 0.15, centreGap: 0.6,
    tilt: 25, clearance: 0.5, maxRot: 60,
  });
  const [ilrCap, setIlrCap] = useState(1.2);
  const [siteLoc, setSiteLoc] = useState({ lat: 8.687, lon: -8.653 });
  const [summary, setSummary] = useState(null);
  const [rates, setRates] = useState({
    cur: "£", lv: 38, mv: 62, modWp: 0.13, mountWp: 0.09, invKw: 32,
  });
  const reg = useRef({});
  const saveProject = () => {
    const data = {
      app: "PVhub", version: 1, saved: new Date().toISOString(),
      pvMod, pvInv, elec, frame, ilrCap, uiMode, rates, siteLoc,
      layout: reg.current.layout?.get(), shade: reg.current.shade?.get(),
    };
    const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "pvhub-project.json";
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const loadProject = (file) => {
    const rd = new FileReader();
    rd.onload = () => {
      try {
        const d = JSON.parse(String(rd.result));
        if (d.pvMod) setPvMod(d.pvMod);
        if (d.pvInv) setPvInv(d.pvInv);
        if (d.elec) setElec(d.elec);
        if (d.frame) setFrame(d.frame);
        if (d.ilrCap) setIlrCap(d.ilrCap);
        if (d.uiMode) setUiMode(d.uiMode);
        if (d.rates) setRates(d.rates);
        if (d.siteLoc) setSiteLoc(d.siteLoc);
        reg.current.layout?.set(d.layout);
        reg.current.shade?.set(d.shade);
      } catch (e) { /* invalid file — ignore */ }
    };
    rd.readAsText(file);
  };

  const TABS = [
    ["module", "Module"], ["inverter", "Inverter"], ["frame", "Frame"],
    ["string", "String Sizing"], ["clip", "Paralleling"],
    ["shade", "Pitch & Yield"], ["layout", "Layout"], ["summary", "Summary"],
  ];
  const GROUPS = [
    ["Technologies", ["module", "inverter", "frame"]],
    ["Calculations", ["string", "clip"]],
    ["Layout", ["layout"]],
    ["Yield & Summary", ["shade", "summary"]],
  ];
  const visGroups = uiMode === "stupid"
    ? GROUPS.filter(([g]) => g === "Layout" || g === "Yield & Summary")
        .map(([g, ids]) => [g, ids.filter((i) => i !== "shade")])
    : GROUPS;
  const activeGroup = visGroups.find(([, ids]) => ids.includes(tool)) || visGroups[0];
  const MODES = [
    ["stupid", "Stupid", "Draw a site, type an AC target, read the verdict and cost. Everything else is a sensible default. For anyone."],
    ["simple", "Simple", "The full workflow with only the essential inputs showing. For engineers working from datasheets."],
    ["engineer", "Engineer", "Every parameter, every derivation, every knob. For preliminary design proper."],
  ];
  const landing = !entered && (
    <div style={{ position: "fixed", inset: 0, zIndex: 999, background: "#14171c",
      display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 26, padding: 20 }}>
      <div style={{ display: "flex", alignItems: "baseline", userSelect: "none" }}>
        <span style={{ font: "800 34px system-ui", color: "#fff", letterSpacing: "-1px" }}>PV</span>
        <span style={{ font: "800 34px system-ui", color: "#000", background: "#f90",
          borderRadius: 8, padding: "0 10px", marginLeft: 3 }}>hub</span>
      </div>
      <div style={{ font: "13px system-ui", color: "#8b95a3" }}>How much detail do you want to work at?</div>
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", justifyContent: "center", maxWidth: 860 }}>
        {MODES.map(([id, name, blurb]) => (
          <button key={id} onClick={() => { setUiMode(id); setEntered(true); if (id === "stupid") setTool("layout"); }}
            style={{ width: 240, textAlign: "left", background: "#1c2128", color: "#e8eaed",
              border: `1px solid ${uiMode === id ? "#e8820c" : "#2c313b"}`, borderRadius: 8,
              padding: "16px 16px 14px", cursor: "pointer" }}>
            <div style={{ font: "700 15px system-ui", color: "#e8820c", marginBottom: 6 }}>{name}</div>
            <div style={{ font: "11.5px/1.55 system-ui", color: "#9aa3ae" }}>{blurb}</div>
          </button>
        ))}
      </div>
      <div style={{ font: "10.5px system-ui", color: "#5c6572" }}>You can switch modes any time from the header.</div>
    </div>
  );

  const shellCss = `
    .pvhub-tab { background: transparent; border: none; color: #9aa4af; padding: 0 16px;
      font: 600 14px system-ui, sans-serif; letter-spacing: 0.02em; cursor: pointer;
      border-bottom: 3px solid transparent; white-space: nowrap; height: 100%; }
    .pvhub-tab:hover { color: #dde3ea; }
    .pvhub-tab.on { color: #fff; border-bottom-color: #e8820c; }
    .pvhub-sub { display: flex; align-items: center; gap: 6px; height: 40px;
      padding: 0 14px; background: #14171c; border-bottom: 1px solid #22272f; flex-shrink: 0; }
    .pvhub-subtab { background: #1c2128; border: 1px solid #2c313b; color: #9aa4af;
      border-radius: 6px; padding: 6px 15px; font: 600 12.5px system-ui, sans-serif;
      cursor: pointer; white-space: nowrap; }
    .pvhub-subtab:hover { color: #dde3ea; border-color: #3a4150; }
    .pvhub-subtab.on { background: #e8820c; border-color: #e8820c; color: #181206; }
    .pvhub-tab.on { color: #fff; border-bottom-color: ${C.accent}; }
    .wk { background: ${C.panel}; border: 1px solid ${C.line}; border-radius: 6px;
      padding: 12px 14px; margin-bottom: 10px; }
    .wk-head { display: flex; align-items: center; gap: 10px; margin-bottom: 7px; }
    .wk-n { font: 700 11px var(--mono); color: ${C.accent}; background: rgba(232,130,12,0.12);
      border: 1px solid rgba(232,130,12,0.35); border-radius: 3px; padding: 1px 7px; }
    .wk-title { font: 600 12.5px system-ui, sans-serif; color: ${C.text}; flex: 1; }
    .wk-status { font: 700 10px system-ui, sans-serif; letter-spacing: 0.06em;
      border-radius: 3px; padding: 2px 8px; text-transform: uppercase; }
    .wk-status.ok { color: #59b56f; background: rgba(47,158,68,0.12); border: 1px solid rgba(47,158,68,0.4); }
    .wk-status.bad { color: #d67070; background: rgba(214,69,69,0.12); border: 1px solid rgba(214,69,69,0.4); }
    .wk-formula { font: 12px var(--mono); color: ${C.accent}; margin-bottom: 4px; }
    .wk-sub { font: 12px var(--mono); color: ${C.muted}; margin-bottom: 7px; }
    .wk-sub b { color: ${C.text}; }
    .wk-why { font: 11.5px/1.55 system-ui, sans-serif; color: ${C.muted}; }
    .pv-root { height: 100vh; height: 100dvh; }
    /* themed scrollbars everywhere, not just inside the tool panes */
    .pv-root, .pv-root * { scrollbar-width: thin; scrollbar-color: #333b46 transparent; }
    .pv-root ::-webkit-scrollbar { width: 9px; height: 9px; }
    .pv-root ::-webkit-scrollbar-thumb { background: #333b46; border-radius: 6px;
      border: 2px solid transparent; background-clip: content-box; }
    .pv-root ::-webkit-scrollbar-thumb:hover { background: #46505e; background-clip: content-box; }
    .pv-root ::-webkit-scrollbar-track { background: transparent; }
    .pv-root ::-webkit-scrollbar-corner { background: transparent; }
    /* the tab strip scrolls but never shows a bar */
    .pvhub-tabs { scrollbar-width: none; -ms-overflow-style: none; }
    .pvhub-tabs::-webkit-scrollbar { display: none; }
    .pv-head { flex: 0 0 auto; }
    @media (max-width: 900px) {
      .app { flex-direction: column !important; }
      .pv-side { width: 100% !important; min-width: 0 !important; max-height: 45vh;
        border-right: none !important; border-bottom: 1px solid ${C.line}; overflow-y: auto; }
      .fld { width: 100% !important; }
      .pv-page { padding: 14px 12px !important; }
      .pvhub-tab { padding: 0 11px; font-size: 12.5px; }
      .pvhub-sub { padding: 0 10px; height: 38px; }
      .btn { padding: 8px 12px; }
      .tbcell { min-width: 64px; padding: 6px 9px 7px; }
      .tbv { font-size: 13px; }
      .hide-narrow { display: none !important; }
      .pvhub-tabs { -webkit-mask-image: linear-gradient(90deg, #000 0, #000 calc(100% - 22px), transparent 100%);
        mask-image: linear-gradient(90deg, #000 0, #000 calc(100% - 22px), transparent 100%); }
      .pv-side { max-height: 52vh; }
      .pv-root .app > div:last-child { min-height: 48vh; }
    }
  `;
  return (
    <div className="pv-root" style={{
      display: "flex", flexDirection: "column", width: "100%",
      background: C.chrome, color: C.text, overflow: "hidden",
      fontFamily: "system-ui, sans-serif",
      "--mono": 'ui-monospace, "Cascadia Code", "SF Mono", Menlo, Consolas, monospace',
    }}>
      {landing}
      <style>{shellCss}</style>
      <div style={{
        display: "flex", alignItems: "center", gap: 14, padding: "0 14px",
        background: "#0d0f12", borderBottom: `1px solid ${C.line}`, height: 60, flexShrink: 0,
      }} className="pv-head">
        <div style={{ display: "flex", alignItems: "baseline", userSelect: "none", flexShrink: 0 }}>
          <span style={{ font: "800 23px system-ui", color: "#fff", letterSpacing: "-0.5px" }}>PV</span>
          <span style={{ font: "800 23px system-ui", color: "#000", background: "#f90",
            borderRadius: 6, padding: "0 7px", marginLeft: 2 }}>hub</span>
        </div>
        <div className="pvhub-tabs" style={{ display: "flex", height: "100%", alignItems: "stretch", overflowX: "auto", marginLeft: 6 }}>
          {visGroups.map(([g, ids]) => (
            <button key={g} className={`pvhub-tab ${activeGroup[0] === g ? "on" : ""}`}
              onClick={() => setTool(ids[0])}>{g}</button>
          ))}
        </div>
        <div style={{ flex: 1 }} />
        <div style={{ display: "flex", gap: 4, flexShrink: 0, marginRight: 8 }}>
          <button className="btn" onClick={saveProject}>Save project</button>
          <label className="btn" style={{ cursor: "pointer" }}>Open
            <input type="file" accept=".json" style={{ display: "none" }}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) loadProject(f); e.target.value = ""; }} />
          </label>
        </div>
        <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
          {["stupid", "simple", "engineer"].map((m) => (
            <button key={m} className="btn" style={uiMode === m
              ? { background: C.accent, borderColor: C.accent, color: "#181206", fontWeight: 600 } : {}}
              onClick={() => { setUiMode(m); if (m === "stupid") setTool("layout"); }}>{m === "stupid" ? "Stupid" : m === "simple" ? "Simple" : "Engineer"}</button>
          ))}
        </div>
      </div>
      {activeGroup[1].length > 1 && (
        <div className="pvhub-sub">
          <span style={{ font: "600 10px system-ui", letterSpacing: "0.09em", color: "#5c6572",
            textTransform: "uppercase", marginRight: 4 }}>{activeGroup[0]}</span>
          {activeGroup[1].map((id) => (
            <button key={id} className={`pvhub-subtab ${tool === id ? "on" : ""}`}
              onClick={() => setTool(id)}>{TABS.find(([t]) => t === id)?.[1]}</button>
          ))}
        </div>
      )}
      <div style={{ flex: 1, minHeight: 0, display: tool === "module" ? "flex" : "none" }}>
        <ModuleTab mod={pvMod} setMod={setMod2} uiMode={uiMode} />
      </div>
      <div style={{ flex: 1, minHeight: 0, display: tool === "inverter" ? "flex" : "none" }}>
        <InverterTab inv={pvInv} setInv={setPvInv} uiMode={uiMode} />
      </div>
      <div style={{ flex: 1, minHeight: 0, display: tool === "frame" ? "flex" : "none" }}>
        <FrameTab frame={frame} setFrame={setFrame} mod={pvMod} elec={elec} uiMode={uiMode} />
      </div>
      <div style={{ flex: 1, minHeight: 0, display: tool === "string" ? "flex" : "none" }}>
        <StringSizingTool mod={pvMod} setMod={setMod2} inv={pvInv} setInv={setPvInv}
          frameP={frame.config} uiMode={uiMode} loc={siteLoc} setLoc={setSiteLoc}
          onAdopt={(n) => { setElec({ ...elec, modulesPerString: n }); setTool("clip"); }} />
      </div>
      <div style={{ flex: 1, minHeight: 0, display: tool === "clip" ? "flex" : "none" }}>
        <ClippingTab mod={pvMod} inv={pvInv} elec={elec} setElec={setElec}
          ilrCap={ilrCap} setIlrCap={setIlrCap} />
      </div>
      <div style={{ flex: 1, minHeight: 0, display: tool === "shade" ? "flex" : "none" }}>
        <ShadeTab frame={frame} mod={pvMod} elec={elec} reg={reg} loc={siteLoc} />
      </div>
      <div style={{ flex: 1, minHeight: 0, display: tool === "layout" ? "flex" : "none" }}>
        <LayoutTool module={pvMod} setModule={setMod2} frame={frame} setFrame={setFrame}
          elec={elec} setElec={setElec} invAcKw={pvInv.acKva || 0} uiMode={uiMode} reg={reg}
          onSummary={setSummary} inv={pvInv} setInv={setPvInv} />
      </div>
      <div style={{ flex: 1, minHeight: 0, display: tool === "summary" ? "flex" : "none" }}>
        <SummaryTab s={summary} rates={rates} setRates={setRates}
          mod={pvMod} inv={pvInv} elec={elec} frame={frame} />
      </div>
    </div>
  );
}
