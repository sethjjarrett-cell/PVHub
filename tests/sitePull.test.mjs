/* The site's position on the earth, and the ground pulled for it. */

import {
  metresPerDegree, makeGeoRef, localToLonLat, lonLatToLocal, tileOf, decodeTerrarium,
  sampleGrid, tilesFor, elevationsAt, terrariumUrl, TERRAIN_ZOOM, TILE,
} from "../src/sitePull.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log("  FAIL:", m); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
const near = (a, b, tol, m) => ok(Math.abs(a - b) <= tol, `${m} (got ${a}, want ${b} ±${tol})`);

console.log("\n--- metres and degrees ---");
{
  const eqtr = metresPerDegree(0);
  near(eqtr.lat, 110574, 2, "a degree of latitude at the equator is 110.6 km");
  near(eqtr.lon, 111320, 2, "and of longitude 111.3 km");
  const uk = metresPerDegree(52);
  near(uk.lon, 68678, 5, "at 52° a degree of longitude has shrunk to 68.7 km");
  ok(uk.lat > eqtr.lat, "while a degree of latitude has grown slightly");
}

console.log("\n--- the georeference ---");
{
  eq(makeGeoRef({ lat: NaN, lon: 2 }), null, "no latitude, no georeference");
  const g = makeGeoRef({ lat: -15.36, lon: 28.28, source: "kml" });
  eq(g.source, "kml", "where it came from is kept");
  const ll = localToLonLat({ x: 0, y: 0 }, g);
  near(ll[0], 28.28, 1e-12, "the origin is the reference point, in longitude");
  near(ll[1], -15.36, 1e-12, "and in latitude");
  const north = localToLonLat({ x: 0, y: -1000 }, g);
  ok(north[1] > -15.36, "negative local y is north, as the KML import draws it");
  const back = lonLatToLocal(localToLonLat({ x: 312.5, y: -48.25 }, g), g);
  near(back.x, 312.5, 1e-6, "local to degrees and back is exact across");
  near(back.y, -48.25, 1e-6, "and down");
  /* A drawn boundary: its middle placed at the site's coordinates. */
  const drawn = makeGeoRef({ lat: 52, lon: -1, x0: 250, y0: 280 });
  eq(drawn.source, "assumed", "a georeference not taken from a file says it was assumed");
  const mid = localToLonLat({ x: 250, y: 280 }, drawn);
  near(mid[0], -1, 1e-12, "and puts that local point at the site's position");
  near(Math.abs(localToLonLat({ x: 250 + 686.78, y: 280 }, drawn)[0] - mid[0]), 0.01, 1e-4,
       "686.8 m east at 52° is a hundredth of a degree");
}

console.log("\n--- slippy-map tiles ---");
{
  const c = tileOf(0, 0, 1);
  near(c.x, 1, 1e-12, "the equator on the prime meridian is the middle of the zoom-1 world, across");
  near(c.y, 1, 1e-12, "and down");
  const london = tileOf(-0.1278, 51.5074, 14);
  eq([Math.floor(london.x), Math.floor(london.y)], [8186, 5448], "London is tile 8186/5448 at zoom 14");
  ok(tileOf(0, 89.9, 3).y >= -1e-9, "a point near the pole is clamped onto the map rather than off it");
  eq(terrariumUrl({ x: 8186, y: 5448, z: 14 }),
     "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/14/8186/5448.png", "the tile address");
  eq(TERRAIN_ZOOM, 14, "zoom 14, about 9.5 m a pixel at the equator");
}

console.log("\n--- Terrarium decoding ---");
eq(decodeTerrarium(128, 0, 0), 0, "128, 0, 0 is sea level");
eq(decodeTerrarium(128, 100, 128), 100.5, "128, 100, 128 is 100.5 m");
eq(decodeTerrarium(127, 255, 0), -1, "one step below sea level is −1 m");
near(decodeTerrarium(140, 32, 64), 3104.25, 1e-9, "3,104 m of mountain");

console.log("\n--- the sampling grid ---");
{
  const sq = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];
  eq(sampleGrid(sq, 20, 0).length, 36, "a 100 m square every 20 m is six by six");
  eq(sampleGrid(sq, 20, 40).length, 100, "and with a 40 m margin, ten by ten");
  ok(sampleGrid(sq, 20, 40).some((p) => p.x < 0 && p.y < 0), "the margin reaches past the boundary");
  eq(sampleGrid([], 20), [], "no boundary, no grid");
  eq(sampleGrid(sq, 0), [], "and no spacing, no grid");
}

console.log("\n--- which tiles ---");
{
  const g = makeGeoRef({ lat: 51.5074, lon: -0.1278 });
  const pts = sampleGrid([{ x: -50, y: -50 }, { x: 50, y: -50 }, { x: 50, y: 50 }, { x: -50, y: 50 }], 25, 0)
    .map((p) => localToLonLat(p, g));
  const t = tilesFor(pts);
  ok(t.length >= 1 && t.length <= 4, "a 100 m site needs one tile, or a few if it straddles an edge");
  ok(t.every((x) => x.z === 14), "all at zoom 14");
  /* A point a hair inside a tile's right edge also needs the tile to its
     right, because bilinear sampling reads one pixel further across. */
  const edge = tilesFor([[(8187 / 16384) * 360 - 180 - 1e-7, 51.5]]);
  ok(edge.some((x) => x.x === 8187), "a point at a tile's edge also asks for its neighbour");
}

console.log("\n--- elevations from tiles ---");
{
  /* A synthetic surface: height rises 0.25 m per global pixel eastward
     and 0.1 m per pixel southward, encoded as Terrarium would. */
  const enc = (v) => {
    const s = v + 32768;
    return [Math.floor(s / 256), Math.floor(s) % 256, Math.round((s - Math.floor(s)) * 256)];
  };
  /* Measured from a pixel near the test point, so the heights stay
     within the ±32 km Terrarium can encode. */
  const o = tileOf(-0.1278, 51.5074, 14);
  const GX = Math.floor(o.x * TILE), GY = Math.floor(o.y * TILE);
  const h = (gx, gy) => 0.25 * (gx - GX) + 0.1 * (gy - GY) + 100;
  const pixel = (tx, ty, px, py) => enc(h(tx * TILE + px, ty * TILE + py));
  const ll = [[-0.1278, 51.5074], [-0.1200, 51.5100]];
  const zs = elevationsAt(ll, pixel);
  const expect = ll.map(([lon, lat]) => {
    const t = tileOf(lon, lat, 14);
    return h(t.x * TILE - 0.5, t.y * TILE - 0.5);
  });
  near(zs[0], expect[0], 0.02, "on a plane, bilinear sampling recovers the height exactly");
  near(zs[1], expect[1], 0.02, "at a second point too");
  ok(zs[1] > zs[0], "and the point to the east is higher, as the surface rises that way");

  const holey = elevationsAt(ll, (tx, ty, px, py) => (px > 128 ? null : pixel(tx, ty, px, py)));
  ok(holey.some((v) => v === null), "a point whose pixels cannot all be read gets no height");
  ok(!holey.some((v) => v === 0), "and never a height of zero, which would be a real and wrong one");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
