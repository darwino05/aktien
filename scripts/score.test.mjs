import test from 'node:test';
import assert from 'node:assert/strict';
import { lin, extractFundamentals, scoreStock } from './score.mjs';

const base = {
  priceAtFundamentals: 100,
  eps: 5, // KGV 20
  peMetric: 20,
  pfcf: 25, // FCF-Rendite 4 %
  epsGrowth: 20, // PEG 1
  revenueGrowth: 10,
  netMargin: 25,
  roe: 25,
  netDebt: 0,
  ebitda: 1000,
  debtEquity: 0.5,
  recommendation: { period: '2026-11-01', strongBuy: 4, buy: 4, hold: 2, sell: 0, strongSell: 0 },
  targetMean: 130,
};

test('lin kappt und interpoliert, auch absteigend', () => {
  assert.equal(lin(5, 0, 10, 10), 5);
  assert.equal(lin(-3, 0, 10, 10), 0);
  assert.equal(lin(99, 0, 10, 10), 10);
  assert.equal(lin(2, 3, 1, 10), 5);
  assert.equal(lin(null, 0, 1, 10), null);
});

test('Beispielaktie: Bereichspunkte und Gesamtscore', () => {
  const r = scoreStock(base, 100);
  const pts = Object.fromEntries(r.areas.map((a) => [a.key, a.points]));
  assert.deepEqual(pts, { bewertung: 15, wachstum: 13, qualitaet: 20, bilanz: 20, analysten: 20 });
  assert.equal(r.score, 88);
  assert.equal(r.rating, 'Kaufkandidat');
  assert.match(r.summary, /Stark bei Bewertung, Qualität, Bilanz und Analysten/);
});

test('Kurs-Update rechnet KGV und Kursziel-Abstand neu', () => {
  const r = scoreStock(base, 200);
  assert.equal(r.metrics.pe, 40);
  assert.equal(r.metrics.peg, 2);
  assert.equal(r.metrics.fcfYield, 2);
  assert.ok(r.metrics.upside < 0);
  assert.ok(r.score < 88);
});

test('Verlust → 0 Punkte PEG, Hinweis in Begründung', () => {
  const r = scoreStock({ ...base, eps: -2 }, 100);
  assert.equal(r.areas[0].parts[1].points, 0);
  assert.match(r.summary, /Verluste/);
});

test('Fehlende Daten → neutral 10 Punkte; fehlendes Kursziel → Empfehlungen zählen doppelt', () => {
  const r = scoreStock({ ...base, revenueGrowth: null, epsGrowth: null, targetMean: null }, 100);
  const w = r.areas.find((a) => a.key === 'wachstum');
  assert.equal(w.points, 10);
  assert.equal(w.missing, true);
  const a = r.areas.find((x) => x.key === 'analysten');
  assert.equal(a.points, 20); // 80 % Kauf → 10, doppelt
  assert.equal(a.parts.length, 1);
});

test('Einstufungsgrenzen', () => {
  const weak = { ...base, epsGrowth: -5, revenueGrowth: -5, netMargin: 2, roe: 3, netDebt: 5000, pfcf: -10,
    recommendation: { strongBuy: 0, buy: 1, hold: 5, sell: 4, strongSell: 0 }, targetMean: 90 };
  assert.equal(scoreStock(weak, 100).rating, 'Meiden');
});

test('extractFundamentals liest Finnhub-Felder', () => {
  const f = extractFundamentals({
    quote: { c: 50 },
    metric: { metric: { epsTTM: 2, peTTM: 25, pfcfShareTTM: 20, epsGrowth3Y: 12, revenueGrowthTTMYoy: 8,
      netProfitMarginTTM: 15, roeTTM: 18, enterpriseValue: 1200, marketCapitalization: 1000, ebitdPerShareTTM: 4 } },
    profile: { shareOutstanding: 25 },
    recommendation: [
      { period: '2026-10-01', strongBuy: 1, buy: 1, hold: 1, sell: 0, strongSell: 0 },
      { period: '2026-11-01', strongBuy: 2, buy: 3, hold: 1, sell: 0, strongSell: 0 },
    ],
    priceTarget: null,
  });
  assert.equal(f.netDebt, 200);
  assert.equal(f.ebitda, 100);
  assert.equal(f.recommendation.period, '2026-11-01');
  assert.equal(f.revenueGrowth, 8);
  assert.equal(scoreStock(f, 50).metrics.netDebtEbitda, 2);
});
