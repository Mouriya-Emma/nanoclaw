/**
 * NanoClaw Pi-mono Agent Runner
 * Runs inside a container, receives config via stdin, outputs result to stdout.
 * Same protocol as the Claude agent-runner (stdin JSON, stdout markers, file IPC).
 */

import fs from 'fs';
import os from 'os';
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
import { createSessionManager, extractSessionId, getSessionDir } from './session.js';

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

  // Write OAuth credentials to the path pi-coding-agent expects (~/.pi/agent/auth.json)
  // AuthStorage requires each credential to have type: "oauth" for OAuth token handling.
  if (containerInput.oauthCredentials && Object.keys(containerInput.oauthCredentials).length > 0) {
    const piAgentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent');
    fs.mkdirSync(piAgentDir, { recursive: true });
    const authJsonPath = path.join(piAgentDir, 'auth.json');
    // Ensure each credential has type: "oauth" so AuthStorage recognizes them
    const authData: Record<string, any> = {};
    for (const [provider, cred] of Object.entries(containerInput.oauthCredentials)) {
      authData[provider] = { type: 'oauth', ...(cred as any) };
    }
    fs.writeFileSync(authJsonPath, JSON.stringify(authData, null, 2));
    delete containerInput.oauthCredentials;
    log(`Wrote OAuth credentials to ${authJsonPath}`);
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

  // Track whether the event handler emitted output for the current prompt
  let promptOutputEmitted = false;

  // Subscribe to events for output
  session.subscribe((event: AgentSessionEvent) => {
    if (event.type === 'agent_end') {
      // Extract text from the final assistant messages
      const messages = event.messages || [];
      for (const msg of messages) {
        if (msg.role === 'assistant') {
          const content = msg.content || [];
          const textParts = content
            .filter((c: any) => c.type === 'text')
            .map((c: any) => c.text);
          let text = textParts.join('');

          // Fallback: check msg.text directly (some providers structure differently)
          if (!text && (msg as any).text) {
            text = (msg as any).text;
          }

          if (text) {
            log(`Assistant: ${text.slice(0, 200)}`);
            writeOutput({
              status: 'success',
              result: text,
              newSessionId: extractSessionId(sessionManager),
            });
            promptOutputEmitted = true;
          }
        }
      }
    }
  });

  /**
   * Fallback: read session JSONL file to get the last assistant message.
   * Returns { text, error } — text if found, error message if all responses were errors.
   */
  function getLastAssistantFromSession(): { text: string | null; error: string | null } {
    try {
      const sessDir = getSessionDir();
      const sessionId = extractSessionId(sessionManager);
      if (!sessionId) return { text: null, error: null };

      // Find the session file (may be timestamp-prefixed)
      let sessionFile = path.join(sessDir, `${sessionId}.jsonl`);
      if (!fs.existsSync(sessionFile)) {
        const match = fs.readdirSync(sessDir).find(f => f.endsWith(`_${sessionId}.jsonl`));
        if (match) sessionFile = path.join(sessDir, match);
        else return { text: null, error: null };
      }

      const lines = fs.readFileSync(sessionFile, 'utf-8').split('\n').filter(l => l.trim());
      // Walk backwards to find last assistant message
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const record = JSON.parse(lines[i]);
          const msg = record.message || record;
          if (msg.role === 'assistant') {
            // Check for text content
            const content = Array.isArray(msg.content) ? msg.content : [];
            const text = content
              .filter((c: any) => c.type === 'text')
              .map((c: any) => c.text)
              .join('');
            if (text) return { text, error: null };
            // Check for error
            if (msg.errorMessage) return { text: null, error: msg.errorMessage };
          }
        } catch { /* skip malformed lines */ }
      }
    } catch (err) {
      log(`Session file fallback error: ${err instanceof Error ? err.message : String(err)}`);
    }
    return { text: null, error: null };
  }

  /**
   * Run a prompt and ensure output is emitted.
   * Falls back to reading the session file if the event handler didn't capture output.
   */
  async function runPrompt(text: string): Promise<void> {
    promptOutputEmitted = false;
    await session.prompt(text);
    if (!promptOutputEmitted) {
      log('Event handler did not emit output, trying session file fallback...');
      const { text: fallbackText, error } = getLastAssistantFromSession();
      if (fallbackText) {
        log(`Fallback assistant: ${fallbackText.slice(0, 200)}`);
        writeOutput({
          status: 'success',
          result: fallbackText,
          newSessionId: extractSessionId(sessionManager),
        });
        promptOutputEmitted = true;
      } else if (error) {
        log(`API error: ${error}`);
        writeOutput({
          status: 'error',
          result: null,
          newSessionId: extractSessionId(sessionManager),
          error,
        });
      } else {
        log('No assistant text found in session file either');
      }
    }
  }

  // Query loop
  try {
    // Send initial prompt
    log(`Sending initial prompt (${prompt.length} chars)...`);
    await runPrompt(prompt);

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
      await runPrompt(nextMessage);
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
