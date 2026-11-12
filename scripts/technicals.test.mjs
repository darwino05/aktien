import test from 'node:test';
import assert from 'node:assert/strict';
import { sma, rsi, atr, pivots, computeTechnicals, buildPlan, trendOf } from './technicals.mjs';

// Synthetische Kerzen: sanfter Aufwärtstrend mit Wellen
function candles(n = 300, drift = 0.1, start = 100) {
  const t = [], o = [], h = [], l = [], c = [], v = [];
  const t0 = Date.parse('2025-01-02T00:00:00Z') / 1000;
  for (let i = 0; i < n; i++) {
    const p = start + i * drift + Math.sin(i / 6) * 4;
    t.push(t0 + i * 86400); o.push(p); c.push(p); h.push(p + 1); l.push(p - 1); v.push(1e6);
  }
  return { t, o, h, l, c, v };
}

test('SMA, RSI, ATR Grundfälle', () => {
  assert.equal(sma([1, 2, 3, 4], 2), 3.5);
  assert.equal(sma([1], 2), null);
  const up = Array.from({ length: 30 }, (_, i) => i + 1);
  assert.equal(rsi(up), 100);
  const flat = Array.from({ length: 30 }, () => 10);
  assert.equal(atr(flat.map((x) => x + 1), flat.map((x) => x - 1), flat), 2);
});

test('Pivots finden Wellentäler und fassen nahe Level zusammen', () => {
  const vals = Array.from({ length: 140 }, (_, i) => 100 + Math.sin(i / 6) * 10);
  const lows = pivots(vals, 'low');
  assert.ok(lows.length >= 1);
  assert.ok(lows.every((x) => x < 92));
});

test('computeTechnicals liefert Kennzahlen und Sparkline', () => {
  const t = computeTechnicals(candles());
  assert.ok(t.sma200 < t.sma50);
  assert.equal(t.closes.length, 260);
  assert.ok(t.atr > 0);
  assert.ok(t.high52 > t.low52);
  assert.equal(computeTechnicals({ t: [1], h: [1], l: [1], c: [1] }), null);
});

test('Aufwärtstrend + starker Score + Kurs an Unterstützung → kaufen', () => {
  const tech = { sma20: 99.5, sma50: 95, sma200: 85, rsi: 52, atr: 2, macdHist: 0.3, high52: 115, supports: [92], resistances: [110], };
  const p = buildPlan({ price: 100, tech, score: 80, earnings: null, now: Date.parse('2026-11-12') });
  assert.equal(p.trend.code, 'auf');
  assert.equal(p.signal.code, 'kaufen');
  assert.equal(p.zoneTop, 100); // Unterstützung 0,25 ATR entfernt → Kurs ist Zone
  assert.ok(p.stop < p.zoneBottom);
  assert.ok(p.target1 > p.limit);
  assert.equal(p.validUntil, '2026-12-10');
});

test('Kurs weit über Zone → Limit; Gültigkeit endet vor Quartalszahlen', () => {
  const tech = { sma20: 95, sma50: 90, sma200: 80, rsi: 60, atr: 2, macdHist: 0.1, high52: 120, supports: [], resistances: [] };
  const p = buildPlan({ price: 100, tech, score: 75, earnings: { date: '2026-11-20' }, now: Date.parse('2026-11-12') });
  assert.equal(p.signal.code, 'limit');
  assert.equal(p.zoneTop, 95);
  assert.equal(p.validUntil, '2026-11-19');
});

test('Quartalszahlen in 2 Tagen → abwarten; überkauft → abwarten; Score < 50 → meiden', () => {
  const tech = { sma20: 99, sma50: 95, sma200: 85, rsi: 55, atr: 2, macdHist: 0.1, high52: 115, supports: [], resistances: [] };
  const now = Date.parse('2026-11-12');
  assert.equal(buildPlan({ price: 100, tech, score: 80, earnings: { date: '2026-11-14' }, now }).signal.code, 'warten');
  assert.equal(buildPlan({ price: 100, tech: { ...tech, rsi: 75 }, score: 80, now }).signal.code, 'warten');
  const m = buildPlan({ price: 100, tech, score: 40, now });
  assert.equal(m.signal.code, 'meiden');
  assert.equal(m.validUntil, null);
});

test('Trend-Erkennung', () => {
  assert.equal(trendOf(50, { sma50: 60, sma200: 70 }).code, 'ab');
  assert.equal(trendOf(75, { sma50: 60, sma200: 70 }).code, 'seit');
  assert.equal(trendOf(65, null).code, 'unbekannt');
});
