/**
 * Step: service — Generate and load service manager config.
 * Replaces 08-setup-service.sh
 *
 * Fixes: Root→system systemd, WSL nohup fallback, no `|| true` swallowing errors.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { logger } from '../src/logger.js';
import {
  getPlatform,
  getNodePath,
  getServiceManager,
  hasSystemd,
  isRoot,
  isWSL,
} from './platform.js';
import { emitStatus } from './status.js';

export interface ServiceFlags {
  mode: 'full' | 'rehydrate';
  preserveUnit: boolean;
  noKill: boolean;
  skipIfRunning: boolean;
}

// Rehydrate mode is used when the CT is rebuilt but the application state
// (unit files, running service, on-disk groups) survives on a bind mount.
// See issue #2 (Mouriya-Emma/nanoclaw) and homelab-tf#63/#64.
export function parseServiceArgs(args: string[]): ServiceFlags {
  let mode: 'full' | 'rehydrate' = 'full';
  let preserveUnit = false;
  let noKill = false;
  let skipIfRunning = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--mode' && args[i + 1]) {
      const v = args[i + 1];
      if (v === 'rehydrate' || v === 'full') {
        mode = v;
      }
      i++;
    } else if (a.startsWith('--mode=')) {
      const v = a.slice('--mode='.length);
      if (v === 'rehydrate' || v === 'full') {
        mode = v;
      }
    } else if (a === '--preserve-unit') {
      preserveUnit = true;
    } else if (a === '--no-kill') {
      noKill = true;
    } else if (a === '--skip-if-running') {
      skipIfRunning = true;
    }
  }

  if (mode === 'rehydrate') {
    preserveUnit = true;
    noKill = true;
    skipIfRunning = true;
  }

  return { mode, preserveUnit, noKill, skipIfRunning };
}

// Write a unit/plist file, honoring --preserve-unit semantics.
// Returns what was done so the caller can emit accurate status.
export function writeUnitFileIfNeeded(
  unitPath: string,
  content: string,
  flags: ServiceFlags,
): { written: boolean; preservedExisting: boolean } {
  const exists = fs.existsSync(unitPath);
  if (flags.preserveUnit && exists) {
    return { written: false, preservedExisting: true };
  }
  fs.writeFileSync(unitPath, content);
  return { written: true, preservedExisting: false };
}

export async function run(args: string[]): Promise<void> {
  const projectRoot = process.cwd();
  const platform = getPlatform();
  const nodePath = getNodePath();
  const homeDir = os.homedir();
  const flags = parseServiceArgs(args);

  logger.info(
    { platform, nodePath, projectRoot, flags },
    'Setting up service',
  );

  // Build first
  logger.info('Building TypeScript');
  try {
    execSync('npm run build', {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    logger.info('Build succeeded');
  } catch {
    logger.error('Build failed');
    emitStatus('SETUP_SERVICE', {
      SERVICE_TYPE: 'unknown',
      NODE_PATH: nodePath,
      PROJECT_PATH: projectRoot,
      STATUS: 'failed',
      ERROR: 'build_failed',
      LOG: 'logs/setup.log',
    });
    process.exit(1);
  }

  fs.mkdirSync(path.join(projectRoot, 'logs'), { recursive: true });

  if (platform === 'macos') {
    setupLaunchd(projectRoot, nodePath, homeDir, flags);
  } else if (platform === 'linux') {
    setupLinux(projectRoot, nodePath, homeDir, flags);
  } else {
    emitStatus('SETUP_SERVICE', {
      SERVICE_TYPE: 'unknown',
      NODE_PATH: nodePath,
      PROJECT_PATH: projectRoot,
      STATUS: 'failed',
      ERROR: 'unsupported_platform',
      LOG: 'logs/setup.log',
    });
    process.exit(1);
  }
}

function setupLaunchd(
  projectRoot: string,
  nodePath: string,
  homeDir: string,
  flags: ServiceFlags,
): void {
  const plistPath = path.join(
    homeDir,
    'Library',
    'LaunchAgents',
    'com.nanoclaw.plist',
  );
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
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

  const plistResult = writeUnitFileIfNeeded(plistPath, plist, flags);
  if (plistResult.preservedExisting) {
    logger.info(
      { plistPath },
      'Preserving existing launchd plist (rehydrate mode)',
    );
  } else {
    logger.info({ plistPath }, 'Wrote launchd plist');
  }

  // Check if already loaded before deciding whether to load
  let alreadyLoaded = false;
  try {
    const output = execSync('launchctl list', { encoding: 'utf-8' });
    alreadyLoaded = output.includes('com.nanoclaw');
  } catch {
    // launchctl list failed — treat as not loaded
  }

  if (flags.skipIfRunning && alreadyLoaded) {
    logger.info('launchd service already loaded — skipping load (rehydrate mode)');
  } else {
    try {
      execSync(`launchctl load ${JSON.stringify(plistPath)}`, {
        stdio: 'ignore',
      });
      logger.info('launchctl load succeeded');
    } catch {
      logger.warn('launchctl load failed (may already be loaded)');
    }
  }

  // Verify
  let serviceLoaded = alreadyLoaded;
  try {
    const output = execSync('launchctl list', { encoding: 'utf-8' });
    serviceLoaded = output.includes('com.nanoclaw');
  } catch {
    // launchctl list failed
  }

  emitStatus('SETUP_SERVICE', {
    SERVICE_TYPE: 'launchd',
    NODE_PATH: nodePath,
    PROJECT_PATH: projectRoot,
    PLIST_PATH: plistPath,
    SERVICE_LOADED: serviceLoaded,
    MODE: flags.mode,
    PLIST_PRESERVED: plistResult.preservedExisting,
    STATUS: 'success',
    LOG: 'logs/setup.log',
  });
}

function setupLinux(
  projectRoot: string,
  nodePath: string,
  homeDir: string,
  flags: ServiceFlags,
): void {
  const serviceManager = getServiceManager();

  if (serviceManager === 'systemd') {
    setupSystemd(projectRoot, nodePath, homeDir, flags);
  } else {
    // WSL without systemd or other Linux without systemd
    setupNohupFallback(projectRoot, nodePath, homeDir, flags);
  }
}

/**
 * Kill any orphaned nanoclaw node processes left from previous runs or debugging.
 * Prevents connection conflicts when two instances connect to the same channel simultaneously.
 */
