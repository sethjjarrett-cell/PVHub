/* =====================================================================
   OUTBOUND DATA SOURCES

   Every call here is optional. The app works offline without them and
   each one degrades with a visible notice rather than failing silently,
   because a yield figure quoted to a client from a fallback model is
   worse than no figure at all.

   Each function returns the same shape:
     { ok, data, msg, url }
   so the caller can show what was asked, what came back, and where it
   came from — which is the whole point of having one place that pulls.

   Two services, and they are reached in two different ways.

   Open-Meteo answers a web page directly, so its pulls are a button.

   PVGIS does not. Its API publishes no cross-origin permission, by
   stated policy ("access to PVGIS APIs via AJAX is not allowed. Please,
   do not ask for changes in our CORS policy"), so no browser will let a
   page read the answer, from any host, however it is served. For a year
   this file called it anyway and reported the failure as an offline
   page or a corporate proxy, which sent people looking in the wrong
   place. What does work is opening the same query in a browser tab,
   where the rule does not apply, and handing the answer back: so this
   file builds the query and reads the answer, and never pretends to
   fetch it.
   ===================================================================== */

/**
 * Try each host in turn; PVGIS moves its versioned path about.
 *
 * Each attempt is bounded. A blocked network does not always refuse a
 * connection — a corporate proxy will happily accept one and then say
 * nothing — and a fetch with no timeout leaves the button spinning for
 * ever with no way back. Better to give up out loud.
 */
const TIMEOUT_MS = 20000;

async function firstOk(hosts, qs, extract) {
  let last = null;
  for (const h of hosts) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(h + qs, { signal: ctl.signal });
      if (!res.ok) { last = new Error(`HTTP ${res.status}`); continue; }
      const json = await res.json();
      const data = extract(json);
      if (data === null || data === undefined) throw new Error("unexpected response shape");
      return { ok: true, data, url: h + qs, msg: "" };
    } catch (e) {
      last = e;
    } finally {
      clearTimeout(timer);
    }
  }
  const timedOut = last?.name === "AbortError";
  const blocked = /failed to fetch|networkerror|load failed|connection reset/i.test(last?.message || "");
  return {
    ok: false, data: null, url: hosts[0] + qs,
    msg: timedOut
      ? `No answer within ${TIMEOUT_MS / 1000} s. The service may be down, or a proxy may be holding the connection open without passing it on.`
      : blocked
        ? "The request was blocked before it left the machine — an offline page, a corporate proxy, or the site opened from file:// rather than http://."
        : `Request failed: ${last?.message || "unknown error"}`,
  };
}

/**
 * ERA5 daily temperature extremes, for the string-sizing cold check.
 * The lows and highs are never averaged across sources — the extreme is
 * exactly what the check exists to catch.
 */
export async function fetchEra5(lat, lon, years = 10) {
  const end = new Date();
  end.setDate(end.getDate() - 7);           // ERA5 lags real time
  const start = new Date(end);
  start.setFullYear(start.getFullYear() - years);
  const iso = (d) => d.toISOString().slice(0, 10);
  const qs = `?latitude=${lat}&longitude=${lon}&start_date=${iso(start)}&end_date=${iso(end)}`
    + `&daily=temperature_2m_min,temperature_2m_max&timezone=UTC`;
  return firstOk(
    ["https://archive-api.open-meteo.com/v1/archive", "https://api.open-meteo.com/v1/archive"],
    qs,
    (d) => {
      const lo = (d?.daily?.temperature_2m_min || []).filter(Number.isFinite);
      const hi = (d?.daily?.temperature_2m_max || []).filter(Number.isFinite);
      if (!lo.length || !hi.length) return null;
      return { lo: Math.min(...lo), hi: Math.max(...hi), days: lo.length, years };
    },
  );
}

/* ---------------------------------------------------------------
   Open-Meteo: a typical year, assembled from reanalysis
   --------------------------------------------------------------- */

const DAYS_IN = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const DOY0 = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];

/**
 * Build one representative year out of several real ones.
 *
 * For each calendar month, the year chosen is the one whose global
 * horizontal irradiation for that month sits closest to the mean of
 * that month across all the years supplied. Twelve real months, each
 * from whichever year was most ordinary for it, joined end to end.
 *
 * That is the idea behind a typical meteorological year, reduced to
 * one variable. The standard methods (Sandia, ISO 15927-4) weigh
 * several variables by the shape of their distributions; this weighs
 * one by its monthly total, and says so rather than borrowing the name
 * unqualified. What it keeps is the thing an average of years would
 * destroy: real hours, with real clear mornings and real cloud, which
 * is what a shading or clipping model actually runs on.
 *
 * `h` is Open-Meteo's hourly block: parallel arrays keyed by variable
 * name, timestamps in UTC. Its radiation values are means over the
 * hour ENDING at the timestamp, so each row is placed at the middle of
 * that hour — half an hour earlier than the stamp — because that is
 * where the sun was, on average, while the energy arrived.
 */
