/* ---------------------------------------------------------------
   PVCollada 2.0: the layout as a file PVsyst, PVcase and the rest
   can open in three dimensions.

   PVCollada is a COLLADA 1.5 document with PV-specific elements in
   <extra> blocks (pvlib/pvcollada). This writer emits the physical
   plant: the module, one rack model per distinct rack, one table
   model per frame type, a table instance per frame, and the terrain
   when there is any. It does not write the electrical layout yet —
   PVhub assigns strings to inverters by block, not module by module,
   and inventing a module-level string map to fill the format would
   be a drawing of something nobody designed (GAPS G44).

   Conventions, from the schema and the coordinate guide:
     local East-North-Up metres, origin at the stated latitude,
     longitude and absolute altitude; azimuth clockwise from north;
     a rack's geometry is the rectangle of its module surface; a
     tracker's positive rotation for axis azimuth 180° is to the west.

   PVhub's local y runs south, so north is −y on the way out. A fixed
   frame faces the equator. A tracker is drawn flat, with its torque
   tube at the height PVhub's own drawing uses — low edge at the
   ground clearance when fully rotated — and the file says that height
   was derived.

   Output is checked against the official XSD and Schematron files;
   see tests/pvcollada.test.mjs for what is checked without them.

   No React.
   --------------------------------------------------------------- */

const fin = (v) => Number.isFinite(v);
const RAD = Math.PI / 180;
const f3 = (v) => (Math.round(v * 1000) / 1000).toFixed(3).replace(/\.?0+$/, "") || "0";
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** What the export still needs, in words. Nothing is filled in for it. */
export function pvcMissing({ frames, fg, module, geo }) {
  const m = [];
  if (!frames || !frames.length) m.push("a layout with frames placed");
  if (!geo || !fin(geo.lat) || !fin(geo.lon)) m.push("the site's position on the earth");
  if (!fg || !(fg.alongLen > 0) || !(fg.acrossW > 0)) m.push("the frame geometry");
  if (!module || !String(module.model || "").trim()) m.push("the module's model name");
  if (!module || !(module.power > 0)) m.push("the module's rated power");
  if (!module || !(module.length > 0) || !(module.width > 0)) m.push("the module's length and width");
  if (!module || !(module.depth > 0)) m.push("the module's depth (thickness)");
  /* PVhub's east-west frame is not yet one thing: its footprint and
     shading carry two faces of nP modules each, while its module count
     and section drawing carry nP in all. A file would have to pick one
     and then disagree with the layout's capacity (GAPS G45). */
  if (fg && fg.mounting === "ew") {
    m.push("an east-west frame PVhub agrees with itself on: its footprint has two faces of modules "
      + "but its module count has one, so the export is withheld until that is settled");
  }
  return m;
}

/* Terrain height at a local point, bilinear on PVhub's grid. */
function zOn(t, x, y) {
  const gx = Math.max(0, Math.min(t.nx - 1, (x - t.x0) / t.cell));
  const gy = Math.max(0, Math.min(t.ny - 1, (y - t.y0) / t.cell));
  const ix = Math.min(t.nx - 2, Math.floor(gx)), iy = Math.min(t.ny - 2, Math.floor(gy));
  const fx = gx - ix, fy = gy - iy, Z = (i, j) => t.z[j * t.nx + i];
  return Z(ix, iy) * (1 - fx) * (1 - fy) + Z(ix + 1, iy) * fx * (1 - fy)
    + Z(ix, iy + 1) * (1 - fx) * fy + Z(ix + 1, iy + 1) * fx * fy;
}

/* How many modules each rack of a frame carries along its length. A
   centre gap splits the frame into two racks, as it is built. */
function rackSplit(fg) {
  const n = fg.alongCount;
  if (fg.centreGap > 0 && n >= 2) return [Math.ceil(n / 2), Math.floor(n / 2)];
  return [n];
}

/**
 * The racks of one frame, in table coordinates: East-North-Up metres
 * about the centre of the frame's plan, at ground level. Each rack is
 * its surface rectangle plus what the <pv:rack> element says about it.
 */
