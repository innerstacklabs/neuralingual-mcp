# Changelog

All notable changes to this project will be documented in this file.

## [0.5.0] - 2026-05-26

### Added
- `nl_unshare` tool — revoke public share links for practice sets
- `nl_sync_affirmations` tool — declarative add/update/remove affirmations in a single call
- `nl_set_export` / `nl_set_import` tools — YAML-based set editing workflow
- `nl_affirmation_add` / `nl_affirmation_delete` tools — individual affirmation management
- `nl_affirmations_feedback` / `nl_affirmations_toggle` tools — batch feedback and enable/disable
- `nl_generate_more` tool — generate additional affirmations for existing sets
- `nl_library_list` / `nl_library_view` tools — enhanced library browsing with play stats
- `nl_guide` tool — render framework methodology as markdown
- `nl_source_twitter` tool — extract text from Twitter/X posts
- `nl_catalog_browse` / `nl_catalog_view` / `nl_catalog_copy` tools — browse and copy curated catalog
- `nl_context_settings_list` / `nl_context_settings_update` / `nl_context_settings_reset` tools
- `nl_wizard_defaults` tool — resolved defaults for render configuration
- `nl_user_profile` / `nl_user_set_username` / `nl_user_check_username` tools
- `nl_playback_start` / `nl_playback_complete` tools — session tracking
- `nl_intent_update` / `nl_intent_delete` tools — intent management
- Smithery configuration for directory listing
- Automatic token refresh on 401 responses
- Rich rate limit handling with `Retry-After` header support

### Changed
- Tool count: 28 → 44
- Improved error messages with structured HTTP status codes
- Better ID resolution: prefix matching with ambiguity detection

## [0.4.0] - 2026-05-15

### Added
- Initial public release on npm
- 28 MCP tools for library management, creation, rendering, and playback
- CLI with `neuralingual` command for direct terminal usage
- Apple Sign-In authentication
- Source extraction (URL, YouTube, PDF)
- YAML export/import workflow
