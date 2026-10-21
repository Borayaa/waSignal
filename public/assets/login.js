import { api } from './api.js';
const $ = (s) => document.querySelector(s);
api('/api/me', { noRedirect: true }).then(() => { location.replace('/dashboard'); }).catch(() => {});
const key = $('#apiKey'), err = $('#err'), btn = $('#submit');
$('#toggle').addEventListener('click', () => {
  const show = key.type === 'password';
  key.type = show ? 'text' : 'password';
  $('#toggle').textContent = show ? 'Hide' : 'Show';
});
$('#form').addEventListener('submit', async (e) => {
  e.preventDefault();
  err.hidden = true; btn.disabled = true; btn.textContent = 'Signing in…';
  try {
    const label = $('#label').value.trim(), inviteCode = $('#inviteCode').value.trim();
    await api('/api/auth/login', { method: 'POST', noRedirect: true, body: { apiKey: key.value.trim(), ...(label ? { label } : {}), ...(inviteCode ? { inviteCode } : {}) } });
    location.href = '/dashboard';
  } catch (ex) {
    err.textContent = ex.status === 401 ? 'Invalid access key.' : ex.message;
    err.hidden = false; btn.disabled = false; btn.textContent = 'Sign in';
  }
});