export function frameRacks(fg, { south = false } = {}) {
  const { dAlong, gapAlong: g, endOverhang: e, centreGap: c, acrossW, tilt, clearance, maxRot, mounting, nP } = fg;
  const counts = rackSplit(fg);
  /* Along the axis: each rack's length, the outer ones carrying the
     end overhang as an inset, the centre gap plus one module gap between. */
  const lens = counts.map((k, i) => k * dAlong + (k - 1) * g + (counts.length === 1 ? 2 * e : e));
  const total = lens.reduce((a, b) => a + b, 0) + (counts.length - 1) * (c + g);
  const spans = []; let at = -total / 2;
  lens.forEach((L, i) => { spans.push([at, at + L]); at += L + c + g; });
  const insets = counts.map((_, i) => ({
    first: i === 0 ? e : 0, last: i === counts.length - 1 ? e : 0,
  }));
  const common = (k, i) => ({ rows: nP, cols: counts[i], inset: insets[i] });
  const racks = [];

  if (mounting === "tracker") {
    const H = clearance + (acrossW / 2) * Math.sin(maxRot * RAD);
    spans.forEach(([a, b], i) => racks.push({
      ...common(counts[i], i), type: "tracker", trackerHeight: H,
      /* Flat at zero rotation; the axis runs north-south. */
      pts: [[-acrossW / 2, a, H], [acrossW / 2, a, H], [acrossW / 2, b, H], [-acrossW / 2, b, H]],
    }));
    return { racks, kind: "tracker", trackerHeight: H };
  }

  const rise = acrossW * Math.sin(tilt * RAD), run = acrossW * Math.cos(tilt * RAD);
  if (mounting === "ew") {
    const r = (fg.ridgeGap || 0) / 2;
    for (const [face, az, sgn] of [["east", 90, 1], ["west", 270, -1]]) {
      spans.forEach(([a, b], i) => {
        /* High edge at the ridge, low edge outboard on its own side. */
        const xi = sgn * r, xo = sgn * (r + run);
        racks.push({ ...common(counts[i], i), type: "fixed_tilt", tilt, azimuth: az, face,
          pts: [[xo, a, clearance], [xo, b, clearance], [xi, b, clearance + rise], [xi, a, clearance + rise]] });
      });
    }
    return { racks, kind: "fixed" };
  }

  /* Fixed: the axis runs east-west and the face looks at the equator,
     so the low edge is on the equator side. */
  const az = south ? 0 : 180;
  const yLow = south ? run / 2 : -run / 2, yHigh = -yLow;
  spans.forEach(([a, b], i) => racks.push({
    ...common(counts[i], i), type: "fixed_tilt", tilt, azimuth: az,
    pts: [[a, yLow, clearance], [b, yLow, clearance], [b, yHigh, clearance + rise], [a, yHigh, clearance + rise]],
  }));
  return { racks, kind: "fixed" };
}

/* Two triangles for a quad, wound so the normal points up. */
function quadTris(pts) {
  const [a, b, c] = pts;
  const nz = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  return nz >= 0 ? "0 1 2 0 2 3" : "0 2 1 0 3 2";
}

const meshXml = (id, pts, tris, triCount, material) => [
  `<geometry id="${id}">`,
  "<mesh>",
  `<source id="${id}-src">`,
  `<float_array id="${id}-arr" count="${pts.length * 3}">${pts.map((p) => p.map(f3).join(" ")).join(" ")}</float_array>`,
  "<technique_common>",
  `<accessor count="${pts.length}" source="#${id}-arr" stride="3"><param name="X" type="float"/><param name="Y" type="float"/><param name="Z" type="float"/></accessor>`,
  "</technique_common>",
  "</source>",
  `<vertices id="${id}-vtx"><input semantic="POSITION" source="#${id}-src"/></vertices>`,
  `<triangles count="${triCount}" material="${material}"><input offset="0" semantic="VERTEX" source="#${id}-vtx"/><p>${tris}</p></triangles>`,
  "</mesh>",
];

const EFFECT = (id, rgb) => `<effect id="${id}-fx"><profile_COMMON><technique sid="standard"><lambert>`
  + `<diffuse><color sid="diffuse">${rgb} 1</color></diffuse></lambert></technique></profile_COMMON></effect>`;

