import { randomUUID } from 'crypto';

export const AGENT_CHANNEL_SCHEMA_VERSION = '0.1.0';
export const AGENT_CHANNEL_SERVER_NAME = 'agent-channel';
export const NANOCLAW_INBOUND_BODY_KIND = 'nanoclaw.message_in';
export const NANOCLAW_OUTBOUND_BODY_KIND = 'nanoclaw.message_out';

const EXCHANGE_SYSTEM_CHANNEL = 'exchange/system';
const SENDER_HEADER = 'x-agent-channel-sender';

type EnvelopeBody =
  | { kind: 'register.request'; payload: RegisterRequest }
  | { kind: 'register.response'; payload: RegisterResponse }
  | { kind: 'heartbeat.ping'; payload: { channel_id: string; sequence: number } }
  | { kind: 'heartbeat.pong'; payload: { channel_id: string; sequence: number } }
  | { kind: 'discovery.list_request'; payload: { filter?: ChannelListFilter } }
  | { kind: 'discovery.list_response'; payload: { channels: ChannelDescriptor[]; generated_at: string } }
  | { kind: 'deliver.message'; payload: ExchangeDeliverMessage }
  | { kind: 'deliver.error'; payload: ExchangeDeliverError };

export interface ExchangeEnvelope {
  msg_id: string;
  from: string;
  to: string;
  in_reply_to?: string;
  ts: string;
  schema_version: string;
  body: EnvelopeBody;
}

interface ExchangeDeliverMessage {
  body_kind: string;
  payload: unknown;
  in_reply_to?: string;
  reply_to_msg_id?: string;
}

interface ExchangeDeliverError {
  error:
    | 'target_unknown'
    | 'unauthorized'
    | 'exchange_offline'
    | 'envelope_invalid'
    | 'mailbox_deregistered'
    | 'schema_version_incompatible'
    | 'rate_limited';
  failed_msg_id: string;
  human_message: string;
}

interface RegisterRequest {
  schema_version: string;
  capabilities: string[];
  identity: {
    agent_kind: string;
    instance_label: string;
    parent_channel_id?: string;
  };
  desired_channel_id?: string;
  heartbeat_hint?: {
    interval_seconds: number;
  };
}

interface RegisterResponse {
  channel_id: string;
  registered_at: string;
  heartbeat: {
    interval_seconds: number;
    timeout_seconds: number;
  };
  delivery_endpoint: string;
  schema_version: string;
}

interface ChannelListFilter {
  agent_kind?: string[];
  capability?: string[];
  label_glob?: string;
}

export interface ChannelDescriptor {
  channel_id: string;
  agent_kind: string;
  instance_label: string;
  capabilities: string[];
  registered_at: string;
  parent_channel_id?: string;
}

export interface ClaudeChannelRuntimeMessage {
  text: string;
  envelope: ExchangeEnvelope;
}

export interface ClaudeChannelRuntimeError {
  message: string;
  retryable: boolean;
  classification?: string;
  envelope: ExchangeEnvelope;
}

export interface ClaudeChannelExchangeCallbacks {
  onRuntimeMessage(message: ClaudeChannelRuntimeMessage): void;
  onRuntimeError(error: ClaudeChannelRuntimeError): void;
}

export interface ClaudeChannelExchange {
  readonly url: string;
  readonly runtimeChannelId: string;
  readonly claudeChannelId: string;
  deliverToClaude(text: string): string;
  stop(): void;
}

export type ClaudeChannelExchangeFactory = (callbacks: ClaudeChannelExchangeCallbacks) => ClaudeChannelExchange;

interface Mailbox {
  descriptor: ChannelDescriptor;
  inbox: ExchangeEnvelope[];
}

