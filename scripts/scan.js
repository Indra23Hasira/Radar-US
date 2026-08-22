import admin from "firebase-admin";
import { fetchDaily, sma, lastClose, pctReturn, clamp } from "./lib/yahoo.js";

// ---------- Firebase Admin init ----------
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// ---------- Sector ETF universe (SPDR Select Sector) ----------
const SECTORS = [
  { sector: "Technology", etf: "XLK" },
  { sector: "Financials", etf: "XLF" },
  { sector: "Healthcare", etf: "XLV" },
  { sector: "Consumer Discretionary", etf: "XLY" },
  { sector: "Consumer Staples", etf: "XLP" },
  { sector: "Energy", etf: "XLE" },
  { sector: "Industrials", etf: "XLI" },
  { sector: "Materials", etf: "XLB" },
  { sector: "Utilities", etf: "XLU" },
  { sector: "Real Estate", etf: "XLRE" },
  { sector: "Communication Services", etf: "XLC" }
];

function trendLabel(price, ma50, ma200) {
  if (price == null || ma50 == null) return "neutral";
  if (ma200 != null && price > ma50 && price > ma200) return "bullish";
  if (ma200 != null && price < ma50 && price < ma200) return "bearish";
  return "neutral";
}

function trendScore(label) {
  if (label === "bullish") return 100;
  if (label === "bearish") return 20;
  return 55;
}

function vixLabel(vix) {
  if (vix == null) return "n/a";
  if (vix < 15) return "low";
  if (vix < 25) return "normal";
  return "high";
}

function vixScore(vix) {
  if (vix == null) return 50;
  if (vix < 15) return 90;
  if (vix < 20) return 70;
  if (vix < 25) return 50;
  if (vix < 30) return 30;
  return 10;
}

async function computeMarketRegime() {
  const [spy, qqq, vixData] = await Promise.all([
    fetchDaily("SPY"),
    fetchDaily("QQQ"),
    fetchDaily("^VIX")
  ]);

  const spyPrice = lastClose(spy);
  const spyMa50 = sma(spy, 50);
  const spyMa200 = sma(spy, 200);
  const spxTrend = trendLabel(spyPrice, spyMa50, spyMa200);

  const qqqPrice = lastClose(qqq);
  const qqqMa50 = sma(qqq, 50);
  const qqqMa200 = sma(qqq, 200);
  const nasdaqTrend = trendLabel(qqqPrice, qqqMa50, qqqMa200);

  const vix = lastClose(vixData);

  return { spxTrend, nasdaqTrend, vix, spyMa50, qqqMa50 };
}

async function computeSectorRotation(spyDaily) {
  const spyRs = pctReturn(spyDaily, 21); // ~1 bulan trading days

  const results = await Promise.all(
    SECTORS.map(async ({ sector, etf }) => {
      const daily = await fetchDaily(etf);
      const rs1m = pctReturn(daily, 21);
      const relativeStrength = rs1m != null && spyRs != null ? rs1m - spyRs : null;
      const price = lastClose(daily);
      const ma50 = sma(daily, 50);
      return { sector, etf, rs1m: rs1m != null ? Number(rs1m.toFixed(2)) : null, relativeStrength, aboveMa50: price != null && ma50 != null ? price > ma50 : null };
    })
  );

  results.sort((a, b) => (b.relativeStrength ?? -999) - (a.relativeStrength ?? -999));
  results.forEach((r, i) => { r.rank = i + 1; });

  const breadthCount = results.filter(r => r.aboveMa50).length;
  const breadth = Math.round((breadthCount / results.length) * 100);

  return { results, breadth };
}

async function main() {
  console.log("Mulai scan market regime + sector rotation...");

  const spyDaily = await fetchDaily("SPY");
  const regime = await computeMarketRegime();
  const { results: sectorResults, breadth } = await computeSectorRotation(spyDaily);

  const marketScore = clamp(Math.round(
    (trendScore(regime.spxTrend) + trendScore(regime.nasdaqTrend) + vixScore(regime.vix) + breadth) / 4
  ));

  const date = new Date().toISOString().slice(0, 10);

  // /marketRegime/{date}
  await db.collection("marketRegime").doc(date).set({
    spxTrend: regime.spxTrend,
    nasdaqTrend: regime.nasdaqTrend,
    breadth: `${breadth}%`,
    vix: `${regime.vix?.toFixed(1) ?? "-"} (${vixLabel(regime.vix)})`,
    score: marketScore,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  });

  // /sectorScores/{date}/sectors/{etf}
  const batch = db.batch();
  const sectorsRef = db.collection("sectorScores").doc(date).collection("sectors");
  sectorResults.forEach(r => {
    batch.set(sectorsRef.doc(r.etf), {
      sector: r.sector,
      etf: r.etf,
      rs1m: r.rs1m,
      rank: r.rank
    });
  });
  await batch.commit();

  // /meta/latest
  await db.collection("meta").doc("latest").set({ date });

  console.log(`Selesai. Market score: ${marketScore}, breadth: ${breadth}%`);
  console.log("Sector ranking:", sectorResults.map(r => `${r.rank}. ${r.etf} (${r.rs1m}%)`).join(", "));
}

main().catch(err => {
  console.error("Scan gagal:", err);
  process.exit(1);
});
