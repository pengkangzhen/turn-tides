import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Question } from '../types'

const questions = atom({ plugin: 'turn-tides', key: 'questions' } as const, [])

// answers live only in the hover summary, so a short one-line summary is all
// the state keeps
const ANSWER_CAP = 240

const textOf = (content: unknown): string => {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const typed = block as { type?: unknown; text?: unknown }
    if (typed.type === 'text' && typeof typed.text === 'string') parts.push(typed.text)
  }
  return parts.join(' ').trim()
}

// not every user-role row is a question the person typed: slash commands,
// local-command echoes (the !-passthrough envelope is <bash-input> for the
// command line and <bash-stdout> for its output, two separate rows),
// interruption markers and caveats ride the same door
const isLocalEcho = (text: string): boolean =>
  text.startsWith('<command-name>') ||
  text.startsWith('<bash-') ||
  text.startsWith('<local-command')

const isQuestionText = (text: string): boolean =>
  text !== '' && !text.startsWith('/') && !isLocalEcho(text) && !text.startsWith('[Request interrupted')

const questionFromRow = (
  parsed: unknown,
): { id: string; kind: 'ask'; text: string; at: number } | undefined => {
  if (parsed === null || typeof parsed !== 'object') return undefined
  const row = parsed as {
    type?: unknown
    isMeta?: unknown
    isSidechain?: unknown
    uuid?: unknown
    timestamp?: unknown
    message?: unknown
  }
  if (row.type !== 'user' || row.isMeta === true || row.isSidechain === true) return undefined
  if (typeof row.uuid !== 'string' || row.message === null || typeof row.message !== 'object')
    return undefined
  const text = textOf((row.message as { content?: unknown }).content)
  if (!isQuestionText(text)) return undefined
  return {
    id: row.uuid,
    kind: 'ask' as const,
    text,
    at: typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : 0,
  }
}

// a `!`-passthrough shell command the person ran from the prompt: its row
// wraps the command line in <bash-input> tags
const commandFromRow = (
  parsed: unknown,
): { id: string; kind: 'command'; text: string; at: number } | undefined => {
  if (parsed === null || typeof parsed !== 'object') return undefined
  const row = parsed as {
    type?: unknown
    isMeta?: unknown
    isSidechain?: unknown
    uuid?: unknown
    timestamp?: unknown
    message?: unknown
  }
  if (row.type !== 'user' || row.isMeta === true || row.isSidechain === true) return undefined
  if (typeof row.uuid !== 'string' || row.message === null || typeof row.message !== 'object')
    return undefined
  const text = textOf((row.message as { content?: unknown }).content)
  if (!text.startsWith('<bash-input>')) return undefined
  const line = /^<bash-input>([\s\S]*?)<\/bash-input>/.exec(text)?.[1]?.trim()
  if (line === undefined || line === '') return undefined
  return {
    id: row.uuid,
    kind: 'command' as const,
    text: line,
    at: typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : 0,
  }
}

const isAssistantRow = (parsed: unknown): boolean => {
  if (parsed === null || typeof parsed !== 'object') return false
  const row = parsed as { type?: unknown; isSidechain?: unknown }
  return row.type === 'assistant' && row.isSidechain !== true
}

// the whole file is preferred; a transcript past the 4 MiB read cap is
// walked in contiguous 4 MiB windows through host commands (tail from a
// byte offset, the engine capping each run's stdout at 4 MiB), the windows
// joined back into one text — every turn in the file is reachable, however
// long the session. A row cut by a window boundary may parse nowhere; that
// costs at most one turn per 4 MiB.
const WINDOW = 4194304

const readTranscript = async ($: EngineInterface, path: string): Promise<string | undefined> => {
  const whole = await $.fs.read(path).catch(() => undefined)
  if (whole !== undefined) return whole
  const wc = await $.process.run(['wc', '-c', path]).catch(() => undefined)
  const size = Number(wc?.stdout.trim().split(/\s+/)[0])
  if (wc === undefined || wc.exitCode !== 0 || !Number.isFinite(size)) return undefined
  const parts: string[] = []
  for (let start = 1; start <= size; start += WINDOW) {
    const run = await $.process.run(['tail', '-c', `+${start}`, path]).catch(() => undefined)
    if (run === undefined || run.exitCode !== 0) break
    parts.push(run.stdout)
  }
  return parts.length === 0 ? undefined : parts.join('')
}

