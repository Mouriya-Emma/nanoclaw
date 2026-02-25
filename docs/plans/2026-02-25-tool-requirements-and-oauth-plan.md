# Tool Requirements & Pi-mono OAuth Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add MCP tool for agents to declare container tool requirements, and implement pi-mono OAuth authentication via Telegram bot.

**Architecture:** Feature 1 follows the existing IPC pattern (MCP tool writes IPC file, host processes, stores in SQLite). Feature 2 adds a host-side auth manager that wraps pi-mono SDK's OAuth functions, with Telegram as the user interaction layer and `data/pi-auth.json` as credential storage.

**Tech Stack:** TypeScript, better-sqlite3, @mariozechner/pi-ai (OAuth), grammy (Telegram), vitest (tests)

---

## Feature 1: Tool Requirements Declaration

### Task 1: Add `tool_requirements` table and DB functions

**Files:**
- Modify: `src/db.ts`
- Modify: `src/types.ts`
- Test: `src/ipc-auth.test.ts`

**Step 1: Write the failing test**

Add to `src/ipc-auth.test.ts`:

```typescript
// --- tool_requirement ---

describe('tool_requirement', () => {
  it('stores a tool requirement via IPC', async () => {
    await processTaskIpc(
      {
        type: 'tool_requirement',
        tool: 'gh',
        reason: 'Need GitHub CLI for PRs',
        needsAuth: true,
        authProvider: 'github',
      },
      'main',
      true,
      deps,
    );

    const reqs = getToolRequirements();
    expect(reqs).toHaveLength(1);
    expect(reqs[0].tool_name).toBe('gh');
    expect(reqs[0].needs_auth).toBe(1);
    expect(reqs[0].auth_provider).toBe('github');
  });

  it('upserts on duplicate (group_folder, tool_name)', async () => {
    await processTaskIpc(
      {
        type: 'tool_requirement',
        tool: 'gh',
        reason: 'First reason',
        needsAuth: false,
      },
      'main',
      true,
      deps,
    );

    await processTaskIpc(
      {
        type: 'tool_requirement',
        tool: 'gh',
        reason: 'Updated reason',
        needsAuth: true,
        authProvider: 'github',
      },
      'main',
      true,
      deps,
    );

    const reqs = getToolRequirements();
    expect(reqs).toHaveLength(1);
    expect(reqs[0].reason).toBe('Updated reason');
    expect(reqs[0].needs_auth).toBe(1);
  });

  it('stores requirements per group', async () => {
    await processTaskIpc(
      { type: 'tool_requirement', tool: 'gh', reason: 'PRs' },
      'main',
      true,
      deps,
    );

    await processTaskIpc(
      { type: 'tool_requirement', tool: 'gh', reason: 'PRs too' },
      'other-group',
      false,
      deps,
    );

    const reqs = getToolRequirements();
    expect(reqs).toHaveLength(2);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/ipc-auth.test.ts`
Expected: FAIL — `getToolRequirements` not found, `tool_requirement` IPC type not handled

**Step 3: Add ToolRequirement type to `src/types.ts`**

```typescript
export interface ToolRequirement {
  id: number;
  group_folder: string;
  tool_name: string;
  reason: string | null;
  needs_auth: number;
  auth_provider: string | null;
  created_at: string;
}
```

**Step 4: Add table and functions to `src/db.ts`**

In `createSchema`, add to the `database.exec(...)` block:

```sql
CREATE TABLE IF NOT EXISTS tool_requirements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_folder TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  reason TEXT,
  needs_auth INTEGER DEFAULT 0,
  auth_provider TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(group_folder, tool_name)
);
```

Add functions:

