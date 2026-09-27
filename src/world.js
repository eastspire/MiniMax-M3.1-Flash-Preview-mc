// The world: chunk storage, terrain synthesis, biomes, caves, ores and trees.
//
// A chunk is a 16 x WORLD_H x 16 column of bytes held in a single typed array,
// laid out y-major so a vertical column is contiguous. Terrain is a pure
// function of (seed, x, z) — the only state that outlives a chunk is the
// player's edit journal, so dropping and regenerating a chunk is always safe.
//
// Generation runs as explicit phases (bedrock, rock, carve, surface, water,
// decorate) rather than one nested pass, because each phase can then be skipped
// or reordered while tuning without touching the others.

import {
  AIR, BEDROCK, STONE, COBBLE, DIRT, GRASS, SAND, SANDSTONE, SNOW, GRAVEL,
  COAL, IRON, GOLD, OAK_LOG, OAK_LEAF, SPRUCE_LOG, SPRUCE_LEAF, CACTUS,
  WATER, blockTable,
} from './blocks.js';
import { Noise, clamp, smoothstep, hash2 } from './noise.js';

export const CHUNK_X = 16;
export const CHUNK_Z = 16;
export const WORLD_H = 128;
export const SEA_LEVEL = 40;
const PLANE = CHUNK_X * CHUNK_Z;
const CHUNK_BYTES = PLANE * WORLD_H;

export const CLIMATE = {
  OCEAN: 'Ocean', SHORE: 'Shore', MEADOW: 'Meadow', WOODLAND: 'Woodland',
  STEPPE: 'Steppe', DUNES: 'Dunes', TUNDRA: 'Tundra', ALPINE: 'Alpine',
};
const CLIMATE_IDS = Object.values(CLIMATE);

export const cellOffset = (x, y, z) => y * PLANE + z * CHUNK_X + x;
export const regionKey = (cx, cz) => `${cx}|${cz}`;

export class World {
  constructor(seed = 20260927) {
    this.seed = seed >>> 0;
    // Each concern gets its own field so tuning one does not move the others.
    this.land = new Noise(this.seed ^ 0x51ed270b);
    this.swirl = new Noise(this.seed ^ 0x1b873593);
    this.crest = new Noise(this.seed ^ 0xcc9e2d51);
    this.rough = new Noise(this.seed ^ 0x7feb352d);
    this.thermal = new Noise(this.seed ^ 0x846ca68b);
    this.moist = new Noise(this.seed ^ 0x2545f491);
    this.hollow = new Noise(this.seed ^ 0x9e3779b1);
    this.vein = new Noise(this.seed ^ 0xbf58476d);
    this.stand = new Noise(this.seed ^ 0x94d049bb);

    this.regions = new Map();      // live chunks, keyed by regionKey
    this.ready = new Set();         // regions that have been generated
    this.journal = new Map();       // "x,y,z" -> block id, survives unloading
    this.postbox = [];              // tree writes waiting on a neighbour
  }

  // -------------------------------------------------------------- climate

  thermalAt(x, z) { return this.thermal.fbm2(x * 0.00041, z * 0.00041, 3); }
  moistAt(x, z) { return this.moist.fbm2(x * 0.00057, z * 0.00057, 3); }

