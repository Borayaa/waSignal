import { api } from './api.js';
const $ = (s) => document.querySelector(s);
api('/api/me', { noRedirect: true }).then(() => { location.replace('/dashboard'); }).catch(() => {});

const form = $('#form'), err = $('#err'), btn = $('#submit'), pw = $('#password');
const tabIn = $('#tab-signin'), tabUp = $('#tab-signup');
let signup = false, busy = false;

function setMode(up, focusTab = false) {
  signup = up;
  tabIn.setAttribute('aria-selected', String(!up)); tabUp.setAttribute('aria-selected', String(up));
  tabIn.tabIndex = up ? -1 : 0; tabUp.tabIndex = up ? 0 : -1;
  form.setAttribute('aria-labelledby', up ? 'tab-signup' : 'tab-signin');
  document.querySelectorAll('[data-signup]').forEach((el) => { el.hidden = !up; });
  pw.autocomplete = up ? 'new-password' : 'current-password';
  btn.textContent = up ? 'Create account' : 'Sign in';
  err.hidden = true;
  try { history.replaceState(null, '', up ? '#signup' : location.pathname + location.search); } catch {}
  if (focusTab) (up ? tabUp : tabIn).focus();
}
tabIn.onclick = () => setMode(false);
tabUp.onclick = () => setMode(true);
[tabIn, tabUp].forEach((t) => t.addEventListener('keydown', (e) => {
  if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) { e.preventDefault(); setMode(t === tabIn ? e.key !== 'ArrowLeft' && e.key !== 'Home' : e.key === 'End', true); }
}));
setMode(location.hash === '#signup');
window.addEventListener('hashchange', () => setMode(location.hash === '#signup'));

$('#toggle').addEventListener('click', () => {
  const show = pw.type === 'password';
  pw.type = show ? 'text' : 'password';
  $('#confirm').type = pw.type;
  $('#toggle').textContent = show ? 'Hide' : 'Show';
  $('#toggle').setAttribute('aria-pressed', String(show));
});

function strength(p) {
  if (!p) return [0, ''];
  let s = 0;
  if (p.length >= 8) s++; if (p.length >= 12) s++;
  if (/[a-z]/.test(p) && /[A-Z]/.test(p)) s++;
  if (/\d/.test(p) && /[^A-Za-z0-9]/.test(p)) s++; else if (/\d|[^A-Za-z0-9]/.test(p)) s += 0.5;
  s = Math.min(4, Math.floor(s));
  if (p.length < 8) s = Math.min(s, 1);
  return [s, ['Very weak', 'Weak', 'Fair', 'Good', 'Strong'][s]];
}
pw.addEventListener('input', () => {
  const [s, t] = strength(pw.value), bar = $('#strBar');
  bar.style.width = pw.value ? (s + 1) * 20 + '%' : '0';
  bar.className = s >= 3 ? 'hi' : s <= 1 ? 'lo' : '';
  $('#strTxt').textContent = t;
});

const showErr = (m) => { err.textContent = m; err.hidden = false; };

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (busy) return;
  err.hidden = true;
  const username = $('#username').value.trim(), password = pw.value;
  if (signup) {
    if (!/^[A-Za-z0-9_.-]{3,32}$/.test(username)) return showErr('Username must be 3–32 characters: letters, numbers, . _ -');
    if (password.length < 8 || password.length > 128) return showErr('Password must be 8–128 characters.');
    if (password !== $('#confirm').value) return showErr('Passwords do not match.');
    if (!$('#inviteCode').value.trim()) return showErr('Invite code is required. Ask the admin for an invite code.');
  } else if (!username || !password) return showErr('Enter your username and password.');
  busy = true; btn.disabled = true; btn.textContent = signup ? 'Creating account…' : 'Signing in…';
  try {
    const body = signup ? { username, password, inviteCode: $('#inviteCode').value.trim() } : { username, password };
    await api(signup ? '/api/auth/signup' : '/api/auth/login', { method: 'POST', noRedirect: true, body });
    location.href = '/dashboard';
  } catch (ex) {
    showErr(ex.message);
    busy = false; btn.disabled = false; btn.textContent = signup ? 'Create account' : 'Sign in';
  }
});
