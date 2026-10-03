// cache-keeper: watches the prompt cache's TTL, prices a re-warm, warns before it goes cold,
// and turns "handoff → /clear → paste → send" into two button presses.
// Every function that takes $ lives at the top of this file: the engine follows $ only there.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit } from 'claude-code'

import {
  COMPACT_FLOOR_TOKENS,
  COMPACT_REGROW_TOKENS,
  COMPACT_STEP_TOKENS,
  defaultCompactAt,
  describeCompactPoint,
  parseCompactSetting,
  resolveCompactPoint,
  shouldAutoCompact,
} from './auto-compact-policy'
import type { CompactSetting } from './auto-compact-policy'
import {
  MINUTE_MS,
  TTL_1H_MS,
  TTL_5M_MS,
  cacheWriteMultiple,
  formatCountdown,
  formatTokens,
  formatUntil,
  formatUsd,
  resolveInputPrice,
  weightedUnits,
} from './cache-math'
import { LIMIT_LABEL, PHASE_COLOR, TONE_DOT_COLOR, autoCompactSummary, bandChips, headline, percentLeft } from './cache-view-model'
import type { CachePhase, KeeperConfig, KeeperView, TtlSource } from './cache-view-model'

// Session state, held by the host in $.state so it survives hot reloads.
const touchAtom = atom({ plugin: 'cache-keeper', key: 'touch' } as const, null)
const isRunningAtom = atom({ plugin: 'cache-keeper', key: 'isRunning' } as const, false)
const turnStartedAtAtom = atom({ plugin: 'cache-keeper', key: 'turnStartedAt' } as const, null)
// Written by the ticker so drawings that read it redraw as the countdown moves.
const nowAtom = atom({ plugin: 'cache-keeper', key: 'now' } as const, 0)
const observedTtlAtom = atom({ plugin: 'cache-keeper', key: 'observedTtlMs' } as const, null)
// The touch timestamp already warned about, so each cache cycle warns once.
const warnedForAtom = atom({ plugin: 'cache-keeper', key: 'warnedFor' } as const, null)
const autoOpenedAtom = atom({ plugin: 'cache-keeper', key: 'autoOpened' } as const, false)
const handoffAtom = atom({ plugin: 'cache-keeper', key: 'handoff' } as const, {
  status: 'idle',
  text: '',
})
const calibrationAtom = atom({ plugin: 'cache-keeper', key: 'calibration' } as const, null)
const compactAtAtom = atom({ plugin: 'cache-keeper', key: 'compactAt' } as const, null)
const compactRefusedAtAtom = atom({ plugin: 'cache-keeper', key: 'compactRefusedAt' } as const, null)

const PANE_ID = 'cache-keeper'
const PANE_TITLE = 'Cache keeper'
const TICK_MS = 15_000
// Lets the finished turn settle before an auto-compaction starts.
const AUTO_COMPACT_DELAY_MS = 1_000

const KEEP_ALIVE_PROMPT =
  'Prompt-cache keep-alive from the cache-keeper mod. No action needed: reply with just "ok".'

const HANDOFF_ARGS =
  'Put the complete handoff in your final reply, ready to paste as the first message of a fresh session.'

// Used when the configured handoff command is not installed.
const HANDOFF_PROMPT = [
  'Write a session handoff so a fresh session can continue this work without the transcript.',
  'Cover: the objective, decisions made, current state (files, commands, IDs exactly), what is left, and what not to redo.',
  'Reply with the handoff only, written as the first message of the new session.',
].join(' ')

// ---------------------------------------------------------------- view

/** The TTL in force: the configured one, else what a gap proved, else 1h on a subscription and 5m off one. */
async function resolveTtl(
  $: EngineInterface,
  config: KeeperConfig,
  rateLimits: SessionRateLimit[],
): Promise<{ ms: number; source: TtlSource }> {
  if (config.cacheTtl === '1h') return { ms: TTL_1H_MS, source: 'config' }
  if (config.cacheTtl === '5m') return { ms: TTL_5M_MS, source: 'config' }
  const observed = await read($, observedTtlAtom)
  if (observed !== null) return { ms: observed, source: 'observed' }
  return { ms: rateLimits.length > 0 ? TTL_1H_MS : TTL_5M_MS, source: 'assumed' }
}

