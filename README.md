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

### MCP Tools (44 tools)

**Library & Discovery**

| Tool | Description |
|---|---|
| `nl_library` | List all practice sets with title, context, render status |
| `nl_library_list` | List playlists with play count and last-played metadata |
| `nl_library_view` | View a playlist with affirmations, feedback, and play stats |
| `nl_info` | Full set details — affirmations, render config, share status |
| `nl_search` | Search sets by keyword |
| `nl_guide` | Render the framework (methodology, principles, sources) as markdown |

**Creation & Editing**

| Tool | Description |
|---|---|
| `nl_create` | Create a new set from intent text and/or source material (costs 1 credit) |
| `nl_rename` | Update title and/or emoji |
| `nl_delete` | Delete a practice set |
| `nl_intent_update` | Update intent text, title, emoji, or tone |
| `nl_intent_delete` | Delete a playlist (alias for nl_delete) |
| `nl_generate_more` | Generate additional affirmations for an existing set (costs 1 credit) |

**Affirmation Management**

| Tool | Description |
|---|---|
| `nl_affirmation_add` | Add a custom affirmation to a playlist |
| `nl_affirmation_delete` | Delete a single affirmation |
| `nl_affirmations_feedback` | Like or dislike affirmations (batch) |
| `nl_affirmations_toggle` | Enable or disable affirmations (batch) |
| `nl_sync_affirmations` | Declarative sync — add, update, remove affirmations |
| `nl_set_export` | Export set as editable YAML (optionally with framework) |
| `nl_set_import` | Apply edited YAML back to a set |

**Audio & Rendering**

| Tool | Description |
|---|---|
| `nl_voices` | List available voices with accent, gender, tier |
| `nl_render_configure` | Configure voice, background, pace, duration, context |
| `nl_render_start` | Start audio rendering |
| `nl_render_status` | Check render progress |
| `nl_rerender` | Re-render with current config |
| `nl_play` | Download rendered audio to local cache |
| `nl_playback_start` | Log the start of a practice session |
| `nl_playback_complete` | Record session duration and completion |

**Source Extraction**

| Tool | Description |
|---|---|
| `nl_source_extract` | Extract text from a web article URL |
| `nl_source_youtube` | Extract transcript from a YouTube video |
| `nl_source_twitter` | Extract text from a Twitter/X post |
| `nl_source_pdf` | Upload and extract text from a local PDF |

**Catalog**

| Tool | Description |
|---|---|
| `nl_catalog_browse` | Browse curated catalog with filtering and sorting |
| `nl_catalog_view` | View a catalog item with full details |
| `nl_catalog_copy` | Copy a catalog playlist to your library |

**Settings & Preferences**

| Tool | Description |
|---|---|
| `nl_context_settings_list` | List per-context default settings |
| `nl_context_settings_update` | Update defaults for a session context |
| `nl_context_settings_reset` | Reset a context to system defaults |
| `nl_wizard_defaults` | Get resolved wizard defaults (voice, background, binaural, etc.) |

**Account**

| Tool | Description |
|---|---|
| `nl_user_profile` | Get user profile, subscription tier, and credits |
| `nl_user_set_username` | Set or update username |
| `nl_user_check_username` | Check username availability |
| `nl_credits` | Check credit balance |
| `nl_share` | Generate a public share link |
| `nl_unshare` | Revoke a public share link |

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
