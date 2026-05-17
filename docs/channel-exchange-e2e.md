# Channel Exchange E2E

Run the SDK replacement true-path regression with:

```bash
pnpm run test:e2e:channel-exchange
```

The slice creates an isolated repo-local NanoClaw data root, writes a real inbound session DB row, runs the real `container/agent-runner` poll loop under Bun with the Claude Code provider, sends the turn through the provider-local channel exchange/MCP server, and drains NanoClaw host delivery back to a target-equivalent channel adapter.

Environment knobs:

- `CLAUDE_CODE_EXECUTABLE`: Claude Code CLI path, default `claude`.
- `NANOCLAW_E2E_MODEL`: Claude Code model argument, default `sonnet`.
- `NANOCLAW_E2E_TIMEOUT_MS`: end-to-end timeout, default `300000`.
- `NANOCLAW_E2E_WORK_DIR`: repo-local working directory, default `.nanoclaw/e2e/channel-exchange`.
- `NANOCLAW_E2E_EVIDENCE_DIR`: repo-local evidence directory, default inside the run directory.
- `NANOCLAW_E2E_RUN_ID`: stable run id for evidence filenames.

The command exits `0` only when the expected nonce is delivered through NanoClaw host delivery. Missing tools, Claude Code quota/auth failures, MCP/exchange startup errors, provider exits, and host delivery failures are reported as `CHANNEL_EXCHANGE_E2E_BLOCKED phase=<environment|provider|exchange_mcp|delivery> ...` with a markdown transcript, DB snapshot, and runner logs.
