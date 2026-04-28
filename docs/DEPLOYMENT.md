# Homelab deployment (Mouriya-Emma fork)

This fork (`Mouriya-Emma/nanoclaw`) runs as a managed service on the operator's homelab, not as a personal-laptop install. The core engine and skills are unchanged from upstream `qwibitai/nanoclaw`; what differs is where it lives, who owns its credentials, and how new builds reach it. This doc captures all of that. If you're forking the public `qwibitai/nanoclaw` and following [`README.md`](../README.md) instead, ignore this file.

## Where it runs

NanoClaw runs on **VM 106 (`nanoclaw`)** in the LAN homelab Proxmox host. The VM is declared in [`Mouriya-Emma/homelab-tf`](https://github.com/Mouriya-Emma/homelab-tf) at `workstation/vms/106.yaml`: 4 vCPU / 8 GB / 40 GB root disk on `zpool-single-1t-ssd`, with SR-IOV VF10 as its NIC. No iGPU, no data disks — `dist/` is rsynced fresh on every deploy and SQLite/agent state lives on the root disk.

The hostname on the netbird mesh is `nanoclaw.mouriya.lan` and that's the only address the deploy step targets. The LAN-side DHCP lease (~`192.168.1.21x`) exists too but isn't used in the path; netbird is the single canonical reachability channel between the GitHub Actions runner and this VM.

## Bring-up (one-time, from homelab-tf)

The VM and its base provisioning live on the IaC side, not in this repo. From `~/work/arch_lxc/`:

```
cd workstation && tofu apply              # creates the VM via cloud-init
make vm-provision-nanoclaw                # runs _shared/ansible/nanoclaw.yml
```

The Ansible play applies three roles in order: `debian-vm-base` (apt essentials, qemu-guest-agent), `docker-baseline` (renders `/etc/docker/daemon.json` with LAN-standard DNS at `192.168.1.22` + log rotation; this is a greenfield host so `docker_baseline_restart_on_change: true`), and `nanoclaw` (the role that makes the VM ready to receive deploys).

What the `nanoclaw` role plants on disk:

- Node.js 22 from NodeSource, plus `jq`, `rsync`, `curl`, OpenBao CLI.
- A `deploy` user (uid 1100) in the `docker` group, with the GitHub Actions runner's public key authorized for SSH.
- `/etc/nanoclaw/bao.env` (mode 0600) — holds `BAO_ADDR`, `BAO_TOKEN` (a periodic token scoped to the nanoclaw policy), and `BAO_PATH=nanoclaw/runtime`.
- `/usr/local/bin/nanoclaw-launch.sh` — the launch wrapper.
- `/etc/systemd/system/nanoclaw.service` — the systemd unit, enabled but not yet startable (no `dist/` on disk until the first deploy lands).
- A narrow sudoers entry letting `deploy` run exactly `systemctl restart nanoclaw` without password.

After this play completes, the VM is parked waiting for the first GitHub Actions deploy.

## Code deploys (every push to `main`)

`.github/workflows/deploy.yml` implements **Pattern A** (build on hosted runner, deploy on a netbird-mesh-attached self-hosted runner). The pattern is the same one used across the operator's other private services and is documented in `Mouriya-Emma/local-cicd-demo`.

The build job runs on `ubuntu-latest`, does `npm ci && npm run build`, and uploads four artifacts: `dist/`, `container/`, `scripts/`, and the `package.json` + `package-lock.json` pair. The deploy job runs on `[self-hosted, linux, vctcn]` (the netbird-attached runner sitting in OVH; it can reach `nanoclaw.mouriya.lan` over the mesh, GitHub-hosted runners cannot).

The deploy job:

1. Downloads all four artifacts.
2. Restores the executable bit on `*.sh` and `*.mjs` under `container/` and `scripts/` (GitHub's `actions/download-artifact` strips it).
3. Stages `~/.ssh/id_deploy` from the repo secret `DEPLOY_SSH_KEY` and trusts the host fingerprint via `ssh-keyscan`.
4. Rsyncs `dist/`, `container/`, `scripts/`, and the manifest pair to `deploy@nanoclaw.mouriya.lan:/opt/nanoclaw/`.
5. SSHes into the VM and runs `npm ci --omit=dev --ignore-scripts && npm rebuild better-sqlite3`. The `--ignore-scripts` flag skips husky's `prepare` hook (dev-only), but it also skips `better-sqlite3`'s install hook that builds the native `.node` binding — hence the explicit `npm rebuild` afterwards. Without it, the service crash-loops at boot with `Could not locate the bindings file`.
6. SSHes in again to run `bash container/build.sh`, which (re)builds the agent image on the target. Docker's layer cache makes subsequent builds cheap; the image only fully rebuilds when something in `container/` actually changed.
7. SSHes in a third time to `sudo systemctl restart nanoclaw` and waits up to 30 s for the service to become `active`. Boot can take >3 s on first run because better-sqlite3 opens the on-disk DB and the channel adapters do their initial WebSocket handshakes; the wrapper retries `is-active` every 2 s for up to 15 attempts.

The required repo secret is `DEPLOY_SSH_KEY`: an ed25519 private key whose public counterpart is what the `nanoclaw` role authorizes for the `deploy` user (delivered via `nanoclaw_deploy_ssh_pubkey` in homelab-tf's `_shared/ansible/secrets.yml`). The keypair is operator-managed; rotating means generating a new pair, updating the secret, updating the secrets file, re-running the play.

The deploy workflow has `concurrency: { group: nanoclaw-deploy, cancel-in-progress: false }`. Multiple pushes during a long deploy queue up; the queue collapses if more than one lands, so only the most recent of the queued ones actually runs.

## Runtime

`nanoclaw.service` is a plain systemd unit running as the `deploy` user, with `Restart=always` and `RestartSec=10`. `ProtectSystem=strict` plus `ReadWritePaths=/opt/nanoclaw` confines writes to the install dir; `PrivateTmp=true` gives it its own `/tmp`. It depends on `docker.service` and waits for `network-online.target`.

ExecStart is `/usr/local/bin/nanoclaw-launch.sh`, which is the interesting part: on every start it fetches runtime secrets from OpenBao at `secret/nanoclaw/runtime`, materialises them into `/opt/nanoclaw/.env` (mode 0600), and execs `node dist/index.js`. The KV-v2 path holds three fields:

- `claude_token` — the Anthropic OAuth token (also exported as `ANTHROPIC_AUTH_TOKEN`).
- `mattermost_url` — the homelab Mattermost endpoint nanoclaw reads/writes against.
- `mattermost_bot_token` — the bot account's Personal Access Token.

Why fetch on every start instead of pinning into the unit's `Environment=`: rotating any of these is then "edit the value in OpenBao, `sudo systemctl restart nanoclaw`" — no role re-run, no secret in version control. The launch script also calls `auth/token/renew-self` on the bao token before reading the data path, so the periodic token's lease doesn't expire under a long-lived service.

Why `.env` and not `Environment=`: `src/env.ts:readEnvFile()` reads the `.env` file from `process.cwd()` and intentionally bypasses `process.env`, so child agent containers don't inherit secrets via env. systemd's `EnvironmentFile=` alone wouldn't satisfy that contract.

If `claude_token` is missing or equal to the `PLACEHOLDER_NEEDS_SETUP` sentinel that ships in the bao seed, the wrapper exits non-zero and systemd logs the failure. That's the signal that you've never actually populated bao on a fresh deploy — write the real value with `bao kv put secret/nanoclaw/runtime claude_token=...`.

## Operating it

SSH from the operator laptop is over netbird:

```
ssh deploy@nanoclaw.mouriya.lan          # operator key, not the deploy key
```

The deploy key is for the GitHub Actions runner only; don't authorize it for human use.

Logs live in the journal:

```
sudo journalctl -u nanoclaw -f           # follow the service
sudo journalctl -u nanoclaw --since '1h ago'
```

Restart and confirm it came back:

```
sudo systemctl restart nanoclaw
sudo systemctl is-active nanoclaw        # 'active' once warm
```

Persistent runtime state is under `/opt/nanoclaw/`: `store/` (SQLite DB), `data/`, `groups/<group>/CLAUDE.md`, `logs/`. None of these are inside docker volumes; they're plain directories on the VM root disk. Backups, if/when added, would target this tree.

Triggering a redeploy without a code change:

```
gh workflow run deploy --repo Mouriya-Emma/nanoclaw
```

This is the same path as a `main` push; it picks up whatever is currently on `main`, rebuilds, redeploys, and bounces the service.

## How upstream syncs land

The fork tracks `qwibitai/nanoclaw` as the `upstream` remote. Pulling new upstream changes is a normal `git fetch upstream && git merge upstream/main` against this fork's `main`. Anything channel-specific is on dedicated branches per [`docs/BRANCH-FORK-MAINTENANCE.md`](BRANCH-FORK-MAINTENANCE.md); the deployment story above is independent of upstream merges as long as the artifact layout (`dist/`, `container/`, `scripts/`) stays unchanged. The deploy workflow sits in the fork only — it would never be merged upstream.
