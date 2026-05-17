import {
  AGENT_CHANNEL_SCHEMA_VERSION,
  NANOCLAW_INBOUND_BODY_KIND,
  type ChannelDescriptor,
  type ExchangeEnvelope,
} from './claude-channel-exchange.js';

const CHANNEL_NOTIFICATION_METHOD = 'notifications/claude/channel';
const CHANNEL_CAPABILITY_KEY = 'claude/channel';
const SENDER_HEADER = 'x-agent-channel-sender';
const JSON_RPC_VERSION = '2.0';

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

interface ServerMessage {
  jsonrpc: '2.0';
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface ChannelNotificationParams {
  channel_event:
    | { event: 'message'; body_kind: string; payload: unknown }
    | { event: 'delivery_error'; error: string; failed_msg_id: string; human_message: string };
  envelope_meta: {
    msg_id: string;
    from: string;
    to: string;
    in_reply_to?: string;
    ts: string;
    schema_version: string;
  };
}

const TOOL_DESCRIPTORS = [
  {
    name: 'channel.send',
    description: 'Send one message to a target mailbox via the agent-channel exchange.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['to', 'body_kind', 'payload'],
      properties: {
        to: { type: 'string', minLength: 1 },
        body_kind: { type: 'string', minLength: 1 },
        payload: {},
        in_reply_to: { type: 'string', minLength: 1 },
      },
    },
  },
  {
    name: 'channel.list_channels',
    description: 'List currently registered mailboxes on the exchange.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        filter: {
          type: 'object',
          additionalProperties: false,
          properties: {
            agent_kind: { type: 'array', items: { type: 'string' } },
            capability: { type: 'array', items: { type: 'string' } },
            label_glob: { type: 'string', minLength: 1 },
          },
        },
      },
    },
  },
  {
    name: 'channel.poll_inbox',
    description:
      'Drain this mailbox inbox and return inbound deliver.message / deliver.error envelopes visible to Claude Code.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
  },
];

const exchangeUrl = requiredEnv('AGENT_CHANNEL_EXCHANGE_URL');
const desiredChannelId = requiredEnv('AGENT_CHANNEL_DESIRED_ID');
const instanceLabel = process.env.AGENT_CHANNEL_INSTANCE_LABEL || 'claude-code';
const pendingInbox: ChannelNotificationParams[] = [];
let channelId = desiredChannelId;

function log(message: string): void {
  process.stderr.write(`[agent-channel-mcp] ${message}\n`);
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    process.stderr.write(`[agent-channel-mcp] ${name} is required\n`);
    process.exit(2);
  }
  return value;
}

function emit(message: ServerMessage): void {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function ok(id: JsonRpcId, result: unknown): void {
  emit({ jsonrpc: JSON_RPC_VERSION, id, result });
}

function fail(id: JsonRpcId, code: number, message: string, data?: unknown): void {
  emit({ jsonrpc: JSON_RPC_VERSION, id, error: { code, message, ...(data !== undefined ? { data } : {}) } });
}

async function main(): Promise<void> {
  await register();

  let buffer = '';
  process.stdin.on('data', (chunk) => {
    buffer += chunk.toString();
    let idx: number;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line.length > 0) void handleLine(line);
    }
  });

  const timer = setInterval(() => {
    void heartbeat().catch((err) => log(`heartbeat failed: ${err instanceof Error ? err.message : String(err)}`));
  }, 30_000);

  const shutdown = (): void => {
    clearInterval(timer);
    void deregister().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function register(): Promise<void> {
  const envelope: ExchangeEnvelope = {
    msg_id: nextMsgId('register'),
    from: desiredChannelId,
    to: 'exchange/system',
    ts: new Date().toISOString(),
    schema_version: AGENT_CHANNEL_SCHEMA_VERSION,
    body: {
      kind: 'register.request',
      payload: {
        schema_version: AGENT_CHANNEL_SCHEMA_VERSION,
        desired_channel_id: desiredChannelId,
        capabilities: ['channel.send', 'channel.receive', 'discovery.list'],
        identity: {
          agent_kind: 'mcp-child',
          instance_label: instanceLabel,
        },
        heartbeat_hint: { interval_seconds: 30 },
      },
    },
  };
  const response = await fetchJson('/v1/register', { method: 'POST', body: envelope });
  if (!isEnvelope(response) || response.body.kind !== 'register.response') {
    throw new Error(`register failed: ${JSON.stringify(response)}`);
  }
  channelId = response.body.payload.channel_id;
  log(`registered channel_id=${channelId}`);
}

async function deregister(): Promise<void> {
  await fetchJson('/v1/deregister', { method: 'POST', body: { channel_id: channelId } }).catch(() => undefined);
}

async function handleLine(line: string): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (err) {
    fail(null, -32700, 'parse error', err instanceof Error ? err.message : String(err));
    return;
  }
  if (Array.isArray(parsed)) {
    for (const item of parsed) await handleRequest(item);
    return;
  }
  await handleRequest(parsed);
}