// A transcript row's uuid is the id its render site draws under and what
// $.ui.scroll takes, so the seeded file and the live appends join on it.
// The assistant rows that follow a question become its answer summary: each
// one overwrites the last, so the row nearest the next question wins.
// merge: a tail-windowed re-seed refreshes what the window covers and keeps
// the turns before it (a wholesale replace would shrink the strip to the
// window); a session start still replaces wholesale — a /clear must reset
const seed = async (
  $: EngineInterface,
  transcriptPath: string,
  merge = false,
): Promise<void> => {
  if (transcriptPath === '') return
  const file = await readTranscript($, transcriptPath)
  if (file === undefined) return
  const found: Question[] = []
  for (const line of file.split('\n')) {
    if (line === '') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    const asked = questionFromRow(parsed)
    if (asked !== undefined) {
      found.push({ ...asked, answer: '', tokens: 0 })
      continue
    }
    const command = commandFromRow(parsed)
    if (command !== undefined) {
      found.push({ ...command, answer: '', tokens: 0 })
      continue
    }
    if (isAssistantRow(parsed) && found.length > 0 && found[found.length - 1]!.kind === 'ask') {
      const message = (parsed as { message?: unknown }).message
      if (message !== null && typeof message === 'object') {
        const typed = message as { content?: unknown; usage?: { output_tokens?: unknown } }
        const text = oneLine(textOf(typed.content), ANSWER_CAP)
        if (text !== '') found[found.length - 1]!.answer = text
        const out = typed.usage?.output_tokens
        if (typeof out === 'number') found[found.length - 1]!.tokens += out
      }
    }
  }
  await update($, questions, list => {
    if (!merge) return found
    const byId = new Map(list.map(q => [q.id, q] as const))
    for (const q of found) byId.set(q.id, q)
    return [...byId.values()].sort((a, b) => a.at - b.at)
  })
}

const oneLine = (text: string, room: number): string => {
  const flat = text.replace(/\s+/g, ' ')
  return flat.length > room ? flat.slice(0, Math.max(1, room - 1)) + '…' : flat
}

const shortTokens = (n: number): string =>
  n >= 1000 ? `${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}k` : String(n)

// dynamic widths, token-weather's rule ("bars scale to the busiest reading
// shown, so growth shows at any fill level"): an ask's width spreads 2..5
// across the logarithm of its output tokens between the quietest and the
// busiest turns in view, so the strip always shows its full range no matter
// how the session's absolute numbers cluster, and ties stay ties. The
// running turn (its tokens not yet in) matches the latest known one; a
// !-command is a single column of its own
const rawWidths = (bars: Question[]): number[] => {
  const known = bars.filter(q => q.kind === 'ask' && q.tokens > 0).map(q => q.tokens)
  if (known.length === 0) return bars.map(q => (q.kind === 'command' ? 1 : 3))
  const lo = Math.log(Math.min(...known))
  const hi = Math.log(Math.max(...known))
  const spread = hi - lo
  const widthOf = (t: number): number =>
    spread === 0 ? 3 : 2 + Math.round((3 * (Math.log(t) - lo)) / spread)
  let fallback = 3
  for (let i = bars.length - 1; i >= 0; i -= 1) {
    if (bars[i]!.kind === 'ask' && bars[i]!.tokens > 0) {
      fallback = widthOf(bars[i]!.tokens)
      break
    }
  }
  return bars.map(q => (q.kind === 'command' ? 1 : q.tokens > 0 ? widthOf(q.tokens) : fallback))
}

// the strip never wraps and no turn is dropped: when the natural widths
// overflow the line, the one-column gaps are reserved first and every bar
// scales by its share of what remains (floored at one column, so the mapping
// stays monotone — busier turns stay visibly longer until the physics of the
// terminal runs out). Only when even one-column bars with gaps cannot fit do
// the gaps give way and the bars touch, token-weather's chart style; a turn
// count beyond the raw columns degenerates to the newest ones.
const scaleStrip = (
  list: Question[],
  columns: number,
): { bars: Question[]; widths: number[]; gap: number } => {
  const budget = Math.max(24, Math.max(8, columns) - 14)
  const bars = list.length > budget ? list.slice(-budget) : list
  const widths = rawWidths(bars)
  const sum = widths.reduce((a, b) => a + b, 0)
  const gaps = bars.length - 1
  if (sum + gaps <= budget) return { bars, widths, gap: 1 }
  if (bars.length + gaps <= budget) {
    const k = (budget - gaps) / sum
    return { bars, widths: widths.map(w => Math.max(1, Math.floor(w * k))), gap: 1 }
  }
  const k = budget / sum
  return { bars, widths: widths.map(w => Math.max(1, Math.floor(w * k))), gap: 0 }
}

