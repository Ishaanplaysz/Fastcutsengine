const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const size = 256;
const pixels = Buffer.alloc((size * 4 + 1) * size);
const polygon = [[78, 57], [193, 57], [181, 87], [114, 87], [105, 113], [163, 113], [152, 143], [96, 143], [77, 200], [42, 200]];
function inside(x, y) {
  let result = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) result = !result;
  }
  return result;
}
for (let y = 0; y < size; y++) {
  for (let x = 0; x < size; x++) {
    const offset = y * (size * 4 + 1) + 1 + x * 4;
    const dx = Math.max(32 - x, x - 223, 0);
    const dy = Math.max(32 - y, y - 223, 0);
    if (dx * dx + dy * dy > 32 * 32) continue;
    const f = inside(x, y);
    const sparkle = Math.abs(x - 192) + Math.abs(y - 181) < 14;
    const shade = (x + y) / 512;
    pixels[offset] = f || sparkle ? 243 : Math.round(166 - shade * 35);
    pixels[offset + 1] = f || sparkle ? 237 : Math.round(132 - shade * 40);
    pixels[offset + 2] = f || sparkle ? 255 : Math.round(245 - shade * 20);
    pixels[offset + 3] = 255;
  }
}
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  const header = Buffer.alloc(4), crc = Buffer.alloc(4);
  header.writeUInt32BE(data.length);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([header, body, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(size, 0);
ihdr.writeUInt32BE(size, 4);
ihdr[8] = 8;
ihdr[9] = 6;
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
const ico = Buffer.alloc(22);
ico.writeUInt16LE(1, 2);
ico.writeUInt16LE(1, 4);
ico.writeUInt16LE(1, 10);
ico.writeUInt16LE(32, 12);
ico.writeUInt32LE(png.length, 14);
ico.writeUInt32LE(22, 18);
const directory = path.join(__dirname, '..', 'assets');
fs.mkdirSync(directory, { recursive: true });
fs.writeFileSync(path.join(directory, 'icon.png'), png);
fs.writeFileSync(path.join(directory, 'icon.ico'), Buffer.concat([ico, png]));
console.log('Generated FastCompute application icons.');
