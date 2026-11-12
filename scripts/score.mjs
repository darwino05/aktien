// Score-Berechnung für den Aktien-Radar.
// Reine Funktionen ohne Netzwerkzugriff – testbar mit `node --test`.

export const AREAS = [
  { key: 'bewertung', label: 'Bewertung' },
  { key: 'wachstum', label: 'Wachstum' },
  { key: 'qualitaet', label: 'Qualität' },
  { key: 'bilanz', label: 'Bilanz' },
  { key: 'analysten', label: 'Analysten' },
];

export const RATING_BUY = 70;
export const RATING_WATCH = 50;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Erster vorhandener Zahlenwert aus mehreren möglichen Feldnamen. */
export function pick(obj, ...keys) {
  if (!obj) return null;
  for (const k of keys) {
    const v = num(obj[k]);
    if (v !== null) return v;
  }
  return null;
}

/** Linear: Wert `zero` → 0 Punkte, Wert `full` → `max` Punkte, dazwischen linear, außerhalb gekappt. */
export function lin(v, zero, full, max) {
  if (num(v) === null) return null;
  const t = (v - zero) / (full - zero);
  return Math.min(1, Math.max(0, t)) * max;
}

const round1 = (x) => Math.round(x * 10) / 10;

/**
 * Rohdaten von Finnhub in die gespeicherten Fundamentaldaten übersetzen.
 * Mehrere Feldnamen je Kennzahl, weil Finnhub je nach Aktie unterschiedliche Felder füllt.
 */
export function extractFundamentals({ quote, metric, profile, recommendation, priceTarget }) {
  const m = metric?.metric ?? {};
  const price = num(quote?.c);

  // Gewinnwachstum "pro Jahr": 3-Jahres-CAGR bevorzugt (robuster als TTM), sonst TTM, sonst 5 Jahre.
  const epsGrowth = pick(m, 'epsGrowth3Y', 'epsGrowthTTMYoy', 'epsGrowth5Y');
  const revenueGrowth = pick(m, 'revenueGrowth3Y', 'revenueGrowthTTMYoy', 'revenueGrowth5Y');

  // Nettoverschuldung / EBITDA: Finnhub liefert das nicht direkt.
  // Nettoverschuldung ≈ Enterprise Value − Marktkapitalisierung (beides in Mio.),
  // EBITDA = EBITDA je Aktie (TTM) × Aktienanzahl (Mio., aus profile2).
  const ev = pick(m, 'enterpriseValue');
  const mcap = pick(m, 'marketCapitalization') ?? pick(profile, 'marketCapitalization');
  const shares = pick(profile, 'shareOutstanding');
  const ebitdaPS = pick(m, 'ebitdPerShareTTM', 'ebitdPerShareAnnual');
  let netDebt = null;
  let ebitda = null;
  if (ev !== null && mcap !== null) netDebt = ev - mcap;
  if (ebitdaPS !== null && shares !== null) ebitda = ebitdaPS * shares;

  // Empfehlungen: neuester Monat steht vorne.
  const rec = Array.isArray(recommendation) && recommendation.length
    ? [...recommendation].sort((a, b) => String(b.period).localeCompare(String(a.period)))[0]
    : null;

  return {
    priceAtFundamentals: price,
    eps: pick(m, 'epsTTM', 'epsExclExtraItemsTTM', 'epsBasicExclExtraItemsTTM', 'epsInclExtraItemsTTM'),
    peMetric: pick(m, 'peTTM', 'peExclExtraTTM', 'peBasicExclExtraTTM', 'peNormalizedAnnual', 'peAnnual'),
    pfcf: pick(m, 'pfcfShareTTM', 'pfcfShareAnnual'),
    epsGrowth,
    revenueGrowth,
    netMargin: pick(m, 'netProfitMarginTTM', 'netProfitMarginAnnual'),
    roe: pick(m, 'roeTTM', 'roeRfy', 'roeAnnual'),
    netDebt,
    ebitda,
    debtEquity: pick(m, 'totalDebt/totalEquityQuarterly', 'totalDebt/totalEquityAnnual'),
    recommendation: rec
      ? {
          period: rec.period ?? null,
          strongBuy: num(rec.strongBuy) ?? 0,
          buy: num(rec.buy) ?? 0,
          hold: num(rec.hold) ?? 0,
          sell: num(rec.sell) ?? 0,
          strongSell: num(rec.strongSell) ?? 0,
        }
      : null,
    targetMean: pick(priceTarget, 'targetMean', 'targetMedian'),
  };
}

