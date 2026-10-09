# msg-queue

Line up messages for Claude while it works. Each one waits until the current task is completely finished, then goes in as a new task of its own.

## Why

While Claude is working, anything you type and send doesn't wait. Claude Code slips it into the task already running, the next time Claude pauses to use a tool. That is handy for steering ("use the other file"), but not when you mean "after that, do this next":

- the new request gets mixed into the current one, and Claude may switch to it halfway through
- you can't line up a few steps and walk away
- you end up watching for Claude to finish just to type the next thing

Claude Code's own "queue" shortcut (`ctrl+x enter`) gets slipped in the same way ([#99416](https://github.com/anthropics/claude-code/issues/99416)).

msg-queue gives you a real queue: start a line with `>>` and it waits its turn.

## Quick start

While Claude works, type:

```
>> run the tests and fix anything that fails
```

Press Enter. The message appears in a small list above the prompt and is sent once Claude has finished the current task. If Claude isn't busy, it goes right away.

## What you can do

**Queue several steps at once.** Each line that starts with `>> ` is its own message, sent one after another, each as a separate task. Lines without `>>` belong to the message above them.

```
>> fix the failing tests
   and keep the changes small
>> update the changelog
>> summarise what changed
```

**Say something now and queue the rest.** Text above the first `>>` line is sent straight away, like a normal message. Only the `>>` lines wait.

```
also check the README while you're at it
>> then open a pull request
```

**Queue a command.** A queued message that is a slash command runs as that command when its turn comes. Handy for compacting between long tasks:

```
>> build the feature
>> /compact
>> write the docs for it
```

**See what's waiting.** The list above the prompt shows the queue. Messages leave it as soon as they are sent.

**Change or remove queued messages.** Type `>>` on its own and press Enter. Everything still waiting comes back into the prompt box, one `>>` line each. Nothing is sent while you edit.

- change a line, or delete the ones you no longer want, and press Enter to save
- empty the box to cancel: the queue goes back exactly as it was

Messages that were already sent are never in the edit.

**Drop everything.** `>>clear` empties the queue.

**Stop and start.** If you press Esc to interrupt Claude, or a task fails, the queue pauses so nothing runs on its own. Type `>>` on its own to carry on. `>>edit` lets you change a paused queue before you carry on.

## Good to know

- A `>>` that will queue its line is shown in colour as you type. One in the middle of a line, inside a code block (between ```` ``` ````), or stuck to a word (`>>like this`) is ordinary text and goes to Claude as written.
- Images can't wait in the queue. A `>>` prompt with an image is refused while Claude is busy; send it without `>>`.
- A queued line can't start with a `/` that isn't a command, such as a file path. You'll get a notice and the prompt comes back to fix. Put a word first: `>> read /tmp/log.txt`.
- When Claude isn't busy and nothing is waiting, a `>>` message is simply sent as your prompt. Otherwise Claude Code shows "Prompt dropped by a hook" as msg-queue takes it. That's expected: the prompt went into the queue instead. Messages sent later from the queue are labelled "Prompt from the msg-queue plugin".
- `>>` isn't a slash command, so it won't get in the way of `/` commands like `/q` in the typeahead.

## Install

You need Claude Code 2.1.295 or newer. msg-queue is built on the Claude Code mod API, which is early access and may change between releases.

**From GitHub** (recommended):

```sh
claude plugin marketplace add romanlv/msg-queue
claude plugin install msg-queue@msg-queue
```

Start a new Claude Code session and type `>> hello` to check it works: with nothing running it is sent at once, like a normal message.

**From a copy on your machine**, for example a fork or a clone you have changed:

```sh
git clone https://github.com/romanlv/msg-queue.git
claude plugin marketplace add ./msg-queue
claude plugin install msg-queue@msg-queue
```

**Try it without installing**, for one session only:

```sh
git clone https://github.com/romanlv/msg-queue.git
claude --plugin-dir ./msg-queue
```

**Update** to the latest version:

```sh
claude plugin marketplace update msg-queue
claude plugin update msg-queue@msg-queue
```

**Turn it off, or remove it:**

```sh
claude plugin disable msg-queue@msg-queue     # keep it installed, but off
claude plugin uninstall msg-queue@msg-queue
claude plugin marketplace remove msg-queue
```

Changes take effect in the next session you start.

## Develop

From the repository folder:

```sh
claude --plugin-dir .      # start Claude Code with this copy loaded
claude plugin validate .
claude plugin test .
```
