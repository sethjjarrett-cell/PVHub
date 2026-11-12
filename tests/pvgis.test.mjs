/* The data layer: the typical year assembled from Open-Meteo, and the
   PVGIS answers read back when they are handed over.

   The PVGIS fixtures are real answers for a generic point (52 N, 1 W),
   saved from the service. One of them is the answer to the query this
   application used to send for a tracker, kept because it is the best
   argument for reading back what PVGIS says it was asked. */

import { readFileSync } from "node:fs";
import {
  typicalYear, pvgisFaces, pvgisUrl, readPvgis, parseTmy, combineFaces, aspectName,
  WEATHER_SOURCES,
} from "../src/pvgis.js";

const fx = (n) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), "utf8");
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log("  FAIL:", m); } };
const eq = (a, b, m) => ok(a === b, `${m} (got ${a}, want ${b})`);
const near = (a, b, tol, m) => ok(Math.abs(a - b) <= tol, `${m} (got ${a}, want ${b} ±${tol})`);

/* ---------------------------------------------------------------
   A synthetic record with a known answer
   --------------------------------------------------------------- */
const DIM = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const leap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
/* Every daylight hour of a month carries the same irradiance, set per
   year, so each month's total is known exactly. */
function record(years, level) {
  const h = { time: [], shortwave_radiation: [], direct_normal_irradiance: [], diffuse_radiation: [], temperature_2m: [] };
  for (const y of years) {
    for (let mo = 1; mo <= 12; mo++) {
      const days = mo === 2 && leap(y) ? 29 : DIM[mo - 1];
      for (let d = 1; d <= days; d++) {
        for (let hr = 0; hr < 24; hr++) {
          const p2 = (n) => String(n).padStart(2, "0");
          h.time.push(`${y}-${p2(mo)}-${p2(d)}T${p2(hr)}:00`);
          const g = hr >= 8 && hr <= 16 ? level(y, mo) : 0;
          h.shortwave_radiation.push(g);
          h.direct_normal_irradiance.push(g * 0.7);
          h.diffuse_radiation.push(g * 0.3);
          h.temperature_2m.push(10 + mo);
        }
      }
    }
  }
  return h;
}

console.log("\n--- the typical year ---");
{
  /* Three years at 100, 200 and 400 W/m²: the mean is 233, and 200 is
     the nearest to it, so every month should come from the middle year. */
  const lv = { 2021: 100, 2022: 200, 2023: 400 };
  const t = typicalYear(record([2021, 2022, 2023], (y) => lv[y]));
  ok(t.ok, "three whole years assemble");
  eq(t.rows.length, 8760, "into exactly 8,760 hours");
  ok(t.picks.every((p) => p.year === 2022), "each month taken from the year nearest that month's mean");
  eq(t.picks.length, 12, "one pick per month");
  near(t.ghiYear, (365 * 9 * 200) / 1000, 1e-6, "and the year's total is that year's");
  eq(t.picks[0].of, 3, "the number of candidate years is reported");

  /* The choice is per month, not per year. */
  const t2 = typicalYear(record([2021, 2022, 2023], (y, mo) => (mo === 6 ? { 2021: 300, 2022: 900, 2023: 310 }[y] : lv[y])));
  eq(t2.picks[5].year, 2023, "June is chosen on June's own figures (300, 900, 310: mean 503, nearest 310)");
  eq(t2.picks[0].year, 2022, "while January still follows January's");

  /* A leap year must not push the year to 8,784 hours. */
  const t3 = typicalYear(record([2024], () => 250));
  eq(t3.rows.length, 8760, "a leap year still gives 8,760 hours, the 29th dropped");
  ok(!t3.rows.some((r) => r.doy > 365), "and no day past 365");

  /* Open-Meteo's radiation is the mean over the hour ENDING at the
     stamp, so the row sits half an hour before it. */
  const firstLit = t.rows.find((r) => r.ghi > 0);
  eq(firstLit.hour, 7.5, "the 08:00 value is placed at 07:30, the middle of the hour it covers");
  const midnight = t.rows[0];
  eq(midnight.hour, 23.5, "and the 00:00 value belongs to 23:30 the day before");
  eq(midnight.doy, 365, "which for 1 January wraps to day 365");
  eq(t.rows[24].doy, 1, "the next midnight belongs to day 1");

  near(firstLit.dni / firstLit.ghi, 0.7, 1e-9, "direct and diffuse travel with the hour they came from");
  eq(t.rows[100].temp, 11, "and so does temperature");
}

