import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import init, { encode_packets, RaptorQDecoder } from '@raptorqr/raptorq-wasm';

const wasmUrl = import.meta.resolve(
  '@raptorqr/raptorq-wasm/wasm/raptorqr_raptorq_wasm_bg.wasm',
);
await init({ module_or_path: await readFile(new URL(wasmUrl)) });

const source = Uint8Array.from(
  { length: 8192 },
  (_, index) => (index * 31 + 7) & 255,
);
const packets = Array.from(
  encode_packets(source, 201, 20),
  (packet) => new Uint8Array(packet),
);
const decoder = new RaptorQDecoder(source.length, 201);
let recovered = null;

for (const packet of packets.slice(5)) {
  const decoded = decoder.push(packet);
  if (decoded) {
    recovered = new Uint8Array(decoded);
    break;
  }
}
decoder.free();

assert.deepEqual(recovered, source);
console.log(`RaptorQ loss recovery OK (${packets.length} packets, skipped 5)`);
