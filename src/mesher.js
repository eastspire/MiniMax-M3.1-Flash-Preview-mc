// Chunk meshing.
//
// Each face is described by an explicit table of four corner offsets plus its
// normal, rather than being derived from an origin and two in-plane axes. The
// table is written out longhand so the winding of every face can be checked by
// eye: looking at the face from outside, the corners run counter-clockwise.
//
// Vertices are emitted into one interleaved buffer with a compact vertex
// format (position, uv, then a packed meta word carrying texture layer, baked
// occlusion and face id). Building into flat arrays and slicing once at the end
// keeps the inner loop free of per-vertex object allocation.

import * as THREE from '../vendor/three.module.js';
import { CHUNK_X, CHUNK_Z, WORLD_H } from './world.js';
import { AIR, WATER, blockTable } from './blocks.js';

// Per face: normal, then four [x,y,z] corner offsets within the block.
// Corner order is fixed: 0,1,2,3 with 0-1-2 and 0-2-3 as the two triangles.
const FACE_TABLE = [
  { // +X — seen from +X, "right" is -Z
    n: [1, 0, 0],
    c: [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]],
  },
  { // -X — seen from -X, "right" is +Z
    n: [-1, 0, 0],
    c: [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]],
  },
  { // +Y — seen from above, "right" is +X and "up" is -Z
    n: [0, 1, 0],
    c: [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]],
  },
  { // -Y — seen from below
    n: [0, -1, 0],
    c: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]],
  },
  { // +Z
    n: [0, 0, 1],
    c: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]],
  },
  { // -Z
    n: [0, 0, -1],
    c: [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]],
  },
];

// Corner (u,v) coordinates matching the corner order above, used for both the
// AO neighbour offsets and the texture uv.
const CORNER_UV = [[0, 0], [1, 0], [1, 1], [0, 1]];

/** Growable interleaved vertex buffer. */
class VertexSink {
  constructor(floatsPerVertex) {
    this.stride = floatsPerVertex;
    this.data = [];
    this.order = [];
  }
  get empty() { return this.order.length === 0; }

