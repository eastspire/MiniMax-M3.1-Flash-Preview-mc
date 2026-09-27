// First-person player.
//
// Physics runs on a fixed 60 Hz accumulator rather than on the render frame,
// so behaviour does not change with frame rate and cannot tunnel through the
// floor on a long frame. Collision resolves one axis at a time against an
// explicit AABB overlap test, which is what produces wall-sliding.
//
// Looking targets the block under the crosshair with a stepped ray march
// followed by a bisection refinement. That is slower than an incremental
// DDA but it is far easier to reason about, and the reach is only a few blocks.

import * as THREE from '../vendor/three.module.js';
import { AIR, WATER, blockTable } from './blocks.js';
import { WORLD_H, SEA_LEVEL } from './world.js';

const BODY_W = 0.62;          // player box width and depth
const BODY_T = 1.79;          // standing height
const EYE_DROP = 0.17;        // eye below the top of the head
const HALF_W = BODY_W / 2;

const TICK = 1 / 60;
const PULL = 34;              // gravity, blocks/s^2
const LAUNCH = 9.4;           // jump impulse
const SPEED_WALK = 4.4;
const SPEED_RUN = 7.1;
const SPEED_FLY = 13.5;
const SPEED_SWIM = 3.2;
const LOOK_SCALE = 0.0019;    // radians per pixel
const PITCH_STOP = 0.0008;    // keeps the camera off exactly vertical
const REACH = 5.4;
const TERMINAL = 62;

// A compass angle maps to the world direction (cos, sin), while the player's
// forward vector is (-sin yaw, -cos yaw); converting between them is this flip.
const yawForAngle = (angle) => Math.atan2(-Math.cos(angle), -Math.sin(angle));

const LOOK_KEYS = {
  KeyW: [0, 1], ArrowUp: [0, 1],
  KeyS: [0, -1], ArrowDown: [0, -1],
  KeyA: [-1, 0], ArrowLeft: [-1, 0],
  KeyD: [1, 0], ArrowRight: [1, 0],
};

export class Player {
  constructor(world) {
    this.world = world;
    this.feet = new THREE.Vector3(0.5, 90, 0.5);
    this.speed = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = 0;
    this.grounded = false;
    this.flying = false;
    this.sprinting = false;
    this.swimming = false;
    this.gait = 0;
    this.gaitAmount = 0;
    this.keys = new Set();
    this._carry = 0;
    this._viewY = null;      // eased camera height; null until first use
  }

  get eyeY() { return this.feet.y + BODY_T - EYE_DROP; }
  get bodyTop() { return this.feet.y + BODY_T; }

  /**
   * Camera height, eased toward the true eye height.
   *
   * Collision resolution is discrete: walking over a one-block step teleports
   * the feet up a block, and a camera bound straight to that position jolts a
   * full block in a single frame. Easing it turns each step into a short ramp.
   * Large changes still snap, otherwise a long fall would leave the camera
   * trailing behind the player.
   */
  viewEye(dt) {
    const target = this.eyeY;
    if (this._viewY === null || Math.abs(target - this._viewY) > 2.5) {
      this._viewY = target;
    } else {
      this._viewY += (target - this._viewY) * Math.min(1, dt * 18);
    }
    return this._viewY;
  }

  // ------------------------------------------------------------- looking

  /** Rotate the view. `dx`/`dy` are pixel deltas. */
  turn(dx, dy) {
    this.yaw -= dx * LOOK_SCALE;
    const stop = Math.PI / 2 - PITCH_STOP;
    this.pitch = Math.max(-stop, Math.min(stop, this.pitch - dy * LOOK_SCALE));
  }

  aimAt(x, y, z) {
    const ex = x - this.feet.x;
    const ey = y - this.eyeY;
    const ez = z - this.feet.z;
    this.yaw = Math.atan2(-ex, -ez);
    this.pitch = Math.atan2(ey, Math.hypot(ex, ez));
  }

  forward(out = new THREE.Vector3()) {
    const flat = Math.cos(this.pitch);
    return out.set(-Math.sin(this.yaw) * flat, Math.sin(this.pitch), -Math.cos(this.yaw) * flat);
  }

