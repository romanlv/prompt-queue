import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

type Engine = Parameters<TestBody>[0]
type On = Parameters<TestBody>[1]

async function session($: Engine, on: On, initialBox = '') {
  let box = initialBox
  const entered: string[] = []
  const filled: string[] = []
  const ran: string[] = []
  const toasts: string[] = []
  const commands = { fail: false, startsTurn: false, refuseFill: false, compact: 'stands' as 'stands' | 'skipped' }
  // The bottom of the chain, standing in for the engine; another plugin drops DROPPED.
  on('prompt.submit', (_$, e) => {
    if (e.text === 'DROPPED') {
      return { drop: 'another plugin' } as never
    }
    if (e.text === 'THROWS') {
      throw new Error('the engine failed')
    }
    entered.push(e.text)
    return { text: e.text }
  })
  on('prompt.read', () => ({ value: { text: box, cursor: box.length } }) as never)
  const decorated: unknown[] = []
  on('prompt.fill', (_$, e) => {
    if (commands.refuseFill) {
      return { isFilled: false } as never
    }
    box = e.mode === 'append' ? box + e.text : e.text
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
  on('prompt.edit', (_$, e) => ({ text: e.inputText, cursor: e.inputText.length }) as never)
  on('session.start', (_$, e) => e as never)
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }) as never)
  // What the engine draws above the prompt when no plugin draws there.
  on('ui.render', { component: 'AbovePrompt' }, (_$, e) => h(_$.ui.resolve(e).Box, {}) as never)
  const clock = mock.clock(on)
  // Again under the mock clock, so the mod's poll of the box runs on it.
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true } as never)
  const turnStart = async () => {
    await $.turn.start({ text: 'work', turnId: 't' })
    await clock.advance(0)
  }
  const turnEnd = async (reason: 'answer' | 'aborted' = 'answer') => {
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: reason === 'aborted', turnId: 't', reason } as never)
    await clock.advance(0)
  }
  // The person pressing Enter on a prompt, mid-turn or not.
  // Enter empties the box, and the host hands a dropped prompt back to it.
  const type = async (text: string, kind: 'composer' | 'bridge' = 'composer', typedSince?: string) => {
    box = ''
    const out = await $.prompt.submit({ text, wait: false, origin: { kind } } as never)
    if ('drop' in out) {
      box = typedSince ?? text
    }
    await clock.advance(0)
    return out
  }
  const setBox = async (text: string) => {
    box = text
    await clock.advance(250)
    await clock.advance(300)
  }
  const boxText = () => box
  // Changes the box and lets one poll see it, leaving the cancel check pending.
  const setBoxQuietly = async (text: string) => {
    box = text
    await clock.advance(250)
  }
  const advance = (ms: number) => clock.advance(ms)
  return { entered, filled, decorated, ran, commands, toasts, type, setBox, setBoxQuietly, advance, boxText, turnStart, turnEnd }
}

test('>> with nothing running sends at once', async ($, on) => {
  const s = await session($, on)
  await s.type('>>   reply APPLE ')
  expect(s.entered).toEqual(['reply APPLE'])
})

test('>> with no message shows usage and sends nothing', async ($, on) => {
  const s = await session($, on)
  await s.type('>>')
  expect(s.toasts).toEqual(['msg-queue: Usage: >> {message}'])
  expect(s.entered).toEqual([])
})

test('queued messages go one per finished turn, in order', async ($, on) => {
  const s = await session($, on)
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
  const s = await session($, on)
  await s.turnStart()
  await s.type('>> ONE')
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 's', reason: 'answer', agentId: 'a1' } as never)
  expect(s.entered).toEqual([])
})

test('a multi-line message stays one; >> inside a line is text', async ($, on) => {
  const s = await session($, on)
  await s.turnStart()
  await s.type('>> first\nsecond\n>> next\n  indented\n>>\n>> what >> does\n>>x too')
  for (let i = 0; i < 3; i++) {
    await s.turnEnd()
    await s.turnStart()
  }
  expect(s.entered).toEqual(['first\nsecond', 'next\n  indented', 'what >> does\n>>x too'])
})

test('>>edit moves only what is still queued into the box, and Enter queues it again', async ($, on) => {
  const s = await session($, on)
  await s.turnStart()
  await s.type('>> ONE')
  await s.type('>> TWO')
  await s.type('>> THREE')
  await s.turnEnd()
  await s.turnStart()
  expect(s.entered).toEqual(['ONE'])
  await s.type('>>edit')
  expect(s.boxText()).toBe('>> TWO\n>> THREE')
  await s.turnEnd()
  expect(s.entered).toEqual(['ONE'])
  await s.type('>> THREE-EDITED')
  expect(s.entered).toEqual(['ONE', 'THREE-EDITED'])
})

