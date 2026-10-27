import { PNG } from 'pngjs';

export function screenHasContent(bytes: Uint8Array): boolean | undefined {
  if (bytes.length < 24 || bytes.length > 16 * 1024 * 1024) return undefined;
  const header = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = header.readUInt32BE(16);
  const height = header.readUInt32BE(20);
  if (width === 0 || height === 0 || width * height > 16_000_000) return undefined;
  try {
    const { data } = PNG.sync.read(header);
    const left = Math.floor(width / 10);
    const top = Math.floor(height / 10);
    const first = (top * width + left) * 4;
    for (let y = top; y < Math.ceil(height * 0.9); y += 1) {
      for (let x = left; x < Math.ceil(width * 0.9); x += 1) {
        const offset = (y * width + x) * 4;
        if (data[offset] !== data[first] || data[offset + 1] !== data[first + 1] || data[offset + 2] !== data[first + 2]) return true;
      }
    }
    return false;
  } catch {
    return undefined;
  }
}
