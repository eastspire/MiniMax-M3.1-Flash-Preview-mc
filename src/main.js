// Application shell: renderer, terrain material, streaming, input, game loop.
//
// Structure is deliberately flat — a `stage` object owns the three.js side, a
// `streamer` owns chunk residency, and a `frame` function drives everything.
// The debug API at the bottom exists for the screenshot harness and is the only
// way the tooling reaches into the running game.

import * as THREE from '../vendor/three.module.js';
import {
  AIR, WATER, GRASS, DIRT, STONE, COBBLE, SAND, SNOW, PLANK, BRICK, GLASS,
  OAK_LOG, OAK_LEAF, GRAVEL, blockTable, blockName, createTextureArray,
} from './blocks.js';
import { World, CHUNK_X, CHUNK_Z, WORLD_H, SEA_LEVEL, regionKey } from './world.js';
import { buildChunkMeshes } from './mesher.js';
import { Player } from './player.js';
import { SkyDome, DAY_SECONDS, clockLabel } from './sky.js';
import { Hud } from './hud.js';

const query = new URLSearchParams(location.search);
const readNumber = (key, fallback) => (query.has(key) ? Number(query.get(key)) : fallback);

const SEED = readNumber('seed', 20260927);
const RADIUS = Math.max(2, Math.min(12, readNumber('dist', 8)));
const ORIGIN_X = readNumber('x', 0);
const ORIGIN_Z = readNumber('z', 0);
const HAZE_OFF = query.get('fog') === '0';
const TITLE_OFF = query.get('overlay') === '0';
const SPIN = query.get('spin') === '1';
const CLOCK_LOCK = query.has('t') ? readNumber('t', 0.3) : null;
// Open just after sunrise, so the first thing on screen is the world.
const CLOCK_START = 0.312;

const BELT = [GRASS, DIRT, STONE, COBBLE, SAND, PLANK, GLASS, OAK_LOG, OAK_LEAF, BRICK, SNOW, GRAVEL];

// ---------------------------------------------------------------- shaders

const TERRAIN_VERTEX = `
attribute vec3 meta;              // x: texture layer, y: baked occlusion, z: face id
varying vec2 vTile;
varying vec3 vMeta;
varying vec3 vWorldNormal;
varying float vDepth;
void main() {
  vTile = uv;
  vMeta = meta;
  vWorldNormal = normalize(mat3(modelMatrix) * normal);
  vec4 eye = modelViewMatrix * vec4(position, 1.0);
  vDepth = -eye.z;
  gl_Position = projectionMatrix * eye;
}`;

const TERRAIN_FRAGMENT = `
precision highp float;
precision highp sampler2DArray;
layout(location = 0) out vec4 outColor;

uniform sampler2DArray slices;
uniform vec3 sunRay;
uniform vec3 sunLight;
uniform vec3 skyFill;
uniform vec3 hazeColor;
uniform float hazeNear;
uniform float hazeFar;
uniform float cutout;             // alpha-test threshold, 0 for solid geometry
uniform float dim;                // extra opacity for the fluid pass
uniform float swell;              // 1 for the animated water surface
uniform float clock;

varying vec2 vTile;
varying vec3 vMeta;
varying vec3 vWorldNormal;
varying float vDepth;

void main() {
  vec2 uv = vTile;
  if (swell > 0.5) {
    uv.y += sin(clock * 0.62 + uv.x * 6.2831) * 0.030
          + sin(clock * 0.41 + uv.x * 12.566) * 0.016;
  }
  vec4 texel = texture(slices, vec3(uv, vMeta.x));
  if (texel.a < cutout) discard;

  vec3 n = normalize(vWorldNormal);
  float toSun = max(dot(n, normalize(sunRay)), 0.0);
  // Faces pointing up catch more sky than faces pointing down. Without this a
  // floor and a ceiling of the same material shade identically.
  float facing = 0.58 + 0.42 * (n.y * 0.5 + 0.5);

  vec3 lit = texel.rgb * (skyFill * facing * 1.55 + sunLight * toSun * 0.44) * vMeta.y;
  float haze = smoothstep(hazeNear, hazeFar, vDepth);
  lit = mix(lit, hazeColor, haze);

  outColor = vec4(lit, texel.a * dim);
}`;