export function startClaudeChannelExchange(callbacks: ClaudeChannelExchangeCallbacks): ClaudeChannelExchange {
  const runtimeSessionId = randomUUID();
  const runtimeChannelId = `nanoclaw/${encodeURIComponent('agent-runner')}/${encodeURIComponent(runtimeSessionId)}`;
  const claudeChannelId = `claude-code/${runtimeSessionId}`;
  const mailboxes = new Map<string, Mailbox>();

  const registerMailbox = (
    channelId: string,
    descriptor: Omit<ChannelDescriptor, 'channel_id' | 'registered_at'>,
  ): ChannelDescriptor => {
    const existing = mailboxes.get(channelId);
    if (existing) return existing.descriptor;

    const full: ChannelDescriptor = {
      channel_id: channelId,
      registered_at: new Date().toISOString(),
      ...descriptor,
    };
    mailboxes.set(channelId, { descriptor: full, inbox: [] });
    return full;
  };

  registerMailbox(runtimeChannelId, {
    agent_kind: 'worker-agent',
    instance_label: 'nanoclaw-agent-runner',
    capabilities: ['channel.send', 'channel.receive', 'discovery.list'],
  });
  registerMailbox(claudeChannelId, {
    agent_kind: 'mcp-child',
    instance_label: 'claude-code',
    capabilities: ['channel.send', 'channel.receive', 'discovery.list'],
  });

  const handle = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      if (request.method === 'GET' && url.pathname === '/version') {
        return json({ schema_version: AGENT_CHANNEL_SCHEMA_VERSION, server_version: 'nanoclaw-provider-local' });
      }
      if (request.method === 'POST' && url.pathname === '/v1/register') {
        return handleRegister(request);
      }
      if (request.method === 'POST' && url.pathname === '/v1/deregister') {
        return handleDeregister(request);
      }
      if (request.method === 'POST' && url.pathname === '/v1/discovery/list') {
        return handleDiscoveryList(request);
      }
      if (request.method === 'POST' && url.pathname === '/v1/envelope') {
        return handleEnvelope(request);
      }
      return new Response('not found', { status: 404 });
    },
  });

  function deliverToClaude(text: string): string {
    const msgId = nextMsgId('nanoclaw-turn');
    enqueue(claudeChannelId, {
      msg_id: msgId,
      from: runtimeChannelId,
      to: claudeChannelId,
      ts: new Date().toISOString(),
      schema_version: AGENT_CHANNEL_SCHEMA_VERSION,
      body: {
        kind: 'deliver.message',
        payload: {
          body_kind: NANOCLAW_OUTBOUND_BODY_KIND,
          payload: {
            direction: 'outbound',
            session: {
              agent_group_id: 'agent-runner',
              session_id: runtimeSessionId,
            },
            message: {
              id: msgId,
              kind: 'chat',
              timestamp: new Date().toISOString(),
              content: { text },
            },
            destination: {
              exchange_channel_id: claudeChannelId,
            },
          },
        },
      },
    });
    return msgId;
  }

  async function handleRegister(request: Request): Promise<Response> {
    const envelope = await readEnvelope(request);
    if (!envelope || envelope.body.kind !== 'register.request') {
      return json({ error: 'body.kind must be register.request' }, 400);
    }

    const payload = envelope.body.payload;
    const channelId = payload.desired_channel_id ?? `auto/${nextMsgId('channel')}`;
    const descriptor = registerMailbox(channelId, {
      agent_kind: payload.identity.agent_kind,
      instance_label: payload.identity.instance_label,
      capabilities: payload.capabilities,
      ...(payload.identity.parent_channel_id !== undefined
        ? { parent_channel_id: payload.identity.parent_channel_id }
        : {}),
    });
    const registeredAt = descriptor.registered_at;
    const response: ExchangeEnvelope = {
      msg_id: nextMsgId('register'),
      from: EXCHANGE_SYSTEM_CHANNEL,
      to: channelId,
      in_reply_to: envelope.msg_id,
      ts: registeredAt,
      schema_version: AGENT_CHANNEL_SCHEMA_VERSION,
      body: {
        kind: 'register.response',
        payload: {
          channel_id: channelId,
          registered_at: registeredAt,
          heartbeat: {
            interval_seconds: payload.heartbeat_hint?.interval_seconds ?? 30,
            timeout_seconds: 120,
          },
          delivery_endpoint: `${serverUrl()}/v1/envelope`,
          schema_version: AGENT_CHANNEL_SCHEMA_VERSION,
        },
      },
    };
    return json(response);
  }

  async function handleDeregister(request: Request): Promise<Response> {
    const raw = (await request.json().catch(() => ({}))) as { channel_id?: unknown };
    const channelId = typeof raw.channel_id === 'string' ? raw.channel_id : request.headers.get(SENDER_HEADER);
    const removed = channelId ? mailboxes.delete(channelId) : false;
    return json({ ok: true, removed });
  }

  async function handleDiscoveryList(request: Request): Promise<Response> {
    const sender = request.headers.get(SENDER_HEADER);
    if (!sender || !mailboxes.has(sender)) return json({ error: 'sender not registered' }, 401);

    const envelope = await readEnvelope(request);
    if (!envelope || envelope.body.kind !== 'discovery.list_request') {
      return json({ error: 'body.kind must be discovery.list_request' }, 400);
    }
    const filter = (envelope.body.payload as { filter?: ChannelListFilter }).filter;
    const channels = [...mailboxes.values()].map((m) => m.descriptor).filter((d) => matchesFilter(d, filter));
    const response: ExchangeEnvelope = {
      msg_id: nextMsgId('discovery'),
      from: EXCHANGE_SYSTEM_CHANNEL,
      to: sender,
      in_reply_to: envelope.msg_id,
      ts: new Date().toISOString(),
      schema_version: AGENT_CHANNEL_SCHEMA_VERSION,
      body: {
        kind: 'discovery.list_response',
        payload: { channels, generated_at: new Date().toISOString() },
      },
    };
    return json(response);
  }

  async function handleEnvelope(request: Request): Promise<Response> {
    const sender = request.headers.get(SENDER_HEADER);
    if (!sender || !mailboxes.has(sender)) {
      return json({
        response: deliverError('unknown', sender ?? 'unknown', 'unauthorized', 'sender not registered'),
        inbox: [],
      });
    }

    const envelope = await readEnvelope(request);
    if (!envelope) {
      return json({
        response: deliverError('unknown', sender, 'envelope_invalid', 'request body is not valid JSON'),
        inbox: [],
      });
    }

    let response: ExchangeEnvelope;
    if (envelope.body.kind === 'heartbeat.ping') {
      response = {
        msg_id: nextMsgId('heartbeat'),
        from: EXCHANGE_SYSTEM_CHANNEL,
        to: sender,
        in_reply_to: envelope.msg_id,
        ts: new Date().toISOString(),
        schema_version: AGENT_CHANNEL_SCHEMA_VERSION,
        body: {
          kind: 'heartbeat.pong',
          payload: { channel_id: sender, sequence: envelope.body.payload.sequence },
        },
      };
    } else if (envelope.body.kind === 'deliver.message') {
      response = routeDeliverMessage({ ...envelope, from: sender });
    } else if (envelope.body.kind === 'deliver.error') {
      response = routeDeliverError({ ...envelope, from: sender });
    } else {
      response = deliverError(
        envelope.msg_id,
        sender,
        'envelope_invalid',
        `unsupported body.kind: ${envelope.body.kind}`,
      );
    }

    return json({ response, inbox: drain(sender) });
  }

  function routeDeliverMessage(envelope: ExchangeEnvelope): ExchangeEnvelope {
    if (envelope.to === runtimeChannelId) {
      const text = extractRuntimeMessageText(envelope);
      if (text.ok) {
        callbacks.onRuntimeMessage({ text: text.text, envelope });
      } else {
        callbacks.onRuntimeError({
          message: text.message,
          retryable: false,
          envelope,
        });
      }
      return deliveryAck(envelope, envelope.from);
    }

    if (!mailboxes.has(envelope.to)) {
      return deliverError(
        envelope.msg_id,
        envelope.from,
        'target_unknown',
        `target mailbox ${envelope.to} is not registered`,
      );
    }

    enqueue(envelope.to, envelope);
    return deliveryAck(envelope, envelope.from);
  }

  function routeDeliverError(envelope: ExchangeEnvelope): ExchangeEnvelope {
    if (envelope.to === runtimeChannelId && envelope.body.kind === 'deliver.error') {
      callbacks.onRuntimeError({
        message: envelope.body.payload.human_message,
        retryable: false,
        classification: envelope.body.payload.error === 'rate_limited' ? 'quota' : undefined,
        envelope,
      });
      return deliveryAck(envelope, envelope.from);
    }
    if (!mailboxes.has(envelope.to)) {
      return deliverError(
        envelope.msg_id,
        envelope.from,
        'target_unknown',
        `target mailbox ${envelope.to} is not registered`,
      );
    }
    enqueue(envelope.to, envelope);
    return deliveryAck(envelope, envelope.from);
  }

  function enqueue(channelId: string, envelope: ExchangeEnvelope): void {
    const mailbox = mailboxes.get(channelId);
    if (!mailbox) return;
    mailbox.inbox.push(envelope);
  }

  function drain(channelId: string): ExchangeEnvelope[] {
    const mailbox = mailboxes.get(channelId);
    if (!mailbox) return [];
    return mailbox.inbox.splice(0, mailbox.inbox.length);
  }

  function serverUrl(): string {
    return `http://${handle.hostname}:${handle.port}`;
  }

  return {
    url: serverUrl(),
    runtimeChannelId,
    claudeChannelId,
    deliverToClaude,
    stop: () => handle.stop(true),
  };
}

