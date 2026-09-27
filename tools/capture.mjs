// Screenshot harness: boots the real page in Chrome and drives a scripted
// tour, capturing each scene. Any page error or console error fails the run,
// so the images in the README cannot drift away from a working build.
//
//   node tools/capture.mjs [--url ...] [--out docs/screenshots]

import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : dflt;
};
const BASE = argOf('--url', 'http://127.0.0.1:8138/');
const OUT = path.resolve(ROOT, argOf('--out', 'docs/screenshots'));

mkdirSync(OUT, { recursive: true });
// Clear stale frames so a scene that no longer exists cannot linger.
for (const f of readdirSync(OUT)) {
  if (f.endsWith('.png') || f.endsWith('.jpg')) rmSync(path.join(OUT, f));
}

const browser = await chromium.launch({
  headless: true,
  channel: 'chrome',
  args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--hide-scrollbars'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });

const consoleErrors = [];
const pageErrors = [];
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') consoleErrors.push(`[${m.type()}] ${m.text()}`);
});
page.on('pageerror', (e) => { pageErrors.push(String(e)); });

const log = (...a) => console.log(...a);
const shot = async (name) => {
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  log(`  shot  ${name}.png`);
};
const settle = async (timeout = 60000) => {
  await page.waitForFunction(() => window.__game && window.__game.settled(), null, { timeout });
  await page.waitForTimeout(500);
};
const report = () => page.evaluate(() => window.__game.report());