export function typicalYear(h) {
  const time = h?.time || [];
  const ghi = h?.shortwave_radiation || [];
  const dni = h?.direct_normal_irradiance || [];
  const dhi = h?.diffuse_radiation || [];
  const temp = h?.temperature_2m || [];
  if (!time.length) return { ok: false, msg: "no hourly data in the response" };

  // index the hours by year and month
  const byYm = new Map();
  for (let i = 0; i < time.length; i++) {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})/.exec(time[i]);
    if (!m) continue;
    const y = +m[1], mo = +m[2], d = +m[3], hr = +m[4];
    if (mo === 2 && d === 29) continue;            // a typical year has no leap day
    const key = `${y}-${mo}`;
    let g = byYm.get(key);
    if (!g) { g = { y, mo, idx: [], sum: 0, good: 0 }; byYm.set(key, g); }
    g.idx.push({ i, d, hr });
    if (Number.isFinite(ghi[i]) && ghi[i] >= 0) { g.sum += ghi[i]; g.good++; }
  }

  const picks = [];
  const rows = [];
  for (let mo = 1; mo <= 12; mo++) {
    const want = DAYS_IN[mo - 1] * 24;
    /* A month with holes in it cannot stand for that month: its total
       would read low for a reason that has nothing to do with weather. */
    const cands = [...byYm.values()].filter((g) => g.mo === mo && g.good >= want * 0.99);
    if (!cands.length) {
      return { ok: false, msg: `no complete ${MONTH_NAME[mo - 1]} in the years returned` };
    }
    const mean = cands.reduce((a, g) => a + g.sum, 0) / cands.length;
    let best = cands[0];
    for (const g of cands) {
      const dg = Math.abs(g.sum - mean), db = Math.abs(best.sum - mean);
      // ties go to the more recent year, which is the better-observed one
      if (dg < db - 1e-9 || (Math.abs(dg - db) <= 1e-9 && g.y > best.y)) best = g;
    }
    picks.push({ month: mo, year: best.y, kwh: best.sum / 1000, mean: mean / 1000, of: cands.length });
    for (const { i, d, hr } of best.idx) {
      let doy = DOY0[mo - 1] + d, hour = hr - 0.5;
      if (hour < 0) { hour += 24; doy -= 1; if (doy < 1) doy = 365; }
      const g = Number.isFinite(ghi[i]) ? Math.max(0, ghi[i]) : 0;
      rows.push({
        doy, hour, ghi: g,
        dni: Number.isFinite(dni[i]) ? Math.max(0, dni[i]) : 0,
        dhi: Number.isFinite(dhi[i]) ? Math.max(0, dhi[i]) : 0,
        temp: Number.isFinite(temp[i]) ? temp[i] : 25,
      });
    }
  }
  if (rows.length !== 8760) {
    return { ok: false, msg: `assembled ${rows.length} hours where a year has 8,760` };
  }
  const years = [...new Set([...byYm.values()].map((g) => g.y))].sort((a, b) => a - b);
  return {
    ok: true, rows, picks, years,
    ghiYear: rows.reduce((a, r) => a + r.ghi, 0) / 1000,      // kWh/m² a year
  };
}
const MONTH_NAME = ["January", "February", "March", "April", "May", "June", "July",
  "August", "September", "October", "November", "December"];

/* One bounded GET. A blocked network does not always refuse a
   connection, so every call here gives up out loud after a stated time. */
async function getJson(url, ms) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (res.status === 429) {
      return { ok: false, msg: "Open-Meteo is rate-limiting this connection. Wait a minute and "
        + "try again; an office sharing one address can reach the free limit together." };
    }
    if (!res.ok) return { ok: false, msg: `Open-Meteo answered HTTP ${res.status}.` };
    return { ok: true, json: await res.json() };
  } catch (e) {
    return { ok: false, msg: e?.name === "AbortError"
      ? `No answer within ${Math.round(ms / 1000)} s. The service may be down, or a proxy may be holding the connection.`
      : "The request did not get out: an offline machine, a blocking proxy, or the page opened from file:// rather than http://." };
  } finally {
    clearTimeout(timer);
  }
}

