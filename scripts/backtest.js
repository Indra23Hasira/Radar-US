import admin from "firebase-admin";
import { fetchDaily } from "./lib/yahoo.js";

// ---------- Firebase Admin init ----------
if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();

// ============================================================================
// BACKTEST v2
//
// Yang berubah dari v1:
// 1. Entry realistis: beli di harga OPEN hari trading BERIKUTNYA setelah scan
//    (scan jalan setelah market tutup, jadi paling cepat baru bisa eksekusi besoknya).
//    Jual di CLOSE hari ke-N sejak entry.
// 2. Diukur di beberapa holding period sekaligus (5, 10, 20 hari trading), biar ketahuan
//    apakah sinyalnya sebenernya jalan di horizon yang lebih panjang.
// 3. Dua pembanding: SPY (index, dibobot market cap) DAN rata-rata semua saham S&P 500
//    yang di-scan (bobot sama). Pembanding kedua ini yang jawab langsung: "apakah
//    ranking radar lebih bagus daripada asal comot saham S&P 500?" - gak kecampur efek
//    saham mega-cap yang lagi narik index sendirian.
//    Edge dihitung per kandidat terhadap pembanding di TANGGAL YANG SAMA (matched), bukan
//    rata-rata tanggal yang dirata-rata lagi.
// 4. Uji komponen di SELURUH ~500 saham: tiap tanggal, saham dibagi 5 kelompok (kuintil)
//    menurut composite score / RS5d / RS1m / volume, terus dilihat kelompok mana yang
//    return-nya ngalahin rata-rata. Kalau Q5 (tertinggi) > Q1 (terendah), komponen itu
//    beneran prediktif. Kalau kebalik, komponen itu malah ngerusak skor.
//    Tanggal yang dipakai dibikin gak tumpang tindih (jaraknya minimal = holding period),
//    biar tiap periode beneran sample independen - prinsip yang sama kayak first-appearance.
// ============================================================================

const HORIZONS = [5, 10, 20];   // holding period dalam hari trading
const PRIMARY_HORIZON = 5;      // dipakai buat field "legacy" biar tampilan lama tetap kebaca
const TOP_N = 20;               // kandidat = top 20 hari itu (sama kayak di dashboard)
const QUINTILES = 5;
const MIN_BAR_AGE_SEC = 7 * 3600; // bar harian dianggap "final" kalau udah >7 jam sejak market buka (13:30 UTC → 20:30 UTC, setelah tutup)

const BUCKET_ORDER = ["<60", "60-64", "65-69", "70-74", "75-79", "80-84", "85-89", "90-100", "n/a"];
function scoreBucket(score) {
  if (score == null) return "n/a";
  if (score >= 90) return "90-100";
  if (score >= 85) return "85-89";
  if (score >= 80) return "80-84";
  if (score >= 75) return "75-79";
  if (score >= 70) return "70-74";
  if (score >= 65) return "65-69";
  if (score >= 60) return "60-64";
  return "<60";
}

// ---------- helpers ----------
const round2 = n => (n == null || !isFinite(n) ? null : Number(n.toFixed(2)));
const mean = arr => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);

// field di /stockScores disimpan sebagai teks buat tampilan ("+4.2%", "1.8x", "-") → ubah balik ke angka
function parseNum(v) {
  if (v == null) return null;
  if (typeof v === "number") return isFinite(v) ? v : null;
  const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ""));
  return isNaN(n) ? null : n;
}

function insiderCategory(label) {
  if (!label || label === "-") return "tidak ada";
  if (label.startsWith("buy")) return "beli";
  if (label.startsWith("sell")) return "jual";
  if (label.startsWith("mixed")) return "campur";
  return "lainnya";
}
function earningsCategory(label) {
  return !label || label === "-" ? "tidak ada data" : "ada data";
}

// buang bar hari ini kalau market-nya belum tutup (jaga-jaga backtest di-trigger manual pas jam bursa)
function completeBars(daily) {
  const now = Date.now() / 1000;
  return daily.filter(d => now - d.t >= MIN_BAR_AGE_SEC);
}

// return % kalau beli di OPEN hari trading setelah dateStr, jual di CLOSE hari ke-h sejak entry
function forwardReturn(daily, dateStr, h) {
  if (!daily || daily.length === 0) return null;
  const target = Date.parse(`${dateStr}T00:00:00Z`) / 1000;
  const idx = daily.findIndex(d => d.t >= target);
  if (idx === -1) return null;
  if (daily[idx].t - target > 5 * 86400) return null; // ada bolong data di sekitar tanggal itu
  const entryBar = daily[idx + 1];
  const exitBar = daily[idx + h];
  if (!entryBar || !exitBar) return null;
  const entry = entryBar.open > 0 ? entryBar.open : entryBar.close; // open kadang null di Yahoo
  if (!(entry > 0) || !(exitBar.close > 0)) return null;
  return ((exitBar.close - entry) / entry) * 100;
}

