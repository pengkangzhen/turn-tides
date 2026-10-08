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
    const command = commandFromRow(parsed)
    if (command !== undefined) {
      found.push({ ...command, answer: '' })
      continue
    }
    if (isAssistantRow(parsed) && found.length > 0 && found[found.length - 1]!.kind === 'ask') {
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

// a turn's bar width, token-weather's history chart turned horizontal: an
// ask reads the volume of its question and answer together (the longer the
// exchange, the longer the bar); a !-command is a single column of its own
const barWidth = (q: Question): number => {
  if (q.kind === 'command') return 1
  const len = q.text.length + q.answer.length
  if (len <= 80) return 2
  if (len <= 200) return 3
  if (len <= 400) return 4
  return 5
}

// the strip never wraps and no turn is dropped: when the natural widths
// overflow the line, the one-column gaps are reserved first and every bar
// scales by its share of what remains (floored at one column, so the mapping
// stays monotone — longer answers stay visibly longer until the physics of
// the terminal runs out). Only when even one-column bars with gaps cannot
// fit do the gaps give way and the bars touch, token-weather's chart style;
// a turn count beyond the raw columns degenerates to the newest ones.
const scaleStrip = (
  list: Question[],
  columns: number,
): { bars: Question[]; widths: number[]; gap: number } => {
  const budget = Math.max(24, Math.max(8, columns) - 14)
  const bars = list.length > budget ? list.slice(-budget) : list
  const widths = bars.map(barWidth)
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
            : [...list, { id: e.uuid, kind, text: body, answer: '', at }],
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
                  {` ${q.kind === 'command' ? '$ ' : ''}${oneLine(q.text, room)}`}
                </Text>
                <Text color="black" dimColor>
                  {q.kind === 'command'
                    ? '! local command'
                    : q.answer === ''
                      ? 'A: …'
                      : `A: ${oneLine(q.answer, room)}`}
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