export const WEATHER_SOURCES = {
  sarah3: {
    name: "EUMETSAT SARAH-3 satellite irradiance, via Open-Meteo",
    standing: "Satellite-derived, and the same record PVGIS draws on for Europe, Africa and "
      + "the Middle East. Air temperature is ERA5 reanalysis, as it is in PVGIS's own typical year.",
  },
  era5: {
    name: "ERA5 reanalysis irradiance, via Open-Meteo",
    standing: "A weather model's account of the sky rather than a satellite's measurement of "
      + "it, used here because this site lies outside the satellite record. Its yearly total "
      + "is usually close; its split between direct and diffuse light is less reliable, and it "
      + "puts too much in the direct beam where cloud is frequent.",
  },
  pvgis: {
    name: "PVGIS typical meteorological year",
    standing: "PVGIS's own typical year, handed back from a browser tab.",
  },
};

/**
 * Hourly irradiance and temperature for the last `years` whole years,
 * reduced to one typical year.
 *
 * Satellite irradiance first: Open-Meteo serves EUMETSAT's SARAH-3
 * record, which is what PVGIS itself uses across the Meteosat disc.
 * That record carries no temperature, so the temperature comes from
 * ERA5 in a second call and the two are joined hour for hour.
 *
 * Outside the disc — the Americas, east Asia, Australia — the satellite
 * call comes back empty, and the irradiance falls back to ERA5 as well.
 * Which of the two was used is returned and shown, because they do not
 * have the same standing and a figure drawn from the weaker one should
 * not be able to pass for the stronger.
 */
export async function fetchTypicalYear(lat, lon, years = 10) {
  const last = new Date().getUTCFullYear() - 1;
  const first = last - years + 1;
  const span = `latitude=${lat}&longitude=${lon}&start_date=${first}-01-01&end_date=${last}-12-31&timezone=UTC`;
  const satUrl = `https://satellite-api.open-meteo.com/v1/archive?${span}`
    + "&hourly=shortwave_radiation,direct_normal_irradiance,diffuse_radiation&models=eumetsat_sarah3";
  const tempUrl = `https://archive-api.open-meteo.com/v1/archive?${span}&hourly=temperature_2m`;
  const reUrl = `https://archive-api.open-meteo.com/v1/archive?${span}`
    + "&hourly=shortwave_radiation,direct_normal_irradiance,diffuse_radiation,temperature_2m";
  // Ten years of hours is a few megabytes; give a slow link the time.
  const MS = 60000;
  const done = (ty, source, url, extra = {}) => ({ ok: true, url, msg: "", data: {
    ...ty, source,
    label: `${WEATHER_SOURCES[source].name}: typical year from ${ty.years[0]}–${ty.years[ty.years.length - 1]}`,
    lat, lon, ...extra,
  } });

  const [sat, tmp] = await Promise.all([getJson(satUrl, MS), getJson(tempUrl, MS)]);
  let whyNotSat = sat.ok ? "" : sat.msg;
  if (sat.ok) {
    const h = { ...(sat.json?.hourly || {}) };
    const t = tmp.ok ? tmp.json?.hourly : null;
    /* Joined by position, so the two series must be the same hours. If
       they are not, the temperature is left out rather than misaligned:
       a constant 25 °C is a stated simplification, an offset series is
       a silent error. */
    const aligned = !!t && Array.isArray(t.time) && Array.isArray(h.time)
      && t.time.length === h.time.length && t.time[0] === h.time[0];
    if (aligned) h.temperature_2m = t.temperature_2m;
    const ty = typicalYear(h);
    if (ty.ok) return done(ty, "sarah3", satUrl, { tempFrom: aligned ? "ERA5" : null });
    whyNotSat = "the satellite record does not cover this site";
  }
  const re = await getJson(reUrl, MS);
  if (!re.ok) return { ok: false, data: null, url: reUrl, msg: re.msg };
  const ty = typicalYear(re.json?.hourly);
  if (!ty.ok) return { ok: false, data: null, url: reUrl, msg: `Open-Meteo answered, but ${ty.msg}.` };
  return done(ty, "era5", reUrl, { tempFrom: "ERA5", fellBack: whyNotSat });
}

/* ---------------------------------------------------------------
   PVGIS: the query, and the answer when it is handed back
   --------------------------------------------------------------- */

const PVGIS = "https://re.jrc.ec.europa.eu/api/v5_3";

/**
 * Which planes PVGIS has to be asked about for a mounting type.
 *
 * A tracker is one question. A fixed array is one, facing the equator.
 * An east-west pair is two, because PVGIS models one plane at a time
 * and the pair's yield is the mean of its faces.
 *
 * `aspect` is PVGIS's own convention: 0 faces south, 90 west, -90
 * east, 180 north. A fixed array in the southern hemisphere faces
 * north, and leaving the aspect at its default there asks PVGIS about
 * an array pointing away from the sun.
 */
