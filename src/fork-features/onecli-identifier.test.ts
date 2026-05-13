import { describe, expect, it } from 'vitest';

import { fromOneCLIIdentifier, toOneCLIIdentifier } from './onecli-identifier.js';

describe('toOneCLIIdentifier', () => {
  it('prefixes a UUID that starts with a digit so OneCLI letter-first rule passes', () => {
    expect(toOneCLIIdentifier('5dec44de-074a-4131-9472-da38f8097438')).toBe('ag-5dec44de-074a-4131-9472-da38f8097438');
  });

  it('prefixes a UUID that starts with a letter (uniformity, not branching by content)', () => {
    expect(toOneCLIIdentifier('abc44de2-074a-4131-9472-da38f8097438')).toBe('ag-abc44de2-074a-4131-9472-da38f8097438');
  });

  it('produces a string within OneCLI 1-50 char limit for a standard UUID input', () => {
    const out = toOneCLIIdentifier('5dec44de-074a-4131-9472-da38f8097438');
    expect(out.length).toBeGreaterThanOrEqual(1);
    expect(out.length).toBeLessThanOrEqual(50);
  });
});

describe('fromOneCLIIdentifier', () => {
  it('strips the ag- prefix to recover the agent group id', () => {
    expect(fromOneCLIIdentifier('ag-5dec44de-074a-4131-9472-da38f8097438')).toBe(
      '5dec44de-074a-4131-9472-da38f8097438',
    );
  });

  it('passes a non-prefixed identifier through unchanged for backward compatibility', () => {
    expect(fromOneCLIIdentifier('5dec44de-074a-4131-9472-da38f8097438')).toBe('5dec44de-074a-4131-9472-da38f8097438');
  });

  it('returns undefined when input is undefined', () => {
    expect(fromOneCLIIdentifier(undefined)).toBeUndefined();
  });

  it('returns undefined when input is null (matches @onecli-sh/sdk externalId nullable shape)', () => {
    expect(fromOneCLIIdentifier(null)).toBeUndefined();
  });

  it('is idempotent under re-stripping', () => {
    const id = 'ag-5dec44de-074a-4131-9472-da38f8097438';
    expect(fromOneCLIIdentifier(fromOneCLIIdentifier(id))).toBe('5dec44de-074a-4131-9472-da38f8097438');
  });
});

describe('round trip', () => {
  it('to-then-from recovers the original group id', () => {
    const id = '5dec44de-074a-4131-9472-da38f8097438';
    expect(fromOneCLIIdentifier(toOneCLIIdentifier(id))).toBe(id);
  });
});