test('>>edit with nothing queued says so', async ($, on) => {
  const s = await session($, on)
  await s.type('>>edit')
  expect(s.toasts.at(-1)).toBe(`msg-queue: ${'Nothing is queued'}`)
  expect(s.boxText()).toBe('')
})

test('>>clear drops the queue', async ($, on) => {
  const s = await session($, on)
  await s.turnStart()
  await s.type('>> ONE\n>> TWO')
  await s.type('>>clear')
  expect(s.toasts.at(-1)).toBe(`msg-queue: ${'Dropped 2 queued messages'}`)
  await s.turnEnd()
  expect(s.entered).toEqual([])
})

test('an interrupted turn pauses the queue until >> resumes it', async ($, on) => {
  const s = await session($, on)
  await s.turnStart()
  await s.type('>> ONE')
  await s.turnEnd('aborted')
  expect(s.entered).toEqual([])
  await s.type('>>')
  expect(s.toasts.at(-1)).toBe(`msg-queue: ${'Queue resumed'}`)
  expect(s.entered).toEqual(['ONE'])
})

test('a queued slash command runs as that command in its place in the queue', async ($, on) => {
  const s = await session($, on)
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
  const s = await session($, on)
  await s.type('>> /compact')
  await s.type('>> ONE')
  expect(s.ran).toEqual(['/compact'])
  expect(s.entered).toEqual(['ONE'])
})

test('a command that starts a turn holds the queue until that turn ends', async ($, on) => {
  const s = await session($, on)
  s.commands.startsTurn = true
  await s.type('>> /review\n>> ONE')
  expect(s.ran).toEqual(['/review'])
  expect(s.entered).toEqual([])
  await s.turnEnd()
  expect(s.entered).toEqual(['ONE'])
})

test('a failed command pauses the queue', async ($, on) => {
  const s = await session($, on)
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
  const s = await session($, on)
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
  const s = await session($, on)
  s.commands.compact = 'skipped'
  await s.type('>> /compact\n>> ONE')
  expect(s.ran).toEqual(['/compact'])
  expect(s.entered).toEqual([])
  await s.type('>>')
  expect(s.toasts.at(-1)).toBe(`msg-queue: ${'Queue resumed'}`)
  expect(s.entered).toEqual(['ONE'])
})

test('a typed prompt with >> lines below its text sends the text and queues the rest', async ($, on) => {
  const s = await session($, on)
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
  const s = await session($, on)
  await s.turnStart()
  await s.type('steer this\n>> ONE')
  expect(s.entered).toEqual(['steer this'])
  await s.turnEnd()
  expect(s.entered).toEqual(['steer this', 'ONE'])
})

test('a typed prompt without >> lines, or with them only in a code fence, is left alone', async ($, on) => {
  const s = await session($, on)
  await s.type('plain\nmessage')
  await s.type('the docs say\n```\n>> do a thing\n```\nand >> mid-line')
  await s.turnStart()
  await s.turnEnd()
  expect(s.entered).toEqual(['plain\nmessage', 'the docs say\n```\n>> do a thing\n```\nand >> mid-line'])
})

test('a typed prompt queuing an unknown /word is dropped whole, for the host to hand back', async ($, on) => {
  const s = await session($, on)
  const out = await s.type('do this\n>> /tmp/x.log explain')
  expect(out).toEqual({ drop: '/tmp/x.log is not a command, so nothing was queued; start the message with other text to send it' })
  expect(s.entered).toEqual([])
  expect(s.filled).toEqual([])
})

test('>> must be followed by a space to queue, so >>word text goes to the model as typed', async ($, on) => {
  const s = await session($, on)
  await s.type('>>edit the readme')
  expect(s.entered).toEqual(['>>edit the readme'])
})

test('a prompt the mod takes is cleared from the box the host hands it back to', async ($, on) => {
  const s = await session($, on, '>> ONE')
  await s.turnStart()
  await s.type('>> ONE')
  expect(s.filled).toEqual([''])
})

test('the box is left alone when the person has typed something else since', async ($, on) => {
  const s = await session($, on)
  await s.turnStart()
  await s.type('>> ONE', 'composer', 'new draft')
  expect(s.boxText()).toBe('new draft')
})

type Edited = { decorations?: { start: number; end: number }[] }

// The person typing text into an empty box; the kit's engine types no prompt.edit call.
function edit($: Engine, text: string) {
  return ($.prompt as unknown as { edit: (e: unknown) => Promise<Edited> }).edit({ origin: { kind: 'composer' }, text: '', cursor: 0, start: 0, end: 0, inputText: text } as never)
}