function extractRuntimeMessageText(
  envelope: ExchangeEnvelope,
): { ok: true; text: string } | { ok: false; message: string } {
  if (envelope.body.kind !== 'deliver.message') {
    return { ok: false, message: 'runtime message envelope must be deliver.message' };
  }

  const deliver = envelope.body.payload;
  if (deliver.body_kind !== NANOCLAW_INBOUND_BODY_KIND) {
    return { ok: false, message: `unsupported channel.send body_kind: ${deliver.body_kind}` };
  }

  const payload = normalizePossiblyStringifiedJson(deliver.payload);
  return extractPayloadText(payload);
}

function extractPayloadText(payload: unknown): { ok: true; text: string } | { ok: false; message: string } {
  const normalized = normalizePossiblyStringifiedJson(payload);
  if (typeof normalized === 'string') return { ok: true, text: normalized };
  if (!isRecord(normalized)) return { ok: false, message: 'channel.send payload must be text or an object' };

  const message = isRecord(normalized.message) ? normalized.message : normalized;
  const content =
    'content' in message
      ? normalizePossiblyStringifiedJson(message.content)
      : normalizePossiblyStringifiedJson(message.text);
  if (typeof content === 'string') return { ok: true, text: content };
  if (isRecord(content) && typeof content.text === 'string') return { ok: true, text: content.text };
  if (content !== undefined) return { ok: true, text: JSON.stringify(content) };
  return { ok: false, message: 'channel.send payload.message.content is required' };
}

export function normalizePossiblyStringifiedJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function deliveryAck(envelope: ExchangeEnvelope, to: string): ExchangeEnvelope {
  return {
    msg_id: nextMsgId('ack'),
    from: EXCHANGE_SYSTEM_CHANNEL,
    to,
    in_reply_to: envelope.msg_id,
    ts: new Date().toISOString(),
    schema_version: AGENT_CHANNEL_SCHEMA_VERSION,
    body: {
      kind: 'deliver.message',
      payload: {
        body_kind: 'exchange.delivery_ack',
        payload: { accepted: true, target: envelope.to, msg_id: envelope.msg_id },
      },
    },
  };
}

function deliverError(
  failedMsgId: string,
  to: string,
  error: ExchangeDeliverError['error'],
  humanMessage: string,
): ExchangeEnvelope {
  return {
    msg_id: nextMsgId('error'),
    from: EXCHANGE_SYSTEM_CHANNEL,
    to,
    in_reply_to: failedMsgId,
    ts: new Date().toISOString(),
    schema_version: AGENT_CHANNEL_SCHEMA_VERSION,
    body: {
      kind: 'deliver.error',
      payload: {
        error,
        failed_msg_id: failedMsgId,
        human_message: humanMessage,
      },
    },
  };
}

function matchesFilter(descriptor: ChannelDescriptor, filter: ChannelListFilter | undefined): boolean {
  if (!filter) return true;
  if (filter.agent_kind && !filter.agent_kind.includes(descriptor.agent_kind)) return false;
  if (filter.capability && !filter.capability.every((cap) => descriptor.capabilities.includes(cap))) return false;
  if (filter.label_glob && !globMatches(filter.label_glob, descriptor.instance_label)) return false;
  return true;
}

function globMatches(glob: string, value: string): boolean {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`).test(value);
}

async function readEnvelope(request: Request): Promise<ExchangeEnvelope | null> {
  const raw = await request.json().catch(() => null);
  return isEnvelope(raw) ? raw : null;
}

function isEnvelope(value: unknown): value is ExchangeEnvelope {
  if (!isRecord(value) || !isRecord(value.body)) return false;
  return (
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
  return `${prefix}-${Date.now()}-${randomUUID()}`;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