function killOrphanedProcesses(projectRoot: string): void {
  try {
    execSync(`pkill -f '${projectRoot}/dist/index\\.js' || true`, {
      stdio: 'ignore',
    });
    logger.info('Stopped any orphaned nanoclaw processes');
  } catch {
    // pkill not available or no orphans
  }
}

/**
 * Detect stale docker group membership in the user systemd session.
 *
 * When a user is added to the docker group mid-session, the user systemd
 * daemon (user@UID.service) keeps the old group list from login time.
 * Docker works in the terminal but not in the service context.
 *
 * Only relevant on Linux with user-level systemd (not root, not macOS, not WSL nohup).
 */
function checkDockerGroupStale(): boolean {
  try {
    execSync('systemd-run --user --pipe --wait docker info', {
      stdio: 'pipe',
      timeout: 10000,
    });
    return false; // Docker works from systemd session
  } catch {
    // Check if docker works from the current shell (to distinguish stale group vs broken docker)
    try {
      execSync('docker info', { stdio: 'pipe', timeout: 5000 });
      return true; // Works in shell but not systemd session → stale group
    } catch {
      return false; // Docker itself is not working, different issue
    }
  }
}

function setupSystemd(
  projectRoot: string,
  nodePath: string,
  homeDir: string,
  flags: ServiceFlags,
): void {
  const runningAsRoot = isRoot();

  // Root uses system-level service, non-root uses user-level
  let unitPath: string;
  let systemctlPrefix: string;

  if (runningAsRoot) {
    unitPath = '/etc/systemd/system/nanoclaw.service';
    systemctlPrefix = 'systemctl';
    logger.info('Running as root — installing system-level systemd unit');
  } else {
    // Check if user-level systemd session is available
    try {
      execSync('systemctl --user daemon-reload', { stdio: 'pipe' });
    } catch {
      logger.warn(
        'systemd user session not available — falling back to nohup wrapper',
      );
      setupNohupFallback(projectRoot, nodePath, homeDir, flags);
      return;
    }
    const unitDir = path.join(homeDir, '.config', 'systemd', 'user');
    fs.mkdirSync(unitDir, { recursive: true });
    unitPath = path.join(unitDir, 'nanoclaw.service');
    systemctlPrefix = 'systemctl --user';
  }

  const unit = `[Unit]
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
WantedBy=${runningAsRoot ? 'multi-user.target' : 'default.target'}`;

  const unitResult = writeUnitFileIfNeeded(unitPath, unit, flags);
  if (unitResult.preservedExisting) {
    logger.info(
      { unitPath },
      'Preserving existing systemd unit (rehydrate mode)',
    );
  } else {
    logger.info({ unitPath }, 'Wrote systemd unit');
  }

  // Detect stale docker group before starting (user systemd only)
  const dockerGroupStale = !runningAsRoot && checkDockerGroupStale();
  if (dockerGroupStale) {
    logger.warn(
      'Docker group not active in systemd session — user was likely added to docker group mid-session',
    );
  }

  // Kill orphaned nanoclaw processes to avoid channel connection conflicts.
  // In rehydrate mode, skip — we want to preserve the running service across
  // a CT rebuild or a follow-up `/setup` run for other steps.
  if (flags.noKill) {
    logger.info('Skipping orphan process kill (rehydrate mode)');
  } else {
    killOrphanedProcesses(projectRoot);
  }

  // Enable lingering so the user service survives SSH logout.
  // Without linger, systemd terminates all user processes when the last session closes.
  if (!runningAsRoot) {
    try {
      execSync('loginctl enable-linger', { stdio: 'ignore' });
      logger.info('Enabled loginctl linger for current user');
    } catch (err) {
      logger.warn(
        { err },
        'loginctl enable-linger failed — service may stop on SSH logout',
      );
    }
  }

  // daemon-reload is always safe and needed if unit was written
  try {
    execSync(`${systemctlPrefix} daemon-reload`, { stdio: 'ignore' });
  } catch (err) {
    logger.error({ err }, 'systemctl daemon-reload failed');
  }

  try {
    execSync(`${systemctlPrefix} enable nanoclaw`, { stdio: 'ignore' });
  } catch (err) {
    logger.error({ err }, 'systemctl enable failed');
  }

  // Check if already active before starting
  let alreadyActive = false;
  try {
    execSync(`${systemctlPrefix} is-active nanoclaw`, { stdio: 'ignore' });
    alreadyActive = true;
  } catch {
    // Not active
  }

  if (flags.skipIfRunning && alreadyActive) {
    logger.info('systemd service already active — skipping start (rehydrate mode)');
  } else {
    try {
      execSync(`${systemctlPrefix} start nanoclaw`, { stdio: 'ignore' });
    } catch (err) {
      logger.error({ err }, 'systemctl start failed');
    }
  }

  // Verify (re-check; start may have just happened)
  let serviceLoaded = alreadyActive;
  try {
    execSync(`${systemctlPrefix} is-active nanoclaw`, { stdio: 'ignore' });
    serviceLoaded = true;
  } catch {
    // Not active
  }

  emitStatus('SETUP_SERVICE', {
    SERVICE_TYPE: runningAsRoot ? 'systemd-system' : 'systemd-user',
    NODE_PATH: nodePath,
    PROJECT_PATH: projectRoot,
    UNIT_PATH: unitPath,
    SERVICE_LOADED: serviceLoaded,
    ...(dockerGroupStale ? { DOCKER_GROUP_STALE: true } : {}),
    LINGER_ENABLED: !runningAsRoot,
    MODE: flags.mode,
    UNIT_PRESERVED: unitResult.preservedExisting,
    STATUS: 'success',
    LOG: 'logs/setup.log',
  });
}

