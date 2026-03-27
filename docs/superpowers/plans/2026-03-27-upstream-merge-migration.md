# Upstream Merge Migration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge upstream/main (332 commits) into local main, adopting the channel registry architecture and OneCLI credential management while preserving our host exec proxy and MCP proxy features.

**Architecture:** The merge uses upstream as the base for all conflicting code, then grafts our three local feature blocks back on: (1) MCP proxy server, (2) host exec proxy, (3) skills/plugins sync. The channel registry replaces hardcoded WhatsApp/Telegram init. OneCLI replaces .env-based secret passing to containers. Telegram channel becomes a registry-compatible module.

**Tech Stack:** Node.js, TypeScript, Docker containers, OneCLI SDK, Claude Agent SDK

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/config.ts` | Merge | Adopt upstream (OneCLI, timezone, trigger functions) + add MCP_PROXY_PORT, HOST_EXEC_ALLOWLIST |
| `src/index.ts` | Merge | Adopt upstream channel registry loop + add MCP proxy startup/shutdown + host MCP server URL injection |
| `src/container-runner.ts` | Merge | Adopt upstream OneCLI + .env shadow + mtime cache + add host-exec mounts + skills/plugins sync + hostMcpServers field |
| `container/agent-runner/src/index.ts` | Merge | Adopt upstream (no secrets, script support) + add hostMcpServers field + MCP http proxy config |
| `src/mcp-proxy.ts` | Keep | Unchanged — our MCP proxy + host exec proxy server |
| `container/host-exec.mjs` | Keep | Unchanged — container-side host exec stub |
| `src/channels/registry.ts` | From upstream | Channel registry (new file from upstream) |
| `src/channels/index.ts` | From upstream + modify | Barrel file — uncomment telegram import |
| `src/channels/telegram.ts` | Modify | Adapt to registry pattern (self-register via `registerChannel`) |
| `package.json` | Merge | Adopt upstream deps + keep `@modelcontextprotocol/sdk` |
| `.env.example` | Merge | Both sides' additions |
| `CLAUDE.md` | Merge | Adopt upstream structure + keep host exec proxy docs |
| All other upstream-only new files | From upstream | `src/remote-control.ts`, `src/sender-allowlist.ts`, `src/timezone.ts`, etc. |

---

### Task 1: Create merge branch and do initial merge accepting upstream for all non-conflicting files

**Files:**
- All files in the repository

- [ ] **Step 1: Create a working branch**

```bash
git checkout -b merge-upstream-2026-03-27
```

- [ ] **Step 2: Start the merge, accepting upstream for conflicts as starting point**

```bash
git merge upstream/main --no-commit --no-ff
```

This will stop with 8 conflicts. We'll resolve them one by one in subsequent tasks.

- [ ] **Step 3: For package-lock.json, accept upstream and regenerate later**

```bash
git checkout --theirs package-lock.json
git add package-lock.json
```

- [ ] **Step 4: Commit checkpoint**

Do NOT commit yet — we resolve all conflicts first, then commit as one merge.

---

### Task 2: Resolve `.env.example` conflict

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: View the conflict**

```bash
git diff --diff-filter=U -- .env.example
```

- [ ] **Step 2: Accept both sides' additions**

The conflict is both sides appending new env vars. Accept upstream's version then append our local additions (`HOST_EXEC_ALLOWLIST`, `MCP_PROXY_PORT`). The final file should contain all env vars from both sides.

- [ ] **Step 3: Stage**

```bash
git add .env.example
```

---

### Task 3: Resolve `CLAUDE.md` conflict

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Accept upstream as base**

```bash
git checkout --theirs CLAUDE.md
```

- [ ] **Step 2: Add back our host exec proxy documentation**

After the "## Troubleshooting" section, add the "## Host Exec Proxy" section from our local version. Also add `mcp-proxy.ts` and `host-exec.mjs` to the Key Files table. Keep the `language: 'zh-CN'` note if relevant.

- [ ] **Step 3: Stage**

```bash
git add CLAUDE.md
```

---

### Task 4: Resolve `src/config.ts` conflict

**Files:**
- Modify: `src/config.ts`

- [ ] **Step 1: Accept upstream as base**

```bash
git checkout --theirs src/config.ts
```

- [ ] **Step 2: Add our local config exports at the end of the file**

Append after the `TIMEZONE` export:

```typescript
// MCP Proxy port for exposing host MCP servers to container agents
export const MCP_PROXY_PORT = parseInt(process.env.MCP_PROXY_PORT || '18321', 10);

