// Expected Value calculator for trading signals. ES module, no dependencies.
// Results are illustrative only; not financial advice.

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
  const loc = undefined;
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
      <div class="ev-seg" role="group" aria-label="${label} input mode">
        <button type="button" class="ev-segbtn" data-mode="${id}:price" aria-pressed="false">Price</button>
        <button type="button" class="ev-segbtn" data-mode="${id}:pips" aria-pressed="true">Pips</button></div></div>
      <input class="ev-input" id="ev-${id}" type="number" inputmode="decimal" step="any" aria-describedby="ev-${id}-h">
      <p class="ev-help" id="ev-${id}-h">${help}</p></div>`;
  }

  root.classList.add('ev-root');
  root.innerHTML = `
  <div class="ev-grid">
    <form class="ev-controls" onsubmit="return false" aria-label="Trade inputs" novalidate>
      <fieldset class="ev-fs"><legend class="ev-legend">Trade setup</legend>
        <div class="ev-field"><span class="ev-label" id="ev-dir-l">Direction</span>
          <div class="ev-seg" role="group" aria-labelledby="ev-dir-l">
            <button type="button" class="ev-segbtn" data-dir="buy" aria-pressed="false">Buy</button>
            <button type="button" class="ev-segbtn" data-dir="sell" aria-pressed="true">Sell</button></div>
          <p class="ev-help">Sell profits when price falls.</p></div>
        ${field('entry', 'Entry price', 'price', 'The limit or market entry from the signal.')}
        ${modeField('sl', 'Stop loss', 'Distance you can lose. 1 pip = pip size in price.')}
        ${modeField('tp', 'Take profit', 'Distance to the target.')}
        <div class="ev-row2">
        ${field('pipSize', 'Pip size', 'price', '0.1 for gold at IC Markets.')}
        ${field('contract', 'Contract size', 'units/lot', '100 oz per lot for XAUUSD.')}
        </div>
        ${field('lots', 'Lot size', 'lots', 'Position size, e.g. 0.01.')}
      </fieldset>
      <fieldset class="ev-fs"><legend class="ev-legend">Win rate and costs</legend>
        <div class="ev-field"><label class="ev-label" for="ev-win">Win rate <span class="ev-unit">%</span></label>
          <div class="ev-slider"><input class="ev-range" id="ev-win-r" type="range" min="0" max="100" step="1" aria-label="Win rate slider">
          <input class="ev-input ev-narrow" id="ev-win" type="number" inputmode="decimal" step="any" aria-describedby="ev-win-h"></div>
          <p class="ev-help" id="ev-win-h">Use the provider's real track record (the trade log), not a guess.</p></div>
        <div class="ev-row2">
        ${field('spread', 'Spread', 'pips', 'Paid on entry; counted as a cost on every trade.')}
        ${field('comm', 'Commission', '$/lot round trip', 'IC Markets Raw: about 7.')}
        </div>
        ${field('trades', 'Trades per month', 'trades', 'Whole number, 1 to 1000.')}
      </fieldset>
    </form>
    <div class="ev-results" aria-live="polite">
      <div class="ev-hint-box" id="ev-errs" hidden></div>
      <div class="ev-verdict-row"><span class="ev-pill" id="ev-pill"></span><span class="ev-verdict-note" id="ev-pill-note"></span></div>
      <dl class="ev-stats" id="ev-stats"></dl>
      <p class="ev-formula"><strong>How EV is computed.</strong> EV per trade = win rate &times; (reward &minus; costs) &minus; (1 &minus; win rate) &times; (risk + costs).
      Break-even win rate = (risk + costs) &divide; (risk + reward). R means multiples of the risk on one trade.</p>
    </div>
  </div>
  <div class="ev-charts">
    <figure class="ev-fig"><figcaption class="ev-figcap">EV per trade by win rate</figcaption><div id="ev-c1"></div></figure>
    <figure class="ev-fig"><figcaption class="ev-figcap">Monte Carlo: 2,000 simulated months</figcaption><div id="ev-c2"></div>
      <dl class="ev-stats ev-stats-sm" id="ev-mc-stats"></dl></figure>
  </div>
  <section class="ev-split" aria-labelledby="ev-split-t">
    <h3 class="ev-h3" id="ev-split-t">TP split: one target or several?</h3>
    <p class="ev-help">Enter up to 3 take-profit levels in pips (leave blank to skip). Probability is the chance of reaching that level <em>given the previous level was reached</em>, before the stop. The stop is not moved. "Split" opens one position per level with the lots divided equally.</p>
    <div class="ev-split-grid" id="ev-split-in"></div>
    <div class="ev-table-wrap"><table class="ev-table" id="ev-split-out"></table></div>
    <p class="ev-help" id="ev-split-msg"></p>
  </section>
  <p class="ev-disclaimer">Illustrative only. The win rate must come from the signal provider's real, verified track record (see the dashboard's trade log); past results do not guarantee future ones. Costs here are estimates (slippage and swaps ignored). This is not financial advice.</p>`;

  const $ = (id) => root.querySelector('#ev-' + id);
  const inp = {};
  ['entry', 'sl', 'tp', 'pipSize', 'contract', 'lots', 'win', 'spread', 'comm', 'trades'].forEach((k) => (inp[k] = $(k)));
  const range = $('win-r');

  const parse = (s) => (String(s).trim() === '' ? NaN : Number(s));

  function derive() {
    const errs = {};
    const v = {
      entry: parse(S.entry), pipSize: parse(S.pipSize), contract: parse(S.contract), lots: parse(S.lots),
      winRate: parse(S.win), spreadPips: parse(S.spread), commission: parse(S.comm), trades: parse(S.trades),
    };
    if (!(v.entry > 0)) errs.entry = 'Enter a positive entry price.';
    if (!(v.pipSize > 0)) errs.pipSize = 'Pip size must be greater than 0.';
    if (!(v.contract > 0)) errs.contract = 'Contract size must be greater than 0.';
    if (!(v.lots > 0)) errs.lots = 'Lot size must be greater than 0.';
    if (!(v.winRate >= 0 && v.winRate <= 100)) errs.win = 'Win rate must be between 0 and 100.';
    if (!(v.spreadPips >= 0)) errs.spread = 'Spread cannot be negative.';
    if (!(v.commission >= 0)) errs.comm = 'Commission cannot be negative.';
    if (!(Number.isInteger(v.trades) && v.trades >= 1 && v.trades <= 1000)) errs.trades = 'Use a whole number from 1 to 1000.';
    const sell = S.dir === 'sell';
    for (const k of ['sl', 'tp']) {
      const x = parse(S[k].v);
      const name = k === 'sl' ? 'Stop loss' : 'Take profit';
      const above = k === 'sl' ? sell : !sell; // should the price be above entry?
      let pips = NaN;
      if (!ok(x)) errs[k] = `Enter a ${name.toLowerCase()} value.`;
      else if (S[k].mode === 'pips') {
        if (x > 0) pips = x; else errs[k] = `${name} must be more than 0 pips.`;
      } else if (!(v.entry > 0) || !(v.pipSize > 0)) errs[k] = 'Needs a valid entry price and pip size.';
      else {
        const d = (above ? x - v.entry : v.entry - x) / v.pipSize;
        if (d > 0) pips = d;
        else errs[k] = `For a ${sell ? 'sell' : 'buy'}, ${name.toLowerCase()} must be ${above ? 'above' : 'below'} the entry price.`;
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
    g += `<text class="ev-axis-t" x="${(L + W - R) / 2}" y="${H - 6}" text-anchor="middle">Win rate</text>`;
    g += `<line class="ev-zero" x1="${L}" x2="${W - R}" y1="${Y(0)}" y2="${Y(0)}"/>`;
    g += `<line class="ev-line" x1="${X(0)}" y1="${Y(y0)}" x2="${X(100)}" y2="${Y(y1)}"/>`;
    const be = c.be;
    if (be >= 0 && be <= 100) {
      g += `<circle class="ev-mk ev-mk-be" cx="${X(be)}" cy="${Y(0)}" r="5"><title>Break-even win rate ${pct(be)}</title></circle>`;
      const left = be > 70;
      g += `<text class="ev-lbl" x="${X(be) + (left ? -8 : 8)}" y="${Y(0) - 10}" text-anchor="${left ? 'end' : 'start'}">Break-even ${pct(be)}</text>`;
    }
    const ev = evAt(c, win);
    g += `<line class="ev-cur" x1="${X(win)}" x2="${X(win)}" y1="${T}" y2="${H - B}"/><circle class="ev-mk ev-mk-cur" cx="${X(win)}" cy="${Y(ev)}" r="5"><title>Your win rate ${pct(win)}: EV ${usd(ev)}</title></circle>`;
    const flip = win > 70;
    g += `<text class="ev-lbl" x="${X(win) + (flip ? -8 : 8)}" y="${Y(ev) + (ev >= 0 ? 18 : -10)}" text-anchor="${flip ? 'end' : 'start'}">You: ${pct(win)}, ${usd(ev)}</text>`;
    const rows = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map((p) => `<tr><td>${p}%</td><td>${usd(evAt(c, p))}</td></tr>`).join('');
    const label = `Line chart of EV per trade against win rate. EV rises from ${usd(y0)} at 0% to ${usd(y1)} at 100%. Break-even at ${pct(be)}. At your win rate of ${pct(win)} EV is ${usd(ev)}.`;
    $('c1').innerHTML = svg(W, H, esc(label), `<title>EV per trade by win rate</title><desc>${esc(label)}</desc>${g}`) +
      `<table class="ev-sr"><caption>EV per trade by win rate</caption><thead><tr><th>Win rate</th><th>EV per trade</th></tr></thead><tbody>${rows}</tbody></table>`;
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
      rowsT.push(`<tr><td>${usd0(a)} to ${usd0(z)}</td><td>${k}</td></tr>`);
      if (k) g += `<rect class="${neg ? 'ev-bar-neg' : 'ev-bar-pos'}" x="${L + b * bw + 1}" y="${Y(k)}" width="${Math.max(bw - 2, 1)}" height="${H - B - Y(k)}" rx="2"><title>${usd0(a)} to ${usd0(z)}: ${k} of ${sim.months} months</title></rect>`;
    });
    g += `<line class="ev-zero" x1="${L}" x2="${W - R}" y1="${H - B}" y2="${H - B}"/>`;
    if (sim.min < 0 && sim.max > 0) g += `<line class="ev-zero" x1="${X(0)}" x2="${X(0)}" y1="${T}" y2="${H - B}" stroke-dasharray="3 3"/><text class="ev-tick" x="${X(0)}" y="${H - B + 30}" text-anchor="middle">$0</text>`;
    [['p5', '5th', 'start'], ['p50', 'Median', 'middle'], ['p95', '95th', 'end']].forEach(([k, name], idx) => {
      const x = X(sim[k]);
      g += `<line class="ev-pct" x1="${x}" x2="${x}" y1="${T - 6}" y2="${H - B}"/><text class="ev-lbl" x="${x}" y="${T - 12 + (idx === 1 ? 0 : 0)}" text-anchor="${idx === 0 ? 'end' : idx === 2 ? 'start' : 'middle'}">${name} ${usd0(sim[k])}</text>`;
    });
    g += `<text class="ev-tick" x="${L}" y="${H - B + 18}" text-anchor="start">${usd0(sim.min)}</text><text class="ev-tick" x="${W - R}" y="${H - B + 18}" text-anchor="end">${usd0(sim.max)}</text><text class="ev-axis-t" x="${W / 2}" y="${H - 6}" text-anchor="middle">Monthly profit or loss</text>`;
    const label = `Histogram of simulated monthly profit and loss. 5th percentile ${usd0(sim.p5)}, median ${usd0(sim.p50)}, 95th percentile ${usd0(sim.p95)}. Probability of a losing month ${pct(sim.probLoss * 100)}.`;
    $('c2').innerHTML = svg(W, H, esc(label), `<title>Monte Carlo monthly P/L</title><desc>${esc(label)}</desc>${g}`) +
      `<table class="ev-sr"><caption>Monthly P/L histogram</caption><thead><tr><th>Range</th><th>Months</th></tr></thead><tbody>${rowsT.join('')}</tbody></table>`;
    $('mc-stats').innerHTML = stat('5th percentile', usd(sim.p5)) + stat('Median month', usd(sim.p50)) + stat('95th percentile', usd(sim.p95)) +
      stat('Chance of a losing month', pct(sim.probLoss * 100)) + stat('Median max drawdown', usd(sim.medDd));
  }

  const stat = (k, v, cls = '') => `<div class="ev-stat"><dt>${k}</dt><dd class="${cls}">${v}</dd></div>`;

  /* ----- split section ----- */
  const splitIn = $('split-in');
  splitIn.innerHTML = S.split.map((_, n) => `<div class="ev-split-row"><span class="ev-label">TP${n + 1}</span>
    <label class="ev-sublabel" for="ev-sp-${n}">Pips</label><input class="ev-input" id="ev-sp-${n}" type="number" inputmode="decimal" step="any">
    <label class="ev-sublabel" for="ev-pr-${n}">Chance of reaching, %</label><input class="ev-input" id="ev-pr-${n}" type="number" inputmode="decimal" step="any"></div>`).join('');

  function renderSplit(c, v) {
    const levels = [];
    let msg = '';
    let prev = 0;
    for (let n = 0; n < 3; n++) {
      const pips = parse(S.split[n].pips), pr = parse(S.split[n].prob);
      if (String(S.split[n].pips).trim() === '') continue;
      if (!(pips > 0) || !(pr >= 0 && pr <= 100)) { msg = `TP${n + 1}: use pips above 0 and a probability from 0 to 100.`; break; }
      if (pips <= prev) { msg = `TP${n + 1} must be further away than the previous level.`; break; }
      prev = pips;
      levels.push({ pips, prob: pr / 100 });
    }
    const t = $('split-out');
    if (!c || msg || !levels.length) {
      t.innerHTML = '';
      $('split-msg').textContent = msg || (c ? 'Enter at least one level.' : 'Fix the trade inputs above first.');
      return;
    }
    const r = splitEv(c, v, levels);
    const best = Math.max(r.first, r.last, r.split);
    const cell = (x) => `<td class="${x === best ? 'ev-best' : ''}">${usd(x)}${x === best ? ' (best)' : ''}</td>`;
    t.innerHTML = `<caption class="ev-sr">Blended EV per signal by TP strategy</caption><thead><tr><th scope="col">Level</th><th scope="col">Pips</th><th scope="col">Cumulative chance</th><th scope="col">EV if sole target</th></tr></thead><tbody>` +
      r.rows.map((x, n) => `<tr><th scope="row">TP${n + 1}</th><td>${num(x.pips)}</td><td>${pct(x.cum * 100)}</td><td>${usd(x.ev)}</td></tr>`).join('') +
      `</tbody><tfoot><tr><th scope="row" colspan="2">Strategy</th><th scope="col">First TP only</th><th scope="col">Last TP only</th>${levels.length > 1 ? '<th scope="col">Split equally</th>' : ''}</tr>
      <tr><th scope="row" colspan="2">EV per signal</th>${cell(r.first)}${cell(r.last)}${levels.length > 1 ? cell(r.split) : ''}</tr></tfoot>`;
    $('split-msg').textContent = 'Uses the stop loss, costs and lot size above. Split divides lots and costs equally across the levels, so every position keeps the same stop.';
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
    eb.innerHTML = list.length ? '<strong>Check these inputs</strong><ul>' + list.map((e) => `<li>${esc(e)}</li>`).join('') + '</ul>' : '';
    for (const k of ['sl', 'tp']) {
      const h = $(k + '-h');
      const base = k === 'sl' ? 'Distance you can lose.' : 'Distance to the target.';
      if (ok(v[k + 'Pips']) && ok(v.entry) && ok(v.pipSize)) {
        h.textContent = `${base} = ${num(v[k + 'Pips'])} pips, price ${fmtPrice.format(pipsToPrice(k, v[k + 'Pips'], v))}.`;
      } else h.textContent = base;
    }
    const need = ['entry', 'sl', 'tp', 'pipSize', 'contract', 'lots', 'win', 'spread', 'comm', 'trades'];
    const valid = need.every((k) => !errs[k]);
    const stats = $('stats'), pill = $('pill'), note = $('pill-note');
    if (!valid) {
      stats.innerHTML = ''; pill.textContent = 'Inputs incomplete'; pill.className = 'ev-pill ev-pill-warn'; note.textContent = '';
      $('c1').innerHTML = ''; $('c2').innerHTML = ''; $('mc-stats').innerHTML = '';
      renderSplit(null, v);
      return;
    }
    const c = calc(v);
    const eps = 0.05; // percentage points treated as break-even
    let cls, text;
    if (c.margin > eps) { cls = 'pos'; text = 'Positive edge'; } else if (c.margin < -eps) { cls = 'neg'; text = 'Negative edge'; } else { cls = 'flat'; text = 'Break-even'; }
    pill.textContent = text; pill.className = 'ev-pill ev-pill-' + cls;
    note.textContent = `${fmtPct.format(Math.abs(c.margin))} percentage points ${c.margin >= 0 ? 'above' : 'below'} the break-even win rate of ${pct(c.be)}`;
    const evc = c.ev > 0 ? 'ev-pos' : c.ev < 0 ? 'ev-neg' : '';
    stats.innerHTML =
      stat('Risk per trade', usd(c.risk)) + stat('Reward per trade', usd(c.reward)) +
      stat('Risk : reward', `1 : ${num(c.rr)}`) + stat('Costs per trade', `${usd(c.costs)} <span class="ev-sub">(${num(c.costsR)} R)</span>`) +
      stat('Break-even win rate', pct(c.be)) + stat('Pip value (position)', usd(c.pipValue)) +
      stat('EV per trade', `${usd(c.ev)} <span class="ev-sub">(${rr(c.evR)})</span>`, evc) +
      stat('EV per month', `${usd(c.evMonth)} <span class="ev-sub">(${num(v.trades)} trades)</span>`, evc);
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

  sync(); render();
}

if (typeof document !== 'undefined') {
  const run = () => { const r = document.getElementById('ev-app'); if (r) mount(r); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run); else run();
}
