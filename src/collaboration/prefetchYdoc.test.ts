import { describe, it, expect } from 'vitest';
import { Doc as YDoc, encodeStateAsUpdate, applyUpdate } from 'yjs';
import { stripSidecarHeader } from './prefetchYdoc';

/** Frame a lib0-v1 update the way `relay/src/sync/binary.rs::encode_snapshot`
 * does: `b"DSKY" | format_version:u32 LE | server_version:u64 LE | update`. */
function frameSidecar(update: Uint8Array, formatVersion = 1, serverVersion = 7): Uint8Array {
  const header = new Uint8Array(16);
  header.set([0x44, 0x53, 0x4b, 0x59], 0); // "DSKY"
  new DataView(header.buffer).setUint32(4, formatVersion, true);
  new DataView(header.buffer).setBigUint64(8, BigInt(serverVersion), true);
  const out = new Uint8Array(header.length + update.length);
  out.set(header, 0);
  out.set(update, header.length);
  return out;
}

describe('stripSidecarHeader', () => {
  it('strips the 16-byte DSKY header, yielding an applyUpdate-able payload', () => {
    // Author a doc, encode it, frame it exactly like the relay, then strip.
    const src = new YDoc();
    src.getMap('shapes:p1').set('s1', 'rect');
    const update = encodeStateAsUpdate(src);

    const framed = frameSidecar(update);
    const payload = stripSidecarHeader(framed);
    expect(payload).not.toBeNull();

    // The payload must reconstruct the original CRDT content — this is exactly
    // what prefetchYdoc applies into the local room.
    const dst = new YDoc();
    applyUpdate(dst, payload!);
    expect(dst.getMap('shapes:p1').get('s1')).toBe('rect');
  });

  it('rejects a buffer with the wrong magic', () => {
    const framed = frameSidecar(new Uint8Array([1, 2, 3, 4]));
    framed[0] = 0x58; // 'X'
    expect(stripSidecarHeader(framed)).toBeNull();
  });

  it('rejects a buffer too short to contain a header + payload', () => {
    expect(stripSidecarHeader(new Uint8Array(16))).toBeNull(); // header only, no payload
    expect(stripSidecarHeader(new Uint8Array([0x44, 0x53, 0x4b, 0x59]))).toBeNull();
    expect(stripSidecarHeader(new Uint8Array(0))).toBeNull();
  });
});
