/** The last main-thread API activity: when the prompt cache was last refreshed and how big it is. */
export type CacheTouch = { at: number; contextTokens: number; model: string }

/** Handoff flow: idle → pending (handoff turn running) → ready (text captured, waiting for Clear & continue). */
export type CacheHandoff = { status: 'idle' | 'pending' | 'ready'; text: string }

/** Price calibration from the cost ledger: cost at the first observation and weighted token units since. */
export type CacheCalibration = { costStart: number; units: number }

declare module 'claude-code' {
  interface PluginState {
    'cache-keeper': {
      touch: CacheTouch | null
      isRunning: boolean
      turnStartedAt: number | null
      now: number
      observedTtlMs: number | null
      warnedFor: number | null
      autoOpened: boolean
      handoff: CacheHandoff
      calibration: CacheCalibration | null
      /** This session's auto-compact point in tokens, 'off', or null for the mod setting / research default. */
      compactAt: number | 'off' | null
      /** Context tokens when an auto-compaction was last refused; null once one goes through. */
      compactRefusedAt: number | null
    }
  }
}
