# Neuralingual User Guide

Create personalized affirmation practice sets from the command line. Describe what you want to work on, and Neuralingual generates tailored affirmations and saves them to your library.

## Quick Start

### 1. Log In

The CLI uses Apple Sign-In for authentication. Running `neuralingual login` opens your browser where you sign in with your Apple ID. Your session is stored locally and refreshed automatically.

```bash
neuralingual login
```

By default, `neuralingual login` targets production. Use `--env dev` for development.

To log out:

```bash
neuralingual logout
```

### 2. Create Your First Set (60 Seconds)

```bash
neuralingual create "I want to feel calm and focused during my morning routine"
```

This sends your intent to the LLM, which generates a title, emoji, session context, and 20-40 personalized affirmations. Output:

```
Creating practice set (this may take 10-30 seconds)...

Created: Morning Calm
Intent ID: abc12345-...
Context: meditation

Affirmations (18):
  [x] I greet each morning with quiet confidence
  [x] My mind settles into clarity with each breath
  [x] I am present and grounded in this moment
  ...
```

### 3. Check Your Library

```bash
neuralingual library
```

Output:
```
ID        TITLE             Context     Affirmations  Audio  Render
abc12345  Morning Calm      meditation  18            no     -
```

### 4. Configure and Render Audio

```bash
# Browse available voices
neuralingual voices

# Configure render settings
neuralingual render configure abc12345 --voice evelyn --context meditation --duration 10

# Start the render and wait for completion
neuralingual render start abc12345 --wait

# Play the rendered audio
neuralingual play abc12345 --open
```

---

## Commands

### `neuralingual login`

Log in via Apple Sign-In. Opens a browser window for authentication.

```bash
neuralingual login
neuralingual login --env dev
```

### `neuralingual logout`

Clear stored tokens and log out.

```bash
neuralingual logout
```

### `neuralingual whoami`

Show your current user info, subscription tier, and credit balance.

```bash
neuralingual whoami
```

Output:
```
User:    Jane Smith
Email:   jane@example.com
ID:      usr_abc123
Tier:    standard
Credits: 15
Role:    user
```

### `neuralingual create <text>`

Create a new practice set from natural language. The LLM interprets your intent and generates personalized affirmations.

```bash
neuralingual create "I am becoming a confident public speaker"
neuralingual create "Deep restful sleep" --tone mystical
```

| Option | Description |
|--------|-------------|
| `--tone <tone>` | `grounded`, `open`, or `mystical` (default: your saved preference, or `open`) |

### `neuralingual library`

List all your practice sets with their status.

```bash
neuralingual library
neuralingual library --context sleep
neuralingual library --status rendered --sort title
neuralingual library --limit 5
```

| Option | Description |
|--------|-------------|
| `--context <ctx>` | Filter by session context |
| `--status <status>` | Filter: `rendered`, `pending`, or `failed` |
| `--sort <order>` | Sort: `newest`, `oldest`, or `title` (default: newest) |
| `--limit <n>` | Limit number of results |

### `neuralingual info <id>`

Show detailed info for a practice set including affirmations, render config, and share status.

```bash
neuralingual info abc12345
```

### `neuralingual search <query>`

Search your library by title or context.

```bash
neuralingual search "morning"
neuralingual search "sleep"
```

### `neuralingual rename <id>`

Rename a practice set's title or emoji.

```bash
neuralingual rename abc12345 --title "Morning Power"
neuralingual rename abc12345 --emoji "💪"
```

### `neuralingual delete <id>`

Delete a practice set from your library (with confirmation prompt).

```bash
neuralingual delete abc12345
neuralingual delete abc12345 --force   # skip confirmation
```

### `neuralingual credits`

Show your credit balance and recent transactions.

```bash
neuralingual credits
```

Output:
```
Credit Balance: 15
  Subscription: 10
  Purchased:    5

Recent transactions:
Date        Type           Amount  Balance
4/1/2026    subscription   +10     15
3/28/2026   render         -1      5
3/25/2026   purchase       +5      6
```

### `neuralingual download <render-job-id>`

Download rendered audio as an MP3 file.

```bash
neuralingual download xyz789
neuralingual download xyz789 -o my-session.mp3
```

| Option | Description |
|--------|-------------|
| `-o, --output <path>` | Output file path (default: `nl-<id>.mp3`) |

---

## Rendering Audio

### `neuralingual voices`

Browse available voices with filtering options.

```bash
neuralingual voices
neuralingual voices --gender Female --accent US
neuralingual voices --tier free --json
```

