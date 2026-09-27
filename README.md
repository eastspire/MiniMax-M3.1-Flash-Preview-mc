# Cubeworld

A Minecraft-style voxel sandbox that runs in the browser. Infinite seeded
terrain, eight climates, caves and ores, water, a full day/night cycle, and
mining and building — rendered with WebGL2 on top of three.js.

**Every texture in this project is generated in code at load time.** There are
no image files: each 16×16 block tile is painted pixel by pixel into a single
`DataArrayTexture` and sampled by a custom GLSL3 shader.

![The spawn area at dawn](docs/screenshots/02-spawn.png)

---

## Run it

ES modules need a real HTTP origin, so serve the folder rather than opening the
file directly:

```bash
cd voxelcraft
node tools/serve.mjs . 8138      # http://127.0.0.1:8138/
```

Any static server works — `python3 -m http.server 8138` is fine too. The bundled
`tools/serve.mjs` just adds `no-store` headers so an edited module is never
served from the browser cache while you are iterating.

## Controls

| Input | Action |
| --- | --- |
| `W A S D` or the arrow keys | move on foot |
| `Space` | jump (swim up in water, rise while flying) |
| hold `Shift` | run |
| `C` | descend while flying |
| `F` | toggle flight |
| Hold **left mouse** | mine the targeted block — time scales with its hardness |
| **Right mouse** | place the selected block |
| **Middle mouse** | pick the targeted block into the hotbar |
| `1`–`9`, `-`, `=` | select a hotbar slot |
| Mouse wheel | cycle the hotbar |
| `F3` | compact the HUD |
| `F1` | hide every overlay |

Pointer lock is the intended way to look around. If the browser refuses it —
embedded webviews, an iframe without `allow="pointer-lock"`, a dismissed prompt
— the game says so and falls back to **dragging with the left mouse button**.
Every other control is unchanged.

## What's in the world

- **Terrain** — a domain-warped continental base, mid-scale hills, ridged
  mountains gated by a low-frequency mask so ranges cluster, and a
  short-wavelength jitter term. That last one earns its place: without it the
  height field is smooth enough that every slope becomes a metronomic
  staircase. It has to stay small, though — pushed higher it etches regular
  corduroy stripes across every hillside instead.
- **Climates** — ocean, shore, meadow, woodland, steppe, dunes, tundra and
  alpine, chosen from height plus thermal/moisture noise. Each picks its own
  surface, sub-surface and flora (broadleaf, conifer, flat-topped acacia).
- **Caves** — two near-independent ridged noise fields intersected. A single
  thresholded field gives disconnected bubbles; the intersection gives long
  connected passages, which is what reads as a cave system.
- **Ores** — coal, iron and gold by depth, plus gravel pockets.
- **Water** — sea-level fill, swimming with buoyancy and drag, an animated
  surface, and a submerged fog and screen tint.
- **Day/night** — a 320-second cycle driving the sky gradient, sun, star field,
  fog and light colour from one value. The clock starts just after sunrise so
  the first thing on screen is the world, not a black sky.
- **Building** — 23 block types, 12 in the hotbar. Edits go into a global
  journal, so a chunk can be unloaded and regenerated without losing them.

## Screenshots

Every image below is captured from the running game by `tools/capture.mjs`,
which drives the real page in Chrome. The run fails on any page error or console
error, so these cannot drift away from a working build.

### Boot and first steps

| `01-title` — title screen | `02-spawn` — the opening view |
| --- | --- |
| ![title](docs/screenshots/01-title.png) | ![spawn](docs/screenshots/02-spawn.png) |

| `03-walking` — after holding `W` | `04-hut` — a 226-block hut, built block by block |
| --- | --- |
| ![walking](docs/screenshots/03-walking.png) | ![hut](docs/screenshots/04-hut.png) |

### Mining

| `05-wall` — a cobblestone wall | `06-mining` — held down on the target |
| --- | --- |
| ![wall](docs/screenshots/05-wall.png) | ![mining](docs/screenshots/06-mining.png) |

| `07-mined-hole` — the hole it left |
| --- |
| ![mined](docs/screenshots/07-mined-hole.png) |

### Climates

Each of these was found by searching for a coordinate where the surrounding
80×80 area is at least 70% the same climate — otherwise the "dunes" shot ends
up photographing a forest on the horizon.

| `08-mountains` — snow-capped ridge | `09-woodland` — dense forest |
| --- | --- |
| ![mountains](docs/screenshots/08-mountains.png) | ![woodland](docs/screenshots/09-woodland.png) |

| `10-dunes` — sand and cacti | `11-tundra` — conifer and snow |
| --- | --- |
| ![dunes](docs/screenshots/10-dunes.png) | ![tundra](docs/screenshots/11-tundra.png) |

| `12-shore` — sand meeting the sea | `13-ocean` — open water |
| --- | --- |
| ![shore](docs/screenshots/12-shore.png) | ![ocean](docs/screenshots/13-ocean.png) |

### The day cycle

| `14-noon` | `15-sunset` |
| --- | --- |
| ![noon](docs/screenshots/14-noon.png) | ![sunset](docs/screenshots/15-sunset.png) |

| `16-night` — stars over a dark plain | `17-dawn` — the sun coming up |
| --- | --- |
| ![night](docs/screenshots/16-night.png) | ![dawn](docs/screenshots/17-dawn.png) |

### Scale and water

| `18-aerial` — the coastline from 86 blocks up | `20-overview` — the view the FPS probe uses |
| --- | --- |
| ![aerial](docs/screenshots/18-aerial.png) | ![overview](docs/screenshots/20-overview.png) |

