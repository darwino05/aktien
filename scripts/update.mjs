// Holt Daten (Finnhub, Yahoo Finance, EZB-Kurse) und schreibt data.json + history.json.
//
//   FINNHUB_API_KEY=... node scripts/update.mjs full     # alles
//   FINNHUB_API_KEY=... node scripts/update.mjs quotes   # nur Kurse; Score und Kaufplan werden neu gerechnet
//
// Keine Abhängigkeiten, benötigt Node ≥ 18 (globales fetch).

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { extractFundamentals, scoreStock } from './score.mjs';
import { computeTechnicals, buildPlan } from './technicals.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_FILE = path.join(ROOT, 'data.json');
const HISTORY_FILE = path.join(ROOT, 'history.json');
const WATCHLIST_FILE = path.join(ROOT, 'watchlist.txt');
const FINNHUB = 'https://finnhub.io/api/v1';
const MIN_INTERVAL_MS = 1100; // < 60 Aufrufe/Minute (Finnhub Gratis-Tarif)
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';

const KEY = process.env.FINNHUB_API_KEY;
const MODE = process.argv[2] === 'quotes' ? 'quotes' : 'full';

if (!KEY) {
  console.error('FINNHUB_API_KEY fehlt (als GitHub Secret bzw. Umgebungsvariable setzen).');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isoDay = (d = Date.now()) => new Date(d).toISOString().slice(0, 10);
let lastCall = 0;
let calls = 0;

class AccessError extends Error {}

/** Finnhub-Aufruf mit Drosselung und Wiederholung bei 429/5xx. Schlüssel nur im Header, nie in der URL. */
async function api(endpoint, params) {
  const url = new URL(FINNHUB + endpoint);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  for (let attempt = 1; attempt <= 4; attempt++) {
    const wait = lastCall + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    calls++;

    let res;
    try {
      res = await fetch(url, { headers: { 'X-Finnhub-Token': KEY } });
    } catch (err) {
      if (attempt === 4) throw err;
      await sleep(2000 * attempt);
      continue;
    }
    if (res.status === 401 || res.status === 403) throw new AccessError(`${endpoint}: kein Zugriff (${res.status})`);
    if (res.status === 429 || res.status >= 500) {
      if (attempt === 4) throw new Error(`${endpoint}: HTTP ${res.status}`);
      await sleep(res.status === 429 ? 15000 * attempt : 3000 * attempt);
      continue;
    }
    if (!res.ok) throw new Error(`${endpoint}: HTTP ${res.status}`);
    return res.json();
  }
}

/** Andere Quellen (Yahoo, EZB): einfache Wiederholung, eigener Browser-User-Agent. */
async function getJson(url, tries = 3) {
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
      if (res.ok) return await res.json();
      if (res.status === 404) return null;
      if (attempt === tries) throw new Error(`HTTP ${res.status}`);
    } catch (e) {
      if (attempt === tries) throw e;
    }
    await sleep(1500 * attempt);
  }
}

/** Endpunkte, die im Tarif fehlen, nach dem ersten 401/403 für den Rest des Laufs abschalten. */
const disabled = new Set();
async function optional(name, endpoint, params) {
  if (disabled.has(name)) return null;
  try {
    return await api(endpoint, params);
  } catch (e) {
    if (e instanceof AccessError) {
      disabled.add(name);
      console.warn(`  ${name}: nicht im Tarif enthalten – wird weggelassen.`);
    } else console.warn(`  ${params.symbol ?? ''} ${name}: ${e.message}`);
    return null;
  }
}

