/// <reference lib="webworker" />

import { packetizeRaptorQ } from '@raptorqr/core/sender/raptorq_packetizer';
import { DEFAULT_RAPTORQ_REPAIR_PERCENT } from '@raptorqr/core/fec/codec';
import { createQRTransferProfile } from '@raptorqr/core/protocol/profiles';

const profile = createQRTransferProfile(20, 'L');
const scope = self as unknown as DedicatedWorkerGlobalScope;

type EncodeMessage = {
  type: 'encode';
  data: ArrayBuffer;
  filename: string;
  mimeType: string;
};

scope.onmessage = (event: MessageEvent<EncodeMessage>) => {
  if (event.data.type !== 'encode') return;

  void packetizeRaptorQ(
    new Uint8Array(event.data.data),
    false,
    true,
    event.data.filename,
    event.data.mimeType,
    {
      maxTransportPayloadSize: profile.maxPayloadSize,
      repairPercent: Math.max(20, DEFAULT_RAPTORQ_REPAIR_PERCENT),
    },
  ).then((result) => {
    const transfer = result.packets.map((packet) => packet.buffer as ArrayBuffer);
    scope.postMessage({
      type: 'encoded',
      packets: result.packets,
      sourcePacketIndices: result.sourcePacketIndices,
      repairPacketIndices: result.repairPacketIndices,
      originalSize: event.data.data.byteLength,
      encodedSize: result.packets.reduce((sum, packet) => sum + packet.byteLength, 0),
    }, transfer);
  }).catch((error: unknown) => {
    scope.postMessage({
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
    });
  });
};
