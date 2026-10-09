import { atom, read, update } from 'claude-code'
import type { EngineInterface, PromptDecoration, Register, Timer } from 'claude-code'

const isDraft = atom({ plugin: 'prompt-queue', key: 'isDraft' } as const, false)
const queue = atom({ plugin: 'prompt-queue', key: 'queue' } as const, [] as string[])
// From a turn's start, or the mod's own submit, to that turn's end on the main loop.
const isBusy = atom({ plugin: 'prompt-queue', key: 'isBusy' } as const, false)
// Set when a turn ends by interruption or error, so Esc stops the chain rather than starting the next item.
const isPaused = atom({ plugin: 'prompt-queue', key: 'isPaused' } as const, false)
// The messages >>edit put in the box, held out of the queue until Enter saves the box's
// version or emptying the box puts them back; null when no edit is open.
const held = atom({ plugin: 'prompt-queue', key: 'held' } as const, null as string[] | null)

// Each line opening with >> starts a queued message, and the lines below belong to it;
// >>edit and >>clear are whole prompts of their own.
const LEADER = '>>'
const QUEUED_LINE = /^>>(?:[ \t]|$)/
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

// The >> runs to colour in text as the box holds it: each that queues its line, and the
// whole prompt when it is one of the actions.
function leaderRuns(text: string): PromptDecoration[] {
  const paint = (start: number): PromptDecoration => ({ start, end: start + LEADER.length, color: 'suggestion', bold: true })
  const trimmed = text.trim()
  if (ACTIONS.includes(trimmed)) {
    return [paint(text.indexOf(trimmed))]
  }
  const runs: PromptDecoration[] = []
  let isFenced = false
  let offset = 0
  for (const line of text.split('\n')) {
    if (FENCE.test(line)) {
      isFenced = !isFenced
    }
    if (!isFenced && QUEUED_LINE.test(line)) {
      runs.push(paint(offset))
    }
    offset += line.length + 1
  }

  return runs
}

function preview(message: string): string {
  const line = message.split('\n')[0] ?? ''
  const isCut = line.length > WIDTH || message.includes('\n')

  return isCut ? `${line.slice(0, WIDTH)}…` : line
}

let isCancelPending = false
let poll: Timer | undefined

async function syncDraft($: EngineInterface) {
  await restoreCarried($)
  const box = await $.prompt.read()
  const is = splitQueued(box.text).messages.length > 0
  if (is !== (await read($, isDraft))) {
    await update($, isDraft, () => is)
  }
  if (box.text === '' && !isCancelPending && (await read($, held)) !== null) {
    // Enter empties the box too, a moment before its prompt.submit ends the edit.
    isCancelPending = true
    $.clock.after(300, () => cancelIfEmpty($))
  }
}

async function cancelIfEmpty($: EngineInterface) {
  isCancelPending = false
  const items = await read($, held)
  if (items === null || (await $.prompt.read()).text !== '') {
    return
  }
  await update($, queue, q => [...items, ...q])
  await update($, held, () => null)
  $.ui.toast('prompt-queue: Edit cancelled; the queue is as it was')
  sendLater($)
}

// Ends an open edit with the messages the person saved, in the held ones' place.
async function saveEdit($: EngineInterface, messages: string[]) {
  await update($, queue, q => [...messages, ...q])
  await update($, held, () => null)
}

// What was waiting when a /clear ended the session: the host starts the next one with
// fresh state and no session.start, so the first hook to run in it puts this back.
let carried: { items: string[]; isPaused: boolean } | undefined

async function restoreCarried($: EngineInterface) {
  const kept = carried
  if (kept === undefined) {
    return
  }
  carried = undefined
  // Only into fresh state: had the queue come through the /clear, it already holds these.
  if ((await read($, queue)).length > 0) {
    return
  }
  await update($, queue, () => kept.items)
  if (kept.isPaused) {
    await update($, isPaused, () => true)
  }
  sendLater($)
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
  $.ui.toast(`prompt-queue: ${why}, so the queue is paused; >> resumes it`)
}

