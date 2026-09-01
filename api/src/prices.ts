const wrappedSolMint = "So11111111111111111111111111111111111111112";
const cacheDurationMs = 60_000;

let solPriceCache: { usd: number; fetchedAt: number } | undefined;

export const getSolUsdPrice = async () => {
  const now = Date.now();
  if (solPriceCache && now - solPriceCache.fetchedAt < cacheDurationMs) {
    return { usd: solPriceCache.usd, stale: false };
  }
  try {
    const response = await fetch(
      `https://lite-api.jup.ag/price/v3?ids=${wrappedSolMint}`,
      { signal: AbortSignal.timeout(3_000) }
    );
    if (!response.ok) throw new Error(`Price provider returned ${response.status}`);
    const prices = await response.json() as Record<string, { usdPrice?: number }>;
    const usd = prices[wrappedSolMint]?.usdPrice;
    if (!Number.isFinite(usd) || !usd || usd <= 0) {
      throw new Error("SOL price is unavailable");
    }
    solPriceCache = { usd, fetchedAt: now };
    return { usd, stale: false };
  } catch (error) {
    if (solPriceCache) return { usd: solPriceCache.usd, stale: true };
    throw error;
  }
};
