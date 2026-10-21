import { api, get, post, put } from './api.js';
const $ = (s, r = document) => r.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const json = (v) => esc(JSON.stringify(v, null, 2));
const num = (v, d = 2) => (typeof v === 'number' && isFinite(v) ? v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) : (v === null || v === undefined || v === '' ? '—' : esc(v)));
const pick = (o, ...keys) => { for (const k of keys) if (o && o[k] !== undefined && o[k] !== null) return o[k]; return undefined; };
const fmtTime = (t) => { const d = new Date(t); return isNaN(d) ? '—' : d.toLocaleString([], { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }); };

function toast(msg, err = false) {
  const t = document.createElement('div');
  t.className = 'toast' + (err ? ' err' : '');
  t.textContent = msg;
  $('#toasts').append(t);
  setTimeout(() => t.remove(), err ? 6000 : 3000);
}
const fail = (e) => toast(e.message || String(e), true);

// ---------- boot ----------
let me, settings;
try { me = await get('/api/me'); } catch { throw 0; }
$('#acct').textContent = me.username;
$('#logout').onclick = async () => { try { await post('/api/auth/logout'); } catch {} location.href = '/'; };

// ---------- account menu ----------
const menu = $('#acctMenu'), menuBtn = $('#acctBtn');
function setMenu(open) { menu.hidden = !open; menuBtn.setAttribute('aria-expanded', String(open)); if (open) menu.querySelector('button').focus(); }
menuBtn.onclick = () => setMenu(menu.hidden);
document.addEventListener('click', (e) => { if (!menu.hidden && !e.target.closest('.menu')) setMenu(false); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !menu.hidden) { setMenu(false); menuBtn.focus(); } });

// ---------- change password ----------
const dlg = $('#pwDlg'), pwErr = $('#pwErr');
$('#chgPw').onclick = () => { setMenu(false); $('#pwForm').reset(); pwErr.hidden = true; dlg.showModal(); $('#pwCur').focus(); };
$('#pwCancel').onclick = () => dlg.close();
$('#pwForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const currentPassword = $('#pwCur').value, newPassword = $('#pwNew').value;
  const showErr = (m) => { pwErr.textContent = m; pwErr.hidden = false; };
  pwErr.hidden = true;
  if (!currentPassword) return showErr('Enter your current password.');
  if (newPassword.length < 8 || newPassword.length > 128) return showErr('New password must be 8–128 characters.');
  if (newPassword !== $('#pwConf').value) return showErr('New passwords do not match.');
  const btn = $('#pwSave'); btn.disabled = true;
  try {
    await put('/api/auth/password', { currentPassword, newPassword }, { noRedirect: true });
    dlg.close(); toast('Password changed. Other sessions were signed out.');
  } catch (ex) {
    if (ex.status === 401 && ex.message !== 'Current password is incorrect') { location.href = '/'; return; }
    showErr(ex.message);
  } finally { btn.disabled = false; }
});

function setPill(cfg) {
  const p = $('#pill');
  if (cfg.enabled && !cfg.dryRun) { p.className = 'pill live'; p.textContent = 'LIVE'; }
  else if (cfg.enabled) { p.className = 'pill dry'; p.textContent = 'DRY RUN'; }
  else { p.className = 'pill off'; p.textContent = 'OFF'; }
}
async function loadSettings() { settings = await get('/api/settings'); setPill(settings.config); return settings; }

// ---------- tabs ----------
const tabs = { overview: { load: loadOverview, every: 15000 }, signals: { load: loadSignals, every: 5000 }, trades: { load: loadTrades, every: 0 },
  sources: { load: loadSources, every: 3000, init: initWa }, automation: { load: initAuto, every: 0 }, costs: { load: loadCosts, every: 0 }, playground: { load: initPlay, every: 0 } };
let cur = null, timer = null;
function show(name) {
  if (name === 'whatsapp') name = 'sources';
  if (!tabs[name]) name = 'overview';
  cur = name; clearInterval(timer);
  document.querySelectorAll('#nav button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('section.tab').forEach((s) => s.classList.toggle('active', s.id === 'tab-' + name));
  const t = tabs[name];
  if (t.init && !t.done) { t.init(); t.done = true; }
  const run = () => Promise.resolve(t.load()).catch((e) => { if (e.status !== 400) fail(e); });
  run();
  if (t.every) timer = setInterval(() => { if (!document.hidden) run(); }, t.every);
  if (location.hash !== '#' + name) history.replaceState(null, '', '#' + name);
}
$('#nav').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) show(b.dataset.tab); });
document.addEventListener('click', (e) => { const a = e.target.closest('[data-goto]'); if (a) { e.preventDefault(); show(a.dataset.goto); } });

