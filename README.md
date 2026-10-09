# msg-queue

A Claude Code mod that holds messages until the running turn has fully ended, then sends each as a turn of its own.

A plain Enter while Claude works steers the running turn: Claude Code hands the message in at the next tool call. `chat:queueSubmit` (`ctrl+x enter`) is documented to wait its turn but is absorbed mid-turn the same way ([#99416](https://github.com/anthropics/claude-code/issues/99416)). `/qq` queues instead.

- `/qq {message}` adds a message to the queue, mid-turn or not; with nothing running it sends at once
- each turn that ends with an answer sends the next one, so every message runs as its own turn
- the queue shows above the prompt; finished and running messages drop off
- `/qq-edit` moves what is still queued back into the box as `/qq` lines; edit or delete lines and press Enter to queue them again
- `/qq-clear` drops the queue
- a queued message that starts with a slash command runs as that command: `/qq /compact keep the plan` compacts once everything queued before it has finished, and the next message waits for the compaction. A message led by anything else with a slash, such as a path, is refused; put other text first
- an interrupted or failed turn, a failed command, or a compaction cancelled with Esc pauses the queue; `/qq` on its own resumes it

One prompt can carry several messages: each line that opens with `/qq` starts a new one, and other lines belong to the message above them. Text above the first `/qq` line is sent at once, as a plain Enter would send it: mid-turn it steers the running turn. A `/qq` line inside a code fence is text.

```
fix the failing tests
/qq run lint after
/qq /compact
/qq summarise what changed
```

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
