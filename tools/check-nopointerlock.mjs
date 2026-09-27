// Regression test for the no-pointer-lock path.
//
// The game asks for pointer lock, but a browser can refuse it: embedded
// webviews, an iframe without allow="pointer-lock", or a dismissed prompt.
// When that happens the overlay used to stay up and the player was stuck on
// the title screen with no way in. This stubs requestPointerLock to reject the
// way a webview does, then asserts the game is still fully playable.
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
page.on('console', (m) => { if (m.type() === 'error') errors.push(`[console] ${m.text()}`); });

// Deny pointer lock the way an embedded webview does.
await page.addInitScript(() => {
  Object.defineProperty(HTMLCanvasElement.prototype, 'requestPointerLock', {
    configurable: true,
    value() { return Promise.reject(new DOMException('denied', 'WrongDocumentError')); },
  });
});

await page.goto(URL, { waitUntil: 'load' });
await page.waitForFunction(() => window.__game && window.__game.settled(), null, { timeout: 60000 });
await page.waitForTimeout(500);

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push([name, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) errors.push(`assertion failed: ${name}`);
};

check('overlay visible before start', await page.evaluate(() =>
  document.getElementById('title').dataset.done !== '1'));

await page.click('#begin');
await page.waitForTimeout(900);

const afterStart = await page.evaluate(() => ({
  hidden: document.getElementById('title').dataset.done === '1',
  locked: document.pointerLockElement !== null,
}));
check('start clears the overlay without pointer lock', afterStart.hidden, `(lock granted: ${afterStart.locked})`);

// walking
const p0 = await page.evaluate(() => window.__game.player.feet.toArray());
await page.keyboard.down('KeyW');
await page.waitForTimeout(1200);
await page.keyboard.up('KeyW');
await page.waitForTimeout(200);
const p1 = await page.evaluate(() => window.__game.player.feet.toArray());
const walked = Math.hypot(p1[0] - p0[0], p1[2] - p0[2]);
check('W walks the player', walked > 1, `(${walked.toFixed(2)} blocks)`);

// looking, by dragging
const y0 = await page.evaluate(() => window.__game.player.yaw);
await page.mouse.move(640, 400);
await page.mouse.down();
await page.mouse.move(900, 400, { steps: 12 });
await page.mouse.up();
await page.waitForTimeout(200);
const y1 = await page.evaluate(() => window.__game.player.yaw);
check('drag turns the camera', Math.abs(y1 - y0) > 0.05, `(dyaw ${(y1 - y0).toFixed(3)})`);

// placing and mining a block
const edited = await page.evaluate(() => {
  const g = window.__game;
  g.setYawPitch(g.player.yaw, -1.15);
  const hit = g.player.trace();
  if (!hit) return { ok: false, why: 'nothing targeted' };
  const p = hit.stand;
  g.world.put(p[0], p[1], p[2], 21);                   // bricks
  const placedOk = g.world.get(p[0], p[1], p[2]) === 21;
  g.world.put(hit.x, hit.y, hit.z, 0);                  // mine it out
  const minedOk = g.world.get(hit.x, hit.y, hit.z) === 0;
  return { ok: placedOk && minedOk, placedOk, minedOk };
});
check('a block can be placed and mined', edited.ok, JSON.stringify(edited));

// hotbar selection still works
await page.keyboard.press('Digit4');
await page.waitForTimeout(150);
check('hotbar selection responds', await page.evaluate(() => window.__game.hud.chosen) === 3);

await page.screenshot({ path: 'docs/screenshots/21-no-pointer-lock.png' });
console.log(`  shot  21-no-pointer-lock.png`);

console.log(`page/console errors: ${errors.length}`);
errors.slice(0, 6).forEach((e) => console.log('   ', e.slice(0, 200)));
const failed = checks.filter(([, ok]) => !ok).length;
console.log(`${checks.length - failed}/${checks.length} checks passed`);

await browser.close();
process.exit(errors.length ? 1 : 0);