// Host commands that container agents can execute via the exec proxy
export const HOST_EXEC_ALLOWLIST =
  process.env.HOST_EXEC_ALLOWLIST || envConfig.HOST_EXEC_ALLOWLIST || '';
```

Also add `'HOST_EXEC_ALLOWLIST'` to the `readEnvFile()` call's array.

- [ ] **Step 3: Stage**

```bash
git add src/config.ts
```

---

### Task 5: Resolve `src/container-runner.ts` conflict — adopt OneCLI + preserve host exec/MCP features

**Files:**
- Modify: `src/container-runner.ts`

This is a major conflict. Strategy: start from upstream, then graft back our features.

- [ ] **Step 1: Accept upstream as base**

```bash
git checkout --theirs src/container-runner.ts
```

- [ ] **Step 2: Add imports for our features**

Add to the import section:

```typescript
import { readHostExecAllowlist } from './mcp-proxy.js';
import { HOST_EXEC_ALLOWLIST } from './config.js';
```

- [ ] **Step 3: Add `hostMcpServers` to ContainerInput interface**

```typescript
export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  script?: string;
  hostMcpServers?: Record<string, { url: string }>;
}
```

- [ ] **Step 4: Add `language: 'zh-CN'` to the settings.json write in `buildVolumeMounts`**

In the `if (!fs.existsSync(settingsFile))` block, add `language: 'zh-CN'` at the top level of the JSON object (alongside `env`).

- [ ] **Step 5: Add skills/plugins sync to `buildVolumeMounts`**

After the container skills sync block (which upstream already has), add host user skills sync and plugins sync blocks from our local version. This is the code that syncs `~/.claude/skills/` and `~/.claude/plugins/` into the container. Add `import os from 'os';` to the imports.

```typescript
// Sync host user's skills (from ~/.claude/skills/) so container agents
// have the same skills available as the host Claude Code instance.
const hostClaudeDir = path.join(os.homedir(), '.claude');
const hostSkillsDir = path.join(hostClaudeDir, 'skills');
if (fs.existsSync(hostSkillsDir)) {
  for (const entry of fs.readdirSync(hostSkillsDir)) {
    const srcPath = path.join(hostSkillsDir, entry);
    const realSrc = fs.realpathSync(srcPath);
    if (!fs.statSync(realSrc).isDirectory()) continue;
    const dstDir = path.join(skillsDst, entry);
    fs.cpSync(realSrc, dstDir, { recursive: true });
  }
}

