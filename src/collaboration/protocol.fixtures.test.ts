/**
 * Cross-language protocol fixture round-trip test.
 *
 * Loads every JSON fixture in `/protocol-fixtures/`, encodes its payload
 * with `encodeMessage`, decodes it back with `decodePayload`, and asserts
 * the round-trip is lossless. A matching Rust test
 * (`src-tauri/tests/protocol_fixtures.rs`) consumes the same files —
 * together they guarantee `protocol.ts` and `protocol.rs` stay in sync.
 *
 * Fixtures live at `/relay/tests/protocol-fixtures/` (moved there in
 * Slice C.1 of phase 20.3).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PROTOCOL_VERSION,
  encodeMessage,
  decodeMessageType,
  decodePayload,
  getMessageTypeName,
} from './protocol';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = resolve(__dirname, '../../relay/tests/protocol-fixtures');

interface Fixture {
  messageType: number;
  messageName: string;
  kind: 'request' | 'response' | 'event' | 'oneshot';
  payload: unknown;
}

function loadFixtures(): Array<{ file: string; fixture: Fixture }> {
  const files = readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort();
  return files.map((file) => {
    const raw = readFileSync(join(FIXTURES_DIR, file), 'utf8');
    return { file, fixture: JSON.parse(raw) as Fixture };
  });
}

describe('protocol fixtures (cross-language)', () => {
  it('PROTOCOL_VERSION is set', () => {
    expect(PROTOCOL_VERSION).toBeGreaterThan(0);
  });

  const fixtures = loadFixtures();

  it('discovers at least one fixture', () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  for (const { file, fixture } of fixtures) {
    describe(file, () => {
      it('messageType matches messageName via getMessageTypeName', () => {
        expect(getMessageTypeName(fixture.messageType)).toBe(fixture.messageName);
      });

      it('round-trips through encodeMessage / decodePayload', () => {
        const wire = encodeMessage(fixture.messageType, fixture.payload);
        expect(wire[0]).toBe(fixture.messageType);
        expect(decodeMessageType(wire)).toBe(fixture.messageType);

        const decoded = decodePayload<unknown>(wire);
        expect(decoded).toEqual(fixture.payload);
      });
    });
  }
});