  // ----------------------------------------------------------- collision

  /** Does the player AABB at `p` intersect any solid voxel? */
  blocked(p) {
    const x0 = Math.floor(p.x - HALF_W), x1 = Math.floor(p.x + HALF_W);
    const y0 = Math.floor(p.y), y1 = Math.floor(p.y + BODY_T - 0.001);
    const z0 = Math.floor(p.z - HALF_W), z1 = Math.floor(p.z + HALF_W);
    for (let y = y0; y <= y1; y++) {
      if (y < 0) return true;
      if (y >= WORLD_H) continue;
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          if (!blockTable[this.world.get(x, y, z)].blocksMovement) continue;
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Step one axis, backing off to the last free position if blocked. Returns
   * true if the motion was clipped, so the caller can zero that component.
   */
  tryStep(axis, delta) {
    if (delta === 0) return false;
    const want = this.feet.clone();
    want[axis] += delta;
    if (!this.blocked(want)) { this.feet.copy(want); return false; }

    // A one-block lip is walkable: try the same horizontal move from a step up.
    if (axis !== 'y' && this.grounded && !this.flying) {
      const hop = want.clone();
      hop.y = this.feet.y + 1.03;
      if (!this.blocked(hop)) { this.feet.copy(hop); return true; }
    }
    this.speed[axis] = 0;
    return true;
  }

  /** True when solid ground is within a short distance under the feet. */
  touchingGround() {
    const probe = this.feet.clone();
    probe.y -= 0.06;
    return this.blocked(probe);
  }

  // ------------------------------------------------------------- physics

  update(dtSeconds) {
    this._carry += Math.min(dtSeconds, 0.25);
    let guard = 0;
    while (this._carry >= TICK && guard++ < 8) {
      this._carry -= TICK;
      this.step(TICK);
    }
    // head bob, purely cosmetic
    const horizontal = Math.hypot(this.speed.x, this.speed.z);
    const want = this.grounded ? Math.min(1, horizontal / 6.5) : 0;
    this.gaitAmount += (want - this.gaitAmount) * Math.min(1, dtSeconds * 9);
    this.gait += horizontal * TICK * 2.15;
  }

  step(dt) {
    const here = this.world.get(
      Math.floor(this.feet.x), Math.floor(this.feet.y + 0.15), Math.floor(this.feet.z));
    const atEye = this.world.get(
      Math.floor(this.feet.x), Math.floor(this.eyeY), Math.floor(this.feet.z));
    this.swimming = here === WATER || atEye === WATER;

    // desired heading, rotated from input space into world space
    let ix = 0, iz = 0;
    for (const code of this.keys) {
      const v = LOOK_KEYS[code];
      if (v) { ix += v[0]; iz += v[1]; }
    }
    const mag = Math.hypot(ix, iz);
    if (mag > 0) { ix /= mag; iz /= mag; }
    // Rotate the input basis into world space. `forward()` is
    // (-sin yaw, -cos yaw) and the camera's right is (cos yaw, -sin yaw), so
    // the iz (forward/back) terms must both be negated — getting this sign
    // wrong swaps W and S while leaving A and D looking perfectly fine.
    const s = Math.sin(this.yaw), c = Math.cos(this.yaw);
    const wishX = ix * c - iz * s;
    const wishZ = -ix * s - iz * c;

    this.sprinting = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
    let top = this.flying ? SPEED_FLY
      : this.swimming ? SPEED_SWIM
        : this.sprinting ? SPEED_RUN : SPEED_WALK;

    const agility = this.grounded || this.flying ? 22 : 7;
    const blend = Math.min(1, agility * dt);
    this.speed.x += (wishX * top - this.speed.x) * blend;
    this.speed.z += (wishZ * top - this.speed.z) * blend;

    const jump = this.keys.has('Space');
    const descend = this.keys.has('KeyC') || this.keys.has('ShiftLeft');

    if (this.flying) {
      const lift = (jump ? 1 : 0) - (descend ? 1 : 0);
      this.speed.y += (lift * SPEED_FLY - this.speed.y) * Math.min(1, 18 * dt);
    } else if (this.swimming) {
      this.speed.y -= PULL * 0.26 * dt;
      if (jump) this.speed.y = Math.min(this.speed.y + 24 * dt, 4.0);
      this.speed.y *= Math.max(0, 1 - 3.0 * dt);
    } else {
      this.speed.y = Math.max(this.speed.y - PULL * dt, -TERMINAL);
      if (jump && this.grounded) { this.speed.y = LAUNCH; this.grounded = false; }
    }

    this.tryStep('y', this.speed.y * dt);
    this.grounded = !this.flying && this.speed.y <= 0 && this.touchingGround();
    if (this.grounded && this.speed.y < 0) this.speed.y = 0;

    this.tryStep('x', this.speed.x * dt);
    this.tryStep('z', this.speed.z * dt);

    if (this.feet.y < -10) this.place(this.chooseSite(this.feet.x, this.feet.z));
  }

  // ------------------------------------------------------------- targeting

  /**
   * March along the view ray in small steps, then bisect the final interval.
   * Returns the first block found together with the empty cell in front of it.
   */
  trace(maxReach = REACH) {
    const dir = this.forward();
    const step = 0.04;
    const refine = 0.06;

    let previous = 0;
    for (let t = step; t <= maxReach; t += step) {
      const x = this.feet.x + dir.x * t;
      const y = this.eyeY + dir.y * t;
      const z = this.feet.z + dir.z * t;
      const id = this.world.get(Math.floor(x), Math.floor(y), Math.floor(z));
      if (id !== AIR && id !== WATER) {
        // walk back to the boundary between empty and solid
        let lo = previous, hi = t;
        for (let k = 0; k < 8; k++) {
          const mid = (lo + hi) / 2;
          const mx = this.feet.x + dir.x * mid;
          const my = this.eyeY + dir.y * mid;
          const mz = this.feet.z + dir.z * mid;
          const midId = this.world.get(Math.floor(mx), Math.floor(my), Math.floor(mz));
          if (midId !== AIR && midId !== WATER) hi = mid; else lo = mid;
        }
        const hx = this.feet.x + dir.x * (hi - refine);
        const hy = this.eyeY + dir.y * (hi - refine);
        const hz = this.feet.z + dir.z * (hi - refine);
        const bx = Math.floor(this.feet.x + dir.x * hi);
        const by = Math.floor(this.eyeY + dir.y * hi);
        const bz = Math.floor(this.feet.z + dir.z * hi);
        return {
          x: bx, y: by, z: bz,
          id: this.world.get(bx, by, bz),
          reach: hi,
          stand: [Math.floor(hx), Math.floor(hy), Math.floor(hz)],
        };
      }
      previous = t;
    }
    return null;
  }

  /** Is this cell empty, and outside the player's own body? */
  placeable(x, y, z) {
    if (y < 1 || y >= WORLD_H) return false;
    const existing = this.world.get(x, y, z);
    if (existing !== AIR && existing !== WATER) return false;
    const insideX = x + 1 > this.feet.x - HALF_W && x < this.feet.x + HALF_W;
    const insideY = y + 1 > this.feet.y && y < this.bodyTop;
    const insideZ = z + 1 > this.feet.z - HALF_W && z < this.feet.z + HALF_W;
    return !(insideX && insideY && insideZ);
  }

  // --------------------------------------------------------------- spawn

  /**
   * Pick a start site. Candidates are laid out on a golden-angle spiral so the
   * whole neighbourhood is covered evenly, then scored on how much sky the best
   * direction actually shows. Sites that are walled in — a pit, a ravine, the
   * foot of a cliff — are rejected outright rather than merely ranked low,
   * because the least-bad view in a trench still opens onto a dirt wall.
   *
   * Uses terrain noise only, so it is safe to call before any chunk is loaded.
   */
  chooseSite(x, z) {
    const GOLDEN = 2.39996323;   // radians; successive radii stay uncorrelated
    const originX = Math.floor(x), originZ = Math.floor(z);
    let winner = null;

    for (let i = 1; i < 260; i++) {
      const r = 3.4 * Math.sqrt(i);
      const a = i * GOLDEN;
      const cx = originX + Math.round(Math.cos(a) * r);
      const cz = originZ + Math.round(Math.sin(a) * r);
      const h = Math.floor(this.world.heightAt(cx, cz));
      if (h < SEA_LEVEL + 1 || h > WORLD_H - 8) continue;
      if (this.world.floraAt(cx, cz)) continue;
      if (this.flatness(cx, h, cz) > 2) continue;

      const view = this.bestView(cx, h, cz);
      // Reject a site unless some direction is genuinely open: the skyline has
      // to stay near eye level, and the ground in front has to be flat or
      // falling away. Without the second test a site ringed by forest picks the
      // one clear direction, which happens to be straight up a bank.
      if (view.silhouette > h + 13) continue;
      if (view.nearRise > h + 2) continue;

      // Lower skyline wins; being near the requested point is a tiebreak only.
      const score = -(view.silhouette - h) * 4 - Math.hypot(cx - originX, cz - originZ) * 0.35;
      if (!winner || score > winner.score) {
        winner = { x: cx, z: cz, h, angle: view.angle, score };
      }
    }
    return winner || { x: originX, z: originZ, h: Math.floor(this.world.heightAt(originX, originZ)) };
  }

  /** Peak deviation from `h` over a small cross of samples. */
  flatness(cx, h, cz) {
    let worst = 0;
    const offsets = [[3, 0], [-3, 0], [0, 3], [0, -3], [2, 2], [-2, -2], [2, -2], [-2, 2]];
    for (const [dx, dz] of offsets) {
      const d = Math.abs(this.world.heightAt(cx + dx, cz + dz) - h);
      if (d > worst) worst = d;
    }
    return worst;
  }

  /**
   * Survey the 32 compass directions and describe the best one.
   *
   * `silhouette` is the highest thing (terrain or canopy) anywhere along a
   * direction out to 52 blocks; low means the horizon opens up. `nearRise` is
   * the highest ground in just the first 16 blocks; low means you are not
   * staring into a bank. A direction has to satisfy both — the best skyline on
   * its own still points uphill when trees ring the site on every other side.
   */
  bestView(cx, h, cz) {
    let best = { angle: 0, silhouette: Infinity, nearRise: Infinity };
    for (let a = 0; a < 32; a++) {
      const ang = (a / 32) * Math.PI * 2;
      const dx = Math.round(Math.cos(ang)), dz = Math.round(Math.sin(ang));
      let top = -Infinity, near = -Infinity;
      for (let s = 2; s <= 52; s += 2) {
        const tx = cx + dx * s, tz = cz + dz * s;
        let g = this.world.heightAt(tx, tz);
        const plant = this.world.floraAt(tx, tz);
        if (plant) g += 3 + plant.height;
        if (g > top) top = g;
        if (s <= 16 && g > near) near = g;
      }
      if (top < best.silhouette || (top === best.silhouette && near < best.nearRise)) {
        best = { angle: ang, silhouette: top, nearRise: near };
      }
    }
    return best;
  }

  /**
   * Stand the player on `site` and let gravity settle them. Must run after the
   * surrounding chunks exist, or there is nothing solid to land on.
   */
  place(site) {
    this.feet.set(site.x + 0.5, site.h + 2.4, site.z + 0.5);
    this.speed.set(0, 0, 0);
    this.flying = false;
    this.grounded = false;
    this._viewY = null;          // drop any easing from the previous position
    this.yaw = site.angle === undefined
      ? this.facingFor(site.x, site.h, site.z)
      : yawForAngle(site.angle);
    this.pitch = -0.07;
    for (let i = 0; i < 150; i++) {
      this.speed.y = Math.max(this.speed.y - PULL * TICK, -TERMINAL);
      this.tryStep('y', this.speed.y * TICK);
      if (this.grounded || this.touchingGround()) break;
    }
    this.speed.y = 0;
    this.grounded = true;
    return site;
  }

  spawnAt(x, z) { return this.place(this.chooseSite(x, z)); }

  /** Yaw pointing along the most open direction from a column. */
  facingFor(cx, h, cz) {
    return yawForAngle(this.bestView(cx, h, cz).angle);
  }
}

export { BODY_W as PLAYER_WIDTH, BODY_T as PLAYER_HEIGHT, REACH as PLAYER_REACH };