// Sync host user's plugins
const hostPluginsDir = path.join(hostClaudeDir, 'plugins');
const pluginsDst = path.join(groupSessionsDir, 'plugins');
if (fs.existsSync(hostPluginsDir)) {
  const hostCacheDir = path.join(hostPluginsDir, 'cache');
  if (fs.existsSync(hostCacheDir)) {
    const dstCacheDir = path.join(pluginsDst, 'cache');
    fs.cpSync(hostCacheDir, dstCacheDir, {
      recursive: true,
      filter: (src) => !src.includes('/.git'),
    });
  }
  const installedFile = path.join(hostPluginsDir, 'installed_plugins.json');
  if (fs.existsSync(installedFile)) {
    const content = fs.readFileSync(installedFile, 'utf-8');
    const rewritten = content.replaceAll(hostClaudeDir, '/home/node/.claude');
    fs.mkdirSync(pluginsDst, { recursive: true });
    fs.writeFileSync(path.join(pluginsDst, 'installed_plugins.json'), rewritten);
  }
  for (const configFile of ['blocklist.json', 'known_marketplaces.json']) {
    const src = path.join(hostPluginsDir, configFile);
    if (fs.existsSync(src)) {
      fs.mkdirSync(pluginsDst, { recursive: true });
      fs.copyFileSync(src, path.join(pluginsDst, configFile));
    }
  }
}
```

- [ ] **Step 6: Add host-exec wrapper generation to `buildVolumeMounts`**

Before the `additionalMounts` block, add:

```typescript
// Host command execution stubs
const hostExecDir = path.join(DATA_DIR, 'sessions', group.folder, 'host-exec');
const allowedCommands = readHostExecAllowlist(HOST_EXEC_ALLOWLIST);
if (allowedCommands.length > 0) {
  fs.mkdirSync(hostExecDir, { recursive: true });
  const proxySrc = path.join(process.cwd(), 'container', 'host-exec.mjs');
  if (fs.existsSync(proxySrc)) {
    fs.copyFileSync(proxySrc, path.join(hostExecDir, 'proxy.mjs'));
  }
  for (const cmd of allowedCommands) {
    const stub = `#!/bin/bash\nexec node /opt/host-exec/proxy.mjs "${cmd}" "$@"\n`;
    const stubPath = path.join(hostExecDir, cmd);
    fs.writeFileSync(stubPath, stub, { mode: 0o755 });
  }
  mounts.push({
    hostPath: hostExecDir,
    containerPath: '/opt/host-exec',
    readonly: true,
  });
}
```

- [ ] **Step 7: Add host gateway and PATH to `buildContainerArgs`**

In the `buildContainerArgs` function, after the `hostGatewayArgs()` call, add:

```typescript
// Prepend host-exec stubs to PATH so agents can call proxied commands directly
args.push('-e', 'PATH=/opt/host-exec:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin');
```

Note: upstream already calls `hostGatewayArgs()` which handles `--add-host`. We just need the PATH.

- [ ] **Step 8: Add `script` field to writeTasksSnapshot**

Check that the task snapshot includes the `script` field (upstream added this). Verify the type definition.

- [ ] **Step 9: Stage**

```bash
git add src/container-runner.ts
```

---

### Task 6: Resolve `container/agent-runner/src/index.ts` conflict — adopt upstream + add hostMcpServers

**Files:**
- Modify: `container/agent-runner/src/index.ts`

- [ ] **Step 1: Accept upstream as base**

```bash
git checkout --theirs container/agent-runner/src/index.ts
```

- [ ] **Step 2: Add `hostMcpServers` to ContainerInput interface**

```typescript
interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  script?: string;
  hostMcpServers?: Record<string, { url: string }>;
}
```

- [ ] **Step 3: Add host MCP servers to the `query()` call's `mcpServers` config**

In the `runQuery` function, find the `mcpServers` config object. After the existing `nanoclaw` entry, add dynamic host MCP servers:

```typescript
mcpServers: {
  nanoclaw: {
    command: 'node',
    args: [mcpServerPath],
    env: {
      NANOCLAW_CHAT_JID: containerInput.chatJid,
      NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
      NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
    },
  },
  // Host MCP servers proxied via HTTP from the host
  ...(containerInput.hostMcpServers
    ? Object.fromEntries(
        Object.entries(containerInput.hostMcpServers).map(([name, config]) => [
          name,
          { type: 'http' as const, url: config.url },
        ]),
      )
    : {}),
},
```

- [ ] **Step 4: Add host MCP servers to `allowedTools`**

In the `allowedTools` array, after `'mcp__nanoclaw__*'`, add dynamic entries:

```typescript
allowedTools: [
  'Bash',
  'Read', 'Write', 'Edit', 'Glob', 'Grep',
  'WebSearch', 'WebFetch',
  'Task', 'TaskOutput', 'TaskStop',
  'TeamCreate', 'TeamDelete', 'SendMessage',
  'TodoWrite', 'ToolSearch', 'Skill',
  'NotebookEdit',
  'mcp__nanoclaw__*',
  ...(containerInput.hostMcpServers
    ? Object.keys(containerInput.hostMcpServers).map(name => `mcp__${name}__*`)
    : []),
],
```

- [ ] **Step 5: Add log for host MCP servers**

After reading stdin and parsing containerInput, add:

```typescript
if (containerInput.hostMcpServers) {
  log(`Host MCP servers: ${Object.keys(containerInput.hostMcpServers).join(', ')}`);
}
```

- [ ] **Step 6: Stage**

```bash
git add container/agent-runner/src/index.ts
```

---

### Task 7: Resolve `package.json` conflict

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Accept upstream as base**

```bash
git checkout --theirs package.json
```

- [ ] **Step 2: Add back our `@modelcontextprotocol/sdk` dependency**

Add to `dependencies`:

```json
"@modelcontextprotocol/sdk": "^1.12.1"
```

Note: upstream removed WhatsApp/Telegram deps from core (they're skill branches now). This is correct — we should NOT add them back here.

- [ ] **Step 3: Stage**

```bash
git add package.json
```

---

### Task 8: Resolve `src/index.ts` conflict — adopt channel registry + preserve MCP proxy

**Files:**
- Modify: `src/index.ts`

This is the largest conflict. Strategy: accept upstream's registry-based architecture, then add back MCP proxy lifecycle and host MCP server URL injection.

- [ ] **Step 1: Accept upstream as base**

```bash
git checkout --theirs src/index.ts
```

- [ ] **Step 2: Add MCP proxy imports**

Add to import section:

```typescript
import { McpProxyServer, readHostExecAllowlist, readHostMcpServers } from './mcp-proxy.js';
import { HOST_EXEC_ALLOWLIST, MCP_PROXY_PORT } from './config.js';
```

(Note: HOST_EXEC_ALLOWLIST and MCP_PROXY_PORT need to be added to the existing config import line.)

- [ ] **Step 3: Add MCP proxy state variable**

After `const queue = new GroupQueue();`, add:

```typescript
let mcpProxy: McpProxyServer | null = null;
```

- [ ] **Step 4: Add MCP proxy startup in `main()`**

After `loadState()` and before the OneCLI agent loop, add:

```typescript
// Start MCP proxy to share host MCP servers and exec commands with containers
const hostMcpConfigs = readHostMcpServers();
const execAllowlist = readHostExecAllowlist(HOST_EXEC_ALLOWLIST);
mcpProxy = new McpProxyServer(hostMcpConfigs, execAllowlist);
await mcpProxy.start();
```

- [ ] **Step 5: Add MCP proxy shutdown**

In the `shutdown` handler, before `process.exit(0)`, add:

```typescript
if (mcpProxy) await mcpProxy.stop();
```

- [ ] **Step 6: Add host MCP server URL injection in `runAgent()`**

In the `runAgent` function, before the `runContainerAgent()` call, build hostMcpServers:

```typescript
// Build host MCP server URLs for the container
const hostMcpServers: Record<string, { url: string }> = {};
if (mcpProxy) {
  for (const name of mcpProxy.getServerNames()) {
    hostMcpServers[name] = {
      url: `http://host.docker.internal:${MCP_PROXY_PORT}/mcp/${name}`,
    };
  }
}
```

Then add `hostMcpServers` to the ContainerInput object passed to `runContainerAgent()`:

```typescript
hostMcpServers: Object.keys(hostMcpServers).length > 0 ? hostMcpServers : undefined,
```

- [ ] **Step 7: Verify `isMain` uses upstream pattern**

Ensure all `isMainGroup` checks use `group.isMain === true` (upstream pattern) instead of `group.folder === MAIN_GROUP_FOLDER` (our old pattern). The `MAIN_GROUP_FOLDER` export is removed in upstream.

- [ ] **Step 8: Verify `formatMessages` passes TIMEZONE**

Upstream's `formatMessages` now takes `TIMEZONE` parameter. Ensure all calls include it.

- [ ] **Step 9: Stage**

```bash
git add src/index.ts
```

---

### Task 9: Adapt Telegram channel to registry pattern

**Files:**
- Modify: `src/channels/telegram.ts`
- Modify: `src/channels/index.ts`

Our Telegram channel uses a class-based approach with extra callbacks (`onRegisterGroup`, `onClearSession`, `onStopContainer`). It needs to be adapted to the `ChannelFactory` pattern.

- [ ] **Step 1: Read the current Telegram channel implementation**

Read `src/channels/telegram.ts` to understand the current interface.

- [ ] **Step 2: Add self-registration**

At the bottom of `telegram.ts`, add:

```typescript
import { registerChannel, ChannelOpts } from './registry.js';