/** Zwei Teilkennzahlen (je 0–10) zu einem Bereich (0–20). Fehlt eine, zählt die andere doppelt. */
function combine(a, b) {
  if (a === null && b === null) return { points: 10, missing: true };
  if (a === null) return { points: b * 2, missing: false };
  if (b === null) return { points: a * 2, missing: false };
  return { points: a + b, missing: false };
}

const de = (v, digits = 1) =>
  v === null ? '–' : v.toLocaleString('de-DE', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const pct = (v) => (v === null ? '–' : `${de(v)} %`);

/**
 * Score aus Fundamentaldaten + aktuellem Kurs.
 * Kursabhängige Größen (KGV, FCF-Rendite, Kursziel-Abstand) werden mit dem aktuellen Kurs neu gerechnet,
 * damit der Score auch bei den 2-stündlichen Kurs-Updates stimmt.
 */
export function scoreStock(f, price) {
  price = num(price);
  const ratio = price !== null && f.priceAtFundamentals ? price / f.priceAtFundamentals : 1;

  // --- abgeleitete Kennzahlen ---
  let pe = null;
  if (price !== null && f.eps !== null && f.eps !== undefined) pe = f.eps > 0 ? price / f.eps : -1;
  else if (f.peMetric !== null && f.peMetric !== undefined) pe = f.peMetric * ratio;

  let peg = null;
  if (pe !== null && pe > 0 && f.epsGrowth !== null && f.epsGrowth > 0) peg = pe / f.epsGrowth;

  let fcfYield = null;
  if (f.pfcf !== null && f.pfcf !== undefined && f.pfcf !== 0) fcfYield = 100 / (f.pfcf * ratio);

  let netDebtEbitda = null;
  if (f.netDebt !== null && f.ebitda !== null && f.ebitda > 0) netDebtEbitda = f.netDebt / f.ebitda;

  const r = f.recommendation;
  const recTotal = r ? r.strongBuy + r.buy + r.hold + r.sell + r.strongSell : 0;
  const buyShare = recTotal > 0 ? ((r.strongBuy + r.buy) / recTotal) * 100 : null;
  const upside = f.targetMean && price ? (f.targetMean / price - 1) * 100 : null;

  // --- 1 Bewertung ---
  let pegPts = null;
  let pegNote = '';
  if (pe !== null && pe <= 0) { pegPts = 0; pegNote = 'Verlust'; }
  else if (pe !== null && f.epsGrowth !== null && f.epsGrowth <= 0) { pegPts = 0; pegNote = 'kein Gewinnwachstum'; }
  else pegPts = lin(peg, 3, 1, 10); // PEG ≤ 1 → 10, ≥ 3 → 0
  const fcfPts = lin(fcfYield, 0, 8, 10); // ≥ 8 % → 10, ≤ 0 → 0
  const bewertung = combine(pegPts, fcfPts);
  bewertung.parts = [
    { label: 'KGV', value: pe === null ? '–' : pe <= 0 ? 'negativ' : de(pe) },
    { label: 'PEG', value: pegNote || de(peg, 2), points: pegPts, max: 10 },
    { label: 'FCF-Rendite', value: pct(fcfYield), points: fcfPts, max: 10 },
  ];

  // --- 2 Wachstum ---
  const revPts = lin(f.revenueGrowth, 0, 20, 10); // ≥ 20 % p.a. → 10
  const epsPts = lin(f.epsGrowth, 0, 25, 10); // ≥ 25 % p.a. → 10
  const wachstum = combine(revPts, epsPts);
  wachstum.parts = [
    { label: 'Umsatz p.a.', value: pct(f.revenueGrowth), points: revPts, max: 10 },
    { label: 'Gewinn p.a.', value: pct(f.epsGrowth), points: epsPts, max: 10 },
  ];

  // --- 3 Qualität ---
  const marginPts = lin(f.netMargin, 0, 25, 10);
  const roePts = lin(f.roe, 0, 25, 10);
  const qualitaet = combine(marginPts, roePts);
  qualitaet.parts = [
    { label: 'Nettomarge', value: pct(f.netMargin), points: marginPts, max: 10 },
    { label: 'Eigenkapitalrendite', value: pct(f.roe), points: roePts, max: 10 },
  ];

  // --- 4 Bilanz ---
  let bilanz;
  if (netDebtEbitda !== null) {
    const p = lin(netDebtEbitda, 4, 0, 20); // Nettocash (≤ 0) → 20, ≥ 4 → 0
    bilanz = { points: p, missing: false, parts: [
      { label: 'Nettoverschuldung/EBITDA', value: netDebtEbitda <= 0 ? `${de(netDebtEbitda)} (Nettocash)` : de(netDebtEbitda), points: p, max: 20 },
    ] };
  } else if (f.ebitda !== null && f.ebitda <= 0) {
    bilanz = { points: 0, missing: false, parts: [
      { label: 'Nettoverschuldung/EBITDA', value: 'EBITDA negativ', points: 0, max: 20 },
    ] };
  } else if (f.debtEquity !== null && f.debtEquity !== undefined) {
    const p = lin(f.debtEquity, 2, 0.3, 20); // Ersatz: Verschuldungsgrad
    bilanz = { points: p, missing: false, parts: [
      { label: 'Schulden/Eigenkapital (Ersatz)', value: de(f.debtEquity, 2), points: p, max: 20 },
    ] };
  } else {
    bilanz = { points: 10, missing: true, parts: [{ label: 'Nettoverschuldung/EBITDA', value: '–' }] };
  }

  // --- 5 Analysten ---
  const buyPts = lin(buyShare, 20, 80, 10); // ≥ 80 % Kauf → 10, ≤ 20 % → 0
  const upPts = lin(upside, -10, 30, 10); // ≥ +30 % → 10, ≤ −10 % → 0
  const analysten = combine(buyPts, upPts);
  analysten.parts = [
    { label: 'Kaufempfehlungen', value: buyShare === null ? '–' : `${de(buyShare, 0)} % von ${recTotal}`, points: buyPts, max: 10 },
  ];
  if (f.targetMean) analysten.parts.push({ label: 'Abstand Kursziel', value: `${upside >= 0 ? '+' : ''}${pct(upside)}`, points: upPts, max: 10 });

  const byKey = { bewertung, wachstum, qualitaet, bilanz, analysten };
  const areas = AREAS.map(({ key, label }) => {
    const a = byKey[key];
    return {
      key,
      label,
      points: round1(a.points),
      missing: a.missing,
      parts: a.parts.map((p) => ({ ...p, points: p.points === undefined || p.points === null ? null : round1(p.points) })),
    };
  });

  const score = Math.round(areas.reduce((s, a) => s + a.points, 0));
  const rating = score >= RATING_BUY ? 'Kaufkandidat' : score >= RATING_WATCH ? 'Beobachten' : 'Meiden';

  return {
    score,
    rating,
    areas,
    summary: buildSummary(areas, { pe, upside }),
    metrics: { pe, peg, fcfYield, netDebtEbitda, buyShare, upside },
  };
}

function joinDe(list) {
  if (list.length <= 1) return list.join('');
  return `${list.slice(0, -1).join(', ')} und ${list[list.length - 1]}`;
}

function buildSummary(areas, { pe, upside }) {
  const known = areas.filter((a) => !a.missing);
  const strong = known.filter((a) => a.points >= 15).map((a) => a.label);
  const weak = known.filter((a) => a.points <= 7).map((a) => a.label);
  const missing = areas.filter((a) => a.missing).map((a) => a.label);

  const out = [];
  if (strong.length) out.push(`Stark bei ${joinDe(strong)}.`);
  if (weak.length) out.push(`Schwach bei ${joinDe(weak)}.`);
  if (!strong.length && !weak.length && known.length) out.push('Ausgewogenes Profil ohne klare Stärken oder Schwächen.');
  if (pe !== null && pe <= 0) out.push('Das Unternehmen schreibt derzeit Verluste.');
  if (upside !== null && upside < 0) out.push('Der Kurs liegt über dem mittleren Analysten-Kursziel.');
  if (missing.length) out.push(`Keine Daten für ${joinDe(missing)} – neutral mit 10 Punkten bewertet.`);
  return out.join(' ');
}