// ---------- overview ----------
const kpi = (l, v, cls = '') => `<div class="kpi ${cls}"><div class="l">${esc(l)}</div><div class="v">${v}</div></div>`;
const equityHist = [];
function spark() {
  const svg = $('#spark');
  if (equityHist.length < 2) { svg.hidden = true; return; }
  svg.hidden = false;
  const min = Math.min(...equityHist), max = Math.max(...equityHist), r = max - min || 1;
  const pts = equityHist.map((v, i) => `${(i / (equityHist.length - 1) * 200).toFixed(1)},${(56 - (v - min) / r * 52).toFixed(1)}`).join(' ');
  svg.setAttribute('viewBox', '0 0 200 60'); svg.setAttribute('preserveAspectRatio', 'none');
  svg.innerHTML = `<polyline points="${pts}" fill="none" stroke="var(--accent)" stroke-width="1.5" vector-effect="non-scaling-stroke"/>`;
}
const relTime = (ms) => {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return s + 's ago'; if (s < 3600) return Math.floor(s / 60) + ' min ago';
  if (s < 86400) return Math.floor(s / 3600) + ' h ago'; return Math.floor(s / 86400) + ' d ago';
};
const toMs = (t) => (typeof t === 'number' && t < 1e12 ? t * 1000 : t);
const posProfit = (p) => (typeof p.profit === 'number' ? p.profit : null);
const plCell = (v) => (typeof v === 'number' ? `<span class="${v > 0 ? 'pos' : v < 0 ? 'neg' : ''}">${num(v)}</span>` : '—');
const liveBadge = (isLive) => `<span class="badge ${isLive ? 'b-partial' : 'b-group'}">${isLive ? 'Live' : 'Demo'}</span>`;
const NOT_CONNECTED = /not connected/i;
function notConnected(on) { $('#brokerBanner').hidden = !on; }
function renderAcct(a, positions) {
  const sum = positions.some((p) => posProfit(p) !== null) ? positions.reduce((s, p) => s + (posProfit(p) ?? 0), 0) : null;
  $('#kpisAcct').innerHTML =
    kpi('Balance', num(a.balance), 'a') + kpi('Equity', num(a.equity), 'a') +
    kpi('Open P/L', sum === null ? '—' : `<span class="${sum > 0 ? 'pos' : sum < 0 ? 'neg' : ''}">${num(sum)}</span>`, sum !== null && sum < 0 ? 'r' : 'g') +
    kpi('Currency', esc(a.currency ?? '—')) + kpi('Leverage', a.leverage ? '1:' + esc(a.leverage) : '—') +
    kpi('Account', `<span class="mono">${esc(a.login ?? '—')}</span> ${liveBadge(a.isLive)}`) + kpi('Broker', esc(a.brokerName ?? '—'));
}
function renderPositions(list) {
  $('#positions').innerHTML = list.length ? list.map((p) => `<tr><td><b>${esc(p.symbol)}</b></td><td><span class="badge b-${p.side === 'BUY' ? 'BUY' : 'SELL'}">${esc(p.side || '—')}</span></td>
      <td class="num">${num(p.volumeLots, 2)}</td><td class="num">${num(p.entryPrice, 5)}</td><td class="num">${num(p.stopLoss, 5)}</td><td class="num">${num(p.takeProfit, 5)}</td>
      <td class="num">${num(p.swap)}</td><td class="num">${num(p.commission)}</td><td class="num">${plCell(posProfit(p))}</td>
      <td class="mono small" style="white-space:nowrap">${esc(fmtTime(p.openTime))}</td>
      <td><button class="btn sm danger" data-close="${esc(p.positionId)}">Close</button></td></tr>`).join('')
    : `<tr><td colspan="11" class="empty">No open positions</td></tr>`;
}
async function loadOverview() {
  if (!settings) await loadSettings().catch(() => {}); else loadSettings().catch(() => {});
  const [acc, pos, stats, wa, tg] = await Promise.allSettled([get('/api/broker/account'), get('/api/broker/positions'), get('/api/stats'), get('/api/wa'), get('/api/tg')]);
  $('#srcHint').hidden = !(wa.status === 'fulfilled' && tg.status === 'fulfilled' && !wa.value?.targetChatId && !tg.value?.targetChatId);
  const rej = [acc, pos].find((r) => r.status === 'rejected');
  const noConn = rej && rej.reason.status === 400 && NOT_CONNECTED.test(rej.reason.message);
  notConnected(!!noConn);
  if (noConn) {
    $('#kpisAcct').innerHTML = '';
    $('#positions').innerHTML = `<tr><td colspan="11" class="empty">cTrader account not connected</td></tr>`;
  } else if (rej) {
    const m = esc(rej.reason.message);
    $('#kpisAcct').innerHTML = `<div class="banner" style="grid-column:1/-1;margin:0">Account info unavailable: ${m}</div>`;
    $('#positions').innerHTML = `<tr><td colspan="11" class="empty">${m}</td></tr>`;
  } else {
    const a = acc.value || {}, list = pos.value?.positions || [];
    if (typeof a.equity === 'number') { equityHist.push(a.equity); if (equityHist.length > 60) equityHist.shift(); }
    renderAcct(a, list); renderPositions(list);
  }
  if (stats.status === 'fulfilled') {
    const t = stats.value.today || {};
    $('#kpisStats').innerHTML = kpi('Received', num(t.received, 0), 'a') + kpi('Executed', num(t.executed, 0), 'g') + kpi('Rejected', num(t.rejected, 0), 'w') +
      kpi('Failed', num(t.failed, 0), 'r') + kpi('Dry run', num(t.dryRun, 0)) + kpi('Ignored', num(t.ignored, 0));
  }
  spark();
}
$('#positions').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-close]'); if (!b) return;
  const id = b.dataset.close;
  if (!confirm(`Close position ${id}?`)) return;
  b.disabled = true;
  try { await post('/api/broker/close', { positionId: Number(id) }); toast('Position closed'); loadOverview().catch(fail); }
  catch (ex) { fail(ex); b.disabled = false; }
});

