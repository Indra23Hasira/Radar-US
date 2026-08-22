import admin from "firebase-admin";
import { fetchDaily, sma, lastClose, pctReturn, clamp } from "./lib/yahoo.js";
import { fetchSp500 } from "./lib/sp500.js";
import { getInsiderSignal } from "./lib/secEdgar.js";

// ---------- Firebase Admin init ----------
if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();

// ---------- Helper: proses banyak item dengan concurrency terbatas ----------
async function mapWithConcurrency(items, worker, concurrency, delayMs) {
  const results = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(item =>
        worker(item).catch(err => {
          console.error(`Gagal proses item:`, err.message);
          return null;
        })
      )
    );
    results.push(...batchResults);
    if (delayMs) await new Promise(r => setTimeout(r, delayMs));
  }
  return results;
}

function volumeScore(ratio) {
  if (ratio == null) return 50;
  if (ratio >= 2) return 100;
  if (ratio >= 1.5) return 80;
  if (ratio >= 1) return 60;
  if (ratio >= 0.7) return 45;
  return 30;
}

// rank 1 (terbaik) -> skor 100, rank terakhir -> skor 0
function rankToScore(rank, total) {
  if (total <= 1) return 100;
  return Math.round(100 - ((rank - 1) * 100) / (total - 1));
}

async function main() {
  const date = new Date().toISOString().slice(0, 10);

  console.log("Ambil daftar S&P 500...");
  const universe = await fetchSp500();
  console.log(`Universe: ${universe.length} saham`);

  // ambil market score & sector score hari ini (udah ditulis scan.js)
  const marketDoc = await db.collection("marketRegime").doc(date).get();
  const marketScore = marketDoc.exists ? marketDoc.data().score : 50;

  const sectorSnap = await db.collection("sectorScores").doc(date).collection("sectors").get();
  const sectorScoreByEtf = {};
  const sectorCount = sectorSnap.size || 11;
  sectorSnap.forEach(doc => {
    const d = doc.data();
    sectorScoreByEtf[d.etf] = rankToScore(d.rank, sectorCount);
  });

  // ---------- Layer 4a: harga, RS, volume per saham ----------
  console.log("Ambil data harga per saham (Yahoo)...");
  const priceData = await mapWithConcurrency(universe, async (stock) => {
    const daily = await fetchDaily(stock.ticker);
    const price = lastClose(daily);
    const rs1m = pctReturn(daily, 21);

    const priorDaily = daily.slice(0, -1); // exclude hari ini biar avg volume fair
    const vol20 = sma(priorDaily.map(d => ({ close: d.volume })), 20);
    const lastVol = daily.length ? daily[daily.length - 1].volume : null;
    const volRatio = vol20 && lastVol ? lastVol / vol20 : null;

    return { ...stock, price, rs1m, volRatio };
  }, 8, 250);

  const validStocks = priceData.filter(s => s && s.rs1m != null);
  console.log(`Berhasil ambil harga: ${validStocks.length}/${universe.length}`);

  // ---------- Layer 4b: rank RS dalam masing-masing sector ----------
  const bySector = {};
  validStocks.forEach(s => {
    if (!bySector[s.etf]) bySector[s.etf] = [];
    bySector[s.etf].push(s);
  });
  Object.values(bySector).forEach(list => {
    list.sort((a, b) => b.rs1m - a.rs1m);
    list.forEach((s, i) => { s.rsScoreInSector = rankToScore(i + 1, list.length); });
  });

  // ---------- Layer 3: industry (GICS sub-industry) - rata2 RS, rank dalam sector ----------
  const bySubIndustry = {};
  validStocks.forEach(s => {
    const key = `${s.etf}::${s.subIndustry}`;
    (bySubIndustry[key] ||= []).push(s.rs1m);
  });
  const subIndustryAvg = {};
  Object.entries(bySubIndustry).forEach(([key, arr]) => {
    subIndustryAvg[key] = arr.reduce((a, b) => a + b, 0) / arr.length;
  });
  Object.entries(bySector).forEach(([etf, list]) => {
    const subs = [...new Set(list.map(s => s.subIndustry))];
    const ranked = subs
      .map(sub => ({ sub, avg: subIndustryAvg[`${etf}::${sub}`] }))
      .sort((a, b) => b.avg - a.avg);
    const scoreBySub = {};
    ranked.forEach((r, i) => { scoreBySub[r.sub] = rankToScore(i + 1, ranked.length); });
    list.forEach(s => { s.industryScore = scoreBySub[s.subIndustry]; });
  });

  // ---------- Layer 4c: insider signal dari SEC EDGAR ----------
  console.log("Ambil sinyal insider (SEC EDGAR)... ini paling lama");
  const withInsider = await mapWithConcurrency(validStocks, async (s) => {
    const insider = await getInsiderSignal(s.cik);
    return { ...s, insiderLabel: insider.label, insiderScore: insider.score };
  }, 5, 300);

  // ---------- Composite score ----------
  console.log("Hitung composite score...");
  const finalStocks = withInsider.filter(Boolean).map(s => {
    const sectorScore = sectorScoreByEtf[s.etf] ?? 50;
    const volScore = volumeScore(s.volRatio);
    const stockScore = Math.round(s.rsScoreInSector * 0.4 + volScore * 0.3 + s.insiderScore * 0.3);
    const compositeScore = clamp(Math.round(
      marketScore * 0.15 + sectorScore * 0.25 + (s.industryScore ?? 50) * 0.15 + stockScore * 0.45
    ));
    return {
      ticker: s.ticker,
      name: s.name,
      sector: s.etf,
      rs: `${s.rs1m.toFixed(1)}%`,
      volume: s.volRatio != null ? `${s.volRatio.toFixed(1)}x` : "-",
      insider: s.insiderLabel,
      compositeScore
    };
  });

  finalStocks.sort((a, b) => b.compositeScore - a.compositeScore);

  console.log(`Tulis ${finalStocks.length} saham ke Firestore...`);
  const stocksRef = db.collection("stockScores").doc(date).collection("stocks");
  const CHUNK = 400;
  for (let i = 0; i < finalStocks.length; i += CHUNK) {
    const batch = db.batch();
    finalStocks.slice(i, i + CHUNK).forEach(s => {
      batch.set(stocksRef.doc(s.ticker), {
        name: s.name,
        sector: s.sector,
        rs: s.rs,
        volume: s.volume,
        insider: s.insider,
        compositeScore: s.compositeScore
      });
    });
    await batch.commit();
  }

  console.log("Selesai. Top 5:", finalStocks.slice(0, 5).map(s => `${s.ticker} (${s.compositeScore})`).join(", "));
}

main().catch(err => {
  console.error("Stock scan gagal:", err);
  process.exit(1);
});
