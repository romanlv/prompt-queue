import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

type Engine = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]

function session($: Engine, on: On, box = '') {
  const entered: string[] = []
  const filled: string[] = []
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
  return { entered, filled, qq, turnStart, turnEnd }
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
