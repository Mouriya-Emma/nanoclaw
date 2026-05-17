import type { MessageInKind, Session } from '../types.js';

export const NANOCLAW_EXCHANGE_SCHEMA_VERSION = '0.1.0';
export const NANOCLAW_INBOUND_BODY_KIND = 'nanoclaw.message_in';
export const NANOCLAW_OUTBOUND_BODY_KIND = 'nanoclaw.message_out';

export type ExchangeDeliveryErrorVariant =
  | 'target_unknown'
  | 'unauthorized'
  | 'exchange_offline'
  | 'envelope_invalid'
  | 'mailbox_deregistered'
  | 'schema_version_incompatible'
  | 'rate_limited';

export interface ExchangeDeliverMessage {
  body_kind: string;
  payload: unknown;
  reply_to_msg_id?: string;
}

export interface ExchangeDeliverError {
  error: ExchangeDeliveryErrorVariant;
  failed_msg_id: string;
  human_message: string;
}

export interface ExchangeEnvelopeBase {
  msg_id: string;
  from: string;
  to: string;
  in_reply_to?: string;
  ts: string;
  schema_version: string;
}

export interface ExchangeDeliverMessageEnvelope extends ExchangeEnvelopeBase {
  body: {
    kind: 'deliver.message';
    payload: ExchangeDeliverMessage;
  };
}

export interface ExchangeDeliverErrorEnvelope extends ExchangeEnvelopeBase {
  body: {
    kind: 'deliver.error';
    payload: ExchangeDeliverError;
  };
}

export type ExchangeEnvelope = ExchangeDeliverMessageEnvelope | ExchangeDeliverErrorEnvelope;

export interface NanoClawExchangeDestination {
  exchangeChannelId: string;
  channelType?: string | null;
  platformId?: string | null;
  threadId?: string | null;
  localName?: string | null;
}

export interface NanoClawMessageProjection {
  direction: 'inbound' | 'outbound';
  session: {
    agentGroupId: string;
    sessionId: string;
  };
  message: {
    id: string;
    kind: string;
    timestamp: string;
    content: unknown;
    inReplyTo?: string | null;
  };
  destination: NanoClawExchangeDestination;
  source?: {
    exchangeChannelId?: string;
  };
  exchange?: {
    msgId?: string;
    schemaVersion?: string;
    timestamp?: string;
  };
}

export interface DecodedExchangeInbound {
  agentGroupId: string;
  sessionId: string;
  message: {
    id: string;
    kind: MessageInKind;
    timestamp: string;
    platformId: string | null;
    channelType: string | null;
    threadId: string | null;
    content: string;
    processAfter: string | null;
    recurrence: string | null;
    trigger: 0 | 1;
    sourceSessionId: string | null;
    onWake: 0 | 1;
  };
  wake: boolean;
}

export interface DecodedExchangeDeliveryFailure {
  agentGroupId: string;
  sessionId: string;
  deliveryFailure: {
    envelopeMsgId: string;
    failedMsgId: string;
    error: ExchangeDeliveryErrorVariant;
    humanMessage: string;
    reportedAt: string;
    inReplyTo?: string;
  };
}

export type BridgeReceiveErrorCode =
  | 'unsupported_envelope'
  | 'unsupported_body_kind'
  | 'invalid_payload'
  | 'target_mismatch'
  | 'session_not_found'
  | 'session_agent_mismatch';

export type BridgeReceiveResult =
  | {
      ok: true;
      event: 'message';
      agentGroupId: string;
      sessionId: string;
      messageId: string;
      woke: boolean;
    }
  | {
      ok: true;
      event: 'delivery_failure';
      agentGroupId: string;
      sessionId: string;
      messageId: string;
      deliveryFailure: DecodedExchangeDeliveryFailure['deliveryFailure'];
    }
  | {
      ok: false;
      error: BridgeReceiveErrorCode;
      failedMsgId: string;
      message: string;
    };

export interface NanoClawExchangeRuntimeDeps {
  getSession(sessionId: string): Session | undefined;
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
      processAfter?: string | null;
      recurrence?: string | null;
      trigger?: 0 | 1;
      sourceSessionId?: string | null;
      onWake?: 0 | 1;
    },
  ): void;
  wakeContainer(session: Session): Promise<boolean>;
}

export interface NanoClawExchangeRuntimeBridge {
  receiveEnvelope(envelope: ExchangeEnvelope): Promise<BridgeReceiveResult>;
}

const MESSAGE_IN_KINDS = ['chat', 'chat-sdk', 'task', 'webhook', 'system'] as const satisfies readonly MessageInKind[];

