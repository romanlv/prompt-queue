# msg-queue

A Claude Code mod that holds messages until the running turn has fully ended, then sends each as a turn of its own.

A plain Enter while Claude works steers the running turn: Claude Code hands the message in at the next tool call. `chat:queueSubmit` (`ctrl+x enter`) is documented to wait its turn but is absorbed mid-turn the same way ([#99416](https://github.com/anthropics/claude-code/issues/99416)). `/qq` queues instead.

- `/qq {message}` adds a message to the queue, mid-turn or not; with nothing running it sends at once
- each turn that ends with an answer sends the next one, so every message runs as its own turn
- the queue shows above the prompt; finished and running messages drop off
- `/qq-edit` moves what is still queued back into the box as `/qq` lines; edit or delete lines and press Enter to queue them again
- `/qq-clear` drops the queue
- an interrupted or failed turn pauses the queue; `/qq` on its own resumes it

One `/qq` can carry several messages: each line that opens with `/qq` starts a new one, and other lines belong to the message above them.

```
/qq fix the failing tests
and run lint after
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
