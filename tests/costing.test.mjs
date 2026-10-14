/* The finance is checked against closed-form answers; the quote
   handling against the cases that would quietly corrupt a comparison —
   mixed currencies, mixed vintages, lump sums applied at the wrong
   plant size, and escalation losing the original. */
import {
  REGIONS, regionById, COST_LINES, emptyQuote,
  quoteAgeMonths, stalenessOf, escalate, quoteAt, deriveIndices,
  energySeries, opexSeries, lcoe, npv, irr, evaluate, compareQuotes,
  quotesToCsv, quotesFromCsv,
} from '../src/costing.js';

let pass = 0, fail = 0;
const ok = (n, c, got) => { if (c) { pass++; console.log(`  PASS ${n}`); }
  else { fail++; console.log(`  FAIL ${n}` + (got !== undefined ? `  got ${got}` : '')); } };
const near = (n, a, b, t = 1e-6) => ok(n, Math.abs(a - b) <= t, a);

console.log('--- no prices ship with the tool ---');
ok('no region carries a money figure',
  REGIONS.every((r) => !('equipIndex' in r) && !('capex' in r) && !('perWp' in r)));
ok('every region has a currency and a soiling band',
  REGIONS.every((r) => r.ccy && r.soilingPct > 0 && r.discountBand?.length === 2));
ok('all eight regions present', REGIONS.length === 8, REGIONS.length);
ok('the asked-for regions exist',
  ['de','uk','cl','af-e','af-w','af-s','za','eu'].every((id) => REGIONS.some((r) => r.id === id)));
ok('an empty quote has no prices in it',
  COST_LINES.every((l) => emptyQuote().lines[l.id] === 0));

console.log('\n--- age ---');
const Q = (over) => emptyQuote({ name: "Q", kWpBasis: 5000, ...over });
{ const asOf = new Date('2026-10-14');
  near('a quote priced today is 0 months old', quoteAgeMonths(Q({ datePriced: '2026-10-14' }), asOf), 0);
  near('one priced a year ago is 12', quoteAgeMonths(Q({ datePriced: '2025-10-14' }), asOf), 12);
  near('part months round down', quoteAgeMonths(Q({ datePriced: '2026-09-20' }), asOf), 0);
  ok('a missing date gives null', quoteAgeMonths(Q({ datePriced: '' }), asOf) === null);
  ok('current under six months', stalenessOf(Q({ datePriced: '2026-07-01' }), asOf).id === 'fresh',
    stalenessOf(Q({ datePriced: '2026-07-01' }), asOf).id);
  ok('ageing at a year', stalenessOf(Q({ datePriced: '2025-10-01' }), asOf).id === 'ageing');
  ok('stale past eighteen months', stalenessOf(Q({ datePriced: '2024-01-01' }), asOf).id === 'stale');
  ok('no date is flagged, not assumed fresh', stalenessOf(Q({ datePriced: '' }), asOf).id === 'unknown'); }

console.log('\n--- escalation never overwrites ---');
{ const q = Q({ datePriced: '2024-10-14', lines: { ...emptyQuote().lines, modules: 0.10, install: 0.05 } });
  const e = escalate(q, 5, new Date('2026-10-14'));
  near('two years at 5% compounds', e.lines.modules, 0.10 * 1.05 * 1.05, 1e-12);
  near('every line is escalated by the same factor', e.lines.install, 0.05 * 1.05 * 1.05, 1e-12);
  ok('the original lines are kept', e.escalatedFrom.lines.modules === 0.10, e.escalatedFrom.lines.modules);
  ok('and the rate and months are recorded',
    e.escalatedFrom.ratePctPerYear === 5 && e.escalatedFrom.months === 24, e.escalatedFrom.months);
  const none = escalate(Q({ datePriced: '2026-10-14' }), 5, new Date('2026-10-14'));
  ok('a current quote is not escalated', none.escalatedFrom === null); }

