/**
 * NanoClaw Pi-mono Agent Runner
 * Runs inside a container, receives config via stdin, outputs result to stdout.
 * Same protocol as the Claude agent-runner (stdin JSON, stdout markers, file IPC).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  createAgentSession,
  codingTools,
} from '@mariozechner/pi-coding-agent';
import { getModels, getProviders } from '@mariozechner/pi-ai';
import type { Model } from '@mariozechner/pi-ai';
import type { AgentSessionEvent } from '@mariozechner/pi-coding-agent';

import { ContainerInput, writeOutput, readStdin, log } from './protocol.js';
import { shouldClose, drainIpcInput, waitForIpcMessage, IPC_INPUT_DIR } from './ipc.js';
import { McpBridge } from './mcp-bridge.js';
import { createSessionManager, extractSessionId } from './session.js';

const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');

function resolveModel(provider: string, modelId?: string): Model<any> {
  // Map NanoClaw provider names to pi-ai provider names
  const providerMap: Record<string, string> = {
    google: 'google',
    openai: 'openai',
    claude: 'anthropic',
  };

  const piProvider = providerMap[provider] || provider;
  const availableProviders = getProviders();

  if (!availableProviders.includes(piProvider as any)) {
    throw new Error(`Provider "${provider}" (mapped to "${piProvider}") not available. Available: ${availableProviders.join(', ')}`);
  }

  const models = getModels(piProvider as any);
  if (models.length === 0) {
    throw new Error(`No models available for provider "${piProvider}"`);
  }

  if (modelId) {
    const match = models.find(m => m.id === modelId || m.name === modelId);
    if (match) return match;
    log(`Model "${modelId}" not found for ${piProvider}, using default: ${models[0].id}`);
  }

  return models[0];
}

function buildSystemPrompt(input: ContainerInput): string {
  const parts: string[] = [];

  // Load group CLAUDE.md
  const groupClaudeMd = '/workspace/group/CLAUDE.md';
  if (fs.existsSync(groupClaudeMd)) {
    parts.push(fs.readFileSync(groupClaudeMd, 'utf-8'));
  }

  // Load global CLAUDE.md for non-main groups
  const globalClaudeMd = '/workspace/global/CLAUDE.md';
  if (!input.isMain && fs.existsSync(globalClaudeMd)) {
    parts.push(fs.readFileSync(globalClaudeMd, 'utf-8'));
  }

  // Load extra directories CLAUDE.md
  const extraBase = '/workspace/extra';
  if (fs.existsSync(extraBase)) {
    for (const entry of fs.readdirSync(extraBase)) {
      const mdPath = path.join(extraBase, entry, 'CLAUDE.md');
      if (fs.existsSync(mdPath)) {
        parts.push(fs.readFileSync(mdPath, 'utf-8'));
      }
    }
  }

  return parts.join('\n\n---\n\n');
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    try { fs.unlinkSync('/tmp/input.json'); } catch { /* may not exist */ }
    log(`Received input for group: ${containerInput.groupFolder}, provider: ${containerInput.provider}, model: ${containerInput.modelId}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`,
    });
    process.exit(1);
  }

  // Write OAuth credentials to auth.json for Pi-mono SDK
  if (containerInput.oauthCredentials && Object.keys(containerInput.oauthCredentials).length > 0) {
    const authJsonPath = path.join('/workspace/group', 'auth.json');
    fs.writeFileSync(authJsonPath, JSON.stringify(containerInput.oauthCredentials, null, 2));
    delete containerInput.oauthCredentials;
    log('Wrote OAuth credentials to auth.json');
  }

  // Set up API keys in environment for Pi-mono
  const secrets = containerInput.secrets || {};
  for (const [key, value] of Object.entries(secrets)) {
    process.env[key] = value;
  }
  delete containerInput.secrets;

  // Connect MCP bridge
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');
  const mcpBridge = new McpBridge();

  try {
    await mcpBridge.connect({
      mcpServerPath,
      chatJid: containerInput.chatJid,
      groupFolder: containerInput.groupFolder,
      isMain: containerInput.isMain,
      hostMcpServers: containerInput.hostMcpServers,
    });
  } catch (err) {
    log(`MCP bridge connect failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
  try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }

  // Build initial prompt
  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }
  const pending = drainIpcInput();
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    prompt += '\n' + pending.join('\n');
  }

  // Resolve model
  const provider = containerInput.provider || 'google';
  const model = resolveModel(provider, containerInput.modelId);
  log(`Using model: ${model.provider}/${model.id}`);

  // Build system prompt from CLAUDE.md files
  const systemPrompt = buildSystemPrompt(containerInput);

  // Create session manager
  const sessionManager = createSessionManager(containerInput.sessionId);

  // Create agent session with Pi-mono
  const { session } = await createAgentSession({
    sessionManager,
    model,
    tools: codingTools,
    customTools: mcpBridge.getTools(),
    cwd: '/workspace/group',
  });

  // Set system prompt if available
  if (systemPrompt) {
    session.agent.setSystemPrompt(systemPrompt);
  }

  // Subscribe to events for output
  session.subscribe((event: AgentSessionEvent) => {
    if (event.type === 'agent_end') {
      // Extract text from the final assistant messages
      const messages = event.messages || [];
      for (const msg of messages) {
        if (msg.role === 'assistant') {
          const textParts = (msg.content || [])
            .filter((c: any) => c.type === 'text')
            .map((c: any) => c.text);
          const text = textParts.join('');
          if (text) {
            log(`Assistant: ${text.slice(0, 200)}`);
            writeOutput({
              status: 'success',
              result: text,
              newSessionId: extractSessionId(sessionManager),
            });
          }
        }
      }
    }
  });

  // Query loop
  try {
    // Send initial prompt
    log(`Sending initial prompt (${prompt.length} chars)...`);
    await session.prompt(prompt);

    // After initial prompt completes, enter IPC wait loop
    while (true) {
      if (shouldClose()) {
        log('Close sentinel received, exiting');
        break;
      }

      // Emit session update
      writeOutput({
        status: 'success',
        result: null,
        newSessionId: extractSessionId(sessionManager),
      });

      log('Waiting for next IPC message...');
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      log(`Got new message (${nextMessage.length} chars), sending to session`);
      await session.prompt(nextMessage);
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: extractSessionId(sessionManager),
      error: errorMessage,
    });
    process.exit(1);
  } finally {
    await mcpBridge.disconnect();
  }
}

main();