export function nanoclawRuntimeChannelId(agentGroupId: string, sessionId: string): string {
  return `nanoclaw/${encodeURIComponent(agentGroupId)}/${encodeURIComponent(sessionId)}`;
}

export function parseNanoclawRuntimeChannelId(channelId: string): { agentGroupId: string; sessionId: string } | null {
  const prefix = 'nanoclaw/';
  if (!channelId.startsWith(prefix)) return null;

  const parts = channelId.slice(prefix.length).split('/');
  if (parts.length !== 2) return null;

  try {
    const [agentGroupId, sessionId] = parts.map((part) => decodeURIComponent(part));
    if (!agentGroupId || !sessionId) return null;
    return { agentGroupId, sessionId };
  } catch {
    return null;
  }
}

export function normalizePossiblyStringifiedJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function projectNanoClawMessageToExchangeEnvelope(
  projection: NanoClawMessageProjection,
): ExchangeDeliverMessageEnvelope {
  const inReplyTo = projection.message.inReplyTo ?? undefined;
  const deliverPayload: ExchangeDeliverMessage = {
    body_kind: projection.direction === 'inbound' ? NANOCLAW_INBOUND_BODY_KIND : NANOCLAW_OUTBOUND_BODY_KIND,
    payload: {
      direction: projection.direction,
      session: {
        agent_group_id: projection.session.agentGroupId,
        session_id: projection.session.sessionId,
      },
      message: {
        id: projection.message.id,
        kind: projection.message.kind,
        timestamp: projection.message.timestamp,
        content: normalizePossiblyStringifiedJson(projection.message.content),
      },
      destination: {
        exchange_channel_id: projection.destination.exchangeChannelId,
        channel_type: projection.destination.channelType ?? null,
        platform_id: projection.destination.platformId ?? null,
        thread_id: projection.destination.threadId ?? null,
        local_name: projection.destination.localName ?? null,
      },
    },
  };

  if (inReplyTo !== undefined) {
    deliverPayload.reply_to_msg_id = inReplyTo;
  }

  const envelope: ExchangeDeliverMessageEnvelope = {
    msg_id: projection.exchange?.msgId ?? projection.message.id,
    from:
      projection.source?.exchangeChannelId ??
      nanoclawRuntimeChannelId(projection.session.agentGroupId, projection.session.sessionId),
    to: projection.destination.exchangeChannelId,
    ts: projection.exchange?.timestamp ?? projection.message.timestamp,
    schema_version: projection.exchange?.schemaVersion ?? NANOCLAW_EXCHANGE_SCHEMA_VERSION,
    body: {
      kind: 'deliver.message',
      payload: deliverPayload,
    },
  };

  if (inReplyTo !== undefined) {
    envelope.in_reply_to = inReplyTo;
  }

  return envelope;
}

export function buildExchangeDeliveryErrorEnvelope(opts: {
  from: string;
  to: string;
  failedMsgId: string;
  error: ExchangeDeliveryErrorVariant;
  humanMessage: string;
  msgId?: string;
  inReplyTo?: string;
  timestamp?: string;
  schemaVersion?: string;
}): ExchangeDeliverErrorEnvelope {
  const envelope: ExchangeDeliverErrorEnvelope = {
    msg_id: opts.msgId ?? `err-${sanitizeId(opts.failedMsgId)}`,
    from: opts.from,
    to: opts.to,
    ts: opts.timestamp ?? new Date().toISOString(),
    schema_version: opts.schemaVersion ?? NANOCLAW_EXCHANGE_SCHEMA_VERSION,
    body: {
      kind: 'deliver.error',
      payload: {
        error: opts.error,
        failed_msg_id: opts.failedMsgId,
        human_message: opts.humanMessage,
      },
    },
  };

  if (opts.inReplyTo !== undefined) {
    envelope.in_reply_to = opts.inReplyTo;
  }

  return envelope;
}

export function bridgeReceiveErrorToDeliveryErrorEnvelope(
  error: Extract<BridgeReceiveResult, { ok: false }>,
  opts: { from: string; to: string; timestamp?: string },
): ExchangeDeliverErrorEnvelope {
  return buildExchangeDeliveryErrorEnvelope({
    from: opts.from,
    to: opts.to,
    failedMsgId: error.failedMsgId,
    error: bridgeErrorVariant(error.error),
    humanMessage: error.message,
    inReplyTo: error.failedMsgId,
    timestamp: opts.timestamp,
  });
}

