import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

type Engine = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]

function session($: Engine, on: On, box = '') {
  const entered: string[] = []
  const filled: string[] = []
  const ran: string[] = []
  const commands = { fail: false, startsTurn: false, compact: 'stands' as 'stands' | 'skipped' }
  on('prompt.submit', (_$, e) => {
    entered.push(e.text)
    return { text: e.text }
  })
  on('prompt.read', () => ({ value: { text: box, cursor: box.length } }) as never)
  on('prompt.fill', (_$, e) => {
    filled.push(e.text)
    return { isFilled: true }
  })
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('command.list', () => ({ value: ['compact', 'review', 'qq', 'qq-edit', 'qq-clear'].map(name => ({ name, description: '', source: 'builtin' })) }) as never)
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
  const qq = async (command: string, args = '') => {
    const out = await $.command.run({ command, args } as never)
    await clock.advance(0)
    return out
  }
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
  return { entered, filled, ran, commands, qq, type, turnStart, turnEnd }
}

test('/qq with nothing running sends at once', async ($, on) => {
  const s = session($, on)
  await s.qq('qq', '  reply APPLE ')
  expect(s.entered).toEqual(['reply APPLE'])
})

test('/qq with no message shows usage and sends nothing', async ($, on) => {
  const s = session($, on)
  const out = await s.qq('qq')
  expect(out.text).toBe('Usage: /qq {message}')
  expect(s.entered).toEqual([])
})

test('queued messages go one per finished turn, in order', async ($, on) => {
  const s = session($, on)
  await s.turnStart()
  await s.qq('qq', 'ONE')
  await s.qq('qq', 'TWO\n/qq THREE')
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
  await s.qq('qq', 'ONE')
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 's', reason: 'answer', agentId: 'a1' } as never)
  expect(s.entered).toEqual([])
})

test('a multi-line message stays one; /qq inside a line is text', async ($, on) => {
  const s = session($, on)
  await s.turnStart()
  await s.qq('qq', 'first\nsecond\n/qq next\n  indented\n/qq\n/qq what /qq does\n/qqx too')
  for (let i = 0; i < 3; i++) {
    await s.turnEnd()
    await s.turnStart()
  }
  expect(s.entered).toEqual(['first\nsecond', 'next\n  indented', 'what /qq does\n/qqx too'])
})

test('/qq-edit moves only what is still queued into the box, and Enter queues it again', async ($, on) => {
  const s = session($, on)
  await s.turnStart()
  await s.qq('qq', 'ONE')
  await s.qq('qq', 'TWO')
  await s.qq('qq', 'THREE')
  await s.turnEnd()
  await s.turnStart()
  expect(s.entered).toEqual(['ONE'])
  await s.qq('qq-edit')
  expect(s.filled).toEqual(['/qq TWO\n/qq THREE'])
  await s.turnEnd()
  expect(s.entered).toEqual(['ONE'])
  await s.qq('qq', 'THREE-EDITED')
  expect(s.entered).toEqual(['ONE', 'THREE-EDITED'])
})

test('/qq-edit appends below a draft already in the box', async ($, on) => {
  const s = session($, on, 'half typed')
  await s.turnStart()
  await s.qq('qq', 'ONE')
  await s.qq('qq-edit')
  expect(s.filled).toEqual(['\n/qq ONE'])
})

test('/qq-edit with nothing queued says so', async ($, on) => {
  const s = session($, on)
  expect((await s.qq('qq-edit')).text).toBe('Nothing is queued')
  expect(s.filled).toEqual([])
})

test('/qq-clear drops the queue', async ($, on) => {
  const s = session($, on)
  await s.turnStart()
  await s.qq('qq', 'ONE\n/qq TWO')
  expect((await s.qq('qq-clear')).text).toBe('Dropped 2 queued messages')
  await s.turnEnd()
  expect(s.entered).toEqual([])
})