  /**
   * Ground height for a column.
   *
   * The base field is sampled through a domain warp, which is what turns a
   * blobby noise map into coastlines with peninsulas and bays. Mountains come
   * from a ridged multifractal gated by a low-frequency mask, so ranges cluster
   * instead of dusting the whole map.
   */
  heightAt(x, z) {
    const warpX = this.swirl.n2(x * 0.0017, z * 0.0017) * 46;
    const warpZ = this.swirl.n2(x * 0.0017 + 133.7, z * 0.0017 - 61.4) * 46;

    const shelf = this.land.fbm2((x + warpX) * 0.00108, (z + warpZ) * 0.00108, 4);
    const rolling = this.land.fbm2(x * 0.0061, z * 0.0061, 4);
    const grain = this.rough.fbm2(x * 0.027, z * 0.027, 2);
    // Short-wavelength jitter. It only exists to stop slopes degenerating into
    // a metronomic staircase, but it has to stay small: at higher amplitude it
    // etches regular corduroy stripes across every hillside instead.
    const chatter = this.rough.fbm2(x * 0.11, z * 0.11, 2);

    let h = SEA_LEVEL + 3 + shelf * 25 + rolling * 7.6 + grain * 2.1 + chatter * 0.5;

    const range = smoothstep(0.13, 0.47,
      this.land.fbm2(x * 0.00068 + 517.1, z * 0.00068 - 203.9, 2));
    if (range > 0) {
      // Raising the spine to a power sharpens the crests, so ranges read as
      // ridgelines rather than smooth domes.
      const spine = Math.pow(this.crest.ridged2(x * 0.0025, z * 0.0025, 5), 1.45);
      h += range * range * spine * 72;
    }

    // Ease the tallest ground into the world ceiling rather than letting it
    // clip flat against the top.
    const cap = WORLD_H - 13;
    if (h > cap - 20) h = cap - 20 + 20 * (1 - Math.exp(-(h - (cap - 20)) / 8.5));
    return clamp(h, 3, cap);
  }

  climateAt(x, z, h = null) {
    const ground = h === null ? this.heightAt(x, z) : h;
    if (ground < SEA_LEVEL - 2.5) return CLIMATE.OCEAN;
    if (ground < SEA_LEVEL + 1.8) return CLIMATE.SHORE;
    if (ground > SEA_LEVEL + 25) return CLIMATE.ALPINE;
    const warm = this.thermalAt(x, z);
    const wet = this.moistAt(x, z);
    if (warm > 0.23 && wet < -0.04) return CLIMATE.DUNES;
    if (warm < -0.23) return CLIMATE.TUNDRA;
    if (warm > 0.15 && wet < 0.05) return CLIMATE.STEPPE;
    if (wet > 0.04) return CLIMATE.WOODLAND;
    return CLIMATE.MEADOW;
  }

  climateNameAt(x, z, h = null) { return this.climateAt(x, z, h); }

  // ----------------------------------------------------------------- caves

  /**
   * Two ridged fields intersected. A single thresholded field produces
   * disconnected bubbles; the intersection of two independent ones produces
   * long connected passages, which is what reads as a cave system.
   */
  hollowAt(x, y, z) {
    if (y < 3 || y > WORLD_H - 22) return false;
    const s = 0.0195;
    const a = this.hollow.n3(x * s + 88.5, y * s * 2.35, z * s - 12.7);
    const b = this.hollow.n3(x * s - 41.9, y * s * 2.35 + 63.1, z * s + 29.3);
    const passage = a * a + b * b;
    // Openings narrow toward bedrock and are throttled close to the surface.
    const room = smoothstep(2, 15, y) * (1 - 0.5 * smoothstep(58, 80, y));
    return passage < 0.0034 * room + 0.0003;
  }

  veinAt(x, y, z) {
    if (y < 2) return AIR;
    const v = this.vein.n3(x * 0.125, y * 0.44, z * 0.125);
    if (v > 0.805) return GOLD;
    if (v > 0.705) return IRON;
    if (v > 0.605) return COAL;
    if (y < 25 && this.vein.n3(x * 0.088 + 913, y * 0.36, z * 0.088 - 517) > 0.745) return GRAVEL;
    return AIR;
  }

  // ----------------------------------------------------------------- flora

  /** Per-column flora decision, or null. Pure, so it works before loading. */
  floraAt(x, z) {
    const h = this.heightAt(x, z);
    if (h <= SEA_LEVEL + 1.2 || h > SEA_LEVEL + 23) return null;
    const climate = this.climateAt(x, z, h);
    let odds = 0;
    if (climate === CLIMATE.WOODLAND) odds = 0.072;
    else if (climate === CLIMATE.MEADOW) odds = 0.007;
    else if (climate === CLIMATE.TUNDRA) odds = 0.028;
    else if (climate === CLIMATE.STEPPE) odds = 0.011;
    if (hash2(x, z, this.seed ^ 0x2f) > odds) return null;
    // Stand density: trees grow in company, leaving glades between groves.
    if (this.stand.fbm2(x * 0.017, z * 0.017, 2) > 0.29) return null;
    const roll = hash2(x, z, this.seed ^ 0x8d1);
    if (climate === CLIMATE.STEPPE) return { shape: 'flat', height: 4 + ((roll * 2) | 0) };
    if (climate === CLIMATE.TUNDRA || climate === CLIMATE.ALPINE) {
      return { shape: 'cone', height: 6 + ((roll * 4) | 0) };
    }
    return { shape: 'round', height: 4 + ((roll * 3) | 0) };
  }