function terrainMaterial(slices, options = {}) {
  return new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: {
      slices: { value: slices },
      sunRay: { value: new THREE.Vector3(0, 1, 0) },
      sunLight: { value: new THREE.Color(1, 1, 1) },
      skyFill: { value: new THREE.Color(0.3, 0.33, 0.38) },
      hazeColor: { value: new THREE.Color(0.73, 0.82, 0.94) },
      hazeNear: { value: 60 },
      hazeFar: { value: 160 },
      cutout: { value: options.cutout ?? 0 },
      dim: { value: options.dim ?? 1 },
      swell: { value: options.swell ? 1 : 0 },
      clock: { value: 0 },
    },
    vertexShader: TERRAIN_VERTEX,
    fragmentShader: TERRAIN_FRAGMENT,
    transparent: !!options.transparent,
    depthWrite: options.depthWrite !== false,
  });
}

// ------------------------------------------------------------------ stage

const canvas = document.getElementById('viewport');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.setClearColor(0x8ab4e8, 1);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(72, innerWidth / innerHeight, 0.1, 1400);

const { texture: slices, averages } = createTextureArray();
const passMaterials = [
  terrainMaterial(slices),                                  // solid
  terrainMaterial(slices, { cutout: 0.5 }),                 // leaves, glass
  // The fluid pass writes depth. Without it, quads blend in draw order
  // regardless of distance, so a sheet of water far away that happens to be
  // rasterised after a nearer one double-blends over it and the surface
  // breaks into patches of uneven brightness.
  terrainMaterial(slices, { transparent: true, dim: 0.7, swell: true }),
];
const MESH_KEYS = ['opaque', 'alpha', 'fluid'];

const world = new World(SEED);
const player = new Player(world);
const dome = new SkyDome(scene);
const hud = new Hud();
hud.attachAverages(averages);
hud.loadBelt(BELT);

const terrainRoot = new THREE.Group();
scene.add(terrainRoot);

const heldBlock = new THREE.Mesh(
  new THREE.BoxGeometry(0.33, 0.33, 0.33),
  new THREE.MeshBasicMaterial({ color: 0xffffff }),
);
scene.add(heldBlock);
let inHand = BELT[0];

// --------------------------------------------------------------- streamer

/**
 * Keeps a disc of chunks resident around the player. Work is done in small
 * time-sliced batches so streaming never blocks the render loop, and chunks
 * are retired only once they are comfortably outside the disc.
 */
class Streamer {
  constructor() {
    this.desired = new Set();
    this.todo = [];
    this.lastColumn = null;
  }

  /** Recompute the resident set around a column. */
  recentre(px, pz) {
    const cx = Math.floor(px / CHUNK_X), cz = Math.floor(pz / CHUNK_Z);
    this.desired.clear();
    const reach = RADIUS * RADIUS + RADIUS;
    for (let dz = -RADIUS; dz <= RADIUS; dz++) {
      for (let dx = -RADIUS; dx <= RADIUS; dx++) {
        if (dx * dx + dz * dz > reach) continue;
        this.desired.add(regionKey(cx + dx, cz + dz));
      }
    }
    this.todo = [];
    const pending = [];
    for (const id of this.desired) {
      const [x, z] = id.split('|').map(Number);
      if (world.hasRegion(x, z)) continue;
      pending.push([(x - cx) ** 2 + (z - cz) ** 2, x, z]);
    }
    pending.sort((a, b) => a[0] - b[0]);
    for (const [, x, z] of pending) this.todo.push([x, z]);
    this.retire(cx, cz);
  }

  retire(cx, cz) {
    const limit = (RADIUS + 2) ** 2;
    for (const id of [...world.regions.keys()]) {
      const [x, z] = id.split('|').map(Number);
      if ((x - cx) ** 2 + (z - cz) ** 2 > limit) world.retireRegion(x, z);
    }
  }

  /** Do up to `budgetMs` of generation and meshing. */
  pump(budgetMs) {
    const deadline = performance.now() + budgetMs;
    while (this.todo.length && performance.now() < deadline) {
      const [cx, cz] = this.todo.shift();
      const region = world.region(cx, cz);
      this.rebuild(region);
    }
    for (const region of world.regions.values()) {
      if (region.stale && performance.now() < deadline) this.rebuild(region);
    }
  }

  rebuild(region) {
    const built = buildChunkMeshes(region, (x, y, z) => world.get(x, y, z));
    if (region.meshes) {
      for (const key of MESH_KEYS) {
        const old = region.meshes[key];
        if (!old) continue;
        terrainRoot.remove(old);
        old.geometry.dispose();
      }
    }
    const meshes = {};
    MESH_KEYS.forEach((key, i) => {
      if (!built[key]) return;
      meshes[key] = new THREE.Mesh(built[key], passMaterials[i]);
      terrainRoot.add(meshes[key]);
    });
    region.meshes = meshes;
    region.stale = false;
  }

  settled() { return this.todo.length === 0; }
}

