/* ---------------------------------------------------------------
   The one-page preliminary report.

   One A4 sheet a business developer can attach to an email: the plan,
   the plant in a dozen numbers, the yield with its standing, where
   every input came from, and — given as much room as the numbers —
   what was assumed or is missing. The last part is the point. A
   one-pager is where a preliminary figure turns into a quoted one, and
   a figure without its caveats travels further than it should.

   Everything here is built from what the layout, the yield report and
   the site panels already hold. Nothing is computed afresh and nothing
   is filled in: a missing input is listed, never defaulted.

   Pure: returns an HTML string with its own styles, light, print-ready.
   No React.
   --------------------------------------------------------------- */

const fin = (v) => Number.isFinite(v);
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const n = (v, d = 0) => (fin(v) ? v.toLocaleString("en-GB", { minimumFractionDigits: d, maximumFractionDigits: d }) : "—");
const km = (m) => (fin(m) ? (m >= 2000 ? `${n(m / 1000, 2)} km` : `${n(m, 0)} m`) : "—");
const area = (m2) => (fin(m2) ? (m2 >= 1e6 ? `${n(m2 / 1e6, 3)} km²` : `${n(m2, 0)} m²`) : "—");

const TERRAIN = {
  pulled: "Open Terrarium elevation tiles (SRTM, about 30 m): a screening surface",
  dxf: "Survey points from the imported DXF",
  points: "Imported XYZ or CSV points",
  demo: "SYNTHETIC demo surface, not the real ground",
};
const BOUNDARY = {
  kml: "KML or KMZ, placed exactly",
  dxf: "DXF in the drawing's own coordinates; not placed on the earth",
  drawn: "Drawn by hand; placed at the site's coordinates by assumption",
};

/**
 * What this report rests on that nobody has confirmed, or that is not
 * there at all. Each entry is { level: "gap" | "assumed" | "note", text }.
 */
export function prelimGaps(r) {
  const g = [];
  const s = r.summary || {};
  const add = (level, text) => g.push({ level, text });
  if (r.boundarySource !== "kml") {
    add("assumed", r.boundarySource === "dxf"
      ? "The boundary has no position on the earth; anything pulled for the site (terrain, OpenStreetMap, weather) used the site's coordinates as its centre."
      : "The boundary was drawn, so its position is the site's coordinates. Import it as KML or KMZ before anything is pulled for the site.");
  }
  if (!r.terrainSource) add("gap", "No terrain: the layout assumes the whole site is buildable flat ground.");
  else if (r.terrainSource === "demo") add("gap", "The terrain is the synthetic demo surface. Every slope figure is fictional.");
  else if (r.terrainSource === "pulled") add("note", "Terrain is a 30 m screening surface. It shows which ground to avoid, not whether a tracker row meets its slope limit.");
  const y = r.yield;
  if (!y || !fin(y.specYield)) add("gap", "No yield: no PVGIS baseline was loaded, and none is substituted.");
  else if (!y.keepIsEntered) add("assumed", "The row-shading factor is modelled from a calibration constant, not simulated. Replace it with a PVsyst run before the figure is quoted (GAPS G40).");
  if (!r.weatherSource) add("note", "No weather year was pulled. String sizing and the pitch model fall back to their own defaults.");
  if (!s.access) add("gap", "No site entrance placed, so there is no access road quantity.");
  if (s.lv !== null && !s.feeders && s.stations?.length > 1) add("note", "MV is routed radially, one cable per station. Chained feeders would be shorter; enter a feeder limit to see by how much.");
  if (s.unreachableInv > 0) add("gap", `${s.unreachableInv} inverter${s.unreachableInv === 1 ? " is" : "s are"} cut off by an exclusion and left out of the cable totals.`);
  const zones = r.plan?.zones || [];
  const bare = zones.filter((z) => !(z.buffer > 0)).length;
  if (bare) {
    add("assumed", `${bare} of ${zones.length} exclusion${zones.length === 1 ? "" : "s"} ${bare === 1 ? "has" : "have"} `
      + "no buffer: modules are kept out of the shape as drawn and no further.");
  }
  if (zones.length === 0) add("note", "No exclusions were drawn or imported. OpenStreetMap can offer the mapped ones in one click.");
  if (s.mounting === "ew") add("gap", "East-west frames: PVhub's footprint and module count disagree (GAPS G45). The capacity may be half what is drawn.");
  if (s.stations?.length && !s.stations.every((x) => x.kva > 0)) add("note", "Stations are sized in inverter ways, not from a supplier's transformer ratings.");
  add("note", "No prices. Costs belong in the Costing tab against quotes with dates.");
  return g;
}

