// When cache-keeper compacts by itself: the research-backed default point per context window,
// the per-session and global overrides, and the guard that keeps a refused compaction from retrying every turn.
import { formatTokens } from './cache-math'

/** A compact point in context tokens, or auto-compact turned off. */
export type CompactSetting = number | 'off'

export type CompactSource = 'session' | 'setting' | 'default'

export type CompactPoint = { at: number | null; source: CompactSource }

// Long-context recall on Claude models falls off well before a 1M window fills (MRCR v2: ~93% at
// 256k, ~76% at 1M), so 1M-window models compact at a fixed 300k rather than a share of the window.
const LARGE_WINDOW_TOKENS = 500_000
const LARGE_WINDOW_COMPACT_AT = 300_000
// Smaller windows (200k) compact at 70%, early enough to leave room for the summary turn itself.
const SMALL_WINDOW_SHARE = 0.7
// Below this, a compaction saves less than the fresh cache write it causes; the default never fires lower.
export const COMPACT_FLOOR_TOKENS = 100_000
// After a compaction is refused, wait for this much more context before asking again.
export const COMPACT_REGROW_TOKENS = 50_000
// A typed point below this is a typo (a "50" meant as 50k), not a request to compact every turn.
const MIN_TYPED_TOKENS = 10_000
// Step of the pane's − / + buttons.
export const COMPACT_STEP_TOKENS = 50_000

/** The research default for a model with this context window; null when the window is unknown. */
export function defaultCompactAt(contextWindow: number): number | null {
  if (!(contextWindow > 0)) return null
  if (contextWindow >= LARGE_WINDOW_TOKENS) return LARGE_WINDOW_COMPACT_AT
  return Math.max(COMPACT_FLOOR_TOKENS, Math.round(contextWindow * SMALL_WINDOW_SHARE))
}

/**
 * Reads "off", "auto", "250k", "1.2m" or "250000"; undefined when it is none of these.
 * "auto" means: no override at this level.
 */
export function parseCompactSetting(raw: string): CompactSetting | 'auto' | undefined {
  const text = raw.trim().toLowerCase().replace(/[\s,_]/g, '')
  if (text === 'off' || text === 'auto') return text
  const match = /^(\d+(?:\.\d+)?)([km]?)$/.exec(text)
  if (!match) return undefined
  const tokens = Math.round(Number(match[1]) * (match[2] === 'm' ? 1e6 : match[2] === 'k' ? 1e3 : 1))
  return tokens >= MIN_TYPED_TOKENS ? tokens : undefined
}

/** The point in force: this session's override, else the mod setting, else the research default. */
export function resolveCompactPoint(
  session: CompactSetting | null,
  setting: CompactSetting | 'auto',
  contextWindow: number,
): CompactPoint {
  if (session !== null) return { at: session === 'off' ? null : session, source: 'session' }
  if (setting !== 'auto') return { at: setting === 'off' ? null : setting, source: 'setting' }
  return { at: defaultCompactAt(contextWindow), source: 'default' }
}

/** True when the context has reached the point and has grown enough since a refused attempt. */
export function shouldAutoCompact(contextTokens: number, at: number | null, refusedAt: number | null): boolean {
  if (at === null || contextTokens < at) return false
  return refusedAt === null || contextTokens >= refusedAt + COMPACT_REGROW_TOKENS
}

const SOURCE_LABEL: Record<CompactSource, string> = {
  session: 'this session',
  setting: 'mod setting',
  default: 'default for this model',
}

/** "300k (default for this model)" or "off (this session)". */
export function describeCompactPoint(point: CompactPoint): string {
  return `${point.at === null ? 'off' : formatTokens(point.at)} (${SOURCE_LABEL[point.source]})`
}