console.log("\n--- holes in the record ---");
{
  /* A month with gaps reads low for a reason that is not weather. */
  const h = record([2021, 2022], () => 200);
  for (let i = 0; i < 24 * 20; i++) h.shortwave_radiation[i] = null;     // most of January 2021
  const t = typicalYear(h);
  ok(t.ok, "a holed month does not sink the year");
  eq(t.picks[0].year, 2022, "it just cannot stand for its month");
  eq(t.picks[0].of, 1, "and is not counted among the candidates");

  const allNull = record([2021], () => 200);
  allNull.shortwave_radiation = allNull.shortwave_radiation.map(() => null);
  const t2 = typicalYear(allNull);
  ok(!t2.ok, "a record with no irradiance at all is refused");
  ok(/no complete January/.test(t2.msg), "naming the first month it could not fill");
  ok(!typicalYear({}).ok, "and an empty answer is refused rather than assembled into nothing");

  /* No temperature is a stated simplification, not a failure. */
  const noT = record([2022], () => 200); delete noT.temperature_2m;
  eq(typicalYear(noT).rows[0].temp, 25, "missing temperature falls to the stated 25 °C");
}

console.log("\n--- Open-Meteo's real answer ---");
{
  const j = JSON.parse(fx("openmeteo-sarah3-excerpt.json"));
  ok(Array.isArray(j.hourly.time) && /^\d{4}-\d{2}-\d{2}T\d{2}:00$/.test(j.hourly.time[0]), "timestamps are ISO, to the hour");
  for (const k of ["shortwave_radiation", "direct_normal_irradiance", "diffuse_radiation"]) {
    ok(Array.isArray(j.hourly[k]), `the answer carries ${k}`);
    eq(j.hourly_units[k], "W/m²", `${k} is in W/m²`);
  }
  ok(j.hourly.shortwave_radiation.some((v) => v > 100), "with real daylight in it");
  ok(WEATHER_SOURCES.sarah3 && WEATHER_SOURCES.era5 && WEATHER_SOURCES.pvgis, "each source has its standing written down");
  ok(/less reliable/.test(WEATHER_SOURCES.era5.standing), "and the weaker one says that it is weaker");
}

console.log("\n--- which planes PVGIS is asked about ---");
{
  const n = pvgisFaces({ lat: 52, mounting: "fixed", tilt: 20 });
  eq(n.length, 1, "a fixed array is one plane");
  eq(n[0].aspect, 0, "facing south in the northern hemisphere");
  eq(pvgisFaces({ lat: -15.4, mounting: "fixed", tilt: 15 })[0].aspect, 180,
     "and north in the southern, where the default would point it away from the sun");
  const ew = pvgisFaces({ lat: 52, mounting: "ew", tilt: 10 });
  eq(ew.length, 2, "an east-west pair is two planes");
  eq(ew.map((f) => f.aspect).join(","), "-90,90", "one east, one west");
  const tr = pvgisFaces({ lat: 52, mounting: "tracker", tilt: 0 });
  eq(tr[0].kind, "inclined_axis", "a tracker is asked for as an inclined axis at zero");
}

