// Helper buat ambil data harga harian dari Yahoo Finance (unofficial chart API, gratis, no key).
export async function fetchDaily(symbol, range = "1y") {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`Yahoo fetch gagal buat ${symbol}: ${res.status}`);
  const json = await res.json();
  const result = json.chart?.result?.[0];
  if (!result) throw new Error(`Data kosong buat ${symbol}`);
  const closes = result.indicators.quote[0].close;
  const volumes = result.indicators.quote[0].volume;
  const timestamps = result.timestamp;
  return timestamps
    .map((t, i) => ({ t, close: closes[i], volume: volumes ? volumes[i] : null }))
    .filter(d => d.close !== null && d.close !== undefined);
}

export function sma(daily, period) {
  if (daily.length < period) return null;
  const slice = daily.slice(-period).map(d => d.close);
  return slice.reduce((a, b) => a + b, 0) / period;
}

export function lastClose(daily) {
  return daily.length ? daily[daily.length - 1].close : null;
}

// return % dalam N hari trading terakhir
export function pctReturn(daily, tradingDaysBack) {
  if (daily.length <= tradingDaysBack) return null;
  const now = daily[daily.length - 1].close;
  const then = daily[daily.length - 1 - tradingDaysBack].close;
  return ((now - then) / then) * 100;
}

export function clamp(n, min = 0, max = 100) {
  return Math.max(min, Math.min(max, n));
}