### `neuralingual voices preview <id>`

Play a short audio preview of a voice.

```bash
neuralingual voices preview evelyn
```

### `neuralingual render configure <id>`

Configure render settings for a practice set.

```bash
neuralingual render configure abc12345 --voice evelyn --context meditation --duration 10
neuralingual render configure abc12345 --voice evelyn --context sleep --duration 20 --pace 110 --preamble on
```

| Option | Description |
|--------|-------------|
| `--voice <id>` | Voice ID (required) |
| `--context <ctx>` | Session context (required) |
| `--duration <min>` | Duration in minutes (required) |
| `--pace <wpm>` | Pace in words per minute |
| `--background <key>` | Background sound storage key |
| `--background-volume <0-1>` | Background volume |
| `--repeats <n>` | Affirmation repeat count (1-5) |
| `--preamble <on\|off>` | Include intro/outro preamble |
| `--play-all <on\|off>` | Play all affirmations vs. fit within duration |

### `neuralingual render start <id>`

Start a render job. Use `--wait` to poll until completion.

```bash
neuralingual render start abc12345
neuralingual render start abc12345 --wait
```

### `neuralingual render status <id>`

Check render progress.

```bash
neuralingual render status abc12345
```

### `neuralingual rerender <id>`

Re-render with the current config (shortcut for render start).

```bash
neuralingual rerender abc12345 --wait
```

### `neuralingual play <id>`

Download rendered audio and print the local file path. Use `--open` to launch in the default audio player.

```bash
neuralingual play abc12345
neuralingual play abc12345 --open
```

---

## Sharing

### `neuralingual share <id>`

Generate a public share link for a practice set.

```bash
neuralingual share abc12345
```

### `neuralingual unshare <id>`

Revoke a share link.

```bash
neuralingual unshare abc12345
```

---

## Set Files (YAML Import/Export)

Manage complete practice sets as YAML files. Export, edit, and re-import.

### `neuralingual set export <id>`

Export a set to YAML (stdout).

```bash
neuralingual set export abc12345 > my-set.yaml
```

### `neuralingual set edit <id>`

Open a set in your `$EDITOR`, then apply changes on save.

```bash
neuralingual set edit abc12345
```

### `neuralingual set apply <id>`

Apply a YAML set file to an existing intent.

```bash
neuralingual set apply abc12345 --file my-set.yaml
cat edited.yaml | neuralingual set apply abc12345 --file -
```

### `neuralingual set create`

Create a new intent from a YAML set file.

```bash
neuralingual set create --file new-set.yaml
```

---

## Settings

### `neuralingual settings`

Show current user settings and context overrides.

```bash
neuralingual settings
```

### `neuralingual settings set`

Update your default tone preference or display name.

```bash
neuralingual settings set --tone grounded
neuralingual settings set --name "Jane"
```

---

## Builder Examples

### Create a Morning Affirmation Set

```bash
# Generate the set
neuralingual create "I want a powerful morning routine that sets me up for a productive day"

# Check the library for the new intent ID
neuralingual library
```

### Export, Edit in VS Code, Apply Changes

```bash
# Export to YAML
neuralingual set export abc12345 > my-set.yaml

# Edit in VS Code
code my-set.yaml

# Apply changes
neuralingual set apply abc12345 --file my-set.yaml
```

### Batch-Create Sets

```bash
for topic in "morning energy" "deep focus" "creative courage" "letting go" "gratitude"; do
  neuralingual create "I practice $topic every day. I strengthen $topic naturally."
done
```

---

## Concepts

### Intents

An intent is your starting point — a natural language description of what you want to practice. The LLM interprets your intent and generates affirmations tailored to it.

### Affirmations

The generated practice lines. Each has text, a tone (gentle/steady/focused/energizing/soothing), intensity (1-5), and enabled/disabled status.

### Session Contexts

The context determines default pace, pause timing, and background sound selection:

| Context | Use For |
|---------|---------|
| `general` | Default, all-purpose |
| `sleep` | Bedtime, falling asleep |
| `nap` | Short rest |
| `meditation` | Meditation practice |
| `workout` | Exercise |
| `focus` | Deep work |
| `walk` | Walking |
| `chores` | Household tasks |

### Tones

Set the overall tone of generated affirmations:

| Tone | Style |
|------|-------|
| `grounded` | Practical, present-focused |
| `open` | Expansive, possibility-oriented |
| `mystical` | Poetic, transcendent |

### Credits

Operations that use LLM or TTS resources consume credits. Your balance is split between subscription credits (reset periodically) and purchased credits (permanent).
