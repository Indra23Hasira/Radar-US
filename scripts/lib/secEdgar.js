// SEC EDGAR wajib User-Agent yang jelas (nama app + email kontak) - kalau enggak, request ditolak.
const SEC_USER_AGENT = "USStockRadar indraanggriawan17@gmail.com";
const LOOKBACK_DAYS = 10;
const MAX_FILINGS_PER_TICKER = 5; // batasin biar gak terlalu banyak fetch per saham

function pad10(cik) {
  return String(cik).padStart(10, "0");
}

async function fetchSubmissions(cik) {
  const url = `https://data.sec.gov/submissions/CIK${pad10(cik)}.json`;
  const res = await fetch(url, { headers: { "User-Agent": SEC_USER_AGENT } });
  if (!res.ok) return null;
  return res.json();
}

async function fetchOwnershipXml(cikNumeric, accessionNumber, primaryDocument) {
  const acc = accessionNumber.replace(/-/g, "");
  const url = `https://www.sec.gov/Archives/edgar/data/${Number(cikNumeric)}/${acc}/${primaryDocument}`;
  const res = await fetch(url, { headers: { "User-Agent": SEC_USER_AGENT } });
  if (!res.ok) return null;
  return res.text();
}

// Regex sederhana buat narik transactionCode (P=purchase, S=sale) dan
// acquiredDisposedCode (A=acquired, D=disposed) dari XML ownership document.
function parseTransactions(xml) {
  const codes = [...xml.matchAll(/<transactionCode>([A-Z])<\/transactionCode>/g)].map(m => m[1]);
  const adCodes = [...xml.matchAll(/<transactionAcquiredDisposedCode>\s*<value>([AD])<\/value>/g)].map(m => m[1]);
  let buys = 0, sells = 0;
  codes.forEach((code, i) => {
    if (code === "P" && adCodes[i] === "A") buys++;
    if (code === "S" && adCodes[i] === "D") sells++;
  });
  return { buys, sells };
}

// Return { label, score } - label buat ditampilin di tabel, score 0-100 buat composite score.
// score 50 = netral/gak ada data, >50 = ada net buying, <50 = ada net selling.
export async function getInsiderSignal(cik) {
  if (!cik) return { label: "-", score: 50 };

  const submissions = await fetchSubmissions(cik);
  const recent = submissions?.filings?.recent;
  if (!recent) return { label: "-", score: 50 };

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - LOOKBACK_DAYS);

  const form4Indices = recent.form
    .map((f, i) => ({ f, i }))
    .filter(({ f, i }) => f === "4" && new Date(recent.filingDate[i]) >= cutoff)
    .map(({ i }) => i)
    .slice(0, MAX_FILINGS_PER_TICKER);

  if (form4Indices.length === 0) return { label: "-", score: 50 };

  let totalBuys = 0, totalSells = 0;
  for (const i of form4Indices) {
    const xml = await fetchOwnershipXml(submissions.cik, recent.accessionNumber[i], recent.primaryDocument[i]);
    if (!xml) continue;
    const { buys, sells } = parseTransactions(xml);
    totalBuys += buys;
    totalSells += sells;
  }

  const net = totalBuys - totalSells;
  const score = Math.max(0, Math.min(100, 50 + net * 15));

  let label = "-";
  if (totalBuys > 0 && totalSells === 0) label = `buy x${totalBuys}`;
  else if (totalSells > 0 && totalBuys === 0) label = `sell x${totalSells}`;
  else if (totalBuys > 0 && totalSells > 0) label = `mixed ${totalBuys}B/${totalSells}S`;

  return { label, score };
}