// ---------- signals ----------
function confBars(ex) {
  const rows = Object.entries(ex?.fields || {});
  if (ex && typeof ex.confidence === 'number') rows.unshift(['overall', { value: null, confidence: ex.confidence }]);
  return rows.map(([k, f]) => confRow(k, f?.confidence, f?.value)).join('');
}
function confRow(k, c, v) {
  const pct = typeof c === 'number' ? Math.round(c * 100) : null;
  const cls = pct === null ? '' : pct >= 80 ? 'hi' : pct < 50 ? 'lo' : '';
  return `<div class="conf"><span title="${esc(JSON.stringify(v))}">${esc(k)}${v !== null && v !== undefined ? ` <span class="muted mono">${esc(JSON.stringify(v)).slice(0, 24)}</span>` : ''}</span><div class="bar"><i class="${cls}" style="width:${pct ?? 0}%"></i></div><span class="mono">${pct === null ? '—' : pct + '%'}</span></div>`;
}
const openSet = new Set();
let lastSignals = [];
async function loadSignals() { lastSignals = (await get('/api/signals?limit=50')).signals || []; renderSignals(); }
$('#srcFilter').onchange = renderSignals;
function renderSignals() {
  const f = $('#srcFilter').value, box = $('#signals');
  const signals = lastSignals.filter((s) => !f || (s.source || 'whatsapp') === f);
  if (!signals.length) { box.innerHTML = `<div class="empty card">${lastSignals.length ? 'No signals from this source.' : 'No signals yet. Pick a target chat in Sources.'}</div>`; return; }
  box.innerHTML = signals.map((s) => {
    const src = s.source === 'telegram' ? 'telegram' : 'whatsapp';
    const sig = s.signal;
    const summary = sig ? `<div class="mono small" style="margin-top:6px"><span class="badge b-${esc(sig.side)}">${esc(sig.side)}</span> <b>${esc(sig.symbol)}</b> · entry ${num(sig.entry, 5)} · SL ${num(sig.stopLoss, 5)} · TP ${esc((sig.takeProfits || []).join(', ') || '—')}</div>` : '';
    return `<article class="sig s-${esc(s.status)}"><div class="meta"><span class="badge b-${esc(s.status)}">${esc(s.status === 'received' ? 'Queued' : String(s.status).replace('_', ' '))}</span>
      <span class="badge b-${src}">${src === 'telegram' ? 'Telegram' : 'WhatsApp'}</span><span>${esc(s.sender || 'unknown')}</span><span class="mono">${esc(fmtTime(s.receivedAt))}</span></div>
      <div class="txt">${esc(s.text)}</div>${summary}${s.reason ? `<div class="reason">${esc(s.reason)}</div>` : ''}
      ${s.signal || s.extraction ? `<details data-id="${esc(s.id)}" ${openSet.has(String(s.id)) ? 'open' : ''}><summary>Structured data</summary>
        ${s.extraction ? `<div style="margin-top:8px">${confBars(s.extraction)}</div><pre>${json(s.extraction)}</pre>` : ''}
        ${s.signal ? `<pre>${json(s.signal)}</pre>` : ''}</details>` : ''}</article>`;
  }).join('');
}
$('#signals').addEventListener('toggle', (e) => { const d = e.target; if (d.dataset?.id) d.open ? openSet.add(d.dataset.id) : openSet.delete(d.dataset.id); }, true);

// ---------- trades ----------
async function loadTrades() {
  const { trades } = await get('/api/trades?limit=50');
  $('#trades').innerHTML = trades.length ? trades.map((t) => `<tr><td class="mono" style="white-space:nowrap">${esc(fmtTime(t.createdAt))}</td><td>${esc(t.action)}</td>
    <td><span class="badge b-${t.ok ? 'ok' : 'fail'}">${t.ok ? 'OK' : 'FAIL'}</span></td><td class="num">${esc(t.ticket ?? '—')}</td>
    <td><details style="margin:0"><summary>request / response</summary><pre>${json(t.request)}</pre><pre>${json(t.response)}</pre></details></td></tr>`).join('')
    : '<tr><td colspan="5" class="empty">No trades yet</td></tr>';
}

