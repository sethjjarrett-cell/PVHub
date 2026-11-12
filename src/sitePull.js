/* ---------------------------------------------------------------
   Pulling the site from public data: where the boundary is on the
   earth, and the ground under it.

   The layout works in local metres. To ask anything about the real
   site it needs to know which local point sits at which latitude and
   longitude — its georeference — and how far a metre is in degrees
   there. A boundary imported from KML or KMZ carries that exactly; one
   drawn by hand does not, and then the tool places it with its middle
   at the site's coordinates and says that it has, because ground
   pulled for a guessed position is ground somewhere else.

   Terrain comes from the open Terrarium elevation tiles on AWS: SRTM
   at about 30 m in most of the world, finer national surveys where
   they exist, encoded as PNG so a browser can read them. That is a
   screening surface. It is right for deciding which ground to avoid
   and wrong for checking a tracker's slope row by row, and the tool
   says so wherever it shows it.

   No React. The tile images are decoded in the browser; everything
   that decides what to ask for and what the answer means is plain
   arithmetic here, and tested.
   --------------------------------------------------------------- */

const fin = (v) => Number.isFinite(v);

/** Metres per degree of latitude and of longitude at a latitude. */
export function metresPerDegree(latDeg) {
  const f = (latDeg * Math.PI) / 180;
  return {
    lat: 111132.92 - 559.82 * Math.cos(2 * f) + 1.175 * Math.cos(4 * f),
    lon: 111412.84 * Math.cos(f) - 93.5 * Math.cos(3 * f),
  };
}

/**
 * A georeference: the local point (x0, y0) sits at (lat, lon). Local y
 * runs down the screen, so north is negative y — the convention the
 * KML import already uses.
 */
export function makeGeoRef({ lat, lon, x0 = 0, y0 = 0, source = "assumed" } = {}) {
  if (!fin(lat) || !fin(lon)) return null;
  return { lat, lon, x0, y0, source, m: metresPerDegree(lat) };
}

export function localToLonLat(p, g) {
  return [g.lon + (p.x - g.x0) / g.m.lon, g.lat - (p.y - g.y0) / g.m.lat];
}
export function lonLatToLocal([lon, lat], g) {
  return { x: g.x0 + (lon - g.lon) * g.m.lon, y: g.y0 - (lat - g.lat) * g.m.lat };
}

/* ---------------------------------------------------------------
   Terrain
   --------------------------------------------------------------- */

/** Fractional slippy-map tile coordinates of a point at a zoom. */
export function tileOf(lon, lat, z) {
  const n = 2 ** z;
  const r = (Math.max(-85.05112878, Math.min(85.05112878, lat)) * Math.PI) / 180;
  return {
    x: ((lon + 180) / 360) * n,
    y: ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n,
  };
}

/** Terrarium encoding: metres = R×256 + G + B/256 − 32768. */
export const decodeTerrarium = (r, g, b) => r * 256 + g + b / 256 - 32768;

/* Zoom 14 puts a pixel at about 9.5 m × cos(latitude). The source is
   coarser than that almost everywhere, so a finer zoom would only
   interpolate the same data more finely and fetch more tiles. */
export const TERRAIN_ZOOM = 14;
export const TILE = 256;

/**
 * The points to sample: a regular grid over the boundary's box, grown
 * by a margin so the surface reaches past the boundary and a slope at
 * the edge is not read off a single row of samples.
 */
export function sampleGrid(polygon, spacing = 20, margin = 40) {
  if (!polygon || polygon.length < 3 || !(spacing > 0)) return [];
  const xs = polygon.map((p) => p.x), ys = polygon.map((p) => p.y);
  const x0 = Math.min(...xs) - margin, x1 = Math.max(...xs) + margin;
  const y0 = Math.min(...ys) - margin, y1 = Math.max(...ys) + margin;
  const pts = [];
  for (let y = y0; y <= y1 + 1e-9; y += spacing) {
    for (let x = x0; x <= x1 + 1e-9; x += spacing) pts.push({ x, y });
  }
  return pts;
}

