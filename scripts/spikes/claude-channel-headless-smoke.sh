#!/usr/bin/env bash
# Spike for issue #93: prove that Claude Code CLI in NanoClaw target
# headless form can receive a deliver.message via the agent-channel
# exchange MCP server, and can reply via channel.send.
#
# This shell entry just resolves paths and execs the bun runner. The
# bun runner owns the full lifecycle: start exchange, register harness,
# spawn `claude -p` with --mcp-config pointing at @agent-channel/mcp,
# observe both directions, exit non-zero on any failure.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

: "${EXCHANGE_ROOT:=/Users/mouriya/Ext/code/agent-channel-exchange}"
: "${EVIDENCE_DIR:=$REPO_ROOT/.coder-loop/runtime/evidence/issue-93}"
: "${EXCHANGE_PORT:=18787}"
: "${SPIKE_MODEL:=sonnet}"

mkdir -p "$EVIDENCE_DIR"

export EXCHANGE_ROOT EVIDENCE_DIR EXCHANGE_PORT SPIKE_MODEL REPO_ROOT

exec bun run "$SCRIPT_DIR/claude-channel-headless-smoke.ts" "$@"
