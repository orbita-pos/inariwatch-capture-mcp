# @inariwatch/capture-mcp

Local **MCP dev-mode server** for [`@inariwatch/capture`](https://www.npmjs.com/package/@inariwatch/capture). Exposes the most recent errors captured by your app over JSON-RPC 2.0 / stdio so editors (Cursor, Claude Code, Continue, …) can read them directly while you're debugging — no cloud round-trip needed.

## How it works

1. Your app runs `@inariwatch/capture` with `INARIWATCH_DEV_LOG=1` (or sets `INARIWATCH_DEV_LOG_PATH=…`). Every captured event is appended to `${cwd}/.inariwatch/errors.jsonl`.
2. Your editor's MCP client spawns `npx @inariwatch/capture-mcp`. The server reads the JSONL tail and serves it via three tools.
3. The editor's LLM calls those tools while you ask "what errors am I hitting right now?"

## Tools exposed

| Tool | Purpose |
|---|---|
| `get_recent_errors` | Last N errors, filterable by severity |
| `diagnose_error_id` | Full event by `fingerprint` (stack, locals, hypotheses, …) |
| `get_locals_at_frame` | Forensic locals + async stack at a specific frame |

## Editor setup

### Cursor / Claude Code / Continue

Add to your MCP config (e.g. `~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "inariwatch-capture": {
      "command": "npx",
      "args": ["-y", "@inariwatch/capture-mcp"],
      "env": {
        "INARIWATCH_DEV_LOG_PATH": "/absolute/path/to/your-project/.inariwatch/errors.jsonl"
      }
    }
  }
}
```

`INARIWATCH_DEV_LOG_PATH` is optional; defaults to `${cwd}/.inariwatch/errors.jsonl`.

## Status

`v0.1.0-alpha.0` — dev-mode only, single-file JSONL store. The cloud-side production tools live in the hosted MCP server at `mcp.inariwatch.com` (not this package).

## License

MIT
