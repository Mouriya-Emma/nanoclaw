#!/usr/bin/env node
/**
 * Host command execution proxy stub.
 * Runs inside the container, forwards CLI invocations to the host's
 * NanoClaw proxy server via HTTP. Wrapper scripts in /opt/host-exec/bin/
 * call this with the command name as the first argument.
 *
 * Usage: node /opt/host-exec/proxy.mjs <command> [args...]
 */
import http from 'node:http';

const command = process.argv[2];
const args = process.argv.slice(3);

if (!command) {
  process.stderr.write('host-exec: missing command name\n');
  process.exit(127);
}

// Read stdin if piped (non-TTY)
let stdinData = '';
const stdinReady = process.stdin.isTTY
  ? Promise.resolve()
  : new Promise((resolve) => {
      process.stdin.setEncoding('utf-8');
      process.stdin.on('data', (chunk) => { stdinData += chunk; });
      process.stdin.on('end', resolve);
      // If stdin closes immediately (no data), resolve quickly
      setTimeout(resolve, 100);
    });

stdinReady.then(() => {
  const body = JSON.stringify({
    command,
    args,
    ...(stdinData ? { stdin: stdinData } : {}),
  });

  const port = parseInt(process.env.HOST_EXEC_PORT || '18321', 10);

  const req = http.request(
    {
      hostname: 'host.docker.internal',
      port,
      path: '/exec',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 120_000,
    },
    (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (result.stdout) process.stdout.write(result.stdout);
          if (result.stderr) process.stderr.write(result.stderr);
          process.exit(result.exitCode ?? 1);
        } catch {
          process.stderr.write(`host-exec: invalid response: ${data}\n`);
          process.exit(1);
        }
      });
    },
  );

  req.on('timeout', () => {
    process.stderr.write('host-exec: request timed out\n');
    req.destroy();
    process.exit(124);
  });

  req.on('error', (err) => {
    process.stderr.write(`host-exec: ${err.message}\n`);
    process.exit(127);
  });

  req.write(body);
  req.end();
});