async function handleRequest(raw: unknown): Promise<void> {
  if (!isRequest(raw)) {
    fail(null, -32600, 'invalid Request object');
    return;
  }

  const id = raw.id ?? null;
  const isNotification = raw.id === undefined;
  try {
    switch (raw.method) {
      case 'initialize':
        ok(id, {
          protocolVersion: '2024-11-05',
          serverInfo: { name: '@agent-channel/mcp', version: '0.1.0-nanoclaw' },
          capabilities: {
            tools: { listChanged: false },
            experimental: { [CHANNEL_CAPABILITY_KEY]: {} },
          },
        });
        return;
      case 'notifications/initialized':
      case 'initialized':
        return;
      case 'ping':
        ok(id, {});
        return;
      case 'tools/list':
        ok(id, { tools: TOOL_DESCRIPTORS });
        return;
      case 'tools/call':
        await handleToolCall(id, raw.params);
        return;
      default:
        if (!isNotification) fail(id, -32601, `method not found: ${raw.method}`);
    }
  } catch (err) {
    if (!isNotification) fail(id, -32603, 'internal error', err instanceof Error ? err.message : String(err));
  }
}

async function handleToolCall(id: JsonRpcId, params: unknown): Promise<void> {
  if (!isRecord(params) || typeof params.name !== 'string') {
    fail(id, -32602, 'tools/call requires .name string');
    return;
  }

  let result: unknown;
  switch (params.name) {
    case 'channel.send':
      result = await channelSend(params.arguments);
      break;
    case 'channel.list_channels':
      result = await channelList(params.arguments);
      break;
    case 'channel.poll_inbox':
      result = await channelPollInbox();
      break;
    default:
      fail(id, -32602, `unknown tool ${params.name}`);
      return;
  }

  const isError = isRecord(result) && result.ok === false;
  ok(id, {
    content: [{ type: 'text', text: JSON.stringify(result) }],
    structuredContent: result,
    isError,
  });
}

async function channelSend(args: unknown): Promise<unknown> {
  if (!isRecord(args) || typeof args.to !== 'string' || typeof args.body_kind !== 'string' || !('payload' in args)) {
    return { ok: false, error: { kind: 'envelope_invalid', message: 'to, body_kind, and payload are required' } };
  }

  const envelope: ExchangeEnvelope = {
    msg_id: nextMsgId('send'),
    from: channelId,
    to: args.to,
    ...(typeof args.in_reply_to === 'string' ? { in_reply_to: args.in_reply_to } : {}),
    ts: new Date().toISOString(),
    schema_version: AGENT_CHANNEL_SCHEMA_VERSION,
    body: {
      kind: 'deliver.message',
      payload: {
        body_kind: args.body_kind,
        payload: args.payload,
        ...(typeof args.in_reply_to === 'string' ? { in_reply_to: args.in_reply_to } : {}),
      },
    },
  };
  const response = await postEnvelope(envelope);
  if (response.body.kind === 'deliver.error') {
    return {
      ok: false,
      error: {
        kind: response.body.payload.error,
        message: response.body.payload.human_message,
      },
    };
  }
  return { ok: true, msg_id: envelope.msg_id, sent_at: envelope.ts };
}

