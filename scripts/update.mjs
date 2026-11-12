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

/** Tageskerzen der letzten 2 Jahre von Yahoo Finance (ohne Schlüssel). */
async function fetchCandles(symbol) {
  const ys = encodeURIComponent(yahooSymbol(symbol));
  for (const host of ['query1', 'query2']) {
    try {
      const j = await getJson(`https://${host}.finance.yahoo.com/v8/finance/chart/${ys}?range=2y&interval=1d&includePrePost=false`, 2);
      const r = j?.chart?.result?.[0];
      const q = r?.indicators?.quote?.[0];
      if (r?.timestamp?.length && q) return { t: r.timestamp, o: q.open, h: q.high, l: q.low, c: q.close, v: q.volume };
    } catch (e) {
      console.warn(`  ${symbol}: Kurshistorie (${host}) ${e.message}`);
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

  console.log(`Fertig: ${stocks.length} Aktien, ${failures} Fehler, ${calls} Finnhub-Aufrufe.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