// ---------- sources (whatsapp + telegram) ----------
let waData = null, chatFilter = '';
function initWa() {
  $('#wa').innerHTML = `<div class="card src"><h3><span class="badge b-whatsapp">WhatsApp</span></h3><div id="waCard"></div><hr><h3>Target chat</h3><div id="waTarget"></div>
    <input type="text" id="chatSearch" placeholder="Search chats…" aria-label="Search WhatsApp chats"><div class="chatlist" id="chatList"></div></div>
    <div class="card src"><h3><span class="badge b-telegram">Telegram</span></h3><div id="tgCard"></div><div id="tgPick" hidden><hr><h3>Target chat</h3><div id="tgTarget"></div>
    <input type="text" id="tgSearch" placeholder="Search channels, groups, users…" aria-label="Search Telegram chats"><div class="chatlist" id="tgList"></div></div>
    <p class="hint">Uses your own Telegram account (like Telegram Desktop) so it can read channels you've joined. The session stays on your bridge.</p></div>`;
  initTg();
  $('#chatSearch').oninput = (e) => { chatFilter = e.target.value.toLowerCase(); renderChats(); };
  $('#waCard').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-wa]'); if (!b) return;
    const a = b.dataset.wa;
    if (a === 'logout' && !confirm('Log out of WhatsApp? You will need to scan the QR again.')) return;
    try { await post('/api/wa/' + a); toast('Requested: ' + a); loadWa(); } catch (ex) { fail(ex); }
  });
  $('#chatList').addEventListener('click', async (e) => {
    const c = e.target.closest('[data-chat]'); if (!c) return;
    try { await put('/api/wa/target', { chatId: c.dataset.chat || null }); toast('Target chat updated'); loadWa(); } catch (ex) { fail(ex); }
  });
}
async function loadWa() { waData = await get('/api/wa'); renderWa(); renderChats(); }
function loadSources() {
  return Promise.allSettled([loadWa(), loadTg()]).then((r) => { const e = r.find((x) => x.status === 'rejected'); if (e && e.reason.status !== 400) throw e.reason; });
}
function renderWa() {
  const w = waData;
  $('#waCard').innerHTML = `<p><span class="status-dot ${w.bridgeOnline ? 'on' : 'off'}"></span>Bridge ${w.bridgeOnline ? 'online' : '<b class="neg">offline</b>'}</p>
    <p>Status: <span class="badge b-${w.status === 'connected' ? 'ok' : w.status === 'qr' ? 'partial' : 'ignored'}">${esc(w.status)}</span> <span class="muted small">desired: ${esc(w.desired)}</span></p>
    ${w.status === 'connected' && w.phone ? `<p>Phone: <span class="mono">${esc(w.phone)}</span></p>` : ''}
    ${w.status === 'qr' && w.qr ? `<p><img class="qr" alt="WhatsApp QR code" src="${/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(w.qr) ? esc(w.qr) : ''}"></p><p class="muted small">Scan with WhatsApp → Linked devices</p>` : ''}
    <div class="btns"><button class="btn primary" data-wa="connect">Connect</button><button class="btn" data-wa="disconnect">Disconnect</button><button class="btn danger" data-wa="logout">Logout</button></div>`;
}
function renderChats() {
  const w = waData; if (!w) return;
  $('#waTarget').innerHTML = w.targetChatId ? `<div class="target">Current target: <b>${esc(w.targetChatName || w.targetChatId)}</b><br><span class="mono small muted">${esc(w.targetChatId)}</span>
    <div style="margin-top:6px"><button class="btn sm" data-chat="">Clear target</button></div></div>` : `<div class="banner">No target chat selected — incoming messages are ignored.</div>`;
  const list = (w.chats || []).filter((c) => !chatFilter || (c.name || '').toLowerCase().includes(chatFilter) || c.id.toLowerCase().includes(chatFilter));
  $('#chatList').innerHTML = list.length ? list.map((c) => `<div class="chat ${c.id === w.targetChatId ? 'sel' : ''}" data-chat="${esc(c.id)}"><span class="n">${esc(c.name || c.id)}</span>${c.isGroup ? '<span class="badge b-group">group</span>' : ''}</div>`).join('')
    : '<div class="empty">No chats</div>';
}

