// Ambil earnings surprise (beat/miss kuartal terakhir) dan revisi estimasi analis
// dari Yahoo Finance quoteSummary - gratis, tapi kadang lebih ketat aksesnya
// dibanding endpoint harga. Kalau gagal, fallback ke skor netral (bukan error fatal).
function quoteSummaryUrl(ticker) {
  return `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=earningsHistory,earningsTrend`;
}

function raw(val) {
  return val && typeof val === "object" && "raw" in val ? val.raw : val;
}

async function fetchQuoteSummary(ticker) {
  const res = await fetch(quoteSummaryUrl(ticker), { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) return null;
  const json = await res.json();
  return json.quoteSummary?.result?.[0] || null;
}

// Return { label, score } - score 50 = netral/gak ada data
export async function getEarningsSignal(ticker) {
  try {
    const data = await fetchQuoteSummary(ticker);
    if (!data) return { label: "-", score: 50 };

    // ---------- Earnings surprise kuartal terakhir ----------
    const history = data.earningsHistory?.history || [];
    const latest = history[history.length - 1];
    const surprisePct = latest ? raw(latest.surprisePercent) : null;
    const surpriseScore = surprisePct != null
      ? Math.max(0, Math.min(100, 50 + surprisePct * 100 * 3))
      : 50;

    // ---------- Revisi estimasi analis 30 hari terakhir (kuartal berjalan) ----------
    const trends = data.earningsTrend?.trend || [];
    const currentQuarter = trends.find(t => t.period === "0q") || trends[0];
    const up = raw(currentQuarter?.epsRevisions?.upLast30days) ?? 0;
    const down = raw(currentQuarter?.epsRevisions?.downLast30days) ?? 0;
    const revisionScore = Math.max(0, Math.min(100, 50 + (up - down) * 10));

    const score = Math.round(surpriseScore * 0.5 + revisionScore * 0.5);

    const parts = [];
    if (surprisePct != null) parts.push(`EPS ${surprisePct >= 0 ? "+" : ""}${(surprisePct * 100).toFixed(1)}%`);
    if (up || down) parts.push(`rev ${up}\u2191/${down}\u2193`);

    return { label: parts.length ? parts.join(" ") : "-", score };
  } catch (err) {
    return { label: "-", score: 50 };
  }
}