const streamer = new Streamer();

// ------------------------------------------------------------------ input

let playing = false;
let hasLock = false;
let lockDenied = false;
let dragging = false;
const down = new Set();
player.keys = down;

const titleEl = document.getElementById('title');
const dismissTitle = () => { titleEl.dataset.done = '1'; };

function reportLockFailure() {
  lockDenied = true;
  if (!playing) return;
  dismissTitle();
  hud.say('Pointer lock refused — drag to look');
}

function askForLock() {
  const plain = () => {
    try {
      const attempt = canvas.requestPointerLock();
      if (attempt && typeof attempt.catch === 'function') attempt.catch(reportLockFailure);
    } catch { reportLockFailure(); }
  };
  try {
    const attempt = canvas.requestPointerLock();
    if (attempt && typeof attempt.catch === 'function') attempt.catch(plain);
  } catch { plain(); }
}

function begin() {
  playing = true;
  askForLock();
  // If no lock arrives promptly the browser is not going to give us one, so
  // switch to drag-to-look rather than stranding the player on the title.
  setTimeout(() => {
    if (hasLock) return;
    lockDenied = true;
    dismissTitle();
  }, 400);
}

document.getElementById('begin').addEventListener('click', begin);
titleEl.addEventListener('click', (e) => { if (e.target === titleEl) begin(); });
document.addEventListener('pointerlockerror', reportLockFailure);
document.addEventListener('pointerlockchange', () => {
  hasLock = document.pointerLockElement === canvas;
  if (hasLock) {
    lockDenied = false;
    dismissTitle();
  } else if (!playing || lockDenied) {
    dismissTitle();
  } else {
    titleEl.dataset.done = '0';
  }
  if (!hasLock) down.clear();
});

addEventListener('mousemove', (e) => {
  if (!playing) return;
  if (hasLock) player.turn(e.movementX || 0, e.movementY || 0);
  else if (dragging) player.turn(e.movementX || 0, e.movementY || 0);
});

canvas.addEventListener('mousedown', (e) => {
  if (!playing) { begin(); return; }
  if (!hasLock && !lockDenied) { askForLock(); return; }
  if (e.button === 0) {
    if (lockDenied) dragging = true;
    cutting = { spot: player.trace(), worn: 0 };
  }
  if (e.button === 2 && placeCooldown <= 0) { build(); placeCooldown = 0.2; }
  if (e.button === 1) {
    const hit = player.trace(6);
    if (!hit) return;
    const at = BELT.indexOf(hit.id);
    if (at >= 0) { hud.choose(at); takeBlock(BELT[at]); }
  }
});
addEventListener('mouseup', (e) => {
  dragging = false;
  if (e.button === 0) cutting = null;
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

addEventListener('wheel', (e) => {
  if (!playing) return;
  hud.choose(hud.picked + (e.deltaY > 0 ? 1 : -1));
  takeBlock(BELT[hud.picked]);
}, { passive: true });

const BELT_KEYS = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6',
  'Digit7', 'Digit8', 'Digit9', 'Digit0', 'Minus', 'Equal'];

addEventListener('keydown', (e) => {
  if (e.repeat) return;
  down.add(e.code);
  if (e.code === 'KeyF') {
    player.flying = !player.flying;
    player.speed.y = 0;
    hud.say(player.flying ? 'Flight on' : 'Flight off');
  }
  if (e.code === 'F3') { e.preventDefault(); hud.setTrimmed(hud.shell.dataset.trim !== '1'); }
  if (e.code === 'F1') {
    e.preventDefault();
    hud.setVisible(hud.shell.hidden);
  }
  const slot = BELT_KEYS.indexOf(e.code);
  if (slot >= 0 && slot < BELT.length) { hud.choose(slot); takeBlock(BELT[slot]); }
  if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space'].includes(e.code)) e.preventDefault();
});
addEventListener('keyup', (e) => down.delete(e.code));
addEventListener('blur', () => down.clear());

function takeBlock(id) {
  inHand = id;
  const avg = averages[blockTable[id].textureFor(2)] || [1, 1, 1];
  heldBlock.material.color.setRGB(avg[0], avg[1], avg[2]);
}

let cutting = null;
let placeCooldown = 0;

function build() {
  const hit = player.trace();
  if (!hit) return;
  const [x, y, z] = hit.stand;
  if (!player.placeable(x, y, z)) return;
  world.put(x, y, z, inHand);
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const region = world.regions.get(regionKey(
        Math.floor(x / CHUNK_X) + dx, Math.floor(z / CHUNK_Z) + dz));
      if (region) region.stale = true;
    }
  }
}