console.log("\n--- the query ---");
{
  const tr = pvgisUrl("pvcalc", { lat: 52, lon: -1, loss: 14, face: pvgisFaces({ lat: 52, mounting: "tracker" })[0] });
  ok(/fixed=0&inclined_axis=1&inclinedaxisangle=0/.test(tr), "the tracker query asks for a horizontal inclined axis");
  ok(!/trackingtype/.test(tr), "and never uses trackingtype, which PVcalc ignores");
  const fx20 = pvgisUrl("pvcalc", { lat: -15.4, lon: 28.3, loss: 12, face: pvgisFaces({ lat: -15.4, mounting: "fixed", tilt: 15 })[0] });
  ok(/angle=15&aspect=180/.test(fx20), "the fixed query carries the tilt and the way it faces");
  ok(/loss=12/.test(fx20) && /peakpower=1/.test(fx20), "the loss as entered, for one kilowatt-peak");
  ok(/usehorizon=1/.test(fx20), "with the terrain horizon on");
  ok(/\/tmy\?lat=52&lon=-1&outputformat=json$/.test(pvgisUrl("tmy", { lat: 52, lon: -1 })), "the typical-year query is the plain one");
}

console.log("\n--- reading a fixed-tilt answer ---");
{
  const face = pvgisFaces({ lat: 52, mounting: "fixed", tilt: 20 })[0];
  const r = readPvgis("pvcalc", fx("pvgis-pvcalc-fixed20.json"), { lat: 52, lon: -1, face });
  ok(r.ok, "the real answer reads");
  near(r.data.specYield, 977.51, 0.01, "977.5 kWh/kWp");
  near(r.data.irradiation, 1213.37, 0.01, "from 1,213 kWh/m² in plane");
  eq(r.data.monthly.length, 12, "with twelve months");
  near(r.data.monthly.reduce((a, m) => a + m.e, 0), 977.51, 1.0, "that add up to the year");
  eq(r.data.asked.slope, 20, "PVGIS says it modelled 20°");
  eq(r.data.asked.azimuth, 0, "facing south");
  eq(r.data.asked.loss, 14, "at 14% loss");
  eq(r.data.asked.radDb, "PVGIS-SARAH3", "from SARAH-3");
  eq(r.warnings.length, 0, "and nothing about it disagrees with the site");

  /* The same answer, offered for a different site and a different tilt. */
  const wrong = readPvgis("pvcalc", fx("pvgis-pvcalc-fixed20.json"),
    { lat: -15.4, lon: 28.3, face: pvgisFaces({ lat: -15.4, mounting: "fixed", tilt: 15 })[0] });
  ok(wrong.ok, "a figure for somewhere else still reads");
  ok(wrong.warnings.some((w) => /somewhere else/.test(w)), "but is flagged as being for somewhere else");
  ok(wrong.warnings.some((w) => /20° tilt; the layout is at 15°/.test(w)), "with the tilt it was really for");
  ok(wrong.warnings.some((w) => /faces south; this plane faces north/.test(w)), "and the way it really faces");
}

console.log("\n--- reading a tracker answer, and the one that only claims to be ---");
{
  const face = pvgisFaces({ lat: 52, mounting: "tracker" })[0];
  const good = readPvgis("pvcalc", fx("pvgis-pvcalc-tracker.json"), { lat: 52, lon: -1, face });
  ok(good.ok, "the corrected tracker query reads");
  near(good.data.specYield, 1171.76, 0.01, "1,172 kWh/kWp for a real tracker");
  eq(good.data.asked.mounting, "inclined_axis", "and PVGIS confirms it modelled an inclined axis");

  /* What the old query returned. PVGIS accepted `trackingtype=1`,
     ignored it, and answered for a plane lying flat. */
  const old = readPvgis("pvcalc", fx("pvgis-pvcalc-trackingtype1.json"), { lat: 52, lon: -1, face });
  ok(!old.ok, "the old query's answer is refused for a tracker layout");
  ok(/a fixed plane, not a tracker/.test(old.msg), "because PVGIS modelled a fixed plane");
  ok(/quarter low/.test(old.msg), "and the size of the error is stated");
  const asFixed = readPvgis("pvcalc", fx("pvgis-pvcalc-trackingtype1.json"), { lat: 52, lon: -1 });
  near(asFixed.data.specYield, 847.69, 0.01, "what it actually held: 848 kWh/kWp, flat");
  near(1 - asFixed.data.specYield / good.data.specYield, 0.277, 0.005, "28% below the tracker it was taken for");
}

