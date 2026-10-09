import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

const isDraft = atom({ plugin: 'msg-queue', key: 'isDraft' } as const, false)
const queue = atom({ plugin: 'msg-queue', key: 'queue' } as const, [] as string[])
// From a turn's start, or the mod's own submit, to that turn's end on the main loop.
const isBusy = atom({ plugin: 'msg-queue', key: 'isBusy' } as const, false)
// Set when a turn ends by interruption or error, so Esc stops the chain rather than starting the next item.
const isPaused = atom({ plugin: 'msg-queue', key: 'isPaused' } as const, false)

// Each line opening with >> starts a queued message, and the lines below belong to it;
// >>edit and >>clear are whole prompts of their own.
const LEADER = '>>'
const QUEUED_LINE = /^>>(?:[ \t]|$)/
const DRAFT = /^>>/m
const FENCE = /^\s*(?:```|~~~)/
const SHOWN = 5
const WIDTH = 72

// Splits text into what comes before its first >> line and the messages the >> lines
// open; a >> line inside a code fence is text.
function splitQueued(text: string): { head: string; messages: string[] } {
  const head: string[] = []
  const messages: string[][] = []
  let isFenced = false
  for (const line of text.split('\n')) {
    if (FENCE.test(line)) {
      isFenced = !isFenced
    }
    if (!isFenced && QUEUED_LINE.test(line)) {
      messages.push([line.slice(LEADER.length)])
      continue
    }
    ;(messages.at(-1) ?? head).push(line)
  }

  return {
    head: head.join('\n').trim(),
    messages: messages.map(m => m.join('\n').trim()).filter(m => m !== ''),
  }
}

function preview(message: string): string {
  const line = message.split('\n')[0] ?? ''
  const isCut = line.length > WIDTH || message.includes('\n')

  return isCut ? `${line.slice(0, WIDTH)}…` : line
}

async function syncDraft($: EngineInterface) {
  const is = DRAFT.test((await $.prompt.read()).text)
  if (is !== (await read($, isDraft))) {
    await update($, isDraft, () => is)
  }
}

let isSending = false
// Counts turn starts, so a queued command can tell whether it began a turn (a skill) or not (/compact).
let turnsStarted = 0
// Set when a compaction that a queued command started did not stand. /compact cancelled by
// Esc resolves like one that ran, so only the compaction itself tells them apart.
let compactFailure: string | undefined

const COMMAND = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/

// A queued item led by a slash command runs as that command. The host refuses a plugin's
// message that begins with /, so >> turns away one led by anything else (a path, a typo).
function asCommand(item: string) {
  const match = COMMAND.exec(item)
  if (!match) {
    return undefined
  }
  const [, command = '', args = ''] = match

  return { command, args }
}

async function refuseUnknown($: EngineInterface, messages: string[]) {
  const known = new Set((await $.command.list()).map(c => c.name))
  const unknown = messages.find(m => m.startsWith('/') && !known.has(asCommand(m)?.command ?? ''))
  const word = unknown?.split(/\s/)[0]

  return word === undefined
    ? undefined
    : `${word} is not a command, so nothing was queued; start the message with other text to send it`
}

async function pause($: EngineInterface, why: string) {
  await update($, isPaused, () => true)
  $.ui.toast(`msg-queue: ${why}, so the queue is paused; >> resumes it`)
}

// Sends the queue's head once nothing runs; the next goes when that turn has ended.
async function sendNext($: EngineInterface) {
  if (isSending || (await read($, isBusy)) || (await read($, isPaused))) {
    return
  }
  isSending = true
  let run: { command: string; args: string } | undefined
  try {
    const head = (await read($, queue))[0]
    if (head === undefined) {
      return
    }
    await update($, queue, q => q.slice(1))
    await update($, isBusy, () => true)
    run = asCommand(head)
    if (!run) {
      const result = await $.prompt.submit({ text: head, asUser: true }).catch(async (error: unknown) => {
        await pause($, `the message could not be sent (${String(error)})`)
        return { drop: true }
      })
      if ('drop' in result) {
        await update($, isBusy, () => false)
      }
    }
  } finally {
    isSending = false
  }
  if (run) {
    await runCommand($, run)
  }
}

async function runCommand($: EngineInterface, run: { command: string; args: string }) {
  const before = turnsStarted
  compactFailure = undefined
  try {
    await $.command.run(run)
    if (compactFailure !== undefined) {
      await pause($, `/${run.command} did not finish (${compactFailure})`)
    }
  } catch (error) {
    await pause($, `/${run.command} failed (${String(error)})`)
  }
  // A command that started a turn is released by that turn's end instead.
  if (turnsStarted === before) {
    await update($, isBusy, () => false)
    sendLater($)
  }
}

async function resume($: EngineInterface) {
  if (!(await read($, isPaused))) {
    return 'Usage: >> {message}'
  }
  await update($, isPaused, () => false)
  sendLater($)

  return 'Queue resumed'
}

async function editQueue($: EngineInterface) {
  const items = await read($, queue)
  if (items.length === 0) {
    return 'Nothing is queued'
  }
  await update($, queue, () => [])
  const lines = items.map(m => `${LEADER} ${m}`).join('\n')
  const box = await $.prompt.read()
  const filled = await $.prompt.fill(box.text.trim() === '' ? { text: lines } : { text: `\n${lines}`, mode: 'append' })
  if (!filled.isFilled) {
    await update($, queue, q => [...items, ...q])

    return 'The prompt box could not take the queue, so it is unchanged'
  }

  return undefined
}

async function clearQueue($: EngineInterface) {
  const items = await read($, queue)
  await update($, queue, () => [])
  await update($, isPaused, () => false)

  return items.length === 0 ? 'Nothing is queued' : `Dropped ${items.length} queued message${items.length === 1 ? '' : 's'}`
}

// The host hands a dropped prompt back to the box; this empties it once the mod has
// taken the prompt, unless the person has typed something else since.
async function clearTaken($: EngineInterface, text: string) {
  if ((await $.prompt.read()).text === text) {
    await $.prompt.fill({ text: '' })
  }
}

// The prompts that act on the queue rather than add to it.
const ACTIONS = [LEADER, `${LEADER}edit`, `${LEADER}clear`]

async function act($: EngineInterface, action: string, typed: string) {
  await clearTaken($, typed)
  const text = action === LEADER ? await resume($) : action === `${LEADER}edit` ? await editQueue($) : await clearQueue($)
  if (text !== undefined) {
    $.ui.toast(`msg-queue: ${text}`)
  }
}

function sendLater($: EngineInterface) {
  // A submit from a prompt.submit or turn.complete hook would wait on the work that hook holds.
  $.clock.after(0, () => sendNext($))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // The box changes without an edit event (Enter clears it, Up recalls), so it is polled.
    $.clock.every(250, () => syncDraft($))

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind !== 'composer' && e.origin.kind !== 'bridge') {
      return next(e)
    }
    const action = e.text.trim()
    if (ACTIONS.includes(action)) {
      $.clock.after(0, () => act($, action, e.text))

      return { drop: `msg-queue ran ${action}` }
    }
    const { head, messages } = splitQueued(e.text)
    if (messages.length === 0) {
      return next(e)
    }
    const refusal = await refuseUnknown($, messages)
    if (refusal !== undefined) {
      // Dropped, the prompt goes back to the box as typed, to fix there.
      $.ui.toast(`msg-queue: ${refusal}`)

      return { drop: refusal }
    }
    if (head === '') {
      await update($, queue, q => [...q, ...messages])
      $.clock.after(0, () => clearTaken($, e.text))
      sendLater($)

      return { drop: `msg-queue queued it (${(await read($, queue)).length} waiting)` }
    }
    // The text above the >> lines goes now, as Enter sends it; held busy so the queue
    // cannot start before it.
    await update($, isBusy, () => true)
    await update($, queue, q => [...q, ...messages])
    const result = await next({ ...e, text: head })
    if ('drop' in result) {
      await update($, isBusy, () => false)
      sendLater($)
    }

    return result
  })

  on('session.compact', async ($, e, next) => {
    try {
      const result = await next(e)
      if (result.skip !== undefined) {
        compactFailure = result.skip
      }

      return result
    } catch (error) {
      compactFailure = String(error)
      throw error
    }
  })

  on('turn.start', async ($, e, next) => {
    turnsStarted++
    await update($, isBusy, () => true)

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) {
      await update($, isBusy, () => false)
      if (e.reason !== 'answer' && (await read($, queue)).length > 0) {
        await update($, isPaused, () => true)
      }
      sendLater($)
    }

    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e)
    }
    const items = await read($, queue)
    const isDrafting = await read($, isDraft)
    const paused = await read($, isPaused)
    if (items.length === 0 && !isDrafting) {
      return next(e)
    }
    const { Box, Text } = $.ui.resolve(e)
    const waits = e.props.isWorking || items.length > 0 || paused

    return (
      <Box flexDirection="column">
        {items.length > 0 && (
          <Text dimColor>
            {paused ? `⏸ paused (${items.length}): >> resumes · ` : `queued (${items.length}): `}
            {'>>edit · >>clear'}
          </Text>
        )}
        {items.slice(0, SHOWN).map((m, i) => (
          <Text key={`q${i}`} dimColor>
            {`  ${i + 1}. ${preview(m)}`}
          </Text>
        ))}
        {items.length > SHOWN && <Text dimColor>{`  +${items.length - SHOWN} more`}</Text>}
        {isDrafting && (
          <Text color="suggestion">
            {waits ? '↳ >>: joins the queue, sent after the current turn has fully ended' : '↳ >>: nothing is running, so it sends now'}
          </Text>
        )}
      </Box>
    )
  })
}