// ---------- telegram ----------
let tgData = null, tgFilter = '';
const DATA_IMG = /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/;
const TG_BADGE = { connected: 'ok', qr: 'partial', password: 'partial', connecting: 'received', unavailable: 'failed' };
const KIND = { channel: 'Channel', group: 'Group', user: 'User' };
function initTg() {
  $('#tgSearch').oninput = (e) => { tgFilter = e.target.value.toLowerCase(); renderTgChats(); };
  $('#tgCard').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-tg]'); if (!b) return;
    const a = b.dataset.tg;
    if (a === 'logout' && !confirm('Log out of Telegram? You will need to scan the QR again.')) return;
    try { await post('/api/tg/' + a); toast('Requested: ' + a); loadTg().catch(fail); } catch (ex) { fail(ex); }
  });
  $('#tgCard').addEventListener('submit', async (e) => {
    e.preventDefault();
    const inp = $('#tgPw'), btn = $('#tgPwBtn'); if (!inp || !inp.value) return;
    const password = inp.value; inp.value = ''; btn.disabled = true;
    try { await post('/api/tg/password', { password }); toast('Password sent'); loadTg().catch(fail); } catch (ex) { fail(ex); }
    finally { btn.disabled = false; }
  });
  $('#tgPick').addEventListener('click', async (e) => {
    const c = e.target.closest('[data-chat]'); if (!c) return;
    try { await put('/api/tg/target', { chatId: c.dataset.chat || null }); toast('Target chat updated'); loadTg().catch(fail); } catch (ex) { fail(ex); }
  });
}
async function loadTg() { tgData = await get('/api/tg'); renderTg(); renderTgChats(); }
function renderTg() {
  const t = tgData, box = $('#tgCard'), st = t.status;
  // keep the password field intact while the user is typing during polls
  if (st === 'password' && $('#tgPw')) {
    const er = $('#tgPwErr'); er.hidden = !t.error; er.textContent = t.error || '';
    return;
  }
  let body = '';
  if (st === 'unavailable') body = `<div class="banner">The bridge needs <code>TELEGRAM_API_ID</code> and <code>TELEGRAM_API_HASH</code> (get them at <b>my.telegram.org</b> → API development tools) to use Telegram.${t.error ? `<br><span class="small">${esc(t.error)}</span>` : ''}</div>`;
  else if (st === 'disconnected' || st === 'logged_out') body = `${st === 'logged_out' ? '<p class="muted small">Logged out. Connect to link again.</p>' : ''}${t.error ? `<div class="inline-err">${esc(t.error)}</div>` : ''}<div class="btns"><button class="btn primary" data-tg="connect">Connect</button></div>`;
  else if (st === 'connecting') body = `<p><span class="spin"></span>Connecting…</p>`;
  else if (st === 'qr') body = `${t.qr && DATA_IMG.test(t.qr) ? `<p><img class="qr" alt="Telegram QR code" src="${esc(t.qr)}"></p>` : '<p><span class="spin"></span>Waiting for QR code…</p>'}
    <ol class="small muted" style="padding-left:18px;margin:6px 0"><li>Open Telegram on your phone</li><li>Settings → Devices → Link Desktop Device</li><li>Scan this code</li></ol>
    <div class="btns"><button class="btn" data-tg="disconnect">Cancel</button></div>`;
  else if (st === 'password') body = `<form id="tgPwForm" novalidate><h3>Two-step verification</h3><p class="muted small">Enter your Telegram cloud password.</p>
    <div id="tgPwErr" class="inline-err" role="alert" ${t.error ? '' : 'hidden'}>${esc(t.error || '')}</div>
    <label class="field"><span>Password</span><input id="tgPw" type="password" autocomplete="off" maxlength="256" required></label>
    <div class="btns"><button type="submit" id="tgPwBtn" class="btn primary">Submit</button><button type="button" class="btn" data-tg="disconnect">Cancel</button></div></form>`;
  else if (st === 'connected') body = `<p>Account: <b>${esc(t.user || 'unknown')}</b></p>${t.error ? `<div class="inline-err">${esc(t.error)}</div>` : ''}
    <div class="btns"><button class="btn" data-tg="disconnect">Disconnect</button><button class="btn danger" data-tg="logout">Logout</button></div>`;
  else body = `<p class="muted">Unknown status.</p>`;
  box.innerHTML = `<p><span class="status-dot ${t.bridgeOnline ? 'on' : 'off'}"></span>Bridge ${t.bridgeOnline ? 'online' : '<b class="neg">offline</b>'}</p>
    <p>Status: <span class="badge b-${TG_BADGE[st] || 'ignored'}">${esc(st)}</span> <span class="muted small">desired: ${esc(t.desired)}</span></p>${body}`;
  if (st === 'password') $('#tgPw').focus();
}
function renderTgChats() {
  const t = tgData; if (!t) return;
  $('#tgPick').hidden = t.status !== 'connected';
  if (t.status !== 'connected') return;
  $('#tgTarget').innerHTML = t.targetChatId ? `<div class="target">Current target: <b>${esc(t.targetChatName || t.targetChatId)}</b><br><span class="mono small muted">${esc(t.targetChatId)}</span>
    <div style="margin-top:6px"><button class="btn sm" data-chat="">Clear target</button></div></div>` : `<div class="banner">No target chat selected — Telegram messages are ignored.</div>`;
  const list = (t.chats || []).filter((c) => !tgFilter || (c.name || '').toLowerCase().includes(tgFilter) || String(c.id).toLowerCase().includes(tgFilter));
  $('#tgList').innerHTML = list.length ? list.map((c) => `<div class="chat ${c.id === t.targetChatId ? 'sel' : ''}" data-chat="${esc(c.id)}"><span class="n">${esc(c.name || c.id)}</span><span class="badge b-${esc(c.kind)}">${esc(KIND[c.kind] || c.kind)}</span></div>`).join('')
    : '<div class="empty">No chats</div>';
}

