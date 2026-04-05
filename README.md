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

## MCP Server (AI Assistant Integration)

This package includes an MCP server that lets AI assistants (Claude Code, etc.) manage your Neuralingual library directly.

### Setup

Add to your `.mcp.json` (Claude Code) or MCP client config:

```json
{
  "mcpServers": {
    "neuralingual": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "-p", "@innerstacklabs/neuralingual-mcp", "neuralingual-mcp"]
    }
  }
}
```

**Prerequisite:** Run `neuralingual login` first to authenticate.

### MCP Tools

| Tool | Description |
|---|---|
| `nl_library` | List all practice sets with title, context, render status |
| `nl_info` | Full set details — affirmations, render config, share status |
| `nl_search` | Search sets by keyword |
| `nl_create` | Create a new set from intent text (costs 1 credit) |
| `nl_delete` | Delete a practice set |
| `nl_rename` | Update title and/or emoji |
| `nl_play` | Download rendered audio to local cache |
| `nl_credits` | Check credit balance |
| `nl_voices` | List available voices with accent, gender, tier |
| `nl_render_configure` | Configure voice, background, pace, duration, context |
| `nl_render_start` | Start audio rendering |
| `nl_render_status` | Check render progress |
| `nl_rerender` | Re-render with current config |
| `nl_share` / `nl_unshare` | Generate or revoke public share links |
| `nl_set_export` | Export set as editable YAML |
| `nl_set_import` | Apply edited YAML back to a set |
| `nl_sync_affirmations` | Declarative sync — add, update, remove affirmations |

### Example (Claude Code)

```
> Create a neuralingual set about being a great father

Creating "Present & Intentional Dad" with 30 affirmations...
Drew on Fred Rogers, Brené Brown, and John Gottman.

> Render it with Graham's voice, meditation context, 15 minutes

Configured: Meditation · Graham · Acoustic Guitar · 15m
Rendering... done.

> Play it

Downloaded to ~/.config/neuralingual/audio/abc123.mp3
```

## License

MIT