console.log("\n--- an east-west pair ---");
{
  const faces = pvgisFaces({ lat: 52, mounting: "ew", tilt: 10 });
  const a = { specYield: 900, irradiation: 1100, sdYear: 30, monthly: [{ month: 1, e: 30 }, { month: 2, e: 50 }], asked: {} };
  const b = { specYield: 940, irradiation: 1140, sdYear: 34, monthly: [{ month: 1, e: 34 }, { month: 2, e: 54 }], asked: {} };
  eq(combineFaces(faces, { east: a }), null, "one face of two is not an answer");
  const c = combineFaces(faces, { east: a, west: b });
  eq(c.specYield, 920, "both faces give the mean of the two");
  eq(c.monthly[0].e, 32, "month by month");
  eq(c.faces.length, 2, "and the baseline records which faces it was built from");
  eq(combineFaces(pvgisFaces({ lat: 52, mounting: "tracker" }), { tracker: a }).specYield, 900, "a single plane passes straight through");
}

console.log("\n--- reading a typical year, and things that are not one ---");
{
  const real = JSON.parse(fx("pvgis-tmy-excerpt.json"));
  const row = real.outputs.tmy_hourly[0];
  for (const k of ["time(UTC)", "T2m", "G(h)", "Gb(n)", "Gd(h)"]) ok(k in row, `PVGIS's own rows carry ${k}`);
  ok(/^\d{8}:\d{4}$/.test(row["time(UTC)"]), "stamped yyyymmdd:hhmm");

  const short = readPvgis("tmy", fx("pvgis-tmy-excerpt.json"), { lat: 52, lon: -1 });
  ok(!short.ok && /usable hours/.test(short.msg), "two days of it are refused as too short to be a year");

  /* A whole year in PVGIS's shape. */
  const full = JSON.parse(fx("pvgis-tmy-excerpt.json"));
  full.outputs.tmy_hourly = [];
  for (let mo = 1; mo <= 12; mo++) for (let d = 1; d <= DIM[mo - 1]; d++) for (let h = 0; h < 24; h++) {
    const p2 = (n) => String(n).padStart(2, "0");
    full.outputs.tmy_hourly.push({ "time(UTC)": `2016${p2(mo)}${p2(d)}:${p2(h)}00`, T2m: 9, "G(h)": h >= 9 && h <= 15 ? 300 : 0, "Gb(n)": 200, "Gd(h)": 100 });
  }
  const t = readPvgis("tmy", JSON.stringify(full), { lat: 52, lon: -1 });
  ok(t.ok, "a whole year reads");
  eq(t.data.rows.length, 8760, "as 8,760 hours");
  near(t.data.ghiYear, (365 * 7 * 300) / 1000, 1e-6, "with its yearly irradiation totalled");
  ok(/SARAH3/.test(t.data.label), "and labelled with the dataset PVGIS named");
  eq(parseTmy(full).length, 8760, "the bare parser agrees");

  ok(/typical year rather than the yield/.test(readPvgis("pvcalc", JSON.stringify(full), {}).msg),
     "a typical year dropped where a yield is wanted says which it is");
  ok(/yield answer rather than the typical year/.test(readPvgis("tmy", fx("pvgis-pvcalc-fixed20.json"), {}).msg),
     "and the other way round");
  ok(/web page, not the answer/.test(readPvgis("pvcalc", "<!doctype html><html></html>", {}).msg),
     "a saved web page is recognised for what it is");
  ok(/does not read as PVGIS/.test(readPvgis("pvcalc", "hello", {}).msg), "and so is plain nonsense");
  ok(/PVGIS refused the query: Internal Server Error/.test(readPvgis("pvcalc", '{"message":"Internal Server Error","status":500}', {}).msg),
     "PVGIS's own error is passed on in its own words");
  ok(readPvgis("pvcalc", "﻿" + fx("pvgis-pvcalc-fixed20.json"), {}).ok, "a byte-order mark on the saved file is tolerated");
}

console.log("\n--- which way a plane faces, in words ---");
eq(aspectName(0), "south", "0 is south");
eq(aspectName(180), "north", "180 is north");
eq(aspectName(-90), "east", "-90 is east");
eq(aspectName(90), "west", "90 is west");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
