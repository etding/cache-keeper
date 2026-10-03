// The shape cache-keeper's pane, band and status line share, and the pure text built from it.
import type { SessionRateLimit } from 'claude-code'

import { describeCompactPoint } from './auto-compact-policy'
import type { CompactPoint, CompactSetting } from './auto-compact-policy'
import { formatCountdown, formatTokens, formatUsd } from './cache-math'
import type { InputPrice } from './cache-math'

export type KeeperConfig = {
  cacheTtl: string
  warnMs: number
  inputPricePerMTok: number
  handoffCommand: string
  autoCompact: CompactSetting | 'auto'
}

/** empty: nothing cached yet · running: a turn keeps it warm · cooling: inside the warning window. */
export type CachePhase = 'empty' | 'running' | 'warm' | 'cooling' | 'cold'

export type TtlSource = 'config' | 'observed' | 'assumed'

export type KeeperView = {
  phase: CachePhase
  now: number
  remainingMs: number
  ttlMs: number
  ttlSource: TtlSource
  touchAt: number | null
  contextTokens: number
  contextWindow: number
  contextPercent?: number
  rewarmUsd: number
  priceSource: InputPrice['source']
  rateLimits: SessionRateLimit[]
  costUsd?: number
  compact: CompactPoint
}

export const PHASE_COLOR: Record<CachePhase, string> = {
  empty: 'gray',
  running: 'green',
  warm: 'green',
  cooling: 'yellow',
  cold: 'red',
}

export const LIMIT_LABEL: Record<string, string> = { five_hour: '5-hour limit', seven_day: 'Weekly limit' }

/** The pane's first line. */
export function headline(view: KeeperView): string {
  switch (view.phase) {
    case 'empty':
      return 'No cache yet: it starts with the first reply'
    case 'running':
      return 'Cache warm: turn running'
    case 'cold':
      return `Cache cold: next prompt re-writes ${formatTokens(view.contextTokens)} tokens`
    default:
      return `Cache warm: ${formatCountdown(view.remainingMs)} left`
  }
}

/** Share of a rate-limit window still available, in whole percent. */
export const percentLeft = (limit: SessionRateLimit): number => Math.max(0, Math.round(100 - limit.percentUsed))

/** How a bar chip reads: fine, worth watching, act now, or plain information. */
export type ChipTone = 'good' | 'warn' | 'bad' | 'neutral'

/**
 * The status dot's color as a theme key, so it follows the light and dark themes. The pill
 * text stays gray; this small dot is the only color on the bar. Neutral pills get no dot.
 */
export const TONE_DOT_COLOR: Record<ChipTone, string | undefined> = {
  good: 'success',
  warn: 'warning',
  bad: 'error',
  neutral: undefined,
}

export type BandChip = { text: string; tone: ChipTone }

const PHASE_TONE: Record<CachePhase, ChipTone> = {
  empty: 'neutral',
  running: 'good',
  warm: 'good',
  cooling: 'warn',
  cold: 'bad',
}

const SHORT_LIMIT_LABEL: Record<string, string> = { five_hour: '5h', seven_day: 'wk' }

/** Plenty left above half, getting low down to a fifth, nearly out below that. */
const limitTone = (left: number): ChipTone => (left > 50 ? 'good' : left >= 20 ? 'warn' : 'bad')

/** The cache chip: countdown and re-warm cost. Kept terse; the pane has the long form. */
function cacheChipText(view: KeeperView): string {
  const rewarm = formatUsd(view.rewarmUsd)
  switch (view.phase) {
    case 'empty':
      return 'cache after reply'
    case 'running':
      return 'cache warm'
    case 'cold':
      return `cold · ${rewarm}`
    default:
      return `${formatCountdown(view.remainingMs)} · ${rewarm}`
  }
}

// The context chip turns yellow once the context passes this share of the auto-compact point.
const COMPACT_NEAR_SHARE = 0.8

/** "ctx 159k/300k" against the auto-compact point while it is on; "ctx 159k 16%" of the window while off. */
function contextChip(view: KeeperView): BandChip {
  const tokens = `ctx ${formatTokens(view.contextTokens)}`
  const at = view.compact.at
  if (at === null) {
    return { text: `${tokens}${view.contextPercent !== undefined ? ` ${view.contextPercent}%` : ''}`, tone: 'neutral' }
  }
  return { text: `${tokens}/${formatTokens(at)}`, tone: view.contextTokens >= at * COMPACT_NEAR_SHARE ? 'warn' : 'neutral' }
}

/** The pane's auto-compact line: "Compacts at 300k (default for this model) · 84k to go", or why it won't. */
export function autoCompactSummary(view: KeeperView): string {
  if (view.compact.at === null) return `Off (${view.compact.source === 'session' ? 'this session' : 'mod setting'})`
  const toGo = view.compact.at - view.contextTokens
  return `Compacts at ${describeCompactPoint(view.compact)} · ${toGo > 0 ? `${formatTokens(toGo)} to go` : 'after the next reply'}`
}

/** The bar's chips, one per group: cache, context fill, then what is left of each rate-limit window. */
export function bandChips(view: KeeperView): BandChip[] {
  const limits = view.rateLimits.map((limit): BandChip => {
    const left = percentLeft(limit)
    return { text: `${SHORT_LIMIT_LABEL[limit.kind] ?? limit.kind} ${left}%`, tone: limitTone(left) }
  })

  return [
    { text: cacheChipText(view), tone: PHASE_TONE[view.phase] },
    contextChip(view),
    ...limits,
  ]
}
