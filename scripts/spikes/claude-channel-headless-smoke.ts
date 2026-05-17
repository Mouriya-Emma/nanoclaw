// Spike runner for issue #93. Drives an end-to-end loop:
//   exchange HTTP server  →  spike-harness mailbox (raw HTTP)
//                          ↘
//                            nanoclaw/spike-target mailbox  ←  claude -p --mcp-config (@agent-channel/mcp)
//
// Verifies BOTH directions of the Claude Code channel turn-loop
// assumption from RFC #92:
//   1. RECEIVE: agent inside `claude -p` (headless) calls
//      mcp__agent-channel__channel.poll_inbox and sees a spike.ping
//      envelope that the harness pushed.
//   2. SEND:   agent calls mcp__agent-channel__channel.send with a
//      spike.pong reply; the harness drains its inbox and sees the
//      pong with the same nonce.
//
// Required env (resolved by the bash wrapper):
//   EXCHANGE_ROOT      absolute path to agent-channel-exchange clone
//   EVIDENCE_DIR       where to drop logs / transcripts
//   EXCHANGE_PORT      TCP port to bind exchange on (default 18787)
//   SPIKE_MODEL        claude --model (default sonnet)
//   REPO_ROOT          nanoclaw repo root
//
// Exit code:
//   0  → both directions verified, prints `SPIKE_RESULT_OK ...`
//   1  → at least one direction failed, prints `SPIKE_RESULT_FAIL ...`
//   2  → environment / preconditions broken

import { spawn } from "bun";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const procEnv = process.env;
const EXCHANGE_ROOT = required(procEnv.EXCHANGE_ROOT, "EXCHANGE_ROOT");
const EVIDENCE_DIR = required(procEnv.EVIDENCE_DIR, "EVIDENCE_DIR");
const EXCHANGE_PORT = Number(procEnv.EXCHANGE_PORT ?? "18787");
const SPIKE_MODEL = procEnv.SPIKE_MODEL ?? "sonnet";

mkdirSync(EVIDENCE_DIR, { recursive: true });

const EXCHANGE_URL = `http://127.0.0.1:${EXCHANGE_PORT}`;
const HARNESS_ID = "spike-harness";
const TARGET_ID = "nanoclaw/spike-target";
const SCHEMA_VERSION = "0.1.0";

const NONCE = `n-${Math.random().toString(36).slice(2, 10)}`;
const RUN_TS = new Date().toISOString().replace(/[:.]/g, "-");

const exchangeLogPath = join(EVIDENCE_DIR, `exchange-${RUN_TS}.log`);
const claudeStdoutPath = join(EVIDENCE_DIR, `claude-stdout-${RUN_TS}.json`);
const claudeStderrPath = join(EVIDENCE_DIR, `claude-stderr-${RUN_TS}.log`);
const transcriptPath = join(EVIDENCE_DIR, `transcript-${RUN_TS}.md`);
const mcpConfigPath = join(EVIDENCE_DIR, `mcp-config-${RUN_TS}.json`);

type AnySubproc = ReturnType<typeof spawn>;
let exchangeProc: AnySubproc | null = null;
let claudeProc: AnySubproc | null = null;

function cleanup(): void {
  try {
    claudeProc?.kill();
  } catch {}
  try {
    exchangeProc?.kill();
  } catch {}
}

process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});
process.on("SIGTERM", () => {
  cleanup();
  process.exit(143);
});

function required(value: string | undefined, name: string): string {
  if (!value || value.length === 0) {
    console.error(`[spike] env var ${name} is required`);
    process.exit(2);
  }
  return value;
}

function isoNow(): string {
  return new Date().toISOString();
}