test('the >> that queues a line is coloured; one mid-line, in a fence or before a word is not', async ($, on) => {
  session($, on)
  const text = 'now\n>> one\na >> b\n```\n>> fenced\n```\n>>word\n>>'
  const result = await edit($, text)
  const painted = (result.decorations ?? []).map(d => text.slice(d.start, d.end) + '@' + d.start)
  expect(painted).toEqual(['>>@4', '>>@43'])
  expect(result.decorations?.[0]).toMatchObject({ color: 'suggestion', bold: true })
})

test('>>edit and >>clear are coloured as whole prompts', async ($, on) => {
  await session($, on)
  expect((await edit($, '>>edit')).decorations).toMatchObject([{ start: 0, end: 2 }])
  expect((await edit($, '>>edits')).decorations).toBeUndefined()
})

test('>>edit fills the box with its >> already coloured', async ($, on) => {
  const s = await session($, on)
  await s.turnStart()
  await s.type('>> ONE\n>> TWO')
  await s.type('>>edit')
  expect(s.decorated.at(-1)).toMatchObject([{ start: 0, end: 2 }, { start: 7, end: 9 }])
})

test('>>edit holds the queue: a turn ending mid-edit sends nothing, and Enter saves the box in its place', async ($, on) => {
  const s = await session($, on)
  await s.turnStart()
  await s.type('>> A\n>> B\n>> C\n>> D')
  await s.turnEnd()
  await s.turnStart()
  expect(s.entered).toEqual(['A'])
  await s.type('>>edit')
  // A has been sent, so only what is still waiting comes back.
  expect(s.boxText()).toBe('>> B\n>> C\n>> D')
  await s.turnEnd()
  expect(s.entered).toEqual(['A'])
  await s.type('>> B\n>> D-EDITED')
  expect(s.entered).toEqual(['A', 'B'])
  await s.turnStart()
  await s.turnEnd()
  expect(s.entered).toEqual(['A', 'B', 'D-EDITED'])
})

test('emptying the box cancels the edit and puts the queue back as it was', async ($, on) => {
  const s = await session($, on)
  await s.turnStart()
  await s.type('>> A\n>> B')
  await s.type('>>edit')
  expect(s.boxText()).toBe('>> A\n>> B')
  await s.setBox('>> A')
  await s.setBox('')
  expect(s.toasts.at(-1)).toBe('msg-queue: Edit cancelled; the queue is as it was')
  expect(s.entered).toEqual([])
  await s.turnEnd()
  await s.turnStart()
  await s.turnEnd()
  expect(s.entered).toEqual(['A', 'B'])
})

test('cancelling once the turn has ended sends the restored queue in order', async ($, on) => {
  const s = await session($, on)
  await s.turnStart()
  await s.type('>> A\n>> B')
  await s.type('>>edit')
  await s.turnEnd()
  await s.setBox('')
  expect(s.entered).toEqual(['A'])
})

test('Esc during an edit pauses, so saving afterwards sends nothing until >> resumes', async ($, on) => {
  const s = await session($, on)
  await s.turnStart()
  await s.type('>> A\n>> B')
  await s.type('>>edit')
  await s.turnEnd('aborted')
  await s.type('>> B')
  expect(s.entered).toEqual([])
  await s.type('>>')
  expect(s.entered).toEqual(['B'])
})

test('deleting every >> line and sending other text drops the held messages', async ($, on) => {
  const s = await session($, on)
  await s.turnStart()
  await s.type('>> A\n>> B')
  await s.type('>>edit')
  await s.type('never mind, do this instead')
  await s.turnEnd()
  expect(s.entered).toEqual(['never mind, do this instead'])
  await s.turnStart()
  await s.turnEnd()
  expect(s.entered).toEqual(['never mind, do this instead'])
})

test('a second >>edit during an edit says so; >>clear drops the held messages too', async ($, on) => {
  const s = await session($, on)
  await s.turnStart()
  await s.type('>> A')
  await s.type('>>edit')
  await s.type('>>edit')
  expect(s.toasts.at(-1)).toBe('msg-queue: Already editing: Enter saves the box, emptying it cancels')
  await s.type('>>clear')
  expect(s.toasts.at(-1)).toBe('msg-queue: Dropped 1 queued message')
  await s.turnEnd()
  expect(s.entered).toEqual([])
})

test('a >> from the bridge during an edit joins the queue after the edited ones', async ($, on) => {
  const s = await session($, on)
  await s.turnStart()
  await s.type('>> A')
  await s.type('>>edit')
  await s.type('>> PHONE', 'bridge')
  await s.type('>> A-EDITED')
  await s.turnEnd()
  await s.turnStart()
  await s.turnEnd()
  expect(s.entered).toEqual(['A-EDITED', 'PHONE'])
})