// Sends the queue's head once nothing runs; the next goes when that turn has ended.
async function sendNext($: EngineInterface) {
  await restoreCarried($)
  if (isSending || (await read($, isBusy)) || (await read($, isPaused)) || (await read($, held)) !== null) {
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
        sendLater($)
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

// A bare >> resumes a paused queue, opens a waiting one for editing, and otherwise shows usage.
async function resume($: EngineInterface) {
  if (!(await read($, isPaused))) {
    const isWaiting = (await read($, queue)).length > 0 || (await read($, held)) !== null

    return isWaiting ? editQueue($) : 'Usage: >> {message}'
  }
  await update($, isPaused, () => false)
  sendLater($)

  return 'Queue resumed'
}

async function editQueue($: EngineInterface) {
  if ((await read($, held)) !== null) {
    return 'Already editing: Enter saves the box, emptying it cancels'
  }
  const items = await read($, queue)
  if (items.length === 0) {
    return 'Nothing is queued'
  }
  await update($, held, () => items)
  await update($, queue, () => [])
  const lines = items.map(m => `${LEADER} ${m}`).join('\n')
  const box = await $.prompt.read()
  const text = box.text.trim() === '' ? lines : `\n${lines}`
  const filled = await $.prompt.fill({ text, mode: text === lines ? 'replace' : 'append', decorations: leaderRuns(text) })
  if (!filled.isFilled) {
    await update($, queue, q => [...items, ...q])
    await update($, held, () => null)

    return 'The prompt box could not take the queue, so it is unchanged'
  }

  return undefined
}

async function clearQueue($: EngineInterface) {
  const items = [...((await read($, held)) ?? []), ...(await read($, queue))]
  await update($, queue, () => [])
  await update($, held, () => null)
  await update($, isPaused, () => false)

  return items.length === 0 ? 'Nothing is queued' : `Dropped ${items.length} queued message${items.length === 1 ? '' : 's'}`
}

// What the box shows for a paste, where the prompt has the pasted text itself.
const PLACEHOLDER = /\[(?:Pasted text|Image) #\d+[^\]]*\]/

// Whether the box shows text as typed, its pastes folded to placeholders or not.
function showsPrompt(box: string, text: string): boolean {
  if (box === text) {
    return true
  }
  const parts = box.split(PLACEHOLDER)
  if (parts.length === 1) {
    return false
  }
  const escaped = parts.map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))

  return new RegExp(`^${escaped.join('[\\s\\S]*')}$`).test(text)
}

// The host hands a dropped prompt back to the box; this empties it once the mod has
// taken the prompt, unless the person has typed something else since.
async function clearTaken($: EngineInterface, text: string) {
  if (showsPrompt((await $.prompt.read()).text, text)) {
    await $.prompt.fill({ text: '' })
  }
}

// The prompts that act on the queue rather than add to it.
const ACTIONS = [LEADER, `${LEADER}edit`, `${LEADER}clear`]

async function act($: EngineInterface, action: string, typed: string) {
  await clearTaken($, typed)
  const text = action === LEADER ? await resume($) : action === `${LEADER}edit` ? await editQueue($) : await clearQueue($)
  if (text !== undefined) {
    $.ui.toast(`prompt-queue: ${text}`)
  }
}

function sendLater($: EngineInterface) {
  // A submit from a prompt.submit or turn.complete hook would wait on the work that hook holds.
  $.clock.after(0, () => sendNext($))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // The box changes without an edit event (Enter clears it, Up recalls), so it is polled.
    poll?.cancel()
    poll = $.clock.every(250, () => syncDraft($))
    // A reload keeps the queue; anything left waiting with nothing running goes on.
    sendLater($)

    return next(e)
  })

  on('prompt.edit', async ($, e, next) => {
    const result = await next(e)
    const runs = leaderRuns(result.text)

    return runs.length === 0 ? result : { ...result, decorations: [...(result.decorations ?? []), ...runs] }
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind !== 'composer' && e.origin.kind !== 'bridge') {
      return next(e)
    }
    const action = e.text.trim()
    if (ACTIONS.includes(action)) {
      $.clock.after(0, () => act($, action, e.text))

      return { drop: `prompt-queue ran ${action}` }
    }
    const { head, messages } = splitQueued(e.text)
    // Only the box an edit was opened in saves it; a prompt from the bridge just queues.
    const isEditing = e.origin.kind === 'composer' && (await read($, held)) !== null
    if (messages.length === 0) {
      if (isEditing) {
        // Every >> line deleted: the held messages go.
        await saveEdit($, [])
        sendLater($)
      }

      return next(e)
    }
    const refusal = await refuseUnknown($, messages)
    if (refusal !== undefined) {
      // Dropped, the prompt goes back to the box as typed, to fix there.
      $.ui.toast(`prompt-queue: ${refusal}`)

      return { drop: refusal }
    }
    // With nothing running or waiting, the first message is simply the prompt: sent as typed,
    // without the >>. A slash command still goes through the queue, as the host will not run
    // one passed down as prompt text.
    const isIdle =
      !(await read($, isBusy)) && !(await read($, isPaused)) && (await read($, queue)).length === 0
    const [first = '', ...rest] = messages
    const isFirstNow = head === '' && isIdle && !first.startsWith('/')
    const now = isFirstNow ? first : head
    const later = isFirstNow ? rest : messages
    if (now === '' && (e.attachments?.length ?? 0) > 0) {
      const why = 'an image cannot wait in the queue, so nothing was queued; send it without >>'
      $.ui.toast(`prompt-queue: ${why}`)

      return { drop: why }
    }
    if (now === '') {
      await (isEditing ? saveEdit($, later) : update($, queue, q => [...q, ...later]))
      $.clock.after(0, () => clearTaken($, e.text))
      sendLater($)

      return { drop: `prompt-queue queued it (${(await read($, queue)).length} waiting)` }
    }
    // What goes now goes as Enter sends it; held busy so the queue cannot start before it.
    await update($, isBusy, () => true)
    await (isEditing ? saveEdit($, later) : update($, queue, q => [...q, ...later]))
    const result = await next({ ...e, text: now }).catch(async (error: unknown) => {
      await update($, isBusy, () => false)
      if ((await read($, queue)).length > 0) {
        await pause($, `the prompt could not be sent (${String(error)})`)
      }
      throw error
    })
    if ('drop' in result) {
      await update($, isBusy, () => false)
      sendLater($)
    }

    return result
  })

  // A typed command with >> lines below it runs, and the lines queue after it; the host
  // would otherwise hand them to the command as its arguments.
  on('command.run', async ($, e, next) => {
    if (e.origin.kind !== 'composer' && e.origin.kind !== 'bridge') {
      return next(e)
    }
    const { head, messages } = splitQueued(e.args)
    if (messages.length === 0) {
      return next(e)
    }
    const refusal = await refuseUnknown($, messages)
    if (refusal !== undefined) {
      return { text: refusal }
    }
    await update($, isBusy, () => true)
    await update($, queue, q => [...q, ...messages])
    const before = turnsStarted
    try {
      return await next({ ...e, args: head })
    } finally {
      // A command that started a turn is released by that turn's end instead.
      if (turnsStarted === before) {
        await update($, isBusy, () => false)
        sendLater($)
      }
    }
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      const items = [...((await read($, held)) ?? []), ...(await read($, queue))]
      if (items.length > 0) {
        carried = { items, isPaused: await read($, isPaused) }
      }
    }

    return next(e)
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
      const waiting = (await read($, queue)).length + ((await read($, held))?.length ?? 0)
      if (e.reason !== 'answer' && waiting > 0) {
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
    const editing = await read($, held)
    if (items.length === 0 && !isDrafting && editing === null) {
      return next(e)
    }
    const { Box, Text } = $.ui.resolve(e)
    const waits = e.props.isWorking || items.length > 0 || paused

    return (
      <Box flexDirection="column">
        {editing !== null && (
          <Text color="suggestion">
            {`✎ editing ${editing.length} queued: Enter saves · empty the box to cancel${paused ? ' · ⏸ paused, >> resumes' : ''}`}
          </Text>
        )}
        {items.length > 0 && (
          <Text>
            <Text color={paused ? 'warning' : 'suggestion'} bold>
              {paused ? `⏸ paused (${items.length})` : `queued (${items.length})`}
            </Text>
            <Text dimColor>{paused ? ': >> resumes · >>edit · >>clear' : ': >> edits · >>clear'}</Text>
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
            {paused
              ? '↳ >>: joins the queue, which is paused until >> on its own resumes it'
              : waits
                ? '↳ >>: joins the queue, sent after the current turn has fully ended'
                : '↳ >>: nothing is running, so it sends now'}
          </Text>
        )}
      </Box>
    )
  })
}
