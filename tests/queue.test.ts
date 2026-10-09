import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

type Engine = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]

function session($: Engine, on: On, box = '') {
  const entered: string[] = []
  const filled: string[] = []
  const ran: string[] = []
  const toasts: string[] = []
  const commands = { fail: false, startsTurn: false, compact: 'stands' as 'stands' | 'skipped' }
  on('prompt.submit', (_$, e) => {
    entered.push(e.text)
    return { text: e.text }
  })
  on('prompt.read', () => ({ value: { text: box, cursor: box.length } }) as never)
  const decorated: unknown[] = []
  on('prompt.fill', (_$, e) => {
    filled.push(e.text)
    decorated.push(e.decorations)
    return { isFilled: true }
  })
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('command.list', () => ({ value: ['compact', 'review'].map(name => ({ name, description: '', source: 'builtin' })) }) as never)
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined } as never
  })
  for (const command of ['compact', 'review']) {
    on('command.run', { command }, async (_$, e) => {
      ran.push(`/${e.command} ${e.args}`.trim())
      if (commands.fail) {
        throw new Error('no')
      }
      if (e.command === 'compact') {
        await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'hi', toolUses: [] }] } as never).catch(() => undefined)
      }
      if (commands.startsTurn) {
        await turnStart()
      }
      return { text: '' }
    })
  }
  on('session.compact', () => {
    return (commands.compact === 'skipped' ? { skip: 'vetoed' } : { messages: [{ role: 'user', text: 'summary', toolUses: [] }] }) as never
  })
  const clock = mock.clock(on)
  const turnStart = async () => {
    await $.turn.start({ text: 'work', turnId: 't' })
    await clock.advance(0)
  }
  const turnEnd = async (reason: 'answer' | 'aborted' = 'answer') => {
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: reason === 'aborted', turnId: 't', reason } as never)
    await clock.advance(0)
  }
  // The person pressing Enter on a prompt, mid-turn or not.
  const type = async (text: string) => {
    const out = await $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } } as never)
    await clock.advance(0)
    return out
  }
  return { entered, filled, decorated, ran, commands, toasts, type, turnStart, turnEnd }
}

test('>> with nothing running sends at once', async ($, on) => {
  const s = session($, on)
  await s.type('>>   reply APPLE ')
  expect(s.entered).toEqual(['reply APPLE'])
})

test('>> with no message shows usage and sends nothing', async ($, on) => {
  const s = session($, on)
  await s.type('>>')
  expect(s.toasts).toEqual(['msg-queue: Usage: >> {message}'])
  expect(s.entered).toEqual([])
})

test('queued messages go one per finished turn, in order', async ($, on) => {
  const s = session($, on)
  await s.turnStart()
  await s.type('>> ONE')
  await s.type('>> TWO\n>> THREE')
  expect(s.entered).toEqual([])
  await s.turnEnd()
  expect(s.entered).toEqual(['ONE'])
  await s.turnStart()
  await s.turnEnd()
  expect(s.entered).toEqual(['ONE', 'TWO'])
  await s.turnStart()
  await s.turnEnd()
  expect(s.entered).toEqual(['ONE', 'TWO', 'THREE'])
  await s.turnStart()
  await s.turnEnd()
  expect(s.entered).toEqual(['ONE', 'TWO', 'THREE'])
})

test('a subagent finishing does not release the next message', async ($, on) => {
  const s = session($, on)
  await s.turnStart()
  await s.type('>> ONE')
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 's', reason: 'answer', agentId: 'a1' } as never)
  expect(s.entered).toEqual([])
})

test('a multi-line message stays one; >> inside a line is text', async ($, on) => {
  const s = session($, on)
  await s.turnStart()
  await s.type('>> first\nsecond\n>> next\n  indented\n>>\n>> what >> does\n>>x too')
  for (let i = 0; i < 3; i++) {
    await s.turnEnd()
    await s.turnStart()
  }
  expect(s.entered).toEqual(['first\nsecond', 'next\n  indented', 'what >> does\n>>x too'])
})