function ulid(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

async function waitFor<T>(
  what: string,
  fn: () => Promise<T | null>,
  opts: { timeoutMs: number; intervalMs?: number } = { timeoutMs: 30_000 },
): Promise<T> {
  const start = Date.now();
  const interval = opts.intervalMs ?? 200;
  while (Date.now() - start < opts.timeoutMs) {
    const v = await fn();
    if (v !== null) return v;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`timed out waiting for ${what} after ${opts.timeoutMs}ms`);
}

async function postJson(
  path: string,
  body: unknown,
  senderId?: string,
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (senderId) headers["x-agent-channel-sender"] = senderId;
  const resp = await fetch(`${EXCHANGE_URL}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: resp.status, body: parsed };
}

async function pipeIntoFile(
  stream: ReadableStream<Uint8Array> | null,
  destPath: string,
  bufferRef?: { value: string },
): Promise<void> {
  if (!stream) return;
  const decoder = new TextDecoder();
  // Truncate file first
  writeFileSync(destPath, "");
  for await (const chunk of stream) {
    const text = decoder.decode(chunk);
    if (bufferRef) bufferRef.value += text;
    appendFileSync(destPath, text);
  }
}

async function startExchange(): Promise<void> {
  console.log(`[spike] starting exchange on ${EXCHANGE_URL}`);
  exchangeProc = spawn({
    cmd: ["bun", "run", `${EXCHANGE_ROOT}/packages/exchange/src/index.ts`],
    env: { ...procEnv, PORT: String(EXCHANGE_PORT), HOSTNAME: "127.0.0.1" },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  // Tee both into the exchange log
  void pipeIntoFile(exchangeProc.stdout as ReadableStream<Uint8Array>, exchangeLogPath);
  void pipeIntoFile(exchangeProc.stderr as ReadableStream<Uint8Array>, exchangeLogPath + ".stderr");
  await waitFor(
    "exchange /version",
    async () => {
      try {
        const resp = await fetch(`${EXCHANGE_URL}/version`);
        if (resp.ok) return await resp.json();
        return null;
      } catch {
        return null;
      }
    },
    { timeoutMs: 15_000, intervalMs: 200 },
  );
  console.log(`[spike] exchange up`);
}

async function registerHarness(): Promise<void> {
  const envelope = {
    msg_id: ulid(),
    from: HARNESS_ID,
    to: "exchange/system",
    ts: isoNow(),
    schema_version: SCHEMA_VERSION,
    body: {
      kind: "register.request",
      payload: {
        schema_version: SCHEMA_VERSION,
        desired_channel_id: HARNESS_ID,
        capabilities: ["channel.send", "channel.receive", "discovery.list"],
        identity: {
          agent_kind: "pm-agent",
          instance_label: "spike-harness",
        },
      },
    },
  };
  const { status, body } = await postJson("/v1/register", envelope);
  if (status !== 200) {
    throw new Error(
      `harness register failed: status=${status} body=${JSON.stringify(body).slice(0, 400)}`,
    );
  }
  console.log(`[spike] harness registered as ${HARNESS_ID}`);
}

function buildMcpConfig(): string {
  const cfg = {
    mcpServers: {
      "agent-channel": {
        command: "bun",
        args: ["run", `${EXCHANGE_ROOT}/packages/mcp/src/bin.ts`],
        env: {
          AGENT_CHANNEL_EXCHANGE_URL: EXCHANGE_URL,
          AGENT_CHANNEL_DESIRED_ID: TARGET_ID,
          AGENT_CHANNEL_AGENT_KIND: "worker-agent",
          AGENT_CHANNEL_INSTANCE_LABEL: "spike-target",
          AGENT_CHANNEL_CAPABILITIES: "channel.send,channel.receive,discovery.list",
        },
      },
    },
  };
  writeFileSync(mcpConfigPath, JSON.stringify(cfg, null, 2));
  return mcpConfigPath;
}

async function waitForTargetRegistration(): Promise<void> {
  await waitFor(
    `${TARGET_ID} to appear in discovery`,
    async () => {
      const envelope = {
        msg_id: ulid(),
        from: HARNESS_ID,
        to: "exchange/system",
        ts: isoNow(),
        schema_version: SCHEMA_VERSION,
        body: { kind: "discovery.list_request", payload: {} },
      };
      try {
        const { body } = await postJson("/v1/discovery/list", envelope, HARNESS_ID);
        const list = body as {
          body?: { kind?: string; payload?: { channels?: Array<{ channel_id: string }> } };
        };
        const channels = list?.body?.payload?.channels ?? [];
        if (channels.some((c) => c.channel_id === TARGET_ID)) return true;
        return null;
      } catch {
        return null;
      }
    },
    { timeoutMs: 60_000, intervalMs: 500 },
  );
  console.log(`[spike] ${TARGET_ID} is registered`);
}

async function sendPing(): Promise<string> {
  const msgId = ulid();
  const envelope = {
    msg_id: msgId,
    from: HARNESS_ID,
    to: TARGET_ID,
    ts: isoNow(),
    schema_version: SCHEMA_VERSION,
    body: {
      kind: "deliver.message",
      payload: {
        body_kind: "spike.ping",
        payload: { nonce: NONCE },
      },
    },
  };
  const { status, body } = await postJson("/v1/envelope", envelope, HARNESS_ID);
  const wire = body as { response?: { body?: { kind?: string; payload?: unknown } } };
  if (status !== 200 || wire.response?.body?.kind === "deliver.error") {
    throw new Error(
      `ping send failed: status=${status} response=${JSON.stringify(wire.response).slice(0, 400)}`,
    );
  }
  console.log(`[spike] sent spike.ping msg_id=${msgId} nonce=${NONCE}`);
  return msgId;
}

async function drainHarnessInbox(): Promise<unknown[]> {
  const envelope = {
    msg_id: ulid(),
    from: HARNESS_ID,
    to: "exchange/system",
    ts: isoNow(),
    schema_version: SCHEMA_VERSION,
    body: {
      kind: "heartbeat.ping",
      payload: { channel_id: HARNESS_ID, sequence: 0 },
    },
  };
  const { body } = await postJson("/v1/envelope", envelope, HARNESS_ID);
  const wire = body as { inbox?: unknown[] };
  return wire.inbox ?? [];
}

type PongEnvelope = {
  msg_id: string;
  in_reply_to?: string;
  body: { kind: string; payload: { body_kind: string; payload: unknown } };
};

function extractNonce(payload: unknown): string | undefined {
  // Claude Code's MCP tool dispatch may pass our `payload` argument either as
  // a structured object (the expected shape) or, in practice, as a stringified
  // JSON blob — depending on the model's serialization choice for unstructured
  // arguments. Accept both forms.
  if (payload && typeof payload === "object" && "nonce" in payload) {
    const n = (payload as { nonce?: unknown }).nonce;
    return typeof n === "string" ? n : undefined;
  }
  if (typeof payload === "string") {
    try {
      const parsed = JSON.parse(payload) as { nonce?: unknown };
      return typeof parsed.nonce === "string" ? parsed.nonce : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

async function waitForPong(): Promise<PongEnvelope> {
  return waitFor<PongEnvelope>(
    "spike.pong on harness inbox",
    async () => {
      const inbox = await drainHarnessInbox();
      for (const item of inbox) {
        const env = item as PongEnvelope;
        if (env.body?.kind === "deliver.message") {
          appendTranscript("- raw inbox envelope:");
          appendTranscript("```json");
          appendTranscript(JSON.stringify(item, null, 2));
          appendTranscript("```");
        }
        if (
          env.body?.kind === "deliver.message" &&
          env.body.payload?.body_kind === "spike.pong"
        ) {
          return env;
        }
      }
      return null;
    },
    { timeoutMs: 180_000, intervalMs: 1_000 },
  );
}

