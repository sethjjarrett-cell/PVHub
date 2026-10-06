/* =====================================================================
   ROOF DESIGNER

   A plan-view editor for one roof at a time. Draw the outline, drag the
   nodes, put the obstructions where they actually are, fill it with
   modules and take a DXF away.

   The one idea that makes it a roof rather than a shape: pitch and node
   heights are the same information, so either can be driven and the
   other follows. Type 35° and the nodes take the heights that make a
   35° plane. Drag a node's height and the pitch is refitted from the
   nodes. Neither is the master, and the tool says which way it last
   went so you are never guessing.

   What it draws is plan view, and what it exports is 3D. A module on a
   35° roof covers 82% of its own length in plan, so the drawing and the
   count both account for the foreshortening — getting that wrong is the
   difference between a roof that fits the array and one that does not.
   ===================================================================== */

import React, { useMemo, useRef, useState } from "react";
import { fmt, C, Num, Sel, Section, Page, Working } from "./ui.jsx";
import {
  area, centroid, bbox, normalise, fitPlane, heightsFromPitch, zAt,
  autoFill, bestFill, offsetPolygon, rect, surfaceArea, pointInPolygon,
} from "./roofGeom.js";
import { roofToDxf, countEntities } from "./dxf.js";

const PRESETS = {
  rectangle: (w, l) => [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: l }, { x: 0, y: l }],
  lshape: (w, l) => [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: l * 0.5 },
    { x: w * 0.45, y: l * 0.5 }, { x: w * 0.45, y: l }, { x: 0, y: l }],
  trapezium: (w, l) => [{ x: 0, y: 0 }, { x: w, y: 0 },
    { x: w * 0.78, y: l }, { x: w * 0.22, y: l }],
};

/* ---------------------------------------------------------------
   The canvas
   --------------------------------------------------------------- */

