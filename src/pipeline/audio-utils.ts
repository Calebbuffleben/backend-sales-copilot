/**
 * Converte dados PCM (s16le) em um arquivo WAV completo
 * @param pcm Buffer com dados PCM raw (s16le)
 * @param sampleRate Taxa de amostragem em Hz (ex: 16000)
 * @param channels Número de canais (1 = mono, 2 = stereo)
 * @returns Buffer completo do arquivo WAV (header + dados)
 */
export function convertPcmToWav(
  pcm: Buffer,
  sampleRate: number,
  channels: number,
): Buffer {
  const dataLength = pcm.length;
  const headerLength = 44;
  const fileLength = headerLength + dataLength;
  const byteRate = sampleRate * channels * 2; // 2 bytes por sample (s16le)
  const blockAlign = channels * 2;

  // Criar header WAV
  const header = Buffer.alloc(headerLength);

  // RIFF header
  header.write('RIFF', 0);
  header.writeUInt32LE(fileLength - 8, 4); // File size - 8
  header.write('WAVE', 8);

  // fmt chunk
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // Audio format (1 = PCM)
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(16, 34); // Bits per sample (16 bits)

  // data chunk
  header.write('data', 36);
  header.writeUInt32LE(dataLength, 40);

  // Concatenar header + dados PCM
  return Buffer.concat([header, pcm], fileLength);
}
