// Texture sanity, checked in node without a browser.
//
// The water tile used to multiply every texel by its own random value. On a
// single block that is invisible, but magnified across a lake the texels stop
// agreeing with each other and the surface reads as dithering. This asserts
// neighbouring texels stay close, which is the property that actually matters
// once a tile is stretched over a large surface.
import { createTextureArray, blockTable, TILE_PX } from '../src/blocks.js';

const { texture, averages } = createTextureArray();
const data = texture.image.data;
const depth = texture.image.depth;

const texelAt = (layer, x, y) => {
  const i = (layer * TILE_PX * TILE_PX + y * TILE_PX + x) * 4;
  return [data[i], data[i + 1], data[i + 2], data[i + 3]];
};
const luma = ([r, g, b]) => 0.299 * r + 0.587 * g + 0.114 * b;

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
};

console.log(`atlas: ${TILE_PX}x${TILE_PX} x ${depth} tiles\n`);

// For every tile, how big is the largest luminance jump between texels that
// share an edge? A dithered tile scores high; a coherent one scores low.
const rows = [];
for (let layer = 0; layer < depth; layer++) {
  let worst = 0;
  for (let y = 0; y < TILE_PX; y++) {
    for (let x = 0; x < TILE_PX; x++) {
      if (x + 1 < TILE_PX) worst = Math.max(worst, Math.abs(luma(texelAt(layer, x, y)) - luma(texelAt(layer, x + 1, y))));
      if (y + 1 < TILE_PX) worst = Math.max(worst, Math.abs(luma(texelAt(layer, x, y)) - luma(texelAt(layer, x, y + 1))));
    }
  }
  rows.push([layer, worst]);
}
rows.sort((a, b) => b[1] - a[1]);

console.log('largest adjacent-texel luminance jump per tile (top 6):');
for (const [layer, worst] of rows.slice(0, 6)) console.log(`   layer ${String(layer).padStart(2)}  ${worst.toFixed(1)}`);

// The water tile is layer 13 by name order; find it via its mean colour
// instead of hard-coding an index.
const water = averages.findIndex((c) => c[2] > c[0] && c[2] > c[1] && c[0] < 0.35);
const waterStep = rows.find(([l]) => l === water)?.[1] ?? 0;
check('water tile has coherent neighbouring texels', waterStep <= 12, `(largest jump ${waterStep.toFixed(1)}, dithered was ~55)`);

// Nothing should be a flat magenta hole, which is what an unpainted tile is.
const magenta = averages.findIndex((c) => c[0] > 0.9 && c[2] > 0.7 && c[1] < 0.3);
check('every tile is painted', magenta === -1, magenta === -1 ? '' : `layer ${magenta} is the unpainted fallback`);

// Alpha must be uniform within a tile, except for the cutout ones (leaves,
// glass, ice) which deliberately punch holes. Derive the exemption from the
// block table rather than hard-coding a layer index.
let mixed = [];
const cutoutLayers = new Set(
  blockTable.filter((b) => b.solidity === 'cutout')
    .flatMap((b) => [b.textureFor(2), b.textureFor(0)]),
);
for (let layer = 0; layer < depth; layer++) {
  let min = 255, max = 0;
  for (let i = 0; i < TILE_PX * TILE_PX; i++) {
    const a = data[(layer * TILE_PX * TILE_PX + i) * 4 + 3];
    min = Math.min(min, a); max = Math.max(max, a);
  }
  if (min !== max && !cutoutLayers.has(layer)) mixed.push(layer);
}
check('alpha is uniform outside the cutout tiles', mixed.length === 0,
  mixed.length ? `layers ${mixed.join(', ')} mix alpha` : `${cutoutLayers.size} cutout layers exempted`);

console.log(`\n${failures ? failures + ' check(s) failed' : 'all checks passed'}`);
process.exit(failures ? 1 : 0);