console.log('\n--- applying a quote at a different plant size ---');
{ const q = Q({ kWpBasis: 5000, lines: { ...emptyQuote().lines, modules: 0.10, substation: 500000 } });
  const same = quoteAt(q, 5000);
  near('per-Wp line at the quoted size', same.lines.find((l) => l.id === 'modules').amount, 0.10 * 5e6);
  near('lump unchanged at the quoted size', same.lines.find((l) => l.id === 'substation').amount, 500000, 1e-6);
  near('capex adds up', same.capex, 0.10 * 5e6 + 500000, 1e-6);

  const big = quoteAt(q, 50000, { lumpMode: 'scaled', lumpExponent: 0.7 });
  near('per-Wp scales linearly', big.lines.find((l) => l.id === 'modules').amount, 0.10 * 5e7, 1e-6);
  near('the lump follows the power law',
    big.lines.find((l) => l.id === 'substation').amount, 500000 * Math.pow(10, 0.7), 1e-6);
  const asQuoted = quoteAt(q, 50000, { lumpMode: 'asQuoted' });
  near('as-quoted keeps the lump', asQuoted.lines.find((l) => l.id === 'substation').amount, 500000, 1e-6);
  const linear = quoteAt(q, 50000, { lumpMode: 'perWp' });
  near('linear scales it tenfold', linear.lines.find((l) => l.id === 'substation').amount, 5000000, 1e-6);
  ok('the three modes genuinely differ',
    asQuoted.capex < big.capex && big.capex < linear.capex,
    `${asQuoted.capex} < ${big.capex} < ${linear.capex}`);
  ok('the scaling is reported per line',
    big.lines.find((l) => l.id === 'substation').scaling === 'size^0.7'); }

console.log('\n--- derived indices come from real quotes ---');
{ const a = Q({ currency: 'EUR', lines: { ...emptyQuote().lines, modules: 0.10, install: 0.08 } });
  const b = Q({ currency: 'EUR', lines: { ...emptyQuote().lines, modules: 0.12, install: 0.04 } });
  const d = deriveIndices(a, b);
  near('modules ratio', d.lines.find((l) => l.id === 'modules').ratio, 1.2, 1e-12);
  near('labour ratio', d.lines.find((l) => l.id === 'install').ratio, 0.5, 1e-12);
  ok('lines with no price give no ratio',
    d.lines.find((l) => l.id === 'civil').ratio === null);
  ok('and are marked as missing on both',
    d.lines.find((l) => l.id === 'civil').missing === 'both');
  ok('two usable lines', d.usable === 2, d.usable);
  const c = Q({ currency: 'USD', lines: { ...emptyQuote().lines, modules: 0.12 } });
  ok('a currency mismatch is reported', deriveIndices(a, c).sameCurrency === false); }

console.log('\n--- energy ---');
{ const e = energySeries({ kWp: 1000, specificYield: 1500, soilingPct: 0,
    availabilityPct: 100, degradationPct: 0, years: 3 });
  near('no losses, no degradation', e[0], 1500000);
  ok('flat without degradation', e[0] === e[2]);
  const d = energySeries({ kWp: 1000, specificYield: 1500, degradationPct: 1, years: 3 });
  /* Soiling and availability default to none, so year one is the gross
     figure — degradation only starts compounding from year two. */
  near('year 1 is undegraded', d[0], 1500000, 1e-6);
  near('year 3 has two years of degradation', d[2], d[0] * 0.99 * 0.99, 1e-6);
  const s = energySeries({ kWp: 1000, specificYield: 1500, soilingPct: 5,
    availabilityPct: 98, degradationPct: 0, years: 1 });
  near('soiling and availability multiply', s[0], 1500000 * 0.95 * 0.98, 1e-6); }

