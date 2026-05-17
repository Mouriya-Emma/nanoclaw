import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import Database from 'better-sqlite3';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RUN_TS = new Date().toISOString().replace(/[:.]/g, '-');
const RUN_ID = process.env.NANOCLAW_E2E_RUN_ID || RUN_TS;
const WORK_ROOT = path.resolve(
  process.env.NANOCLAW_E2E_WORK_DIR || path.join(REPO_ROOT, '.nanoclaw/e2e/channel-exchange'),
);
const RUN_DIR = path.join(WORK_ROOT, `run-${RUN_ID}`);
const EVIDENCE_DIR = path.resolve(process.env.NANOCLAW_E2E_EVIDENCE_DIR || path.join(RUN_DIR, 'evidence'));
const LOG_DIR = path.join(EVIDENCE_DIR, 'logs');
const TRANSCRIPT_PATH = path.join(EVIDENCE_DIR, `channel-exchange-${RUN_ID}.md`);
const SUMMARY_PATH = path.join(EVIDENCE_DIR, `channel-exchange-${RUN_ID}.json`);
const RUNNER_STDOUT = path.join(LOG_DIR, 'agent-runner.stdout.log');
const RUNNER_STDERR = path.join(LOG_DIR, 'agent-runner.stderr.log');
const DB_SNAPSHOT = path.join(EVIDENCE_DIR, `db-snapshot-${RUN_ID}.json`);
const TIMEOUT_MS = Number(process.env.NANOCLAW_E2E_TIMEOUT_MS || '300000');
const CLAUDE_CODE_EXECUTABLE = process.env.CLAUDE_CODE_EXECUTABLE || 'claude';
const MODEL = process.env.NANOCLAW_E2E_MODEL || 'sonnet';
const CHANNEL_TYPE = 'channel-exchange-e2e';
const PLATFORM_ID = 'target-equivalent-channel';
const DESTINATION_NAME = 'e2e-channel';
const AGENT_GROUP_ID = 'ag-channel-exchange-e2e';
const MESSAGING_GROUP_ID = 'mg-channel-exchange-e2e';
const SESSION_MESSAGE_ID = 'msg-channel-exchange-e2e-1';
const NONCE = `n-${Math.random().toString(36).slice(2, 10)}`;
const EXPECTED_TEXT = `CHANNEL_EXCHANGE_E2E_OK nonce=${NONCE}`;

interface Session {
  id: string;
  agent_group_id: string;
  messaging_group_id: string | null;
  thread_id: string | null;
  agent_provider: string | null;
  status: string;
  container_status: string;
  last_active: string | null;
  created_at: string;
}

interface DeliveredMessage {
  channelType: string;
  platformId: string;
  threadId: string | null;
  kind: string;
  content: unknown;
  contentText: string;
  platformMessageId: string;
}

class E2EFailure extends Error {
  constructor(
    readonly phase: string,
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
  }
}

function assertRepoLocal(targetPath: string, label: string): void {
  const rel = path.relative(REPO_ROOT, targetPath);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new E2EFailure('environment', `${label} must be inside repo root: ${targetPath}`, 2);
  }
  if (targetPath === '/tmp' || targetPath.startsWith('/tmp/')) {
    throw new E2EFailure('environment', `${label} must not be under /tmp: ${targetPath}`, 2);
  }
}

function appendTranscript(line = ''): void {
  fs.appendFileSync(TRANSCRIPT_PATH, `${line}\n`);
}

function commandVersion(command: string, args: string[]): { ok: true; text: string } | { ok: false; text: string } {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  const text = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
  if (result.status === 0) return { ok: true, text };
  return { ok: false, text: text || result.error?.message || `exit ${result.status ?? 'unknown'}` };
}

async function importRepoModule<T>(relativePath: string): Promise<T> {
  return (await import(pathToFileURL(path.join(REPO_ROOT, relativePath)).href)) as T;
}

function rowSnapshot(dbPath: string, table: string): unknown[] {
  if (!fs.existsSync(dbPath)) return [];
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare(`SELECT * FROM ${table}`).all();
  } finally {
    db.close();
  }
}

