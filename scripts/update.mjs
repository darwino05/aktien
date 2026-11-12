// Holt Daten von Finnhub und schreibt data.json.
//
//   FINNHUB_API_KEY=... node scripts/update.mjs full     # alles (Kurse, Kennzahlen, Empfehlungen, Profil, Kursziel)
//   FINNHUB_API_KEY=... node scripts/update.mjs quotes   # nur Kurse, Score wird neu gerechnet
//
// Keine Abhängigkeiten, benötigt Node ≥ 18 (globales fetch).

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { extractFundamentals, scoreStock } from './score.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_FILE = path.join(ROOT, 'data.json');
const WATCHLIST_FILE = path.join(ROOT, 'watchlist.txt');
const BASE = 'https://finnhub.io/api/v1';
const MIN_INTERVAL_MS = 1100; // < 60 Aufrufe/Minute (Gratis-Tarif)

const KEY = process.env.FINNHUB_API_KEY;
const MODE = process.argv[2] === 'quotes' ? 'quotes' : 'full';

if (!KEY) {
  console.error('FINNHUB_API_KEY fehlt (als GitHub Secret bzw. Umgebungsvariable setzen).');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastCall = 0;
let calls = 0;

class AccessError extends Error {}

/** Finnhub-Aufruf mit Drosselung und Wiederholung bei 429/5xx. Schlüssel nur im Header, nie in der URL. */
async function api(endpoint, params) {
  const url = new URL(BASE + endpoint);
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

async function readWatchlist() {
  const text = await readFile(WATCHLIST_FILE, 'utf8');
  const symbols = text
    .split('\n')
    .map((l) => l.replace(/#.*/, '').trim().toUpperCase())
    .filter(Boolean);
  return [...new Set(symbols)];
}

async function readData() {
  try {
    const d = JSON.parse(await readFile(DATA_FILE, 'utf8'));
    return d.demo ? null : d; // Beispieldaten nie weiterverwenden
  } catch {
    return null;
  }
}

function toQuote(q) {
  // Finnhub liefert für unbekannte Symbole c = 0 und t = 0.
  if (!q || !q.c || !q.t) return null;
  return { price: q.c, change: q.d, changePct: q.dp, prevClose: q.pc, time: new Date(q.t * 1000).toISOString() };
}

let priceTargetAvailable = true;

async function fetchFull(symbol) {
  const quoteRaw = await api('/quote', { symbol });
  const quote = toQuote(quoteRaw);
  if (!quote) throw new Error('kein Kurs – Symbol unbekannt oder im Gratis-Tarif nicht verfügbar');

  const metric = await api('/stock/metric', { symbol, metric: 'all' });
  const recommendation = await api('/stock/recommendation', { symbol }).catch((e) => {
    console.warn(`  ${symbol}: Empfehlungen nicht verfügbar (${e.message})`);
    return null;
  });
  const profile = await api('/stock/profile2', { symbol }).catch((e) => {
    console.warn(`  ${symbol}: Profil nicht verfügbar (${e.message})`);
    return null;
  });

  // Kursziel ist bei Finnhub ein Premium-Endpunkt. Nach dem ersten 401/403 nicht weiter versuchen.
  let priceTarget = null;
  if (priceTargetAvailable) {
    try {
      priceTarget = await api('/stock/price-target', { symbol });
    } catch (e) {
      if (e instanceof AccessError) {
        priceTargetAvailable = false;
        console.warn('  Kursziel-Endpunkt nicht im Tarif enthalten – Kursziel wird weggelassen.');
      } else console.warn(`  ${symbol}: Kursziel nicht verfügbar (${e.message})`);
    }
  }

  return {
    symbol,
    name: profile?.name || symbol,
    currency: profile?.currency || null,
    exchange: profile?.exchange || null,
    industry: profile?.finnhubIndustry || null,
    logo: profile?.logo || null,
    weburl: profile?.weburl || null,
    quote,
    fundamentals: extractFundamentals({ quote: quoteRaw, metric, profile, recommendation, priceTarget }),
    fundamentalsUpdatedAt: new Date().toISOString(),
  };
}

function withScore(entry) {
  const { error, ...rest } = entry;
  return { ...rest, ...(error ? { error } : {}), ...scoreStock(entry.fundamentals, entry.quote?.price) };
}

async function main() {
  const symbols = await readWatchlist();
  const old = await readData();
  const oldBySymbol = new Map((old?.stocks ?? []).map((s) => [s.symbol, s]));
  const now = new Date().toISOString();
  let mode = MODE;
  if (mode === 'quotes' && !old) {
    console.log('Noch keine data.json vorhanden – führe vollständiges Update aus.');
    mode = 'full';
  }
  if (old && old.priceTargetAvailable === false && mode === 'quotes') priceTargetAvailable = false;

  console.log(`Modus: ${mode}, ${symbols.length} Aktien`);
  const stocks = [];
  let failures = 0;

  for (const symbol of symbols) {
    const prev = oldBySymbol.get(symbol);
    try {
      let entry;
      if (mode === 'quotes' && prev?.fundamentals) {
        const quote = toQuote(await api('/quote', { symbol }));
        if (!quote) throw new Error('kein Kurs erhalten');
        entry = { ...prev, quote };
      } else {
        entry = await fetchFull(symbol); // voll – oder neue Aktie im Kurs-Modus
      }
      delete entry.error;
      stocks.push(withScore(entry));
      console.log(`  ${symbol}: ${stocks.at(-1).score} (${stocks.at(-1).rating})`);
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

  const data = {
    generatedAt: now,
    quotesUpdatedAt: now,
    fundamentalsUpdatedAt: mode === 'full' ? now : old?.fundamentalsUpdatedAt ?? null,
    priceTargetAvailable,
    stocks,
  };
  await writeFile(DATA_FILE, JSON.stringify(data, null, 1) + '\n');
  console.log(`Fertig: ${stocks.length} Aktien, ${failures} Fehler, ${calls} API-Aufrufe.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
