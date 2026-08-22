# US Stock Radar

Scanner top-down US stock (market → sector → industry → stock) dengan composite score 0-100.
Pola sama dengan app-app lain: single-file HTML + Firebase, deploy ke GitHub Pages.

## Struktur

```
index.html         seluruh app: markup + CSS + JS (auth, render dashboard) jadi satu file
firestore.rules     security rules - akses cuma buat pemilik
scripts/            tempat script scan (Node.js, jalan via GitHub Actions) - belum diisi
manifest.json        PWA manifest
```

## Setup awal

1. Di Firebase Console project `radar-us`, aktifkan **Firestore**.
2. Authentication > Sign-in method: aktifkan **Google** dan **Email/Password**.
3. Authentication > Settings > Authorized domains: tambahin domain GitHub Pages kamu (misal `namakamu.github.io`).
4. Firestore > Rules: paste isi `firestore.rules` ke sana, publish.
5. Push semua file ke GitHub repo baru, aktifkan **GitHub Pages** (Settings > Pages > branch main / root).

## Login flow

- Login pertama kali: klik "Masuk dengan Google".
- Abis itu muncul banner "set password" - isi sekali biar bisa login manual (email+password) juga.
- Setelah itu dua metode (Google atau email+password) sama-sama masuk ke akun yang sama - gak akan pernah bikin akun duplikat atau kejadian gak bisa login lagi.
- Akses dibatasi ke email `indraanggriawan17@gmail.com` saja - login dengan akun Google lain otomatis ditolak & di-logout.

## Skema Firestore

```
/meta/latest                          → { date: "YYYY-MM-DD" }
/marketRegime/{date}                  → { spxTrend, nasdaqTrend, breadth, vix, score }
/sectorScores/{date}/sectors/{id}     → { sector, etf, rs1m, rank }
/stockScores/{date}/stocks/{ticker}   → { sector, rs, volume, insider, compositeScore }
/watchlist/{ticker}                   → { addedDate, entryZone, status, notes }
```

Universe default: S&P 500 (bisa diperluas nanti).

## Status

- [x] Repo skeleton (single-file) + Firestore schema
- [x] Auth (Google + email/password, akun sama) + Firestore rules
- [ ] Modul SEC EDGAR insider scanner
- [ ] Modul sector rotation scoring
- [ ] Modul market regime
- [ ] Composite score engine
- [ ] GitHub Actions scheduled workflow (scan otomatis)