// ------------------------------------------------------------------- loop

let lastStamp = performance.now();
let runningSeconds = 0;
let framesPerSecond = 0;
let windowSeconds = 0, windowFrames = 0;
let anchorColumn = null;
let bootComplete = false;

const KEEP_RADIUS_BLOCKS = (RADIUS + 2) * CHUNK_X;
// Fog has to finish before the outermost chunk we keep, or the streaming edge
// shows up as a hard line of half-faded terrain.
const HAZE_END = Math.min(KEEP_RADIUS_BLOCKS - CHUNK_X, 36 + RADIUS * CHUNK_X);

function tick(stamp) {
  requestAnimationFrame(tick);
  const wall = (stamp - lastStamp) / 1000;
  lastStamp = stamp;
  const dt = Math.min(0.05, wall);
  runningSeconds += dt;

  windowSeconds += wall;
  windowFrames++;
  if (windowSeconds > 0.5) {
    framesPerSecond = windowFrames / windowSeconds;
    windowSeconds = 0; windowFrames = 0;
  }

  if (SPIN && playing) player.yaw += dt * 0.2;
  if (playing) player.update(dt);

  const column = `${Math.floor(player.feet.x / CHUNK_X)}|${Math.floor(player.feet.z / CHUNK_Z)}`;
  if (column !== anchorColumn) {
    anchorColumn = column;
    streamer.recentre(player.feet.x, player.feet.z);
  }
  streamer.pump(9);

  const clock = CLOCK_LOCK === null ? (CLOCK_START + runningSeconds / DAY_SECONDS) % 1 : CLOCK_LOCK;
  const light = dome.evaluate(clock, camera);

  for (const material of passMaterials) {
    const u = material.uniforms;
    u.sunRay.value.copy(light.ray);
    u.sunLight.value.setRGB(light.direct[0], light.direct[1], light.direct[2]);
    u.skyFill.value.setRGB(light.fill[0], light.fill[1], light.fill[2]);
    u.hazeColor.value.setRGB(light.haze[0], light.haze[1], light.haze[2]);
    u.hazeNear.value = HAZE_END * 0.46;
    u.hazeFar.value = HAZE_OFF ? 1e6 : HAZE_END;
    u.clock.value = runningSeconds;
  }

  hud.setSubmerged(player.swimming);

  // the held block bobs with the walk cycle
  if (playing) {
    const sway = Math.sin(player.gait) * 0.021 * player.gaitAmount;
    const rise = Math.abs(Math.cos(player.gait)) * 0.019 * player.gaitAmount;
    heldBlock.position.set(0.41 + sway, -0.37 + rise, -0.6);
    heldBlock.rotation.set(0.19 + rise, -0.52, 0.11);
    heldBlock.visible = true;
  } else {
    heldBlock.visible = false;
  }

  // mining: hold the button and accumulate progress against block hardness
  if (cutting && playing) {
    const current = player.trace();
    const same = current && cutting.spot
      && current.x === cutting.spot.x && current.y === cutting.spot.y && current.z === cutting.spot.z;
    if (same) {
      cutting.worn += dt / Math.max(0.05, blockTable[current.id].hardness);
      if (cutting.worn >= 1) {
        world.put(current.x, current.y, current.z, AIR);
        markNeighbours(current.x, current.y, current.z);
        cutting = null;
      }
    } else if (current) {
      cutting = { spot: current, worn: 0 };
    } else {
      cutting = null;
    }
  }
  if (placeCooldown > 0) placeCooldown -= dt;

  // camera. Height comes from the player's eased view height so one-block
  // terrain steps ramp instead of jolting; the walk bob rides on top of that.
  const bobY = Math.sin(player.gait * 2) * 0.034 * player.gaitAmount;
  const eye = player.viewEye(dt) + bobY;
  camera.position.set(player.feet.x, eye, player.feet.z);
  const look = player.forward();
  camera.lookAt(camera.position.x + look.x, camera.position.y + look.y, camera.position.z + look.z);

  const aimed = player.trace();
  hud.writeReadout([
    `<b>seed</b> ${SEED} &middot; <b>time</b> ${clockLabel(clock)}`,
    `xyz ${player.feet.x.toFixed(1)} / ${player.feet.y.toFixed(1)} / ${player.feet.z.toFixed(1)}`,
    `land <b>${world.climateNameAt(Math.floor(player.feet.x), Math.floor(player.feet.z))}</b> &middot; ${light.brightness > 0.35 ? 'day' : 'night'}`,
    `chunks ${world.regions.size} &middot; queue ${streamer.todo.length}`,
    `draws ${renderer.info.render.calls} &middot; tris ${(renderer.info.render.triangles / 1000).toFixed(0)}k &middot; ${framesPerSecond.toFixed(0)} fps`,
    `mode ${player.flying ? 'fly' : player.swimming ? 'swim' : player.grounded ? 'walk' : 'fall'}`,
    `aim ${aimed ? `${blockName(aimed.id)} @ ${aimed.x} ${aimed.y} ${aimed.z}` : '—'}`,
  ]);

  if (!bootComplete && streamer.settled() && world.regions.size >= streamer.desired.size) {
    bootComplete = true;
    hud.finishBoot();
  }
  const progress = Math.max(0, Math.min(1, 1 - streamer.todo.length / Math.max(1, streamer.desired.size)));
  hud.setProgress(progress, bootComplete
    ? `${world.regions.size} chunks · ${framesPerSecond.toFixed(0)} fps`
    : `carving terrain — ${(progress * 100).toFixed(0)}%`);

  renderer.render(scene, camera);
}

