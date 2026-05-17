import { buildSystemPromptAddendum } from '../../container/agent-runner/src/destinations.js';
import { createProvider } from '../../container/agent-runner/src/providers/factory.js';
import '../../container/agent-runner/src/providers/index.js';
import { runPollLoop } from '../../container/agent-runner/src/poll-loop.js';

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

const cwd = required('NANOCLAW_E2E_AGENT_CWD');
const model = process.env.NANOCLAW_E2E_MODEL || 'sonnet';
const effort = process.env.NANOCLAW_E2E_EFFORT;
const assistantName = process.env.NANOCLAW_E2E_ASSISTANT_NAME || 'Channel Exchange E2E Agent';

const provider = createProvider('claude', {
  assistantName,
  env: { ...process.env },
  mcpServers: {},
  model,
  effort,
});

const instructions = [
  'This is an automated NanoClaw channel-exchange e2e run.',
  'Complete the user request by sending exactly one NanoClaw destination message. Do not leave the response as scratchpad text.',
  buildSystemPromptAddendum(assistantName),
].join('\n\n');

await runPollLoop({
  provider,
  providerName: 'claude',
  cwd,
  systemContext: { instructions },
});
