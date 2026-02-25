# Tool Requirements Declaration & Pi-mono OAuth Authentication

Date: 2026-02-25

## Feature 1: Container Tool Requirements Declaration

### Purpose

Agent 在容器内执行任务时发现缺少某个工具（特别是需要用户预先提供认证的工具，如 `gh` CLI），通过 MCP tool 声明需求，宿主机持久化记录到 SQLite，供用户查看和后续升级参考。

不需要认证的工具 agent 直接在容器内 `apt install` 即时安装。

### Design

**MCP Tool（容器侧 `ipc-mcp-stdio.ts`）：** 新增 `request_tool` tool：

```typescript
server.tool(
  'request_tool',
  'Declare a tool requirement for the container environment. Use when you need a CLI tool that requires user authentication or cannot be installed at runtime.',
  {
    tool: z.string().describe('Tool/command name (e.g., "gh", "gcloud")'),
    reason: z.string().describe('Why this tool is needed'),
    needsAuth: z.boolean().default(false).describe('Whether the tool requires user authentication'),
    authProvider: z.string().optional().describe('Auth provider if applicable (e.g., "github", "google")'),
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
    return { content: [{ type: 'text', text: `Tool requirement "${args.tool}" recorded.` }] };
  },
);
```

**宿主机（`ipc.ts` `processTaskIpc`）：** 新增 `case 'tool_requirement'`，调用 `db.ts` upsert。

**数据库（`db.ts`）：**

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

**Bot 命令：** `/requirements` 列出所有 group 的工具需求。

### Files to modify

| File | Change |
|------|--------|
| `container/pi-runner/src/ipc-mcp-stdio.ts` | Add `request_tool` MCP tool |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | Add `request_tool` MCP tool (same) |
| `src/ipc.ts` | Add `case 'tool_requirement'` in `processTaskIpc` |
| `src/db.ts` | Add `tool_requirements` table + upsert/query functions |
| `src/channels/telegram.ts` | Add `/requirements` command |

---

## Feature 2: Pi-mono OAuth Authentication

### Purpose

用户通过 Telegram bot 完成 OAuth 认证，获取 pi-mono 各 provider 的 credentials。全局共用一套 token（非 per-group）。

### Supported providers (pi-mono built-in)

| Provider ID | Flow | 说明 |
|-------------|------|------|
| `anthropic` | Auth Code + PKCE | Claude Pro/Max |
| `openai-codex` | Auth Code + PKCE | ChatGPT Plus/Pro |
| `google-gemini-cli` | Auth Code + PKCE | Google Gemini |
| `google-antigravity` | Auth Code + PKCE | Google 免费层 |
| `github-copilot` | Auth Code + PKCE | GitHub Copilot |

所有 provider 都支持手动粘贴 code 的 fallback（浏览器回调失败时）。

### Design

**宿主机安装 `@mariozechner/pi-ai`**，直接调用其 OAuth 函数。

**流程：**

1. 用户在 Telegram 发 `/auth google-gemini-cli`
2. 宿主机调用 pi-mono 的 `loginGeminiCli(onUrl, onMessage)` 函数
3. `onUrl` 回调 → bot 把 OAuth URL 发给用户
4. 用户浏览器打开 URL，登录授权
5. 由于宿主机不一定能接收 localhost 回调，走手动 fallback：用户把回调页面上的 code 贴回 Telegram
6. Bot 处于"等待 code"状态，用户下条消息作为 code 转给 pi-mono 完成 token 交换
7. Credentials 存 `data/pi-auth.json`
8. 容器启动时 `container-runner.ts` 读取 `pi-auth.json`，通过 stdin 传入容器
9. `pi-runner/index.ts` 收到后写入容器内 `auth.json`，供 pi-mono SDK 使用

**Telegram 命令：**

```
/auth              → 列出可用 provider 和当前认证状态
/auth <provider>   → 开始 OAuth 流程，发 URL 给用户
/auth revoke <provider> → 删除已存的 credentials
```

**等待 code 状态：** bot 发 URL 后进入等待状态（per-chat），5 分钟超时自动取消。期间用户的下一条消息被当作 auth code 处理，不触发 agent。

**存储格式 `data/pi-auth.json`：**

```json
{
  "google-gemini-cli": {
    "type": "oauth",
    "refresh": "...",
    "access": "...",
    "expires": 1234567890,
    "projectId": "..."
  },
  "openai-codex": {
    "type": "oauth",
    "refresh_token": "...",
    "access_token": "...",
    "expires_in": 3600
  }
}
```

格式由 pi-mono SDK 的各 login 函数返回值决定，直接序列化存储。

### Container integration

`container-runner.ts` 的 `ContainerInput` 扩展：

```typescript
export interface ContainerInput {
  // ... existing fields
  oauthCredentials?: Record<string, unknown>;  // pi-auth.json content for this provider
}
```

`pi-runner/index.ts` 收到后写入 `/workspace/group/auth.json`（或 pi-mono SDK 期望的路径）。

### Files to modify

| File | Change |
|------|--------|
| `package.json` | Add `@mariozechner/pi-ai` dependency to host |
| `src/channels/telegram.ts` | Rewrite `/auth` command with full OAuth flow |
| `src/auth-manager.ts` (new) | OAuth flow orchestration, pi-auth.json read/write |
| `src/container-runner.ts` | Read pi-auth.json, pass credentials via stdin |
| `container/pi-runner/src/index.ts` | Receive and write auth.json for pi-mono SDK |
| `container/pi-runner/src/protocol.ts` | Add oauthCredentials to ContainerInput |
