import { describe, expect, test } from 'bun:test';
import { createSidecarReadyParser } from '../src/sidecar-stdout';

describe('sidecar stdout readiness parser', () => {
  test('detects TAGMA_READY when the line is split across chunks', () => {
    const parser = createSidecarReadyParser();

    expect(parser.push(Buffer.from('TAGMA_'))).toBeNull();
    expect(parser.push(Buffer.from('READY port='))).toBeNull();
    expect(parser.push(Buffer.from('8123\n'))).toBe(8123);
  });
});