test('>>edit moves only what is still queued into the box, and Enter queues it again', async ($, on) => {
  const s = session($, on)
  await s.turnStart()
  await s.type('>> ONE')
  await s.type('>> TWO')
  await s.type('>> THREE')
  await s.turnEnd()
  await s.turnStart()
  expect(s.entered).toEqual(['ONE'])
  await s.type('>>edit')
  expect(s.filled).toEqual(['>> TWO\n>> THREE'])
  await s.turnEnd()
  expect(s.entered).toEqual(['ONE'])
  await s.type('>> THREE-EDITED')
  expect(s.entered).toEqual(['ONE', 'THREE-EDITED'])
})

test('>>edit appends below a draft already in the box', async ($, on) => {
  const s = session($, on, 'half typed')
  await s.turnStart()
  await s.type('>> ONE')
  await s.type('>>edit')
  expect(s.filled).toEqual(['\n>> ONE'])
})

test('>>edit with nothing queued says so', async ($, on) => {
  const s = session($, on)
  await s.type('>>edit')
  expect(s.toasts.at(-1)).toBe(`msg-queue: ${'Nothing is queued'}`)
  expect(s.filled).toEqual([])
})

test('>>clear drops the queue', async ($, on) => {
  const s = session($, on)
  await s.turnStart()
  await s.type('>> ONE\n>> TWO')
  await s.type('>>clear')
  expect(s.toasts.at(-1)).toBe(`msg-queue: ${'Dropped 2 queued messages'}`)
  await s.turnEnd()
  expect(s.entered).toEqual([])
})

test('an interrupted turn pauses the queue until >> resumes it', async ($, on) => {
  const s = session($, on)
  await s.turnStart()
  await s.type('>> ONE')
  await s.turnEnd('aborted')
  expect(s.entered).toEqual([])
  await s.type('>>')
  expect(s.toasts.at(-1)).toBe(`msg-queue: ${'Queue resumed'}`)
  expect(s.entered).toEqual(['ONE'])
})

test('a queued slash command runs as that command in its place in the queue', async ($, on) => {
  const s = session($, on)
  await s.turnStart()
  await s.type('>> ONE\n>> /compact keep the plan\n>> TWO')
  await s.turnEnd()
  expect(s.entered).toEqual(['ONE'])
  expect(s.ran).toEqual([])
  await s.turnStart()
  await s.turnEnd()
  expect(s.ran).toEqual(['/compact keep the plan'])
  expect(s.entered).toEqual(['ONE', 'TWO'])
})

test('a slash command with nothing running runs at once', async ($, on) => {
  const s = session($, on)
  await s.type('>> /compact')
  await s.type('>> ONE')
  expect(s.ran).toEqual(['/compact'])
  expect(s.entered).toEqual(['ONE'])
})

test('a command that starts a turn holds the queue until that turn ends', async ($, on) => {
  const s = session($, on)
  s.commands.startsTurn = true
  await s.type('>> /review\n>> ONE')
  expect(s.ran).toEqual(['/review'])
  expect(s.entered).toEqual([])
  await s.turnEnd()
  expect(s.entered).toEqual(['ONE'])
})

test('a failed command pauses the queue', async ($, on) => {
  const s = session($, on)
  s.commands.fail = true
  await s.turnStart()
  await s.type('>> /compact\n>> ONE')
  await s.turnEnd()
  expect(s.ran).toEqual(['/compact'])
  expect(s.entered).toEqual([])
  await s.type('>>')
  expect(s.toasts.at(-1)).toBe(`msg-queue: ${'Queue resumed'}`)
  expect(s.entered).toEqual(['ONE'])
})

test('a message led by a path or unknown slash word is turned away, queuing nothing', async ($, on) => {
  const s = session($, on)
  await s.turnStart()
  await s.type('>> ONE\n>> /tmp/x.log explain it')
  expect(s.toasts).toEqual(['msg-queue: /tmp/x.log is not a command, so nothing was queued; start the message with other text to send it'])
  await s.type('>> read /tmp/x.log')
  await s.turnEnd()
  expect(s.ran).toEqual([])
  expect(s.entered).toEqual(['read /tmp/x.log'])
})

// The kit skips a hook that throws, so Esc's aborted compaction is checked live, not here.
test('a compaction that does not stand pauses the queue', async ($, on) => {
  const s = session($, on)
  s.commands.compact = 'skipped'
  await s.type('>> /compact\n>> ONE')
  expect(s.ran).toEqual(['/compact'])
  expect(s.entered).toEqual([])
  await s.type('>>')
  expect(s.toasts.at(-1)).toBe(`msg-queue: ${'Queue resumed'}`)
  expect(s.entered).toEqual(['ONE'])
})