/** Reads state and the session's usage figures into one view; reading from a render subscribes it. */
async function computeView($: EngineInterface, config: KeeperConfig): Promise<KeeperView> {
  const ticked = await read($, nowAtom)
  const now = ticked > 0 ? ticked : await $.clock.now()
  const usage = await $.session.usage()
  const touch = await read($, touchAtom)
  const isRunning = await read($, isRunningAtom)
  const ttl = await resolveTtl($, config, usage.rateLimits)

  const contextTokens = usage.context.tokens ?? touch?.contextTokens ?? 0
  const model = touch?.model ?? (await $.session.model())
  const price = resolveInputPrice(
    config.inputPricePerMTok,
    await read($, calibrationAtom),
    usage.cost?.usd,
    model,
  )
  const remainingMs = touch ? touch.at + ttl.ms - now : 0

  let phase: CachePhase = 'empty'
  if (isRunning) phase = 'running'
  else if (touch && remainingMs <= 0) phase = 'cold'
  else if (touch && remainingMs <= config.warnMs) phase = 'cooling'
  else if (touch) phase = 'warm'

  return {
    phase,
    now,
    remainingMs,
    ttlMs: ttl.ms,
    ttlSource: ttl.source,
    touchAt: touch?.at ?? null,
    contextTokens,
    contextWindow: usage.context.window,
    contextPercent: usage.context.percent,
    rewarmUsd: contextTokens * price.perToken * cacheWriteMultiple(ttl.ms),
    priceSource: price.source,
    rateLimits: usage.rateLimits,
    costUsd: usage.cost?.usd,
    compact: resolveCompactPoint(await read($, compactAtAtom), config.autoCompact, usage.context.window),
  }
}

/** Moves the countdown, refreshes the status line, and warns once per cache cycle. */
async function tick($: EngineInterface, config: KeeperConfig): Promise<void> {
  const now = await $.clock.now()
  await update($, nowAtom, () => now)
  const view = await computeView($, config)

  if (view.phase !== 'cooling' || view.touchAt === null) return
  if ((await read($, warnedForAtom)) === view.touchAt) return
  await update($, warnedForAtom, () => view.touchAt)
  $.ui.toast(
    `Cache goes cold in ${formatCountdown(view.remainingMs)}; re-warming ${formatTokens(view.contextTokens)} tokens ` +
      `would cost ≈${formatUsd(view.rewarmUsd)}. Keep warm, compact or hand off from the band above the prompt.`,
    { timeoutMs: 15_000 },
  )
}

// ---------------------------------------------------------------- actions

/** Runs an action without letting a failure escape the press or command that started it. */
function runAction($: EngineInterface, label: string, action: () => Promise<unknown>): void {
  void action().catch((error: unknown) => {
    $.ui.toast(`cache-keeper: ${label} failed: ${error instanceof Error ? error.message : String(error)}`)
  })
}

async function keepWarm($: EngineInterface): Promise<void> {
  await $.prompt.submit({ text: KEEP_ALIVE_PROMPT })
}

async function compactNow($: EngineInterface): Promise<void> {
  await $.command.run({ command: 'compact' })
}