| `19-underwater` — submerged, with the blue tint and fog |
| --- |
| ![underwater](docs/screenshots/19-underwater.png) |

| `21-no-pointer-lock` — playable with pointer lock refused |
| --- |
| ![no pointer lock](docs/screenshots/21-no-pointer-lock.png) |

## How it works

```
index.html               markup, HUD and overlay DOM
css/style.css            HUD, hotbar, overlays, underwater tint
src/noise.js             seeded simplex noise, fBm, ridged multifractal
src/blocks.js            block registry + every texture, painted in code
src/world.js             chunk storage, terrain, climates, caves, ores, flora
src/mesher.js            chunk meshing: face culling, AO, three passes
src/player.js            physics, AABB collision, ray-march targeting, spawn
src/sky.js               sky dome, sun, stars, the day/night model
src/hud.js               hotbar with isometric block icons
src/main.js              renderer, GLSL3 terrain shader, streaming, game loop
vendor/                  three.js r180 (vendored so this runs offline)
tools/                   dev server, smoke tests, screenshot harness
```

### Notes on the parts that were fiddly

- **Face winding.** Every face lists its four corner offsets explicitly, so the
  winding can be checked by eye — looking at the face from outside, the corners
  run counter-clockwise. Deriving them from an origin plus two in-plane axes is
  more compact and much easier to get backwards, which renders the whole world
  inside-out.
- **Ambient occlusion** comes from the three cells touching each corner and is
  stored normalised to 0–1. The triangle split follows the darker diagonal, or
  contact shadows crease the wrong way. It has to be normalised: the raw score
  is 0–3, and using it as a 0–1 multiplier lights the whole scene 3× too bright.
- **No mipmaps on the texture array.** Generating mip levels for a 2D array
  texture blends separate layers together, and every face ends up sampling an
  average of the entire atlas — the world renders as a flat wash of colour.
  Nearest is also the right look for 16px pixel art.
- **Lighting** is a face-orientation term plus a directional term, scaled so a
  fully lit top face lands near 0.9 rather than clipping to white.
- **Fog colour equals the sky's horizon colour** at every stop, and fog finishes
  before the outermost retained chunk. Otherwise the streaming edge shows up as
  grey islands floating on the horizon.
- **Fixed-timestep physics.** Simulation runs on a 60 Hz accumulator rather than
  the render frame, so behaviour does not change with frame rate and a long
  frame cannot tunnel the player through the floor.
- **Targeting is a stepped ray march with bisection**, not an incremental DDA.
  It is slower over five blocks but far easier to reason about.
- **Spawn** is searched, not hard-coded. Candidates go on a golden-angle spiral
  and are scored on two numbers: the *skyline* in the best direction (does the
  horizon open up?) and the *near rise* (are you staring into a bank?). Both
  have to pass. A single "lowest skyline" test is not enough — when trees ring
  the site, the one clear direction is usually straight uphill.
- **Chunks** are 16 × 128 × 16, laid out y-major so a column is contiguous.
  Generation runs as explicit phases and is budgeted per frame (~9 ms), so
  streaming never stalls the render loop. Tree canopies spill across chunk
  borders; those writes are queued and replayed when the neighbour arrives.

### URL parameters

| Param | Meaning |
| --- | --- |
| `?seed=12345` | picks the world; defaults to `20260927` |
| `?x=&z=` | which column to start from |
| `?dist=8` | how far chunks are kept, in chunks (2 to 12) |
| `?t=0.5` | freeze the time of day (0 = midnight, 0.5 = noon) |
| `?fog=0` | turn the distance fog off |
| `?overlay=0` | boot straight into the world |
| `?spin=1` | let the camera drift round by itself |

`window.__game` exposes `goTo`, `setYawPitch`, `setYawToward`, `freezeClock`,
`releaseClock`, `levelGround`, `highPoint`, `landAt`, `pickSite` and `report()`
for tooling.

## Verifying it

```bash
node tools/serve.mjs . 8138 &
node tools/selftest.mjs             # boots the page, asserts the world is sane
node tools/check-nopointerlock.mjs  # plays the game with pointer lock refused
node tools/capture.mjs              # drives a full tour, rewrites docs/screenshots/
```

`selftest.mjs` runs ten checks — chunks stream in, triangles are drawn, meshes
are in the scene, the player's column is solid, the ground-contact test holds,
the start button clears the overlay, `W` actually moves the player, the player
is still grounded afterwards, and a block can be placed and mined. It exits
non-zero on any page or console error.

`check-nopointerlock.mjs` stubs `requestPointerLock` to reject the way an
embedded webview does, then asserts the game is still completely playable: the
overlay clears, `W` walks, dragging turns the camera, a block can be placed and
mined, and the hotbar responds. It is the regression test for the fallback
described above.

`capture.mjs` walks the tour above, then writes a 120-frame FPS probe into
`docs/screenshots/report.json`.

Latest run: **0 page errors, 0 console errors or warnings, 60 fps** on headless
SwiftShader at 1440×900, ~225 chunks resident.

## Known limitations

- There are no shadow maps, so caves and overhangs are lit by the ambient term
  only. Per-vertex AO carries most of the form.
- The world is 128 blocks tall, and terrain is soft-clamped to stay inside it.
- Blocks do not fall when unsupported; there is no redstone and no mobs.
- Player edits live in memory for the session; reloading regenerates the world
  from the seed.
- The held block is a small unlit cube rather than a full animated arm.
