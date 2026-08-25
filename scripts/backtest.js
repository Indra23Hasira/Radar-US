import admin from "firebase-admin";
import { fetchDaily } from "./lib/yahoo.js";

// ---------- Firebase Admin init ----------
if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();

const HOLDING_DAYS = 5; // hari trading maju - ukur return N hari setelah saham kedeteksi
const TOP_N = 20;       // kandidat = saham yang muncul di top 20 hari itu (sama kayak yang ditampilin dashboard)

async function getScanDates() {
  const doc = await db.collection("meta").doc("scanDates").get();
  if (!doc.exists) return [];
  return (doc.data().dates || []).slice().sort();
}

async function getTopStocksForDate(date) {
  const snap = await db.collection("stockScores").doc(date).collection("stocks")
    .orderBy("compositeScore", "desc").limit(TOP_N).get();
  return snap.docs.map(d => ({ ticker: d.id, ...d.data() }));
}

// cari close price di tanggal target (atau tepat sesudahnya kalau libur), lalu maju N hari trading lagi
function findCloseAtOrAfter(daily, targetDateStr, tradingDaysForward = 0) {
  const targetTime = new Date(targetDateStr).getTime() / 1000;
  const idx = daily.findIndex(d => d.t >= targetTime);
  if (idx === -1) return null;
  const forwardIdx = idx + tradingDaysForward;
  if (forwardIdx >= daily.length) return null;
  return daily[forwardIdx].close;
}

function summarize(list) {
  if (list.length === 0) return null;
  const wins = list.filter(r => r.returnPct > 0).length;
  const avgReturn = list.reduce((a, r) => a + r.returnPct, 0) / list.length;
  return {
    count: list.length,
    winRate: Math.round((wins / list.length) * 100),
    avgReturn: Number(avgReturn.toFixed(2))
  };
}

// buat jawab: apakah composite score yang lebih tinggi beneran korelasi sama return yang lebih bagus?
function scoreBucket(score) {
  if (score == null) return "n/a";
  if (score >= 80) return "80-100";
  if (score >= 70) return "70-79";
  if (score >= 60) return "60-69";
  return "<60";
}

async function main() {
  const dates = await getScanDates();

  // butuh tanggal yang udah "matang" - minimal HOLDING_DAYS hari kerja udah lewat dari tanggal itu,
  // biar ada data harga buat ngukur returnnya
  const eligibleDates = dates.slice(0, Math.max(0, dates.length - HOLDING_DAYS));
  if (eligibleDates.length === 0) {
    console.log(`Belum cukup histori buat backtest - butuh minimal ${HOLDING_DAYS} scan hari kerja yang udah "matang". Coba lagi beberapa hari ke depan.`);
    return;
  }

  console.log(`Backtest ${eligibleDates.length} tanggal (${eligibleDates[0]} s/d ${eligibleDates[eligibleDates.length - 1]}), holding period ${HOLDING_DAYS} hari trading...`);

  // kumpulin semua kandidat per tanggal
  const allCandidates = [];
  for (const date of eligibleDates) {
    const stocks = await getTopStocksForDate(date);
    stocks.forEach(s => allCandidates.push({ date, ticker: s.ticker, phase: s.phase || "n/a", compositeScore: s.compositeScore }));
  }
  console.log(`Total kandidat: ${allCandidates.length}`);

  // fetch harga historis per ticker unik (1x per ticker aja, bukan per tanggal - lebih hemat request)
  const uniqueTickers = [...new Set(allCandidates.map(c => c.ticker))];
  const priceCache = {};
  for (let i = 0; i < uniqueTickers.length; i += 8) {
    const batch = uniqueTickers.slice(i, i + 8);
    await Promise.all(batch.map(async t => {
      try {
        priceCache[t] = await fetchDaily(t, "2y");
      } catch (err) {
        console.error(`Gagal ambil harga ${t}:`, err.message);
      }
    }));
    await new Promise(r => setTimeout(r, 200));
  }

  // hitung return tiap kandidat
  const results = [];
  for (const c of allCandidates) {
    const daily = priceCache[c.ticker];
    if (!daily) continue;
    const entryPrice = findCloseAtOrAfter(daily, c.date, 0);
    const exitPrice = findCloseAtOrAfter(daily, c.date, HOLDING_DAYS);
    if (entryPrice == null || exitPrice == null) continue;
    const returnPct = ((exitPrice - entryPrice) / entryPrice) * 100;
    results.push({ ...c, returnPct });
  }
  console.log(`Berhasil dihitung returnnya: ${results.length}/${allCandidates.length}`);

  const overall = summarize(results);
  console.log("\n=== Ringkasan keseluruhan ===", overall);

  const byPhase = {};
  results.forEach(r => { (byPhase[r.phase] ||= []).push(r); });
  const phaseSummary = {};
  Object.entries(byPhase).forEach(([phase, list]) => {
    phaseSummary[phase] = summarize(list);
    console.log(phase, phaseSummary[phase]);
  });

  console.log("\n=== Breakdown by rentang score ===");
  const byScoreBucket = {};
  results.forEach(r => { (byScoreBucket[scoreBucket(r.compositeScore)] ||= []).push(r); });
  const scoreBucketSummary = {};
  Object.entries(byScoreBucket).forEach(([bucket, list]) => {
    scoreBucketSummary[bucket] = summarize(list);
    console.log(bucket, scoreBucketSummary[bucket]);
  });

  await db.collection("backtest").doc("latest").set({
    generatedAt: admin.firestore.FieldValue.serverTimestamp(),
    holdingDays: HOLDING_DAYS,
    dateRange: { from: eligibleDates[0], to: eligibleDates[eligibleDates.length - 1] },
    overall,
    byPhase: phaseSummary,
    byScoreBucket: scoreBucketSummary,
    sampleSize: results.length
  });

  console.log("\nHasil backtest tersimpan ke /backtest/latest");
}

main().catch(err => {
  console.error("Backtest gagal:", err);
  process.exit(1);
});
