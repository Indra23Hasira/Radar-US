# US Stock Radar

Scanner top-down US stock (market → sector → industry → stock) dengan composite score 0-100.
Pola sama dengan app-app lain: single-file HTML + Firebase, deploy ke GitHub Pages.

## Struktur

```
index.html                  seluruh app: markup + CSS + JS (auth, render dashboard) jadi satu file
firestore.rules               security rules - akses cuma buat pemilik
scripts/scan.js                scan market regime + sector rotation (layer 1 & 2)
scripts/stockScan.js            scan per saham: RS, industry, volume, insider, breadth beneran (layer 3 & 4)
scripts/lib/scoring.js          fungsi scoring bersama (trend/VIX) dipakai scan.js & stockScan.js
scripts/lib/yahoo.js            helper ambil & olah data harga+volume dari Yahoo Finance
scripts/lib/sp500.js            daftar universe S&P 500 (ticker, sector, sub-industry, CIK)
scripts/lib/secEdgar.js         ambil & parse Form 4 (insider buy/sell) dari SEC EDGAR
scripts/package.json            dependency (firebase-admin)
.github/workflows/scan.yml       jadwal otomatis (Senin-Jumat, abis market tutup)
manifest.json                    PWA manifest
```

## Setup awal

1. Di Firebase Console project `radar-us`, aktifkan **Firestore**.
2. Authentication > Sign-in method: aktifkan **Google** dan **Email/Password**.
3. Authentication > Settings > Authorized domains: tambahin domain GitHub Pages kamu (misal `namakamu.github.io`).
4. Firestore > Rules: paste isi `firestore.rules` ke sana, publish.
5. Push semua file ke GitHub repo baru, aktifkan **GitHub Pages** (Settings > Pages > branch main / root).

## Setup scan otomatis (GitHub Actions)

1. Firebase Console > Project settings (ikon gerigi) > Service accounts > **Generate new private key**. Ini download file JSON - **jangan pernah di-commit ke repo**, ini kredensial sensitif.
2. Di GitHub repo: Settings > Secrets and variables > Actions > **New repository secret**.
   - Name: `FIREBASE_SERVICE_ACCOUNT_KEY`
   - Value: isi seluruh isi file JSON tadi (paste apa adanya)
3. Selesai. Workflow bakal jalan otomatis tiap hari kerja jam 21:15 UTC (~menyesuaikan abis market US tutup). Bisa juga di-trigger manual: tab **Actions** di GitHub > pilih "Daily scan" > **Run workflow**.
4. Setelah run pertama sukses, refresh dashboard - semua panel bakal keisi.

Catatan: scan saham (`stockScan.js`) scan ~500 ticker S&P 500 + cek insider filing SEC EDGAR per ticker, jadi total durasi run bisa **beberapa menit** (biasanya di bawah 15 menit). Ini normal, bukan macet.

## Login flow

- Login pertama kali: klik "Masuk dengan Google".
- Abis itu muncul banner "set password" - isi sekali biar bisa login manual (email+password) juga.
- Setelah itu dua metode (Google atau email+password) sama-sama masuk ke akun yang sama - gak akan pernah bikin akun duplikat atau kejadian gak bisa login lagi.
- Akses dibatasi ke email `indraanggriawan17@gmail.com` saja - login dengan akun Google lain otomatis ditolak & di-logout.

## Skema Firestore

```
/meta/latest                          → { date: "YYYY-MM-DD" }
/marketRegime/{date}                  → { spxTrend, nasdaqTrend, breadth, vix, score }
/sectorScores/{date}/sectors/{etf}    → { sector, etf, rs1m, rank }
/stockScores/{date}/stocks/{ticker}   → { sector, rs, volume, insider, compositeScore }
/watchlist/{ticker}                   → { addedDate, entryZone, status, notes }
```

Universe: S&P 500, sumber dari dataset publik `datasets/s-and-p-500-companies` di GitHub.

## Cara kerja composite score

```
compositeScore = 15% market regime + 25% sector rotation + 15% industry (sub-industry) + 45% stock signal
stock signal    = 30% RS 5 hari (momentum baru) + 15% RS 1 bulan (konfirmasi tren) + 25% volume + 30% insider
```

**Fase entry** (biar radar condong ke "deteksi awal", bukan "udah telat"):
- **Early** - harga baru breakout dari MA50 (0-8% di atasnya) + momentum 5 hari positif. Ini prioritas utama.
- **Building** - masih dalam tren wajar, belum ekstrem.
- **Extended** - udah naik >40% dalam sebulan. Composite score-nya kena penalti (×0.85) biar gak nyuruh chasing saham yang udah lari jauh.
- **Below MA50** - belum ada momentum bullish.

## Status

- [x] Repo skeleton (single-file) + Firestore schema
- [x] Auth (Google + email/password, akun sama) + Firestore rules
- [x] Modul market regime (SPY/QQQ trend, VIX, breadth proxy)
- [x] Breadth beneran (% dari 500 saham individual di atas MA50, di-update stockScan.js abis scan.js jalan)
- [x] Modul sector rotation (11 SPDR sector ETF, relative strength vs SPY)
- [x] Modul industry (GICS sub-industry, relative strength dalam sector)
- [x] Modul stock-level (RS per saham, volume anomaly)
- [x] Modul SEC EDGAR insider scanner (Form 4 buy/sell, 10 hari terakhir)
- [x] Composite score engine
- [x] GitHub Actions scheduled workflow
- [ ] Earnings/revision momentum (belum, layer stock signal masih 3 komponen)
- [ ] Watchlist & episode tracking di UI (data model udah ada, UI-nya belum dipakai)
