// Expected Value calculator for trading signals. ES module, no dependencies.
// Results are illustrative only; not financial advice.
import { t, ready, onLangChange } from '/i18n.js';

const NS = 'http://www.w3.org/2000/svg';

/* ---------- pure maths (exported for tests) ---------- */

export function calc(i) {
  const pipValue = i.pipSize * i.contract * i.lots; // $ per pip for the position
  const risk = i.slPips * pipValue;
  const reward = i.tpPips * pipValue;
  const costs = i.spreadPips * pipValue + i.commission * i.lots;
  const p = i.winRate / 100;
  const ev = p * (reward - costs) - (1 - p) * (risk + costs);
  const be = (risk + costs) / (risk + reward);
  return {
    pipValue, risk, reward, costs, ev,
    rr: reward / risk,
    costsR: costs / risk,
    evR: ev / risk,
    be: be * 100,
    margin: i.winRate - be * 100,
    evMonth: ev * i.trades,
    winPnl: reward - costs,
    lossPnl: -(risk + costs),
  };
}

export function evAt(c, pct) {
  const p = pct / 100;
  return p * c.winPnl + (1 - p) * c.lossPnl;
}

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function simulate(c, winRate, trades, months = 2000, bins = 30, seed = 20240229) {
  const rand = mulberry32(seed);
  const p = winRate / 100;
  const pnl = new Float64Array(months);
  const dd = new Float64Array(months);
  for (let m = 0; m < months; m++) {
    let eq = 0, peak = 0, maxDd = 0;
    for (let t = 0; t < trades; t++) {
      eq += rand() < p ? c.winPnl : c.lossPnl;
      if (eq > peak) peak = eq;
      else if (peak - eq > maxDd) maxDd = peak - eq;
    }
    pnl[m] = eq; dd[m] = maxDd;
  }
  const s = Float64Array.from(pnl).sort();
  const d = Float64Array.from(dd).sort();
  const q = (a, f) => a[Math.min(a.length - 1, Math.floor(f * a.length))];
  const min = s[0], max = s[months - 1];
  const span = max - min || 1;
  const counts = new Array(bins).fill(0);
  for (const v of pnl) counts[Math.min(bins - 1, Math.floor(((v - min) / span) * bins))]++;
  let losing = 0;
  for (const v of pnl) if (v < 0) losing++;
  return {
    min, max, bins, counts, width: span / bins, months,
    p5: q(s, 0.05), p50: q(s, 0.5), p95: q(s, 0.95),
    probLoss: losing / months, medDd: q(d, 0.5),
  };
}

// levels: [{pips, prob}] prob = chance of reaching this level given the previous one was reached.
export function splitEv(c, i, levels) {
  const n = levels.length;
  const pv = c.pipValue;
  let cum = 1;
  const rows = levels.map((l) => {
    cum *= l.prob;
    const reward = l.pips * pv;
    const ev = cum * (reward - c.costs) - (1 - cum) * (c.risk + c.costs);
    return { pips: l.pips, cum, ev };
  });
  const first = rows[0].ev;
  const last = rows[n - 1].ev;
  const split = rows.reduce((a, r) => a + r.ev, 0) / n; // each position is 1/n of the lots and of the costs
  return { rows, first, last, split };
}

/* ---------- UI ---------- */

