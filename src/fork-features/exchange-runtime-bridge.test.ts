import { describe, expect, it } from 'vitest';

import {
  NANOCLAW_EXCHANGE_SCHEMA_VERSION,
  NANOCLAW_INBOUND_BODY_KIND,
  NANOCLAW_OUTBOUND_BODY_KIND,
  bridgeReceiveErrorToDeliveryErrorEnvelope,
  createNanoClawExchangeRuntimeBridge,
  decodeExchangeInboundEnvelope,
  nanoclawRuntimeChannelId,
  projectNanoClawMessageToExchangeEnvelope,
  type ExchangeDeliverMessageEnvelope,
} from './exchange-runtime-bridge.js';
import type { Session } from '../types.js';

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-1',
    agent_group_id: 'ag-1',
    messaging_group_id: 'mg-1',
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: '2026-05-17T15:00:00.000Z',
    ...overrides,
  };
}

function inboundEnvelope(payload: unknown): ExchangeDeliverMessageEnvelope {
  return {
    msg_id: '01KRVBRIDGEINBOUND0000001',
    from: 'exchange/claude-code',
    to: nanoclawRuntimeChannelId('ag-1', 'sess-1'),
    ts: '2026-05-17T15:01:00.000Z',
    schema_version: NANOCLAW_EXCHANGE_SCHEMA_VERSION,
    body: {
      kind: 'deliver.message',
      payload: {
        body_kind: NANOCLAW_INBOUND_BODY_KIND,
        payload,
      },
    },
  };
}

describe('projectNanoClawMessageToExchangeEnvelope', () => {
  it('projects a NanoClaw inbound message into a deliver.message envelope', () => {
    const envelope = projectNanoClawMessageToExchangeEnvelope({
      direction: 'inbound',
      session: { agentGroupId: 'ag-1', sessionId: 'sess-1' },
      message: {
        id: 'msg-in-1',
        kind: 'chat',
        timestamp: '2026-05-17T15:02:00.000Z',
        content: '{"text":"hello"}',
      },
      destination: {
        exchangeChannelId: 'exchange/runtime-target',
        channelType: 'mattermost',
        platformId: 'town-square',
        threadId: 'thread-1',
        localName: 'ops',
      },
    });

    expect(envelope.from).toBe('nanoclaw/ag-1/sess-1');
    expect(envelope.to).toBe('exchange/runtime-target');
    expect(envelope.body.payload.body_kind).toBe(NANOCLAW_INBOUND_BODY_KIND);
    expect(envelope.body.payload.payload).toMatchObject({
      direction: 'inbound',
      session: { agent_group_id: 'ag-1', session_id: 'sess-1' },
      message: { id: 'msg-in-1', kind: 'chat', content: { text: 'hello' } },
      destination: {
        exchange_channel_id: 'exchange/runtime-target',
        channel_type: 'mattermost',
        platform_id: 'town-square',
        thread_id: 'thread-1',
        local_name: 'ops',
      },
    });
  });

  it('projects a NanoClaw outbound message with envelope-level correlation', () => {
    const envelope = projectNanoClawMessageToExchangeEnvelope({
      direction: 'outbound',
      session: { agentGroupId: 'ag-1', sessionId: 'sess-1' },
      message: {
        id: 'msg-out-1',
        kind: 'chat',
        timestamp: '2026-05-17T15:03:00.000Z',
        content: { text: 'pong' },
        inReplyTo: 'msg-in-1',
      },
      destination: {
        exchangeChannelId: 'exchange/claude-code',
        channelType: 'agent',
        platformId: 'ag-2',
        threadId: null,
      },
    });

    expect(envelope.body.payload.body_kind).toBe(NANOCLAW_OUTBOUND_BODY_KIND);
    expect(envelope.in_reply_to).toBe('msg-in-1');
    expect(envelope.body.payload.reply_to_msg_id).toBe('msg-in-1');
    expect(envelope.body.payload.payload).toMatchObject({
      direction: 'outbound',
      message: { id: 'msg-out-1', content: { text: 'pong' } },
      destination: { channel_type: 'agent', platform_id: 'ag-2' },
    });
  });
});