console.log('\n--- opex ---');
{ const o = opexSeries({ kWp: 1000, omPerKWpYr: 10, years: 3 });
  near('flat without inflation', o[0], 10000); ok('and stays flat', o[0] === o[2]);
  const i = opexSeries({ kWp: 1000, omPerKWpYr: 10, inflationPct: 3, years: 3 });
  near('inflation compounds from year 1', i[2], 10000 * 1.03 * 1.03, 1e-9);
  const r = opexSeries({ kWp: 1000, omPerKWpYr: 0, years: 15,
    inverterReplaceYear: 12, inverterReplacePerWp: 0.03 });
  near('the replacement lands in its year', r[11], 0.03 * 1e6, 1e-6);
  ok('and nowhere else', r[10] === 0 && r[12] === 0);
  const ins = opexSeries({ kWp: 1000, capex: 1000000, insurancePctCapex: 0.5, years: 1 });
  near('insurance is a share of capex', ins[0], 5000, 1e-9); }

console.log('\n--- LCOE ---');
{ /* One year, no opex: LCOE must be capex / discounted energy. */
  const r = lcoe({ capex: 1000, opex: [0], energy: [100], discountRate: 10 });
  near('single year, no opex', r.lcoe, 1000 / (100 / 1.1), 1e-9);
  /* Zero discount: LCOE is just total cost over total energy. */
  const z = lcoe({ capex: 1000, opex: [10, 10], energy: [100, 100], discountRate: 0 });
  near('undiscounted is total over total', z.lcoe, 1020 / 200, 1e-12);
  ok('no energy gives no LCOE rather than infinity',
    lcoe({ capex: 1000, opex: [0], energy: [0], discountRate: 5 }).lcoe === null);
  const share = lcoe({ capex: 900, opex: [100], energy: [100], discountRate: 0 });
  near('capex share is reported', share.capexShare, 0.9, 1e-12); }

console.log('\n--- NPV and IRR ---');
near('NPV of a flat stream', npv([-100, 110], 10), 0, 1e-12);
near('NPV index 0 is undiscounted', npv([100], 10), 100, 1e-12);
{ const r = irr([-100, 110]);
  near('IRR of -100 then 110 is 10%', r, 10, 1e-6);
  const r2 = irr([-1000, 400, 400, 400]);
  near('three-year IRR', npv([-1000, 400, 400, 400], r2), 0, 1e-6);
  ok('a never-positive flow has no IRR', irr([-100, -10, -10]) === null);
  ok('an all-positive flow has no IRR', irr([100, 10]) === null); }

console.log('\n--- the whole model ---');
{ const q = Q({ datePriced: '2026-06-01', currency: 'EUR', kWpBasis: 10000,
    lines: { ...emptyQuote().lines, modules: 0.10, structure: 0.07, inverters: 0.04,
      install: 0.06, substation: 800000 } });
  const r = evaluate({ quote: q, kWp: 10000, specificYield: 1100,
    region: regionById('de'), years: 25, omPerKWpYr: 12, asOf: new Date('2026-10-14') });
  ok('capex is the quote applied', Math.abs(r.capex.capex - (0.27 * 1e7 + 800000)) < 1e-6, r.capex.capex);
  ok('LCOE is positive and sane', r.lcoe > 0 && r.lcoe < 1, r.lcoe);
  ok('the region supplied the discount rate', r.rate === regionById('de').discountRate, r.rate);
  ok('and its soiling', r.soilingPct === regionById('de').soilingPct);
  ok('staleness travels with the result', r.staleness.id === 'fresh', r.staleness.id);
  ok('no tariff means no NPV', r.npv === null && r.irr === null && r.payback === null);
  const withT = evaluate({ quote: q, kWp: 10000, specificYield: 1100,
    region: regionById('de'), years: 25, omPerKWpYr: 12, tariff: 0.06 });
  ok('a tariff gives NPV, IRR and payback',
    withT.npv !== null && withT.irr !== null && withT.payback > 0,
    `${withT.npv?.toFixed(0)} / ${withT.irr?.toFixed(2)} / ${withT.payback?.toFixed(1)}`);
  /* A tariff exactly at LCOE must give NPV near zero — that is what
     LCOE means, and it is the strongest check on the whole chain. */
  const atLcoe = evaluate({ quote: q, kWp: 10000, specificYield: 1100,
    region: regionById('de'), years: 25, omPerKWpYr: 12, tariff: r.lcoe });
  ok('a tariff at LCOE gives NPV of about zero', Math.abs(atLcoe.npv) < 1,
    atLcoe.npv.toFixed(6));
  near('and an IRR equal to the discount rate', atLcoe.irr, r.rate, 1e-4); }

