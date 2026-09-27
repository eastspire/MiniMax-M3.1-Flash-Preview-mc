// Block registry, and the pixel art that goes with it.
//
// There are no image files in this project. Every tile is painted into a byte
// buffer at load and the whole set is uploaded as a single WebGL2 texture
// array, so one bound texture serves every face in the world.
//
// Tile indices are assigned by TILES below rather than by declaration order,
// which keeps the texture layout independent of the block ids.

import * as THREE from '../vendor/three.module.js';

export const TILE_PX = 16;

export const AIR = 0;
export const BEDROCK = 1;
export const STONE = 2;
export const COBBLE = 3;
export const DIRT = 4;
export const GRASS = 5;
export const SAND = 6;
export const SANDSTONE = 7;
export const SNOW = 8;
export const GRAVEL = 9;
export const COAL = 10;
export const IRON = 11;
export const GOLD = 12;
export const OAK_LOG = 13;
export const OAK_LEAF = 14;
export const SPRUCE_LOG = 15;
export const SPRUCE_LEAF = 16;
export const CACTUS = 17;
export const WATER = 18;
export const ICE = 19;
export const PLANK = 20;
export const BRICK = 21;
export const GLASS = 22;
export const BLOCK_TOTAL = 23;

// TILE names double as the texture array layer order.
const TILES = [
  'grassTop', 'grassEdge', 'soil', 'stone', 'cobble', 'sand',
  'sandstoneTop', 'sandstoneEdge', 'snow', 'gravel',
  'oreCoal', 'oreIron', 'oreGold',
  'logTop', 'logBark', 'pineTop', 'pineBark', 'pineNeedle',
  'oakNeedle', 'cactusTop', 'cactusSide', 'fluid', 'ice', 'plank', 'brick', 'pane',
];
const LAYER = Object.fromEntries(TILES.map((name, i) => [name, i]));
const TILE_COUNT = TILES.length;

/** Face order used by the mesher: +X, -X, +Y, -Y, +Z, -Z. */
const F_UP = 2, F_DOWN = 3;

/**
 * Each entry: [name, solidity, hardness, texture]
 *   solidity: 'full' | 'cutout' | 'fluid'
 *   texture:  a tile name, or { up, down, side }
 */
const REGISTRY = [
  ['Air', 'none', 0, null],
  ['Bedrock', 'full', Infinity, 'stone'],
  ['Stone', 'full', 1.45, 'stone'],
  ['Cobblestone', 'full', 1.7, 'cobble'],
  ['Dirt', 'full', 0.45, 'soil'],
  ['Grass', 'full', 0.5, { up: 'grassTop', down: 'soil', side: 'grassEdge' }],
  ['Sand', 'full', 0.35, 'sand'],
  ['Sandstone', 'full', 1.1, { up: 'sandstoneTop', down: 'sandstoneTop', side: 'sandstoneEdge' }],
  ['Snow', 'full', 0.3, 'snow'],
  ['Gravel', 'full', 0.55, 'gravel'],
  ['Coal Ore', 'full', 2.1, 'oreCoal'],
  ['Iron Ore', 'full', 2.5, 'oreIron'],
  ['Gold Ore', 'full', 2.8, 'oreGold'],
  ['Oak Log', 'full', 1.0, { up: 'logTop', down: 'logTop', side: 'logBark' }],
  ['Oak Leaves', 'cutout', 0.2, 'oakNeedle'],
  ['Spruce Log', 'full', 1.0, { up: 'pineTop', down: 'pineTop', side: 'pineBark' }],
  ['Spruce Leaves', 'cutout', 0.2, 'pineNeedle'],
  ['Cactus', 'full', 0.45, { up: 'cactusTop', down: 'cactusTop', side: 'cactusSide' }],
  ['Water', 'fluid', 0, 'fluid'],
  ['Ice', 'cutout', 0.45, 'ice'],
  ['Planks', 'full', 0.85, 'plank'],
  ['Bricks', 'full', 1.9, 'brick'],
  ['Glass', 'cutout', 0.35, 'pane'],
];

export const blockTable = REGISTRY.map(([name, solidity, hardness, tex], id) => ({
  id,
  name,
  solidity,
  hardness,
  blocksMovement: solidity === 'full' || solidity === 'cutout',
  textureFor(face) {
    if (!tex) return -1;
    if (typeof tex === 'string') return LAYER[tex];
    if (face === F_UP) return LAYER[tex.up];
    if (face === F_DOWN) return LAYER[tex.down];
    return LAYER[tex.side];
  },
}));

export const blockName = (id) => (blockTable[id] || blockTable[AIR]).name;

// ---------------------------------------------------------------- painting

class Bitmap {
  constructor() { this.px = new Uint8Array(TILE_PX * TILE_PX * 4); }