async function runClaude(): Promise<{ exitCode: number; transcript: string }> {
  const prompt = [
    "You are running inside an automated spike test that proves a Claude Code MCP channel can be used as a turn loop.",
    "",
    "You have access to two MCP tools from the `agent-channel` server:",
    "- `mcp__agent-channel__channel.poll_inbox` — drains pending inbox events and returns them.",
    "- `mcp__agent-channel__channel.send` — sends one envelope to another mailbox.",
    "",
    "Procedure (do this exactly, no questions, no commentary):",
    "1. Call `mcp__agent-channel__channel.poll_inbox` with `{}` as arguments.",
    "2. Inspect the returned `events` array. Find the event whose `channel_event.body_kind` equals `\"spike.ping\"`.",
    "   - If no such event is present yet, repeat step 1 up to 8 times with no other actions in between.",
    "3. From that event capture:",
    "   - `nonce` = `channel_event.payload.nonce` (a string)",
    "   - `ping_msg_id` = `envelope_meta.msg_id`",
    "4. Call `mcp__agent-channel__channel.send` with arguments exactly:",
    "   `{\"to\":\"spike-harness\",\"body_kind\":\"spike.pong\",\"payload\":{\"nonce\":<nonce>},\"in_reply_to\":<ping_msg_id>}`",
    "5. After `channel.send` returns `ok: true`, your final assistant message must be the literal text `DONE`. Nothing else.",
    "",
    "Do not narrate. Do not ask the user. Use the tools immediately.",
  ].join("\n");

  console.log(`[spike] spawning claude -p --model ${SPIKE_MODEL}`);
  claudeProc = spawn({
    cmd: [
      "claude",
      "--print",
      "--model",
      SPIKE_MODEL,
      "--mcp-config",
      mcpConfigPath,
      "--strict-mcp-config",
      "--dangerously-skip-permissions",
      "--output-format",
      "json",
      prompt,
    ],
    env: { ...procEnv },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });

  const stdoutBuf = { value: "" };
  const stderrBuf = { value: "" };
  const readStdout = pipeIntoFile(
    claudeProc.stdout as ReadableStream<Uint8Array>,
    claudeStdoutPath,
    stdoutBuf,
  );
  const readStderr = pipeIntoFile(
    claudeProc.stderr as ReadableStream<Uint8Array>,
    claudeStderrPath,
    stderrBuf,
  );

  const exitCode = await claudeProc.exited;
  await Promise.all([readStdout, readStderr]);
  let transcript = stdoutBuf.value;
  try {
    const parsed = JSON.parse(stdoutBuf.value) as { result?: string };
    if (typeof parsed.result === "string") transcript = parsed.result;
  } catch {}
  return { exitCode, transcript };
}

