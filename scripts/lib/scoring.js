export function trendLabel(price, ma50, ma200) {
  if (price == null || ma50 == null) return "neutral";
  if (ma200 != null && price > ma50 && price > ma200) return "bullish";
  if (ma200 != null && price < ma50 && price < ma200) return "bearish";
  return "neutral";
}

export function trendScore(label) {
  if (label === "bullish") return 100;
  if (label === "bearish") return 20;
  return 55;
}

export function vixLabel(vix) {
  if (vix == null) return "n/a";
  if (vix < 15) return "low";
  if (vix < 25) return "normal";
  return "high";
}

export function vixScore(vix) {
  if (vix == null) return 50;
  if (vix < 15) return 90;
  if (vix < 20) return 70;
  if (vix < 25) return 50;
  if (vix < 30) return 30;
  return 10;
}
