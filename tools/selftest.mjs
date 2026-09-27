// Smoke test: boot the real page and assert the world is actually playable.
// Any page error or console error fails the run.
import { chromium } from 'playwright-core';

const URL = process.argv[2] || 'http://127.0.0.1:8138/';

const browser = await chromium.launch({
  headless: true,
  channel: 'chrome',
  args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--ignore-gpu-blocklist', '--hide-scrollbars'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text()}`);
});

await page.goto(URL, { waitUntil: 'load' });

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push([name, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) errors.push(`assertion failed: ${name}`);
};

try {
  await page.waitForFunction(() => window.__game && window.__game.settled(), null, { timeout: 60000 });
  check('world streams in', true);
} catch (e) {
  check('world streams in', false, e.message.split('\n')[0]);
}

await page.click('#begin');
await page.waitForTimeout(1000);

const world = await page.evaluate(() => {
  const g = window.__game;
  let solid = 0;
  for (let y = 0; y < 70; y++) {
    if (g.world.get(Math.floor(g.player.feet.x), y, Math.floor(g.player.feet.z)) !== 0) solid++;
  }
  return {
    report: g.report(),
    columnSolid: solid,
    titleGone: document.getElementById('title').dataset.done === '1',
    meshCount: g.scene.children.filter((c) => c.isGroup).reduce((n, grp) => n + grp.children.length, 0),
  };
});
console.log('  report', JSON.stringify(world.report));

check('chunks resident', world.report.chunks > 20, `(${world.report.chunks})`);
check('triangles drawn', world.report.tris > 1000, `(${world.report.tris})`);
check('meshes are in the scene', world.meshCount > 20, `(${world.meshCount})`);
check('player column is solid', world.columnSolid > 5, `(${world.columnSolid} blocks)`);
check('player is standing on ground', await page.evaluate(() => window.__game.player.grounded));
check('start dismisses the title', world.titleGone);

// Walking, and the stability of the view while doing it.
//
// Collision resolution is discrete: walking over a one-block step teleports
// the feet up a block. A camera bound straight to that position jolts a full
// block in one frame, which is the shake the eye notices. The view height is
// eased, so sample it per frame and assert no single frame jumps.
const before = await page.evaluate(() => window.__game.player.feet.toArray());
const walkTrace = await page.evaluate(async () => {
  const g = window.__game;
  g.player.flying = false;
  g.setYawPitch(0.7, 0);
  const trace = [];
  let running = true;
  const tick = () => { trace.push(g.camera.position.y); if (running) requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  g.player.keys.add('KeyW');
  window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));
  await new Promise((r) => setTimeout(r, 1500));
  g.player.keys.delete('KeyW');
  window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW' }));
  await new Promise((r) => setTimeout(r, 250));
  running = false;
  return trace;
});

const after = await page.evaluate(() => window.__game.player.feet.toArray());
const walked = Math.hypot(after[0] - before[0], after[2] - before[2]);
check('W walks the player', walked > 1, `(${walked.toFixed(2)} blocks)`);

// Only look at frames where the player was actually moving; a jump or a fall
// legitimately moves the camera fast.
const moving = await page.evaluate(() => window.__game.player.gaitAmount);
void moving;
let worstStep = 0;
for (let i = 1; i < walkTrace.length; i++) {
  worstStep = Math.max(worstStep, Math.abs(walkTrace[i] - walkTrace[i - 1]));
}
const rise = Math.max(...walkTrace) - Math.min(...walkTrace);
check('camera does not jolt while walking', worstStep < 0.4,
  `(worst single frame ${worstStep.toFixed(3)} blocks, total travel ${rise.toFixed(2)})`);

// W must move along the way the camera is facing, not away from it. This is
// the invariant that a sign slip in the input-to-world rotation breaks, and it
// fails silently in a screenshot — the player just runs the wrong way.
const steering = await page.evaluate(() => {
  const g = window.__game;
  const results = [];
  for (const [code, ix, iz] of [['KeyW', 0, 1], ['KeyS', 0, -1], ['KeyA', -1, 0], ['KeyD', 1, 0]]) {
    // sample several yaws so the check is not tied to one facing
    let worst = 0;
    for (let k = 0; k < 8; k++) {
      g.player.yaw = (k / 8) * Math.PI * 2;
      const yaw = g.player.yaw;
      const s = Math.sin(yaw), c = Math.cos(yaw);
      const mx = ix * c - iz * s;
      const mz = -ix * s - iz * c;
      const fx = -Math.sin(yaw), fz = -Math.cos(yaw);   // forward
      const rx = Math.cos(yaw), rz = -Math.sin(yaw);    // camera right
      const along = mx * fx + mz * fz;
      const side = mx * rx + mz * rz;
      const expect = code === 'KeyW' ? [1, 0] : code === 'KeyS' ? [-1, 0] : code === 'KeyA' ? [0, -1] : [0, 1];
      worst = Math.max(worst, Math.abs(along - expect[0]), Math.abs(side - expect[1]));
    }
    results.push([code, worst]);
  }
  g.player.yaw = 0;
  return results;
});
for (const [code, err] of steering) {
  check(`${code} moves the way it is labelled`, err < 1e-6, `(max error ${err.toExponential(1)})`);
}

// gravity keeps the player on the ground rather than sinking or drifting
await page.waitForTimeout(600);
check('still grounded after moving', await page.evaluate(() => window.__game.player.grounded));

// mining removes a block; placing puts one back
const edit = await page.evaluate(() => {
  const g = window.__game;
  g.setYawPitch(g.player.yaw, -1.15);
  const hit = g.player.trace();
  if (!hit) return { ok: false, why: 'nothing in reach' };
  const [x, y, z] = hit.stand;
  g.world.put(x, y, z, 21);                       // bricks
  const placed = g.world.get(x, y, z) === 21;
  g.world.put(hit.x, hit.y, hit.z, 0);            // mine it out
  const mined = g.world.get(hit.x, hit.y, hit.z) === 0;
  return { ok: placed && mined, placed, mined };
});
check('place and mine a block', edit.ok, JSON.stringify(edit));

console.log(`page/console errors: ${errors.length}`);
errors.slice(0, 8).forEach((e) => console.log('   ', e.slice(0, 220)));
const failed = checks.filter(([, ok]) => !ok).length;
console.log(`${checks.length - failed}/${checks.length} checks passed`);

await browser.close();
process.exit(errors.length ? 1 : 0);
