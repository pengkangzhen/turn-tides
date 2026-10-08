import { expect, test } from 'claude-code/testing'
import type { RenderPropsOf } from 'claude-code'

const bandProps: RenderPropsOf['AbovePrompt'] = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 8,
  bodyColumns: 60,
  scroll: { offset: 0, bodyRows: 8 },
  view: {},
}

// the same rows as fixture.jsonl, inline: the test environment has no
// filesystem, so the fs.read stub below serves them as the transcript
const fixture = [
  '{"type":"user","uuid":"u-1","timestamp":"2026-10-07T10:00:00Z","message":{"role":"user","content":"first question about supply chain"}}',
  '{"type":"assistant","uuid":"a-1","message":{"role":"assistant","content":[{"type":"text","text":"an answer"}],"usage":{"output_tokens":900}}}',
  '{"type":"user","uuid":"m-1","isMeta":true,"message":{"role":"user","content":"a reminder the engine injected"}}',
  '{"type":"user","uuid":"c-1","message":{"role":"user","content":"/compact history"}}',
  '{"type":"user","uuid":"s-1","isSidechain":true,"message":{"role":"user","content":"a subagent row"}}',
  '{"type":"user","uuid":"x-1","message":{"role":"user","content":"<command-name>/reload-plugins</command-name>"}}',
  '{"type":"user","uuid":"x-2","message":{"role":"user","content":"[Request interrupted by user]"}}',
  '{"type":"user","uuid":"cmd-1","timestamp":"2026-10-07T10:30:00Z","message":{"role":"user","content":"<bash-input>git status</bash-input>\\n<bash-stdout>(Bash completed)</bash-stdout>"}}',
  '{"type":"user","uuid":"cmd-2","message":{"role":"user","content":"<bash-stdout>only the output, no input</bash-stdout>"}}',
  '{"type":"user","uuid":"u-2","timestamp":"2026-10-07T11:00:00Z","message":{"role":"user","content":[{"type":"text","text":"second question"},{"type":"tool_result","tool_use_id":"t-1","content":"ignored"}]}}',
].join('\n')

test('seeds questions with answers and draws the band strip', async ($, on) => {
  // the classic chain has no core behaviour of its own: the test's stub is
  // the bottom the plugins' hooks hand down to
  on('classic.SessionStart', () => ({}))
  on('classic.UserPromptSubmit', () => ({}))
  on('fs.read', (_$, e) =>
    e.path.endsWith('fixture.jsonl') ? { value: fixture } : { deny: 'not the fixture' },
  )
  // the band chain has no core drawing of its own beneath the plugins: the
  // stub is the bottom the compose hooks hand down to
  on('ui.render', () => ({ type: 'Text', children: [''] }))

  await $.classic.SessionStart({ source: 'resume', transcript_path: 'tests/fixture.jsonl' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'turn-tides',
      surface,
      component: 'AbovePrompt',
      requestId: 'band',
      props: bandProps,
    })

    // one chip per question, addressed by key (the label is blank space on
    // the chip's background)
    const blocks = await ui.findAll({ type: 'Button' })
    expect(blocks.length, `${surface} draws one block per turn`).toBe(3)
    expect(await ui.findAll({ type: 'Button', key: 'q:u-1' })).toHaveLength(1)
    expect(await ui.findAll({ type: 'Button', key: 'q:u-2' })).toHaveLength(1)
    expect(await ui.findAll({ type: 'Button', key: 'q:cmd-1' })).toHaveLength(1)
    expect(await ui.findAll({ type: 'Text', text: 'git status' })).not.toHaveLength(0)

    // the hover summary carries the question and the answer seeded from
    // the assistant row that follows it
    expect(await ui.findAll({ type: 'Text', text: 'first question' })).not.toHaveLength(0)
    expect(await ui.findAll({ type: 'Text', text: 'an answer' })).toHaveLength(1)

    // the press runs the jump; with no transcript drawn here the scroll
    // resolves a deny, which must not fail the press
    await ui.press({ key: 'q:u-1' })
    await ui.unmount()
  }
})

test('an empty strip re-seeds from the next prompt', async ($, on) => {
  on('classic.SessionStart', () => ({}))
  on('classic.UserPromptSubmit', () => ({}))
  on('fs.read', (_$, e) =>
    e.path.endsWith('fixture.jsonl') ? { value: fixture } : { deny: 'not the fixture' },
  )
  on('ui.render', () => ({ type: 'Text', children: [''] }))

  // the plugin loads mid-session: the session-start seed never ran, and the
  // first prompt's transcript_path fills the strip
  await $.classic.UserPromptSubmit({ prompt: 'anything', transcript_path: 'tests/fixture.jsonl' })

  const ui = await $.ui.mount({
    plugin: 'turn-tides',
    surface: 'terminal',
    component: 'AbovePrompt',
    requestId: 'band',
    props: bandProps,
  })
  const blocks = await ui.findAll({ type: 'Button' })
  expect(blocks.length).toBe(3)
  await ui.unmount()
})

test('a transcript over the read cap seeds from its tail', async ($, on) => {
  on('classic.SessionStart', () => ({}))
  on('fs.read', () => ({ deny: 'over the 4 MiB cap' }))
  on('process.run', (_$, e) => {
    if (e.argv[0] === 'wc') {
      return { value: { exitCode: 0, stdout: `${fixture.length + 40} tests/fixture.jsonl`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    expect(e.argv.join(' ').endsWith('fixture.jsonl')).toBe(true)
    return {
      value: {
        exitCode: 0,
        stdout: 'partial-line-should-be-dropped\n' + fixture,
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
  on('ui.render', () => ({ type: 'Text', children: [''] }))

  await $.classic.SessionStart({ source: 'resume', transcript_path: 'tests/fixture.jsonl' })

  const ui = await $.ui.mount({
    plugin: 'turn-tides',
    surface: 'terminal',
    component: 'AbovePrompt',
    requestId: 'band',
    props: bandProps,
  })
  expect(await ui.findAll({ type: 'Button' })).toHaveLength(3)
  await ui.unmount()
})

test('a transcript read in chunked windows joins back whole', async ($, on) => {
  on('classic.SessionStart', () => ({}))
  on('fs.read', () => ({ deny: 'over the 4 MiB cap' }))
  on('process.run', (_$, e) => {
    if (e.argv[0] === 'wc') {
      return { value: { exitCode: 0, stdout: `${fixture.length + 40} tests/fixture.jsonl`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    const start = Number(e.argv[2]!.slice(1))
    return {
      value: {
        exitCode: 0,
        stdout: fixture.slice(start - 1),
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
  on('ui.render', () => ({ type: 'Text', children: [''] }))

  await $.classic.SessionStart({ source: 'resume', transcript_path: 'tests/fixture.jsonl' })

  const ui = await $.ui.mount({
    plugin: 'turn-tides',
    surface: 'terminal',
    component: 'AbovePrompt',
    requestId: 'band',
    props: bandProps,
  })
  expect(await ui.findAll({ type: 'Button' })).toHaveLength(3)
  await ui.unmount()
})