/** Starts the handoff turn; turn.complete captures its answer as the handoff text. */
async function startHandoff($: EngineInterface, config: KeeperConfig): Promise<void> {
  const names = (await $.command.list()).map(command => command.name)
  const wanted = config.handoffCommand.replace(/^\//, '')
  const command =
    names.find(name => name === wanted) ??
    names.find(name => name === 'context-handoff' || name.endsWith(':context-handoff'))

  await update($, handoffAtom, () => ({ status: 'pending', text: '' }))
  try {
    if (command) await $.command.run({ command, args: HANDOFF_ARGS })
    else await $.prompt.submit({ text: HANDOFF_PROMPT })
  } catch (error) {
    await update($, handoffAtom, () => ({ status: 'idle', text: '' }))
    throw error
  }
}

/** /clear, then sends the captured handoff as the first prompt of the fresh conversation. */
async function clearAndContinue($: EngineInterface): Promise<void> {
  const handoff = await read($, handoffAtom)
  const text = handoff.text.trim()
  if (handoff.status !== 'ready' || text === '') {
    $.ui.toast('cache-keeper: no handoff ready yet. Press Handoff first.')
    return
  }
  await update($, handoffAtom, () => ({ status: 'idle', text: '' }))
  await $.command.run({ command: 'clear' })
  await $.prompt.submit({ text, asUser: true })
}

/**
 * Compacts between turns once the context reaches the point in force. A refusal or failure
 * waits for more context before trying again, so it never repeats every turn.
 */
async function autoCompact($: EngineInterface, config: KeeperConfig): Promise<void> {
  if (await read($, isRunningAtom)) return
  if ((await read($, handoffAtom)).status !== 'idle') return
  const view = await computeView($, config)
  if (!shouldAutoCompact(view.contextTokens, view.compact.at, await read($, compactRefusedAtAtom))) return

  $.ui.toast(`Auto-compacting at ${formatTokens(view.contextTokens)} · point ${describeCompactPoint(view.compact)}`)
  let reason: string
  try {
    const result = await $.session.compact()
    if (result.skip === undefined) return
    reason = result.skip
  } catch (error) {
    if (await read($, isRunningAtom)) return // a turn started first: try again when it ends
    reason = error instanceof Error ? error.message : String(error)
  }
  await update($, compactRefusedAtAtom, () => view.contextTokens)
  $.ui.toast(
    `cache-keeper: auto-compact did not run (${reason}). Next try after ${formatTokens(COMPACT_REGROW_TOKENS)} more context.`,
  )
}

/** Sets this session's auto-compact point; null hands it back to the mod setting / research default. */
async function setSessionCompact($: EngineInterface, value: CompactSetting | null): Promise<void> {
  await update($, compactAtAtom, () => value)
  await update($, compactRefusedAtAtom, () => null)
}

async function discardHandoff($: EngineInterface): Promise<void> {
  await update($, handoffAtom, () => ({ status: 'idle', text: '' }))
}

/** Opens the details pane; pressed or typed, so the surface places it at any width. */
async function openPane($: EngineInterface): Promise<void> {
  const opened = await $.ui.open({ id: PANE_ID, title: PANE_TITLE })
  if (!opened.isPlaced) $.ui.toast(`cache-keeper: the details pane could not open (${opened.reason}).`)
}

// ---------------------------------------------------------------- hooks

export const register: Register = (on, options) => {
  const config: KeeperConfig = {
    cacheTtl: String(options.cacheTtl ?? 'auto'),
    warnMs: Math.max(1, Number(options.warnMinutes ?? 5)) * MINUTE_MS,
    inputPricePerMTok: Number(options.inputPricePerMTok ?? 0),
    handoffCommand: String(options.handoffCommand ?? 'anthropic-skills:context-handoff'),
    autoCompact: parseCompactSetting(String(options.autoCompact ?? 'auto')) ?? 'auto',
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'cache-keeper',
      description: 'Prompt-cache countdown and handoff: open, warm, compact, handoff, continue',
      argumentHint: '[open|warm|compact|handoff|continue|autocompact <250k|off|auto>]',
    })
    if ((await read($, calibrationAtom)) === null) {
      const cost = (await $.session.usage()).cost?.usd
      if (cost !== undefined) await update($, calibrationAtom, () => ({ costStart: cost, units: 0 }))
    }
    // The bar above the prompt shows everything; clear a status entry left by an earlier version.
    $.ui.status(undefined)
    $.clock.every(TICK_MS, () => void tick($, config))
    await tick($, config)

    return next(e)
  })

  on('command.run', { command: 'cache-keeper' }, async ($, e) => {
    const [first = '', ...rest] = e.args.trim().toLowerCase().split(/\s+/)
    const verb = first || 'open'
    if (verb === 'autocompact') {
      const setting = parseCompactSetting(rest.join(''))
      if (setting === undefined) return { text: 'Usage: /cache-keeper autocompact <250k|off|auto>' }
      const sessionValue = setting === 'auto' ? null : setting
      await setSessionCompact($, sessionValue)
      const window = (await $.session.usage()).context.window
      return { text: `cache-keeper: auto-compact for this session at ${describeCompactPoint(resolveCompactPoint(sessionValue, config.autoCompact, window))}` }
    }
    // Fire-and-forget: these queue a command or prompt that runs once this one finishes.
    if (verb === 'warm') runAction($, 'keep warm', () => keepWarm($))
    else if (verb === 'compact') runAction($, 'compact', () => compactNow($))
    else if (verb === 'handoff') runAction($, 'handoff', () => startHandoff($, config))
    else if (verb === 'continue') runAction($, 'clear & continue', () => clearAndContinue($))
    else if (verb === 'open') await openPane($)
    else return { text: 'Usage: /cache-keeper [open|warm|compact|handoff|continue|autocompact <250k|off|auto>]' }

    return { text: `cache-keeper: ${verb}` }
  })

  on('turn.start', async ($, e, next) => {
    const now = await $.clock.now()
    await update($, isRunningAtom, () => true)
    await update($, turnStartedAtAtom, () => now)
    void tick($, config)

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    const usage = await $.session.usage()
    const ttl = await resolveTtl($, config, usage.rateLimits)
    const costUsd = usage.cost?.usd

    // Every loop's requests feed the price calibration against the cost ledger.
    if (e.usage && costUsd !== undefined) {
      const units = weightedUnits(e.usage, ttl.ms)
      await update($, calibrationAtom, prev => ({
        costStart: prev?.costStart ?? costUsd,
        units: (prev?.units ?? 0) + units,
      }))
    }
    if (e.agentId !== undefined) return result // a subagent's cache is not the main thread's

    const now = await $.clock.now()
    const prev = await read($, touchAtom)
    const startedAt = await read($, turnStartedAtAtom)
    await update($, isRunningAtom, () => false)

    // A gap between 5m and 1h tells the TTL apart: a 5m cache had to re-write the whole prefix.
    if (e.usage && prev && startedAt !== null && prev.contextTokens > 10_000) {
      const gap = startedAt - prev.at
      if (gap > TTL_5M_MS + 30_000 && gap < TTL_1H_MS - MINUTE_MS) {
        const rewrote = e.usage.cache_creation_input_tokens >= 0.5 * prev.contextTokens
        await update($, observedTtlAtom, () => (rewrote ? TTL_5M_MS : TTL_1H_MS))
      }
    }
    // Only a turn that reached the API refreshes the cache; an early interrupt leaves the old clock.
    if (e.usage) {
      const model = e.usage.model
      const contextTokens = usage.context.tokens ?? prev?.contextTokens ?? 0
      await update($, touchAtom, () => ({ at: now, contextTokens, model }))
    }

    const handoff = await read($, handoffAtom)
    if (handoff.status === 'pending') {
      const isAnswered = e.reason === 'answer' && e.answer.trim() !== ''
      await update($, handoffAtom, () =>
        isAnswered ? { status: 'ready', text: e.answer } : { status: 'idle', text: '' },
      )
      $.ui.toast(isAnswered ? 'Handoff ready: press Clear & continue.' : 'Handoff did not finish.')
    }

    if (!(await read($, autoOpenedAtom))) {
      await update($, autoOpenedAtom, () => true)
      void $.ui.open({ id: PANE_ID, title: PANE_TITLE })
    }
    await tick($, config)
    // Only after a finished answer: an interrupted turn means the person is steering, so leave the context alone.
    if (e.reason === 'answer') $.clock.after(AUTO_COMPACT_DELAY_MS, () => void autoCompact($, config))

    return result
  })

  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (result.skip !== undefined) return result
    if (result.usage) {
      const ttl = await resolveTtl($, config, (await $.session.usage()).rateLimits)
      const units = weightedUnits(result.usage, ttl.ms)
      await update($, calibrationAtom, prev => (prev ? { ...prev, units: prev.units + units } : prev))
    }
    // The summarized conversation is a new prefix: nothing of it is cached until the next request.
    await update($, touchAtom, () => null)
    await update($, compactRefusedAtAtom, () => null)
    void tick($, config)

    return result
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, touchAtom, () => null)
      await update($, isRunningAtom, () => false)
      await update($, turnStartedAtAtom, () => null)
      await update($, warnedForAtom, () => null)
      void tick($, config)
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const view = await computeView($, config)
    const handoff = await read($, handoffAtom)
    const ttlLabel = view.ttlMs >= TTL_1H_MS ? '1h' : '5m'
    const hasActions = view.phase !== 'running' && view.phase !== 'empty' && handoff.status === 'idle'
    // The − / + buttons and "Turn on" start from the point in force, else this model's default.
    const compactBase = view.compact.at ?? defaultCompactAt(view.contextWindow) ?? COMPACT_FLOOR_TOKENS
    const compactCeiling = view.contextWindow > 0 ? view.contextWindow : Number.POSITIVE_INFINITY

    return (
      <Box flexDirection="column">
        <Text bold color={PHASE_COLOR[view.phase]}>
          {headline(view)}
        </Text>
        <Text dimColor>
          TTL {ttlLabel} ({view.ttlSource}) · re-warm if cold ≈{formatUsd(view.rewarmUsd)} ({view.priceSource} price)
        </Text>
        <Text> </Text>
        <Text>
          Context {formatTokens(view.contextTokens)} / {formatTokens(view.contextWindow)}
          {view.contextPercent !== undefined ? ` (${view.contextPercent}%)` : ''}
        </Text>
        {view.rateLimits.map(limit => (
          <Text>
            {LIMIT_LABEL[limit.kind] ?? limit.kind} {percentLeft(limit)}% left
            {formatUntil(limit.resetsAt, view.now) ? ` · resets in ${formatUntil(limit.resetsAt, view.now)}` : ''}
          </Text>
        ))}
        {view.costUsd !== undefined && <Text>Session at API rates {formatUsd(view.costUsd)}</Text>}

        {/* Auto-compact gets its own titled section so its buttons don't read as part of the actions below. */}
        <Box flexDirection="column" marginTop={1}>
          <Text bold>Auto-compact</Text>
          <Text dimColor>{autoCompactSummary(view)}</Text>
        </Box>
        <Box flexDirection="row" gap={2}>
          <Button
            key="compact-less"
            label={`Sooner −${formatTokens(COMPACT_STEP_TOKENS)}`}
            onPress={() =>
              runAction($, 'auto-compact', () =>
                setSessionCompact($, Math.max(COMPACT_STEP_TOKENS, compactBase - COMPACT_STEP_TOKENS)),
              )
            }
          />
          <Button
            key="compact-more"
            label={`Later +${formatTokens(COMPACT_STEP_TOKENS)}`}
            onPress={() =>
              runAction($, 'auto-compact', () =>
                setSessionCompact($, Math.min(compactCeiling, compactBase + COMPACT_STEP_TOKENS)),
              )
            }
          />
          <Button
            key="compact-toggle"
            label={view.compact.at === null ? 'Turn on' : 'Turn off'}
            onPress={() =>
              runAction($, 'auto-compact', () => setSessionCompact($, view.compact.at === null ? compactBase : 'off'))
            }
          />
          {view.compact.source === 'session' && (
            <Button
              key="compact-reset"
              label="Reset to default"
              onPress={() => runAction($, 'auto-compact', () => setSessionCompact($, null))}
            />
          )}
        </Box>

        {hasActions && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>Actions</Text>
            <Box flexDirection="row" gap={2}>
              <Button key="warm" label="🔥 Keep warm" onPress={() => runAction($, 'keep warm', () => keepWarm($))} />
              <Button key="compact" label="📦 Compact now" onPress={() => runAction($, 'compact', () => compactNow($))} />
              <Button
                key="handoff"
                label="🤝 Handoff"
                onPress={() => runAction($, 'handoff', () => startHandoff($, config))}
              />
            </Box>
          </Box>
        )}
        {handoff.status === 'pending' && <Text color="yellow">Handoff running…</Text>}
        {handoff.status === 'ready' && (
          <Box flexDirection="row">
            <Text color="green">Handoff ready ({formatTokens(handoff.text.length)} chars) </Text>
            <Button
              key="continue"
              label="Clear & continue"
              variant="primary"
              onPress={() => runAction($, 'clear & continue', () => clearAndContinue($))}
            />
            <Text> </Text>
            <Button key="discard" label="Discard" onPress={() => runAction($, 'discard', () => discardHandoff($))} />
          </Box>
        )}
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const view = await computeView($, config)
    const handoff = await read($, handoffAtom)

    const { Box, Button, Text } = $.ui.resolve(e)
    if (handoff.status === 'ready') {
      return (
        <Box flexDirection="row" justifyContent="space-between">
          <Text color="green">Handoff ready.</Text>
          <Box flexDirection="row" flexShrink={0} gap={1}>
            <Button
              key="band-continue"
              label="Clear & continue"
              variant="primary"
              onPress={() => runAction($, 'clear & continue', () => clearAndContinue($))}
            />
            <Button key="band-discard" label="Discard" onPress={() => runAction($, 'discard', () => discardHandoff($))} />
          </Box>
        </Box>
      )
    }

    // Always-on bar: the figures at a glance, then the actions (hidden before the first reply and while a turn runs).
    const hasActions = view.phase !== 'empty' && view.phase !== 'running' && handoff.status === 'idle'

    // Figures on the left (growing to fill the row), buttons pinned to the right edge.
    return (
      <Box flexDirection="row" justifyContent="space-between">
        {/*
          One outlined pill per group: a faint rounded border, gray text, a small colored dot for status.
          height={1} holds the pill to one text row; without it the desktop pads the border well above and below the text.
        */}
        <Box flexDirection="row" flexGrow={1} flexShrink={1} gap={1}>
          {[...bandChips(view), ...(handoff.status === 'pending' ? [{ text: 'handoff running…', tone: 'warn' as const }] : [])].map(
            chip => (
              <Box flexDirection="row" flexShrink={0} borderStyle="round" borderDimColor paddingX={1} height={1}>
                {TONE_DOT_COLOR[chip.tone] && <Text color={TONE_DOT_COLOR[chip.tone]}>● </Text>}
                <Text dimColor>{chip.text}</Text>
              </Box>
            ),
          )}
        </Box>
        {/* One-glyph buttons to save width; the Details pane carries the same actions with word labels. */}
        <Box flexDirection="row" flexShrink={0} gap={1}>
          {hasActions && view.phase !== 'cold' && (
            <Button key="band-warm" label="🔥" onPress={() => runAction($, 'keep warm', () => keepWarm($))} />
          )}
          {hasActions && (
            <Button key="band-compact" label="📦" onPress={() => runAction($, 'compact', () => compactNow($))} />
          )}
          {hasActions && (
            <Button
              key="band-handoff"
              label="🤝"
              onPress={() => runAction($, 'handoff', () => startHandoff($, config))}
            />
          )}
          <Button key="band-details" label="📊" onPress={() => runAction($, 'details', () => openPane($))} />
        </Box>
      </Box>
    )
  })
}
