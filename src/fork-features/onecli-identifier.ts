/**
 * OneCLI agent identifier transform.
 *
 * Self-hosted OneCLI 1.23.0 enforces a stricter identifier format than the
 * SaaS endpoint nanoclaw was originally written against:
 *
 *   1-50 chars, MUST start with a letter, lowercase letters / numbers /
 *   hyphens only.
 *
 * `agentGroup.id` is a UUID (e.g. `5dec44de-074a-4131-9472-da38f8097438`)
 * which often starts with a digit and gets rejected with HTTP 400. We prefix
 * `ag-` so the value clears the letter-first rule while staying within 50
 * chars (`ag-` + 36-char UUID = 39 chars).
 *
 * `fromOneCLIIdentifier` strips the prefix when the OneCLI approval handler
 * (`src/modules/approvals/onecli-approvals.ts`) needs to reverse-look-up the
 * agent group by id. Identifiers without the prefix pass through untouched
 * so any pre-existing OneCLI-side records still resolve.
 */

const ONECLI_ID_PREFIX = 'ag-';

export function toOneCLIIdentifier(groupId: string): string {
  return `${ONECLI_ID_PREFIX}${groupId}`;
}

export function fromOneCLIIdentifier(identifier: string | null | undefined): string | undefined {
  if (!identifier) return undefined;
  return identifier.startsWith(ONECLI_ID_PREFIX) ? identifier.slice(ONECLI_ID_PREFIX.length) : identifier;
}