  plot(x, y, r, g, b, a = 255) {
    if (x < 0 || y < 0 || x >= TILE_PX || y >= TILE_PX) return;
    const o = ((y | 0) * TILE_PX + (x | 0)) * 4;
    this.px[o] = r; this.px[o + 1] = g; this.px[o + 2] = b; this.px[o + 3] = a;
  }

  wash(r, g, b, a = 255) {
    for (let y = 0; y < TILE_PX; y++) for (let x = 0; x < TILE_PX; x++) this.plot(x, y, r, g, b, a);
  }

  read(x, y) {
    const o = ((((y % TILE_PX) + TILE_PX) % TILE_PX) * TILE_PX
      + (((x % TILE_PX) + TILE_PX) % TILE_PX)) * 4;
    return [this.px[o], this.px[o + 1], this.px[o + 2], this.px[o + 3]];
  }

  /** Multiply every pixel by f(x, y). */
  modulate(f) {
    for (let y = 0; y < TILE_PX; y++) {
      for (let x = 0; x < TILE_PX; x++) {
        const k = f(x, y);
        if (k === 1) continue;
        const [r, g, b, a] = this.read(x, y);
        this.plot(x, y, cap(r * k), cap(g * k), cap(b * k), a);
      }
    }
  }
}

const cap = (v) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);

/** Scatter individual pixels of a colour — the base texture of the pixel look. */
function salt(bm, seed, chance, [r, g, b, a = 255]) {
  const rnd = stream(seed);
  for (let y = 0; y < TILE_PX; y++) {
    for (let x = 0; x < TILE_PX; x++) {
      if (rnd() < chance) bm.plot(x, y, r, g, b, a);
    }
  }
}

/** Soft irregular patches, for stone and gravel. */
function mottle(bm, seed, count, [r, g, b], spread) {
  const rnd = stream(seed);
  for (let n = 0; n < count; n++) {
    const cx = (rnd() * TILE_PX) | 0, cy = (rnd() * TILE_PX) | 0;
    for (let dy = -spread; dy <= spread; dy++) {
      for (let dx = -spread; dx <= spread; dx++) {
        if (rnd() < 0.4) continue;
        const [pr, pg, pb] = bm.read(cx + dx, cy + dy);
        const mixT = 0.4;
        bm.plot(cx + dx, cy + dy,
          cap(pr + (r - pr) * mixT), cap(pg + (g - pg) * mixT), cap(pb + (b - pb) * mixT));
      }
    }
  }
}

/** Small deterministic generator, so a tile is identical on every reload. */
function stream(seed) {
  let s = (seed | 0) || 0x9e37;
  return () => {
    s ^= s << 13; s |= 0;
    s ^= s >>> 17;
    s ^= s << 5; s |= 0;
    return ((s >>> 0) % 16777216) / 16777216;
  };
}