// ringkasan buat list baris {ret, spy, univ}
function summarize(rows) {
  if (rows.length === 0) return null;
  const withSpy = rows.filter(r => r.spy != null);
  const withUniv = rows.filter(r => r.univ != null);
  return {
    count: rows.length,
    winRate: Math.round((rows.filter(r => r.ret > 0).length / rows.length) * 100),
    avgReturn: round2(mean(rows.map(r => r.ret))),
    spy: round2(mean(withSpy.map(r => r.spy))),
    universe: round2(mean(withUniv.map(r => r.univ))),
    edgeSpy: round2(mean(withSpy.map(r => r.ret - r.spy))),
    edgeUniverse: round2(mean(withUniv.map(r => r.ret - r.univ))),
    beatUniverseRate: withUniv.length
      ? Math.round((withUniv.filter(r => r.ret > r.univ).length / withUniv.length) * 100)
      : null
  };
}

function groupSummarize(rows, keyFn) {
  const groups = {};
  rows.forEach(r => { (groups[keyFn(r)] ||= []).push(r); });
  const out = {};
  Object.entries(groups).forEach(([k, list]) => { out[k] = summarize(list); });
  return out;
}

// ringkasan buat baris universe {excess}
function summarizeExcess(list) {
  if (list.length === 0) return null;
  return {
    count: list.length,
    avgExcess: round2(mean(list.map(x => x.excess))),
    beatRate: Math.round((list.filter(x => x.excess > 0).length / list.length) * 100)
  };
}

async function mapWithConcurrency(items, fn, concurrency = 8, delayMs = 200) {
  const out = new Array(items.length);
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const res = await Promise.all(batch.map((it, j) => fn(it, i + j)));
    res.forEach((r, j) => { out[i + j] = r; });
    if (i + concurrency < items.length) await new Promise(r => setTimeout(r, delayMs));
  }
  return out;
}

// ---------- Firestore reads ----------
async function getScanDates() {
  const doc = await db.collection("meta").doc("scanDates").get();
  if (!doc.exists) return [];
  return (doc.data().dates || []).slice().sort();
}

const topCache = new Map();
async function getTopStocks(date) {
  if (!topCache.has(date)) {
    const snap = await db.collection("stockScores").doc(date).collection("stocks")
      .orderBy("compositeScore", "desc").limit(TOP_N).get();
    topCache.set(date, snap.docs.map(d => ({ ticker: d.id, ...d.data() })));
  }
  return topCache.get(date);
}

const allCache = new Map();
async function getAllStocks(date) {
  if (!allCache.has(date)) {
    const snap = await db.collection("stockScores").doc(date).collection("stocks").get();
    allCache.set(date, snap.docs.map(d => ({ ticker: d.id, ...d.data() })));
  }
  return allCache.get(date);
}