describe('decodeExchangeInboundEnvelope', () => {
  it('normalizes stringified channel.send payload into a NanoClaw inbound write', () => {
    const decoded = decodeExchangeInboundEnvelope(
      inboundEnvelope(
        JSON.stringify({
          session: { agent_group_id: 'ag-1', session_id: 'sess-1' },
          message: {
            id: 'exchange-msg-1',
            kind: 'chat',
            content: JSON.stringify({ text: 'from claude code' }),
            channel_type: 'agent',
            platform_id: 'ag-2',
            source_session_id: 'sess-source',
          },
          wake: false,
        }),
      ),
    );

    expect('ok' in decoded).toBe(false);
    if ('ok' in decoded) return;

    expect(decoded.agentGroupId).toBe('ag-1');
    expect(decoded.sessionId).toBe('sess-1');
    expect(decoded.message).toMatchObject({
      id: 'exchange-msg-1',
      kind: 'chat',
      channelType: 'agent',
      platformId: 'ag-2',
      content: JSON.stringify({ text: 'from claude code' }),
      sourceSessionId: 'sess-source',
    });
    expect(decoded.wake).toBe(false);
  });

  it('defaults exchange replies without an explicit kind to chat', () => {
    const decoded = decodeExchangeInboundEnvelope(
      inboundEnvelope({
        session: { agent_group_id: 'ag-1', session_id: 'sess-1' },
        message: { content: 'plain text fallback' },
      }),
    );

    expect('ok' in decoded).toBe(false);
    if ('ok' in decoded) return;

    expect(decoded.message.kind).toBe('chat');
    expect(decoded.message.content).toBe(JSON.stringify({ text: 'plain text fallback' }));
  });

  it('returns a typed error for unsupported body_kind', () => {
    const result = decodeExchangeInboundEnvelope({
      ...inboundEnvelope({}),
      body: {
        kind: 'deliver.message',
        payload: { body_kind: 'other.runtime', payload: {} },
      },
    });

    expect(result).toMatchObject({
      ok: false,
      error: 'unsupported_body_kind',
      failedMsgId: '01KRVBRIDGEINBOUND0000001',
    });
  });
});

describe('createNanoClawExchangeRuntimeBridge', () => {
  it('hands a decoded exchange envelope to runtime-owned write and wake helpers', async () => {
    const writes: Array<{
      agentGroupId: string;
      sessionId: string;
      message: { id: string; content: string; trigger?: 0 | 1 };
    }> = [];
    const wakes: Session[] = [];

    const bridge = createNanoClawExchangeRuntimeBridge({
      getSession(id) {
        return id === 'sess-1' ? session() : undefined;
      },
      writeSessionMessage(agentGroupId, sessionId, message) {
        writes.push({ agentGroupId, sessionId, message });
      },
      async wakeContainer(s) {
        wakes.push(s);
        return true;
      },
    });

    const result = await bridge.receiveEnvelope(
      inboundEnvelope({
        session: { agent_group_id: 'ag-1', session_id: 'sess-1' },
        message: {
          id: 'exchange-msg-2',
          kind: 'chat',
          content: { text: 'hello runtime' },
          trigger: 1,
        },
      }),
    );

    expect(result).toMatchObject({
      ok: true,
      agentGroupId: 'ag-1',
      sessionId: 'sess-1',
      messageId: 'exchange-msg-2',
      woke: true,
    });
    expect(writes).toEqual([
      {
        agentGroupId: 'ag-1',
        sessionId: 'sess-1',
        message: {
          id: 'exchange-msg-2',
          kind: 'chat',
          timestamp: '2026-05-17T15:01:00.000Z',
          platformId: null,
          channelType: null,
          threadId: null,
          content: JSON.stringify({ text: 'hello runtime' }),
          processAfter: null,
          recurrence: null,
          trigger: 1,
          sourceSessionId: null,
          onWake: 0,
        },
      },
    ]);
    expect(wakes).toHaveLength(1);
  });

  it('rejects an envelope targeting a session owned by another agent group', async () => {
    const bridge = createNanoClawExchangeRuntimeBridge({
      getSession() {
        return session({ agent_group_id: 'ag-other' });
      },
      writeSessionMessage() {
        throw new Error('should not write');
      },
      async wakeContainer() {
        throw new Error('should not wake');
      },
    });

    const result = await bridge.receiveEnvelope(
      inboundEnvelope({
        session: { agent_group_id: 'ag-1', session_id: 'sess-1' },
        message: { kind: 'chat', content: 'plain text fallback' },
      }),
    );

    expect(result).toMatchObject({
      ok: false,
      error: 'session_agent_mismatch',
    });
  });
});

describe('bridgeReceiveErrorToDeliveryErrorEnvelope', () => {
  it('maps runtime receive errors to contract deliver.error envelopes', () => {
    const error = bridgeReceiveErrorToDeliveryErrorEnvelope(
      {
        ok: false,
        error: 'session_not_found',
        failedMsgId: 'missing-target',
        message: 'session not found: sess-missing',
      },
      {
        from: 'nanoclaw/ag-1/sess-1',
        to: 'exchange/claude-code',
        timestamp: '2026-05-17T15:04:00.000Z',
      },
    );

    expect(error).toMatchObject({
      from: 'nanoclaw/ag-1/sess-1',
      to: 'exchange/claude-code',
      in_reply_to: 'missing-target',
      body: {
        kind: 'deliver.error',
        payload: {
          error: 'target_unknown',
          failed_msg_id: 'missing-target',
          human_message: 'session not found: sess-missing',
        },
      },
    });
  });
});
