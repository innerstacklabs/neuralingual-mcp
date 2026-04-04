# neuralingual-mcp

CLI for [Neuralingual](https://neuralingual.com) — AI-powered affirmation practice sets.

Create personalized affirmation sets from natural language intent, render them as audio with premium voices, and manage your library from the command line.

## Install

```bash
npm install -g @innerstacklabs/neuralingual-mcp
```

Or run directly with npx:

```bash
npx @innerstacklabs/neuralingual-mcp login
```

## Quick Start

```bash
# Log in with Apple Sign-In (opens browser)
neuralingual login

# Create a practice set from intent text
neuralingual create "I want to feel confident before presentations"

# Browse your library
neuralingual library

# Get detailed info on a set
neuralingual info <id>

# Configure rendering
neuralingual voices              # browse available voices
neuralingual render configure <id> --voice <voice-id> --context general --duration 10

# Render and play
neuralingual render start <id> --wait
neuralingual play <id> --open
```

## Commands

| Command | Description |
|---|---|
| `login` | Log in via Apple Sign-In |
| `logout` | Log out and clear tokens |
| `whoami` | Show current user info |
| `library` | List your practice sets |
| `search <query>` | Search by title or context |
| `create <text>` | Create a new practice set |
| `info <id>` | Show detailed set info |
| `rename <id>` | Rename a practice set |
| `delete <id>` | Delete a practice set |
| `render configure` | Configure render settings |
| `render start` | Start a render job |
| `render status` | Check render progress |
| `rerender <id>` | Re-render with current config |
| `voices` | List available voices |
| `voices preview <id>` | Preview a voice |
| `play <id>` | Download/play rendered audio |
| `download <job-id>` | Download audio as MP3 |
| `credits` | Show credit balance |
| `share <id>` | Generate a share link |
| `unshare <id>` | Revoke a share link |
| `set export <id>` | Export set as YAML |
| `set edit <id>` | Edit set in $EDITOR |
| `set apply <id>` | Apply YAML changes |
| `set create` | Create set from YAML |
| `settings` | View/update preferences |

See the [User Guide](docs/USER_GUIDE.md) for detailed usage and examples.

## License

MIT
