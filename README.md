# msg-queue

A Claude Code mod that holds messages until the running turn has fully ended, then sends each as a turn of its own.

A plain Enter while Claude works steers the running turn: Claude Code hands the message in at the next tool call. `chat:queueSubmit` (`ctrl+x enter`) is documented to wait its turn but is absorbed mid-turn the same way ([#99416](https://github.com/anthropics/claude-code/issues/99416)). A prompt led by `>>` queues instead.

- `>> {message}` adds a message to the queue, mid-turn or not; with nothing running it sends at once
- each turn that ends with an answer sends the next one, so every message runs as its own turn
- the queue shows above the prompt; finished and running messages drop off
- `>>edit` moves what is still queued back into the box as `>>` lines; edit or delete lines and press Enter to queue them again
- `>>clear` drops the queue
- a queued message that starts with a slash command runs as that command: `>> /compact keep the plan` compacts once everything queued before it has finished, and the next message waits for the compaction. A message led by anything else with a slash, such as a path, is refused; put other text first
- an interrupted or failed turn, a failed command, or a compaction cancelled with Esc pauses the queue; `>>` on its own resumes it

One prompt can carry several messages: each line that opens with `>> ` starts a new one, and other lines belong to the message above them. Text above the first `>>` line is sent at once, as a plain Enter would send it: mid-turn it steers the running turn. A `>>` line inside a code fence is text, and `>>` must be followed by a space or the line's end.

```
fix the failing tests
>> run lint after
>> /compact
>> summarise what changed
```

Each `>>` that will queue its line shows in colour as you type, so a plain one (mid-line, in a fence, or before a word) is easy to tell apart. `>>` is not a slash command, so it stays out of the `/` typeahead. Claude Code notes each prompt the mod takes as "Prompt dropped by a hook".

## Install

```sh
claude plugin marketplace add romanlv/msg-queue
claude plugin install msg-queue@msg-queue
```

Tested with Claude Code 2.1.295. The mod API is early access and may change between releases.

## Develop

```sh
claude --plugin-dir ~/dev/cc/msg-queue
claude plugin validate .
claude plugin test .
```
