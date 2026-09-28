// Official DeepSeek pricing, USD per 1M tokens, PEAK rates.
// Source: https://api-docs.deepseek.com/quick_start/pricing (re-checked 19/9/2026).
// Off-peak rates are exactly half of the peak rates. Peak hours are 01:00-04:00 and
// 06:00-10:00 UTC, Monday-Friday; every other hour (including all weekend) is off-peak.
export interface ModelPricing {
  hit: number;
  miss: number;
  output: number;
}

export const PEAK_PRICING_USD_PER_M: Record<string, ModelPricing> = {
  'deepseek-flash': { hit: 0.006, miss: 0.3, output: 1.2 },
  'deepseek-v4-pro': { hit: 0.044, miss: 1.32, output: 3.96 },
};

export function isPeakTime(date: Date = new Date()): boolean {
  const day = date.getUTCDay(); // 0 = Sunday .. 6 = Saturday
  if (day === 0 || day === 6) return false;
  const minutes = date.getUTCHours() * 60 + date.getUTCMinutes();
  const inWindow = (startHour: number, endHour: number) => minutes >= startHour * 60 && minutes < endHour * 60;
  return inWindow(1, 4) || inWindow(6, 10);
}

export function getModelPricing(model: string, peak: boolean): ModelPricing | null {
  const base = PEAK_PRICING_USD_PER_M[model];
  if (!base) return null;
  const factor = peak ? 1 : 0.5;
  return { hit: base.hit * factor, miss: base.miss * factor, output: base.output * factor };
}

export interface RequestUsage {
  promptTokens?: number;
  completionTokens?: number;
  promptCacheHitTokens?: number;
  promptCacheMissTokens?: number;
}

// Cost of a single API response, priced at the rate that applied when the request was made.
// Cache-hit and cache-miss input tokens are priced separately because a cache hit is ~50x
// cheaper; charging the whole prompt at the miss rate is exactly what used to overstate
// multi-round agent costs.
export function computeRequestCostUsd(
  model: string,
  usage: RequestUsage,
  peak: boolean = isPeakTime(),
): number {
  const pricing = getModelPricing(model, peak);
  if (!pricing) return 0;
  const hit = Math.max(0, usage.promptCacheHitTokens ?? 0);
  const miss = Math.max(0, usage.promptCacheMissTokens ?? Math.max(0, (usage.promptTokens ?? 0) - hit));
  const output = Math.max(0, usage.completionTokens ?? 0);
  return (hit / 1_000_000) * pricing.hit + (miss / 1_000_000) * pricing.miss + (output / 1_000_000) * pricing.output;
}