export function pvgisFaces({ lat, mounting, tilt }) {
  if (mounting === "fixed") {
    return [{ key: "fixed", name: `fixed at ${tilt}°, facing ${lat < 0 ? "north" : "south"}`,
      kind: "fixed", slope: tilt, aspect: lat < 0 ? 180 : 0 }];
  }
  if (mounting === "ew") {
    return [
      { key: "east", name: `east face at ${tilt}°`, kind: "fixed", slope: tilt, aspect: -90 },
      { key: "west", name: `west face at ${tilt}°`, kind: "fixed", slope: tilt, aspect: 90 },
    ];
  }
  return [{ key: "tracker", name: "horizontal single-axis tracker, north–south axis",
    kind: "inclined_axis", slope: 0, aspect: null }];
}

/**
 * The PVGIS query for one plane, or for the typical year.
 *
 * The tracker form is `fixed=0&inclined_axis=1&inclinedaxisangle=0`.
 * It is NOT `trackingtype=1`: that parameter belongs to a different
 * PVGIS tool, PVcalc ignores it without complaint, and the answer that
 * comes back is a fixed plane lying flat — about a quarter less energy
 * than the tracker that was asked for, under a label that says nothing
 * of the kind. `readPvgis` checks the mounting PVGIS says it modelled
 * for exactly that reason.
 */
export function pvgisUrl(kind, { lat, lon, loss = 14, face = null } = {}) {
  if (kind === "tmy") return `${PVGIS}/tmy?lat=${lat}&lon=${lon}&outputformat=json`;
  const base = `${PVGIS}/PVcalc?lat=${lat}&lon=${lon}&peakpower=1&loss=${loss}`
    + "&pvtechchoice=crystSi&mountingplace=free&usehorizon=1&outputformat=json";
  if (face && face.kind === "fixed") return `${base}&angle=${face.slope}&aspect=${face.aspect}`;
  return `${base}&fixed=0&inclined_axis=1&inclinedaxisangle=0`;
}

/** PVGIS TMY rows, as the pitch model wants them. */
export function parseTmy(json) {
  const rows = json?.outputs?.tmy_hourly;
  if (!Array.isArray(rows) || !rows.length) throw new Error("no hourly data in it");
  const out = [];
  for (const r of rows) {
    const t = String(r.time || r["time(UTC)"] || "");
    const m = t.match(/^(\d{4})(\d{2})(\d{2}):(\d{2})/);
    if (!m) continue;
    const mon = Number(m[2]), day = Number(m[3]), hour = Number(m[4]);
    const doy = DOY0[mon - 1] + day;
    const ghi = r["G(h)"], dni = r["Gb(n)"], dhi = r["Gd(h)"], temp = r.T2m;
    if (!(ghi >= 0) || !(dni >= 0) || !(dhi >= 0)) continue;
    out.push({ doy, hour, ghi, dni, dhi, temp: temp ?? 25 });
  }
  if (out.length < 4000) throw new Error(`only ${out.length} usable hours in it`);
  return out;
}

const near = (a, b, tol) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol;

/**
 * Read a PVGIS answer that was saved or pasted.
 *
 * It reads back what PVGIS says it was ASKED, not only what it
 * answered, and compares that with the site: the place, the mounting,
 * the tilt and which way it faces. An answer for somewhere else, or
 * for a different plane, is a perfectly good number about the wrong
 * thing, and nothing about its size gives that away.
 *
 * `expect` is { lat, lon, face } for PVcalc and { lat, lon } for TMY.
 */
