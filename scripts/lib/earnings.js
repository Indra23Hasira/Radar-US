// Ambil earnings surprise (beat/miss kuartal terakhir) dan revisi estimasi analis
// dari Yahoo Finance quoteSummary. Endpoint ini WAJIB pakai cookie + "crumb" (token sesi) -
// tanpa itu Yahoo balikin 401, dan sejak awal semua saham jadi "-" (skor netral 50).
// Caranya sama kayak browser: ambil cookie dari fc.yahoo.com, minta crumb, lalu kirim keduanya.
// Kalau tetap gagal, fallback ke skor netral (bukan error fatal).
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";

let session = null;        // { cookie, crumb } - dipakai ulang buat semua saham dalam 1 run
let sessionPromise = null; // biar request paralel gak bikin sesi berkali-kali
let stats = { ok: 0, fail: 0 };

function extractCookies(res) {
  const list = typeof res.headers.getSetCookie === "function"
    ? res.headers.getSetCookie()
    : (res.headers.get("set-cookie") || "").split(/,(?=[^;]+?=)/);
  return list.map(c => c.split(";")[0].trim()).filter(Boolean).join("; ");
}

async function createSession() {
  const res = await fetch("https://fc.yahoo.com/", { headers: { "User-Agent": UA }, redirect: "manual" });
  const cookie = extractCookies(res); // status-nya 404, itu normal - yang dibutuhin cuma cookie-nya
  if (!cookie) throw new Error("Yahoo gak ngasih cookie");
  const crumbRes = await fetch("https://query2.finance.yahoo.com/v1/test/getcrumb", {
    headers: { "User-Agent": UA, Cookie: cookie }
  });
  const crumb = (await crumbRes.text()).trim();
  if (!crumbRes.ok || !crumb || crumb.includes("<")) throw new Error(`crumb gagal (${crumbRes.status})`);
  return { cookie, crumb };
}

async function getSession(forceNew = false) {
  if (forceNew) { session = null; sessionPromise = null; }
  if (session) return session;
  if (!sessionPromise) {
    sessionPromise = createSession()
      .then(s => (session = s))
      .catch(err => { sessionPromise = null; throw err; });
  }
  return sessionPromise;
}

function raw(val) {
  return val && typeof val === "object" && "raw" in val ? val.raw : val;
}

async function fetchQuoteSummary(ticker, retried = false) {
  const { cookie, crumb } = await getSession();
  const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker)}` +
    `?modules=earningsHistory,earningsTrend&crumb=${encodeURIComponent(crumb)}`;
  const res = await fetch(url, { headers: { "User-Agent": UA, Cookie: cookie } });
  if ((res.status === 401 || res.status === 403) && !retried) {
    await getSession(true); // sesi kedaluwarsa - bikin baru, coba sekali lagi
    return fetchQuoteSummary(ticker, true);
  }
  if (!res.ok) return null;
  const json = await res.json();
  return json.quoteSummary?.result?.[0] || null;
}

// buat log di akhir scan: berapa saham yang beneran dapet data earnings
export function getEarningsStats() {
  return { ...stats };
}

// Return { label, score } - score 50 = netral/gak ada data
export async function getEarningsSignal(ticker) {
  try {
    const data = await fetchQuoteSummary(ticker);
    if (!data) { stats.fail++; return { label: "-", score: 50 }; }
    stats.ok++;

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
    stats.fail++;
    return { label: "-", score: 50 };
  }
}