export const register: Register = on => {
  // a fresh module copy re-seeds on the first prompt after it loads: an
  // incremental list built by an older schema (turns recorded before the
  // tokens field, say) would otherwise keep its stale widths forever; later
  // prompts only re-seed when the strip stands empty
  let seededThisCopy = false

  // transcript_path is the one place the session's own file is named; seeding
  // from it recovers the questions asked before this plugin loaded, and on a
  // /clear it re-reads the fresh file, replacing the list wholesale.
  on('classic.SessionStart', async ($, e, next) => {
    await seed($, e.transcript_path)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.UserPromptSubmit', async ($, e, next) => {
    if (!seededThisCopy) {
      seededThisCopy = true
      await seed($, e.transcript_path, true)
    } else if ((await read($, questions)).length === 0) {
      await seed($, e.transcript_path, true)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.append', async ($, e, next) => {
    if (
      e.agentId === undefined &&
      (e.door === 'prompt' || e.door === 'command') &&
      e.message.type === 'user' &&
      e.message.isMeta !== true
    ) {
      const text = textOf(e.message.content)
      // a !-passthrough command arrives wrapped in <bash-input>; a slash
      // command's echo in <command-name> stays out of the strip
      const kind: Question['kind'] = text.startsWith('<bash-input>') ? 'command' : 'ask'
      const body =
        kind === 'command'
          ? (/^<bash-input>([\s\S]*?)<\/bash-input>/.exec(text)?.[1] ?? '').trim()
          : text
      if ((kind === 'ask' && isQuestionText(text)) || (kind === 'command' && body !== '')) {
        const at = await $.clock.now()
        await update($, questions, list =>
          list.some(q => q.id === e.uuid)
            ? list
            : [...list, { id: e.uuid, kind, text: body, answer: '', tokens: 0, at }],
        )
      }
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // the turn's own final text becomes the ask's hover summary; only the last
  // still-unanswered ask takes it, so continuations of a turn that asked
  // nothing change nobody's summary and !-commands never take one
  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined && e.answer !== '') {
      const summary = oneLine(e.answer, ANSWER_CAP)
      await update($, questions, list => {
        const last = list[list.length - 1]
        if (last === undefined || last.kind !== 'ask' || last.answer !== '') return list
        return [
          ...list.slice(0, -1),
          { ...last, answer: summary, tokens: e.usage?.output_tokens ?? 0 },
        ]
      })
    }
    return next(e)
  })

  // the strip lives in the band above the prompt, in token-weather's visual
  // language: a bold icon+word lead whose colour mirrors the live state, a
  // bar per turn whose width reads the answer's length (its history chart,
  // horizontal), dim for everything secondary. Hovering a bar unfolds that
  // turn's summary above the strip (a hover group ties the two, the only way
  // hover talks).
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = await read($, questions)
    const room = Math.max(4, Math.max(8, e.props.bodyColumns) - 6)
    const scaled = scaleStrip(list, e.props.bodyColumns)

    // compose with the other band mods (token-weather, replay-theater):
    // ours on top, whatever the chain beneath draws kept below it
    return (
      <Box flexDirection="column">
        {list.length === 0 ? (
          <Text dimColor>≋  Tides — awaiting the first turn</Text>
        ) : (
          <Box flexDirection="column">
            {list.map((q, i) => (
              <Box
                key={`d:${q.id}`}
                display="none"
                hover={{ display: 'flex', scope: `q:${q.id}` }}
                backgroundColor="#d0f0f4"
                flexDirection="column"
                paddingX={1}
              >
                <Text color="black">
                  <Text bold>{`#${i + 1}`}</Text>
                  {` ${q.kind === 'command' ? '$ ' : ''}${oneLine(q.text, room)}`}
                </Text>
                <Text color="black" dimColor>
                  {q.kind === 'command'
                    ? '! local command'
                    : q.answer === ''
                      ? 'A: …'
                      : `A: ${oneLine(q.answer, room)}`}
                  {q.kind === 'ask' && q.tokens > 0 ? `  ↓${shortTokens(q.tokens)}` : ''}
                </Text>
              </Box>
            ))}
            <Box flexDirection="row" gap={scaled.gap} paddingX={1}>
              <Text color="cyan" bold>{`≋  ${list.length}`}</Text>
              <Text dimColor>tides</Text>
              {scaled.bars.map((q, i) => (
                <Box
                  key={`b:${q.id}`}
                  backgroundColor={q.kind === 'command' ? 'magenta' : 'cyan'}
                  hover={{ scope: `q:${q.id}` }}
                >
                  <Button
                    key={`q:${q.id}`}
                    plain
                    label={' '.repeat(scaled.widths[i]!)}
                    onPress={() =>
                      void $.ui.scroll({ to: { requestId: q.id }, block: 'start' }).catch(
                        () => undefined,
                      )
                    }
                  />
                </Box>
              ))}
            </Box>
          </Box>
        )}
        {await next(e)}
      </Box>
    )
  })
}