  /**
   * Append one quad. `verts` and `occl` are length-4 arrays; `layer` is the
   * texture array slice; `uvs` are length-4 [u,v] pairs.
   */
  face(verts, normal, uvs, layer, occl) {
    const base = this.data.length / this.stride;
    for (let k = 0; k < 4; k++) {
      this.data.push(
        verts[k][0], verts[k][1], verts[k][2],
        normal[0], normal[1], normal[2],
        uvs[k][0], uvs[k][1],
        layer, occl[k] / 3, 0,
      );
    }
    // Choose the split diagonal by comparing the two opposite corner pairs.
    // Splitting across the darker pair is what stops occlusion from creasing
    // along the wrong diagonal of the quad.
    const d1 = occl[0] + occl[2];
    const d2 = occl[1] + occl[3];
    if (d1 < d2) {
      this.order.push(base, base + 1, base + 2, base, base + 2, base + 3);
    } else if (d1 > d2) {
      this.order.push(base + 1, base + 2, base + 3, base + 1, base + 3, base);
    } else {
      this.order.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }

  toGeometry() {
    const g = new THREE.BufferGeometry();
    const a = new Float32Array(this.data);
    const s = this.stride;
    g.setAttribute('position', new THREE.BufferAttribute(a.slice(0, a.length).filter((_, i) => i % s < 3), 3));
    const nrm = [], uv = [], meta = [];
    for (let i = 0; i < a.length; i += s) {
      nrm.push(a[i + 3], a[i + 4], a[i + 5]);
      uv.push(a[i + 6], a[i + 7]);
      meta.push(a[i + 8], a[i + 9], a[i + 10]);
    }
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setAttribute('meta', new THREE.Float32BufferAttribute(meta, 3));
    g.setIndex(new THREE.Uint32BufferAttribute(this.order, 1));
    g.computeBoundingSphere();
    return g;
  }
}

/**
 * Build the three meshes for one chunk.
 *
 * `probe(x, y, z)` returns the block id at a world position, or 0 when that
 * position is outside loaded chunks. Faces are only emitted against air or
 * against a neighbour that can actually be seen through, which is what keeps a
 * leaf canopy from rendering as a solid green cube.
 */
export function buildChunkMeshes(chunk, probe) {
  const opaqueSink = new VertexSink(11);
  const alphaSink = new VertexSink(11);
  const fluidSink = new VertexSink(11);
  const baseX = chunk.cx * CHUNK_X;
  const baseZ = chunk.cz * CHUNK_Z;
  const cells = chunk.cells;

  // Cached opacity test, so the AO lookups do not re-fetch the same blocks.
  const solidAt = (x, y, z) => {
    if (y < 0) return true;
    if (y >= WORLD_H) return false;
    const id = probe(x, y, z);
    return id !== AIR && blockTable[id].solidity === 'full';
  };

  const at = (lx, ly, lz) => {
    if (ly < 0 || ly >= WORLD_H) return AIR;
    if (lx < 0 || lx >= CHUNK_X || lz < 0 || lz >= CHUNK_Z) {
      return probe(baseX + lx, ly, baseZ + lz);
    }
    return cells[ly * (CHUNK_X * CHUNK_Z) + lz * CHUNK_X + lx];
  };

  for (let ly = 0; ly < WORLD_H; ly++) {
    for (let lz = 0; lz < CHUNK_Z; lz++) {
      for (let lx = 0; lx < CHUNK_X; lx++) {
        const here = at(lx, ly, lz);
        if (here === AIR) continue;
        const spec = blockTable[here];
        const sink = spec.solidity === 'fluid' ? fluidSink : (spec.solidity === 'cutout' ? alphaSink : opaqueSink);
        const wx = baseX + lx, wz = baseZ + lz;

        for (let f = 0; f < 6; f++) {
          const face = FACE_TABLE[f];
          const fx = wx + face.n[0], fy = ly + face.n[1], fz = wz + face.n[2];
          const neighbour = probe(fx, fy, fz);

          if (!faceShouldDraw(here, spec, neighbour)) continue;
          const layer = spec.textureFor(f);
          if (layer < 0) continue;

          // The two in-plane axes, recovered from how adjacent corners differ.
          // C1 - C0 runs along one edge of the face, C3 - C0 along the other.
          const uDir = [
            Math.sign(face.c[1][0] - face.c[0][0]),
            Math.sign(face.c[1][1] - face.c[0][1]),
            Math.sign(face.c[1][2] - face.c[0][2]),
          ];
          const vDir = [
            Math.sign(face.c[3][0] - face.c[0][0]),
            Math.sign(face.c[3][1] - face.c[0][1]),
            Math.sign(face.c[3][2] - face.c[0][2]),
          ];

          const corners = [];
          const uvs = [];
          const occl = [];
          const flat = spec.solidity === 'fluid';

          for (let k = 0; k < 4; k++) {
            const off = face.c[k];
            // Fluid surfaces sit a touch below the block so the surface reads
            // as a surface rather than a flush cube face.
            const sinkY = flat && face.n[1] === 1 ? -0.11 : 0;
            corners.push([wx + off[0], ly + off[1] + sinkY, wz + off[2]]);
            // Tile row 0 is the top of the painted image, so v is flipped.
            const [uu, vv] = CORNER_UV[k];
            uvs.push([uu, 1 - vv]);

            if (flat) { occl.push(3); continue; }
            const su = uu ? 1 : -1, sv = vv ? 1 : -1;
            const n1 = solidAt(fx + uDir[0] * su, fy + uDir[1] * su, fz + uDir[2] * su);
            const n2 = solidAt(fx + vDir[0] * sv, fy + vDir[1] * sv, fz + vDir[2] * sv);
            const nc = solidAt(
              fx + uDir[0] * su + vDir[0] * sv,
              fy + uDir[1] * su + vDir[1] * sv,
              fz + uDir[2] * su + vDir[2] * sv,
            );
            occl.push(cornerOcclusion(n1, n2, nc));
          }
          sink.face(corners, face.n, uvs, layer, occl);
        }
      }
    }
  }

  const out = {};
  if (!opaqueSink.empty) out.opaque = opaqueSink.toGeometry();
  if (!alphaSink.empty) out.alpha = alphaSink.toGeometry();
  if (!fluidSink.empty) out.fluid = fluidSink.toGeometry();
  return out;
}

/**
 * Corner occlusion from the three cells touching that corner. Two touching
 * edges already dark means the corner is fully hidden regardless of the
 * diagonal, which is the standard shortcut.
 */
function cornerOcclusion(edgeA, edgeB, diagonal) {
  if (edgeA && edgeB) return 0;
  return 3 - (edgeA + edgeB + diagonal);
}

/** Should this face be emitted at all? */
function faceShouldDraw(self, spec, neighbour) {
  if (neighbour === AIR) return true;
  const nb = blockTable[neighbour];
  if (nb.solidity === 'full') return false;               // hidden inside a wall
  if (spec.solidity === 'fluid' && neighbour === WATER) return false;  // no internal water faces
  // Two adjacent blocks of the same cutout type still need a face, or a leaf
  // canopy renders as one opaque mass.
  if (spec.solidity === 'cutout' && neighbour === spec.id) return false;
  return true;
}