  cactusAt(x, z) {
    const h = this.heightAt(x, z);
    if (h <= SEA_LEVEL + 1.5 || h > SEA_LEVEL + 17) return false;
    if (this.climateAt(x, z, h) !== CLIMATE.DUNES) return false;
    return hash2(x, z, this.seed ^ 0x5c4) < 0.011;
  }

  // ------------------------------------------------------------ chunk life

  region(cx, cz) {
    const id = regionKey(cx, cz);
    let r = this.regions.get(id);
    if (r) return r;
    r = { id, cx, cz, cells: new Uint8Array(CHUNK_BYTES), meshes: null, stale: true };
    this.regions.set(id, r);
    if (!this.ready.has(id)) {
      this.synthesise(r);
      this.ready.add(id);
      this.flushPostbox();
    }
    return r;
  }

  hasRegion(cx, cz) { return this.regions.has(regionKey(cx, cz)); }

  retireRegion(cx, cz) {
    const id = regionKey(cx, cz);
    const r = this.regions.get(id);
    if (!r) return;
    if (r.meshes) for (const m of Object.values(r.meshes)) m.geometry.dispose();
    this.regions.delete(id);
  }

  /**
   * Build one chunk in phases. Each phase writes into `cells`; later phases
   * read what earlier ones left, which is why they are ordered the way they are.
   */
  synthesise(r) {
    this.currentRegion = r;        // target for putAcross during this pass
    const { cells } = r;
    cells.fill(AIR);
    const baseX = r.cx * CHUNK_X, baseZ = r.cz * CHUNK_Z;

    // phase 1 — solid body, caves, and the sea fill in one vertical sweep
    for (let lz = 0; lz < CHUNK_Z; lz++) {
      for (let lx = 0; lx < CHUNK_X; lx++) {
        const wx = baseX + lx, wz = baseZ + lz;
        const ground = this.heightAt(wx, wz);
        const floor = Math.floor(ground);
        const top = Math.max(floor, SEA_LEVEL);
        for (let y = 0; y <= top; y++) {
          let b = AIR;
          if (y === 0) b = BEDROCK;
          else if (y <= floor) {
            const cavern = y < floor - 1 && this.hollowAt(wx, y, wz);
            if (cavern) b = AIR;
            else if (y === floor) b = 0;                 // filled in phase 2
            else if (y > floor - 4) b = 0;               // filled in phase 2
            else b = this.veinAt(wx, y, wz) || STONE;
          } else {
            b = WATER;
          }
          if (b !== AIR) cells[cellOffset(lx, y, lz)] = b;
        }
      }
    }

    // phase 2 — surface and sub-surface dressing
    for (let lz = 0; lz < CHUNK_Z; lz++) {
      for (let lx = 0; lx < CHUNK_X; lx++) {
        const wx = baseX + lx, wz = baseZ + lz;
        const ground = this.heightAt(wx, wz);
        const floor = Math.floor(ground);
        if (floor < 1) continue;
        const climate = this.climateAt(wx, wz, ground);
        const crust = this.crustFor(climate, floor);
        const filler = this.fillerFor(climate, floor);
        for (let y = Math.max(1, floor - 3); y <= floor; y++) {
          const o = cellOffset(lx, y, lz);
          if (cells[o] !== AIR) continue;
          cells[o] = y === floor ? crust : filler;
        }
      }
    }

    // phase 3 — flora, including the part that crosses into other chunks
    for (let lz = -5; lz < CHUNK_Z + 5; lz++) {
      for (let lx = -5; lx < CHUNK_X + 5; lx++) {
        const wx = baseX + lx, wz = baseZ + lz;
        const ground = Math.floor(this.heightAt(wx, wz));
        const plant = this.floraAt(wx, wz);
        if (plant) {
          if (ground > SEA_LEVEL && ground < WORLD_H - 17) this.plant(plant, lx, ground + 1, lz);
        } else if (this.cactusAt(wx, wz)) {
          if (ground <= SEA_LEVEL || ground >= WORLD_H - 9) continue;
          const stems = 2 + ((hash2(wx, wz, this.seed ^ 0x7b) * 3) | 0);
          for (let i = 0; i < stems; i++) this.putAcross(lx, ground + 1 + i, lz, CACTUS);
        }
      }
    }

    // phase 4 — replay anything the player changed here
    this.replayJournal(r);
  }

