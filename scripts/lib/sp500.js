// Ambil daftar S&P 500 (ticker, sector, sub-industry, CIK) dari dataset publik di GitHub.
// Dataset ini di-maintain komunitas, update-nya gak instan tiap ada perubahan index,
// tapi cukup buat kebutuhan scan harian.
const SP500_CSV_URL = "https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv";

// Mapping nama GICS sector resmi -> sector ETF SPDR yang kita pakai di sector rotation
export const GICS_TO_ETF = {
  "Energy": "XLE",
  "Materials": "XLB",
  "Industrials": "XLI",
  "Consumer Discretionary": "XLY",
  "Consumer Staples": "XLP",
  "Health Care": "XLV",
  "Financials": "XLF",
  "Information Technology": "XLK",
  "Communication Services": "XLC",
  "Utilities": "XLU",
  "Real Estate": "XLRE"
};

// Parser CSV manual (handle field yang ada koma di dalam tanda kutip, misal "Cambridge, MA")
function parseCsvLine(line) {
  const fields = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      fields.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  fields.push(cur);
  return fields;
}

export async function fetchSp500() {
  const res = await fetch(SP500_CSV_URL, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`Gagal ambil daftar S&P 500: ${res.status}`);
  const text = await res.text();
  const lines = text.trim().split("\n");
  const header = parseCsvLine(lines[0]);
  const col = name => header.indexOf(name);

  return lines.slice(1)
    .map(line => {
      const f = parseCsvLine(line);
      const gicsSector = f[col("GICS Sector")];
      return {
        ticker: (f[col("Symbol")] || "").trim(),
        name: f[col("Security")],
        gicsSector,
        subIndustry: f[col("GICS Sub-Industry")],
        cik: (f[col("CIK")] || "").trim(),
        etf: GICS_TO_ETF[gicsSector] || null
      };
    })
    .filter(r => r.ticker && r.etf);
}
