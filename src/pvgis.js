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

/** PVGIS TMY — 8,760 hours of GHI/DNI/DHI and air temperature. */
export async function fetchTmy(lat, lon) {
  const qs = `?lat=${lat}&lon=${lon}&outputformat=json`;
  return firstOk(
    ["https://re.jrc.ec.europa.eu/api/v5_3/tmy", "https://re.jrc.ec.europa.eu/api/tmy"],
    qs,
    (d) => (Array.isArray(d?.outputs?.tmy_hourly) && d.outputs.tmy_hourly.length ? d : null),
  );
}

/**
 * PVGIS PVcalc — their validated absolute yield for one kWp, including
 * the terrain horizon. This is the only absolute number in the tool that
 * is not ours: the pitch model supplies ratios, and this scales them.
 */
export async function fetchPvcalc({ lat, lon, mounting, tilt, loss }) {
  const tracking = mounting === "fixed" ? 0 : 1;   // 1 = horizontal N-S axis
  const qs = `?lat=${lat}&lon=${lon}&peakpower=1&loss=${loss}`
    + `&pvtechchoice=crystSi&mountingplace=free&trackingtype=${tracking}`
    + (tracking === 0 ? `&angle=${tilt}` : "")
    + `&usehorizon=1&outputformat=json`;
  return firstOk(
    ["https://re.jrc.ec.europa.eu/api/v5_3/PVcalc", "https://re.jrc.ec.europa.eu/api/PVcalc"],
    qs,
    (d) => {
      const t = d?.outputs?.totals || {};
      const first = t.fixed || t.tracking || Object.values(t)[0];
      if (!(first?.E_y > 0)) return null;
      const monthly = (d?.outputs?.monthly?.fixed || d?.outputs?.monthly?.tracking || [])
        .map((m) => ({ month: m.month, e: m.E_m }))
        .filter((m) => Number.isFinite(m.e));
      return {
        specYield: first.E_y,          // kWh per kWp per year
        irradiation: first["H(i)_y"] ?? null,
        sdYear: first.SD_y ?? null,
        monthly,
      };
    },
  );
}