test('a bare >> opens the queue for editing when it is waiting, and resumes it when paused', async ($, on) => {
  const s = await session($, on)
  await s.turnStart()
  await s.type('>> A\n>> B')
  await s.type('>>')
  expect(s.boxText()).toBe('>> A\n>> B')
  await s.type('>> B')
  await s.turnEnd('aborted')
  expect(s.entered).toEqual([])
  await s.type('>>')
  expect(s.toasts.at(-1)).toBe('msg-queue: Queue resumed')
  expect(s.entered).toEqual(['B'])
})

test('with nothing running or waiting, >> sends the first message as the prompt itself', async ($, on) => {
  const s = await session($, on)
  const out = await s.type('>> ONE\n>> TWO')
  expect(out).toEqual({ text: 'ONE' })
  expect(s.entered).toEqual(['ONE'])
  await s.turnStart()
  await s.turnEnd()
  expect(s.entered).toEqual(['ONE', 'TWO'])
})

test('>> queues rather than sends when something is waiting, paused, or the line is a command', async ($, on) => {
  const s = await session($, on)
  expect(await s.type('>> /compact')).toMatchObject({ drop: expect.any(String) })
  await s.turnStart()
  await s.type('>> A')
  await s.turnEnd('aborted')
  expect(await s.type('>> B')).toMatchObject({ drop: expect.any(String) })
  expect(s.entered).toEqual([])
})

test('a prompt with an image that would have to wait is refused, not queued without it', async ($, on) => {
  const s = await session($, on)
  await s.turnStart()
  const out = await $.prompt.submit({ text: '>> look at this', wait: false, origin: { kind: 'composer' }, attachments: [{ type: 'image' }] } as never)
  expect(out).toMatchObject({ drop: expect.stringContaining('an image cannot wait in the queue') })
  await s.turnEnd()
  expect(s.entered).toEqual([])
})

test('the typing hint shows only for a line that queues', async ($, on) => {
  const s = await session($, on)
  const band = await $.ui.mount({ plugin: 'msg-queue', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: true } as never })
  const drafting = async (text: string) => {
    await s.setBox(text)
    return (await band.find({ text: /joins the queue/ })) !== undefined
  }
  expect(await drafting('>> next')).toBe(true)
  expect(await drafting('now\n>> next')).toBe(true)
  for (const text of ['>>edit', '>>clear', '>>', '>>word', '```\n>> fenced\n```', 'a >> b']) {
    expect(await drafting(text)).toBe(false)
  }
})

test('a queued message another hook drops moves the queue on to the next', async ($, on) => {
  const s = await session($, on)
  await s.turnStart()
  await s.type('>> DROPPED\n>> NEXT')
  await s.turnEnd()
  expect(s.entered).toEqual(['NEXT'])
})

test('a prompt with a paste is cleared from the box, which shows the paste folded', async ($, on) => {
  const s = await session($, on)
  await s.turnStart()
  await s.type('>> count these: one\ntwo\nthree', 'composer', '>> count these: [Pasted text #1 +2 lines]')
  expect(s.boxText()).toBe('')
})

test('a folded paste that does not match what was sent is left in the box', async ($, on) => {
  const s = await session($, on)
  await s.turnStart()
  await s.type('>> count these: one', 'composer', '>> other thing [Pasted text #1 +2 lines]')
  expect(s.boxText()).toBe('>> other thing [Pasted text #1 +2 lines]')
})

test('a typed command with >> lines below it runs bare, and the lines queue after it', async ($, on) => {
  const s = await session($, on)
  const presentation = { isFullscreen: false, columns: 80 }
  await $.command.run({ command: 'compact', args: 'keep the plan\n>> AFTER', origin: { kind: 'composer' }, presentation } as never)
  await s.turnStart()
  expect(s.ran).toEqual(['/compact keep the plan'])
  await s.turnEnd()
  expect(s.entered).toEqual(['AFTER'])
})

test('what is waiting comes through a /clear, which starts the next session with fresh state', async ($, on) => {
  const s = await session($, on)
  await s.turnStart()
  await s.type('>> A\n>> B')
  await $.session.end({ reason: 'clear', sessionId: 'old', resume: { id: 'old' } } as never)
  // The kit keeps state across the clear; emptying the queue stands in for the fresh session.
  await s.type('>>clear')
  await s.turnEnd()
  await s.setBox('')
  expect(s.entered).toEqual(['A'])
  await s.turnStart()
  await s.turnEnd()
  expect(s.entered).toEqual(['A', 'B'])
})