registerChannel('telegram', (opts: ChannelOpts) => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return null;
  return new TelegramChannel(token, {
    ...opts,
    onRegisterGroup: /* needs access to registerGroup from index.ts */
  });
});
```

**Design decision needed:** The Telegram channel needs `onRegisterGroup`, `onClearSession`, `onStopContainer` callbacks that come from `index.ts`. The upstream registry pattern only passes `ChannelOpts` (onMessage, onChatMetadata, registeredGroups). Two options:

**Option A:** Extend `ChannelOpts` in the registry to include these callbacks.
**Option B:** Have the Telegram factory read from a shared module or have `index.ts` set these after channel creation.

Recommended: **Option A** — add optional callbacks to `ChannelOpts`:

```typescript
export interface ChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  // Optional lifecycle hooks (used by channels that support in-chat commands)
  onRegisterGroup?: (jid: string, group: RegisteredGroup) => void;
  onClearSession?: (jid: string) => void;
  onStopContainer?: (jid: string) => void;
}
```

- [ ] **Step 3: Update `src/channels/index.ts` barrel to import telegram**

Uncomment the telegram line:

```typescript
import './telegram.js';
```

- [ ] **Step 4: Pass lifecycle callbacks through channelOpts in `src/index.ts`**

In the `channelOpts` object in `main()`, add:

```typescript
const channelOpts = {
  onMessage: (chatJid: string, msg: NewMessage) => { /* existing */ },
  onChatMetadata: (/* existing */),
  registeredGroups: () => registeredGroups,
  onRegisterGroup: registerGroup,
  onClearSession: (jid: string) => {
    const group = registeredGroups[jid];
    if (!group) return;
    delete sessions[group.folder];
    queue.closeStdin(jid);
    logger.info({ jid, group: group.name }, 'Session cleared via /clear');
  },
  onStopContainer: (jid: string) => {
    queue.closeStdin(jid);
    logger.info({ jid }, 'Container stopped via /stop');
  },
};
```

- [ ] **Step 5: Stage**

```bash
git add src/channels/telegram.ts src/channels/index.ts src/channels/registry.ts
```

---

### Task 10: Regenerate package-lock.json and build

**Files:**
- Modify: `package-lock.json`

- [ ] **Step 1: Install dependencies**

```bash
npm install
```

This regenerates package-lock.json with all dependencies resolved.

- [ ] **Step 2: Build to verify TypeScript compiles**

```bash
npm run build
```

Fix any type errors that come up.

- [ ] **Step 3: Stage**

```bash
git add package-lock.json
```

---

### Task 11: Run tests

**Files:** None (verification only)

- [ ] **Step 1: Run test suite**

```bash
npm test
```

- [ ] **Step 2: Fix any test failures**

Tests may need updates for:
- `MAIN_GROUP_FOLDER` replaced by `group.isMain`
- `formatMessages` signature change (added TIMEZONE)
- Channel registry mocking

---

### Task 12: Commit the merge

- [ ] **Step 1: Verify all conflicts resolved**

```bash
git diff --diff-filter=U
```

Should show nothing.

- [ ] **Step 2: Commit**

```bash
git commit -m "$(cat <<'EOF'
merge: upstream/main with channel registry + OneCLI migration

Adopt upstream architecture changes:
- Channel registry (self-registration pattern) replaces hardcoded channels
- OneCLI gateway for container credential injection replaces .env secrets
- Per-group trigger patterns, sender allowlist, remote control
- Task scripts, timezone validation, DB query limits

Preserve local features:
- MCP proxy server (host MCP servers exposed to containers via HTTP)
- Host exec proxy (container agents can run whitelisted host CLI tools)
- Host skills/plugins sync to containers
- Telegram channel (adapted to registry pattern)
- zh-CN language setting for container agents

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 13: Post-merge verification

- [ ] **Step 1: Rebuild container**

```bash
./container/build.sh
```

- [ ] **Step 2: Run dev server briefly to check startup**

```bash
timeout 10 npm run dev || true
```

Check logs for:
- "OneCLI gateway config applied" or appropriate warning
- "MCP proxy started"
- Channel connection messages

- [ ] **Step 3: Verify host-exec still works**

Check that `HOST_EXEC_ALLOWLIST` env var is still read and wrappers are generated.
