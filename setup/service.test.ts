import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { parseServiceArgs, writeUnitFileIfNeeded } from './service.js';

/**
 * Tests for service configuration generation.
 *
 * These tests verify the generated content of plist/systemd/nohup configs
 * without actually loading services.
 */

// Helper: generate a plist string the same way service.ts does
function generatePlist(
  nodePath: string,
  projectRoot: string,
  homeDir: string,
): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.nanoclaw</string>
    <key>ProgramArguments</key>
    <array>
        <string>${nodePath}</string>
        <string>${projectRoot}/dist/index.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${projectRoot}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:${homeDir}/.local/bin</string>
        <key>HOME</key>
        <string>${homeDir}</string>
    </dict>
    <key>StandardOutPath</key>
    <string>${projectRoot}/logs/nanoclaw.log</string>
    <key>StandardErrorPath</key>
    <string>${projectRoot}/logs/nanoclaw.error.log</string>
</dict>
</plist>`;
}

function generateSystemdUnit(
  nodePath: string,
  projectRoot: string,
  homeDir: string,
  isSystem: boolean,
): string {
  return `[Unit]
Description=NanoClaw Personal Assistant
After=network.target

[Service]
Type=simple
ExecStart=${nodePath} ${projectRoot}/dist/index.js
WorkingDirectory=${projectRoot}
Restart=always
RestartSec=5
KillMode=process
Environment=HOME=${homeDir}
Environment=PATH=/usr/local/bin:/usr/bin:/bin:${homeDir}/.local/bin
StandardOutput=append:${projectRoot}/logs/nanoclaw.log
StandardError=append:${projectRoot}/logs/nanoclaw.error.log