function appendTranscript(line: string): void {
  appendFileSync(transcriptPath, line + "\n");
}

async function main(): Promise<number> {
  writeFileSync(transcriptPath, `# Spike transcript ${RUN_TS}\n\n`);
  appendTranscript(`- nonce: \`${NONCE}\``);
  appendTranscript(`- exchange url: ${EXCHANGE_URL}`);
  appendTranscript(`- harness id: ${HARNESS_ID}`);
  appendTranscript(`- target id: ${TARGET_ID}`);
  appendTranscript(`- claude model: ${SPIKE_MODEL}`);
  appendTranscript("");

  await startExchange();
  await registerHarness();
  buildMcpConfig();

  // Spawn claude in parallel: its MCP child will register the target,
  // then the harness sends the ping, then claude polls + replies.
  const claudePromise = runClaude();

  let pingMsgId = "";
  try {
    await waitForTargetRegistration();
    pingMsgId = await sendPing();
    appendTranscript(`- sent spike.ping msg_id=\`${pingMsgId}\``);
  } catch (err) {
    appendTranscript(`- precondition failure: ${(err as Error).message}`);
    const { exitCode, transcript } = await claudePromise;
    appendTranscript(`- claude exitCode=${exitCode}`);
    appendTranscript("```");
    appendTranscript(transcript.trim().slice(0, 4000));
    appendTranscript("```");
    console.error(`SPIKE_RESULT_FAIL precondition_error: ${(err as Error).message}`);
    return 1;
  }

  let pongEnv: PongEnvelope | null = null;
  let pongErr: Error | null = null;
  try {
    pongEnv = await waitForPong();
  } catch (err) {
    pongErr = err as Error;
  }

  const { exitCode: claudeExit, transcript } = await claudePromise;
  appendTranscript("");
  appendTranscript(`## Claude transcript (exit=${claudeExit})`);
  appendTranscript("");
  appendTranscript("```");
  appendTranscript(transcript.trim().slice(0, 6000));
  appendTranscript("```");
  appendTranscript("");

  if (pongErr || !pongEnv) {
    appendTranscript(`## Result: FAIL`);
    appendTranscript(`reason: ${pongErr?.message ?? "no pong"}`);
    console.error(`SPIKE_RESULT_FAIL no_pong: ${pongErr?.message ?? "no pong"}`);
    return 1;
  }

  const rawPayload = pongEnv.body.payload.payload;
  const echoedNonce = extractNonce(rawPayload);
  const payloadShape = typeof rawPayload === "string" ? "stringified-json" : "object";
  appendTranscript(`- payload shape on wire: ${payloadShape}`);
  if (echoedNonce !== NONCE) {
    appendTranscript(`## Result: FAIL`);
    appendTranscript(`reason: nonce mismatch expected=${NONCE} got=${String(echoedNonce)} payloadShape=${payloadShape}`);
    console.error(
      `SPIKE_RESULT_FAIL nonce_mismatch expected=${NONCE} got=${String(echoedNonce)} payloadShape=${payloadShape}`,
    );
    return 1;
  }

  appendTranscript(`## Result: OK`);
  appendTranscript(`- message_visible: ok (claude saw spike.ping nonce=${NONCE} via channel.poll_inbox)`);
  appendTranscript(`- reply_envelope_id: ${pongEnv.msg_id}`);
  appendTranscript(`- in_reply_to: ${pongEnv.in_reply_to ?? "(none)"}`);
  appendTranscript(`- payload_shape: ${payloadShape}`);
  if (payloadShape === "stringified-json") {
    appendTranscript(
      "- NOTE: claude serialized the `payload` argument as a JSON string rather than a structured object. " +
        "The MCP tool inputSchema accepts `payload: {}` (any), so this is currently legal but downstream " +
        "consumers (provider driver) should normalize both forms.",
    );
  }
  console.log(
    `SPIKE_RESULT_OK message_visible=ok reply_envelope_id=${pongEnv.msg_id} nonce=${echoedNonce} payload_shape=${payloadShape}`,
  );
  return 0;
}

let exitCode = 2;
try {
  exitCode = await main();
} catch (err) {
  appendTranscript(`fatal: ${(err as Error).message}`);
  console.error(`SPIKE_RESULT_FAIL fatal: ${(err as Error).message}`);
  exitCode = 2;
} finally {
  cleanup();
}
process.exit(exitCode);