/* The terrain as a mesh, thinned to at most `maxVerts` vertices. */
function terrainMesh(t, toEnu, alt0, maxVerts) {
  const s = Math.max(1, Math.ceil(Math.sqrt((t.nx * t.ny) / maxVerts)));
  const xs = [], ys = [];
  for (let i = 0; i < t.nx; i += s) xs.push(i);
  if (xs[xs.length - 1] !== t.nx - 1) xs.push(t.nx - 1);
  for (let j = 0; j < t.ny; j += s) ys.push(j);
  if (ys[ys.length - 1] !== t.ny - 1) ys.push(t.ny - 1);
  const pts = [];
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const j of ys) for (const i of xs) {
    const [E, N] = toEnu(t.x0 + i * t.cell, t.y0 + j * t.cell);
    const p = [E, N, t.z[j * t.nx + i] - alt0];
    pts.push(p);
    for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p[k]); hi[k] = Math.max(hi[k], p[k]); }
  }
  const W = xs.length, tris = [];
  for (let r = 0; r + 1 < ys.length; r++) for (let q = 0; q + 1 < W; q++) {
    const a = r * W + q, b = a + 1, c = a + W, d = c + 1;
    /* Local y runs south, so a row further down the grid is further
       south; these windings put the normal up in East-North-Up. */
    tris.push(a, c, b, b, c, d);
  }
  return { pts, tris: tris.join(" "), triCount: tris.length / 3, lo, hi, stride: s, W, H: ys.length };
}

/**
 * The document. Returns { ok, xml, counts, notes } or { ok: false, missing }.
 *
 * `frames` are the placed rectangles in layout metres; `fg` is the frame
 * geometry they were built from; `geo` is a georeference (sitePull);
 * `terrain` is PVhub's grid or null; `created` is an ISO time, passed
 * in so the output is reproducible.
 */