// ---------- automation ----------
const swRow = (id, label, checked, hint = '') => `<label class="sw"><input type="checkbox" id="${id}" ${checked ? 'checked' : ''}><span>${label}${hint ? `<div class="hint">${hint}</div>` : ''}</span></label>`;
const TP_HELP = { first: 'Single position targeting TP1 (closest take profit).', last: 'Single position targeting the final TP.', split: 'One position per TP; lot divided evenly (min 0.01 each).' };
let mapRows = [], allowed = [];
async function initAuto() {
  await loadSettings();
  const c = settings.config;
  mapRows = Object.entries(c.symbolMap || {}); allowed = [...(c.allowedSymbols || [])];
  $('#auto').innerHTML = `<form class="card" id="cfgForm"><h3 style="margin-bottom:12px">Automation config</h3>
    ${swRow('f_enabled', 'Enabled', c.enabled, 'Master switch: execute trades from incoming signals')}
    ${swRow('f_dryRun', 'Dry run', c.dryRun, 'Build the JSON but never send orders')}
    <div class="formgrid">
    <label class="field"><span>Lot mode</span><select id="f_lotMode"><option value="fixed">fixed</option><option value="signal">signal (from message)</option></select></label>
    <label class="field"><span>Fixed lot</span><input type="number" id="f_fixedLot" step="0.01" min="0.01" value="${esc(c.fixedLot)}"></label>
    <label class="field"><span>Max lot</span><input type="number" id="f_maxLot" step="0.01" min="0.01" value="${esc(c.maxLot)}"></label>
    <label class="field"><span>Max open positions</span><input type="number" id="f_maxOpen" step="1" min="0" value="${esc(c.maxOpenPositions)}"><div class="hint">0 = unlimited</div></label>
    </div>
    <label class="field"><span>TP strategy</span><select id="f_tp"><option>first</option><option>last</option><option>split</option></select><div class="hint" id="tpHelp"></div></label>
    <label class="field"><span>Min confidence: <b id="confV" class="mono"></b></span><input type="range" id="f_conf" min="0" max="1" step="0.05" value="${esc(c.minConfidence)}"></label>
    ${swRow('f_reqSl', 'Require stop loss', c.requireStopLoss)}
    <div class="formgrid"><label class="field"><span>Symbol suffix</span><input type="text" id="f_suffix" value="${esc(c.symbolSuffix)}" placeholder="(empty for IC Markets)"></label>
    <label class="field"><span>Comment prefix</span><input type="text" id="f_prefix" value="${esc(c.commentPrefix)}"></label></div>
    <div class="field"><span>Symbol map (alias → broker symbol)</span><div class="hint">IC Markets gold is <span class="mono">XAUUSD</span>, so map <span class="mono">GOLD</span> → <span class="mono">XAUUSD</span>. The suffix is normally empty.</div><div id="mapRows"></div><button type="button" class="btn sm" id="addMap">+ Add mapping</button></div>
    <div class="field"><span>Allowed symbols (empty = all)</span><input type="text" id="f_allowed" placeholder="Type symbol, press Enter or comma"><div class="chips" id="chips"></div></div>
    <button class="btn primary" type="submit">Save config</button></form>
    <div class="grid" style="align-content:start"><div class="card" id="ctCard"></div></div>`;
  $('#f_lotMode').value = c.lotMode; $('#f_tp').value = c.tpStrategy;
  const upd = () => { $('#confV').textContent = Number($('#f_conf').value).toFixed(2); $('#tpHelp').textContent = TP_HELP[$('#f_tp').value]; };
  $('#f_conf').oninput = upd; $('#f_tp').onchange = upd; upd();
  renderMap(); renderChips();
  $('#addMap').onclick = () => { syncMap(); mapRows.push(['', '']); renderMap(); };
  $('#mapRows').addEventListener('click', (e) => { const b = e.target.closest('[data-rm]'); if (b) { syncMap(); mapRows.splice(+b.dataset.rm, 1); renderMap(); } });
  const addChip = () => { const inp = $('#f_allowed'); inp.value.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean).forEach((s) => { if (!allowed.includes(s)) allowed.push(s); }); inp.value = ''; renderChips(); };
  $('#f_allowed').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addChip(); } });
  $('#f_allowed').addEventListener('blur', addChip);
  $('#chips').addEventListener('click', (e) => { const b = e.target.closest('[data-rc]'); if (b) { allowed.splice(+b.dataset.rc, 1); renderChips(); } });
  $('#cfgForm').onsubmit = saveCfg;
  initCtrader(); renderCtrader(); loadCtrader().catch(fail);
}
function renderMap() {
  $('#mapRows').innerHTML = mapRows.map(([k, v], i) => `<div class="maprow"><input type="text" data-mk value="${esc(k)}" placeholder="ALIAS" aria-label="Alias"><input type="text" data-mv value="${esc(v)}" placeholder="BROKER" aria-label="Broker symbol"><button type="button" class="btn sm" data-rm="${i}" aria-label="Remove">✕</button></div>`).join('');
}
function syncMap() { mapRows = [...document.querySelectorAll('#mapRows .maprow')].map((r) => [r.querySelector('[data-mk]').value, r.querySelector('[data-mv]').value]); }
function renderChips() { $('#chips').innerHTML = allowed.map((s, i) => `<span class="chip">${esc(s)}<button type="button" data-rc="${i}" aria-label="Remove ${esc(s)}">×</button></span>`).join(''); }
async function saveCfg(e) {
  e.preventDefault(); syncMap();
  const symbolMap = {}; mapRows.forEach(([k, v]) => { if (k.trim() && v.trim()) symbolMap[k.trim().toUpperCase()] = v.trim(); });
  const config = { enabled: $('#f_enabled').checked, dryRun: $('#f_dryRun').checked, lotMode: $('#f_lotMode').value, fixedLot: parseFloat($('#f_fixedLot').value),
    maxLot: parseFloat($('#f_maxLot').value), tpStrategy: $('#f_tp').value, minConfidence: parseFloat($('#f_conf').value), requireStopLoss: $('#f_reqSl').checked,
    symbolSuffix: $('#f_suffix').value.trim(), symbolMap, allowedSymbols: allowed, maxOpenPositions: parseInt($('#f_maxOpen').value, 10) || 0, commentPrefix: $('#f_prefix').value.trim() };
  if (config.enabled && !config.dryRun && !confirm('LIVE trading will be enabled: signals will place REAL orders. Continue?')) return;
  try { settings = await put('/api/settings', { config }); setPill(settings.config); toast('Config saved'); } catch (ex) { fail(ex); }
}
// ---------- cTrader connection ----------
let ctStatus = null;
function fmtDate(ms) { const d = new Date(ms); return typeof ms === 'number' && !isNaN(d) ? d.toLocaleString([], { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'; }
function renderCtrader() {
  const s = ctStatus, el = $('#ctCard'); if (!el) return;
  const head = `<h3 style="margin-bottom:4px">cTrader connection (IC Markets)</h3>`;
  if (!s) { el.innerHTML = head + '<p class="muted">Loading…</p>'; return; }
  if (!s.configured) {
    el.innerHTML = head + `<div class="banner" style="margin-top:8px">cTrader is not configured on this server. The administrator must set the <span class="mono">CTRADER_CLIENT_ID</span> and <span class="mono">CTRADER_CLIENT_SECRET</span> secrets (create an Open API application at <span class="mono">openapi.ctrader.com</span>).</div>`;
    return;
  }
  if (!s.linked) {
    el.innerHTML = head + `<p class="hint" style="margin:0 0 12px">You will log in with your cTrader ID / IC Markets account and grant trading access. We never see your password.</p>
      <button type="button" class="btn primary" id="ctConnect" style="padding:12px 20px;font-size:15px">Connect with cTrader</button>`;
    return;
  }
  const sel = s.selected?.ctidTraderAccountId;
  const accs = s.accounts || [];
  el.innerHTML = head + `<p class="small">Linked. Token expires: <b class="mono">${esc(fmtDate(s.tokenExpiresAt))}</b></p>
    <div class="field"><span>Trading account</span><div id="ctAccts" role="radiogroup" aria-label="Trading account">${accs.length ? accs.map((a) => `<label class="sw"><input type="radio" name="ctAcct" value="${esc(a.ctidTraderAccountId)}" ${a.ctidTraderAccountId === sel ? 'checked' : ''}>
      <span><span class="mono">${esc(a.traderLogin)}</span> · ${esc(a.brokerTitleShort || 'IC Markets')} ${liveBadge(a.isLive)}</span></label>`).join('') : '<div class="empty">No trading accounts found. Try “Refresh accounts”.</div>'}</div></div>
    ${!s.selected && accs.length ? '<div class="banner">Select a trading account to enable trading.</div>' : ''}
    <div class="btns"><button type="button" class="btn" id="ctRefresh">Refresh accounts</button><button type="button" class="btn primary" id="ctTest">Test connection</button><button type="button" class="btn danger" id="ctDisc">Disconnect</button></div>
    <pre id="ctResult" hidden></pre>`;
}
async function loadCtrader() { ctStatus = await get('/api/ctrader'); renderCtrader(); }
function initCtrader() {
  const el = $('#ctCard');
  el.addEventListener('click', async (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.id === 'ctConnect') { location.href = '/api/ctrader/connect'; return; }
    b.disabled = true;
    try {
      if (b.id === 'ctRefresh') { ctStatus = await post('/api/ctrader/refresh-accounts'); renderCtrader(); toast('Accounts refreshed'); }
      else if (b.id === 'ctDisc') {
        if (!confirm('Disconnect your cTrader account? Automated trading will stop until you reconnect.')) { b.disabled = false; return; }
        ctStatus = await api('/api/ctrader', { method: 'DELETE' }); renderCtrader(); toast('Disconnected');
      } else if (b.id === 'ctTest') {
        const out = $('#ctResult'); b.textContent = 'Testing…';
        try {
          const r = await post('/api/broker/test'); out.hidden = false;
          const a = r.account;
          out.textContent = r.ok && a ? `Connected\nLogin: ${a.login}\nBalance: ${a.balance} ${a.currency || ''}\nLatency: ${r.latencyMs} ms` : (r.error || 'Connection failed');
          r.ok ? toast('Connection OK') : toast(r.error || 'Connection failed', true);
        } catch (ex) { out.hidden = false; out.textContent = ex.message; fail(ex); }
        b.textContent = 'Test connection';
      }
    } catch (ex) { fail(ex); }
    b.disabled = false;
  });
  el.addEventListener('change', async (e) => {
    const r = e.target.closest('input[name=ctAcct]'); if (!r) return;
    try { ctStatus = await put('/api/ctrader/account', { ctidTraderAccountId: Number(r.value) }); renderCtrader(); toast('Trading account selected'); } catch (ex) { fail(ex); loadCtrader().catch(() => {}); }
  });
}

// ---------- costs ----------
const money = (v) => { if (typeof v !== 'number' || !isFinite(v)) return '—'; const a = Math.abs(v); return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: a === 0 ? 2 : a < 0.01 ? 6 : a < 1 ? 4 : 2 }); };
const curMonth = () => new Date().toISOString().slice(0, 7);
async function loadCosts() {
  const inp = $('#costMonth');
  if (!inp.value) { inp.value = curMonth(); inp.onchange = () => loadCosts().catch(fail); }
  const month = inp.value || curMonth();
  const c = await get('/api/costs?month=' + encodeURIComponent(month));
  const plan = c.plan || {}, t = c.totals || {}, n = c.counts || {};
  const isCur = c.month === curMonth();
  const kpis = kpi('Month-to-date total', money(t.total), 'a') + kpi(isCur ? 'Projected month-end' : 'Month total', money(isCur ? t.projectedMonthEnd : t.total), 'g') +
    kpi('Signals', num(n.signals, 0)) + kpi('Trades', num(n.trades, 0));
  const lines = c.lines || [];
  const free = (l) => l.cost === 0 && /ctrader/i.test(l.item);
  const lineRows = lines.length ? lines.map((l) => `<tr><td>${esc(l.item)}${free(l) ? ' <span class="badge b-ok">free</span>' : ''}</td><td class="num">${num(l.usage, 0)} ${esc(l.unit)}</td>
    <td class="num">${num(l.included, 0)} ${esc(l.unit)}</td><td class="num">${money(l.unitPrice)}</td><td class="num">${money(l.cost)}</td><td class="small muted">${esc(l.note || '')}</td></tr>`).join('')
    : '<tr><td colspan="6" class="empty">No usage data</td></tr>';
  const days = c.daily || [], maxV = Math.max(1, ...days.map((d) => Math.max(d.signals, d.trades)));
  const W = 600, H = 140, gw = W / Math.max(days.length, 1), bw = Math.max(gw / 2 - 1, 1);
  const bars = days.map((d, i) => {
    const hs = d.signals / maxV * (H - 22), ht = d.trades / maxV * (H - 22), x = i * gw + 1;
    return `<rect class="b" x="${x.toFixed(1)}" y="${(H - 16 - hs).toFixed(1)}" width="${bw.toFixed(1)}" height="${hs.toFixed(1)}" rx="1"><title>${esc(d.date)}: ${esc(d.signals)} signals</title></rect>`
      + `<rect class="b2" x="${(x + bw).toFixed(1)}" y="${(H - 16 - ht).toFixed(1)}" width="${bw.toFixed(1)}" height="${ht.toFixed(1)}" rx="1"><title>${esc(d.date)}: ${esc(d.trades)} trades</title></rect>`
      + (i % 5 === 0 ? `<text x="${x.toFixed(1)}" y="${H - 3}">${esc(String(d.date).slice(8))}</text>` : '');
  }).join('');
  const notes = c.notes || [];
  $('#costs').innerHTML = `<div class="costsec"><span class="badge ${plan.name === 'Workers Paid' ? 'b-partial' : 'b-ok'}">${esc(plan.name || 'Workers')}</span>
      <span class="mono small"> ${money(plan.monthly)}/mo base</span></div>
    <div class="grid kpis" style="margin-top:12px">${kpis}</div>
    <div class="banner" style="margin-top:16px">The <b>cTrader Open API is free</b>, and there are <b>no container costs</b> any more: trades go straight from the Worker. All figures are estimates; the Cloudflare dashboard bill is authoritative.</div>
    <div class="costsec"><h3>Usage &amp; cost breakdown</h3><div class="tbl-wrap"><table><thead><tr><th>Item</th><th class="num">Usage</th><th class="num">Included</th><th class="num">Unit price</th><th class="num">Cost</th><th>Note</th></tr></thead>
      <tbody>${lineRows}</tbody></table></div></div>
    <div class="costsec"><h3>Daily signals &amp; trades <span class="muted small">(<span class="lg lg1"></span>signals <span class="lg lg2"></span>trades)</span></h3><div class="card"><svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Daily signals and trades, peak ${esc(maxV)}">${bars}</svg></div></div>
    ${notes.length ? `<div class="costsec"><h3>Notes</h3><ul class="small">${notes.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}`;
}

// ---------- playground ----------
function initPlay() {
  if ($('#pText')) return;
  $('#play').innerHTML = `<div class="card"><h3 style="margin-bottom:8px">Sample message</h3><textarea id="pText" rows="8" spellcheck="false">XAUUSD BUY NOW @ 2345\nSL 2338\nTP1 2350\nTP2 2360</textarea>
    <div class="btns" style="margin-top:10px"><button class="btn primary" id="pRun">Extract</button><button class="btn danger" id="pExec">Execute for real</button></div>
    <p class="hint">Extract is a dry analysis. “Execute for real” places the trade ignoring dry-run/enabled settings.</p></div><div class="card" id="pOut"><span class="muted">Results appear here.</span></div>`;
  const run = async (execute) => {
    const text = $('#pText').value; if (!text.trim()) return;
    if (execute && !confirm('Place this trade for REAL on your cTrader account?')) return;
    const btns = [$('#pRun'), $('#pExec')]; btns.forEach((b) => (b.disabled = true));
    try { renderPlay(await post('/api/extract', execute ? { text, execute: true } : { text })); if (execute) toast('Execute request sent'); }
    catch (ex) { fail(ex); } finally { btns.forEach((b) => (b.disabled = false)); }
  };
  $('#pRun').onclick = () => run(false); $('#pExec').onclick = () => run(true);
}
function renderPlay(r) {
  const ex = r.extraction || {};
  const head = `<p><span class="badge ${ex.isSignal ? 'b-ok' : 'b-ignored'}">${ex.isSignal ? 'signal' : 'not a signal'}</span> ${ex.side ? `<span class="badge b-${esc(ex.side)}">${esc(ex.side)}</span>` : ''} <b class="mono">${esc(ex.rawSymbol || '')}</b> <span class="muted small">${esc(ex.orderKind || '')}</span></p>`;
  const bars = confRow('overall', ex.confidence) + Object.entries(ex.fields || {}).map(([k, f]) => confRow(k, f?.confidence, f?.value)).join('');
  $('#pOut').innerHTML = head + `<h3>Confidence</h3><div style="margin:6px 0 12px">${bars}</div>` +
    ((r.errors || []).length ? `<div class="inline-err">${r.errors.map(esc).join('<br>')}</div>` : '') +
    `<h3>Trade signal</h3><pre>${r.signal ? json(r.signal) : 'null'}</pre><h3 style="margin-top:10px">Extraction</h3><pre>${json(ex)}</pre>` +
    (r.results ? `<h3 style="margin-top:10px">Execution results</h3><pre>${json(r.results)}</pre>` : '');
}

// cTrader OAuth return: /dashboard#automation?ctrader_error=<msg>
{
  const h = location.hash.slice(1), qi = h.indexOf('?');
  const name = qi >= 0 ? h.slice(0, qi) : h, qs = qi >= 0 ? new URLSearchParams(h.slice(qi + 1)) : null;
  const err = qs?.get('ctrader_error');
  show(name || 'overview');
  if (err) toast('cTrader: ' + err, true);
  else if (name === 'automation' && qs?.has('ctrader')) toast('cTrader account connected');
}