function writeSnapshot(paths: { inboundDb: string; outboundDb: string }, delivered: DeliveredMessage[]): void {
  fs.writeFileSync(
    DB_SNAPSHOT,
    JSON.stringify(
      {
        inboundDb: paths.inboundDb,
        outboundDb: paths.outboundDb,
        messages_in: rowSnapshot(paths.inboundDb, 'messages_in'),
        delivered_rows: rowSnapshot(paths.inboundDb, 'delivered'),
        destinations: rowSnapshot(paths.inboundDb, 'destinations'),
        session_routing: rowSnapshot(paths.inboundDb, 'session_routing'),
        messages_out: rowSnapshot(paths.outboundDb, 'messages_out'),
        processing_ack: rowSnapshot(paths.outboundDb, 'processing_ack'),
        delivered,
      },
      null,
      2,
    ),
  );
}

function parseContent(content: string): { text?: string } {
  try {
    const parsed = JSON.parse(content) as { text?: unknown };
    return { text: typeof parsed.text === 'string' ? parsed.text : undefined };
  } catch {
    return { text: content };
  }
}

function pipeToFile(stream: NodeJS.ReadableStream, filePath: string): void {
  const dest = fs.createWriteStream(filePath);
  stream.pipe(dest);
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function classifyRunnerFailure(stderr: string, outboundRows: unknown[]): E2EFailure {
  const messagesOut = outboundRows as Array<{ content?: string }>;
  const errorRow = messagesOut.find((row) => {
    const text = typeof row.content === 'string' ? parseContent(row.content).text : undefined;
    return text?.startsWith('Error:');
  });
  if (errorRow?.content) {
    const text = parseContent(errorRow.content).text || errorRow.content;
    if (/rate limit|quota/i.test(text)) {
      return new E2EFailure('provider', `Claude Code quota/rate-limit blocker: ${text}`);
    }
    return new E2EFailure('provider', text);
  }
  if (/agent-channel-mcp.*startup error|AGENT_CHANNEL_EXCHANGE_URL|fetch failed|ECONNREFUSED/i.test(stderr)) {
    return new E2EFailure('exchange_mcp', stderr.trim().split('\n').slice(-6).join('\n'));
  }
  if (/Claude Code exited without replying through channel\.send/i.test(stderr)) {
    return new E2EFailure('provider', 'Claude Code exited without replying through channel.send');
  }
  return new E2EFailure('provider', stderr.trim().split('\n').slice(-8).join('\n') || 'agent runner exited');
}

function cleanupRunner(runner: ChildProcessWithoutNullStreams | null): void {
  if (!runner || runner.exitCode !== null || runner.killed) return;
  runner.kill('SIGTERM');
}

async function main(): Promise<number> {
  assertRepoLocal(WORK_ROOT, 'NANOCLAW_E2E_WORK_DIR');
  assertRepoLocal(EVIDENCE_DIR, 'NANOCLAW_E2E_EVIDENCE_DIR');
  fs.rmSync(RUN_DIR, { recursive: true, force: true });
  fs.mkdirSync(RUN_DIR, { recursive: true });
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.writeFileSync(
    TRANSCRIPT_PATH,
    [
      `# Channel exchange e2e ${RUN_ID}`,
      '',
      `- repo root: ${REPO_ROOT}`,
      `- run dir: ${RUN_DIR}`,
      `- evidence dir: ${EVIDENCE_DIR}`,
      `- channel type: ${CHANNEL_TYPE}`,
      `- platform id: ${PLATFORM_ID}`,
      `- destination: ${DESTINATION_NAME}`,
      `- nonce: ${NONCE}`,
      `- timeout ms: ${TIMEOUT_MS}`,
      '',
    ].join('\n'),
  );

  const bunVersion = commandVersion('bun', ['--version']);
  const claudeVersion = commandVersion(CLAUDE_CODE_EXECUTABLE, ['--version']);
  const pnpmVersion = commandVersion('pnpm', ['--version']);
  appendTranscript('## Environment');
  appendTranscript(`- node: ${process.version}`);
  appendTranscript(`- platform: ${process.platform}/${process.arch}`);
  appendTranscript(`- pnpm: ${pnpmVersion.ok ? pnpmVersion.text : `missing (${pnpmVersion.text})`}`);
  appendTranscript(`- bun: ${bunVersion.ok ? bunVersion.text : `missing (${bunVersion.text})`}`);
  appendTranscript(`- claude executable: ${CLAUDE_CODE_EXECUTABLE}`);
  appendTranscript(`- claude version: ${claudeVersion.ok ? claudeVersion.text : `missing (${claudeVersion.text})`}`);
  appendTranscript(`- model: ${MODEL}`);
  appendTranscript('');

  if (!bunVersion.ok) throw new E2EFailure('environment', `bun unavailable: ${bunVersion.text}`, 2);
  if (!claudeVersion.ok) throw new E2EFailure('environment', `Claude Code CLI unavailable: ${claudeVersion.text}`, 2);

  process.chdir(RUN_DIR);

  const { initDb, closeDb } = await importRepoModule<{
    initDb(dbPath: string): Database.Database;
    closeDb(): void;
  }>('src/db/connection.ts');
  const { runMigrations } = await importRepoModule<{ runMigrations(db: Database.Database): void }>(
    'src/db/migrations/index.ts',
  );
  const { createAgentGroup } = await importRepoModule<{
    createAgentGroup(group: {
      id: string;
      name: string;
      folder: string;
      agent_provider: string | null;
      created_at: string;
    }): void;
  }>('src/db/agent-groups.ts');
  const { createMessagingGroup, createMessagingGroupAgent } = await importRepoModule<{
    createMessagingGroup(group: {
      id: string;
      channel_type: string;
      platform_id: string;
      name: string | null;
      is_group: 0 | 1;
      unknown_sender_policy: string;
      created_at: string;
    }): void;
    createMessagingGroupAgent(agent: {
      id: string;
      messaging_group_id: string;
      agent_group_id: string;
      engage_mode: string;
      engage_pattern: string | null;
      sender_scope: string;
      ignored_message_policy: string;
      session_mode: string;
      priority: number;
      created_at: string;
    }): void;
  }>('src/db/messaging-groups.ts');
  const { resolveSession, writeSessionMessage, inboundDbPath, outboundDbPath, writeSessionRouting } =
    await importRepoModule<{
      resolveSession(
        agentGroupId: string,
        messagingGroupId: string | null,
        threadId: string | null,
        sessionMode: 'shared' | 'per-thread' | 'agent-shared',
      ): { session: Session; created: boolean };
      writeSessionMessage(
        agentGroupId: string,
        sessionId: string,
        message: {
          id: string;
          kind: string;
          timestamp: string;
          platformId?: string | null;
          channelType?: string | null;
          threadId?: string | null;
          content: string;
          trigger?: 0 | 1;
        },
      ): void;
      inboundDbPath(agentGroupId: string, sessionId: string): string;
      outboundDbPath(agentGroupId: string, sessionId: string): string;
      writeSessionRouting(agentGroupId: string, sessionId: string): void;
    }>('src/session-manager.ts');
  const { openInboundDb: openHostInboundDb, replaceDestinations } = await importRepoModule<{
    openInboundDb(dbPath: string): Database.Database;
    replaceDestinations(
      db: Database.Database,
      entries: Array<{
        name: string;
        display_name: string | null;
        type: 'channel' | 'agent';
        channel_type: string | null;
        platform_id: string | null;
        agent_group_id: string | null;
      }>,
    ): void;
  }>('src/db/session-db.ts');
  const { setDeliveryAdapter, deliverSessionMessages, stopDeliveryPolls } = await importRepoModule<{
    setDeliveryAdapter(adapter: {
      deliver(
        channelType: string,
        platformId: string,
        threadId: string | null,
        kind: string,
        content: string,
      ): Promise<string | undefined>;
    }): void;
    deliverSessionMessages(session: Session): Promise<void>;
    stopDeliveryPolls(): void;
  }>('src/delivery.ts');

  const now = new Date().toISOString();
  const centralDbPath = path.join(RUN_DIR, 'data', 'nanoclaw-e2e.db');
  const db = initDb(centralDbPath);
  runMigrations(db);

  const agentFolder = 'channel-exchange-e2e-agent';
  const agentDir = path.join(RUN_DIR, 'groups', agentFolder);
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(
    path.join(agentDir, 'CLAUDE.md'),
    [
      '# Channel Exchange E2E Agent',
      '',
      `For the e2e request, send exactly <message to="${DESTINATION_NAME}">${EXPECTED_TEXT}</message>.`,
      'Do not add scratchpad text outside the message block.',
      '',
    ].join('\n'),
  );

  createAgentGroup({
    id: AGENT_GROUP_ID,
    name: 'Channel Exchange E2E Agent',
    folder: agentFolder,
    agent_provider: 'claude',
    created_at: now,
  });
  createMessagingGroup({
    id: MESSAGING_GROUP_ID,
    channel_type: CHANNEL_TYPE,
    platform_id: PLATFORM_ID,
    name: 'Channel Exchange E2E',
    is_group: 0,
    unknown_sender_policy: 'public',
    created_at: now,
  });
  createMessagingGroupAgent({
    id: 'mga-channel-exchange-e2e',
    messaging_group_id: MESSAGING_GROUP_ID,
    agent_group_id: AGENT_GROUP_ID,
    engage_mode: 'pattern',
    engage_pattern: '.',
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    created_at: now,
  });

  const { session } = resolveSession(AGENT_GROUP_ID, MESSAGING_GROUP_ID, null, 'shared');
  writeSessionRouting(AGENT_GROUP_ID, session.id);
  const inboundDb = inboundDbPath(AGENT_GROUP_ID, session.id);
  const outboundDb = outboundDbPath(AGENT_GROUP_ID, session.id);
  const hostInbound = openHostInboundDb(inboundDb);
  try {
    replaceDestinations(hostInbound, [
      {
        name: DESTINATION_NAME,
        display_name: 'E2E Channel',
        type: 'channel',
        channel_type: CHANNEL_TYPE,
        platform_id: PLATFORM_ID,
        agent_group_id: null,
      },
    ]);
  } finally {
    hostInbound.close();
  }
  writeSessionMessage(AGENT_GROUP_ID, session.id, {
    id: SESSION_MESSAGE_ID,
    kind: 'chat',
    timestamp: now,
    channelType: CHANNEL_TYPE,
    platformId: PLATFORM_ID,
    threadId: null,
    trigger: 1,
    content: JSON.stringify({
      sender: 'Channel Exchange E2E',
      senderId: 'channel-exchange-e2e:user',
      text: `Reply exactly with <message to="${DESTINATION_NAME}">${EXPECTED_TEXT}</message>. Nothing else.`,
    }),
  });

  appendTranscript('## Runtime paths');
  appendTranscript(`- central db: ${centralDbPath}`);
  appendTranscript(`- inbound db: ${inboundDb}`);
  appendTranscript(`- outbound db: ${outboundDb}`);
  appendTranscript(`- agent cwd: ${agentDir}`);
  appendTranscript('');

  const delivered: DeliveredMessage[] = [];
  setDeliveryAdapter({
    async deliver(channelType, platformId, threadId, kind, content) {
      const parsed = parseContent(content);
      const platformMessageId = `e2e-delivery-${delivered.length + 1}`;
      delivered.push({
        channelType,
        platformId,
        threadId,
        kind,
        content: JSON.parse(content) as unknown,
        contentText: parsed.text ?? content,
        platformMessageId,
      });
      return platformMessageId;
    },
  });

  const runner = spawn('bun', ['run', path.join(REPO_ROOT, 'scripts/e2e/channel-exchange-runner.ts')], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      NANOCLAW_RUNNER_INBOUND_DB: inboundDb,
      NANOCLAW_RUNNER_OUTBOUND_DB: outboundDb,
      NANOCLAW_RUNNER_HEARTBEAT: path.join(path.dirname(inboundDb), '.heartbeat'),
      NANOCLAW_E2E_AGENT_CWD: agentDir,
      NANOCLAW_E2E_MODEL: MODEL,
      CLAUDE_CODE_EXECUTABLE,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  pipeToFile(runner.stdout, RUNNER_STDOUT);
  pipeToFile(runner.stderr, RUNNER_STDERR);

  let failure: E2EFailure | null = null;
  try {
    const startedAt = Date.now();
    while (Date.now() - startedAt < TIMEOUT_MS) {
      await deliverSessionMessages(session);
      if (delivered.some((msg) => msg.contentText.includes(EXPECTED_TEXT))) {
        writeSnapshot({ inboundDb, outboundDb }, delivered);
        appendTranscript('## Result');
        appendTranscript(
          `CHANNEL_EXCHANGE_E2E_OK nonce=${NONCE} delivered=${delivered.length} inboundDb=${inboundDb} outboundDb=${outboundDb}`,
        );
        appendTranscript('');
        appendTranscript('## Delivered messages');
        appendTranscript('```json');
        appendTranscript(JSON.stringify(delivered, null, 2));
        appendTranscript('```');
        fs.writeFileSync(
          SUMMARY_PATH,
          JSON.stringify(
            {
              ok: true,
              runId: RUN_ID,
              nonce: NONCE,
              expectedText: EXPECTED_TEXT,
              channelType: CHANNEL_TYPE,
              claudeVersion: claudeVersion.text,
              model: MODEL,
              inboundDb,
              outboundDb,
              runnerStdout: RUNNER_STDOUT,
              runnerStderr: RUNNER_STDERR,
              dbSnapshot: DB_SNAPSHOT,
              delivered,
            },
            null,
            2,
          ),
        );
        console.log(
          `CHANNEL_EXCHANGE_E2E_OK nonce=${NONCE} delivered=${delivered.length} transcript=${TRANSCRIPT_PATH}`,
        );
        return 0;
      }
      if (runner.exitCode !== null) {
        failure = classifyRunnerFailure(
          fs.readFileSync(RUNNER_STDERR, 'utf8'),
          rowSnapshot(outboundDb, 'messages_out'),
        );
        break;
      }
      await wait(1000);
    }
    if (!failure) {
      const stderr = fs.existsSync(RUNNER_STDERR) ? fs.readFileSync(RUNNER_STDERR, 'utf8') : '';
      const outRows = rowSnapshot(outboundDb, 'messages_out');
      if (outRows.length > 0) {
        failure = new E2EFailure(
          'delivery',
          `outbound rows exist but expected message was not delivered; rows=${outRows.length}`,
        );
      } else if (/Started channel exchange/.test(stderr) || /agent-channel-mcp/.test(stderr)) {
        failure = new E2EFailure(
          'exchange_mcp',
          `runner stayed alive but no provider result reached outbound.db within ${TIMEOUT_MS}ms`,
        );
      } else {
        failure = new E2EFailure('provider', `no provider result within ${TIMEOUT_MS}ms`);
      }
    }
    throw failure;
  } finally {
    cleanupRunner(runner);
    stopDeliveryPolls();
    closeDb();
    writeSnapshot({ inboundDb, outboundDb }, delivered);
  }
}

let exitCode = 1;
try {
  exitCode = await main();
} catch (err) {
  const failure =
    err instanceof E2EFailure ? err : new E2EFailure('fatal', err instanceof Error ? err.message : String(err), 2);
  appendTranscript('## Result');
  appendTranscript(
    `CHANNEL_EXCHANGE_E2E_BLOCKED phase=${failure.phase} reason=${JSON.stringify(failure.message)} transcript=${TRANSCRIPT_PATH}`,
  );
  appendTranscript('');
  appendTranscript('## Runner stderr tail');
  appendTranscript('```');
  if (fs.existsSync(RUNNER_STDERR)) {
    appendTranscript(fs.readFileSync(RUNNER_STDERR, 'utf8').trim().split('\n').slice(-40).join('\n'));
  }
  appendTranscript('```');
  fs.writeFileSync(
    SUMMARY_PATH,
    JSON.stringify(
      {
        ok: false,
        runId: RUN_ID,
        phase: failure.phase,
        reason: failure.message,
        nonce: NONCE,
        expectedText: EXPECTED_TEXT,
        transcript: TRANSCRIPT_PATH,
        runnerStdout: RUNNER_STDOUT,
        runnerStderr: RUNNER_STDERR,
        dbSnapshot: DB_SNAPSHOT,
      },
      null,
      2,
    ),
  );
  console.error(
    `CHANNEL_EXCHANGE_E2E_BLOCKED phase=${failure.phase} reason=${JSON.stringify(failure.message)} transcript=${TRANSCRIPT_PATH}`,
  );
  exitCode = failure.exitCode;
}

process.exit(exitCode);
