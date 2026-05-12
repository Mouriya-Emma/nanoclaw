## Extension points missing from v2 baseline

These are the upstream surfaces that would need a micro-PR (or a manual patch
in the fork merge) to make the fork's pi-mono and credential-proxy features
land entirely in `src/fork-features/` without trunk edits beyond a single
`import './fork-features/index.js';` line.

### 1. ProviderContainerContribution.image — swap container image per provider

`src/providers/provider-container-registry.ts:34-39` only allows mounts + env.
The fork's pi-mono needs a different runner image (`nanoclaw-pi:latest` vs
`nanoclaw-agent:latest`). v2 has `containerConfig.imageTag` per agent group,
but it is keyed on group, not provider. Today `container-runner.ts:459` reads:

```
const imageTag = containerConfig.imageTag || CONTAINER_IMAGE;
```

Adding `image?: string` to `ProviderContainerContribution` plus a 1-line
override in `buildContainerArgs` (`const imageTag = providerContribution.image
?? containerConfig.imageTag ?? CONTAINER_IMAGE`) would unlock fork's
single-line image swap.

### 2. ProviderContainerContribution.entrypoint — alternate runner command

`container-runner.ts:455-462` hardcodes `--entrypoint bash` and `exec bun run
/app/src/index.ts`. Fork's pi-runner image needs a different entrypoint.
Same shape: add `entrypoint?: string[]` to ProviderContainerContribution.

### 3. registerCommand for command-gate

`src/command-gate.ts:14-15` declares two static `Set`s of command names
(filtered + admin). Fork's `/pi`, `/cla`, `/ask`, `/setmodel` slash commands
have no register API. Adding:

```
export function registerFilteredCommand(cmd: string): void;
export function registerAdminCommand(cmd: string): void;
```

…would let fork-features enroll its commands at import time. As-is, only
trunk patches to `command-gate.ts` work.

### 4. registerMigration for db/migrations/index.ts

The migrations array is static (`src/db/migrations/index.ts:24-38`), even
though the comment at line 51-55 explicitly endorses "module migrations
added later by install skills." Fork could provide a clean migration via
`registerMigration(m)`. The schema_version unique-name design already
supports the spec; only the array push is missing.

Workaround used in this spike: lazy `ensureForkSchema()` on first accessor
call, with `fork_*` table prefix. Loses the schema_version audit row but
otherwise works.

### 5. removeOneCLIRequirement / makeOneCLIOptional

`container-runner.ts:430-433` throws unconditionally if OneCLI doesn't apply
its container config. Fork's `/use-native-credential-proxy` skill replaces
the gateway entirely; with the throw in place, the fork must patch at least
that block to fall back to the credential proxy.

A clean fix: factor the gateway into a `CredentialGateway` interface with
`onecliGateway` as the default impl and a `setCredentialGateway()` register
API so fork-features can swap in its native proxy.

### 6. registerHostExecAllowlist + host-exec wrapper

The host-exec proxy (container reaches host CLIs via HTTP) has no v2
analogue. Fork ships:
   - `src/mcp-proxy.ts` — HTTP `POST /exec` endpoint with allowlist gate
   - `container/host-exec.mjs` — wrapper script written into containers
   - PATH injection in `container-runner.ts`

Of these, only the wrapper-mount + PATH injection need trunk edits.
container-runner.ts would need to accept extra `mounts:` and `env:PATH`
overrides at startup time. Provider-config.env already supports PATH, but
mounts that are not per-session (the wrapper script is shared across
spawns) belong in a different scope. Could be modelled as
"global container hooks" registered once at startup.