function paint(name) {
  const bm = new Bitmap();
  switch (name) {
    case 'grassTop':
      bm.wash(108, 172, 66);
      salt(bm, 101, 0.30, [94, 154, 56]);
      salt(bm, 102, 0.14, [128, 190, 80]);
      break;

    case 'grassEdge': {
      bm.wash(136, 98, 68);
      salt(bm, 111, 0.26, [120, 86, 60]);
      const rnd = stream(112);
      for (let x = 0; x < TILE_PX; x++) {
        const depth = 3 + ((rnd() * 3) | 0);
        for (let y = 0; y < depth; y++) bm.plot(x, y, 108, 172, 66);
      }
      break;
    }

    case 'soil':
      bm.wash(136, 98, 68);
      salt(bm, 121, 0.28, [122, 88, 60]);
      salt(bm, 122, 0.12, [150, 112, 80]);
      break;

    case 'stone':
      bm.wash(130, 130, 134);
      mottle(bm, 131, 15, [112, 112, 118], 2);
      salt(bm, 132, 0.16, [148, 148, 152]);
      break;

    case 'cobble': {
      bm.wash(110, 110, 115);                      // mortar
      const rnd = stream(141);
      for (let n = 0; n < 10; n++) {                // embedded stones
        const cx = 1 + ((rnd() * 13) | 0);
        const cy = 1 + ((rnd() * 13) | 0);
        const w = 3 + ((rnd() * 3) | 0);
        const h = 3 + ((rnd() * 3) | 0);
        const tone = 130 + ((rnd() * 28) | 0);
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) bm.plot(cx + x, cy + y, tone, tone, tone + 4);
        }
      }
      break;
    }

    case 'sand':
      bm.wash(221, 207, 157);
      salt(bm, 151, 0.24, [207, 192, 142]);
      salt(bm, 152, 0.12, [235, 222, 174]);
      break;

    case 'sandstoneTop':
      bm.wash(225, 211, 162);
      salt(bm, 161, 0.18, [211, 196, 147]);
      break;

    case 'sandstoneEdge':
      bm.wash(225, 211, 162);
      for (let y = 0; y < TILE_PX; y++) {           // sediment bands
        if (y % 5 !== 0) continue;
        for (let x = 0; x < TILE_PX; x++) {
          const [r, g, b] = bm.read(x, y);
          bm.plot(x, y, cap(r * 0.89), cap(g * 0.89), cap(b * 0.89));
        }
      }
      break;

    case 'snow':
      bm.wash(244, 248, 252);
      salt(bm, 171, 0.15, [228, 235, 244]);
      salt(bm, 172, 0.07, [255, 255, 255]);
      break;

    case 'gravel': {
      bm.wash(138, 132, 126);
      const rnd = stream(181);
      for (let n = 0; n < 30; n++) {
        const tone = 100 + ((rnd() * 68) | 0);
        bm.plot((rnd() * TILE_PX) | 0, (rnd() * TILE_PX) | 0, tone, tone - 3, tone - 8);
      }
      break;
    }

    case 'oreCoal': case 'oreIron': case 'oreGold': {
      bm.wash(130, 130, 134);
      mottle(bm, 191, 11, [114, 114, 120], 2);
      const [cr, cg, cb] = name === 'oreCoal' ? [46, 46, 50]
        : name === 'oreIron' ? [198, 150, 114] : [234, 202, 86];
      const rnd = stream(192);
      for (let n = 0; n < 5; n++) {
        const cx = 2 + ((rnd() * 11) | 0), cy = 2 + ((rnd() * 11) | 0);
        const bright = 0.8 + rnd() * 0.4;
        for (let dy = 0; dy < 2; dy++) {
          for (let dx = 0; dx < 2; dx++) {
            bm.plot(cx + dx, cy + dy, cap(cr * bright), cap(cg * bright), cap(cb * bright));
          }
        }
      }
      break;
    }

    case 'logTop': {
      bm.wash(162, 126, 80);
      for (let y = 0; y < TILE_PX; y++) {
        for (let x = 0; x < TILE_PX; x++) {
          const ring = Math.hypot(x - 7.5, y - 7.5) | 0;
          if (ring % 3) continue;
          const [r, g, b] = bm.read(x, y);
          bm.plot(x, y, cap(r * 0.83), cap(g * 0.83), cap(b * 0.83));
        }
      }
      break;
    }

    case 'logBark': {
      bm.wash(114, 86, 54);
      const rnd = stream(201);
      bm.modulate(() => 0.8 + rnd() * 0.38);
      break;
    }

    case 'pineTop': {
      bm.wash(98, 72, 47);
      for (let y = 0; y < TILE_PX; y++) {
        for (let x = 0; x < TILE_PX; x++) {
          if (((Math.hypot(x - 7.5, y - 7.5) | 0) % 3) !== 0) continue;
          const [r, g, b] = bm.read(x, y);
          bm.plot(x, y, cap(r * 0.81), cap(g * 0.81), cap(b * 0.81));
        }
      }
      break;
    }

    case 'pineBark': {
      bm.wash(74, 54, 35);
      const rnd = stream(211);
      bm.modulate(() => 0.78 + rnd() * 0.44);
      break;
    }

    case 'oakNeedle': {
      const rnd = stream(221);
      for (let y = 0; y < TILE_PX; y++) {
        for (let x = 0; x < TILE_PX; x++) {
          const g = 76 + ((rnd() * 44) | 0);
          bm.plot(x, y, 50 + ((rnd() * 26) | 0), g, 36 + ((rnd() * 20) | 0), rnd() < 0.12 ? 0 : 255);
        }
      }
      break;
    }

    case 'pineNeedle': {
      const rnd = stream(231);
      for (let y = 0; y < TILE_PX; y++) {
        for (let x = 0; x < TILE_PX; x++) {
          const g = 48 + ((rnd() * 32) | 0);
          bm.plot(x, y, 28 + ((rnd() * 18) | 0), g, 36 + ((rnd() * 16) | 0), rnd() < 0.11 ? 0 : 255);
        }
      }
      break;
    }

    case 'cactusTop':
      bm.wash(76, 134, 64);
      mottle(bm, 241, 7, [90, 150, 74], 1);
      bm.modulate((x) => 0.85 + 0.3 * (1 - Math.abs(x - 7.5) / 8));
      break;

    case 'cactusSide': {
      bm.wash(66, 120, 56);
      for (let x = 0; x < TILE_PX; x++) {
        if (x % 4) continue;
        for (let y = 0; y < TILE_PX; y++) bm.plot(x, y, 54, 102, 46);
      }
      for (let y = 2; y < TILE_PX; y += 5) {
        for (let x = 2; x < TILE_PX; x += 3) bm.plot(x, y, 216, 228, 182);
      }
      break;
    }

    case 'fluid': {
      bm.wash(50, 108, 198, 170);
      // Coherent swell, not per-texel noise. Multiplying every pixel by its
      // own random value looks fine on a single block but reads as dithering
      // once the tile is magnified across a whole lake, because adjacent
      // texels land on unrelated values.
      for (let y = 0; y < TILE_PX; y++) {
        for (let x = 0; x < TILE_PX; x++) {
          const k = 0.95
            + 0.040 * Math.sin(x * 0.62)
            + 0.032 * Math.sin(y * 0.87 + 1.3)
            + 0.018 * Math.sin((x + y) * 0.41);
          const [r, g, bl, a] = bm.read(x, y);
          bm.plot(x, y, cap(r * k), cap(g * k), cap(bl * k), a);
        }
      }
      break;
    }

    case 'ice': {
      bm.wash(170, 208, 240, 195);
      const rnd = stream(261);
      for (let n = 0; n < 6; n++) {
        let x = (rnd() * TILE_PX) | 0, y = (rnd() * TILE_PX) | 0;
        const run = 3 + ((rnd() * 6) | 0);
        for (let k = 0; k < run; k++) {
          bm.plot(x, y, 216, 240, 254, 220);
          x = (x + 1) % TILE_PX;
          if (rnd() < 0.4) y = (y + 1) % TILE_PX;
        }
      }
      break;
    }

    case 'plank': {
      bm.wash(180, 144, 92);
      const rnd = stream(271);
      for (let y = 0; y < TILE_PX; y++) {
        const rowTint = 0.88 + rnd() * 0.24;
        for (let x = 0; x < TILE_PX; x++) {
          if (y % 4 === 3) { bm.plot(x, y, 126, 100, 64); continue; }
          const [r, g, b] = bm.read(x, y);
          bm.plot(x, y, cap(r * rowTint), cap(g * rowTint), cap(b * rowTint));
        }
      }
      break;
    }

    case 'brick': {
      bm.wash(180, 178, 174);                      // mortar
      const rnd = stream(281);
      for (let row = 0; row < 4; row++) {
        const shift = row % 2 ? 4 : 0;
        for (let b = -1; b < 3; b++) {
          const x0 = b * 8 + shift, y0 = row * 4;
          const base = 152 + ((rnd() * 22) | 0);
          const gr = 68 + ((rnd() * 10) | 0);
          const rd = 58 + ((rnd() * 10) | 0);
          for (let y = 1; y < 4; y++) {
            for (let x = 0; x < 7; x++) bm.plot(x0 + x, y0 + y, base, gr, rd);
          }
        }
      }
      break;
    }

    case 'pane': {
      bm.wash(200, 228, 238, 44);
      for (let i = 0; i < TILE_PX; i++) {
        bm.plot(i, i, 238, 250, 254, 150);
        bm.plot(TILE_PX - 1 - i, i, 238, 250, 254, 120);
      }
      bm.modulate(() => 0.93);
      break;
    }

    default:
      bm.wash(255, 0, 220);                        // loud, so a gap is obvious
      break;
  }
  return bm;
}