// ------------------------------------------------------------------ boot
log('== 1. cold boot');
await page.goto(BASE, { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__game, null, { timeout: 30000 });
await settle();
log('  ' + JSON.stringify(await report()));
await shot('01-title');

// ------------------------------------------------------------ first person
log('== 2. first person at spawn');
await page.click('#begin');
await page.waitForTimeout(1000);
await shot('02-spawn');

// ---------------------------------------------------------------- walking
log('== 3. walking');
await page.keyboard.down('KeyW');
await page.waitForTimeout(1600);
await page.keyboard.up('KeyW');
await page.waitForTimeout(400);
log('  ' + JSON.stringify(await report()));
await shot('03-walking');

// ---------------------------------------------------------------- building
log('== 4. build');
const B = { PLANK: 20, BRICK: 21, PANE: 22, LOG: 13, COBBLE: 3, SNOW: 8 };
const built = await page.evaluate((B) => {
  const g = window.__game;
  const spot = g.levelGround(Math.floor(g.player.feet.x), Math.floor(g.player.feet.z), 90);
  if (!spot) return null;
  const ox = spot.x + 3, oz = spot.z - 3;
  const oy = Math.floor(g.world.heightAt(ox, oz)) + 1;
  let placed = 0;
  for (let x = 0; x < 7; x++) {
    for (let z = 0; z < 7; z++) {
      g.world.put(ox + x, oy - 1, oz + z, B.COBBLE); placed++;
      for (let y = 0; y < 4; y++) {
        const wall = x === 0 || z === 0 || x === 6 || z === 6;
        if (!wall) continue;
        const post = (x === 0 || x === 6) && (z === 0 || z === 6);
        const pane = y === 1 && !post && (x + z) % 2 === 0;
        g.world.put(ox + x, oy + y, oz + z, post ? B.LOG : y === 3 ? B.PLANK : pane ? B.PANE : B.BRICK);
        placed++;
      }
    }
  }
  for (let x = -1; x <= 7; x++) {
    for (let z = -1; z <= 7; z++) {
      const inside = x >= 0 && x <= 6 && z >= 0 && z <= 6;
      g.world.put(ox + x, oy + 4, oz + z, inside ? B.PLANK : B.SNOW);
      placed++;
    }
  }
  for (const r of g.world.regions.values()) r.stale = true;
  // Stand back and well clear of any canopy — the ground height is not enough,
  // because a tree beside the hut would put the camera inside its leaves.
  const ex = ox - 10, ez = oz - 10;
  const eye = Math.max(g.world.heightAt(ex, ez) + 12, oy + 11);
  g.player.flying = true;
  g.goTo(ex, eye, ez);
  g.setYawToward(ox + 3.5, oy + 2.5, oz + 3.5);
  return { placed, at: [ox, oy, oz], eye };
}, B);
log('  ' + JSON.stringify(built));
await settle();
await page.waitForTimeout(1800);
await shot('04-hut');

// ----------------------------------------------------------------- mining
log('== 5. mine with a real mouse press');
const wallAt = await page.evaluate((B) => {
  const g = window.__game;
  g.player.flying = true;
  g.setYawPitch(g.player.yaw, -0.6);
  const aim = g.player.forward();
  const bx = Math.floor(g.player.feet.x + aim.x * 6);
  const by = Math.floor(g.player.eyeY + aim.y * 6);
  const bz = Math.floor(g.player.feet.z + aim.z * 6);
  for (let x = -2; x <= 2; x++) {
    for (let y = -2; y <= 2; y++) {
      for (let z = -1; z <= 1; z++) g.world.put(bx + x, by + y, bz + z, B.COBBLE);
    }
  }
  for (const r of g.world.regions.values()) r.stale = true;
  g.setYawPitch(g.player.yaw, -0.6);
  const hit = g.player.trace(7);
  return { wall: [bx, by, bz], hit: hit && [hit.x, hit.y, hit.z] };
}, B);
log('  wall ' + JSON.stringify(wallAt.wall) + ' targeting ' + JSON.stringify(wallAt.hit));
await page.waitForTimeout(1500);
await shot('05-wall');

await page.mouse.down();
await page.waitForTimeout(600);
await shot('06-mining');
await page.waitForTimeout(1500);
await page.mouse.up();
await page.waitForTimeout(500);
const afterMine = await page.evaluate((at) => window.__game.world.get(at[0], at[1], at[2]), wallAt.hit);
log('  block after mining: ' + afterMine + ' (0 = air)');
await shot('07-mined-hole');

// ----------------------------------------------------------------- biomes
log('== 6. biomes');
// A biome coordinate is only worth photographing if the neighbourhood is the
// same biome, otherwise the "desert" shot ends up showing a forest behind it.
const CLIMATES = [
  ['08-mountains', 'Alpine'],
  ['09-woodland', 'Woodland'],
  ['10-dunes', 'Dunes'],
  ['11-tundra', 'Tundra'],
  ['12-shore', 'Shore'],
  ['13-ocean', 'Ocean'],
];
for (const [name, climate] of CLIMATES) {
  const spot = await page.evaluate((climate) => {
    const g = window.__game;
    let best = null;
    for (let z = -2800; z <= 2800; z += 32) {
      for (let x = -2800; x <= 2800; x += 32) {
        if (g.landAt(x, z) !== climate) continue;
        const h = g.world.heightAt(x, z);
        if (climate === 'Alpine' && h < 60) continue;
        if (climate === 'Ocean' && h > 26) continue;
        if (climate === 'Shore' && h < 38) continue;
        let same = 0, total = 0, low = 1e9, high = -1e9;
        for (let dz = -40; dz <= 40; dz += 8) {
          for (let dx = -40; dx <= 40; dx += 8) {
            total++;
            if (g.landAt(x + dx, z + dz) === climate) same++;
            const hh = g.world.heightAt(x + dx, z + dz);
            low = Math.min(low, hh); high = Math.max(high, hh);
          }
        }
        const purity = same / total;
        if (purity < 0.7) continue;
        const score = purity * 100 + Math.min(high - low, 26);
        if (!best || score > best.score) {
          best = { x, z, h, purity: +purity.toFixed(2), relief: +(high - low).toFixed(1), score };
        }
      }
    }
    return best;
  }, climate);
  if (!spot) { log(`  ! no ${climate} found`); continue; }

  await page.evaluate(({ spot, climate }) => {
    const g = window.__game;
    g.player.flying = true;
    if (climate === 'Alpine') {
      const peak = g.highPoint(spot.x, spot.z, 90);
      const stand = 96, bearing = 0.9;
      const cx = Math.round(peak.x - Math.cos(bearing) * stand);
      const cz = Math.round(peak.z + Math.sin(bearing) * stand);
      g.goTo(cx, Math.max(g.world.heightAt(cx, cz) + 10, peak.h + 6), cz);
      g.setYawToward(peak.x, peak.h - 10, peak.z);
    } else if (climate === 'Ocean') {
      g.goTo(spot.x, 52, spot.z);
      g.setYawPitch(0.8, -0.16);
    } else {
      const bx = spot.x - 26, bz = spot.z - 26;
      g.goTo(bx, Math.max(g.world.heightAt(bx, bz) + 12, spot.h + 10), bz);
      g.setYawToward(spot.x, spot.h, spot.z);
    }
  }, { spot, climate });

  await settle();
  await page.waitForTimeout(2000);
  log(`  ${climate} ${JSON.stringify(spot)}`);
  await shot(name);
}

// -------------------------------------------------------------- day cycle
log('== 7. day cycle');
const home = await page.evaluate(() => window.__game.pickSite(0, 0));
for (const [name, t, pitch] of [
  ['14-noon', 0.5, -0.12],
  ['15-sunset', 0.74, 0.0],
  ['16-night', 0.02, 0.05],
  ['17-dawn', 0.255, 0.02],
]) {
  await page.evaluate(({ home, t, pitch }) => {
    const g = window.__game;
    g.player.flying = true;
    g.freezeClock(t);
    g.goTo(home.x, Math.max(home.h + 16, 58), home.z);
    g.setYawPitch(0.7, pitch);
  }, { home, t, pitch });
  await settle();
  await page.waitForTimeout(1600);
  await shot(name);
}

// ------------------------------------------------------------------ aerial
log('== 8. aerial');
await page.evaluate((home) => {
  const g = window.__game;
  g.freezeClock(0.34);
  g.player.flying = true;
  g.goTo(home.x, 86, home.z);
  g.setYawPitch(2.2, -0.34);
}, home);
await settle();
await page.waitForTimeout(2200);
await shot('18-aerial');

// ----------------------------------------------------------------- water
log('== 9. underwater');
const deep = await page.evaluate(() => {
  const g = window.__game;
  for (let z = -3000; z <= 3000; z += 24) {
    for (let x = -3000; x <= 3000; x += 24) {
      const h = g.world.heightAt(x, z);
      if (h > 6 && h < 30) return { x, z, y: Math.floor(h) };
    }
  }
  return null;
});
log('  ' + JSON.stringify(deep));
if (deep) {
  await page.evaluate((d) => {
    const g = window.__game;
    g.freezeClock(0.4);
    g.player.flying = true;
    g.goTo(d.x + 0.5, d.y + 2.2, d.z + 0.5);
    g.setYawPitch(0.9, -0.12);
  }, deep);
  await settle();
  await page.waitForTimeout(1800);
  await shot('19-underwater');
}

// ------------------------------------------------------------------- perf
log('== 10. fps probe');
await page.evaluate((home) => {
  const g = window.__game;
  g.releaseClock();
  g.freezeClock(0.36);
  g.player.flying = true;
  g.goTo(home.x, 64, home.z);
  g.setYawPitch(0.8, -0.18);
}, home);
await settle();
const perf = await page.evaluate(async () => {
  const start = performance.now();
  let frames = 0;
  await new Promise((done) => {
    const tick = () => { frames++; frames < 120 ? requestAnimationFrame(tick) : done(); };
    requestAnimationFrame(tick);
  });
  const seconds = (performance.now() - start) / 1000;
  return { fps: +(frames / seconds).toFixed(1), ...window.__game.report() };
});
log('  ' + JSON.stringify(perf));
await shot('20-overview');

// ----------------------------------------------------------------- report
const summary = {
  url: BASE,
  when: new Date().toISOString(),
  pageErrors,
  consoleErrors: [...new Set(consoleErrors)],
  perf,
  shots: readdirSync(OUT).filter((f) => f.endsWith('.png')).sort(),
};
writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(summary, null, 2));

log('== summary');
log(`  page errors        : ${pageErrors.length}`);
log(`  console warn/error : ${summary.consoleErrors.length}`);
pageErrors.slice(0, 5).forEach((e) => log('   ' + e.slice(0, 200)));
summary.consoleErrors.slice(0, 5).forEach((e) => log('   ' + e.slice(0, 200)));
log(`  screenshots        : ${summary.shots.length}`);

await browser.close();
process.exit(pageErrors.length || summary.consoleErrors.length ? 1 : 0);
