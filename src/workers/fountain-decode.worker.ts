/// <reference lib="webworker" />

import { decodeQRFromCanvas } from '@raptorqr/core/qr/qr_decode';
import { RaptorQWasmDecoder } from '@raptorqr/core/fec/raptorq_wasm';
import { decompress } from '@raptorqr/core/preprocess/compress';
import { parsePacket } from '@raptorqr/core/protocol/packet';
import { RAPTORQ_SYMBOL_INDEX } from '@raptorqr/core/protocol/constants';

const scope = self as unknown as DedicatedWorkerGlobalScope;

let decoder: RaptorQWasmDecoder | null = null;
let seen = new Set<string>();
let dataLength = 0;
let symbolSize = 0;
let compressed = false;
let complete = false;

scope.onmessage = (event: MessageEvent<{ type: 'frame' | 'reset'; imageData?: ImageData }>) => {
  if (event.data.type === 'reset') {
    reset();
    return;
  }
  if (!event.data.imageData || complete) {
    scope.postMessage({ type: 'frame-done' });
    return;
  }

  void processFrame(event.data.imageData)
    .catch((error: unknown) => {
      scope.postMessage({
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    })
    .finally(() => scope.postMessage({ type: 'frame-done' }));
};

async function processFrame(imageData: ImageData) {
  const decoded = await decodeQRFromCanvas(imageData);
  if (!decoded) return;

  let packet;
  try {
    packet = parsePacket(decoded.bytes);
  } catch {
    return;
  }
  if (packet.header.symbolIndex !== RAPTORQ_SYMBOL_INDEX) return;

  if (!decoder) {
    dataLength = packet.header.dataLength;
    symbolSize = packet.payload.length;
    compressed = packet.header.compressed;
    decoder = await RaptorQWasmDecoder.create(dataLength, symbolSize);
  }
  if (
    packet.header.dataLength !== dataLength ||
    packet.payload.length !== symbolSize ||
    packet.header.compressed !== compressed
  ) return;

  const key = Array.from(packet.payload.subarray(0, 4)).join(':');
  if (seen.has(key)) {
    reportProgress();
    return;
  }
  seen.add(key);

  const result = decoder.push(packet.payload);
  if (!result) {
    reportProgress();
    return;
  }

  complete = true;
  const unpacked = compressed ? await decompress(result, 0) : result;
  const file = unpackFile(unpacked);
  scope.postMessage({
    type: 'complete',
    data: file.data.buffer,
    filename: file.filename,
    mimeType: file.mimeType,
  }, [file.data.buffer as ArrayBuffer]);
}

function reportProgress() {
  const needed = Math.max(1, Math.ceil(dataLength / Math.max(1, symbolSize - 4)));
  scope.postMessage({
    type: 'progress',
    received: seen.size,
    needed,
    percent: Math.min(99, Math.round((seen.size / needed) * 100)),
  });
}

function unpackFile(data: Uint8Array) {
  if (data.length < 2) throw new Error('文件元数据不完整');
  const nameLength = data[0]!;
  const mimeLengthOffset = 1 + nameLength;
  if (mimeLengthOffset >= data.length) throw new Error('文件名元数据不完整');
  const mimeLength = data[mimeLengthOffset]!;
  const contentOffset = mimeLengthOffset + 1 + mimeLength;
  if (contentOffset > data.length) throw new Error('文件类型元数据不完整');

  return {
    filename: new TextDecoder().decode(data.subarray(1, mimeLengthOffset)) || 'recovered-file',
    mimeType: new TextDecoder().decode(data.subarray(mimeLengthOffset + 1, contentOffset)) || 'application/octet-stream',
    data: data.slice(contentOffset),
  };
}

function reset() {
  decoder = null;
  seen = new Set();
  dataLength = 0;
  symbolSize = 0;
  compressed = false;
  complete = false;
}
