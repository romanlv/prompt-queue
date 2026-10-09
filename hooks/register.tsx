import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

const isQqDraft = atom({ plugin: 'msg-queue', key: 'isQqDraft' } as const, false)
const queue = atom({ plugin: 'msg-queue', key: 'queue' } as const, [] as string[])
// From a turn's start, or the mod's own submit, to that turn's end on the main loop.
const isBusy = atom({ plugin: 'msg-queue', key: 'isBusy' } as const, false)
// Set when a turn ends by interruption or error, so Esc stops the chain rather than starting the next item.
const isPaused = atom({ plugin: 'msg-queue', key: 'isPaused' } as const, false)

const QQ = /^\/qq(\s|$)/
// /qq-edit puts the queue back in the box one item per line, so one /qq can carry
// several; each line opening with /qq starts a message of its own.
const NEXT_QQ = /\n\/qq(?:[ \t]|$)/m
const SHOWN = 5
const WIDTH = 72

function splitMessages(args: string): string[] {
  return args
    .split(NEXT_QQ)
    .map(m => m.trim())
    .filter(m => m !== '')
}

function preview(message: string): string {
  const line = message.split('\n')[0] ?? ''
  const isCut = line.length > WIDTH || message.includes('\n')

  return isCut ? `${line.slice(0, WIDTH)}…` : line
}

async function syncDraft($: EngineInterface) {
  const isQq = QQ.test((await $.prompt.read()).text)
  if (isQq !== (await read($, isQqDraft))) {
    await update($, isQqDraft, () => isQq)
  }
}

let isSending = false

// Sends the queue's head once nothing runs; the next goes when that turn has ended.
async function sendNext($: EngineInterface) {
  if (isSending || (await read($, isBusy)) || (await read($, isPaused))) {
    return
  }
  isSending = true
  try {
    const head = (await read($, queue))[0]
    if (head === undefined) {
      return
    }
    await update($, queue, q => q.slice(1))
    await update($, isBusy, () => true)
    const result = await $.prompt.submit({ text: head, asUser: true })
    if ('drop' in result) {
      await update($, isBusy, () => false)
    }
  } finally {
    isSending = false
  }
}

function sendLater($: EngineInterface) {
  // A submit from a command.run or turn.complete hook would wait on the work that hook holds.
  $.clock.after(0, () => sendNext($))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'qq',
      description: 'Queue a message to send once the current turn has fully ended: /qq {message}',
      argumentHint: '{message}',
      immediate: true,
    })
    await $.command.register({
      name: 'qq-edit',
      description: 'Move the queued /qq messages back into the prompt box to edit or delete them',
      immediate: true,
    })
    await $.command.register({
      name: 'qq-clear',
      description: 'Drop every queued /qq message',
      immediate: true,
    })
    // The box changes without an edit event (Enter clears it, Up recalls), so it is polled.
    $.clock.every(250, () => syncDraft($))

    return next(e)
  })

  on('command.run', { command: 'qq' }, async ($, e) => {
    const messages = splitMessages(e.args)
    if (messages.length === 0) {
      if (await read($, isPaused)) {
        await update($, isPaused, () => false)
        sendLater($)

        return { text: 'Queue resumed' }
      }

      return { text: 'Usage: /qq {message}' }
    }
    await update($, queue, q => [...q, ...messages])
    sendLater($)

    return {}
  })

  on('command.run', { command: 'qq-edit' }, async $ => {
    const items = await read($, queue)
    if (items.length === 0) {
      return { text: 'Nothing is queued' }
    }
    await update($, queue, () => [])
    const lines = items.map(m => `/qq ${m}`).join('\n')
    const box = await $.prompt.read()
    const filled = await $.prompt.fill(
      box.text.trim() === '' ? { text: lines } : { text: `\n${lines}`, mode: 'append' },
    )
    if (!filled.isFilled) {
      await update($, queue, q => [...items, ...q])

      return { text: 'The prompt box could not take the queue, so it is unchanged' }
    }

    return {}
  })

  on('command.run', { command: 'qq-clear' }, async $ => {
    const items = await read($, queue)
    await update($, queue, () => [])
    await update($, isPaused, () => false)
    if (items.length === 0) {
      return { text: 'Nothing is queued' }
    }

    return { text: `Dropped ${items.length} queued message${items.length === 1 ? '' : 's'}` }
  })

  on('turn.start', async ($, e, next) => {
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
    const isDraft = await read($, isQqDraft)
    const paused = await read($, isPaused)
    if (items.length === 0 && !isDraft) {
      return next(e)
    }
    const { Box, Text } = $.ui.resolve(e)
    const waits = e.props.isWorking || items.length > 0 || paused

    return (
      <Box flexDirection="column">
        {items.length > 0 && (
          <Text dimColor>
            {paused ? `⏸ paused (${items.length}): /qq resumes · ` : `queued (${items.length}): `}
            /qq-edit · /qq-clear
          </Text>
        )}
        {items.slice(0, SHOWN).map((m, i) => (
          <Text key={`q${i}`} dimColor>
            {`  ${i + 1}. ${preview(m)}`}
          </Text>
        ))}
        {items.length > SHOWN && <Text dimColor>{`  +${items.length - SHOWN} more`}</Text>}
        {isDraft && (
          <Text color="suggestion">
            {waits ? '↳ /qq: joins the queue, sent after the current turn has fully ended' : '↳ /qq: nothing is running, so it sends now'}
          </Text>
        )}
      </Box>
    )
  })
}
