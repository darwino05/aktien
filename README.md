# Aktien-Radar

Private Übersicht der eigenen Watchlist: Score 0–100 je Aktie, Einstufung
(**Kaufkandidat** ≥ 70 · **Beobachten** 50–69 · **Meiden** < 50) und Begründung.

- `index.html` – statische Seite, liest nur `data.json`
- `data.json` – wird von der GitHub Action geschrieben (anfangs Beispieldaten)
- `watchlist.txt` – deine Aktien, ein Symbol pro Zeile
- `scripts/update.mjs` – holt Daten von Finnhub (Node ≥ 18, keine Abhängigkeiten)
- `scripts/score.mjs` – Score-Berechnung, Tests in `scripts/score.test.mjs`
- `.github/workflows/update.yml` – Zeitplan

## Einrichtung

1. Kostenlosen API-Schlüssel auf finnhub.io holen.
2. Im Repo: **Settings → Secrets and variables → Actions → New repository secret**,
   Name `FINNHUB_API_KEY`. Der Schlüssel steht nur dort – nie in der Seite oder in `data.json`.
3. Diesen Stand auf `main` bringen (Zeitpläne laufen nur auf dem Standard-Branch).
4. **Settings → Pages → Deploy from a branch → `main` / `(root)`**.
5. **Actions → Daten aktualisieren → Run workflow** (Umfang `full`) für den ersten echten Lauf.

Hinweis: GitHub Pages aus einem *privaten* Repo braucht GitHub Pro/Team. Bei einem
öffentlichen Repo ist der Schlüssel trotzdem sicher, aber Watchlist und `data.json` sind
sichtbar. Die Seite setzt `noindex`, ist aber nicht passwortgeschützt.

## Zeitplan (UTC, `.github/workflows/update.yml`)

| Lauf | Wann | Aufrufe |
|---|---|---|
| Kurse | Mo–Fr 07:17–21:17 alle 2 h | 1 je Aktie, Score wird mit neuem Kurs neu gerechnet |
| Alles | Mo–Fr 04:43 | bis 5 je Aktie (quote, stock/metric, stock/recommendation, stock/profile2, stock/price-target) |
| Watchlist geändert | bei Push von `watchlist.txt` auf `main` | wie „Alles“ |

Das Skript drosselt auf < 60 Aufrufe/Minute und wiederholt bei HTTP 429.
Die Seite zeigt „zuletzt aktualisiert“ getrennt für Kurse und Kennzahlen.
An Feiertagen läuft der Kurs-Job trotzdem und schreibt einfach den letzten Kurs.

## Score (5 Bereiche à 20 Punkte)

Jede Teilkennzahl wird linear zwischen zwei Grenzen auf Punkte abgebildet (außerhalb gekappt).

| Bereich | Kennzahl | 0 Punkte | volle Punkte |
|---|---|---|---|
| Bewertung | PEG = KGV / Gewinnwachstum p.a. | ≥ 3 (oder Verlust / kein Wachstum) | ≤ 1 → 10 |
| | FCF-Rendite = 1 / (Kurs/FCF) | ≤ 0 % | ≥ 8 % → 10 |
| Wachstum | Umsatzwachstum p.a. | ≤ 0 % | ≥ 20 % → 10 |
| | Gewinnwachstum (EPS) p.a. | ≤ 0 % | ≥ 25 % → 10 |
| Qualität | Nettomarge | ≤ 0 % | ≥ 25 % → 10 |
| | Eigenkapitalrendite | ≤ 0 % | ≥ 25 % → 10 |
| Bilanz | Nettoverschuldung / EBITDA | ≥ 4 (oder EBITDA negativ) | ≤ 0 (Nettocash) → 20 |
| Analysten | Anteil Buy + Strong Buy | ≤ 20 % | ≥ 80 % → 10 |
| | Abstand zum mittleren Kursziel | ≤ −10 % | ≥ +30 % → 10 |

Die Grenzen stehen gut lesbar in `scripts/score.mjs` und lassen sich dort anpassen.

**Fehlende Daten:** Fehlt eine von zwei Kennzahlen eines Bereichs, zählt die andere doppelt.
Fehlt der ganze Bereich, gibt es neutrale 10 Punkte, und die Begründung sagt das.

### Finnhub-Felder (`stock/metric`, `metric=all`)

| Kennzahl | Feld (Fallbacks in Klammern) |
|---|---|
| KGV | live aus Kurs / `epsTTM`; sonst `peTTM` (`peExclExtraTTM`, `peBasicExclExtraTTM`, `peNormalizedAnnual`) |
| Gewinnwachstum p.a. | `epsGrowth3Y` (`epsGrowthTTMYoy`, `epsGrowth5Y`) |
| Umsatzwachstum p.a. | `revenueGrowth3Y` (`revenueGrowthTTMYoy`, `revenueGrowth5Y`) |
| Nettomarge | `netProfitMarginTTM` (`netProfitMarginAnnual`) |
| Eigenkapitalrendite | `roeTTM` (`roeRfy`, `roeAnnual`) |
| FCF-Rendite | `100 / pfcfShareTTM` (`pfcfShareAnnual`) |
| Nettoverschuldung/EBITDA | gibt es nicht direkt: (`enterpriseValue` − `marketCapitalization`) / (`ebitdPerShareTTM` × `shareOutstanding` aus profile2). Ersatz, falls das fehlt: `totalDebt/totalEquityQuarterly` (≤ 0,3 → 20, ≥ 2 → 0) |
| Empfehlungen | `stock/recommendation`, neuester Monat |
| Kursziel | `stock/price-target` → `targetMean`. **Premium-Endpunkt:** beim ersten 401/403 wird er für den Lauf übersprungen; dann zählen die Empfehlungen im Bereich Analysten doppelt. |

## Lokal testen

```sh
node --test scripts/score.test.mjs
FINNHUB_API_KEY=dein_schlüssel node scripts/update.mjs full     # oder: quotes
python3 -m http.server   # dann http://localhost:8000
```

Keine Anlageberatung.