function Canvas({ plane, fill, selected, onSelect, onMove, onAddObstruction, tool, showModules }) {
  const ref = useRef(null);
  const [drag, setDrag] = useState(null);

  const all = [...plane.outline, ...plane.obstructions.flatMap((o) => o.poly)];
  const b = all.length ? bbox(all) : { minX: 0, maxX: 10, minY: 0, maxY: 10 };
  const pad = Math.max(1.2, Math.max(b.maxX - b.minX, b.maxY - b.minY) * 0.12);
  const vb = { x: b.minX - pad, y: b.minY - pad,
    w: (b.maxX - b.minX) + pad * 2, h: (b.maxY - b.minY) + pad * 2 };
  /* SVG y runs down, plan y runs north, so the whole scene is flipped
     once here rather than negating every coordinate everywhere. */
  const W = 860;

  const toWorld = (ev) => {
    const r = ref.current.getBoundingClientRect();
    const px = (ev.clientX - r.left) / r.width, py = (ev.clientY - r.top) / r.height;
    if (!Number.isFinite(px) || !Number.isFinite(py)) return null;
    return { x: vb.x + px * vb.w, y: vb.y + (1 - py) * vb.h };
  };
  const down = (i) => (ev) => { ev.stopPropagation(); onSelect(i); setDrag(i); };
  const move = (ev) => {
    if (drag === null) return;
    const p = toWorld(ev); if (!p) return;
    onMove(drag, { x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100 });
  };
  const up = () => setDrag(null);
  const click = (ev) => {
    if (tool !== "obstruction") return;
    const p = toWorld(ev); if (!p) return;
    onAddObstruction(p);
  };

  const Y = (y) => vb.y + vb.h - (y - vb.y);      // flip for SVG
  const path = (pts, close = true) =>
    pts.map((p, i) => `${i ? "L" : "M"}${p.x},${Y(p.y)}`).join("") + (close ? "Z" : "");

  const gridStep = vb.w > 40 ? 5 : vb.w > 16 ? 2 : 1;
  const gridLines = [];
  for (let x = Math.ceil(vb.x / gridStep) * gridStep; x < vb.x + vb.w; x += gridStep)
    gridLines.push(<line key={`gx${x}`} x1={x} x2={x} y1={vb.y} y2={vb.y + vb.h}
      stroke={C.line} strokeWidth={vb.w / W} opacity="0.5" />);
  for (let y = Math.ceil(vb.y / gridStep) * gridStep; y < vb.y + vb.h; y += gridStep)
    gridLines.push(<line key={`gy${y}`} x1={vb.x} x2={vb.x + vb.w} y1={Y(y)} y2={Y(y)}
      stroke={C.line} strokeWidth={vb.w / W} opacity="0.5" />);

  const sw = vb.w / W;
  return (
    <svg ref={ref} viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`} width="100%"
      preserveAspectRatio="xMidYMid meet"
      /* A deep roof at true aspect can run a thousand pixels tall, which
         puts the far end of it below the fold and makes the thing unusable.
         Capped against the viewport; the aspect ratio is preserved, so the
         geometry stays honest and only the scale changes. */
      style={{ display: "block", background: C.paper, borderRadius: 4, touchAction: "none",
        width: "100%", maxHeight: "62vh", cursor: tool === "obstruction" ? "crosshair" : "default" }}
      onPointerMove={move} onPointerUp={up} onPointerLeave={up} onClick={click}>
      {gridLines}
      {fill?.usable?.length >= 3 && (
        <path d={path(fill.usable)} fill="rgba(232,130,12,0.05)" stroke="#e8820c"
          strokeWidth={sw * 1.2} strokeDasharray={`${sw * 5} ${sw * 4}`} />
      )}
      <path d={path(plane.outline)} fill="rgba(255,255,255,0.03)" stroke={C.text} strokeWidth={sw * 2} />
      {showModules && fill?.modules?.map((m, i) => (
        <path key={i} d={path(m.quad)} fill="rgba(58,150,224,0.45)" stroke="#2b6fa8" strokeWidth={sw * 0.8} />
      ))}
      {fill?.keepOuts?.map((k, i) => (
        <path key={`k${i}`} d={path(k.poly)} fill="none" stroke="#d64545"
          strokeWidth={sw} strokeDasharray={`${sw * 3} ${sw * 3}`} opacity="0.8" />
      ))}
      {plane.obstructions.map((o, i) => (
        <path key={`o${i}`} d={path(o.poly)} fill="rgba(214,69,69,0.3)" stroke="#d64545" strokeWidth={sw * 1.5} />
      ))}
      {/* Downslope arrow, so which way the roof falls is never in doubt */}
      {(() => {
        const c = centroid(plane.outline);
        const L = Math.min(vb.w, vb.h) * 0.16;
        const a = (plane.azimuth * Math.PI) / 180;
        const dx = Math.sin(a), dy = Math.cos(a);
        const tip = { x: c.x + dx * L, y: c.y + dy * L };
        return (
          <g opacity="0.85">
            <line x1={c.x} y1={Y(c.y)} x2={tip.x} y2={Y(tip.y)} stroke="#8c6fd0" strokeWidth={sw * 2} />
            <circle cx={tip.x} cy={Y(tip.y)} r={sw * 4} fill="#8c6fd0" />
            <text x={c.x + dx * L * 0.55} y={Y(c.y + dy * L * 0.55) - sw * 6}
              textAnchor="middle" style={{ font: `${sw * 13}px var(--mono)`, fill: "#8c6fd0" }}>
              falls this way
            </text>
          </g>
        );
      })()}
      {plane.outline.map((p, i) => (
        <g key={`n${i}`} onPointerDown={down(i)} style={{ cursor: "grab" }}>
          <circle cx={p.x} cy={Y(p.y)} r={sw * 11} fill="transparent" />
          <circle cx={p.x} cy={Y(p.y)} r={sw * 5}
            fill={selected === i ? "#e8820c" : C.panel}
            stroke={selected === i ? "#fff" : C.text} strokeWidth={sw * 1.5} />
          <text x={p.x + sw * 9} y={Y(p.y) - sw * 7}
            style={{ font: `${sw * 12}px var(--mono)`, fill: selected === i ? "#e8820c" : C.muted }}>
            {i + 1} · {fmt(p.z ?? 0, 2)} m
          </text>
        </g>
      ))}
    </svg>
  );
}

/* ---------------------------------------------------------------
   The tab
   --------------------------------------------------------------- */

export function RoofDesignerTab({ mod, inv, elec, st, set }) {
  const plane = st.planes[st.active] || st.planes[0];
  const [selected, setSelected] = useState(0);
  const [tool, setTool] = useState("edit");
  const [lastDriver, setLastDriver] = useState("pitch");
  const [showModules, setShowModules] = useState(true);
  const [sweeping, setSweeping] = useState(null);

  const updPlane = (patch) => set({ ...st,
    planes: st.planes.map((p, i) => (i === st.active ? { ...p, ...patch } : p)) });

  const modW = mod.width || 1.134, modL = mod.length || 2.278;

  /* The fitted plane, which is what makes pitch and heights two views of
     one thing rather than two inputs that can disagree. */
  const fitted = useMemo(() => fitPlane(plane.outline), [plane.outline]);

  const fillParams = useMemo(() => ({
    outline: plane.outline, obstructions: plane.obstructions,
    pitch: plane.pitch, azimuth: plane.azimuth,
    moduleW: modW, moduleL: modL, orientation: plane.orientation,
    gapU: plane.gapU, gapV: plane.gapV,
    setback: plane.setback, ridgeSetback: plane.ridgeSetback, eaveSetback: plane.eaveSetback,
    obstructionBuffer: plane.obstructionBuffer,
    mounting: plane.mounting, moduleTilt: plane.moduleTilt, shadeLimit: plane.shadeLimit,
    offsetU: plane.offsetU, offsetV: plane.offsetV,
  }), [plane, modW, modL]);

  const fill = useMemo(() => autoFill(fillParams), [fillParams]);

  const kWp = (fill.modules.length * (mod.power || 0)) / 1000;
  const perString = elec.modulesPerString || 0;
  const strings = perString > 0 ? Math.floor(fill.modules.length / perString) : 0;
  const leftover = perString > 0 ? fill.modules.length - strings * perString : 0;

  /* ---- the two directions of the coupling ---- */
  const applyPitch = (pitch, azimuth) => {
    const anchorNode = plane.outline[plane.anchor] || plane.outline[0];
    const moved = heightsFromPitch(plane.outline, pitch, azimuth,
      { x: anchorNode.x, y: anchorNode.y, z: anchorNode.z ?? 0 });
    setLastDriver("pitch");
    updPlane({ pitch, azimuth, outline: moved });
  };
  const applyHeights = (outline) => {
    const f = fitPlane(outline);
    setLastDriver("nodes");
    updPlane({ outline, ...(f ? { pitch: f.pitch, azimuth: f.azimuth } : {}) });
  };

  const moveNode = (i, p) => {
    const outline = plane.outline.map((n, j) => (j === i ? { ...n, ...p } : n));
    /* Dragging in plan keeps the plane and re-reads the heights off it,
       so a node moved sideways stays on the roof rather than hanging in
       the air. */
    const f = fitted;
    const withZ = f ? outline.map((n) => ({ ...n, z: zAt(f, n.x, n.y) })) : outline;
    updPlane({ outline: withZ });
  };
  const setNodeZ = (i, z) => applyHeights(plane.outline.map((n, j) => (j === i ? { ...n, z } : n)));

  const addNode = () => {
    const o = plane.outline;
    const i = selected, j = (selected + 1) % o.length;
    const mid = { x: (o[i].x + o[j].x) / 2, y: (o[i].y + o[j].y) / 2 };
    const z = fitted ? zAt(fitted, mid.x, mid.y) : (((o[i].z ?? 0) + (o[j].z ?? 0)) / 2);
    updPlane({ outline: [...o.slice(0, j), { ...mid, z }, ...o.slice(j)] });
  };
  const delNode = () => {
    if (plane.outline.length <= 3) return;
    updPlane({ outline: plane.outline.filter((_, j) => j !== selected) });
    setSelected(0);
  };

  const addObstruction = (p) => {
    const s = plane.newObstructionSize || 0.8;
    updPlane({ obstructions: [...plane.obstructions, {
      label: `OBS ${plane.obstructions.length + 1}`,
      poly: rect(p.x - s / 2, p.y - s / 2, s, s),
      buffer: plane.obstructionBuffer }] });
    setTool("edit");
  };
  const delObstruction = (i) =>
    updPlane({ obstructions: plane.obstructions.filter((_, j) => j !== i) });

  const runSweep = () => {
    setSweeping("running");
    /* Let the button paint before a few hundred fills run. */
    setTimeout(() => {
      const b = bestFill(fillParams, 6);
      updPlane({ orientation: b.best.orientation,
        offsetU: Math.round(b.best.offsetU * 1000) / 1000,
        offsetV: Math.round(b.best.offsetV * 1000) / 1000 });
      setSweeping({ tried: b.tried, range: b.range });
    }, 30);
  };

  const exportDxf = () => {
    const dxf = roofToDxf({ planes: [{
      name: plane.name, outline: plane.outline, usable: fill.usable,
      modules: fill.modules, keepOuts: fill.keepOuts, obstructions: plane.obstructions,
      plane: fitted, pitch: plane.pitch, azimuth: plane.azimuth }] });
    const blob = new Blob([dxf], { type: "application/dxf" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${(plane.name || "roof").replace(/\s+/g, "-").toLowerCase()}.dxf`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const preset = (kind) => {
    const pts = PRESETS[kind](plane.presetW || 10, plane.presetL || 7);
    const withZ = heightsFromPitch(pts.map((p) => ({ ...p, z: 0 })),
      plane.pitch, plane.azimuth, { x: pts[0].x, y: pts[0].y, z: plane.baseHeight ?? 3 });
    updPlane({ outline: withZ });
    setSelected(0);
  };

  const node = plane.outline[selected];

  return (
    <Page wide>
      <div className="tbl" style={{ marginBottom: 10 }}>
        ROOF DESIGNER — DRAW IT, FILL IT, EXPORT DXF
      </div>

      <Section code="D1" title="The plane">
        <Sel label="Shape to start from" value="—"
          onChange={(v) => v !== "—" && preset(v)}
          options={[{ value: "—", label: "Pick a starting shape…" },
            { value: "rectangle", label: "Rectangle" },
            { value: "lshape", label: "L-shape" },
            { value: "trapezium", label: "Trapezium / hipped end" }]} />
        <Num label="Starting width" unit="m" value={plane.presetW} step={0.5}
          onChange={(v) => updPlane({ presetW: v })} />
        <Num label="Starting depth" unit="m" value={plane.presetL} step={0.5}
          onChange={(v) => updPlane({ presetL: v })} />
        <Num label="Eave height" unit="m" value={plane.baseHeight} step={0.1}
          onChange={(v) => updPlane({ baseHeight: v })} />

        <div className="readout" style={{ width: "100%", font: "10.5px/1.65 system-ui" }}>
          <b>Pitch and node heights are the same information.</b> Set the pitch and the nodes
          take the heights that make that plane; type a node height and the pitch is refitted
          from the nodes. Whichever you touched last is the one driving, and it says so below.
          Dragging a node sideways keeps it on the current plane rather than leaving it floating.
        </div>
      </Section>

      <Section code="D2" title="Pitch, or the heights — either drives the other">
        <Num label="Roof pitch" unit="°" value={plane.pitch} step={0.5} min={0} max={75}
          onChange={(v) => applyPitch(v, plane.azimuth)} />
        <Num label="Azimuth" unit="°" value={plane.azimuth} step={5}
          onChange={(v) => applyPitch(plane.pitch, ((v % 360) + 360) % 360)} />
        <Sel label="Anchor node — the one that keeps its height"
          value={String(plane.anchor)} onChange={(v) => updPlane({ anchor: Number(v) })}
          options={plane.outline.map((p, i) => ({ value: String(i), label: `Node ${i + 1}` }))} />
        {node && (
          <Num label={`Node ${selected + 1} height`} unit="m" value={node.z ?? 0} step={0.05}
            onChange={(v) => setNodeZ(selected, v)} />
        )}
        <div style={{ display: "flex", gap: 7, flexWrap: "wrap", alignItems: "center" }}>
          <button className="btn" onClick={addNode}>+ Node after {selected + 1}</button>
          <button className="btn" onClick={delNode} disabled={plane.outline.length <= 3}>
            Delete node {selected + 1}
          </button>
          <button className={`btn ${tool === "obstruction" ? "on" : ""}`}
            style={tool === "obstruction" ? { background: "#d64545", borderColor: "#d64545", color: "#fff" } : {}}
            onClick={() => setTool(tool === "obstruction" ? "edit" : "obstruction")}>
            {tool === "obstruction" ? "Click the roof to place…" : "+ Obstruction"}
          </button>
          <Num label="New obstruction size" unit="m" value={plane.newObstructionSize} step={0.1}
            onChange={(v) => updPlane({ newObstructionSize: v })} />
        </div>

        <div style={{ width: "100%", display: "flex", gap: 9, flexWrap: "wrap", marginTop: 2 }}>
          <div style={{ background: C.panel2, border: `1px solid ${lastDriver === "pitch" ? "#e8820c" : C.line}`,
            borderRadius: 6, padding: "7px 11px" }}>
            <div style={{ font: "10px system-ui", color: C.muted }}>Driving</div>
            <div style={{ font: "650 13px var(--mono)", color: lastDriver === "pitch" ? "#e8820c" : C.text }}>
              {lastDriver === "pitch" ? "pitch → nodes" : "nodes → pitch"}
            </div>
          </div>
          {fitted && (<>
            <div style={{ background: C.panel2, border: `1px solid ${C.line}`, borderRadius: 6, padding: "7px 11px" }}>
              <div style={{ font: "10px system-ui", color: C.muted }}>Fitted pitch</div>
              <div style={{ font: "650 13px var(--mono)", color: C.text }}>{fmt(fitted.pitch, 2)}°</div>
            </div>
            <div style={{ background: C.panel2, border: `1px solid ${C.line}`, borderRadius: 6, padding: "7px 11px" }}>
              <div style={{ font: "10px system-ui", color: C.muted }}>Fitted azimuth</div>
              <div style={{ font: "650 13px var(--mono)", color: C.text }}>{fmt(fitted.azimuth, 1)}°</div>
            </div>
            <div style={{ background: C.panel2,
              border: `1px solid ${fitted.planar ? "#4fb06a" : "#e0a63a"}`, borderRadius: 6, padding: "7px 11px" }}>
              <div style={{ font: "10px system-ui", color: C.muted }}>Flatness</div>
              <div style={{ font: "650 13px var(--mono)", color: fitted.planar ? "#8fd6a3" : "#e8c07a" }}>
                {fitted.planar ? "planar" : `${fmt(fitted.residual * 1000, 0)} mm out`}
              </div>
            </div>
          </>)}
        </div>
        {fitted && !fitted.planar && (
          <div className="warn" style={{ width: "100%" }}>
            &#9888; <b>These nodes do not lie on one plane</b> — the worst is
            {" "}{fmt(fitted.residual * 1000, 0)} mm off the best fit. A single roof face is
            planar by construction, so this usually means a hip or a valley has been caught in
            one outline, or a height has a typo in it. Everything below uses the best-fit plane,
            which is a fair answer for a survey with a few millimetres of noise in it and the
            wrong answer for two faces drawn as one. Split them into separate planes if that is
            what they are.
          </div>
        )}
      </Section>

      <Section code="D3" title="Drawing">
        <div style={{ width: "100%" }}>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center",
            marginBottom: 7, font: "10.5px system-ui", color: C.muted }}>
            <label style={{ display: "flex", alignItems: "center", gap: 5, cursor: "pointer" }}>
              <input type="checkbox" checked={showModules} onChange={(e) => setShowModules(e.target.checked)}
                style={{ accentColor: C.accent }} />
              Show modules
            </label>
            <span>Drag a numbered node to move it. Its height is beside it.</span>
            <span style={{ color: "#e8820c" }}>dashed orange = usable after setbacks</span>
            <span style={{ color: "#d64545" }}>red = obstruction and its keep-out</span>
          </div>
          <Canvas plane={plane} fill={fill} selected={selected} onSelect={setSelected}
            onMove={moveNode} onAddObstruction={addObstruction} tool={tool}
            showModules={showModules} />
          {plane.obstructions.length > 0 && (
            <div style={{ display: "flex", gap: 7, flexWrap: "wrap", marginTop: 8 }}>
              {plane.obstructions.map((o, i) => (
                <span key={i} style={{ display: "flex", alignItems: "center", gap: 6,
                  background: C.panel2, border: `1px solid ${C.line}`, borderRadius: 5,
                  padding: "4px 8px", font: "11px var(--mono)", color: C.text }}>
                  {o.label} · {fmt(area(o.poly), 2)} m²
                  <button className="btn" style={{ padding: "1px 7px" }}
                    onClick={() => delObstruction(i)}>✕</button>
                </span>
              ))}
            </div>
          )}
        </div>
      </Section>

      <Section code="D4" title="Fill">
        <Sel label="Mounting" value={plane.mounting} onChange={(v) => updPlane({ mounting: v })}
          options={[{ value: "flush", label: "Flush — on the roof plane" },
            { value: "tilted", label: "Tilted up — raised above it" }]} />
        {plane.mounting === "tilted" && (<>
          <Num label="Module tilt" unit="°" value={plane.moduleTilt} step={1}
            onChange={(v) => updPlane({ moduleTilt: v })} />
          <Num label="Shade limit elevation" unit="°" value={plane.shadeLimit} step={1}
            onChange={(v) => updPlane({ shadeLimit: v })} />
        </>)}
        <Sel label="Orientation" value={plane.orientation}
          onChange={(v) => updPlane({ orientation: v })}
          options={[{ value: "portrait", label: "Portrait" }, { value: "landscape", label: "Landscape" }]} />
        <Num label="Edge setback" unit="m" value={plane.setback} step={0.05} min={0}
          onChange={(v) => updPlane({ setback: v })} />
        <Num label="Ridge setback" unit="m" value={plane.ridgeSetback} step={0.05} min={0}
          onChange={(v) => updPlane({ ridgeSetback: v })} />
        <Num label="Eave setback" unit="m" value={plane.eaveSetback} step={0.05} min={0}
          onChange={(v) => updPlane({ eaveSetback: v })} />
        <Num label="Gap across" unit="m" value={plane.gapU} step={0.005} min={0}
          onChange={(v) => updPlane({ gapU: v })} />
        <Num label="Gap up the slope" unit="m" value={plane.gapV} step={0.005} min={0}
          onChange={(v) => updPlane({ gapV: v })} />
        <Num label="Obstruction keep-out" unit="m" value={plane.obstructionBuffer} step={0.05} min={0}
          onChange={(v) => updPlane({ obstructionBuffer: v })} />
        <Num label="Grid nudge across" unit="m" value={plane.offsetU} step={0.05}
          onChange={(v) => updPlane({ offsetU: v })} />
        <Num label="Grid nudge up" unit="m" value={plane.offsetV} step={0.05}
          onChange={(v) => updPlane({ offsetV: v })} />

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", width: "100%" }}>
          <button className="btn" onClick={runSweep}
            style={{ background: C.accent, borderColor: C.accent, color: "#181206", fontWeight: 600 }}>
            {sweeping === "running" ? "Searching…" : "Auto-generate — find the best fit"}
          </button>
          {sweeping && sweeping !== "running" && (
            <span style={{ font: "10.5px system-ui", color: C.muted }}>
              {sweeping.tried} combinations tried, giving between {sweeping.range.min} and
              {" "}<b style={{ color: "#8fd6a3" }}>{sweeping.range.max}</b> modules.
            </span>
          )}
        </div>
        <div className="readout" style={{ width: "100%" }}>
          <b>Auto-generate sweeps both orientations and the grid phase.</b> Where the grid starts
          is not a detail: a 50 mm shift can win or lose a whole column, so the first arrangement
          the arithmetic happens to produce is an arbitrary answer rather than a fair one. It
          tries both orientations at thirty-six starting offsets each and keeps the best. Nudge
          by hand afterwards if a particular row matters more than the count.
        </div>

        {fill.warnings.map((w, i) => (
          <div key={i} className="warn" style={{ width: "100%" }}>&#9888; {w}</div>
        ))}
      </Section>

      <Section code="D5" title="What it comes to">
        <div style={{ display: "flex", gap: 9, flexWrap: "wrap", width: "100%" }}>
          {[["Modules", fill.modules.length, ""],
            ["Capacity", fmt(kWp, 2), "kWp"],
            ["Rows × columns", `${fill.rows} × ${fill.cols}`, ""],
            ["Plan area", fmt(fill.planArea || 0, 1), "m²"],
            ["Roof surface", fmt(fill.surfaceArea || 0, 1), "m²"],
            ["Coverage", fmt((fill.coverage || 0) * 100, 0), "% of plan"]].map(([l, v, un]) => (
            <div key={l} style={{ background: C.panel2, border: `1px solid ${C.line}`,
              borderRadius: 6, padding: "8px 11px", minWidth: 104 }}>
              <div style={{ font: "10px system-ui", color: C.muted }}>{l}</div>
              <div style={{ font: "650 16px var(--mono)", color: C.text }}>
                {v}<span style={{ font: "10px system-ui", color: C.muted }}> {un}</span>
              </div>
            </div>
          ))}
        </div>

        <Working n="F1" title="Roof surface against its plan"
          formula="A_surface = A_plan / cos(pitch)"
          sub={`${fmt(fill.planArea || 0, 2)} / cos ${fmt(plane.pitch, 1)}°`}
          result={fmt(fill.surfaceArea || 0, 2)} unit="m²"
          why="A pitched roof has more surface than it has footprint, which is why a drawing measured off a site plan under-counts it. The fill works in surface coordinates for exactly this reason: a module keeps its own length up the slope and covers less plan than it is long." />
        {plane.mounting === "tilted" && fill.selfShade && (
          <Working n="F2" title="Row pitch for the tilted array"
            formula="p = l·cos β + l·sin β / tan α"
            sub={`${fmt(fill.moduleL, 3)}·cos ${fmt(plane.moduleTilt, 0)}° + ${fmt(fill.moduleL, 3)}·sin ${fmt(plane.moduleTilt, 0)}° / tan ${fmt(plane.shadeLimit, 0)}°`}
            result={fmt(fill.selfShade.rowPitch, 3)} unit="m"
            status={fill.selfShade.gcr > 0.7 ? "Tight" : "OK"}
            why={`The module's own footprint plus the clear run its shadow needs at the limit elevation. Ground cover ratio comes out at ${fmt(fill.selfShade.gcr, 2)}. Lowering the limit angle buys back spacing at the cost of the first and last hours of a winter day, which on a roof where area binds is usually the right trade.`} />
        )}
        <Working n={plane.mounting === "tilted" ? "F3" : "F2"} title="Installed capacity"
          formula="kWp = n × P_module / 1000"
          sub={`${fill.modules.length} × ${fmt(mod.power || 0, 0)} W`}
          result={fmt(kWp, 2)} unit="kWp"
          why="What the Yield report, the cable tools and the battery tab work from." />
        {perString > 0 && (
          <div className="readout" style={{ width: "100%" }}>
            At {perString} modules per string that is <b>{strings} whole string
            {strings === 1 ? "" : "s"}</b>
            {leftover > 0
              ? <> with <b style={{ color: "#e8c07a" }}>{leftover} left over</b>. Leftovers are
                  not free — they go unconnected, or they string across onto another plane, and a
                  string is limited by its worst-lit module. Adjust the string length on the
                  String Sizing tab, or take the count down to a round number.</>
              : <>, exactly.</>}
          </div>
        )}
      </Section>

      <Section code="D6" title="Export">
        <button className="btn" onClick={exportDxf} disabled={!fill.modules.length}
          style={fill.modules.length ? { background: "#3a96e0", borderColor: "#3a96e0",
            color: "#06121c", fontWeight: 600 } : {}}>
          Download DXF
        </button>
        <div className="readout" style={{ width: "100%" }}>
          <b>A DXF is a text file of geometry on named layers</b>, written here as R12, which is
          the flavour every reader made in the last forty years opens without comment. AutoCAD
          opens it directly and will save it as DWG in one step if you need the native format.
          The geometry goes out in <b>3D</b> — every module corner carries the height of the roof
          plane at that point, so a section through the drawing is true and PVsyst sees a tilted
          surface rather than a flat one.
          <br /><br />
          Layers: <code style={{ font: "11px var(--mono)", color: C.accent }}>PV-ROOF-OUTLINE</code>,
          {" "}<code style={{ font: "11px var(--mono)", color: C.accent }}>PV-ROOF-SETBACK</code>,
          {" "}<code style={{ font: "11px var(--mono)", color: C.accent }}>PV-OBSTRUCTION</code>,
          {" "}<code style={{ font: "11px var(--mono)", color: C.accent }}>PV-OBSTRUCTION-BUFFER</code>,
          {" "}<code style={{ font: "11px var(--mono)", color: C.accent }}>PV-MODULE</code> (one closed
          polyline each), <code style={{ font: "11px var(--mono)", color: C.accent }}>PV-NODE</code> and
          {" "}<code style={{ font: "11px var(--mono)", color: C.accent }}>PV-TEXT</code>. Separate
          layers so the receiving end can switch parts off — modules alone for an import, the lot
          for a drawing to issue.
          <br /><br />
          <b>What it does not carry:</b> module electrical data, string assignments, or any yield
          figure. A DXF is geometry. Those are set up in whatever receives it.
        </div>
      </Section>
    </Page>
  );
}

export const ROOF_PLANE_DEFAULT = {
  name: "Plane 1",
  outline: [{ x: 0, y: 0, z: 3 }, { x: 10, y: 0, z: 3 },
    { x: 10, y: 7, z: 3 + 7 * Math.tan((35 * Math.PI) / 180) },
    { x: 0, y: 7, z: 3 + 7 * Math.tan((35 * Math.PI) / 180) }],
  obstructions: [],
  pitch: 35, azimuth: 180, anchor: 0,
  presetW: 10, presetL: 7, baseHeight: 3,
  mounting: "flush", moduleTilt: 15, shadeLimit: 18,
  orientation: "portrait",
  gapU: 0.02, gapV: 0.02,
  setback: 0.3, ridgeSetback: 0.3, eaveSetback: 0.3,
  obstructionBuffer: 0.5, newObstructionSize: 0.8,
  offsetU: 0, offsetV: 0,
};