/** Which tiles a set of points needs, at a zoom. */
export function tilesFor(pointsLL, z = TERRAIN_ZOOM) {
  const keys = new Map();
  for (const [lon, lat] of pointsLL) {
    const t = tileOf(lon, lat, z);
    /* Bilinear sampling reads the pixel to the right and below as well,
       which can sit in the next tile along. */
    for (const [dx, dy] of [[0, 0], [1 / TILE, 0], [0, 1 / TILE], [1 / TILE, 1 / TILE]]) {
      const tx = Math.floor(t.x + dx), ty = Math.floor(t.y + dy);
      keys.set(`${tx}/${ty}`, { x: tx, y: ty, z });
    }
  }
  return [...keys.values()];
}

export const terrariumUrl = (t) =>
  `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${t.z}/${t.x}/${t.y}.png`;

/**
 * Elevations at a set of points, given a way to read one pixel.
 *
 * `pixel(tx, ty, px, py)` returns [r, g, b] or null. Each point is
 * read bilinearly from the four pixel centres around it, so a site
 * does not come back as terraces one pixel wide. A point whose pixels
 * cannot all be read gets null, never zero: zero metres is a height,
 * and the wrong one almost everywhere.
 */
export function elevationsAt(pointsLL, pixel, z = TERRAIN_ZOOM) {
  const read = (gx, gy) => {
    const tx = Math.floor(gx / TILE), ty = Math.floor(gy / TILE);
    const c = pixel(tx, ty, gx - tx * TILE, gy - ty * TILE);
    return c ? decodeTerrarium(c[0], c[1], c[2]) : null;
  };
  return pointsLL.map(([lon, lat]) => {
    const t = tileOf(lon, lat, z);
    /* Global pixel coordinates, shifted so that integers fall on pixel
       centres rather than corners. */
    const gx = t.x * TILE - 0.5, gy = t.y * TILE - 0.5;
    const ix = Math.floor(gx), iy = Math.floor(gy), fx = gx - ix, fy = gy - iy;
    const a = read(ix, iy), b = read(ix + 1, iy), c = read(ix, iy + 1), d = read(ix + 1, iy + 1);
    if ([a, b, c, d].some((v) => v === null)) return null;
    return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
  });
}

/**
 * Fetch and decode the tiles, then sample. Browser only: it needs
 * Image and a canvas to turn a PNG into numbers.
 */
export async function pullTerrain({ polygon, geo, spacing = 20, margin = 40, z = TERRAIN_ZOOM, timeoutMs = 20000 }) {
  if (!geo) return { ok: false, msg: "The boundary has no position on the earth to pull ground for." };
  const grid = sampleGrid(polygon, spacing, margin);
  if (!grid.length) return { ok: false, msg: "There is no boundary to pull ground for." };
  const ll = grid.map((p) => localToLonLat(p, geo));
  const tiles = tilesFor(ll, z);
  if (tiles.length > 64) {
    return { ok: false, msg: `That would take ${tiles.length} tiles. The site is too large to pull at this `
      + "resolution in one go; import its terrain from a survey instead." };
  }
  const load = (t) => new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    const timer = setTimeout(() => resolve(null), timeoutMs);
    img.onload = () => {
      clearTimeout(timer);
      try {
        const cv = document.createElement("canvas");
        cv.width = TILE; cv.height = TILE;
        const cx = cv.getContext("2d", { willReadFrequently: true });
        cx.drawImage(img, 0, 0);
        resolve(cx.getImageData(0, 0, TILE, TILE).data);
      } catch (e) { resolve(null); }
    };
    img.onerror = () => { clearTimeout(timer); resolve(null); };
    img.src = terrariumUrl(t);
  });
  const data = new Map();
  const got = await Promise.all(tiles.map(load));
  tiles.forEach((t, i) => { if (got[i]) data.set(`${t.x}/${t.y}`, got[i]); });
  if (!data.size) {
    return { ok: false, msg: "None of the elevation tiles came back. The service may be unreachable "
      + "from this network, or the page opened from file:// rather than http://." };
  }
  const zs = elevationsAt(ll, (tx, ty, px, py) => {
    const d = data.get(`${tx}/${ty}`);
    if (!d) return null;
    const i = (Math.floor(py) * TILE + Math.floor(px)) * 4;
    return [d[i], d[i + 1], d[i + 2]];
  }, z);
  const pts = grid.map((p, i) => ({ x: p.x, y: p.y, z: zs[i] })).filter((p) => fin(p.z));
  const missing = grid.length - pts.length;
  return {
    ok: pts.length >= 4, pts, missing, tiles: tiles.length, tilesMissing: tiles.length - data.size,
    msg: pts.length >= 4 ? "" : "Too few heights came back to build a surface.",
  };
}