  crustFor(climate, floor) {
    switch (climate) {
      case CLIMATE.OCEAN: return floor < SEA_LEVEL - 5 ? GRAVEL : SAND;
      case CLIMATE.SHORE: return floor <= SEA_LEVEL + 2 ? SAND : GRASS;
      case CLIMATE.DUNES: return SAND;
      case CLIMATE.ALPINE:
        if (floor > SEA_LEVEL + 33) return SNOW;
        if (floor > SEA_LEVEL + 25) return STONE;
        if (floor > SEA_LEVEL + 17) return COBBLE;
        return GRASS;
      case CLIMATE.TUNDRA: return floor > SEA_LEVEL + 12 ? SNOW : GRASS;
      default: return GRASS;
    }
  }

  fillerFor(climate, floor) {
    if (climate === CLIMATE.DUNES || climate === CLIMATE.SHORE || climate === CLIMATE.OCEAN) return SANDSTONE;
    if (climate === CLIMATE.ALPINE && floor > SEA_LEVEL + 17) return STONE;
    if (climate === CLIMATE.TUNDRA && floor > SEA_LEVEL + 12) return DIRT;
    return DIRT;
  }

  /** Write into this chunk, or post it to the neighbour when it spills out. */
  putAcross(lx, y, lz, id, force = false) {
    if (y < 1 || y >= WORLD_H) return;
    const inChunk = lx >= 0 && lx < CHUNK_X && lz >= 0 && lz < CHUNK_Z;
    if (!inChunk) {
      if (lx < -5 || lz < -5 || lx > CHUNK_X + 4 || lz > CHUNK_Z + 4) return;
      this.postbox.push(this.cx * CHUNK_X + lx, y, this.cz * CHUNK_Z + lz, id);
      return;
    }
    const r = this.currentRegion;
    const o = cellOffset(lx, y, lz);
    if (force || r.cells[o] === AIR) r.cells[o] = id;
  }

  plant(spec, lx, y, lz) {
    const self = this;
    const put = (x, yy, z, id) => self.putAcross(x, yy, z, id);
    const h = spec.height;

    if (spec.shape === 'cone') {
      for (let i = 0; i < h; i++) put(lx, y + i, lz, SPRUCE_LOG);
      let width = 0;
      for (let level = h - 1; level >= 2; level--) {
        width = Math.min(3, ((h - level) / 2) | 0);
        if (width === 0) { put(lx, y + level, lz, SPRUCE_LEAF); continue; }
        for (let dz = -width; dz <= width; dz++) {
          for (let dx = -width; dx <= width; dx++) {
            if (Math.abs(dx) === width && Math.abs(dz) === width && width > 1) continue;
            if (dx === 0 && dz === 0 && level < h) continue;
            put(lx + dx, y + level, lz + dz, SPRUCE_LEAF);
          }
        }
      }
      put(lx, y + h, lz, SPRUCE_LEAF);
      return;
    }

    if (spec.shape === 'flat') {
      for (let i = 0; i < h; i++) put(lx, y + i, lz, OAK_LOG);
      const top = y + h;
      for (let dz = -3; dz <= 3; dz++) {
        for (let dx = -3; dx <= 3; dx++) {
          if (Math.abs(dx) + Math.abs(dz) > 4) continue;
          if (dx > 0) put(lx + dx, top, lz + dz, OAK_LEAF);
          if (dz > 0) put(lx + dx, top - 1, lz + dz, OAK_LEAF);
        }
      }
      return;
    }

    for (let i = 0; i < h; i++) put(lx, y + i, lz, OAK_LOG);
    const crown = y + h - 1;
    for (let level = -1; level <= 2; level++) {
      const reach = level === 2 ? 1 : 2;
      for (let dz = -reach; dz <= reach; dz++) {
        for (let dx = -reach; dx <= reach; dx++) {
          if (dx === 0 && dz === 0 && level < 2) continue;
          if (reach > 1 && Math.abs(dx) === reach && Math.abs(dz) === reach) continue;
          put(lx + dx, crown + level, lz + dz, OAK_LEAF);
        }
      }
    }
  }

