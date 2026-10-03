// Pure helpers for cache-keeper: TTLs, Anthropic prompt-cache price multiples, and formatting.
import type { ModelUsage } from 'claude-code'

import type { CacheCalibration } from '../types'

export const MINUTE_MS = 60_000
export const TTL_1H_MS = 60 * MINUTE_MS
export const TTL_5M_MS = 5 * MINUTE_MS

// Prompt-cache prices are fixed multiples of a model's base input price:
// a cache read costs 0.1x, a cache write 1.25x (5m TTL) or 2x (1h TTL), output 5x.
const CACHE_READ_MULTIPLE = 0.1
const OUTPUT_MULTIPLE = 5

export const cacheWriteMultiple = (ttlMs: number): number => (ttlMs >= TTL_1H_MS ? 2 : 1.25)

/** A response's tokens expressed in base-input-price units, so cost / units = base price per token. */
export function weightedUnits(usage: ModelUsage, ttlMs: number): number {
  return (
    usage.input_tokens +
    CACHE_READ_MULTIPLE * usage.cache_read_input_tokens +
    cacheWriteMultiple(ttlMs) * usage.cache_creation_input_tokens +
    OUTPUT_MULTIPLE * usage.output_tokens
  )
}

/** List base input price (USD per token) by model family; the fallback before the ledger has calibrated. */
function listInputPricePerToken(model: string): number {
  const id = model.toLowerCase()
  if (id.includes('haiku')) return 1e-6
  if (id.includes('sonnet')) return 3e-6
  return 5e-6
}

// Enough weighted tokens that the ledger ratio is not dominated by one tiny side request.
const MIN_CALIBRATION_UNITS = 50_000

export type InputPrice = { perToken: number; source: 'config' | 'ledger' | 'list' }

/** Picks the base input price: configured value, else calibrated from the cost ledger, else list price. */
export function resolveInputPrice(
  configuredPerMTok: number,
  calibration: CacheCalibration | null,
  costNowUsd: number | undefined,
  model: string,
): InputPrice {
  if (configuredPerMTok > 0) return { perToken: configuredPerMTok / 1e6, source: 'config' }
  if (calibration && costNowUsd !== undefined && calibration.units >= MIN_CALIBRATION_UNITS) {
    const spent = costNowUsd - calibration.costStart
    if (spent > 0) return { perToken: spent / calibration.units, source: 'ledger' }
  }
  return { perToken: listInputPricePerToken(model), source: 'list' }
}

export const formatUsd = (usd: number): string =>
  usd >= 100 ? `$${usd.toFixed(0)}` : usd >= 10 ? `$${usd.toFixed(1)}` : `$${usd.toFixed(2)}`

export const formatTokens = (tokens: number): string =>
  tokens >= 1e6 ? `${(tokens / 1e6).toFixed(2)}M` : tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : `${tokens}`

/** Countdown text with prime marks to save width: 59', then 1'30" and 45" in the last two minutes. */
export function formatCountdown(ms: number): string {
  if (ms <= 0) return '0"'
  const minutes = Math.floor(ms / MINUTE_MS)
  if (minutes >= 2) return `${minutes}'`
  const seconds = Math.ceil(ms / 1000)
  return minutes > 0 ? `${minutes}'${String(seconds % 60).padStart(2, '0')}"` : `${seconds}"`
}

/** Time until an ISO timestamp, as "2h 10'" / "3d 4h"; empty when unknown or past. */
export function formatUntil(iso: string | undefined, now: number): string {
  if (!iso) return ''
  const ms = Date.parse(iso) - now
  if (!(ms > 0)) return ''
  const totalMinutes = Math.round(ms / MINUTE_MS)
  const days = Math.floor(totalMinutes / 1440)
  const hours = Math.floor((totalMinutes % 1440) / 60)
  const minutes = totalMinutes % 60
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}'`
  return `${minutes}'`
}
