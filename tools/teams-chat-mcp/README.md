# teams-chat-mcp

Local MCP server that lets any Claude Code session read, monitor, and (on
explicit request) send messages in Microsoft Teams **chats** Gregg is a member
of, via Microsoft Graph delegated auth. Built 2026-09-27.

**This folder is the source of record. The live install runs from
`C:\Users\gregg\.claude\tools\teams-chat-mcp\`** - after editing here, copy the
changed files there. The companion skill lives at
`C:\Users\gregg\.claude\skills\teams-chat\SKILL.md` (copy kept here as SKILL.md).

## Pieces

| File | Role |
|---|---|
| `server.py` | The MCP server: `find_chat`, `read_chat` (day/range + topic keywords), `poll_chat` (cursor-based monitoring), `send_chat_message` (posts as Gregg), `whoami` |
| `graphauth.py` | MSAL device-code auth, on-disk token cache, silent refresh |
| `login.py` | Interactive device-code sign-in (one-time) |
| `setup.py` | Creates `.venv`, installs `msal`, `mcp<2` (v2 renamed FastMCP), `requests`, `tzdata` (Windows has no system tz DB) |
| `config.json` | Entra app id `2438bfea-dee0-499b-a345-f9d9e38e79a6` ("TEMARK Teams Chat MCP", public client, delegated Chat.ReadWrite), tenant id, display timezone (America/Phoenix) |
| `smoketest.py` | Calls the tool functions directly (bypassing MCP transport) against live Graph |

`config.json` holds only public identifiers. Credentials live in
`token_cache.json` (refresh tokens - gitignored, never commit) created by
`login.py`.

## Setup on a new machine

```
python setup.py
.venv\Scripts\python.exe login.py          # device-code sign-in as Gregg
claude mcp add --scope user teams-chat -- <this dir>\.venv\Scripts\python.exe <this dir>\server.py
```

## Notes

- The token carries ONLY Chat.ReadWrite - `/me` profile reads 403, so
  `_my_display_name()` degrades gracefully (chat labels then include Gregg's
  own name; cosmetic).
- Graph returns chat messages newest-first; `read_chat` stops paginating once
  past the window start and returns oldest-first.
- Channels/email/calendar are NOT this server's job - the claude.ai
  Microsoft 365 connector covers those.