test('when the box will not take the queue, >>edit leaves it as it was', async ($, on) => {
  const s = await session($, on)
  await s.turnStart()
  await s.type('>> A\n>> B')
  s.commands.refuseFill = true
  await s.type('>>edit')
  expect(s.toasts.at(-1)).toBe('msg-queue: The prompt box could not take the queue, so it is unchanged')
  await s.turnEnd()
  await s.turnStart()
  await s.turnEnd()
  expect(s.entered).toEqual(['A', 'B'])
})

test('a send that fails pauses what was queued behind it, and >> resumes it', async ($, on) => {
  const s = await session($, on)
  await s.type('>> THROWS\n>> NEXT').catch(() => undefined)
  expect(s.toasts.at(-1)).toContain('the prompt could not be sent')
  expect(s.entered).toEqual([])
  await s.type('>>')
  expect(s.entered).toEqual(['NEXT'])
})

test('a typed command whose >> lines hold an unknown /word runs nothing and queues nothing', async ($, on) => {
  const s = await session($, on)
  const presentation = { isFullscreen: false, columns: 80 }
  const out = await $.command.run({ command: 'compact', args: '\n>> /tmp/x.log explain', origin: { kind: 'composer' }, presentation } as never)
  expect(out.text).toBe('/tmp/x.log is not a command, so nothing was queued; start the message with other text to send it')
  expect(s.ran).toEqual([])
})

test('the >> lines below a typed command that starts a turn wait for that turn to end', async ($, on) => {
  const s = await session($, on)
  s.commands.startsTurn = true
  const presentation = { isFullscreen: false, columns: 80 }
  await $.command.run({ command: 'review', args: '>> AFTER', origin: { kind: 'composer' }, presentation } as never)
  await s.turnStart()
  expect(s.entered).toEqual([])
  await s.turnEnd()
  expect(s.entered).toEqual(['AFTER'])
})

test('the band shows the label, five messages, how many more, and long ones cut', async ($, on) => {
  const s = await session($, on)
  await s.turnStart()
  const long = 'x'.repeat(100)
  await s.type(['>> ' + long, '>> two\nsecond line', '>> 3', '>> 4', '>> 5', '>> 6', '>> 7'].join('\n'))
  const band = await $.ui.mount({ plugin: 'msg-queue', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: true } as never })
  expect(await band.find({ text: 'queued (7)' })).toBeDefined()
  expect(await band.find({ text: `  1. ${'x'.repeat(72)}…` })).toBeDefined()
  expect(await band.find({ text: '  2. two…' })).toBeDefined()
  expect(await band.find({ text: '  6. 6' })).toBeUndefined()
  expect(await band.find({ text: '  +2 more' })).toBeDefined()
})

test('the band says paused, and draws nothing of its own with nothing to show', async ($, on) => {
  const s = await session($, on)
  const band = await $.ui.mount({ plugin: 'msg-queue', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false } as never })
  expect(await band.find({ text: /queued|paused/ })).toBeUndefined()
  await s.turnStart()
  await s.type('>> A')
  await s.turnEnd('aborted')
  expect(await band.find({ text: '⏸ paused (1)' })).toBeDefined()
})

test('a session that ends other than by /clear carries nothing over', async ($, on) => {
  const s = await session($, on)
  await s.turnStart()
  await s.type('>> A')
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 'old', resume: { id: 'old' } } as never)
  await s.type('>>clear')
  await s.turnEnd()
  await s.setBox('')
  expect(s.entered).toEqual([])
})

test('a queue that came through a /clear is not doubled by the carried copy', async ($, on) => {
  const s = await session($, on)
  await s.turnStart()
  await s.type('>> A\n>> B')
  await $.session.end({ reason: 'clear', sessionId: 'old', resume: { id: 'old' } } as never)
  await s.turnEnd()
  await s.turnStart()
  await s.turnEnd()
  await s.turnStart()
  await s.turnEnd()
  expect(s.entered).toEqual(['A', 'B'])
})

test('Enter emptying the box just before a save does not count as a cancel', async ($, on) => {
  const s = await session($, on)
  await s.turnStart()
  await s.type('>> A\n>> B')
  await s.type('>>edit')
  // The poll sees the box Enter has just emptied, then the save arrives.
  await s.setBoxQuietly('')
  await s.type('>> A-EDITED')
  await s.advance(300)
  expect(s.toasts.some(t => t.includes('Edit cancelled'))).toBe(false)
  await s.turnEnd()
  expect(s.entered).toEqual(['A-EDITED'])
})