function markNeighbours(x, y, z) {
  const cx = Math.floor(x / CHUNK_X), cz = Math.floor(z / CHUNK_Z);
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const region = world.regions.get(regionKey(cx + dx, cz + dz));
      if (region) region.stale = true;
    }
  }
}

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight, false);
});

// ------------------------------------------------------------------- boot

// Choose the site from noise first, load its neighbourhood, then drop the
// player in — settling needs real blocks underneath.
const home = player.chooseSite(ORIGIN_X, ORIGIN_Z);
streamer.recentre(home.x, home.z);

const bootDeadline = performance.now() + 1900;
while (!streamer.settled() && performance.now() < bootDeadline) streamer.pump(30);
for (const region of world.regions.values()) if (region.stale) streamer.rebuild(region);

player.place(home);
anchorColumn = `${Math.floor(player.feet.x / CHUNK_X)}|${Math.floor(player.feet.z / CHUNK_Z)}`;
hud.finishBoot();
if (TITLE_OFF) dismissTitle();
takeBlock(BELT[0]);
requestAnimationFrame(tick);

// ------------------------------------------------------------- debug hook

window.__game = {
  world, player, camera, renderer, scene, dome, hud,
  settled: () => streamer.settled(),
  report: () => ({
    chunks: world.regions.size,
    draws: renderer.info.render.calls,
    tris: renderer.info.render.calls ? renderer.info.render.triangles : 0,
    fps: Number(framesPerSecond.toFixed(1)),
    at: player.feet.toArray().map((v) => Number(v.toFixed(1))),
    land: world.climateNameAt(Math.floor(player.feet.x), Math.floor(player.feet.z)),
  }),
  goTo(x, y, z) { player.feet.set(x, y, z); player.speed.set(0, 0, 0); streamer.recentre(x, z); },
  setYawPitch(yaw, pitch) { player.yaw = yaw; player.pitch = pitch; },
  setYawToward(x, y, z) { player.aimAt(x, y, z); },
  freezeClock(t) { dome.pinned = t; },
  releaseClock() { dome.pinned = null; },
  /** Nearest reasonably level 9x9 patch, for staging builds. */
  levelGround(cx, cz, r = 60) {
    let best = null;
    for (let z = -r; z <= r; z += 3) {
      for (let x = -r; x <= r; x += 3) {
        const px = cx + x, pz = cz + z;
        const h = world.heightAt(px, pz);
        if (h <= SEA_LEVEL + 2 || h > SEA_LEVEL + 19) continue;
        let lowest = Infinity, highest = -Infinity;
        for (let dz = -6; dz <= 6; dz += 3) {
          for (let dx = -6; dx <= 6; dx += 3) {
            const hh = world.heightAt(px + dx, pz + dz);
            lowest = Math.min(lowest, hh);
            highest = Math.max(highest, hh);
          }
        }
        const spread = highest - lowest;
        const cost = spread * 10 - Math.hypot(x, z) * 0.02;
        if (!best || cost < best.cost) best = { x: px, z: pz, h, spread, cost };
      }
    }
    return best;
  },
  /** Highest column within a radius. */
  highPoint(cx, cz, r) {
    let best = null;
    for (let z = -r; z <= r; z += 3) {
      for (let x = -r; x <= r; x += 3) {
        const h = world.heightAt(cx + x, cz + z);
        if (!best || h > best.h) best = { x: cx + x, z: cz + z, h };
      }
    }
    return best;
  },
  landAt(x, z) { return world.climateNameAt(x, z); },
  pickSite(x, z) { return player.chooseSite(x, z); },
};