/* A plan of the site, north up, scaled to fit. */
export function planSvg(plan, { size = 520 } = {}) {
  const b = plan?.boundary || [];
  if (b.length < 3) return "";
  const xs = b.map((p) => p.x), ys = b.map((p) => p.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const span = Math.max(x1 - x0, y1 - y0) || 1, pad = span * 0.06;
  const k = size / (span + 2 * pad);
  const X = (x) => ((x - x0 + pad) * k).toFixed(1), Y = (y) => ((y - y0 + pad) * k).toFixed(1);
  const poly = (pts) => pts.map((p) => `${X(p.x)},${Y(p.y)}`).join(" ");
  const out = [];
  for (const z of plan.zones || []) if (z.pts?.length >= 3) out.push(`<polygon points="${poly(z.pts)}" fill="#e05a5a33" stroke="#c0392b" stroke-width="0.8"/>`);
  for (const bl of plan.blocks || []) {
    const pts = bl.outline?.length >= 3 ? bl.outline
      : [{ x: bl.x, y: bl.y }, { x: bl.x + bl.w, y: bl.y }, { x: bl.x + bl.w, y: bl.y + bl.h }, { x: bl.x, y: bl.y + bl.h }];
    out.push(`<polygon points="${poly(pts)}" fill="#2f5d9e" fill-opacity="0.55" stroke="#1d3d6b" stroke-width="0.5"/>`);
  }
  for (const e of plan.road || []) out.push(`<line x1="${X(e.a.x)}" y1="${Y(e.a.y)}" x2="${X(e.b.x)}" y2="${Y(e.b.y)}" stroke="#8a7d6b" stroke-width="2.4" stroke-linecap="round"/>`);
  for (const p of plan.mv || []) if (p.length >= 2) out.push(`<polyline points="${poly(p)}" fill="none" stroke="#7b3fa0" stroke-width="1.2"/>`);
  out.push(`<polygon points="${poly(b)}" fill="none" stroke="#e8820c" stroke-width="1.8"/>`);
  for (const s of plan.stations || []) out.push(`<rect x="${(X(s.x) - 3.5).toFixed(1)}" y="${(Y(s.y) - 3.5).toFixed(1)}" width="7" height="7" fill="#2e8b57" stroke="#14532d"/>`);
  if (plan.poi) out.push(`<circle cx="${X(plan.poi.x)}" cy="${Y(plan.poi.y)}" r="5" fill="#fff" stroke="#7b3fa0" stroke-width="2"/>`);
  if (plan.entrance) out.push(`<path d="M ${X(plan.entrance.x)} ${(Y(plan.entrance.y) - 6).toFixed(1)} l 5 9 l -10 0 z" fill="#8a7d6b"/>`);
  /* A scale bar of a round length, about a fifth of the drawing. */
  const target = span / 5, mag = 10 ** Math.floor(Math.log10(target));
  const bar = [1, 2, 5, 10].map((m) => m * mag).filter((v) => v <= target).pop() || mag;
  const bx = 14, by = size - 14;
  out.push(`<line x1="${bx}" y1="${by}" x2="${(bx + bar * k).toFixed(1)}" y2="${by}" stroke="#222" stroke-width="2"/>`,
    `<text x="${bx}" y="${by - 5}" font-size="10" fill="#222">${bar >= 1000 ? `${bar / 1000} km` : `${bar} m`}</text>`,
    `<path d="M ${size - 18} 14 l 6 16 l -6 -4 l -6 4 z" fill="#222"/><text x="${size - 22}" y="44" font-size="10" fill="#222">N</text>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="100%" role="img" aria-label="Site plan">${out.join("")}</svg>`;
}

/** The whole page. */
export function prelimReportHtml(r) {
  const s = r.summary || {};
  const y = r.yield || null;
  const acMva = fin(s.invAcKw) && s.inverters ? (s.inverters * s.invAcKw) / 1000 : null;
  const dcac = acMva ? s.dcMWp / acMva : null;
  const gcr = s.pitch > 0 && s.collectW > 0 ? s.collectW / s.pitch : null;
  const kvas = (s.stations || []).map((x) => x.kva).filter((v) => v > 0);
  const stationsText = s.stations?.length
    ? `${s.stations.length} station${s.stations.length === 1 ? "" : "s"}`
      + (kvas.length === s.stations.length ? ` · ${n(kvas.reduce((a, v) => a + v, 0) / 1000, 2)} MVA` : "")
    : "—";
  const mvText = s.feeders
    ? `${km(s.mv)} on ${s.feeders.length} feeder${s.feeders.length === 1 ? "" : "s"} (radial would be ${km(s.radialMv)})`
    : km(s.mv);
  const rows = [
    ["DC capacity", `${n(s.dcMWp, 2)} MWp`, `${n(s.modules)} × ${n(s.modPower)} W${r.moduleName ? ` · ${esc(r.moduleName)}` : ""}`],
    ["AC capacity", acMva ? `${n(acMva, 2)} MVA` : "—", s.inverters ? `${s.inverters} × ${n(s.invAcKw)} kVA` : ""],
    ["DC/AC", dcac ? n(dcac, 2) : "—", ""],
    ["Mounting", s.mounting === "tracker" ? "Single-axis tracker" : s.mounting === "ew" ? "East-west" : `Fixed tilt ${n(s.tilt)}°`,
      `${n(s.frames)} frames${s.pitch ? ` · pitch ${n(s.pitch, 2)} m` : ""}${gcr ? ` · GCR ${n(gcr, 2)}` : ""}`],
    ["Strings", n(s.strings), s.modulesPerString ? `${s.modulesPerString} modules each` : ""],
    ["Transformer stations", stationsText, ""],
    ["Site area", area(s.areaM2), s.areaM2 ? `${n((s.dcMWp * 1e6) / s.areaM2, 1)} MW/km²` : ""],
    ["On flat ground", r.terrainSource ? `${n((s.flatShare ?? 1) * 100)}%` : "not assessed", r.terrainSource ? "rest needs grading" : "no terrain"],
    ["LV cable, routed", km(s.lv), "inverter to station"],
    ["MV cable, routed", mvText, "station to grid point"],
    ["Access road", s.access ? km(s.access.length) : "—", s.access ? `${n(s.access.length * s.access.width)} m² at ${n(s.access.width, 1)} m` : "no entrance placed"],
    ["Exclusions", n((r.plan?.zones || []).length), (r.plan?.zones || []).some((z) => z.osm) ? "some from OpenStreetMap" : ""],
  ];
  const yieldBlock = y && fin(y.specYield)
    ? `<table class="kv">
        <tr><td>Specific yield</td><td class="v">${n(y.netSpec, 0)} kWh/kWp</td><td>${n(y.specYield, 0)} from PVGIS × ${n(y.geomKeep, 3)} row geometry${y.keepIsEntered ? " (entered)" : " (modelled)"}</td></tr>
        <tr><td>Annual energy</td><td class="v">${n(y.annualGWh, 2)} GWh</td><td>first year, before degradation</td></tr>
        ${fin(y.cf) ? `<tr><td>Capacity factor</td><td class="v">${n(y.cf * 100, 1)}%</td><td>on AC</td></tr>` : ""}
      </table>
      <p class="small">The absolute figure is PVGIS's${y.dataset ? ` (${esc(y.dataset)})` : ""}; the effect of row spacing is PVhub's. They do not have the same standing, and a PVsyst run supersedes both.</p>`
    : `<p class="gap">No yield is given: no PVGIS baseline was loaded, and this report does not substitute one.</p>`;
  const gaps = prelimGaps(r);
  const label = { gap: "Missing", assumed: "Assumed", note: "Note" };
  const sources = [
    ["Boundary", BOUNDARY[r.boundarySource] || "—"],
    ["Terrain", TERRAIN[r.terrainSource] || "None"],
    ["Weather", r.weatherSource || "None pulled"],
    ["Yield baseline", y && fin(y.specYield) ? `PVGIS PVcalc${y.dataset ? `, ${y.dataset}` : ""}` : "None"],
    ["Exclusions", (r.plan?.zones || []).length
      ? `${(r.plan.zones.filter((z) => z.osm).length)} from OpenStreetMap (© OpenStreetMap contributors, ODbL), ${(r.plan.zones.filter((z) => !z.osm).length)} drawn or imported`
      : "None"],
  ];

  return `<!doctype html>
<html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Preliminary design — ${esc(r.title || s.name || "PVhub")}</title>
<style>
  @page { size: A4; margin: 12mm; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 10.5px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; color: #1c2128; background: #fff; }
  .sheet { max-width: 186mm; margin: 0 auto; padding: 10px 14px; }
  header { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 2px solid #e8820c; padding-bottom: 6px; }
  h1 { font-size: 17px; margin: 0; letter-spacing: 0.01em; }
  h2 { font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.08em; color: #6b7480; margin: 10px 0 4px; }
  .meta { text-align: right; color: #6b7480; }
  .badge { display: inline-block; font-weight: 700; font-size: 10.5px; letter-spacing: 0.06em; color: #8a4b00; background: #fdf0e0; border: 1px solid #f0c48a; border-radius: 3px; padding: 1px 6px; margin-top: 4px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 8px; }
  .plan { border: 1px solid #d8dde3; border-radius: 4px; padding: 4px; }
  table.kv { width: 100%; border-collapse: collapse; }
  table.kv td { padding: 2.5px 4px; border-bottom: 1px solid #edf0f3; vertical-align: top; }
  table.kv td:first-child { color: #6b7480; white-space: nowrap; }
  table.kv td.v { font: 600 11px ui-monospace, Menlo, Consolas, monospace; text-align: right; white-space: nowrap; }
  table.kv td:last-child { color: #6b7480; }
  .small { color: #6b7480; margin: 4px 0 0; }
  .gap { color: #8a1c1c; }
  ul.gaps { list-style: none; padding: 0; margin: 0; }
  ul.gaps li { padding: 2px 0 2px 64px; position: relative; }
  ul.gaps li b { position: absolute; left: 0; width: 58px; font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.04em; }
  ul.gaps li.gap b { color: #b42318; } ul.gaps li.assumed b { color: #b26b00; } ul.gaps li.note b { color: #6b7480; }
  .legend span { display: inline-block; margin-right: 10px; color: #6b7480; }
  .legend i { display: inline-block; width: 10px; height: 10px; vertical-align: -1px; margin-right: 3px; }
  footer { margin-top: 10px; border-top: 1px solid #d8dde3; padding-top: 5px; color: #6b7480; }
  .print { position: fixed; bottom: 12px; right: 12px; font: 600 12px system-ui; padding: 6px 12px; border: 1px solid #e8820c; background: #fff; color: #8a4b00; border-radius: 4px; cursor: pointer; }
  @media print { .print { display: none; } .sheet { padding: 0; } }
  @media (max-width: 640px) { .grid { grid-template-columns: 1fr; } }
</style></head>
<body><button class="print" onclick="window.print()">Print or save as PDF</button>
<div class="sheet">
<header>
  <div><h1>Preliminary design — ${esc(r.title || `${n(s.dcMWp, 2)} MWp`)}</h1>
    <div class="badge">PRELIMINARY · FOR SCREENING AND BID DECISIONS · NOT FOR CONSTRUCTION</div></div>
  <div class="meta">${fin(r.lat) && fin(r.lon) ? `${n(r.lat, 4)}, ${n(r.lon, 4)}<br>` : ""}${esc(r.date || "")}<br>PVhub · ${esc(s.name || "")}</div>
</header>
<div class="grid">
  <div><div class="plan">${planSvg(r.plan)}</div>
    <div class="legend small"><span><i style="background:#2f5d9e99"></i>blocks</span><span><i style="background:#e05a5a55;border:1px solid #c0392b"></i>exclusions</span><span><i style="background:#2e8b57"></i>stations</span><span><i style="background:#7b3fa0"></i>MV</span><span><i style="background:#8a7d6b"></i>road</span></div>
  </div>
  <div><h2 style="margin-top:0">The plant</h2><table class="kv">${rows.map(([k, v, sub]) => `<tr><td>${k}</td><td class="v">${v}</td><td>${sub || ""}</td></tr>`).join("")}</table>
    <h2>Yield</h2>${yieldBlock}</div>
</div>
<h2>What this rests on, and what it does not</h2>
<ul class="gaps">${gaps.map((x) => `<li class="${x.level}"><b>${label[x.level]}</b>${esc(x.text)}</li>`).join("")}</ul>
<h2>Sources</h2><table class="kv">${sources.map(([k, v]) => `<tr><td>${k}</td><td colspan="2">${esc(v)}</td></tr>`).join("")}</table>
<footer>A preliminary layout fitted to the boundary with stated rules: it answers whether the site fits a plant of about this size, and what it needs, not how it will be built. Cable lengths are routed along the layout's corridors; quantities are first-pass. Generated by PVhub.</footer>
</div></body></html>`;
}
