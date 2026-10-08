export type Question = {
  /**
   * The prompt's row id: session.append's uuid, the UserMessage render site's
   * requestId, and what $.ui.scroll({ to: { requestId } }) takes.
   */
  id: string
  /**
   * 'ask': a question the person typed, with the turn's answer as summary.
   * 'command': a `!`-passthrough shell command the person ran; one bar,
   * its own colour, no answer.
   */
  kind: 'ask' | 'command'
  /**
   * The prompt's text blocks joined, as first asked; for a command, the
   * command line itself.
   */
  text: string
  /**
   * The turn's final visible answer, collapsed to one line and capped;
   * '' until the turn ends.
   */
  answer: string
  /**
   * When it was asked, in $.clock.now()'s milliseconds (Date.parse of the
   * transcript's timestamp when seeded from the file).
   */
  at: number
}

declare module 'claude-code' {
  interface PluginState {
    'turn-tides': { questions: Question[] }
  }
}