/**
 * Paint every tile and upload them as one texture array.
 * Also returns a mean colour per tile, used by the HUD to tint block icons.
 */
export function createTextureArray() {
  const layers = TILES.map(paint);
  const data = new Uint8Array(TILE_PX * TILE_PX * 4 * layers.length);
  const averages = [];

  layers.forEach((bm, i) => {
    data.set(bm.px, i * TILE_PX * TILE_PX * 4);
    let r = 0, g = 0, b = 0, n = 0;
    for (let p = 0; p < TILE_PX * TILE_PX; p++) {
      if (bm.px[p * 4 + 3] < 40) continue;          // skip transparent holes
      r += bm.px[p * 4]; g += bm.px[p * 4 + 1]; b += bm.px[p * 4 + 2]; n++;
    }
    averages.push(n ? [r / n / 255, g / n / 255, b / n / 255] : [0.5, 0.5, 0.5]);
  });

  const texture = new THREE.DataArrayTexture(data, TILE_PX, TILE_PX, TILE_COUNT);
  texture.format = THREE.RGBAFormat;
  texture.type = THREE.UnsignedByteType;
  texture.magFilter = THREE.NearestFilter;
  // No mipmaps. Generating mip levels for a 2D array texture blends separate
  // layers together, and every face ends up sampling an average of the whole
  // atlas. Nearest is also the correct look for 16px pixel art.
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  // Tiles are authored in display space and lit by our own shader.
  texture.colorSpace = THREE.NoColorSpace;
  texture.anisotropy = 1;
  texture.needsUpdate = true;

  return { texture, averages, layerOf: LAYER };
}
