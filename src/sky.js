// Sky, sun, stars, and the lighting model that everything else reads from.
//
// A single normalised time value drives the whole thing: the sky gradient, the
// sun direction, the star fade, the directional light colour, the ambient fill
// and the fog. Keeping them on one clock is what stops the world from looking
// like it is lit by three different times of day.

import * as THREE from '../vendor/three.module.js';
import { clamp, lerp } from './noise.js';

export const DAY_SECONDS = 320;

// Stops of the day cycle, interpolated between. Fog deliberately shares the
// horizon colour at every stop so distant terrain dissolves into the exact
// shade of sky behind it.
const STOPS = [
  { at: 0.00, top: [5, 7, 20], rim: [11, 15, 36], direct: [0.15, 0.19, 0.34], fill: [0.11, 0.13, 0.22] },
  { at: 0.21, top: [24, 32, 70], rim: [80, 64, 96], direct: [0.44, 0.36, 0.42], fill: [0.20, 0.20, 0.28] },
  { at: 0.26, top: [72, 110, 170], rim: [234, 152, 106], direct: [0.90, 0.56, 0.36], fill: [0.26, 0.24, 0.26] },
  { at: 0.33, top: [106, 160, 226], rim: [188, 210, 238], direct: [0.97, 0.89, 0.75], fill: [0.30, 0.32, 0.36] },
  { at: 0.50, top: [94, 152, 228], rim: [180, 208, 240], direct: [1.00, 0.96, 0.88], fill: [0.30, 0.33, 0.38] },
  { at: 0.67, top: [106, 160, 226], rim: [192, 208, 234], direct: [0.97, 0.89, 0.75], fill: [0.30, 0.32, 0.36] },
  { at: 0.74, top: [88, 108, 178], rim: [246, 140, 84], direct: [0.93, 0.50, 0.30], fill: [0.26, 0.22, 0.24] },
  { at: 0.79, top: [32, 36, 82], rim: [98, 62, 90], direct: [0.42, 0.30, 0.38], fill: [0.20, 0.19, 0.26] },
  { at: 1.00, top: [5, 7, 20], rim: [11, 15, 36], direct: [0.15, 0.19, 0.34], fill: [0.11, 0.13, 0.22] },
];

function readStops(t) {
  let i = 0;
  while (i < STOPS.length - 2 && STOPS[i + 1].at <= t) i++;
  const a = STOPS[i], b = STOPS[i + 1];
  const f = clamp((t - a.at) / (b.at - a.at || 1), 0, 1);
  const blend = (p, q) => [lerp(p[0], q[0], f), lerp(p[1], q[1], f), lerp(p[2], q[2], f)];
  return {
    top: blend(a.top, b.top),
    rim: blend(a.rim, b.rim),
    direct: blend(a.direct, b.direct),
    fill: blend(a.fill, b.fill),
  };
}

const DOME_VERT = `
varying vec3 vRay;
void main() {
  vRay = normalize(position);
  vec4 clip = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = clip.xyww;      // pin to the far plane
}`;

const DOME_FRAG = `
uniform vec3 topColor;
uniform vec3 rimColor;
uniform vec3 sunRay;
uniform vec3 sunColor;
uniform float starAmount;
varying vec3 vRay;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

void main() {
  vec3 d = normalize(vRay);
  // Non-linear ramp: most of the colour change happens near the horizon,
  // which is what reads as atmosphere rather than a plain vertical gradient.
  float band = pow(clamp(d.y, 0.0, 1.0), 0.44);
  vec3 col = mix(rimColor, topColor, band);

  float toward = max(dot(d, normalize(sunRay)), 0.0);
  col += sunColor * pow(toward, 340.0) * 3.4;   // the disc
  col += sunColor * pow(toward, 8.0) * 0.28;    // the glow around it

  if (d.y > 0.03 && starAmount > 0.01) {
    // A sparse grid of cells, each lighting up with a stable random value.
    vec2 cell = floor(d.xz * 165.0 / max(d.y, 0.14));
    float roll = hash(cell);
    if (roll > 0.9958) {
      float twinkle = 0.5 + 0.5 * hash(cell + 11.7);
      col += vec3(twinkle * 0.9) * starAmount;
    }
  }
  gl_FragColor = vec4(col, 1.0);
}`;

export class SkyDome {
  constructor(scene) {
    this.pinned = null;
    this.uniforms = {
      topColor: { value: new THREE.Color(0x5a9ae0) },
      rimColor: { value: new THREE.Color(0xbcd0ee) },
      sunRay: { value: new THREE.Vector3(0, 1, 0) },
      sunColor: { value: new THREE.Color(1, 1, 1) },
      starAmount: { value: 0 },
    };
    const material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: DOME_VERT,
      fragmentShader: DOME_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 20), material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
    scene.add(this.mesh);
    this.ray = new THREE.Vector3(0, 1, 0);
  }

  /**
   * Advance to time `t` in [0,1) and return the lighting the world needs.
   * `pinned` overrides the clock, which is how screenshots freeze a time of day.
   */
  evaluate(t, camera) {
    const time = this.pinned === null ? t : this.pinned;
    const angle = (time - 0.25) * Math.PI * 2;
    // Tilted arc: the sun never sits exactly overhead, which keeps shadows and
    // face shading from going flat at noon.
    this.ray.set(Math.cos(angle) * 0.4, Math.sin(angle), Math.cos(angle) * 0.92).normalize();

    const k = readStops(time);
    this.uniforms.topColor.value.setRGB(k.top[0] / 255, k.top[1] / 255, k.top[2] / 255);
    this.uniforms.rimColor.value.setRGB(k.rim[0] / 255, k.rim[1] / 255, k.rim[2] / 255);
    this.uniforms.sunRay.value.copy(this.ray);
    this.uniforms.sunColor.value.setRGB(k.direct[0], k.direct[1], k.direct[2]);
    this.uniforms.starAmount.value = 1 - clamp((this.ray.y + 0.16) / 0.22, 0, 1);

    if (camera) this.mesh.position.copy(camera.position);

    return {
      ray: this.ray,
      direct: k.direct,
      fill: k.fill,
      haze: k.rim.map((v) => v / 255),
      brightness: clamp(this.ray.y * 2.4 + 0.25, 0, 1),
    };
  }
}

export function clockLabel(t) {
  const hours = t * 24;
  const h = Math.floor(hours);
  const m = Math.floor((hours - h) * 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
