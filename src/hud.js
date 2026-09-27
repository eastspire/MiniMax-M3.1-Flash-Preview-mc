// Heads-up display: the block belt, the debug readout, transient messages and
// the underwater grade.
//
// The block icons are drawn on a 2D canvas from the same average tile colours
// the 3D world samples, so the belt can never drift out of step with the
// textures. The markup it fills lives in index.html; nothing here creates the
// containers themselves.

import { blockTable } from './blocks.js';

const BELT_ICON = 44;      // backing canvas is square and scaled down by CSS

export class Hud {
  constructor() {
    this.shell = document.getElementById('shell');
    this.readout = document.getElementById('readout');
    this.belt = document.getElementById('belt');
    this.flash = document.getElementById('flash');
    this.grade = document.getElementById('submerged');
    this.meterFill = document.getElementById('meter-fill');
    this.meterCaption = document.getElementById('meter-caption');
    this.boot = document.getElementById('boot');

    this.averages = [];
    this.chosen = 0;
    this.cells = [];
    this._flashTimer = 0;
  }

  attachAverages(averages) { this.averages = averages; }

  /** Build one cell per block id in `ids`. */
  loadBelt(ids) {
    this.belt.textContent = '';
    this.cells = ids.map((id, i) => {
      const cell = document.createElement('div');
      cell.className = 'cell';
      cell.dataset.on = i === this.chosen ? '1' : '0';

      const icon = document.createElement('canvas');
      icon.width = icon.height = BELT_ICON;
      this.drawIcon(icon, id);

      const key = document.createElement('span');
      key.className = 'key';
      key.textContent = i === 9 ? '0' : String(i + 1);

      const title = document.createElement('span');
      title.className = 'title';
      title.textContent = blockTable[id].name;

      cell.append(icon, key, title);
      this.belt.appendChild(cell);
      return cell;
    });
  }

  /**
   * Draw a block as an isometric cube: a rhombus on top with the two visible
   * sides sheared down from it, each stepped darker so the form reads even at
   * 36 pixels.
   */
  drawIcon(canvas, blockId) {
    const spec = blockTable[blockId];
    const ctx = canvas.getContext('2d');
    const n = canvas.width;
    ctx.clearRect(0, 0, n, n);

    const cx = n / 2, cy = n / 2 + 3;
    const arm = n * 0.41;
    const skirt = arm * 0.92;

    const tint = (layer, k = 1) => {
      const a = this.averages[layer] || [0.6, 0.6, 0.6];
      return `rgb(${(a[0] * 255 * k) | 0},${(a[1] * 255 * k) | 0},${(a[2] * 255 * k) | 0})`;
    };

    const quad = (points, fill) => {
      ctx.beginPath();
      ctx.moveTo(points[0][0], points[0][1]);
      for (let i = 1; i < points.length; i++) ctx.lineTo(points[i][0], points[i][1]);
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
    };

    quad([[cx - arm, cy], [cx, cy + arm], [cx, cy + arm + skirt], [cx - arm, cy + skirt]],
      tint(spec.textureFor(0), 0.6));
    quad([[cx + arm, cy], [cx, cy + arm], [cx, cy + arm + skirt], [cx + arm, cy + skirt]],
      tint(spec.textureFor(4), 0.8));
    quad([[cx, cy - arm], [cx + arm, cy], [cx, cy + arm], [cx - arm, cy]],
      tint(spec.textureFor(2)));

    ctx.lineWidth = 1.4;
    ctx.strokeStyle = 'rgb(0 0 0 / 0.32)';
    ctx.beginPath();
    ctx.moveTo(cx, cy - arm);
    ctx.lineTo(cx + arm, cy);
    ctx.lineTo(cx, cy + arm);
    ctx.lineTo(cx - arm, cy);
    ctx.closePath();
    ctx.stroke();
  }

  choose(index) {
    if (!this.cells.length) return;
    this.chosen = ((index % this.cells.length) + this.cells.length) % this.cells.length;
    this.cells.forEach((cell, i) => { cell.dataset.on = i === this.chosen ? '1' : '0'; });
  }

  writeReadout(rows) { this.readout.innerHTML = rows.join('<br>'); }

  setSubmerged(on) { this.grade.dataset.active = on ? '1' : '0'; }

  setTrimmed(on) { this.shell.dataset.trim = on ? '1' : '0'; }

  setVisible(on) { this.shell.hidden = !on; }

  say(message) {
    this.flash.textContent = message;
    this.flash.dataset.show = '1';
    clearTimeout(this._flashTimer);
    this._flashTimer = setTimeout(() => { this.flash.dataset.show = '0'; }, 1400);
  }

  /** Boot progress, 0..1. Once complete the boot card is dismissed. */
  setProgress(fraction, caption) {
    this.meterFill.style.inlineSize = `${(fraction * 100).toFixed(0)}%`;
    this.meterCaption.textContent = caption;
  }

  finishBoot() { this.boot.dataset.done = '1'; }
}