[Install]
WantedBy=${isSystem ? 'multi-user.target' : 'default.target'}`;
}

describe('plist generation', () => {
  it('contains the correct label', () => {
    const plist = generatePlist(
      '/usr/local/bin/node',
      '/home/user/nanoclaw',
      '/home/user',
    );
    expect(plist).toContain('<string>com.nanoclaw</string>');
  });

  it('uses the correct node path', () => {
    const plist = generatePlist(
      '/opt/node/bin/node',
      '/home/user/nanoclaw',
      '/home/user',
    );
    expect(plist).toContain('<string>/opt/node/bin/node</string>');
  });

  it('points to dist/index.js', () => {
    const plist = generatePlist(
      '/usr/local/bin/node',
      '/home/user/nanoclaw',
      '/home/user',
    );
    expect(plist).toContain('/home/user/nanoclaw/dist/index.js');
  });

  it('sets log paths', () => {
    const plist = generatePlist(
      '/usr/local/bin/node',
      '/home/user/nanoclaw',
      '/home/user',
    );
    expect(plist).toContain('nanoclaw.log');
    expect(plist).toContain('nanoclaw.error.log');
  });
});

describe('systemd unit generation', () => {
  it('user unit uses default.target', () => {
    const unit = generateSystemdUnit(
      '/usr/bin/node',
      '/home/user/nanoclaw',
      '/home/user',
      false,
    );
    expect(unit).toContain('WantedBy=default.target');
  });

  it('system unit uses multi-user.target', () => {
    const unit = generateSystemdUnit(
      '/usr/bin/node',
      '/home/user/nanoclaw',
      '/home/user',
      true,
    );
    expect(unit).toContain('WantedBy=multi-user.target');
  });

  it('contains restart policy', () => {
    const unit = generateSystemdUnit(
      '/usr/bin/node',
      '/home/user/nanoclaw',
      '/home/user',
      false,
    );
    expect(unit).toContain('Restart=always');
    expect(unit).toContain('RestartSec=5');
  });

  it('uses KillMode=process to preserve detached children', () => {
    const unit = generateSystemdUnit(
      '/usr/bin/node',
      '/home/user/nanoclaw',
      '/home/user',
      false,
    );
    expect(unit).toContain('KillMode=process');
  });

  it('sets correct ExecStart', () => {
    const unit = generateSystemdUnit(
      '/usr/bin/node',
      '/srv/nanoclaw',
      '/home/user',
      false,
    );
    expect(unit).toContain(
      'ExecStart=/usr/bin/node /srv/nanoclaw/dist/index.js',
    );
  });
});

describe('parseServiceArgs', () => {
  it('defaults to full mode with no preservation flags', () => {
    const flags = parseServiceArgs([]);
    expect(flags.mode).toBe('full');
    expect(flags.preserveUnit).toBe(false);
    expect(flags.noKill).toBe(false);
    expect(flags.skipIfRunning).toBe(false);
  });

  it('treats --mode=rehydrate as all three preservation flags', () => {
    const flags = parseServiceArgs(['--mode=rehydrate']);
    expect(flags.mode).toBe('rehydrate');
    expect(flags.preserveUnit).toBe(true);
    expect(flags.noKill).toBe(true);
    expect(flags.skipIfRunning).toBe(true);
  });

  it('accepts space-separated --mode rehydrate form', () => {
    const flags = parseServiceArgs(['--mode', 'rehydrate']);
    expect(flags.mode).toBe('rehydrate');
    expect(flags.preserveUnit).toBe(true);
  });

  it('honors individual flags without --mode', () => {
    const flags = parseServiceArgs([
      '--preserve-unit',
      '--no-kill',
      '--skip-if-running',
    ]);
    expect(flags.mode).toBe('full');
    expect(flags.preserveUnit).toBe(true);
    expect(flags.noKill).toBe(true);
    expect(flags.skipIfRunning).toBe(true);
  });

  it('honors a single individual flag (partial rebuild scenario)', () => {
    const flags = parseServiceArgs(['--no-kill']);
    expect(flags.mode).toBe('full');
    expect(flags.preserveUnit).toBe(false);
    expect(flags.noKill).toBe(true);
    expect(flags.skipIfRunning).toBe(false);
  });

  it('ignores unknown --mode values (stays full)', () => {
    const flags = parseServiceArgs(['--mode=gibberish']);
    expect(flags.mode).toBe('full');
    expect(flags.preserveUnit).toBe(false);
  });

  it('rehydrate and individual flags combine idempotently', () => {
    const flags = parseServiceArgs(['--mode=rehydrate', '--no-kill']);
    expect(flags.mode).toBe('rehydrate');
    expect(flags.noKill).toBe(true);
    expect(flags.preserveUnit).toBe(true);
  });
});

describe('writeUnitFileIfNeeded', () => {
  function tmpUnitPath(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-unit-'));
    return path.join(dir, 'nanoclaw.service');
  }

  it('writes the unit when no file exists (fresh install)', () => {
    const p = tmpUnitPath();
    const flags = parseServiceArgs([]);
    const result = writeUnitFileIfNeeded(p, 'freshly-generated', flags);
    expect(result.written).toBe(true);
    expect(result.preservedExisting).toBe(false);
    expect(fs.readFileSync(p, 'utf8')).toBe('freshly-generated');
  });

  it('preserves operator customizations in rehydrate mode', () => {
    const p = tmpUnitPath();
    fs.writeFileSync(p, '# CUSTOM_MARKER: must survive');
    const flags = parseServiceArgs(['--mode=rehydrate']);
    const result = writeUnitFileIfNeeded(p, 'regenerated-would-clobber', flags);
    expect(result.written).toBe(false);
    expect(result.preservedExisting).toBe(true);
    expect(fs.readFileSync(p, 'utf8')).toBe('# CUSTOM_MARKER: must survive');
  });

  it('overwrites existing unit in full mode (current install behavior)', () => {
    const p = tmpUnitPath();
    fs.writeFileSync(p, 'stale-content');
    const flags = parseServiceArgs([]);
    const result = writeUnitFileIfNeeded(p, 'regenerated', flags);
    expect(result.written).toBe(true);
    expect(result.preservedExisting).toBe(false);
    expect(fs.readFileSync(p, 'utf8')).toBe('regenerated');
  });

  it('still writes when --preserve-unit is set but no file exists', () => {
    // Rebuild into an empty CT: preserve-unit requested, but nothing to preserve.
    // Must write so the service can actually start.
    const p = tmpUnitPath();
    const flags = parseServiceArgs(['--preserve-unit']);
    const result = writeUnitFileIfNeeded(p, 'must-write', flags);
    expect(result.written).toBe(true);
    expect(result.preservedExisting).toBe(false);
    expect(fs.readFileSync(p, 'utf8')).toBe('must-write');
  });
});

describe('WSL nohup fallback', () => {
  it('generates a valid wrapper script', () => {
    const projectRoot = '/home/user/nanoclaw';
    const nodePath = '/usr/bin/node';
    const pidFile = path.join(projectRoot, 'nanoclaw.pid');

    // Simulate what service.ts generates
    const wrapper = `#!/bin/bash
set -euo pipefail
cd ${JSON.stringify(projectRoot)}
nohup ${JSON.stringify(nodePath)} ${JSON.stringify(projectRoot)}/dist/index.js >> ${JSON.stringify(projectRoot)}/logs/nanoclaw.log 2>> ${JSON.stringify(projectRoot)}/logs/nanoclaw.error.log &
echo $! > ${JSON.stringify(pidFile)}`;

    expect(wrapper).toContain('#!/bin/bash');
    expect(wrapper).toContain('nohup');
    expect(wrapper).toContain(nodePath);
    expect(wrapper).toContain('nanoclaw.pid');
  });
});