console.log('\n--- comparing quotes ---');
{ const base = { kWp: 10000, specificYield: 1500, years: 25, omPerKWpYr: 10,
    asOf: new Date('2026-10-14') };
  const mk = (over) => Q({ kWpBasis: 10000,
    lines: { ...emptyQuote().lines, modules: 0.10, install: 0.05 }, ...over });
  const c = compareQuotes([
    mk({ name: 'DE', regionId: 'de', currency: 'EUR', datePriced: '2026-08-01' }),
    mk({ name: 'KE', regionId: 'af-e', currency: 'USD', datePriced: '2024-01-01' }),
  ], base);
  ok('two rows, sorted by LCOE', c.rows.length === 2 && c.rows[0].lcoe <= c.rows[1].lcoe);
  ok('mixed currencies are warned about', c.warnings.some((w) => /currencies/.test(w)));
  ok('a wide vintage spread is warned about', c.warnings.some((w) => /months apart/.test(w)));
  ok('stale quotes are named', c.warnings.some((w) => /18 months old/.test(w) && /KE/.test(w)));
  const clean = compareQuotes([
    mk({ name: 'A', regionId: 'de', currency: 'EUR', datePriced: '2026-08-01' }),
    mk({ name: 'B', regionId: 'uk', currency: 'EUR', datePriced: '2026-09-01' }),
  ], base);
  ok('comparable quotes raise no warnings', clean.warnings.length === 0,
    JSON.stringify(clean.warnings)); }

console.log('\n--- CSV round trip ---');
{ const qs = [
    Q({ name: 'Quote, with comma', project: 'P1', country: 'Kenya', regionId: 'af-e',
      datePriced: '2026-03-04', currency: 'USD', kWpBasis: 7500, notes: 'says "ex works"',
      lines: { ...emptyQuote().lines, modules: 0.093, substation: 412000 } }),
    Q({ name: 'B', regionId: 'uk', datePriced: '2025-11-30', currency: 'GBP', kWpBasis: 4000,
      lines: { ...emptyQuote().lines, install: 0.0712 } }),
  ];
  const csv = quotesToCsv(qs);
  const back = quotesFromCsv(csv);
  ok('both quotes come back', back.quotes.length === 2, back.quotes.length);
  ok('a comma inside a field survives', back.quotes[0].name === 'Quote, with comma', back.quotes[0].name);
  ok('an embedded quote mark survives', back.quotes[0].notes === 'says "ex works"', back.quotes[0].notes);
  near('a per-Wp figure survives to full precision', back.quotes[0].lines.modules, 0.093, 1e-12);
  near('a lump survives', back.quotes[0].lines.substation, 412000, 1e-9);
  ok('the date survives', back.quotes[0].datePriced === '2026-03-04');
  ok('the region survives', back.quotes[1].regionId === 'uk');
  ok('no warnings on a clean file', back.warnings.length === 0, JSON.stringify(back.warnings)); }
{ let threw = null;
  try { quotesFromCsv('name,modules\nA,0.1'); } catch (e) { threw = e.message; }
  ok('a file with no date column is refused', /datePriced/.test(threw || ''), threw);
  try { quotesFromCsv(''); } catch (e) { threw = e.message; }
  ok('an empty file is refused', /header row/.test(threw || ''), threw);
  const bad = quotesFromCsv('name,datePriced,modules\nA,04/03/2026,0.1');
  ok('a non-ISO date is warned about, not silently accepted',
    bad.warnings.some((w) => /not an ISO date/.test(w)), JSON.stringify(bad.warnings)); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
