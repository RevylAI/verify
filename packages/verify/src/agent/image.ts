import { PNG } from 'pngjs';

export interface ModelImage {
  png: Uint8Array;
  width: number;
  height: number;
}

/** Shrinks a PNG by the smallest whole factor that keeps its longer side within maxSide, averaging each block of pixels. */
export function fitPng(bytes: Uint8Array, maxSide: number): ModelImage {
  const source = PNG.sync.read(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  const factor = Math.ceil(Math.max(source.width, source.height) / maxSide);
  if (factor <= 1) return { png: bytes, width: source.width, height: source.height };
  const width = Math.floor(source.width / factor);
  const height = Math.floor(source.height / factor);
  const target = new PNG({ width, height });
  const area = factor * factor;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const sums = [0, 0, 0, 0];
      for (let dy = 0; dy < factor; dy += 1) {
        const row = (y * factor + dy) * source.width;
        for (let dx = 0; dx < factor; dx += 1) {
          const offset = (row + x * factor + dx) * 4;
          for (let channel = 0; channel < 4; channel += 1) sums[channel]! += source.data[offset + channel]!;
        }
      }
      const out = (y * width + x) * 4;
      for (let channel = 0; channel < 4; channel += 1) target.data[out + channel] = Math.round(sums[channel]! / area);
    }
  }
  return { png: PNG.sync.write(target), width, height };
}