function setupNohupFallback(
  projectRoot: string,
  nodePath: string,
  homeDir: string,
): void {
  logger.warn('No systemd detected — generating nohup wrapper script');

  const wrapperPath = path.join(projectRoot, 'start-nanoclaw.sh');
  const pidFile = path.join(projectRoot, 'nanoclaw.pid');

  const lines = [
    '#!/bin/bash',
    '# start-nanoclaw.sh — Start NanoClaw without systemd',
    `# To stop: kill \\$(cat ${pidFile})`,
    '',
    'set -euo pipefail',
    '',
    `cd ${JSON.stringify(projectRoot)}`,
    '',
    '# Stop existing instance if running',
    `if [ -f ${JSON.stringify(pidFile)} ]; then`,
    `  OLD_PID=$(cat ${JSON.stringify(pidFile)} 2>/dev/null || echo "")`,
    '  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then',
    '    echo "Stopping existing NanoClaw (PID $OLD_PID)..."',
    '    kill "$OLD_PID" 2>/dev/null || true',
    '    sleep 2',
    '  fi',
    'fi',
    '',
    'echo "Starting NanoClaw..."',
    `nohup ${JSON.stringify(nodePath)} ${JSON.stringify(projectRoot + '/dist/index.js')} \\`,
    `  >> ${JSON.stringify(projectRoot + '/logs/nanoclaw.log')} \\`,
    `  2>> ${JSON.stringify(projectRoot + '/logs/nanoclaw.error.log')} &`,
    '',
    `echo $! > ${JSON.stringify(pidFile)}`,
    'echo "NanoClaw started (PID $!)"',
    `echo "Logs: tail -f ${projectRoot}/logs/nanoclaw.log"`,
  ];
  const wrapper = lines.join('\n') + '\n';

  fs.writeFileSync(wrapperPath, wrapper, { mode: 0o755 });
  logger.info({ wrapperPath }, 'Wrote nohup wrapper script');

  emitStatus('SETUP_SERVICE', {
    SERVICE_TYPE: 'nohup',
    NODE_PATH: nodePath,
    PROJECT_PATH: projectRoot,
    WRAPPER_PATH: wrapperPath,
    SERVICE_LOADED: false,
    FALLBACK: 'wsl_no_systemd',
    STATUS: 'success',
    LOG: 'logs/setup.log',
  });
}