async function readWatchlist() {
  const text = await readFile(WATCHLIST_FILE, 'utf8');
  const symbols = text
    .split('\n')
    .map((l) => l.replace(/#.*/, '').trim().toUpperCase())
    .filter(Boolean);
  return [...new Set(symbols)];
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

function toQuote(q) {
  // Finnhub liefert für unbekannte Symbole c = 0 und t = 0.
  if (!q || !q.c || !q.t) return null;
  return { price: q.c, change: q.d, changePct: q.dp, prevClose: q.pc, open: q.o, high: q.h, low: q.l, time: new Date(q.t * 1000).toISOString() };
}

/** Finnhub-Symbol → Yahoo-Symbol (BRK.B → BRK-B; SAP.DE bleibt). */
const yahooSymbol = (s) => (/^[A-Z]+\.[A-Z]$/.test(s) ? s.replace('.', '-') : s);

// ---------- Kurshistorie: mehrere Quellen, die erste funktionierende gewinnt ----------
// Quellen, die in diesem Lauf blockieren, werden für die restlichen Aktien übersprungen.
const historyBlocked = new Set();
const historyUsed = {};

/** Stooq: Tageskurse als CSV, ohne Schlüssel. */
async function candlesStooq(symbol) {
  const s = /\.[A-Z]{1,3}$/.test(symbol) && !/^[A-Z]+\.[A-Z]$/.test(symbol)
    ? symbol.toLowerCase()
    : `${symbol.toLowerCase().replace('.', '-')}.us`;
  const from = isoDay(Date.now() - 760 * 86400000).replaceAll('-', '');
  const res = await fetch(`https://stooq.com/q/d/l/?s=${encodeURIComponent(s)}&i=d&d1=${from}`, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = (await res.text()).trim();
  const lines = text.split('\n');
  if (!/^Date,Open,High,Low,Close/i.test(lines[0])) throw new Error(`unerwartete Antwort: ${lines[0].slice(0, 60)}`);
  const t = [], o = [], h = [], l = [], c = [], v = [];
  for (const line of lines.slice(1)) {
    const [d, op, hi, lo, cl, vo] = line.split(',');
    if (!d || !cl) continue;
    t.push(Date.parse(d + 'T21:00:00Z') / 1000); o.push(+op); h.push(+hi); l.push(+lo); c.push(+cl); v.push(vo ? +vo : null);
  }
  if (c.length < 60) throw new Error(`nur ${c.length} Tage`);
  return { t, o, h, l, c, v };
}

/** Yahoo Finance mit Cookie + Crumb (wie gängige Bibliotheken), ohne Schlüssel. */
let yahooAuth = null;
async function yahooLogin() {
  if (yahooAuth) return yahooAuth;
  const r1 = await fetch('https://fc.yahoo.com/', { headers: { 'User-Agent': UA }, redirect: 'manual' });
  const cookie = (r1.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  const r2 = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', { headers: { 'User-Agent': UA, Cookie: cookie } });
  const crumb = r2.ok ? (await r2.text()).trim() : '';
  if (!crumb || crumb.includes('<')) throw new Error(`kein Crumb (HTTP ${r2.status})`);
  return (yahooAuth = { cookie, crumb });
}
async function candlesYahoo(symbol) {
  const { cookie, crumb } = await yahooLogin();
  const ys = encodeURIComponent(yahooSymbol(symbol));
  const res = await fetch(`https://query2.finance.yahoo.com/v8/finance/chart/${ys}?range=2y&interval=1d&crumb=${encodeURIComponent(crumb)}`, { headers: { 'User-Agent': UA, Cookie: cookie } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const r = (await res.json())?.chart?.result?.[0];
  const q = r?.indicators?.quote?.[0];
  if (!r?.timestamp?.length || !q) throw new Error('leere Antwort');
  return { t: r.timestamp, o: q.open, h: q.high, l: q.low, c: q.close, v: q.volume };
}

/** Twelve Data (nur mit kostenlosem Schlüssel als Secret TWELVEDATA_API_KEY; 8 Abrufe/Minute). */
let lastTwelve = 0;
async function candlesTwelve(symbol) {
  const key = process.env.TWELVEDATA_API_KEY;
  if (!key) throw new Error('kein Schlüssel');
  const wait = lastTwelve + 8000 - Date.now();
  if (wait > 0) await sleep(wait);
  lastTwelve = Date.now();
  const res = await fetch(`https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol.replace(/\.DE$/, ''))}&interval=1day&outputsize=520&order=ASC`, { headers: { Authorization: `apikey ${key}` } });
  const j = await res.json();
  if (!Array.isArray(j.values)) throw new Error(j.message || `HTTP ${res.status}`);
  const rows = j.values;
  return {
    t: rows.map((x) => Date.parse(x.datetime + 'T21:00:00Z') / 1000),
    o: rows.map((x) => +x.open), h: rows.map((x) => +x.high), l: rows.map((x) => +x.low), c: rows.map((x) => +x.close), v: rows.map((x) => (x.volume ? +x.volume : null)),
  };
}

const HISTORY_SOURCES = [['Stooq', candlesStooq], ['Yahoo', candlesYahoo], ['TwelveData', candlesTwelve]];

async function fetchCandles(symbol) {
  for (const [name, fn] of HISTORY_SOURCES) {
    if (historyBlocked.has(name)) continue;
    try {
      const c = await fn(symbol);
      historyUsed[name] = (historyUsed[name] || 0) + 1;
      return c;
    } catch (e) {
      console.warn(`  ${symbol}: Kurshistorie ${name}: ${e.message}`);
      // Sperren (429/403/Login) gelten für den ganzen Lauf; "Symbol unbekannt" nur für diese Aktie
      if (/HTTP (401|403|429)|Crumb|Schlüssel|limit/i.test(e.message)) historyBlocked.add(name);
    }
  }
  return null;
}

/** Wechselkurs USD → EUR (EZB-Referenzkurs über frankfurter.app, sonst Yahoo). */
async function fetchUsdEur() {
  for (const url of ['https://api.frankfurter.dev/v1/latest?base=USD&symbols=EUR', 'https://api.frankfurter.app/latest?from=USD&to=EUR']) {
    try {
      const j = await getJson(url, 2);
      if (j?.rates?.EUR) return { rate: j.rates.EUR, date: j.date, source: 'EZB' };
    } catch {}
  }
  try {
    const j = await getJson('https://query1.finance.yahoo.com/v8/finance/chart/EURUSD=X?range=5d&interval=1d', 2);
    const p = j?.chart?.result?.[0]?.meta?.regularMarketPrice;
    if (p) return { rate: 1 / p, date: isoDay(), source: 'Yahoo' };
  } catch {}
  return null;
}

/** TradingView-Symbol aus der Finnhub-Börsenbezeichnung. */
function tvSymbol(symbol, exchange) {
  const e = (exchange || '').toUpperCase();
  if (e.includes('NASDAQ')) return `NASDAQ:${symbol}`;
  if (e.includes('NEW YORK')) return `NYSE:${symbol}`;
  if (e.includes('XETRA') || symbol.endsWith('.DE')) return `XETR:${symbol.replace(/\.DE$/, '')}`;
  if (symbol.endsWith('.AS')) return `EURONEXT:${symbol.replace(/\.AS$/, '')}`;
  if (symbol.endsWith('.PA')) return `EURONEXT:${symbol.replace(/\.PA$/, '')}`;
  if (symbol.endsWith('.L')) return `LSE:${symbol.replace(/\.L$/, '')}`;
  return symbol;
}

const plusDays = (n) => isoDay(Date.now() + n * 86400000);

async function fetchFull(symbol) {
  const quoteRaw = await api('/quote', { symbol });
  const quote = toQuote(quoteRaw);
  if (!quote) throw new Error('kein Kurs – Symbol unbekannt oder im Gratis-Tarif nicht verfügbar');

  const metric = await api('/stock/metric', { symbol, metric: 'all' });
  const recommendation = await optional('Empfehlungen', '/stock/recommendation', { symbol });
  const profile = await optional('Profil', '/stock/profile2', { symbol });
  const priceTarget = await optional('Kursziel', '/stock/price-target', { symbol });
  const cal = await optional('Quartalstermine', '/calendar/earnings', { symbol, from: isoDay(), to: plusDays(120) });
  const surprises = await optional('Gewinnüberraschungen', '/stock/earnings', { symbol });
  const news = await optional('Nachrichten', '/company-news', { symbol, from: plusDays(-10), to: isoDay() });
  const insider = await optional('Insider', '/stock/insider-sentiment', { symbol, from: plusDays(-120), to: isoDay() });
  const candles = await fetchCandles(symbol);

  const next = (cal?.earningsCalendar ?? [])
    .filter((e) => e.date >= isoDay())
    .sort((a, b) => a.date.localeCompare(b.date))[0];
  const insiderRows = (insider?.data ?? []).slice(-3);

  return {
    symbol,
    name: profile?.name || symbol,
    currency: profile?.currency || null,
    exchange: profile?.exchange || null,
    country: profile?.country || null,
    industry: profile?.finnhubIndustry || null,
    logo: profile?.logo || null,
    weburl: profile?.weburl || null,
    marketCap: profile?.marketCapitalization ?? null, // Mio.
    tvSymbol: tvSymbol(symbol, profile?.exchange),
    quote,
    fundamentals: extractFundamentals({ quote: quoteRaw, metric, profile, recommendation, priceTarget }),
    extra: {
      beta: metric?.metric?.beta ?? null,
      dividendYield: metric?.metric?.dividendYieldIndicatedAnnual ?? metric?.metric?.currentDividendYieldTTM ?? null,
      pb: metric?.metric?.pbQuarterly ?? metric?.metric?.pbAnnual ?? null,
      ps: metric?.metric?.psTTM ?? null,
    },
    tech: computeTechnicals(candles),
    earnings: {
      next: next ? { date: next.date, hour: next.hour || null, epsEstimate: next.epsEstimate ?? null, revenueEstimate: next.revenueEstimate ?? null, quarter: next.quarter ?? null, year: next.year ?? null } : null,
      history: (Array.isArray(surprises) ? surprises : []).slice(0, 4).map((e) => ({ period: e.period, actual: e.actual, estimate: e.estimate, surprisePercent: e.surprisePercent })),
    },
    news: (Array.isArray(news) ? news : [])
      .filter((n) => n.headline && n.url)
      .sort((a, b) => b.datetime - a.datetime)
      .slice(0, 6)
      .map((n) => ({ headline: n.headline, source: n.source, url: n.url, time: new Date(n.datetime * 1000).toISOString(), summary: (n.summary || '').slice(0, 280) })),
    insider: insiderRows.length
      ? { mspr: insiderRows.reduce((s, r) => s + (r.mspr ?? 0), 0) / insiderRows.length, change: insiderRows.reduce((s, r) => s + (r.change ?? 0), 0), months: insiderRows.length }
      : null,
    fundamentalsUpdatedAt: new Date().toISOString(),
  };
}

function withScore(entry) {
  const { error, ...rest } = entry;
  if (!entry.fundamentals) return entry;
  const s = scoreStock(entry.fundamentals, entry.quote?.price);
  const plan = buildPlan({
    price: entry.quote?.price,
    tech: entry.tech,
    score: s.score,
    earnings: entry.earnings?.next,
    targetMean: entry.fundamentals.targetMean,
  });
  return { ...rest, ...(error ? { error } : {}), ...s, plan };
}

async function main() {
  const symbols = await readWatchlist();
  let old = await readJson(DATA_FILE);
  if (old?.demo) old = null; // Beispieldaten nie weiterverwenden
  const oldBySymbol = new Map((old?.stocks ?? []).map((s) => [s.symbol, s]));
  const now = new Date().toISOString();
  let mode = MODE;
  if (mode === 'quotes' && !old) {
    console.log('Noch keine data.json vorhanden – führe vollständiges Update aus.');
    mode = 'full';
  }
  if (mode === 'quotes') for (const d of old?.disabled ?? []) disabled.add(d);

  console.log(`Modus: ${mode}, ${symbols.length} Aktien`);
  const stocks = [];
  let failures = 0;

  for (const symbol of symbols) {
    const prev = oldBySymbol.get(symbol);
    try {
      let entry;
      if (mode === 'quotes' && prev?.fundamentals && 'tech' in prev) {
        const quote = toQuote(await api('/quote', { symbol }));
        if (!quote) throw new Error('kein Kurs erhalten');
        entry = { ...prev, quote };
        if (!prev.tech) entry.tech = computeTechnicals(await fetchCandles(symbol)); // fehlende Historie nachholen
      } else {
        entry = await fetchFull(symbol); // voll – oder neue Aktie im Kurs-Modus
      }
      delete entry.error;
      stocks.push(withScore(entry));
      const s = stocks.at(-1);
      console.log(`  ${symbol}: ${s.score} (${s.rating}) · ${s.plan?.signal.label ?? 'kein Kaufplan (keine Kurshistorie)'}`);
    } catch (e) {
      failures++;
      console.warn(`  ${symbol}: FEHLER ${e.message}`);
      if (prev?.fundamentals) stocks.push(withScore({ ...prev, error: e.message })); // alte Daten behalten
      else stocks.push({ symbol, name: symbol, error: e.message });
    }
  }

  if (failures === symbols.length && symbols.length) {
    console.error('Alle Abfragen fehlgeschlagen – data.json bleibt unverändert.');
    process.exit(1);
  }

  let marketNews = old?.marketNews ?? [];
  let fx = old?.fx ?? null;
  if (mode === 'full') {
    const mn = await optional('Marktnachrichten', '/news', { category: 'general' });
    if (Array.isArray(mn)) {
      marketNews = mn.filter((n) => n.headline && n.url).slice(0, 12)
        .map((n) => ({ headline: n.headline, source: n.source, url: n.url, time: new Date(n.datetime * 1000).toISOString() }));
    }
  }
  fx = (await fetchUsdEur()) ?? fx;

  const data = {
    generatedAt: now,
    quotesUpdatedAt: now,
    fundamentalsUpdatedAt: mode === 'full' ? now : old?.fundamentalsUpdatedAt ?? null,
    priceTargetAvailable: !disabled.has('Kursziel'),
    disabled: [...disabled],
    fx,
    marketNews,
    stocks,
  };
  await writeFile(DATA_FILE, JSON.stringify(data) + '\n');

  // Tagesschnappschuss für die Trefferbilanz (ein Eintrag je Tag, letzter Lauf gewinnt)
  const history = (await readJson(HISTORY_FILE)) ?? { days: [] };
  const today = isoDay();
  const snap = { d: today, s: {} };
  for (const s of stocks) if (s.quote?.price) snap.s[s.symbol] = [s.quote.price, s.score ?? null, s.plan?.signal.code ?? null];
  history.days = history.days.filter((x) => x.d !== today).concat(snap).slice(-600);
  await writeFile(HISTORY_FILE, JSON.stringify(history) + '\n');

  console.log(`Fertig: ${stocks.length} Aktien, ${failures} Fehler, ${calls} Finnhub-Aufrufe. Kurshistorie: ${JSON.stringify(historyUsed)}`);
  if (mode === 'full' && symbols.length && !Object.keys(historyUsed).length) {
    console.warn('::warning::Keine Kurshistorie erhalten – Kaufpläne fehlen. Optional kostenlosen Twelve-Data-Schlüssel als Secret TWELVEDATA_API_KEY hinterlegen.');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