export function decodeExchangeInboundEnvelope(
  envelope: ExchangeEnvelope,
): BridgeReceiveResult | DecodedExchangeInbound | DecodedExchangeDeliveryFailure {
  if (isDeliverErrorEnvelope(envelope)) {
    return decodeExchangeDeliveryErrorEnvelope(envelope);
  }

  const deliver = envelope.body.payload;
  if (deliver.body_kind !== NANOCLAW_INBOUND_BODY_KIND) {
    return receiveError(
      'unsupported_body_kind',
      envelope.msg_id,
      `unsupported deliver.message body_kind: ${deliver.body_kind}`,
    );
  }

  const payload = normalizePossiblyStringifiedJson(deliver.payload);
  if (!isRecord(payload)) {
    return receiveError('invalid_payload', envelope.msg_id, 'nanoclaw.message_in payload must be an object');
  }

  const session = recordField(payload, 'session');
  const message = recordField(payload, 'message');
  if (!session || !message) {
    return receiveError('invalid_payload', envelope.msg_id, 'payload.session and payload.message are required');
  }

  const agentGroupId = requiredString(session, 'agent_group_id');
  const sessionId = requiredString(session, 'session_id');
  if (!agentGroupId || !sessionId) {
    return receiveError(
      'invalid_payload',
      envelope.msg_id,
      'payload.session must include agent_group_id and session_id',
    );
  }

  if (!Object.prototype.hasOwnProperty.call(message, 'content')) {
    return receiveError('invalid_payload', envelope.msg_id, 'payload.message.content is required');
  }

  const kind = message.kind === undefined ? 'chat' : parseMessageKind(message.kind);
  if (!kind) {
    return receiveError('invalid_payload', envelope.msg_id, 'payload.message.kind is missing or unsupported');
  }

  const destination = recordField(payload, 'destination');
  const trigger = optionalBit(message.trigger, 1);
  const onWake = optionalBit(message.on_wake, 0);
  if (trigger === null || onWake === null) {
    return receiveError('invalid_payload', envelope.msg_id, 'payload.message trigger/on_wake must be 0 or 1');
  }

  return {
    agentGroupId,
    sessionId,
    message: {
      id: optionalString(message.id) ?? `exchange-${sanitizeId(envelope.msg_id)}`,
      kind,
      timestamp: optionalString(message.timestamp) ?? envelope.ts,
      platformId: nullableString(message.platform_id) ?? nullableString(destination?.platform_id) ?? null,
      channelType: nullableString(message.channel_type) ?? nullableString(destination?.channel_type) ?? null,
      threadId: nullableString(message.thread_id) ?? nullableString(destination?.thread_id) ?? null,
      content: contentToDbString(message.content),
      processAfter: nullableString(message.process_after) ?? null,
      recurrence: nullableString(message.recurrence) ?? null,
      trigger,
      sourceSessionId: nullableString(message.source_session_id) ?? null,
      onWake,
    },
    wake: optionalBoolean(payload.wake) ?? trigger === 1,
  };
}

function decodeExchangeDeliveryErrorEnvelope(
  envelope: ExchangeDeliverErrorEnvelope,
): BridgeReceiveResult | DecodedExchangeDeliveryFailure {
  const target = parseNanoclawRuntimeChannelId(envelope.to);
  if (!target) {
    return receiveError(
      'target_mismatch',
      envelope.msg_id,
      `deliver.error target is not a NanoClaw runtime channel: ${envelope.to}`,
    );
  }

  const payload = envelope.body.payload;
  if (
    !isExchangeDeliveryErrorVariant(payload.error) ||
    typeof payload.failed_msg_id !== 'string' ||
    payload.failed_msg_id.length === 0 ||
    typeof payload.human_message !== 'string' ||
    payload.human_message.length === 0
  ) {
    return receiveError('invalid_payload', envelope.msg_id, 'deliver.error payload is invalid');
  }

  return {
    agentGroupId: target.agentGroupId,
    sessionId: target.sessionId,
    deliveryFailure: {
      envelopeMsgId: envelope.msg_id,
      failedMsgId: payload.failed_msg_id,
      error: payload.error,
      humanMessage: payload.human_message,
      reportedAt: envelope.ts,
      ...(envelope.in_reply_to !== undefined ? { inReplyTo: envelope.in_reply_to } : {}),
    },
  };
}