```typescript
export function upsertToolRequirement(req: {
  group_folder: string;
  tool_name: string;
  reason?: string;
  needs_auth?: boolean;
  auth_provider?: string;
}): void {
  db.prepare(
    `INSERT INTO tool_requirements (group_folder, tool_name, reason, needs_auth, auth_provider, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(group_folder, tool_name) DO UPDATE SET
       reason = excluded.reason,
       needs_auth = excluded.needs_auth,
       auth_provider = excluded.auth_provider`,
  ).run(
    req.group_folder,
    req.tool_name,
    req.reason || null,
    req.needs_auth ? 1 : 0,
    req.auth_provider || null,
    new Date().toISOString(),
  );
}

export function getToolRequirements(groupFolder?: string): ToolRequirement[] {
  if (groupFolder) {
    return db
      .prepare('SELECT * FROM tool_requirements WHERE group_folder = ? ORDER BY created_at DESC')
      .all(groupFolder) as ToolRequirement[];
  }
  return db
    .prepare('SELECT * FROM tool_requirements ORDER BY created_at DESC')
    .all() as ToolRequirement[];
}
```

Add import for `ToolRequirement` in `db.ts`.

**Step 5: Add `case 'tool_requirement'` to `src/ipc.ts`**

In `processTaskIpc`, add to the data parameter type:

```typescript
tool?: string;
reason?: string;
needsAuth?: boolean;
authProvider?: string;
```

Add the case:

```typescript
case 'tool_requirement':
  if (data.tool) {
    upsertToolRequirement({
      group_folder: sourceGroup,
      tool_name: data.tool,
      reason: data.reason,
      needs_auth: data.needsAuth,
      auth_provider: data.authProvider,
    });
    logger.info(
      { tool: data.tool, sourceGroup },
      'Tool requirement recorded via IPC',
    );
  }
  break;
```

Add import for `upsertToolRequirement` from `./db.js`.

**Step 6: Run test to verify it passes**

Run: `npx vitest run src/ipc-auth.test.ts`
Expected: PASS

**Step 7: Commit**

```
feat: add tool_requirements table and IPC handler
```

---

### Task 2: Add `request_tool` MCP tool to both runners

**Files:**
- Modify: `container/agent-runner/src/ipc-mcp-stdio.ts`
- Modify: `container/pi-runner/src/ipc-mcp-stdio.ts`

**Step 1: Add `request_tool` tool to `container/agent-runner/src/ipc-mcp-stdio.ts`**

Add after the `register_group` tool:

```typescript
server.tool(
  'request_tool',
  'Declare a tool requirement for the container environment. Use when you discover a CLI tool is needed but requires user authentication or pre-installation. The requirement is recorded for the user to review and act on.',
  {
    tool: z.string().describe('Tool/command name (e.g., "gh", "gcloud")'),
    reason: z.string().describe('Why this tool is needed'),
    needsAuth: z.boolean().default(false).describe('Whether the tool requires user authentication'),
    authProvider: z.string().optional().describe('Auth provider if needs auth (e.g., "github", "google")'),
  },
  async (args) => {
    writeIpcFile(TASKS_DIR, {
      type: 'tool_requirement',
      tool: args.tool,
      reason: args.reason,
      needsAuth: args.needsAuth,
      authProvider: args.authProvider,
      groupFolder,
      timestamp: new Date().toISOString(),
    });

    return {
      content: [{ type: 'text' as const, text: `Tool requirement "${args.tool}" recorded. The user will be notified.` }],
    };
  },
);
```

**Step 2: Copy the same tool to `container/pi-runner/src/ipc-mcp-stdio.ts`**

Identical code.

**Step 3: Commit**

```
feat: add request_tool MCP tool to both runners
```

---

### Task 3: Add `/requirements` Telegram command

**Files:**
- Modify: `src/channels/telegram.ts`

**Step 1: Add `/requirements` command**

Add after the `/auth` command block:

```typescript
this.bot.command('requirements', async (ctx) => {
  const reqs = getToolRequirements();
  if (reqs.length === 0) {
    ctx.reply('No tool requirements recorded.');
    return;
  }

  const lines = reqs.map(r => {
    const auth = r.needs_auth ? ` [needs auth: ${r.auth_provider || 'unknown'}]` : '';
    return `• ${r.tool_name} (${r.group_folder})${auth}\n  ${r.reason || 'No reason given'}`;
  });

  ctx.reply(`Tool requirements:\n\n${lines.join('\n\n')}`);
});
```

Add import for `getToolRequirements` from `../db.js`.

**Step 2: Build and verify**

Run: `npm run build`
Expected: No type errors

**Step 3: Commit**

```
feat: add /requirements command to Telegram
```

---

## Feature 2: Pi-mono OAuth Authentication

### Task 4: Install `@mariozechner/pi-ai` on host and research OAuth API

**Files:**
- Modify: `package.json`

**Step 1: Install the dependency**

Run: `bun add @mariozechner/pi-ai`

**Step 2: Research the actual OAuth API**

Read the installed package source to verify the exact function signatures for `loginGeminiCli`, `loginOpenAICodex`, `loginAnthropic`, etc. Check:
- What callbacks they accept (onUrl, onMessage, onCode)
- What they return (credential shape)
- How manual code paste fallback works
- Where they expect to store/read auth.json

Read relevant source files to confirm the API matches what the research agent found. Pay special attention to whether login functions accept a callback for "please paste code" or if they read from stdin directly.

**Step 3: Commit**

```
chore: add @mariozechner/pi-ai dependency
```

---

### Task 5: Create `src/auth-manager.ts`

**Files:**
- Create: `src/auth-manager.ts`

This module handles reading/writing `data/pi-auth.json` and wrapping pi-mono's OAuth login functions.

**Step 1: Write auth-manager**

```typescript
import fs from 'fs';
import path from 'path';
import { DATA_DIR } from './config.js';
import { logger } from './logger.js';

const AUTH_FILE = path.join(DATA_DIR, 'pi-auth.json');

export interface AuthCredentials {
  [provider: string]: Record<string, unknown>;
}

export function readAuthCredentials(): AuthCredentials {
  if (!fs.existsSync(AUTH_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

export function writeAuthCredentials(creds: AuthCredentials): void {
  fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true });
  fs.writeFileSync(AUTH_FILE, JSON.stringify(creds, null, 2));
}

export function getAuthStatus(): Array<{ provider: string; authenticated: boolean }> {
  const creds = readAuthCredentials();
  const providers = ['anthropic', 'openai-codex', 'google-gemini-cli', 'google-antigravity', 'github-copilot'];
  return providers.map(p => ({ provider: p, authenticated: !!creds[p] }));
}

export function revokeAuth(provider: string): boolean {
  const creds = readAuthCredentials();
  if (!creds[provider]) return false;
  delete creds[provider];
  writeAuthCredentials(creds);
  return true;
}

/**
 * Start an OAuth login flow for a provider.
 *
 * IMPORTANT: The exact implementation depends on Task 4's findings about
 * the pi-ai SDK's login function signatures. The placeholder below shows
 * the intended structure. Adjust after reading real source.
 */
export async function startOAuthFlow(
  provider: string,
  onUrl: (url: string) => void,
  onMessage: (msg: string) => void,
): Promise<{ credentials: Record<string, unknown> }> {
  const piAi = await import('@mariozechner/pi-ai');

  const loginFunctions: Record<string, Function> = {
    'anthropic': piAi.loginAnthropic,
    'openai-codex': piAi.loginOpenAICodex,
    'google-gemini-cli': piAi.loginGeminiCli,
    'google-antigravity': piAi.loginAntigravity,
    'github-copilot': piAi.loginGitHubCopilot,
  };

  const loginFn = loginFunctions[provider];
  if (!loginFn) {
    throw new Error(`Unknown OAuth provider: ${provider}`);
  }

  const credentials = await loginFn(onUrl, onMessage);

  const allCreds = readAuthCredentials();
  allCreds[provider] = { type: 'oauth', ...credentials };
  writeAuthCredentials(allCreds);

  return { credentials };
}
```

**Note:** The `startOAuthFlow` function is a placeholder. After Task 4 reveals the real pi-ai API, adjust the login function calls accordingly. If login functions read from stdin, a different approach (piping Telegram messages as stdin) will be needed.

**Step 2: Build and verify**

Run: `npm run build`
Expected: No type errors

**Step 3: Commit**

```
feat: add auth-manager for pi-mono OAuth credentials
```

---

### Task 6: Rewrite `/auth` command in Telegram

**Files:**
- Modify: `src/channels/telegram.ts`

**Step 1: Rewrite the `/auth` command handler**

Replace the existing `/auth` stub with full OAuth flow:

```typescript
this.bot.command('auth', async (ctx) => {
  const args = ctx.match?.trim();

  if (!args) {
    const status = getAuthStatus();
    const lines = status.map(s => `${s.authenticated ? '✅' : '❌'} ${s.provider}`);
    ctx.reply(`OAuth status:\n${lines.join('\n')}\n\nUsage:\n/auth <provider> — start OAuth\n/auth revoke <provider> — remove credentials`);
    return;
  }

  if (args.startsWith('revoke ')) {
    const provider = args.slice(7).trim();
    const revoked = revokeAuth(provider);
    ctx.reply(revoked ? `Credentials for ${provider} revoked.` : `No credentials found for ${provider}.`);
    return;
  }

  const provider = args;
  const validProviders = ['anthropic', 'openai-codex', 'google-gemini-cli', 'google-antigravity', 'github-copilot'];
  if (!validProviders.includes(provider)) {
    ctx.reply(`Unknown provider: ${provider}\nValid: ${validProviders.join(', ')}`);
    return;
  }

  ctx.reply(`Starting OAuth for ${provider}...`);

  try {
    await startOAuthFlow(
      provider,
      (url) => ctx.reply(`Open this URL to authenticate:\n${url}\n\nThen paste the code/URL you receive back here.`),
      (msg) => ctx.reply(msg),
    );

    ctx.reply(`✅ ${provider} authenticated successfully.`);
  } catch (err) {
    ctx.reply(`❌ OAuth failed: ${err instanceof Error ? err.message : String(err)}`);
  }
});
```

Add imports for `getAuthStatus`, `revokeAuth`, `startOAuthFlow` from `../auth-manager.js`.

**Note:** If pi-mono login functions need interactive stdin for code paste (discovered in Task 4), this handler will need to intercept the user's next Telegram message and pipe it as input. Add a `pendingAuth` Map at class level to track this state.

**Step 2: Build and verify**

Run: `npm run build`
Expected: No type errors

**Step 3: Commit**

```
feat: rewrite /auth command with pi-mono OAuth flow
```

---

### Task 7: Pass OAuth credentials to pi-runner containers

**Files:**
- Modify: `src/container-runner.ts`
- Modify: `container/pi-runner/src/protocol.ts`
- Modify: `container/pi-runner/src/index.ts`

**Step 1: Extend ContainerInput in `container/pi-runner/src/protocol.ts`**

Add to the `ContainerInput` interface:

```typescript
oauthCredentials?: Record<string, unknown>;
```

**Step 2: Read and pass OAuth credentials in `src/container-runner.ts`**

In `runContainerAgent`, before writing to stdin, add:

```typescript
import { readAuthCredentials } from './auth-manager.js';

// Before container.stdin.write(JSON.stringify(input)):
if (input.provider && input.provider !== 'claude') {
  const authCreds = readAuthCredentials();
  if (Object.keys(authCreds).length > 0) {
    input.oauthCredentials = authCreds;
  }
}
```

**Step 3: Write auth.json in pi-runner `index.ts`**

After parsing stdin input, before creating agent session:

```typescript
if (containerInput.oauthCredentials && Object.keys(containerInput.oauthCredentials).length > 0) {
  const authJsonPath = path.join('/workspace/group', 'auth.json');
  fs.writeFileSync(authJsonPath, JSON.stringify(containerInput.oauthCredentials, null, 2));
  delete containerInput.oauthCredentials;
  log('Wrote OAuth credentials to auth.json');
}
```

**Step 4: Build and verify**

Run: `npm run build`
Expected: No type errors

**Step 5: Commit**

```
feat: pass OAuth credentials to pi-runner containers
```

---

### Task 8: Build and integration test

**Step 1: Build everything**

Run: `npm run build`
Expected: Clean build, no errors

**Step 2: Run all tests**

Run: `npm test`
Expected: All tests pass including new tool_requirement tests

**Step 3: Rebuild container images**

Run: `./container/build.sh`
Expected: Both images build successfully

**Step 4: Manual smoke test**

1. Start with `npm run dev`
2. `/requirements` → empty
3. `/auth` → list providers with status
4. `/auth google-gemini-cli` → start OAuth flow
