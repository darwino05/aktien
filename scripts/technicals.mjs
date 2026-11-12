// Technische Analyse und Kaufplan.
// Reine Funktionen ohne Netzwerkzugriff – testbar mit `node --test`.

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const r2 = (x) => (x === null ? null : Math.round(x * 100) / 100);
const r1 = (x) => (x === null ? null : Math.round(x * 10) / 10);

export function sma(values, n) {
  if (values.length < n) return null;
  let s = 0;
  for (let i = values.length - n; i < values.length; i++) s += values[i];
  return s / n;
}

function emaSeries(values, n) {
  const k = 2 / (n + 1);
  const out = [];
  let prev = null;
  for (let i = 0; i < values.length; i++) {
    if (i < n - 1) { out.push(null); continue; }
    if (prev === null) prev = values.slice(0, n).reduce((a, b) => a + b, 0) / n;
    else prev = values[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

/** RSI nach Wilder. */
export function rsi(closes, n = 14) {
  if (closes.length <= n) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= n; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gain += d; else loss -= d;
  }
  gain /= n; loss /= n;
  for (let i = n + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (n - 1) + Math.max(d, 0)) / n;
    loss = (loss * (n - 1) + Math.max(-d, 0)) / n;
  }
  if (loss === 0) return 100;
  return 100 - 100 / (1 + gain / loss);
}

/** Average True Range nach Wilder. */
export function atr(high, low, close, n = 14) {
  if (close.length <= n) return null;
  const tr = [];
  for (let i = 1; i < close.length; i++) {
    tr.push(Math.max(high[i] - low[i], Math.abs(high[i] - close[i - 1]), Math.abs(low[i] - close[i - 1])));
  }
  let a = tr.slice(0, n).reduce((x, y) => x + y, 0) / n;
  for (let i = n; i < tr.length; i++) a = (a * (n - 1) + tr[i]) / n;
  return a;
}

/** MACD-Histogramm (12/26/9): > 0 = Momentum steigt. */
export function macdHist(closes) {
  if (closes.length < 35) return null;
  const e12 = emaSeries(closes, 12), e26 = emaSeries(closes, 26);
  const macd = closes.map((_, i) => (e12[i] !== null && e26[i] !== null ? e12[i] - e26[i] : null)).filter((x) => x !== null);
  const signal = emaSeries(macd, 9);
  return macd.at(-1) - signal.at(-1);
}

/** Lokale Tiefs/Hochs (Pivot ± w Tage) der letzten `lookback` Tage, nahe Level zusammengefasst. */
export function pivots(values, kind, lookback = 130, w = 5) {
  const start = Math.max(w, values.length - lookback);
  const found = [];
  for (let i = start; i < values.length - w; i++) {
    let ok = true;
    for (let j = i - w; j <= i + w && ok; j++) {
      if (j === i) continue;
      if (kind === 'low' ? values[j] < values[i] : values[j] > values[i]) ok = false;
    }
    if (ok) found.push(values[i]);
  }
  // Level, die weniger als 1,5 % auseinander liegen, zusammenfassen
  found.sort((a, b) => a - b);
  const merged = [];
  for (const v of found) {
    const last = merged.at(-1);
    if (last && Math.abs(v - last.v) / last.v < 0.015) { last.v = (last.v * last.n + v) / (last.n + 1); last.n++; }
    else merged.push({ v, n: 1 });
  }
  return merged.map((m) => m.v);
}

/**
 * Kennzahlen aus Tageskerzen { t:[sek], o, h, l, c, v }.
 * Gibt null zurück, wenn zu wenig Historie vorhanden ist.
 */
export function computeTechnicals(candles) {
  if (!candles || !Array.isArray(candles.c)) return null;
  // Lücken (null) entfernen
  const rows = candles.c
    .map((c, i) => ({ t: candles.t[i], h: num(candles.h[i]), l: num(candles.l[i]), c: num(c), v: num(candles.v?.[i]) }))
    .filter((x) => x.c !== null && x.h !== null && x.l !== null);
  if (rows.length < 60) return null;
  const c = rows.map((x) => x.c), h = rows.map((x) => x.h), l = rows.map((x) => x.l);
  const last = c.at(-1);
  const yr = rows.slice(-252);

  const back = (n) => (c.length > n ? (last / c[c.length - 1 - n] - 1) * 100 : null);
  const thisYear = new Date(rows.at(-1).t * 1000).getUTCFullYear();
  const firstOfYear = rows.findIndex((x) => new Date(x.t * 1000).getUTCFullYear() === thisYear);
  const ytdBase = firstOfYear > 0 ? c[firstOfYear - 1] : c[firstOfYear];

  const rets = [];
  for (let i = Math.max(1, c.length - 252); i < c.length; i++) rets.push(Math.log(c[i] / c[i - 1]));
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const vol = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1)) * Math.sqrt(252) * 100;

  let peak = -Infinity, maxDD = 0;
  for (const x of yr) { peak = Math.max(peak, x.c); maxDD = Math.min(maxDD, (x.c / peak - 1) * 100); }

  const vols = rows.slice(-20).map((x) => x.v).filter((x) => x !== null);
  const avgVol20 = vols.length ? vols.reduce((a, b) => a + b, 0) / vols.length : null;

  return {
    lastClose: r2(last),
    lastDate: new Date(rows.at(-1).t * 1000).toISOString().slice(0, 10),
    sma20: r2(sma(c, 20)),
    sma50: r2(sma(c, 50)),
    sma200: r2(sma(c, 200)),
    rsi: r1(rsi(c)),
    atr: r2(atr(h, l, c)),
    macdHist: r2(macdHist(c)),
    high52: r2(Math.max(...yr.map((x) => x.h))),
    low52: r2(Math.min(...yr.map((x) => x.l))),
    supports: pivots(l, 'low').map(r2),
    resistances: pivots(h, 'high').map(r2),
    perf: { w1: r1(back(5)), m1: r1(back(21)), m3: r1(back(63)), m6: r1(back(126)), y1: r1(back(252)), ytd: r1(ytdBase ? (last / ytdBase - 1) * 100 : null) },
    volatility: r1(vol),
    maxDrawdown: r1(maxDD),
    avgVolume20: avgVol20 === null ? null : Math.round(avgVol20),
    // Für Sparklines: letzte ~260 Schlusskurse
    closes: c.slice(-260).map(r2),
    dates: rows.slice(-260).map((x) => new Date(x.t * 1000).toISOString().slice(0, 10)),
    // 200-Tage-Linie für den Chart (über die volle Historie gerechnet, letzte 260 Werte)
    sma200Series: c.map((_, i) => (i >= 199 ? r2(sma(c.slice(0, i + 1), 200)) : null)).slice(-260),
    sma50Series: c.map((_, i) => (i >= 49 ? r2(sma(c.slice(0, i + 1), 50)) : null)).slice(-260),
  };
}

