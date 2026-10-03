# Cache Keeper: a Claude Code mod you can build without coding

Idea credit: [Nate Herk (@nateherk)](https://x.com/nateherk), from his video
[Claude Code Mods Are Game Changers](https://www.youtube.com/watch?v=9hetShMMp2s).

## What it does

Claude Code keeps your chat in a **prompt cache**. On a Claude subscription the cache lasts
**60 minutes** after your last message. After that it goes **cold**, and your next message
re-reads the whole chat from scratch. That uses up your limits much faster.

Cache Keeper puts a small row of pills above your prompt box:

| Pill | What it tells you |
|---|---|
| `52m · $0.31` | Time left before the cache goes cold, and what re-warming it would cost |
| `ctx 159k/300k` | How full the chat is, compared with the auto-compact point |
| `5h 72%` · `wk 64%` | How much of your 5-hour and weekly limits is left |

Each pill has a small dot: green = fine, yellow = watch it, red = act now.

And buttons:

| Button | What it does |
|---|---|
| 🔥 | Keeps the cache warm (sends a tiny message so the 60-minute clock restarts) |
| 📦 | Compacts the chat now (Claude summarizes it, so it gets smaller) |
| 🤝 | Hand off: Claude writes a summary of where you are. Then **Clear & continue** starts a fresh chat with that summary already sent |
| 📊 | Opens the details pane: everything above, plus what the chat would cost at API prices, plus auto-compact controls |

It also:
- **warns you 5 minutes before the cache goes cold**, so you can keep it warm, compact or hand off;
- **auto-compacts between turns** at a sensible point: 300k tokens on 1M-context models
  (Claude Code's own default waits until about 967k), 70% of the window on smaller models,
  never below 100k. You can change this for any chat.

It sends nothing to the internet. It only reads the usage numbers Claude Code already has.

---

## Before you start

- The **Claude desktop app**, updated to the latest version (mods are a new feature).
- A Claude plan that includes **Claude Code** (the **Code** tab in the app).
- About 10 minutes.

You don't need to know how to code. Claude writes the code; you click a few buttons.

---

## Option A: build it yourself with one prompt (recommended)

### Step 1. Update the app
Restart the Claude desktop app so it installs any waiting update. If you're unsure, download the
latest version from [claude.ai/download](https://claude.ai/download).

### Step 2. Open a Code session
Click the **Code** tab and start a new session. Any folder is fine.

### Step 3. Paste this prompt and press Enter

```text
Build me a Claude Code mod called cache-keeper.

Above the prompt box, show a row of small outlined pills with gray text and one small colored
status dot each (green / yellow / red, soft colors that follow the light and dark theme):
1. Prompt-cache countdown (1 hour on a subscription, 5 minutes otherwise) and what re-warming
   the cache would cost.
2. Context used, compared with the auto-compact point.
3. 5-hour and weekly limits left.

Next to the pills, add emoji-only buttons with no colored background:
🔥 keep the cache warm (hide it once the cache is cold), 📦 compact now,
🤝 handoff, 📊 open a details pane.
Handoff runs my handoff skill if I have one, otherwise a built-in handoff prompt. When the
handoff is ready, show a "Clear & continue" button that clears the chat and sends the handoff
summary into the fresh chat.

The details pane shows the same numbers in full, the session cost at API prices, and
auto-compact controls (−50k, +50k, turn on/off, reset).

Show a toast 5 minutes before the cache goes cold.

Auto-compact only between turns, after a finished answer: 300k tokens on 1M-context models,
70% of smaller windows, never below 100k. If a compaction is refused, wait for 50k more
context before trying again. Let me override it per session with
/cache-keeper autocompact <250k|off|auto>.

Make the cache TTL, warning minutes, input price and auto-compact point into settings.
Validate the mod when you're done.
```

### Step 4. Say yes to hot reloading
While Claude works, a question appears: **"Enable hot reloading for this session?"**
Click **Enable for this session**. This lets the mod load in this chat without restarting.

### Step 5. Wait for Claude to finish
When Claude's reply ends, the mod loads. Send any short message (for example `hi`): the cache
only starts after the first reply. The pills appear above your prompt box.

### Step 6. Try it
- Watch the countdown on the first pill.
- Click 📊 to open the details pane.
- Click 🤝, wait for the summary, then click **Clear & continue**.

Want a change? Just say it in plain words: "make the colors softer", "use a different emoji
for compact", "warn me 10 minutes before instead of 5". Claude edits the mod and it reloads
when the reply ends.

### Step 7. Keep it in every session
Type: **Make this mod load in every session.**
Claude copies the mod to a permanent folder and adds one line to your Claude settings.
Start a new session to see it there.

To stop it later, type: **Stop loading cache-keeper in every session.**

---

## Option B: use my files

The [`cache-keeper`](cache-keeper) folder in this repository is the finished mod. To use it:

1. Open a Code session and paste:
   **Install the cache-keeper mod from https://github.com/etding/cache-keeper into a permanent folder, check it with `claude plugin validate`, then make it load in every session.**
2. Start a new session.

Prefer doing it by hand? Click the green **Code** button on this page → **Download ZIP**, unzip it,
and move the `cache-keeper` folder somewhere permanent (for example `Documents/claude-mods`).
Then ask Claude: **Load the mod in `<that folder>` in every session.**

Only load mods whose code you trust. A mod runs inside Claude Code. Read the files, or ask Claude
"read this mod and tell me everything it does" before you load it.

---

## Settings

Ask Claude to change them, or open the plugin settings menu:

| Setting | Default | Meaning |
|---|---|---|
| Prompt-cache TTL | `auto` | 1h on a subscription, 5m otherwise |
| Warn minutes | `5` | When the cold-cache warning appears |
| Input price | `0` (auto) | Used for the re-warm cost; auto works it out from your session |
| Auto-compact point | `auto` | `auto`, `off`, or a number like `250k` |
| Handoff command | `anthropic-skills:context-handoff` | The skill the 🤝 button runs; if it's missing, a built-in prompt is used |

For one chat only: `/cache-keeper autocompact 250k` (or `off`, or `auto`).

## If something looks wrong

| Problem | Fix |
|---|---|
| No pills at all | Send one message first. The cache starts after the first reply. |
| Still nothing | Ask Claude: "cache-keeper didn't load. Run `claude plugin validate` on it and fix it." |
| No 5h / weekly pills | These only show on subscription plans. |
| Emoji look odd | Emoji are drawn by your system font. Ask Claude to swap the emoji. |
