/* The capacity chain is checked against the source workbook's BESS
   Sizing sheet, value by value. The dispatch has no workbook to check
   against, so it is checked against conservation of energy and against
   cases whose answer is known by inspection. */
import {
  nameplateFromUsable, usableFromNameplate, unitCount,
  loadProfile, pvProfile, dispatch, sweepBattery, suggestSizes,
  parseLoadCsv, loadFromMonthly, profileSummary,
} from '../src/bess.js';

let pass = 0, fail = 0;
const ok = (name, cond, got) => { if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}` + (got !== undefined ? `  got ${got}` : '')); } };
const near = (name, a, b, tol = 1e-6) => ok(name, Math.abs(a - b) <= tol, a);

console.log('\n--- capacity chain, against the workbook BESS sheet ---');
/* Workbook: 35 MW, 175 MWh, DoD 100, RTE 88, aux 2, BOL.
   B18 = 190.357782460366 MWh nameplate. */
const r = nameplateFromUsable({ usableKWh: 175000, dodPct: 100, rtePct: 88, auxPct: 2, sizeFor: 'bol' });
near('B18 nameplate = 190.357782460366 MWh', r.nameplateKWh / 1000, 190.357782460366, 1e-9);
near('discharge efficiency = sqrt(0.88)', r.etaDischarge, Math.sqrt(0.88), 1e-12);
ok('BOL applies no retention', r.retention === 1, r.retention);
const eol = nameplateFromUsable({ usableKWh: 175000, dodPct: 100, rtePct: 88, auxPct: 2, retentionPct: 70, sizeFor: 'eol' });
near('EOL applies 0.70', eol.retention, 0.7);
ok('EOL needs more nameplate than BOL', eol.nameplateKWh > r.nameplateKWh);
near('EOL is exactly BOL / 0.7', eol.nameplateKWh, r.nameplateKWh / 0.7, 1e-6);

console.log('\n--- unit count, against the workbook ---');
/* Workbook: 5 MWh / 2.5 MW units, pf 1.  B29=14, B30=39, B31=39,
   B32=195 MWh, B33=97.5 MW, B34=179.267690340451 MWh, B35=PASS. */
const u = unitCount({ requiredKW: 35000, nameplateKWh: r.nameplateKWh,
  unitKWh: 5000, unitKW: 2500, pf: 1, dodPct: 100, rtePct: 88, auxPct: 2, sizeFor: 'bol' });
ok('B29 units for power = 14', u.forPower === 14, u.forPower);
ok('B30 units for energy = 39', u.forEnergy === 39, u.forEnergy);
ok('B31 governing = 39', u.units === 39, u.units);
ok('governed by energy', u.governedBy === 'energy', u.governedBy);
near('B32 installed energy = 195 MWh', u.installedKWh / 1000, 195);
near('B33 installed power = 97.5 MW', u.installedKW / 1000, 97.5);
near('B34 deliverable = 179.267690340451 MWh', u.deliverableKWh / 1000, 179.267690340451, 1e-9);
ok('B35 PASS — deliverable meets the 175 MWh asked', u.deliverableKWh >= 175000 && u.powerOk);
/* A power-driven case: same units, 100 MW for 1 hour. */
const u2 = unitCount({ requiredKW: 100000, nameplateKWh: nameplateFromUsable({ usableKWh: 100000 }).nameplateKWh,
  unitKWh: 5000, unitKW: 2500, pf: 1 });
ok('power-driven case is labelled power', u2.governedBy === 'power', u2.governedBy);
ok('power-driven needs 40 units', u2.units === 40, u2.units);

console.log('\n--- round trip of the chain ---');
const back = usableFromNameplate({ nameplateKWh: r.nameplateKWh, dodPct: 100, rtePct: 88, auxPct: 2 });
near('nameplate -> usable returns the original 175 MWh', back.usableKWh, 175000, 1e-6);

console.log('\n--- load profiles ---');
for (const shape of ['residential', 'commercial', 'industrial', 'flat']) {
  const L = loadProfile({ annualKWh: 4000, shape });
  const sum = L.reduce((a, b) => a + b, 0);
  near(`${shape}: annual total preserved`, sum, 4000, 1e-6);
  ok(`${shape}: 8760 hours`, L.length === 8760, L.length);
  ok(`${shape}: never negative`, L.every((v) => v >= 0));
}
{ const L = loadProfile({ annualKWh: 4000, shape: 'residential', seasonalAmp: 40, seasonalPeak: 'winter' });
  near('seasonality does not change the annual total', L.reduce((a,b)=>a+b,0), 4000, 1e-6);
  const jan = L.slice(0, 744).reduce((a,b)=>a+b,0), jul = L.slice(4344, 5088).reduce((a,b)=>a+b,0);
  ok('winter peak puts January above July', jan > jul, `${jan.toFixed(0)} vs ${jul.toFixed(0)}`); }
{ const L = loadProfile({ annualKWh: 4000, shape: 'commercial', weekendFactor: 0.3 });
  near('weekend factor does not change the annual total', L.reduce((a,b)=>a+b,0), 4000, 1e-6); }

console.log('\n--- PV profile ---');
{ const { pv, synthetic } = pvProfile({ kWp: 5, specificYield: 1200, lat: 51.5, prRatio: 1 });
  ok('no TMY is flagged synthetic', synthetic === true);
  near('synthetic scales to the stated yield', pv.reduce((a,b)=>a+b,0), 6000, 1e-6);
  ok('night hours are zero', pv[0] === 0 && pv[23] === 0, `${pv[0]}, ${pv[23]}`);
  const jun = pv.slice(3624, 4344).reduce((a,b)=>a+b,0), dec = pv.slice(8016, 8760).reduce((a,b)=>a+b,0);
  ok('northern summer out-generates winter', jun > dec, `${jun.toFixed(0)} vs ${dec.toFixed(0)}`);
  const south = pvProfile({ kWp: 5, specificYield: 1200, lat: -33, prRatio: 1 }).pv;
  const sJun = south.slice(3624, 4344).reduce((a,b)=>a+b,0), sDec = south.slice(8016, 8760).reduce((a,b)=>a+b,0);
  ok('southern hemisphere reverses the seasons', sDec > sJun, `${sDec.toFixed(0)} vs ${sJun.toFixed(0)}`); }
{ const tmy = new Array(8760).fill(0).map((_, h) => (h % 24 >= 8 && h % 24 < 17 ? 600 : 0));
  const { pv, synthetic } = pvProfile({ tmy, kWp: 10, specificYield: 1400 });
  ok('TMY present is not flagged synthetic', synthetic === false);
  near('TMY profile scales to kWp x yield', pv.reduce((a,b)=>a+b,0), 14000, 1e-6); }

console.log('\n--- dispatch: conservation and known cases ---');
{ /* No battery: everything is direct, import or export. */
  const load = new Float64Array(8760).fill(1);
  const pv = new Float64Array(8760).fill(0).map((_, h) => (h % 24 >= 10 && h % 24 < 14 ? 3 : 0));
  const d = dispatch({ pv, load, nameplateKWh: 0, powerKW: 0, rtePct: 88, hasGrid: true });
  near('no battery: nothing charged', d.charged, 0);
  near('no battery: nothing discharged', d.discharged, 0);
  near('load balance: direct + imported = load', d.direct + d.imported, d.loadTotal, 1e-6);
  near('PV balance: direct + exported + curtailed = PV', d.direct + d.exported + d.curtailed, d.pvTotal, 1e-6);
  near('self-sufficiency = direct / load', d.selfSufficiencyPct, (d.direct / d.loadTotal) * 100, 1e-9); }

{ const load = new Float64Array(8760).fill(1);
  const pv = new Float64Array(8760).fill(0).map((_, h) => (h % 24 >= 10 && h % 24 < 14 ? 3 : 0));
  const d = dispatch({ pv, load, nameplateKWh: 20, powerKW: 5, rtePct: 88, dodPct: 100, hasGrid: true });
  near('load balance with battery', d.direct + d.discharged + d.imported, d.loadTotal, 1e-6);
  near('PV balance with battery', d.direct + d.charged + d.exported + d.curtailed, d.pvTotal, 1e-6);
  ok('battery raises self-sufficiency above direct-only', d.selfSufficiencyPct > (d.direct / d.loadTotal) * 100);
  ok('discharged is less than charged (round-trip loss)', d.discharged < d.charged, `${d.discharged.toFixed(1)} vs ${d.charged.toFixed(1)}`);
  near('round-trip loss matches sqrt-split efficiency within a cycle', d.roundTripLossKWh, d.charged - d.discharged, 1e-9);
  ok('state of charge never exceeds 100%', d.socSeries.every((v) => v <= 100 + 1e-9));
  ok('state of charge never goes negative', d.socSeries.every((v) => v >= -1e-9));
  ok('cycles are a sensible count', d.cycles > 0 && d.cycles < 8760, d.cycles); }

{ /* Off grid: the shortfall must be reported, never absorbed. */
  const load = new Float64Array(8760).fill(1);
  const pv = new Float64Array(8760).fill(0);
  const d = dispatch({ pv, load, nameplateKWh: 10, powerKW: 5, hasGrid: false, socInitPct: 100 });
  ok('off grid with no PV: unmet load is reported', d.unmet > 0, d.unmet);
  near('off grid: served + unmet = load', d.direct + d.discharged + d.unmet, d.loadTotal, 1e-6);
  near('off grid: nothing imported', d.imported, 0);
  ok('unmet percentage is consistent', Math.abs(d.unmetPct - (d.unmet / d.loadTotal) * 100) < 1e-9); }

{ /* DoD restricts what the bank can give. */
  const load = new Float64Array(8760).fill(1);
  const pv = new Float64Array(8760).fill(0).map((_, h) => (h % 24 >= 10 && h % 24 < 14 ? 4 : 0));
  const full = dispatch({ pv, load, nameplateKWh: 20, powerKW: 5, dodPct: 100 });
  const half = dispatch({ pv, load, nameplateKWh: 20, powerKW: 5, dodPct: 50 });
  ok('halving DoD lowers self-sufficiency', half.selfSufficiencyPct < full.selfSufficiencyPct,
    `${half.selfSufficiencyPct.toFixed(2)} vs ${full.selfSufficiencyPct.toFixed(2)}`);
  near('usable capacity follows DoD', half.usableKWh, 10); }

{ /* Export limit sends the rest to curtailment, not into thin air. */
  const load = new Float64Array(8760).fill(0.2);
  const pv = new Float64Array(8760).fill(0).map((_, h) => (h % 24 >= 10 && h % 24 < 14 ? 5 : 0));
  const d = dispatch({ pv, load, nameplateKWh: 2, powerKW: 1, exportLimitKW: 1 });
  ok('export beyond the limit is curtailed', d.curtailed > 0, d.curtailed);
  ok('peak export never exceeds the limit', d.peakExportKW <= 1 + 1e-9, d.peakExportKW);
  near('PV balance holds with curtailment', d.direct + d.charged + d.exported + d.curtailed, d.pvTotal, 1e-6); }

{ /* Power rating binds independently of energy. */
  const load = new Float64Array(8760).fill(10);
  const pv = new Float64Array(8760).fill(0).map((_, h) => (h % 24 >= 10 && h % 24 < 14 ? 40 : 0));
  const slow = dispatch({ pv, load, nameplateKWh: 500, powerKW: 1 });
  const fast = dispatch({ pv, load, nameplateKWh: 500, powerKW: 50 });
  ok('a bigger inverter uses the same bank better', fast.selfSufficiencyPct > slow.selfSufficiencyPct,
    `${fast.selfSufficiencyPct.toFixed(2)} vs ${slow.selfSufficiencyPct.toFixed(2)}`); }

console.log('\n--- sweep and the knee ---');
{ const load = loadProfile({ annualKWh: 4000, shape: 'residential' });
  const { pv } = pvProfile({ kWp: 4, specificYield: 1000, lat: 51.5, prRatio: 1 });
  const sizes = suggestSizes(4000 / 365, 12);
  const s = sweepBattery({ pv, load, powerKW: 3, rtePct: 90, dodPct: 100 }, sizes);
  ok('a row per size', s.rows.length === sizes.length, s.rows.length);
  ok('self-sufficiency rises with size', s.rows.every((r, i) => i === 0 || r.selfSufficiencyPct >= s.rows[i-1].selfSufficiencyPct - 1e-9));
  ok('marginal gain is reported from the second row', s.rows[0].marginalPerKWh === null && s.rows[1].marginalPerKWh !== null);
  ok('marginal gain diminishes', s.rows[s.rows.length-1].marginalPerKWh < s.rows[1].marginalPerKWh,
    `${s.rows[s.rows.length-1].marginalPerKWh} vs ${s.rows[1].marginalPerKWh}`);
  ok('a knee is identified', s.knee !== null, s.knee && s.knee.nameplateKWh);
  ok('the knee is at or below the largest size swept', s.knee.nameplateKWh <= sizes[sizes.length-1]);
  ok('threshold is the stated fraction of the first gain', Math.abs(s.threshold - s.firstMarginal * 0.2) < 1e-12); }

{ /* A sweep that is still climbing at its top end must say so. */
  const load = new Float64Array(8760).fill(5);
  const pv = new Float64Array(8760).fill(0).map((_, h) => (h % 24 >= 9 && h % 24 < 15 ? 60 : 0));
  const s = sweepBattery({ pv, load, powerKW: 100, rtePct: 95 }, [1, 2, 3, 4]);
  ok('an unbracketed sweep is flagged', s.bracketed === false, s.bracketed); }

console.log('\n--- monthly bills into a year ---');
{ const m = [500, 450, 400, 320, 280, 250, 240, 250, 300, 380, 450, 520];
  const L = loadFromMonthly(m, 'residential');
  near('annual total matches the sum of the bills', L.reduce((a,b)=>a+b,0), m.reduce((a,b)=>a+b,0), 1e-6);
  const jan = L.slice(0, 744).reduce((a,b)=>a+b,0);
  near('January matches its own bill', jan, 500, 1e-6);
  const jul = L.slice(4344, 5088).reduce((a,b)=>a+b,0);
  near('July matches its own bill', jul, 240, 1e-6);
  ok('8760 hours', L.length === 8760); }

console.log('\n--- CSV import ---');
const mkCsv = (n, perHour, unit, header = true) => {
  const out = header ? [`timestamp,${unit}`] : [];
  for (let i = 0; i < n; i++) {
    const h = Math.floor(i / perHour) % 24;
    const kw = 0.3 + 0.5 * Math.sin((h / 24) * Math.PI * 2 + 1) ** 2;
    out.push(`2024-01-01T${String(h).padStart(2,'0')}:00,${(unit === 'kW' ? kw : kw / perHour).toFixed(4)}`);
  }
  return out.join('\n');
};
{ const r = parseLoadCsv(mkCsv(8760, 1, 'kWh'));
  ok('hourly recognised', r.resolution === 'hourly', r.resolution);
  ok('named kWh column found', r.unit === 'kwh', r.unit);
  ok('8760 hours out', r.load.length === 8760);
  ok('a plausible annual total', r.annualKWh > 0, r.annualKWh.toFixed(0)); }
{ const r = parseLoadCsv(mkCsv(17520, 2, 'kW'));
  ok('half-hourly recognised', r.resolution === 'half-hourly', r.resolution);
  ok('kW column found', r.unit === 'kw', r.unit);
  /* Same numbers, different stated unit. At half-hourly a kW reading is
     power held for half an hour, so it contributes half as much energy
     as the same figure read as kWh. Getting this backwards doubles or
     halves the year, which is why it is reported. */
  const same = Array.from({ length: 17520 }, () => '2024,2').join('\n');
  const asKw = parseLoadCsv('t,kW\n' + same);
  const asKwh = parseLoadCsv('t,kWh\n' + same);
  near('kWh at half-hourly sums the readings', asKwh.annualKWh, 17520 * 2, 1e-6);
  near('kW at half-hourly halves them', asKw.annualKWh, 17520 * 2 * 0.5, 1e-6);
  ok('the two units give different years', asKw.annualKWh !== asKwh.annualKWh); }
{ const r = parseLoadCsv(mkCsv(35040, 4, 'kW'));
  ok('quarter-hourly recognised', r.resolution === 'quarter-hourly', r.resolution); }
{ const r = parseLoadCsv('500\n450\n400\n320\n280\n250\n240\n250\n300\n380\n450\n520'.split('\n').map((v,i)=>`M${i+1},${v}`).join('\n'));
  ok('twelve rows read as monthly', r.resolution === 'monthly', r.resolution);
  near('monthly totals preserved', r.annualKWh, 4340, 1e-6); }
{ const semi = 'Zeitstempel;Verbrauch kWh\n' + Array.from({length: 8760}, (_, i) => `2024;${(0.5).toFixed(1).replace('.', ',')}`).join('\n');
  const r = parseLoadCsv(semi);
  ok('semicolon and decimal comma handled', Math.abs(r.annualKWh - 4380) < 1, r.annualKWh); }
{ const r = parseLoadCsv(mkCsv(8760, 1, 'kWh', false));
  ok('headerless file still parses', r.hasHeader === false && r.load.length === 8760);
  ok('headerless warns about the column guess', r.warnings.some(w => /No column was named/.test(w))); }
{ const r = parseLoadCsv('t,kWh\n' + Array.from({length: 365}, () => '2024,10').join('\n'));
  ok('daily recognised', r.resolution === 'daily', r.resolution);
  near('daily totals preserved', r.annualKWh, 3650, 1e-6);
  ok('daily warns the shape is assumed', r.warnings.some(w => /within-day shape is assumed/.test(w))); }
{ const r = parseLoadCsv('t,kWh\n' + Array.from({length: 8760}, (_, i) => `2024,${i % 100 === 0 ? -2 : 1}`).join('\n'));
  ok('negative readings are flagged', r.warnings.some(w => /negative/.test(w)));
  ok('negatives are floored, not summed', r.annualKWh > 8600, r.annualKWh); }
{ let threw = null; try { parseLoadCsv(''); } catch (e) { threw = e.message; }
  ok('an empty file fails clearly', /empty/.test(threw || ''), threw);
  threw = null; try { parseLoadCsv('a,b\n1,2'); } catch (e) { threw = e.message; }
  ok('too few rows fails clearly', /too few/.test(threw || ''), threw); }
{ const r = parseLoadCsv('t,MWh\n' + Array.from({length: 8760}, () => '2024,1').join('\n'));
  ok('an MW header is flagged', r.warnings.some(w => /MW or MWh/.test(w))); }

console.log('\n--- profile summary ---');
{ const L = loadProfile({ annualKWh: 4000, shape: 'residential' });
  const s = profileSummary(L);
  ok('24 hourly averages', s.byHour.length === 24);
  ok('12 monthly totals', s.byMonth.length === 12);
  near('monthly totals sum to the year', s.byMonth.reduce((a,b)=>a+b,0), 4000, 1e-6);
  const peak = s.byHour.indexOf(Math.max(...s.byHour));
  ok('residential peak lands in the evening', peak >= 17 && peak <= 21, peak); }

{ /* An imported profile must drive the dispatch the same as a built one. */
  const r = parseLoadCsv(mkCsv(8760, 1, 'kWh'));
  const { pv } = pvProfile({ kWp: 4, specificYield: 1000, lat: 51.5, prRatio: 1 });
  const d = dispatch({ pv, load: r.load, nameplateKWh: 10, powerKW: 3.7, rtePct: 90 });
  near('load balance holds on imported data', d.direct + d.discharged + d.imported, d.loadTotal, 1e-6);
  ok('self-sufficiency is in range', d.selfSufficiencyPct > 0 && d.selfSufficiencyPct <= 100,
    d.selfSufficiencyPct.toFixed(1)); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
