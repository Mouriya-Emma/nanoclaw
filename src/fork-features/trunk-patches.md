# Tracked trunk patches

Each entry below is a small edit to an upstream file that fork-features cannot fully encapsulate, because upstream lacks a register-style extension point at the call site. At every rebase, walk this list — if upstream has since added a register API or made the concern obsolete, migrate the patch into `fork-features/` or drop it.

Format per entry: file/line, what the patch does, why extraction isn't possible today.

## OneCLI identifier transform (issue Mouriya-Emma/nanoclaw#90)

### `src/container-runner.ts` — call to `toOneCLIIdentifier`

- Patch:
  - Add `import { toOneCLIIdentifier } from './fork-features/onecli-identifier.js';`
  - Change `const agentIdentifier = agentGroup.id;` to `const agentIdentifier = toOneCLIIdentifier(agentGroup.id);`
- Why a patch and not pure fork-features: `agentIdentifier` is a local in `spawnContainer` consumed by `buildContainerArgs(... agentIdentifier)`. Upstream has no hook for "compute the OneCLI identifier from an agent group" — the only call site is this one literal assignment. Extracting would require adding a `getOneCLIIdentifier(group)` extension point upstream.

### `src/modules/approvals/onecli-approvals.ts` — call to `fromOneCLIIdentifier`

- Patch:
  - Add `import { fromOneCLIIdentifier } from '../../fork-features/onecli-identifier.js';`
  - Change `const originGroup = request.agent.externalId ? getAgentGroup(request.agent.externalId) : undefined;` to use `fromOneCLIIdentifier` then `getAgentGroup`.
- Why a patch and not pure fork-features: the reverse-lookup happens inside the manual-approval handler upstream owns. Upstream takes `request.agent.externalId` straight to `getAgentGroup`. Symmetry with the forward-transform patch above; same missing extension point.

## Rebase checklist for these two

When rebasing onto a new upstream version:
1. Has upstream added a `registerOneCLIIdentifierTransform` (or equivalent) extension point? Migrate both patches into a single `fork-features/onecli-identifier.ts` self-registration call and drop these entries.
2. Has upstream changed how `agentGroup.id` is consumed by `ensureAgent` (e.g. moved the transform server-side, switched away from `@onecli-sh/sdk`)? The patches may be obsolete — verify with a smoke test against a self-hosted OneCLI before keeping them.
