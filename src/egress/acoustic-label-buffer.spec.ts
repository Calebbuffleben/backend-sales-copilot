import {
  aggregateTurnAcousticClass,
  parseAcousticLabelControl,
  stripPcmV2,
  type AcousticWindowLabel,
} from './acoustic-label-buffer';

describe('acoustic-label-buffer', () => {
  it('parses acoustic_label control frames', () => {
    const label = parseAcousticLabelControl(
      JSON.stringify({
        type: 'acoustic_label',
        labelId: 3,
        acousticClass: 'seller',
        matchedSellerId: 'u1',
        confidence: 0.9,
        windowStartMs: 100,
        windowEndMs: 300,
      }),
    );
    expect(label?.acousticClass).toBe('seller');
    expect(label?.labelId).toBe(3);
  });

  it('aggregates seller-dominant turns', () => {
    const labels: AcousticWindowLabel[] = [
      {
        labelId: 1,
        acousticClass: 'seller',
        confidence: 0.9,
        windowStartMs: 0,
        windowEndMs: 200,
      },
      {
        labelId: 2,
        acousticClass: 'seller',
        confidence: 0.85,
        windowStartMs: 200,
        windowEndMs: 400,
      },
      {
        labelId: 3,
        acousticClass: 'customer',
        confidence: 0.5,
        windowStartMs: 400,
        windowEndMs: 500,
      },
    ];
    expect(aggregateTurnAcousticClass(labels, 0, 500)).toBe('seller');
  });

  it('strips PCM v2 envelope and returns labelId', () => {
    const pcm = Buffer.alloc(320, 1);
    const header = Buffer.alloc(24);
    header.writeUInt32BE(0x4d503206, 0);
    header.writeUInt32BE(7, 4); // frameSeq
    header.writeUInt32BE(1000, 8); // captureMonoMs
    header.writeUInt32BE(42, 12); // labelId
    header.writeUInt32BE(pcm.length, 16);
    header.writeUInt32BE(0, 20);
    const framed = Buffer.concat([header, pcm]);
    const decoded = stripPcmV2(framed);
    expect(decoded?.labelId).toBe(42);
    expect(decoded?.pcm.equals(pcm)).toBe(true);
  });
});