test('a typed prompt with >> lines below its text sends the text and queues the rest', async ($, on) => {
  const s = session($, on)
  await s.type('this is sent right away\n\n>> this is fine\n\n>> another one\nwith a second line\n>> /compact')
  expect(s.entered).toEqual(['this is sent right away'])
  await s.turnStart()
  await s.turnEnd()
  expect(s.entered).toEqual(['this is sent right away', 'this is fine'])
  await s.turnStart()
  await s.turnEnd()
  expect(s.entered.at(-1)).toBe('another one\nwith a second line')
  await s.turnStart()
  await s.turnEnd()
  expect(s.ran).toEqual(['/compact'])
})

test('typed mid-turn, the text goes in at once and the >> parts wait for the turn to end', async ($, on) => {
  const s = session($, on)
  await s.turnStart()
  await s.type('steer this\n>> ONE')
  expect(s.entered).toEqual(['steer this'])
  await s.turnEnd()
  expect(s.entered).toEqual(['steer this', 'ONE'])
})

test('a typed prompt without >> lines, or with them only in a code fence, is left alone', async ($, on) => {
  const s = session($, on)
  await s.type('plain\nmessage')
  await s.type('the docs say\n```\n>> do a thing\n```\nand >> mid-line')
  await s.turnStart()
  await s.turnEnd()
  expect(s.entered).toEqual(['plain\nmessage', 'the docs say\n```\n>> do a thing\n```\nand >> mid-line'])
})

test('a typed prompt queuing an unknown /word is dropped whole, for the host to hand back', async ($, on) => {
  const s = session($, on)
  const out = await s.type('do this\n>> /tmp/x.log explain')
  expect(out).toEqual({ drop: '/tmp/x.log is not a command, so nothing was queued; start the message with other text to send it' })
  expect(s.entered).toEqual([])
  expect(s.filled).toEqual([])
})

test('>> must be followed by a space to queue, so >>word text goes to the model as typed', async ($, on) => {
  const s = session($, on)
  await s.type('>>edit the readme')
  expect(s.entered).toEqual(['>>edit the readme'])
})

test('a prompt the mod takes is cleared from the box the host hands it back to', async ($, on) => {
  const s = session($, on, '>> ONE')
  await s.turnStart()
  await s.type('>> ONE')
  expect(s.filled).toEqual([''])
})

test('the box is left alone when the person has typed something else since', async ($, on) => {
  const s = session($, on, 'new draft')
  await s.turnStart()
  await s.type('>> ONE')
  expect(s.filled).toEqual([])
})

type Edited = { decorations?: { start: number; end: number }[] }

// The person typing text into an empty box; the kit's engine types no prompt.edit call.
function edit($: Engine, text: string) {
  return ($.prompt as unknown as { edit: (e: unknown) => Promise<Edited> }).edit({ origin: { kind: 'composer' }, text: '', cursor: 0, start: 0, end: 0, inputText: text } as never)
}

test('the >> that queues a line is coloured; one mid-line, in a fence or before a word is not', async ($, on) => {
  session($, on)
  on('prompt.edit', (_$, e) => ({ text: e.inputText, cursor: e.inputText.length }) as never)
  const text = 'now\n>> one\na >> b\n```\n>> fenced\n```\n>>word\n>>'
  const result = await edit($, text)
  const painted = (result.decorations ?? []).map(d => text.slice(d.start, d.end) + '@' + d.start)
  expect(painted).toEqual(['>>@4', '>>@43'])
  expect(result.decorations?.[0]).toMatchObject({ color: 'suggestion', bold: true })
})

test('>>edit and >>clear are coloured as whole prompts', async ($, on) => {
  session($, on)
  on('prompt.edit', (_$, e) => ({ text: e.inputText, cursor: e.inputText.length }) as never)
  expect((await edit($, '>>edit')).decorations).toMatchObject([{ start: 0, end: 2 }])
  expect((await edit($, '>>edits')).decorations).toBeUndefined()
})

test('>>edit fills the box with its >> already coloured', async ($, on) => {
  const s = session($, on)
  await s.turnStart()
  await s.type('>> ONE\n>> TWO')
  await s.type('>>edit')
  expect(s.decorated.at(-1)).toMatchObject([{ start: 0, end: 2 }, { start: 7, end: 9 }])
})