async function channelList(args: unknown): Promise<unknown> {
  const filter = isRecord(args) && isRecord(args.filter) ? args.filter : undefined;
  const envelope: ExchangeEnvelope = {
    msg_id: nextMsgId('list'),
    from: channelId,
    to: 'exchange/system',
    ts: new Date().toISOString(),
    schema_version: AGENT_CHANNEL_SCHEMA_VERSION,
    body: {
      kind: 'discovery.list_request',
      payload: filter ? { filter } : {},
    },
  };
  const response = await fetchJson('/v1/discovery/list', {
    method: 'POST',
    sender: channelId,
    body: envelope,
  });
  if (!isEnvelope(response) || response.body.kind !== 'discovery.list_response') {
    return {
      ok: false,
      error: { kind: 'exchange_offline', message: `unexpected list response: ${JSON.stringify(response)}` },
    };
  }
  return {
    ok: true,
    channels: response.body.payload.channels as ChannelDescriptor[],
    generated_at: response.body.payload.generated_at,
  };
}

async function channelPollInbox(): Promise<unknown> {
  await heartbeat();
  const events = pendingInbox.splice(0, pendingInbox.length);
  return { ok: true, events, drained_at: new Date().toISOString() };
}

async function heartbeat(): Promise<void> {
  const envelope: ExchangeEnvelope = {
    msg_id: nextMsgId('heartbeat'),
    from: channelId,
    to: 'exchange/system',
    ts: new Date().toISOString(),
    schema_version: AGENT_CHANNEL_SCHEMA_VERSION,
    body: {
      kind: 'heartbeat.ping',
      payload: { channel_id: channelId, sequence: Date.now() },
    },
  };
  await postEnvelope(envelope);
}

async function postEnvelope(envelope: ExchangeEnvelope): Promise<ExchangeEnvelope> {
  const result = await fetchJson('/v1/envelope', { method: 'POST', sender: channelId, body: envelope });
  if (!isRecord(result) || !isEnvelope(result.response) || !Array.isArray(result.inbox)) {
    throw new Error(`unexpected envelope response: ${JSON.stringify(result)}`);
  }
  for (const item of result.inbox) {
    if (isEnvelope(item)) pushInboundNotification(item);
  }
  return result.response;
}

function pushInboundNotification(envelope: ExchangeEnvelope): void {
  const params = toNotification(envelope);
  if (!params) return;
  pendingInbox.push(params);
  emit({
    jsonrpc: JSON_RPC_VERSION,
    method: CHANNEL_NOTIFICATION_METHOD,
    params,
  });
}

function toNotification(envelope: ExchangeEnvelope): ChannelNotificationParams | null {
  const envelope_meta = {
    msg_id: envelope.msg_id,
    from: envelope.from,
    to: envelope.to,
    ...(envelope.in_reply_to !== undefined ? { in_reply_to: envelope.in_reply_to } : {}),
    ts: envelope.ts,
    schema_version: envelope.schema_version,
  };

  if (envelope.body.kind === 'deliver.message') {
    return {
      channel_event: {
        event: 'message',
        body_kind: envelope.body.payload.body_kind,
        payload: envelope.body.payload.payload,
      },
      envelope_meta,
    };
  }
  if (envelope.body.kind === 'deliver.error') {
    return {
      channel_event: {
        event: 'delivery_error',
        error: envelope.body.payload.error,
        failed_msg_id: envelope.body.payload.failed_msg_id,
        human_message: envelope.body.payload.human_message,
      },
      envelope_meta,
    };
  }
  return null;
}

async function fetchJson(pathname: string, opts: { method: 'POST'; body: unknown; sender?: string }): Promise<unknown> {
  const response = await fetch(`${exchangeUrl.replace(/\/+$/, '')}${pathname}`, {
    method: opts.method,
    headers: {
      'content-type': 'application/json',
      ...(opts.sender ? { [SENDER_HEADER]: opts.sender } : {}),
    },
    body: JSON.stringify(opts.body),
  });
  return response.json();
}

function isRequest(value: unknown): value is JsonRpcRequest {
  return isRecord(value) && value.jsonrpc === JSON_RPC_VERSION && typeof value.method === 'string';
}

function isEnvelope(value: unknown): value is ExchangeEnvelope {
  return (
    isRecord(value) &&
    isRecord(value.body) &&
    typeof value.msg_id === 'string' &&
    typeof value.from === 'string' &&
    typeof value.to === 'string' &&
    typeof value.ts === 'string' &&
    typeof value.schema_version === 'string' &&
    typeof value.body.kind === 'string'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nextMsgId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

main().catch((err) => {
  log(`startup error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
