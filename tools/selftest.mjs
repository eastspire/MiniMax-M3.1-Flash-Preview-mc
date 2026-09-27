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

// walking
const before = await page.evaluate(() => window.__game.player.feet.toArray());
await page.keyboard.down('KeyW');
await page.waitForTimeout(1300);
await page.keyboard.up('KeyW');
await page.waitForTimeout(200);
const after = await page.evaluate(() => window.__game.player.feet.toArray());
const walked = Math.hypot(after[0] - before[0], after[2] - before[2]);
check('W walks the player', walked > 1, `(${walked.toFixed(2)} blocks)`);

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
