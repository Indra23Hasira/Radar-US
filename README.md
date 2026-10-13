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
/meta/scanDates                       → { dates: ["2026-08-20", "2026-08-21", ...] } - buat historical tracking
/marketRegime/{date}                  → { spxTrend, nasdaqTrend, breadth, vix, score }
/sectorScores/{date}/sectors/{etf}    → { sector, etf, rs1m, rank }
/stockScores/{date}/stocks/{ticker}   → { sector, price, changeDay, rs, volume, insider, compositeScore }
/watchlist/{ticker}                   → { addedDate, entryZone, status, notes }
```

Universe: S&P 500, sumber dari dataset publik `datasets/s-and-p-500-companies` di GitHub.

## Label akselerasi momentum

Selain Phase (Early/Building/Extended), tiap saham juga dikasih label akselerasi - bandingin kecepatan RS 5 hari (per hari) vs RS 1 bulan (per hari):

- **Akselerasi kuat / Akselerasi** - momentum minggu ini lebih cepat dari rata-rata bulan lalu, lagi "gaspol"
- **Baru mulai** - belum ada tren bulanan yang jelas, tapi minggu ini udah mulai gerak
- **Stabil** - kecepatannya konsisten
- **Melambat / Melambat tajam** - momentum bulan lalu udah kejadian, minggu ini mulai capek
- **Melemah** - RS 5 hari udah negatif

Ini **cuma label informasi** (gak masuk ke composite score) - dipakai buat nyaring manual dari kandidat yang udah lolos ranking, bukan buat ubah urutan/saham mana yang muncul. Cara pakai: dari top saham di ranking, prioritasin cek manual yang badge-nya "Akselerasi" ketimbang "Melambat" - itu biasanya yang momentumnya lebih fresh, bukan yang udah lama jalan.

## Cara kerja composite score

```
compositeScore = 15% market regime + 25% sector rotation + 15% industry (sub-industry) + 45% stock signal
stock signal    = 25% RS 5 hari + 10% RS 1 bulan + 20% volume + 25% insider + 20% earnings/revisi analis
```

**Fase entry** (biar radar condong ke "deteksi awal", bukan "udah telat"):
- **Early** - harga ≤5% di atas MA50 (baru breakout) DAN momentum 5 hari >1% (bukan sekadar positif dikit). Ini prioritas utama.
- **Building** - masih dalam tren wajar, belum ekstrem. Tetep valid buat entry.
- **Extended** - RS 1 bulan >40% ATAU udah >20% di atas MA50. Composite score-nya kena penalti (×0.85) biar gak nyuruh chasing saham yang udah lari jauh.
- **Below MA50** - belum ada momentum bullish.

Urutan tabel di dashboard **murni by composite score** (persis kayak sebelum ada konsep fase) - fase cuma label informasi yang nempel di tiap saham, gak ngaruh ke saham mana yang kepilih atau urutannya. Ini yang paling stabil: saham yang muncul tetep yang emang lolos kriteria kualitas, dan lo bisa lihat sekilas dari badge-nya mana yang baru mulai gerak (Early) vs yang udah lama tren (Building) vs yang udah kejauhan (Extended) - tanpa itu ngubah-ubah saham mana yang ditampilin.

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
- [x] Earnings/revision momentum (EPS surprise + revisi analis 30 hari, Yahoo Finance quoteSummary)
- [x] Watchlist & episode tracking di UI (klik "+" di stock ranking, isi entry zone/catatan, status watching/entered/closed)
- [x] Historical tracking (badge trend score vs 3 scan sebelumnya, di /meta/scanDates)
- [x] Backtest v2 (entry open H+1, hold 5/10/20 hari, pembanding SPY + rata-rata 500 saham, uji komponen per kuintil, jalan mingguan)
- [ ] Notifikasi harian (belum - kandidat: Telegram bot, paling gampang setup-nya)

## Backtest (v2)

`scripts/backtest.js` jawab dua pertanyaan:

1. **Kalau beli top 20 radar, hasilnya lebih bagus dari market gak?**
2. **Komponen skor mana yang beneran memprediksi return, dan mana yang malah merusak?**

**Aturan entry/exit:** beli di harga **open hari trading setelah scan** (scan jalan setelah market tutup, jadi paling cepat eksekusi besoknya), jual di **close hari ke-N** sejak entry. Diukur di tiga holding period sekaligus: **5, 10, 20 hari trading**. Dashboard punya tombol buat pindah horizon.

**Dua pembanding:**
- **SPY**: index S&P 500, dibobot market cap. Kalau pasar lagi ditarik segelintir mega-cap (breadth rendah), rata-rata saham biasa bakal kalah dari SPY walaupun radarnya gak salah apa-apa.
- **Rata-rata semua saham S&P 500 yang di-scan** (bobot sama): ini pembanding utama. Edge vs rata-rata saham = "apakah ranking radar lebih bagus daripada asal comot saham dari universe yang sama?"

Edge dihitung per kandidat terhadap pembanding di tanggal yang sama, lalu dirata-rata (matched), bukan rata-rata kandidat dikurangi rata-rata baseline yang tanggalnya beda-beda.

**Top 20, sampling discipline:** satu saham cuma dihitung di hari **pertama** dia masuk top 20. Kalau besoknya masih bertahan di top 20, itu bukan sample baru, cuma saham yang sama diukur ulang di jendela waktu yang tumpang tindih. Prinsip sama kayak Radar IDX/BTC. Breakdown by fase dan by rentang composite score (8 rentang: `<60`, `60-64`, ..., `90-100`) tetap ada, per horizon.

**Uji komponen di seluruh universe (~500 saham):** di tiap tanggal yang diuji, semua saham dibagi 5 kelompok (kuintil) menurut nilai komponennya: composite score, RS 5 hari, RS 1 bulan, volume vs rata-rata. Q1 = 20% terendah, Q5 = 20% tertinggi. Yang diukur: return tiap saham **dikurangi rata-rata semua saham di tanggal itu** (excess return). Kuintil dihitung per tanggal, baru digabung.
- `Q5−Q1` positif ("searah") = makin tinggi komponennya, makin bagus return-nya → komponen itu layak dipertahankan/diberi bobot lebih.
- `Q5−Q1` negatif ("terbalik") = komponen itu malah memilih saham yang bakal kalah → bobotnya harus diturunkan atau logikanya dibalik.
- Juga ditampilkan: excess return per fase, per kategori insider (beli/jual/campur/tidak ada), dan per status data earnings (ada/tidak ada). Kalau "tidak ada data" earnings mendominasi, artinya endpoint earnings sering gagal dan komponen itu praktis netral di skor.

Tanggal buat uji komponen dibikin **gak tumpang tindih**: jaraknya minimal sepanjang holding period, mulai dari tanggal terbaru mundur ke belakang. Jadi tiap periode = sample independen. Konsekuensinya horizon 20 hari baru punya sedikit periode di awal; dashboard nampilin peringatan kalau periodenya masih di bawah 4 dan label "searah/terbalik" disembunyikan sampai cukup.

Universe diambil dari daftar saham di scan terakhir. Harga diambil 1x per ticker (~500 request ke Yahoo, sama kayak scan harian). Firestore read per run sekitar 5.000 dokumen, masih jauh di bawah kuota gratis harian (50.000).

**Format `/backtest/latest` (v2):** `version: 2`, `horizons`, `results["5"|"10"|"20"] = { top20, byPhase, byScoreBucket, universe: { periods, periodDates, sampleSize, factors, spreads, byPhase, byScoreBucket, insider, earnings } }`. Field lama (`overall`, `baseline`, `edge`, `byPhase`, `byScoreBucket` untuk 5 hari vs SPY) tetap ditulis, jadi index.html versi lama masih bisa nampilin sesuatu. index.html baru otomatis pakai tampilan lama kalau dokumennya masih format v1.

Jalan **mingguan otomatis** (`.github/workflows/backtest.yml`, tiap Minggu), atau trigger manual dari tab Actions. Kalau di-trigger pas jam bursa US, bar hari itu dibuang otomatis karena belum final.

**Catatan soal modul earnings:** endpoint `quoteSummary` yang dipakai (`scripts/lib/earnings.js`) kadang lebih ketat aksesnya dibanding endpoint harga (`chart`) yang dipakai modul lain. Kalau abis run pertama kolom "Earnings" kosong ("-") buat SEMUA saham (bukan cuma sebagian), kemungkinan Yahoo minta autentikasi tambahan buat endpoint ini - cek log run di GitHub Actions buat pastiin. Kalau itu kejadian, skor-nya otomatis fallback ke netral (50) jadi gak bikin scan lain ikut gagal, tapi berarti perlu dicari sumber data alternatif.

## Perbaikan data insider & earnings (Okt 2026)

Backtest v2 nunjukin 100% saham kebaca "tidak ada" insider DAN "tidak ada data" earnings sejak awal. Artinya 45% dari stock signal (insider 25% + earnings 20%) selama ini konstan 50 buat semua saham. Penyebabnya dua bug:

- **Insider:** di daftar submissions SEC, dokumen Form 4 tercatat sebagai `xslF345X06/form4.xml`, yang isinya versi HTML hasil render dan gak ada tag `<transactionCode>`. Sekarang prefix `xsl.../` dibuang biar yang diambil XML mentahnya. Ditambah cek `issuerCik`: Form 4 di mana perusahaan itu jadi *pembeli* saham emiten lain (contoh Berkshire) gak dihitung lagi sebagai insider trading perusahaan itu sendiri.
- **Earnings:** endpoint `quoteSummary` Yahoo wajib cookie + crumb, tanpa itu balikin 401. Sekarang `earnings.js` bikin sesi kayak browser (cookie dari `fc.yahoo.com`, crumb dari `/v1/test/getcrumb`), dipakai ulang sepanjang run, dan otomatis diperbarui kalau kedaluwarsa.

Tiap scan sekarang nge-log jumlah saham yang punya data insider & earnings (cek di log GitHub Actions step "Run stock-level scan"). Kalau earnings `0 berhasil`, berarti cara crumb-nya diblokir lagi.

`stockScan.js` juga nyimpen field `components` (skor 0-100 per lapisan: market, sector, industry, rs5d, rs1m, volume, insider, earnings) di tiap saham. Dengan ini backtest bisa nguji lapisan sektor, industri, dan earnings, bukan cuma komponen yang bisa diturunin dari teks. Lapisan yang datanya baru ada di scan terbaru otomatis punya periode lebih sedikit; dashboard nampilin jumlah periodenya, dan label searah/terbalik baru muncul setelah ≥4 periode.
