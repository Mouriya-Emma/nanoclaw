# NanoClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Quick Context

Single Node.js process that connects to WhatsApp, routes messages to Claude Agent SDK running in containers (Linux VMs). Each group has isolated filesystem and memory.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/channels/whatsapp.ts` | WhatsApp connection, auth, send/receive |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/router.ts` | Message formatting and outbound routing |
| `src/config.ts` | Trigger pattern, paths, intervals |
| `src/container-runner.ts` | Spawns agent containers with mounts |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated) |
| `src/mcp-proxy.ts` | MCP proxy + host exec proxy for containers |
| `container/host-exec.mjs` | Container-side stub for host CLI execution |
| `container/skills/agent-browser.md` | Browser automation tool (available to all agents via Bash) |

## Skills

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |
| `/update` | Pull upstream NanoClaw changes, merge with customizations, run migrations |
| `/qodo-pr-resolver` | Fetch and fix Qodo PR review issues interactively or in batch |
| `/get-qodo-rules` | Load org- and repo-level coding rules from Qodo before code tasks |

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
./container/build.sh # Rebuild agent container
```

Service management:
```bash
# macOS (launchd)
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # restart

# Linux (systemd)
systemctl --user start nanoclaw
systemctl --user stop nanoclaw
systemctl --user restart nanoclaw
```

## Host Exec Proxy — 让容器 agent 使用宿主机 CLI

容器内的 agent 无法直接运行宿主机的 CLI 工具（如 `fulcrum`），因为二进制不在容器里。
Host Exec Proxy 通过 HTTP 转发实现透明的远程执行，对 agent 来说就是正常的 CLI 调用。

**架构：**
```
容器: fulcrum current-task info
  → /opt/host-exec/fulcrum (bash wrapper)
  → node proxy.mjs → HTTP POST host.docker.internal:18321/exec
  → 宿主机 NanoClaw 进程 spawn 真正的 fulcrum
  → stdout/stderr/exitCode 原样返回
```

**添加新工具只需两步：**
1. `.env` 中 `HOST_EXEC_ALLOWLIST` 加逗号分隔的命令名（如 `fulcrum,pencil`）
2. 确保该命令在宿主机 PATH 中可用

**关键文件：**
| File | Purpose |
|------|---------|
| `container/host-exec.mjs` | 容器内的 node 代理脚本，HTTP 转发到宿主机 |
| `src/mcp-proxy.ts` | `POST /exec` 端点，白名单校验 + spawn 执行 |
| `src/container-runner.ts` | 生成 bash wrapper，挂载到 `/opt/host-exec/`，注入 PATH |

**安全约束：**
- 只允许白名单内的命令名（不允许路径、不允许 shell 注入）
- 直接 spawn，不经过 shell
- 输出截断 1MB，超时 120s

## Container Build Cache

The container buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild, prune the builder then re-run `./container/build.sh`.