// ============================================================================
async function main() {
  const dates = await getScanDates();
  if (dates.length < 3) {
    console.log("Belum cukup histori scan buat backtest. Coba lagi beberapa hari ke depan.");
    return;
  }

  // ---------- 1. Kandidat top 20 (first-appearance aja) ----------
  // satu saham cuma dihitung di hari PERTAMA dia masuk top 20 - kalau besoknya masih bertahan,
  // itu bukan sample baru (prinsip sama kayak Radar IDX/BTC)
  const candidates = [];
  let skippedRepeat = 0;
  for (let i = 0; i < dates.length; i++) {
    const date = dates[i];
    const stocks = await getTopStocks(date);
    const prevTickers = i > 0 ? new Set((await getTopStocks(dates[i - 1])).map(s => s.ticker)) : new Set();
    stocks.forEach(s => {
      if (prevTickers.has(s.ticker)) { skippedRepeat++; return; }
      candidates.push({ date, ticker: s.ticker, phase: s.phase || "n/a", compositeScore: s.compositeScore });
    });
  }
  console.log(`Kandidat top ${TOP_N} (first-appearance): ${candidates.length} (${skippedRepeat} dilewatin karena bertahan dari hari sebelumnya)`);

  // ---------- 2. Universe = semua saham di scan terakhir ----------
  const latestAll = await getAllStocks(dates[dates.length - 1]);
  const universeTickers = latestAll.map(s => s.ticker);
  console.log(`Universe: ${universeTickers.length} saham`);

  // ---------- 3. Ambil harga (1x per ticker) ----------
  const tickersToFetch = [...new Set(["SPY", ...universeTickers, ...candidates.map(c => c.ticker)])];
  console.log(`Ambil harga ${tickersToFetch.length} ticker dari Yahoo...`);
  const priceCache = {};
  let fetchFail = 0;
  await mapWithConcurrency(tickersToFetch, async t => {
    try {
      priceCache[t] = completeBars(await fetchDaily(t, "1y"));
    } catch (err) {
      fetchFail++;
    }
  });
  console.log(`Harga berhasil: ${tickersToFetch.length - fetchFail}, gagal: ${fetchFail}`);
  const spyDaily = priceCache["SPY"];
  if (!spyDaily) console.error("PERINGATAN: harga SPY gagal diambil - pembanding SPY bakal kosong");

  // rata-rata return seluruh universe per (tanggal, horizon) - dipakai sebagai pembanding "asal comot"
  const univMeanCache = new Map();
  function universeMean(date, h) {
    const key = `${date}|${h}`;
    if (!univMeanCache.has(key)) {
      const rets = universeTickers
        .map(t => forwardReturn(priceCache[t], date, h))
        .filter(r => r != null);
      // minimal setengah universe punya data, biar gak bias kalau data forward-nya baru sebagian
      univMeanCache.set(key, rets.length >= universeTickers.length * 0.5 ? mean(rets) : null);
    }
    return univMeanCache.get(key);
  }

  const results = {};
  let dateFrom = null, dateTo = null;

  for (const h of HORIZONS) {
    // ---------- 4. Top 20 vs pembanding ----------
    const rows = [];
    let noForward = 0, noPrice = 0;
    for (const c of candidates) {
      const daily = priceCache[c.ticker];
      if (!daily) { noPrice++; continue; }
      const ret = forwardReturn(daily, c.date, h);
      if (ret == null) { noForward++; continue; }
      rows.push({
        ...c,
        ret,
        spy: forwardReturn(spyDaily, c.date, h),
        univ: universeMean(c.date, h)
      });
    }
    if (rows.length) {
      const ds = rows.map(r => r.date).sort();
      if (!dateFrom || ds[0] < dateFrom) dateFrom = ds[0];
      if (!dateTo || ds[ds.length - 1] > dateTo) dateTo = ds[ds.length - 1];
    }

    const top20 = summarize(rows);
    const byPhase = groupSummarize(rows, r => r.phase);
    const byScoreBucketRaw = groupSummarize(rows, r => scoreBucket(r.compositeScore));
    const byScoreBucket = {};
    BUCKET_ORDER.forEach(b => { if (byScoreBucketRaw[b]) byScoreBucket[b] = byScoreBucketRaw[b]; });

    console.log(`\n=== Hold ${h}d: top ${TOP_N} ===`);
    console.log(`dihitung ${rows.length}/${candidates.length} (data forward belum ada: ${noForward}, harga gagal: ${noPrice})`);
    console.log(top20);

    // ---------- 5. Uji komponen di seluruh universe ----------
    // pilih tanggal yang gak tumpang tindih: mulai dari yang paling baru yang udah punya data forward,
    // mundur dengan jarak minimal h scan
    const periodDates = [];
    let lastPickedIdx = Infinity;
    for (let i = dates.length - 1; i >= 0; i--) {
      if (lastPickedIdx - i < h) continue;
      if (universeMean(dates[i], h) == null) continue;
      periodDates.push(dates[i]);
      lastPickedIdx = i;
    }
    periodDates.reverse();

    const num = v => (typeof v === "number" && isFinite(v) ? v : null);
    const factorDefs = {
      composite: s => num(s.compositeScore),
      rs5d: s => parseNum(s.rs5d),
      rs1m: s => parseNum(s.rs),
      volume: s => parseNum(s.volume),
      // skor per lapisan - cuma ada di scan setelah stockScan.js nyimpen field "components"
      sector: s => num(s.components?.sector),
      industry: s => num(s.components?.industry),
      earnings: s => num(s.components?.earnings)
      // insider sengaja gak dibagi kuintil: hampir semua saham skornya 50 (gak ada transaksi),
      // jadi dianalisis per kategori (beli/jual/campur/tidak ada) di bawah
    };
    const quintileBuckets = {};
    Object.keys(factorDefs).forEach(f => { quintileBuckets[f] = Array.from({ length: QUINTILES }, () => []); });
    const uRows = [];
    const factorPeriods = {}; // berapa periode yang punya data buat tiap komponen (komponen baru punya lebih sedikit)

    for (const d of periodDates) {
      const all = await getAllStocks(d);
      const m = universeMean(d, h);
      const dayRows = all
        .map(s => {
          const ret = forwardReturn(priceCache[s.ticker], d, h);
          return ret == null ? null : { s, excess: ret - m };
        })
        .filter(Boolean);
      uRows.push(...dayRows.map(r => ({
        excess: r.excess,
        phase: r.s.phase || "n/a",
        insider: insiderCategory(r.s.insider),
        earnings: earningsCategory(r.s.earnings),
        bucket: scoreBucket(r.s.compositeScore)
      })));

      // kuintil dihitung PER TANGGAL (bukan digabung), biar tiap tanggal adil dibandingin sama dirinya sendiri
      Object.entries(factorDefs).forEach(([f, getter]) => {
        const valid = dayRows
          .map(r => ({ v: getter(r.s), excess: r.excess }))
          .filter(x => x.v != null)
          .sort((a, b) => a.v - b.v);
        if (valid.length) factorPeriods[f] = (factorPeriods[f] || 0) + 1;
        valid.forEach((x, i) => {
          const q = Math.min(QUINTILES - 1, Math.floor((i * QUINTILES) / valid.length));
          quintileBuckets[f][q].push(x);
        });
      });
    }

    const factors = {};
    const spreads = {};
    Object.entries(quintileBuckets).forEach(([f, qs]) => {
      if (qs.every(list => list.length === 0)) return; // komponen ini belum ada datanya di periode yang diuji
      factors[f] = qs.map((list, i) => ({ q: i + 1, ...(summarizeExcess(list) || { count: 0, avgExcess: null, beatRate: null }) }));
      const q1 = factors[f][0].avgExcess, q5 = factors[f][QUINTILES - 1].avgExcess;
      spreads[f] = q1 != null && q5 != null ? round2(q5 - q1) : null;
    });

    const groupExcess = keyFn => {
      const g = {};
      uRows.forEach(r => { (g[keyFn(r)] ||= []).push(r); });
      const out = {};
      Object.entries(g).forEach(([k, list]) => { out[k] = summarizeExcess(list); });
      return out;
    };

    const universe = {
      periods: periodDates.length,
      periodDates,
      sampleSize: uRows.length,
      factors,
      factorPeriods,
      spreads,
      byPhase: groupExcess(r => r.phase),
      byScoreBucket: groupExcess(r => r.bucket),
      insider: groupExcess(r => r.insider),
      earnings: groupExcess(r => r.earnings)
    };

    console.log(`--- Uji komponen ${h}d: ${periodDates.length} periode independen, ${uRows.length} sample ---`);
    console.log("Spread Q5-Q1 (excess vs rata-rata universe):", spreads);

    results[String(h)] = { top20, byPhase, byScoreBucket, universe };
  }

  // ---------- 6. Simpan ----------
  const primary = results[String(PRIMARY_HORIZON)];
  const legacyByScore = {};
  Object.entries(primary.byScoreBucket).forEach(([b, s]) => { legacyByScore[b] = { ...s, edge: s.edgeSpy }; });

  await db.collection("backtest").doc("latest").set({
    version: 2,
    generatedAt: admin.firestore.FieldValue.serverTimestamp(),
    entryRule: "beli open H+1, jual close hari ke-N",
    horizons: HORIZONS,
    primaryHorizon: PRIMARY_HORIZON,
    topN: TOP_N,
    dateRange: { from: dateFrom, to: dateTo },
    universeSize: universeTickers.length,
    bucketOrder: BUCKET_ORDER,
    results,
    // field lama (5d, pembanding SPY) - biar index.html versi lama tetap bisa nampilin sesuatu
    holdingDays: PRIMARY_HORIZON,
    overall: primary.top20 ? { count: primary.top20.count, winRate: primary.top20.winRate, avgReturn: primary.top20.avgReturn } : null,
    baseline: primary.top20?.spy ?? null,
    edge: primary.top20?.edgeSpy ?? null,
    byPhase: primary.byPhase,
    byScoreBucket: legacyByScore,
    sampleSize: primary.top20?.count ?? 0
  });

  console.log("\nHasil backtest v2 tersimpan ke /backtest/latest");
}

main().catch(err => {
  console.error("Backtest gagal:", err);
  process.exit(1);
});
