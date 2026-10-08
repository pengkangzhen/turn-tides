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
// local-command echoes and interruption markers ride the same door
const isQuestionText = (text: string): boolean =>
  text !== '' &&
  !text.startsWith('/') &&
  !text.startsWith('<command-name>') &&
  !text.startsWith('[Request interrupted')

const questionFromRow = (parsed: unknown): { id: string; text: string; at: number } | undefined => {
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
    text,
    at: typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : 0,
  }
}

const isAssistantRow = (parsed: unknown): boolean => {
  if (parsed === null || typeof parsed !== 'object') return false
  const row = parsed as { type?: unknown; isSidechain?: unknown }
  return row.type === 'assistant' && row.isSidechain !== true
}

// the whole file is preferred; a transcript past the 4 MiB read cap falls
// back to its last MiB through a host tail, whose partial first line the
// JSON parser drops anyway
const readTranscript = async ($: EngineInterface, path: string): Promise<string | undefined> => {
  const whole = await $.fs.read(path).catch(() => undefined)
  if (whole !== undefined) return whole
  const tail = await $.process.run(['tail', '-c', '1048576', path]).catch(() => undefined)
  return tail === undefined || tail.exitCode !== 0 ? undefined : tail.stdout
}

// A transcript row's uuid is the id its render site draws under and what
// $.ui.scroll takes, so the seeded file and the live appends join on it.
// The assistant rows that follow a question become its answer summary: each
// one overwrites the last, so the row nearest the next question wins.
const seed = async ($: EngineInterface, transcriptPath: string): Promise<void> => {
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
      found.push({ ...asked, answer: '' })
      continue
    }
    if (isAssistantRow(parsed) && found.length > 0) {
      const message = (parsed as { message?: unknown }).message
      const text =
        message !== null && typeof message === 'object'
          ? oneLine(textOf((message as { content?: unknown }).content), ANSWER_CAP)
          : ''
      if (text !== '') found[found.length - 1]!.answer = text
    }
  }
  await update($, questions, () => found)
}

const oneLine = (text: string, room: number): string => {
  const flat = text.replace(/\s+/g, ' ')
  return flat.length > room ? flat.slice(0, Math.max(1, room - 1)) + '…' : flat
}

// a turn's bar width, token-weather's history chart turned horizontal: the
// longer the answer, the longer the bar; the running turn sits at a middle
// width until its answer lands
const barWidth = (q: Question): number => {
  const len = q.answer.length
  if (len === 0) return 3
  if (len <= 40) return 2
  if (len <= 120) return 3
  if (len <= 240) return 4
  return 5
}

// the strip never wraps and no turn is dropped: when the natural widths
// overflow the line, every bar scales by its share of the full budget
// (floored at one column, so the mapping stays monotone — longer answers
// stay visibly longer until the physics of the terminal runs out) and the
// bars touch like token-weather's chart. Only a turn count beyond the raw
// columns degenerates to the newest ones.
const scaleStrip = (
  list: Question[],
  columns: number,
): { bars: Question[]; widths: number[]; gap: number } => {
  const budget = Math.max(24, Math.max(8, columns) - 14)
  const bars = list.length > budget ? list.slice(-budget) : list
  const widths = bars.map(barWidth)
  const sum = widths.reduce((a, b) => a + b, 0)
  const natural = sum + Math.max(0, bars.length - 1)
  if (natural <= budget) return { bars, widths, gap: 1 }
  const k = budget / sum
  return { bars, widths: widths.map(w => Math.max(1, Math.floor(w * k))), gap: 0 }
}

export const register: Register = on => {
  // transcript_path is the one place the session's own file is named; seeding
  // from it recovers the questions asked before this plugin loaded, and on a
  // /clear it re-reads the fresh file, replacing the list wholesale.
  on('classic.SessionStart', async ($, e, next) => {
    await seed($, e.transcript_path)
    return next(e)
  }).catch(($, e, next) => next(e))

  // a plugin loaded mid-session missed the session's start; the first prompt
  // after that still names the transcript, so an empty strip re-seeds there
  on('classic.UserPromptSubmit', async ($, e, next) => {
    const current = await read($, questions)
    if (current.length === 0) await seed($, e.transcript_path)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.append', async ($, e, next) => {
    if (
      e.agentId === undefined &&
      e.door === 'prompt' &&
      e.message.type === 'user' &&
      e.message.isMeta !== true
    ) {
      const text = textOf(e.message.content)
      if (isQuestionText(text)) {
        const at = await $.clock.now()
        await update($, questions, list =>
          list.some(q => q.id === e.uuid)
            ? list
            : [...list, { id: e.uuid, text, answer: '', at }],
        )
      }
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // the turn's own final text becomes the block's hover summary; only the
  // last still-unanswered question takes it, so continuations of a turn
  // that asked nothing change nobody's summary
  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined && e.answer !== '') {
      const summary = oneLine(e.answer, ANSWER_CAP)
      await update($, questions, list => {
        const last = list[list.length - 1]
        if (last === undefined || last.answer !== '') return list
        return [...list.slice(0, -1), { ...last, answer: summary }]
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
                  {` ${oneLine(q.text, room)}`}
                </Text>
                <Text color="black" dimColor>
                  {q.answer === '' ? 'A: …' : `A: ${oneLine(q.answer, room)}`}
                </Text>
              </Box>
            ))}
            <Box flexDirection="row" gap={scaled.gap} paddingX={1}>
              <Text color="cyan" bold>{`≋  ${list.length}`}</Text>
              <Text dimColor>tides</Text>
              {scaled.bars.map((q, i) => (
                <Box
                  key={`b:${q.id}`}
                  backgroundColor="cyan"
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