export function readPvgis(kind, text, expect = {}) {
  let json;
  try {
    json = typeof text === "string" ? JSON.parse(text.replace(/^﻿/, "").trim()) : text;
  } catch (e) {
    return { ok: false, msg: /^\s*</.test(String(text))
      ? "That is a web page, not the answer. Open the link, and save or copy what that tab shows."
      : "That does not read as PVGIS's answer. It should begin with {\"inputs\"." };
  }
  if (json?.message && !json?.outputs) {
    return { ok: false, msg: `PVGIS refused the query: ${json.message}` };
  }
  const where = json?.inputs?.location || {};
  const meteo = json?.inputs?.meteo_data || {};
  const asked = {
    lat: where.latitude, lon: where.longitude,
    radDb: meteo.radiation_db || null,
    years: meteo.year_min && meteo.year_max ? `${meteo.year_min}–${meteo.year_max}` : null,
    horizon: meteo.use_horizon === true,
  };
  const warnings = [];
  if (Number.isFinite(expect.lat) && Number.isFinite(expect.lon)
      && !(near(asked.lat, expect.lat, 0.02) && near(asked.lon, expect.lon, 0.02))) {
    warnings.push(`This answer is for ${asked.lat}, ${asked.lon}; the site is at `
      + `${expect.lat}, ${expect.lon}. It is a figure for somewhere else.`);
  }

  if (kind === "tmy") {
    try {
      const rows = parseTmy(json);
      return { ok: true, warnings, data: {
        rows, source: "pvgis", asked,
        label: `PVGIS TMY${asked.radDb ? `, ${asked.radDb}` : ""}${asked.years ? ` ${asked.years}` : ""}`,
        ghiYear: rows.reduce((a, r) => a + r.ghi, 0) / 1000,
        lat: asked.lat, lon: asked.lon,
      } };
    } catch (e) {
      return { ok: false, msg: `That is a PVGIS answer, but ${e.message}. It may be the yield `
        + "answer rather than the typical year." };
    }
  }

  const totals = json?.outputs?.totals;
  if (!totals) {
    return { ok: false, msg: "That is a PVGIS answer, but it carries no yield totals. It may be "
      + "the typical year rather than the yield." };
  }
  const face = expect.face || null;
  const want = face ? face.kind : (totals.inclined_axis ? "inclined_axis" : "fixed");
  const tot = totals[want];
  const mount = json?.inputs?.mounting_system?.[want];
  if (!tot || !(tot.E_y > 0)) {
    const got = Object.keys(totals).join(", ") || "nothing";
    return { ok: false, msg: want === "inclined_axis"
      ? `PVGIS modelled ${got === "fixed" ? "a fixed plane" : got}, not a tracker. Use the link `
        + "here, which asks for a horizontal single-axis tracker; the older tracker query "
        + "returned a flat fixed plane and reads about a quarter low."
      : `PVGIS modelled ${got}, not a fixed plane. Use the link here.` };
  }
  const slope = mount?.slope?.value, azimuth = mount?.azimuth?.value;
  if (face && face.kind === "fixed") {
    if (!near(Number(slope), face.slope, 0.5)) {
      warnings.push(`This answer is for a ${slope}° tilt; the layout is at ${face.slope}°.`);
    }
    if (!near(Number(azimuth), face.aspect, 1)) {
      warnings.push(`This answer faces ${aspectName(Number(azimuth))}; this plane faces `
        + `${aspectName(face.aspect)}.`);
    }
  }
  const pv = json?.inputs?.pv_module || {};
  const peak = pv.peak_power > 0 ? pv.peak_power : 1;
  const monthly = (json?.outputs?.monthly?.[want] || [])
    .map((m) => ({ month: m.month, e: m.E_m / peak }))
    .filter((m) => Number.isFinite(m.e));
  return { ok: true, warnings, data: {
    specYield: tot.E_y / peak,
    irradiation: tot["H(i)_y"] ?? null,
    sdYear: Number.isFinite(tot.SD_y) ? tot.SD_y / peak : null,
    monthly,
    asked: { ...asked, mounting: want, slope: Number.isFinite(+slope) ? +slope : null,
      azimuth: Number.isFinite(+azimuth) ? +azimuth : null, loss: pv.system_loss ?? null },
  } };
}

export const aspectName = (a) => (a === 0 ? "south" : a === 180 || a === -180 ? "north"
  : a === 90 ? "west" : a === -90 ? "east" : `${a}° from south`);

/**
 * Several faces into one baseline. An east-west pair is the mean of
 * its two faces, month by month, since the two share the inverter and
 * each carries half the modules. Returns null until every face asked
 * for has an answer, because half a pair is not a smaller answer, it
 * is a different array.
 */
export function combineFaces(faces, answers) {
  const got = faces.map((f) => answers?.[f.key]).filter(Boolean);
  if (!faces.length || got.length !== faces.length) return null;
  const n = got.length;
  const monthly = (got[0].monthly || []).map((m, i) => ({
    month: m.month, e: got.reduce((a, g) => a + (g.monthly?.[i]?.e ?? 0), 0) / n,
  }));
  const allHave = (k) => got.every((g) => Number.isFinite(g[k]));
  return {
    specYield: got.reduce((a, g) => a + g.specYield, 0) / n,
    irradiation: allHave("irradiation") ? got.reduce((a, g) => a + g.irradiation, 0) / n : null,
    sdYear: allHave("sdYear") ? got.reduce((a, g) => a + g.sdYear, 0) / n : null,
    monthly,
    asked: got[0].asked, faces: faces.map((f) => f.name),
    source: "pvgis",
  };
}