test('an interrupted turn pauses the queue until /qq resumes it', async ($, on) => {
  const s = session($, on)
  await s.turnStart()
  await s.qq('qq', 'ONE')
  await s.turnEnd('aborted')
  expect(s.entered).toEqual([])
  expect((await s.qq('qq')).text).toBe('Queue resumed')
  expect(s.entered).toEqual(['ONE'])
})

test('a queued slash command runs as that command in its place in the queue', async ($, on) => {
  const s = session($, on)
  await s.turnStart()
  await s.qq('qq', 'ONE\n/qq /compact keep the plan\n/qq TWO')
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
  await s.qq('qq', '/compact')
  await s.qq('qq', 'ONE')
  expect(s.ran).toEqual(['/compact'])
  expect(s.entered).toEqual(['ONE'])
})

test('a command that starts a turn holds the queue until that turn ends', async ($, on) => {
  const s = session($, on)
  s.commands.startsTurn = true
  await s.qq('qq', '/review\n/qq ONE')
  expect(s.ran).toEqual(['/review'])
  expect(s.entered).toEqual([])
  await s.turnEnd()
  expect(s.entered).toEqual(['ONE'])
})

test('a failed command pauses the queue', async ($, on) => {
  const s = session($, on)
  s.commands.fail = true
  await s.turnStart()
  await s.qq('qq', '/compact\n/qq ONE')
  await s.turnEnd()
  expect(s.ran).toEqual(['/compact'])
  expect(s.entered).toEqual([])
  expect((await s.qq('qq')).text).toBe('Queue resumed')
  expect(s.entered).toEqual(['ONE'])
})

test('a message led by a path or unknown slash word is turned away, queuing nothing', async ($, on) => {
  const s = session($, on)
  await s.turnStart()
  const out = await s.qq('qq', 'ONE\n/qq /tmp/x.log explain it')
  expect(out.text).toBe('/tmp/x.log is not a command, so nothing was queued; start the message with other text to send it')
  await s.qq('qq', 'read /tmp/x.log')
  await s.turnEnd()
  expect(s.ran).toEqual([])
  expect(s.entered).toEqual(['read /tmp/x.log'])
})

// The kit skips a hook that throws, so Esc's aborted compaction is checked live, not here.
test('a compaction that does not stand pauses the queue', async ($, on) => {
  const s = session($, on)
  s.commands.compact = 'skipped'
  await s.qq('qq', '/compact\n/qq ONE')
  expect(s.ran).toEqual(['/compact'])
  expect(s.entered).toEqual([])
  expect((await s.qq('qq')).text).toBe('Queue resumed')
  expect(s.entered).toEqual(['ONE'])
})

test('a typed prompt with /qq lines below its text sends the text and queues the rest', async ($, on) => {
  const s = session($, on)
  await s.type('this is sent right away\n\n/qq this is fine\n\n/qq another one\nwith a second line\n/qq /compact')
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

test('typed mid-turn, the text goes in at once and the /qq parts wait for the turn to end', async ($, on) => {
  const s = session($, on)
  await s.turnStart()
  await s.type('steer this\n/qq ONE')
  expect(s.entered).toEqual(['steer this'])
  await s.turnEnd()
  expect(s.entered).toEqual(['steer this', 'ONE'])
})

test('a typed prompt without /qq lines, or with them only in a code fence, is left alone', async ($, on) => {
  const s = session($, on)
  await s.type('plain\nmessage')
  await s.type('the docs say\n```\n/qq do a thing\n```\nand /qq mid-line')
  await s.turnStart()
  await s.turnEnd()
  expect(s.entered).toEqual(['plain\nmessage', 'the docs say\n```\n/qq do a thing\n```\nand /qq mid-line'])
})

test('a typed prompt queuing an unknown /word is dropped whole and put back in the box', async ($, on) => {
  const s = session($, on)
  const out = await s.type('do this\n/qq /tmp/x.log explain')
  expect(out).toEqual({ drop: '/tmp/x.log is not a command, so nothing was queued; start the message with other text to send it' })
  expect(s.entered).toEqual([])
  expect(s.filled).toEqual(['do this\n/qq /tmp/x.log explain'])
})