export function toPvCollada({
  frames, fg, module, geo, terrain = null, project = {}, created = new Date().toISOString(),
  acW = null, maxTerrainVerts = 40000,
}) {
  const missing = pvcMissing({ frames, fg, module, geo });
  if (missing.length) return { ok: false, missing };

  const south = geo.lat < 0;
  const vertical = fg.mounting !== "fixed";
  const planW = vertical ? fg.planAcross : fg.alongLen;
  const planH = vertical ? fg.alongLen : fg.planAcross;
  const use = frames.filter((f) => Math.abs(f.w - planW) < 0.01 && Math.abs(f.h - planH) < 0.01);
  const skipped = frames.length - use.length;
  if (!use.length) return { ok: false, missing: ["frames matching the current frame geometry (re-run the layout)"] };

  const toEnu = (x, y) => [x - (geo.x0 || 0), -(y - (geo.y0 || 0))];
  const alt0 = terrain ? zOn(terrain, geo.x0 || 0, geo.y0 || 0) : 0;
  const notes = [];

  const { racks, kind, trackerHeight } = frameRacks(fg, { south });
  const perTable = racks.reduce((a, r) => a + r.rows * r.cols, 0);
  const modules = perTable * use.length;
  const dcW = modules * module.power;

  /* ---- assets ---- */
  const comments = [
    `Exported by PVhub. ${use.length} tables, ${modules} modules, ${f3(dcW / 1e6)} MWp DC.`,
    geo.source === "kml" ? "Position from the KML or KMZ boundary."
      : "Position ASSUMED: the boundary had no position of its own and was placed with its centre at the site's coordinates.",
    terrain ? "Terrain from the project's terrain points; altitude is the terrain height at the origin."
      : "No terrain: the plant is flat and the altitude is written as 0 m because none is known.",
    kind === "tracker" ? `Tracker torque-tube height ${f3(trackerHeight)} m is derived: the low edge meets the ground clearance at full rotation.` : "",
    "No electrical layout is written: strings are not assigned module by module in PVhub.",
  ].filter(Boolean).join(" ");
  if (geo.source !== "kml") notes.push("The position is assumed, not read from the boundary.");
  if (!terrain) notes.push("No terrain is loaded, so the plant is flat and its altitude is written as 0 m.");
  if (skipped) notes.push(`${skipped} frame${skipped === 1 ? " does" : "s do"} not match the current frame geometry and ${skipped === 1 ? "was" : "were"} left out.`);

  const mod = [
    `<pv:module id="Module1">`,
    module.manufacturer ? `<pv:manufacturer>${esc(module.manufacturer)}</pv:manufacturer>` : "",
    `<pv:name>${esc(module.model)}</pv:name>`,
    module.bifaciality > 0 ? "<pv:module_type>bifacial</pv:module_type>" : "",
    `<pv:nom_power>${f3(module.power)}</pv:nom_power>`,
    `<pv:length>${f3(module.length * 1000)}</pv:length>`,
    `<pv:width>${f3(module.width * 1000)}</pv:width>`,
    `<pv:depth>${f3(module.depth * 1000)}</pv:depth>`,
    "</pv:module>",
  ].filter(Boolean).join("");

  const projectXml = [
    "<pv:project>",
    `<pv:name>${esc(project.name || "PVhub layout")}</pv:name>`,
    `<pv:module_count>${modules}</pv:module_count>`,
    `<pv:table_count>${use.length}</pv:table_count>`,
    `<pv:capacity_dc>${f3(dcW)}</pv:capacity_dc>`,
    acW > 0 ? `<pv:capacity_ac>${f3(acW)}</pv:capacity_ac>` : "",
    "</pv:project>",
  ].filter(Boolean).join("");

  /* ---- geometries ---- */
  const geoms = [];
  racks.forEach((r, i) => {
    const id = `Rack${i + 1}`;
    const rackTag = [
      "<pv:rack>",
      `<pv:rack_type>${r.type}</pv:rack_type>`,
      `<pv:row_spacing>${f3(fg.crossGap)}</pv:row_spacing>`,
      `<pv:column_spacing>${f3(fg.gapAlong)}</pv:column_spacing>`,
      r.inset.first ? `<pv:inset_first_column>${f3(r.inset.first)}</pv:inset_first_column>` : "",
      r.inset.last ? `<pv:inset_last_column>${f3(r.inset.last)}</pv:inset_last_column>` : "",
      `<pv:module_rows>${r.rows}</pv:module_rows>`,
      `<pv:module_columns>${r.cols}</pv:module_columns>`,
      `<pv:module_orientation>${fg.orientation === "landscape" ? "landscape" : "portrait"}</pv:module_orientation>`,
      r.type === "tracker"
        ? `<pv:tracker_azimuth>180</pv:tracker_azimuth><pv:tracker_slope>0</pv:tracker_slope><pv:tracker_height>${f3(r.trackerHeight)}</pv:tracker_height>`
        : `<pv:tilt>${f3(r.tilt)}</pv:tilt><pv:azimuth>${f3(r.azimuth)}</pv:azimuth><pv:height_above_ground>${f3(fg.clearance)}</pv:height_above_ground>`,
      "<pv:module_id>Module1</pv:module_id>",
      "</pv:rack>",
    ].filter(Boolean).join("");
    geoms.push(...meshXml(id, r.pts, quadTris(r.pts), 2, "PVmat"),
      `<extra><technique profile="PVCollada-2.0">${rackTag}</technique></extra>`, "</geometry>");
  });

  let tm = null;
  if (terrain) {
    tm = terrainMesh(terrain, toEnu, alt0, maxTerrainVerts);
    geoms.push(...meshXml("Terrain1", tm.pts, tm.tris, tm.triCount, "GroundMat"),
      `<extra><technique profile="PVCollada-2.0"><pv:terrain><pv:vertex_count>${tm.pts.length}</pv:vertex_count>`
      + `<pv:triangle_count>${tm.triCount}</pv:triangle_count>`
      + `<pv:bounding_box_min>${tm.lo.map(f3).join(" ")}</pv:bounding_box_min>`
      + `<pv:bounding_box_max>${tm.hi.map(f3).join(" ")}</pv:bounding_box_max></pv:terrain></technique></extra>`,
      "</geometry>");
    if (tm.stride > 1) notes.push(`The terrain grid was thinned to every ${tm.stride}th point (${tm.pts.length} vertices) to keep the file a sensible size.`);
  }

  /* ---- the table model ---- */
  const bind = (sym, mat) => `<bind_material><technique_common><instance_material symbol="${sym}" target="#${mat}"/></technique_common></bind_material>`;
  const tableTag = kind === "tracker"
    ? `<pv:table><pv:type>tracker</pv:type><pv:tracker_type>single_axis</pv:tracker_type>`
      + `<pv:tracker_max_rotation>${f3(-fg.maxRot)} ${f3(fg.maxRot)}</pv:tracker_max_rotation></pv:table>`
    : "<pv:table><pv:type>fixed</pv:type></pv:table>";
  const nodes = [
    '<node id="Table1">',
    ...racks.map((_, i) => `<instance_geometry url="#Rack${i + 1}">${bind("PVmat", "PVmaterial")}`
      + `<extra><technique profile="PVCollada-2.0"><pv:instance_rack id="Table1-Rack${i + 1}"/></technique></extra></instance_geometry>`),
    `<extra><technique profile="PVCollada-2.0">${tableTag}</technique></extra>`,
    "</node>",
  ];

  /* ---- the scene: a table per frame ---- */
  const scene = [];
  if (tm) {
    scene.push('<node id="TerrainNode1" name="Terrain"><instance_geometry url="#Terrain1">'
      + `${bind("GroundMat", "GroundMaterial")}<extra><technique profile="PVCollada-2.0"><pv:instance_terrain id="InstanceTerrain1"/></technique></extra>`
      + "</instance_geometry></node>");
  }
  use.forEach((f, k) => {
    const cx = f.x + f.w / 2, cy = f.y + f.h / 2;
    const [E, N] = toEnu(cx, cy);
    const Z = terrain ? zOn(terrain, cx, cy) - alt0 : 0;
    const n = k + 1, name = f.block !== undefined ? `INV${f.block}-T${n}` : `T${n}`;
    scene.push(`<node id="T${n}" name="${esc(name)}"><translate>${f3(E)} ${f3(N)} ${f3(Z)}</translate>`
      + `<instance_node url="#Table1"><extra><technique profile="PVCollada-2.0"><pv:instance_table id="IT${n}"><pv:instance_racks_array>`
      + racks.map((_, i) => `<pv:instance_rack_ref id="IT${n}-R${i + 1}" url="#Table1-Rack${i + 1}"/>`).join("")
      + "</pv:instance_racks_array></pv:instance_table></technique></extra></instance_node></node>");
  });

  const stamp = created.replace(/\.\d{3}Z$/, "Z");
  const xml = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<COLLADA xmlns="http://www.collada.org/2008/03/COLLADASchema" xmlns:pv="https://pvcollada.org/2026/XMLSchema" version="1.5.0">',
    "<asset>",
    `<contributor><author>PVhub</author><authoring_tool>PVhub</authoring_tool><comments>${esc(comments)}</comments></contributor>`,
    "<coverage><geographic_location>"
      + `<longitude>${geo.lon.toFixed(7)}</longitude><latitude>${geo.lat.toFixed(7)}</latitude>`
      + `<altitude mode="absolute">${f3(alt0)}</altitude></geographic_location></coverage>`,
    `<created>${stamp}</created><modified>${stamp}</modified>`,
    '<unit meter="1" name="meter"/>',
    "<up_axis>Z_UP</up_axis>",
    '<extra><technique profile="PVCollada-2.0">',
    "<pv:software><pv:source>PVhub</pv:source></pv:software>",
    projectXml,
    `<pv:components><pv:modules>${mod}</pv:modules></pv:components>`,
    "</technique></extra>",
    "</asset>",
    "<library_effects>", EFFECT("PV", "0.12 0.22 0.45"), EFFECT("Ground", "0.42 0.45 0.33"), "</library_effects>",
    "<library_materials>",
    '<material id="PVmaterial" name="Modules"><instance_effect url="#PV-fx"/></material>',
    '<material id="GroundMaterial" name="Ground"><instance_effect url="#Ground-fx"/></material>',
    "</library_materials>",
    "<library_geometries>", ...geoms, "</library_geometries>",
    "<library_nodes>", ...nodes, "</library_nodes>",
    '<library_visual_scenes><visual_scene id="Scene" name="PVhub layout">', ...scene, "</visual_scene></library_visual_scenes>",
    '<scene><instance_visual_scene url="#Scene"/></scene>',
    "</COLLADA>",
  ].join("\n");

  return { ok: true, xml, counts: { tables: use.length, modules, dcW, racksPerTable: racks.length, perTable }, notes };
}