export function trendOf(price, t) {
  if (!t || t.sma50 === null || t.sma200 === null) return { code: 'unbekannt', label: 'unbekannt' };
  if (price > t.sma200 && t.sma50 > t.sma200) return { code: 'auf', label: 'Aufwärtstrend' };
  if (price < t.sma200 && t.sma50 < t.sma200) return { code: 'ab', label: 'Abwärtstrend' };
  return { code: 'seit', label: 'Seitwärts / unentschieden' };
}

const DAY = 86400000;
const isoDay = (d) => new Date(d).toISOString().slice(0, 10);

/**
 * Kaufplan: Kaufzone, Limit, Stop-Loss, Ziele, CRV, Gültigkeit und Signal.
 * Regelbasiert aus Score (Fundamentaldaten) + Technik (Timing). Keine Prognose.
 */
export function buildPlan({ price, tech, score, earnings, targetMean, now = Date.now() }) {
  price = num(price);
  if (price === null || !tech || !tech.atr) return null;
  const a = tech.atr;
  const trend = trendOf(price, tech);

  // --- Kaufzone: höchste Unterstützung (gleitende Durchschnitte, Pivot-Tiefs) unter dem Kurs, max. 15 % entfernt
  const cands = [tech.sma20, tech.sma50, tech.sma200, ...(tech.supports || [])]
    .filter((x) => num(x) !== null && x < price && x >= price * 0.85)
    .sort((x, y) => y - x);
  let zoneTop = cands.length ? cands[0] : price - 0.5 * a;
  // Liegt die nächste Unterstützung zu nah (< 0,3 ATR), zählt der aktuelle Kurs schon als Zone
  if (price - zoneTop < 0.3 * a) zoneTop = price;
  const zoneBottom = zoneTop - a;
  const limit = (zoneTop + zoneBottom) / 2;

  // --- Stop-Loss: unter der nächsten Unterstützung unterhalb der Zone, sonst 1,5 ATR unter der Zone
  const below = [tech.sma50, tech.sma200, ...(tech.supports || [])]
    .filter((x) => num(x) !== null && x < zoneBottom && x > zoneBottom - 3 * a)
    .sort((x, y) => y - x);
  let stop = below.length ? below[0] - 0.5 * a : zoneBottom - 1.5 * a;
  stop = Math.max(stop, limit * 0.8);
  const risk = limit - stop;

  // --- Ziele: nächster Widerstand mit mind. 1,5 R Abstand, sonst 2 R; Ziel 2 = 3 R oder Analystenziel
  const res = [...(tech.resistances || []), tech.high52]
    .filter((x) => num(x) !== null && x >= limit + 1.5 * risk)
    .sort((x, y) => x - y);
  const target1 = res.length ? res[0] : limit + 2 * risk;
  const target2 = Math.max(limit + 3 * risk, target1 * 1.05, num(targetMean) ?? 0);
  const crv = (target1 - limit) / risk;

  // --- Quartalszahlen
  const eDate = earnings?.date ? Date.parse(earnings.date + 'T00:00:00Z') : null;
  const today = Date.parse(isoDay(now) + 'T00:00:00Z');
  const daysToEarnings = eDate !== null ? Math.round((eDate - today) / DAY) : null;

  // --- Gültigkeit des Limits: 4 Wochen, aber spätestens 1 Tag vor den Quartalszahlen
  let validUntil = today + 28 * DAY;
  if (daysToEarnings !== null && daysToEarnings > 3) validUntil = Math.min(validUntil, eDate - DAY);

  const inZone = price <= zoneTop + 0.25 * a;
  const distToZone = ((zoneTop / price) - 1) * 100;

  // --- Signal
  const reasons = [];
  let code;
  if (score < 50) {
    code = 'meiden';
    reasons.push(`Score ${score} unter 50 – fundamental nicht überzeugend.`);
  } else if (daysToEarnings !== null && daysToEarnings >= 0 && daysToEarnings <= 3) {
    code = 'warten';
    reasons.push(`Quartalszahlen ${daysToEarnings === 0 ? 'heute' : `in ${daysToEarnings} Tag${daysToEarnings === 1 ? '' : 'en'}`} – Kurssprünge möglich, erst danach entscheiden.`);
  } else if (tech.rsi !== null && tech.rsi > 70) {
    code = 'warten';
    reasons.push(`Kurzfristig überkauft (RSI ${tech.rsi.toLocaleString('de-DE')}) – Rücksetzer abwarten.`);
  } else if (trend.code === 'ab' && score < 70) {
    code = 'warten';
    reasons.push('Abwärtstrend (Kurs und 50-Tage-Linie unter der 200-Tage-Linie) – erst Stabilisierung abwarten.');
  } else if (score >= 70 && inZone && trend.code !== 'ab') {
    code = 'kaufen';
    reasons.push('Fundamental stark und Kurs in der Kaufzone.');
  } else if (score >= 70) {
    code = 'limit';
    reasons.push(trend.code === 'ab'
      ? 'Fundamental stark, aber im Abwärtstrend – nur mit Limit tiefer einsteigen.'
      : `Fundamental stark, Kurs ${Math.abs(distToZone).toLocaleString('de-DE', { maximumFractionDigits: 1 })} % über der Kaufzone – Limit setzen statt hinterherlaufen.`);
  } else {
    code = 'beobachten';
    reasons.push(`Score ${score}: solide, aber kein klarer Kaufkandidat – nur bei Rücksetzer in die Zone interessant.`);
  }

  if (crv < 1.5 && (code === 'kaufen' || code === 'limit')) reasons.push(`Chance/Risiko nur ${crv.toLocaleString('de-DE', { maximumFractionDigits: 1 })} – Position klein halten.`);
  if (trend.code === 'auf' && code !== 'meiden') reasons.push('Intakter Aufwärtstrend (über 50- und 200-Tage-Linie).');
  if (tech.macdHist !== null) reasons.push(tech.macdHist > 0 ? 'Momentum (MACD) dreht nach oben.' : 'Momentum (MACD) noch schwach.');
  if (daysToEarnings !== null && daysToEarnings > 3 && daysToEarnings <= 14) reasons.push(`Quartalszahlen am ${new Date(eDate).toLocaleDateString('de-DE')} – Limit läuft vorher aus.`);

  const labels = { kaufen: 'Jetzt kaufen', limit: 'Limit setzen', beobachten: 'Beobachten', warten: 'Abwarten', meiden: 'Nicht kaufen' };
  // Priorität für die Sortierung "beste Chancen"
  const priority = Math.round(score + Math.min(crv, 4) * 5 + (code === 'kaufen' ? 20 : code === 'limit' ? 10 : 0) - (trend.code === 'ab' ? 10 : 0));

  return {
    trend,
    zoneTop: r2(zoneTop),
    zoneBottom: r2(zoneBottom),
    limit: r2(limit),
    stop: r2(stop),
    target1: r2(target1),
    target2: r2(target2),
    crv: r1(crv),
    riskPct: r1((risk / limit) * 100),
    upsidePct: r1((target1 / limit - 1) * 100),
    distToZonePct: r1(distToZone),
    inZone,
    validUntil: code === 'meiden' ? null : isoDay(validUntil),
    daysToEarnings,
    signal: { code, label: labels[code], reasons },
    priority,
  };
}