function mount(root) {
  const loc = 'en-US'; // numbers keep en-US format in every language
  const fmtUsd = new Intl.NumberFormat(loc, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
  const fmtUsd0 = new Intl.NumberFormat(loc, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  const fmtNum = new Intl.NumberFormat(loc, { maximumFractionDigits: 2 });
  const fmtPct = new Intl.NumberFormat(loc, { maximumFractionDigits: 1 });
  const fmtR = new Intl.NumberFormat(loc, { maximumFractionDigits: 2, signDisplay: 'exceptZero' });
  const fmtPrice = new Intl.NumberFormat(loc, { maximumFractionDigits: 5, useGrouping: false });
  const ok = Number.isFinite;
  const usd = (v) => (ok(v) ? fmtUsd.format(v) : '—');
  const usd0 = (v) => (ok(v) ? fmtUsd0.format(v) : '—');
  const num = (v) => (ok(v) ? fmtNum.format(v) : '—');
  const pct = (v) => (ok(v) ? fmtPct.format(v) + '%' : '—');
  const rr = (v) => (ok(v) ? fmtR.format(v) + ' R' : '—');

  const S = {
    dir: 'sell', entry: '4156.2', pipSize: '0.1', contract: '100', lots: '0.01',
    sl: { mode: 'pips', v: '25' }, tp: { mode: 'pips', v: '600' },
    win: '5', spread: '2', comm: '7', trades: '20',
    split: [
      { pips: '200', prob: '50' }, { pips: '400', prob: '60' }, { pips: '600', prob: '70' },
    ],
  };

  const el = (tag, attrs = {}, html) => {
    const e = document.createElement(tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (html != null) e.innerHTML = html;
    return e;
  };

  function field(id, label, unit, help, extra = '') {
    return `<div class="ev-field"><label class="ev-label" for="ev-${id}">${label}${unit ? ` <span class="ev-unit">${unit}</span>` : ''}</label>
      <input class="ev-input" id="ev-${id}" type="number" inputmode="decimal" step="any" aria-describedby="ev-${id}-h" ${extra}>
      <p class="ev-help" id="ev-${id}-h">${help}</p></div>`;
  }
  function modeField(id, label, help) {
    return `<div class="ev-field"><div class="ev-labelrow"><label class="ev-label" for="ev-${id}">${label}</label>
      <div class="ev-seg" role="group" aria-label="${t('ev.modeAria', { label })}">
        <button type="button" class="ev-segbtn" data-mode="${id}:price" aria-pressed="false">${t('ev.mode.price')}</button>
        <button type="button" class="ev-segbtn" data-mode="${id}:pips" aria-pressed="true">${t('ev.mode.pips')}</button></div></div>
      <input class="ev-input" id="ev-${id}" type="number" inputmode="decimal" step="any" aria-describedby="ev-${id}-h">
      <p class="ev-help" id="ev-${id}-h">${help}</p></div>`;
  }

  const $ = (id) => root.querySelector('#ev-' + id);
  root.classList.add('ev-root');
  let inp, range;
  function build() {
  root.innerHTML = `
  <div class="ev-grid">
    <form class="ev-controls" onsubmit="return false" aria-label="${t('ev.aria.inputs')}" novalidate>
      <fieldset class="ev-fs"><legend class="ev-legend">${t('ev.setup')}</legend>
        <div class="ev-field"><span class="ev-label" id="ev-dir-l">${t('ev.direction')}</span>
          <div class="ev-seg" role="group" aria-labelledby="ev-dir-l">
            <button type="button" class="ev-segbtn" data-dir="buy" aria-pressed="false">${t('ev.buy')}</button>
            <button type="button" class="ev-segbtn" data-dir="sell" aria-pressed="true">${t('ev.sell')}</button></div>
          <p class="ev-help">${t('ev.help.direction')}</p></div>
        ${field('entry', t('ev.entry'), t('ev.unit.price'), t('ev.help.entry'))}
        ${modeField('sl', t('ev.sl'), t('ev.help.sl'))}
        ${modeField('tp', t('ev.tp'), t('ev.help.tp'))}
        <div class="ev-row2">
        ${field('pipSize', t('ev.pipSize'), t('ev.unit.price'), t('ev.help.pipSize'))}
        ${field('contract', t('ev.contract'), t('ev.unit.contract'), t('ev.help.contract'))}
        </div>
        ${field('lots', t('ev.lots'), t('ev.unit.lots'), t('ev.help.lots'))}
      </fieldset>
      <fieldset class="ev-fs"><legend class="ev-legend">${t('ev.winCosts')}</legend>
        <div class="ev-field"><label class="ev-label" for="ev-win">${t('ev.win')} <span class="ev-unit">%</span></label>
          <div class="ev-slider"><input class="ev-range" id="ev-win-r" type="range" min="0" max="100" step="1" aria-label="${t('ev.aria.slider')}">
          <input class="ev-input ev-narrow" id="ev-win" type="number" inputmode="decimal" step="any" aria-describedby="ev-win-h"></div>
          <p class="ev-help" id="ev-win-h">${t('ev.help.win')}</p></div>
        <div class="ev-row2">
        ${field('spread', t('ev.spread'), t('ev.unit.pips'), t('ev.help.spread'))}
        ${field('comm', t('ev.comm'), t('ev.unit.comm'), t('ev.help.comm'))}
        </div>
        ${field('trades', t('ev.trades'), t('ev.unit.trades'), t('ev.help.trades'))}
      </fieldset>
    </form>
    <div class="ev-results" aria-live="polite">
      <div class="ev-hint-box" id="ev-errs" hidden></div>
      <div class="ev-verdict-row"><span class="ev-pill" id="ev-pill"></span><span class="ev-verdict-note" id="ev-pill-note"></span></div>
      <dl class="ev-stats" id="ev-stats"></dl>
      <p class="ev-formula">${t('ev.formula')}</p>
    </div>
  </div>
  <div class="ev-charts">
    <figure class="ev-fig"><figcaption class="ev-figcap">${t('ev.c1.title')}</figcaption><div id="ev-c1"></div></figure>
    <figure class="ev-fig"><figcaption class="ev-figcap">${t('ev.c2.title')}</figcaption><div id="ev-c2"></div>
      <dl class="ev-stats ev-stats-sm" id="ev-mc-stats"></dl></figure>
  </div>
  <section class="ev-split" aria-labelledby="ev-split-t">
    <h3 class="ev-h3" id="ev-split-t">${t('ev.split.title')}</h3>
    <p class="ev-help">${t('ev.split.intro')}</p>
    <div class="ev-split-grid" id="ev-split-in"></div>
    <div class="ev-table-wrap"><table class="ev-table" id="ev-split-out"></table></div>
    <p class="ev-help" id="ev-split-msg"></p>
  </section>
  <p class="ev-disclaimer">${t('ev.disclaimer')}</p>`;

  inp = {};
  ['entry', 'sl', 'tp', 'pipSize', 'contract', 'lots', 'win', 'spread', 'comm', 'trades'].forEach((k) => (inp[k] = $(k)));
  range = $('win-r');
  buildSplit();
  bindInputs();
  }

  const parse = (s) => (String(s).trim() === '' ? NaN : Number(s));

  function derive() {
    const errs = {};
    const v = {
      entry: parse(S.entry), pipSize: parse(S.pipSize), contract: parse(S.contract), lots: parse(S.lots),
      winRate: parse(S.win), spreadPips: parse(S.spread), commission: parse(S.comm), trades: parse(S.trades),
    };
    if (!(v.entry > 0)) errs.entry = t('ev.err.entry');
    if (!(v.pipSize > 0)) errs.pipSize = t('ev.err.pipSize');
    if (!(v.contract > 0)) errs.contract = t('ev.err.contract');
    if (!(v.lots > 0)) errs.lots = t('ev.err.lots');
    if (!(v.winRate >= 0 && v.winRate <= 100)) errs.win = t('ev.err.win');
    if (!(v.spreadPips >= 0)) errs.spread = t('ev.err.spread');
    if (!(v.commission >= 0)) errs.comm = t('ev.err.comm');
    if (!(Number.isInteger(v.trades) && v.trades >= 1 && v.trades <= 1000)) errs.trades = t('ev.err.trades');
    const sell = S.dir === 'sell';
    for (const k of ['sl', 'tp']) {
      const x = parse(S[k].v);
      const name = k === 'sl' ? t('ev.sl') : t('ev.tp');
      const above = k === 'sl' ? sell : !sell; // should the price be above entry?
      let pips = NaN;
      if (!ok(x)) errs[k] = t('ev.err.valueMissing', { name });
      else if (S[k].mode === 'pips') {
        if (x > 0) pips = x; else errs[k] = t('ev.err.pipsPositive', { name });
      } else if (!(v.entry > 0) || !(v.pipSize > 0)) errs[k] = t('ev.err.needEntry');
      else {
        const d = (above ? x - v.entry : v.entry - x) / v.pipSize;
        if (d > 0) pips = d;
        else errs[k] = t(above ? 'ev.err.above' : 'ev.err.below', { name, dir: sell ? t('ev.sellLower') : t('ev.buyLower') });
      }
      v[k + 'Pips'] = pips;
    }
    return { v, errs };
  }

  function pipsToPrice(k, pips, v) {
    const above = k === 'sl' ? S.dir === 'sell' : S.dir === 'buy';
    return v.entry + (above ? 1 : -1) * pips * v.pipSize;
  }

  /* ----- charts ----- */
  const svg = (w, h, label, inner) =>
    `<svg class="ev-svg" viewBox="0 0 ${w} ${h}" role="img" aria-label="${label}" focusable="false">${inner}</svg>`;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const nice = (lo, hi, n) => {
    const span = hi - lo || 1;
    const raw = span / n;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || raw;
    const out = [];
    for (let t = Math.ceil(lo / step) * step; t <= hi + 1e-9; t += step) out.push(Math.abs(t) < 1e-9 ? 0 : t);
    return out;
  };

  function chart1(c, win) {
    const W = 560, H = 300, L = 62, R = 16, T = 18, B = 40;
    const y0 = c.lossPnl, y1 = c.winPnl;
    const lo = Math.min(y0, 0), hi = Math.max(y1, 0);
    const pad = (hi - lo) * 0.08 || 1;
    const ymin = lo - pad, ymax = hi + pad;
    const X = (p) => L + (p / 100) * (W - L - R);
    const Y = (v) => T + (1 - (v - ymin) / (ymax - ymin)) * (H - T - B);
    let g = '';
    for (const t of nice(ymin, ymax, 5)) g += `<line class="ev-grid-l" x1="${L}" x2="${W - R}" y1="${Y(t)}" y2="${Y(t)}"/><text class="ev-tick" x="${L - 8}" y="${Y(t) + 4}" text-anchor="end">${esc(usd0(t))}</text>`;
    for (let p = 0; p <= 100; p += 20) g += `<text class="ev-tick" x="${X(p)}" y="${H - B + 18}" text-anchor="middle">${p}%</text>`;
    g += `<text class="ev-axis-t" x="${(L + W - R) / 2}" y="${H - 6}" text-anchor="middle">${t('ev.axis.win')}</text>`;
    g += `<line class="ev-zero" x1="${L}" x2="${W - R}" y1="${Y(0)}" y2="${Y(0)}"/>`;
    g += `<line class="ev-line" x1="${X(0)}" y1="${Y(y0)}" x2="${X(100)}" y2="${Y(y1)}"/>`;
    const be = c.be;
    if (be >= 0 && be <= 100) {
      g += `<circle class="ev-mk ev-mk-be" cx="${X(be)}" cy="${Y(0)}" r="5"><title>${t('ev.c1.beTitle', { be: pct(be) })}</title></circle>`;
      const left = be > 70;
      g += `<text class="ev-lbl" x="${X(be) + (left ? -8 : 8)}" y="${Y(0) - 10}" text-anchor="${left ? 'end' : 'start'}">${t('ev.c1.beLabel', { be: pct(be) })}</text>`;
    }
    const ev = evAt(c, win);
    g += `<line class="ev-cur" x1="${X(win)}" x2="${X(win)}" y1="${T}" y2="${H - B}"/><circle class="ev-mk ev-mk-cur" cx="${X(win)}" cy="${Y(ev)}" r="5"><title>${t('ev.c1.youTitle', { win: pct(win), ev: usd(ev) })}</title></circle>`;
    const flip = win > 70;
    g += `<text class="ev-lbl" x="${X(win) + (flip ? -8 : 8)}" y="${Y(ev) + (ev >= 0 ? 18 : -10)}" text-anchor="${flip ? 'end' : 'start'}">${t('ev.c1.youLabel', { win: pct(win), ev: usd(ev) })}</text>`;
    const rows = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map((p) => `<tr><td>${p}%</td><td>${usd(evAt(c, p))}</td></tr>`).join('');
    const label = t('ev.c1.desc', { y0: usd(y0), y1: usd(y1), be: pct(be), win: pct(win), ev: usd(ev) });
    $('c1').innerHTML = svg(W, H, esc(label), `<title>${t('ev.c1.title')}</title><desc>${esc(label)}</desc>${g}`) +
      `<table class="ev-sr"><caption>${t('ev.c1.title')}</caption><thead><tr><th>${t('ev.axis.win')}</th><th>${t('ev.stat.ev')}</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  function chart2(c, sim) {
    const W = 560, H = 300, L = 16, R = 16, T = 28, B = 40;
    const n = sim.bins;
    const maxC = Math.max(...sim.counts, 1);
    const X = (v) => L + ((v - sim.min) / (sim.max - sim.min || 1)) * (W - L - R);
    const Y = (k) => T + (1 - k / maxC) * (H - T - B);
    let g = '';
    const bw = (W - L - R) / n;
    const rowsT = [];
    sim.counts.forEach((k, b) => {
      const a = sim.min + b * sim.width, z = a + sim.width;
      const neg = (a + z) / 2 < 0;
      rowsT.push(`<tr><td>${t('ev.range', { a: usd0(a), z: usd0(z) })}</td><td>${k}</td></tr>`);
      if (k) g += `<rect class="${neg ? 'ev-bar-neg' : 'ev-bar-pos'}" x="${L + b * bw + 1}" y="${Y(k)}" width="${Math.max(bw - 2, 1)}" height="${H - B - Y(k)}" rx="2"><title>${t('ev.c2.barTitle', { a: usd0(a), z: usd0(z), k, months: sim.months })}</title></rect>`;
    });
    g += `<line class="ev-zero" x1="${L}" x2="${W - R}" y1="${H - B}" y2="${H - B}"/>`;
    if (sim.min < 0 && sim.max > 0) g += `<line class="ev-zero" x1="${X(0)}" x2="${X(0)}" y1="${T}" y2="${H - B}" stroke-dasharray="3 3"/><text class="ev-tick" x="${X(0)}" y="${H - B + 30}" text-anchor="middle">$0</text>`;
    [['p5', t('ev.c2.p5'), 'start'], ['p50', t('ev.c2.median'), 'middle'], ['p95', t('ev.c2.p95'), 'end']].forEach(([k, name], idx) => {
      const x = X(sim[k]);
      g += `<line class="ev-pct" x1="${x}" x2="${x}" y1="${T - 6}" y2="${H - B}"/><text class="ev-lbl" x="${x}" y="${T - 12 + (idx === 1 ? 0 : 0)}" text-anchor="${idx === 0 ? 'end' : idx === 2 ? 'start' : 'middle'}">${name} ${usd0(sim[k])}</text>`;
    });
    g += `<text class="ev-tick" x="${L}" y="${H - B + 18}" text-anchor="start">${usd0(sim.min)}</text><text class="ev-tick" x="${W - R}" y="${H - B + 18}" text-anchor="end">${usd0(sim.max)}</text><text class="ev-axis-t" x="${W / 2}" y="${H - 6}" text-anchor="middle">${t('ev.c2.axis')}</text>`;
    const label = t('ev.c2.desc', { p5: usd0(sim.p5), p50: usd0(sim.p50), p95: usd0(sim.p95), loss: pct(sim.probLoss * 100) });
    $('c2').innerHTML = svg(W, H, esc(label), `<title>${t('ev.c2.svgTitle')}</title><desc>${esc(label)}</desc>${g}`) +
      `<table class="ev-sr"><caption>${t('ev.c2.caption')}</caption><thead><tr><th>${t('ev.c2.thRange')}</th><th>${t('ev.c2.thMonths')}</th></tr></thead><tbody>${rowsT.join('')}</tbody></table>`;
    $('mc-stats').innerHTML = stat(t('ev.mc.p5'), usd(sim.p5)) + stat(t('ev.mc.median'), usd(sim.p50)) + stat(t('ev.mc.p95'), usd(sim.p95)) +
      stat(t('ev.mc.loss'), pct(sim.probLoss * 100)) + stat(t('ev.mc.dd'), usd(sim.medDd));
  }

  const stat = (k, v, cls = '') => `<div class="ev-stat"><dt>${k}</dt><dd class="${cls}">${v}</dd></div>`;

  /* ----- split section ----- */
  function buildSplit() {
  $('split-in').innerHTML = S.split.map((_, n) => `<div class="ev-split-row"><span class="ev-label">${t('ev.tpN', { n: n + 1 })}</span>
    <label class="ev-sublabel" for="ev-sp-${n}">${t('ev.split.pips')}</label><input class="ev-input" id="ev-sp-${n}" type="number" inputmode="decimal" step="any">
    <label class="ev-sublabel" for="ev-pr-${n}">${t('ev.split.chance')}</label><input class="ev-input" id="ev-pr-${n}" type="number" inputmode="decimal" step="any"></div>`).join('');
  }

  function renderSplit(c, v) {
    const levels = [];
    let msg = '';
    let prev = 0;
    for (let n = 0; n < 3; n++) {
      const pips = parse(S.split[n].pips), pr = parse(S.split[n].prob);
      if (String(S.split[n].pips).trim() === '') continue;
      if (!(pips > 0) || !(pr >= 0 && pr <= 100)) { msg = t('ev.split.errValue', { n: n + 1 }); break; }
      if (pips <= prev) { msg = t('ev.split.errOrder', { n: n + 1 }); break; }
      prev = pips;
      levels.push({ pips, prob: pr / 100 });
    }
    const tbl = $('split-out');
    if (!c || msg || !levels.length) {
      tbl.innerHTML = '';
      $('split-msg').textContent = msg || (c ? t('ev.split.none') : t('ev.split.fix'));
      return;
    }
    const r = splitEv(c, v, levels);
    const best = Math.max(r.first, r.last, r.split);
    const cell = (x) => `<td class="${x === best ? 'ev-best' : ''}">${usd(x)}${x === best ? ' ' + t('ev.split.best') : ''}</td>`;
    tbl.innerHTML = `<caption class="ev-sr">${t('ev.split.caption')}</caption><thead><tr><th scope="col">${t('ev.split.thLevel')}</th><th scope="col">${t('ev.split.pips')}</th><th scope="col">${t('ev.split.thCum')}</th><th scope="col">${t('ev.split.thEv')}</th></tr></thead><tbody>` +
      r.rows.map((x, n) => `<tr><th scope="row">${t('ev.tpN', { n: n + 1 })}</th><td>${num(x.pips)}</td><td>${pct(x.cum * 100)}</td><td>${usd(x.ev)}</td></tr>`).join('') +
      `</tbody><tfoot><tr><th scope="row" colspan="2">${t('ev.split.strategy')}</th><th scope="col">${t('ev.split.first')}</th><th scope="col">${t('ev.split.last')}</th>${levels.length > 1 ? `<th scope="col">${t('ev.split.equal')}</th>` : ''}</tr>
      <tr><th scope="row" colspan="2">${t('ev.split.evSignal')}</th>${cell(r.first)}${cell(r.last)}${levels.length > 1 ? cell(r.split) : ''}</tr></tfoot>`;
    $('split-msg').textContent = t('ev.split.note');
  }

  /* ----- render ----- */
  let mcTimer = 0;
  function render() {
    const { v, errs } = derive();
    // reflect error state and derived price hints
    for (const k of ['entry', 'sl', 'tp', 'pipSize', 'contract', 'lots', 'win', 'spread', 'comm', 'trades']) {
      const bad = !!errs[k];
      inp[k].setAttribute('aria-invalid', bad ? 'true' : 'false');
      inp[k].classList.toggle('ev-bad', bad);
    }
    const eb = $('errs');
    const list = Object.values(errs);
    eb.hidden = !list.length;
    eb.innerHTML = list.length ? `<strong>${t('ev.errs.title')}</strong><ul>` + list.map((e) => `<li>${esc(e)}</li>`).join('') + '</ul>' : '';
    for (const k of ['sl', 'tp']) {
      const h = $(k + '-h');
      const base = t(k === 'sl' ? 'ev.hint.sl' : 'ev.hint.tp');
      if (ok(v[k + 'Pips']) && ok(v.entry) && ok(v.pipSize)) {
        h.textContent = t('ev.hint.derived', { base, pips: num(v[k + 'Pips']), price: fmtPrice.format(pipsToPrice(k, v[k + 'Pips'], v)) });
      } else h.textContent = base;
    }
    const need = ['entry', 'sl', 'tp', 'pipSize', 'contract', 'lots', 'win', 'spread', 'comm', 'trades'];
    const valid = need.every((k) => !errs[k]);
    const stats = $('stats'), pill = $('pill'), note = $('pill-note');
    if (!valid) {
      stats.innerHTML = ''; pill.textContent = t('ev.verdict.incomplete'); pill.className = 'ev-pill ev-pill-warn'; note.textContent = '';
      $('c1').innerHTML = ''; $('c2').innerHTML = ''; $('mc-stats').innerHTML = '';
      renderSplit(null, v);
      return;
    }
    const c = calc(v);
    const eps = 0.05; // percentage points treated as break-even
    let cls, text;
    if (c.margin > eps) { cls = 'pos'; text = t('ev.verdict.pos'); } else if (c.margin < -eps) { cls = 'neg'; text = t('ev.verdict.neg'); } else { cls = 'flat'; text = t('ev.verdict.flat'); }
    pill.textContent = text; pill.className = 'ev-pill ev-pill-' + cls;
    note.textContent = t(c.margin >= 0 ? 'ev.verdict.above' : 'ev.verdict.below', { pts: fmtPct.format(Math.abs(c.margin)), be: pct(c.be) });
    const evc = c.ev > 0 ? 'ev-pos' : c.ev < 0 ? 'ev-neg' : '';
    stats.innerHTML =
      stat(t('ev.stat.risk'), usd(c.risk)) + stat(t('ev.stat.reward'), usd(c.reward)) +
      stat(t('ev.stat.rr'), `1 : ${num(c.rr)}`) + stat(t('ev.stat.costs'), `${usd(c.costs)} <span class="ev-sub">(${num(c.costsR)} R)</span>`) +
      stat(t('ev.stat.be'), pct(c.be)) + stat(t('ev.stat.pipValue'), usd(c.pipValue)) +
      stat(t('ev.stat.ev'), `${usd(c.ev)} <span class="ev-sub">(${rr(c.evR)})</span>`, evc) +
      stat(t('ev.stat.evMonth'), `${usd(c.evMonth)} <span class="ev-sub">${t('ev.stat.nTrades', { n: num(v.trades) })}</span>`, evc);
    chart1(c, v.winRate);
    clearTimeout(mcTimer);
    mcTimer = setTimeout(() => chart2(c, simulate(c, v.winRate, v.trades)), 120);
    renderSplit(c, v);
  }

  /* ----- sync inputs <-> state ----- */
  function sync() {
    inp.entry.value = S.entry; inp.pipSize.value = S.pipSize; inp.contract.value = S.contract; inp.lots.value = S.lots;
    inp.sl.value = S.sl.v; inp.tp.value = S.tp.v; inp.win.value = S.win; range.value = ok(parse(S.win)) ? parse(S.win) : 0;
    inp.spread.value = S.spread; inp.comm.value = S.comm; inp.trades.value = S.trades;
    S.split.forEach((r, n) => { $('sp-' + n).value = r.pips; $('pr-' + n).value = r.prob; });
    root.querySelectorAll('[data-dir]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.dir === S.dir)));
    for (const k of ['sl', 'tp']) root.querySelectorAll(`[data-mode^="${k}:"]`).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode.split(':')[1] === S[k].mode)));
  }

  function bindInputs() {
  const map = { entry: 'entry', pipSize: 'pipSize', contract: 'contract', lots: 'lots', spread: 'spread', comm: 'comm', trades: 'trades' };
  for (const k in map) inp[k].addEventListener('input', () => { S[map[k]] = inp[k].value; render(); });
  inp.sl.addEventListener('input', () => { S.sl.v = inp.sl.value; render(); });
  inp.tp.addEventListener('input', () => { S.tp.v = inp.tp.value; render(); });
  inp.win.addEventListener('input', () => { S.win = inp.win.value; const x = parse(S.win); if (ok(x)) range.value = Math.min(100, Math.max(0, x)); render(); });
  range.addEventListener('input', () => { S.win = range.value; inp.win.value = range.value; render(); });
  S.split.forEach((_, n) => {
    $('sp-' + n).addEventListener('input', (e) => { S.split[n].pips = e.target.value; render(); });
    $('pr-' + n).addEventListener('input', (e) => { S.split[n].prob = e.target.value; render(); });
  });
  }

  root.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.dir) {
      // keep pips; convert price-mode values so they stay on the correct side
      const { v } = derive();
      const old = {}; for (const k of ['sl', 'tp']) old[k] = v[k + 'Pips'];
      S.dir = b.dataset.dir;
      for (const k of ['sl', 'tp']) if (S[k].mode === 'price' && ok(old[k]) && ok(v.entry)) S[k].v = fmtPrice.format(pipsToPrice(k, old[k], v));
    } else if (b.dataset.mode) {
      const [k, m] = b.dataset.mode.split(':');
      if (S[k].mode !== m) {
        const { v } = derive();
        const pips = v[k + 'Pips'];
        if (ok(pips) && ok(v.entry) && ok(v.pipSize)) S[k].v = m === 'pips' ? fmtPrice.format(pips) : fmtPrice.format(pipsToPrice(k, pips, v));
        S[k].mode = m;
      }
    } else return;
    sync(); render();
  });

  build(); sync(); render();
  onLangChange(() => { build(); sync(); render(); });
}

if (typeof document !== 'undefined') {
  const run = async () => { await ready; const r = document.getElementById('ev-app'); if (r) mount(r); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run); else run();
}