  /**
   * Re-post anything that was waiting for a neighbouring chunk to exist.
   * Items whose target is still missing go into a fresh list rather than back
   * onto the one being walked — appending to the array under the loop counter
   * never terminates.
   */
  flushPostbox() {
    if (!this.postbox.length) return;
    const queue = this.postbox;
    this.postbox = [];
    const carry = [];
    for (let i = 0; i < queue.length; i += 4) {
      const wx = queue[i], y = queue[i + 1], wz = queue[i + 2], id = queue[i + 3];
      const cx = Math.floor(wx / CHUNK_X), cz = Math.floor(wz / CHUNK_Z);
      const rid = regionKey(cx, cz);
      const r = this.regions.get(rid);
      if (!r || !this.ready.has(rid)) {
        if (carry.length < 400000) carry.push(wx, y, wz, id);
        continue;
      }
      const o = cellOffset(wx - cx * CHUNK_X, y, wz - cz * CHUNK_Z);
      if (r.cells[o] === AIR) r.cells[o] = id;
      r.stale = true;
    }
    this.postbox = carry;
  }

  replayJournal(r) {
    if (!this.journal.size) return;
    const baseX = r.cx * CHUNK_X, baseZ = r.cz * CHUNK_Z;
    for (const [key, id] of this.journal) {
      const c = key.indexOf(',');
      const c2 = key.indexOf(',', c + 1);
      const x = +key.slice(0, c), y = +key.slice(c + 1, c2), z = +key.slice(c2 + 1);
      if (x < baseX || x >= baseX + CHUNK_X || z < baseZ || z >= baseZ + CHUNK_Z) continue;
      r.cells[cellOffset(x - baseX, y, z - baseZ)] = id;
    }
  }

  // -------------------------------------------------------------- accessors

  get(x, y, z) {
    if (y < 0 || y >= WORLD_H) return AIR;
    const cx = Math.floor(x / CHUNK_X), cz = Math.floor(z / CHUNK_Z);
    const r = this.regions.get(regionKey(cx, cz));
    if (!r) return AIR;
    return r.cells[cellOffset(x - cx * CHUNK_X, y, z - cz * CHUNK_Z)];
  }

  put(x, y, z, id) {
    if (y < 1 || y >= WORLD_H) return false;
    const cx = Math.floor(x / CHUNK_X), cz = Math.floor(z / CHUNK_Z);
    const id2 = regionKey(cx, cz);
    const r = this.regions.get(id2);
    if (!r) return false;
    const o = cellOffset(x - cx * CHUNK_X, y, z - cz * CHUNK_Z);
    if (r.cells[o] === id) return false;
    r.cells[o] = id;
    r.stale = true;
    this.journal.set(`${x},${y},${z}`, id);
    return true;
  }

  /** Topmost non-air, non-water block in a column. */
  surfaceY(x, z) {
    for (let y = WORLD_H - 1; y >= 0; y--) {
      const b = this.get(x, y, z);
      if (b !== AIR && b !== WATER) return y;
    }
    return 0;
  }

  isLoaded(x, z) {
    return this.regions.has(regionKey(Math.floor(x / CHUNK_X), Math.floor(z / CHUNK_Z)));
  }
}

// `putAcross` needs to know which region is being built; see synthesise().
export { CLIMATE_IDS, blockTable, AIR, WATER };