export function createNanoClawExchangeRuntimeBridge(deps: NanoClawExchangeRuntimeDeps): NanoClawExchangeRuntimeBridge {
  return {
    async receiveEnvelope(envelope) {
      const decoded = decodeExchangeInboundEnvelope(envelope);
      if ('ok' in decoded) return decoded;

      if ('deliveryFailure' in decoded) {
        const sessionResult = validateReceiveTarget(deps, decoded.agentGroupId, decoded.sessionId, envelope.msg_id);
        if ('ok' in sessionResult) return sessionResult;

        return {
          ok: true,
          event: 'delivery_failure',
          agentGroupId: decoded.agentGroupId,
          sessionId: decoded.sessionId,
          messageId: decoded.deliveryFailure.envelopeMsgId,
          deliveryFailure: decoded.deliveryFailure,
        };
      }

      const expectedTarget = nanoclawRuntimeChannelId(decoded.agentGroupId, decoded.sessionId);
      if (envelope.to !== expectedTarget) {
        return receiveError(
          'target_mismatch',
          envelope.msg_id,
          `envelope.to ${envelope.to} does not match decoded session target ${expectedTarget}`,
        );
      }

      const sessionResult = validateReceiveTarget(deps, decoded.agentGroupId, decoded.sessionId, envelope.msg_id);
      if ('ok' in sessionResult) return sessionResult;
      const session = sessionResult.session;

      deps.writeSessionMessage(decoded.agentGroupId, decoded.sessionId, decoded.message);

      let woke = false;
      if (decoded.wake) {
        woke = await deps.wakeContainer(session);
      }

      return {
        ok: true,
        event: 'message',
        agentGroupId: decoded.agentGroupId,
        sessionId: decoded.sessionId,
        messageId: decoded.message.id,
        woke,
      };
    },
  };
}

function validateReceiveTarget(
  deps: NanoClawExchangeRuntimeDeps,
  agentGroupId: string,
  sessionId: string,
  failedMsgId: string,
): { session: Session } | Extract<BridgeReceiveResult, { ok: false }> {
  const session = deps.getSession(sessionId);
  if (!session) {
    return receiveError('session_not_found', failedMsgId, `session not found: ${sessionId}`);
  }
  if (session.agent_group_id !== agentGroupId) {
    return receiveError(
      'session_agent_mismatch',
      failedMsgId,
      `session ${sessionId} does not belong to agent group ${agentGroupId}`,
    );
  }

  return { session };
}

export async function receiveExchangeEnvelope(envelope: ExchangeEnvelope): Promise<BridgeReceiveResult> {
  const [{ getSession }, { writeSessionMessage }, { wakeContainer }] = await Promise.all([
    import('../db/sessions.js'),
    import('../session-manager.js'),
    import('../container-runner.js'),
  ]);

  return createNanoClawExchangeRuntimeBridge({
    getSession,
    writeSessionMessage,
    wakeContainer,
  }).receiveEnvelope(envelope);
}

function contentToDbString(content: unknown): string {
  const normalized = normalizePossiblyStringifiedJson(content);
  if (typeof normalized === 'string') {
    return JSON.stringify({ text: normalized });
  }
  if (normalized === undefined) {
    return JSON.stringify({ text: '' });
  }
  return JSON.stringify(normalized);
}

function parseMessageKind(value: unknown): MessageInKind | null {
  if (typeof value !== 'string') return null;
  return MESSAGE_IN_KINDS.includes(value as MessageInKind) ? (value as MessageInKind) : null;
}

function receiveError(
  error: BridgeReceiveErrorCode,
  failedMsgId: string,
  message: string,
): Extract<BridgeReceiveResult, { ok: false }> {
  return { ok: false, error, failedMsgId, message };
}

function bridgeErrorVariant(error: BridgeReceiveErrorCode): ExchangeDeliveryErrorVariant {
  switch (error) {
    case 'session_not_found':
      return 'target_unknown';
    case 'session_agent_mismatch':
    case 'target_mismatch':
      return 'unauthorized';
    case 'unsupported_envelope':
    case 'unsupported_body_kind':
    case 'invalid_payload':
      return 'envelope_invalid';
  }
}

function isDeliverErrorEnvelope(envelope: ExchangeEnvelope): envelope is ExchangeDeliverErrorEnvelope {
  return envelope.body.kind === 'deliver.error';
}

function isExchangeDeliveryErrorVariant(value: unknown): value is ExchangeDeliveryErrorVariant {
  switch (value) {
    case 'target_unknown':
    case 'unauthorized':
    case 'exchange_offline':
    case 'envelope_invalid':
    case 'mailbox_deregistered':
    case 'schema_version_incompatible':
    case 'rate_limited':
      return true;
    default:
      return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function recordField(source: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = source[key];
  return isRecord(value) ? value : null;
}

function requiredString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function nullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (value === undefined) return undefined;
  return typeof value === 'string' ? value : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function optionalBit(value: unknown, fallback: 0 | 1): 0 | 1 | null {
  if (value === undefined) return fallback;
  if (value === 0 || value === 1) return value;
  return null;
}

function sanitizeId(id: string): string {
  return id.replace(/[^A-Za-z0-9_.:-]/g, '_');
}
