// Tiny i18n for the briefing page. Indonesian is the default; English via the EN/ID switch or ?lang=en.
// Page text: elements with data-i18n="key" (textContent) or data-i18n-html="key" (trusted, static markup from the
// dictionaries below), data-i18n-attr="attr:key;attr2:key2" for attributes. Dictionaries live in /i18n/{id,en}.json.
// Scripts: import { t, lang, onLangChange } from '/i18n.js'.

const SUPPORTED = ['id', 'en'];
const KEY = 'ig-briefing-lang';
const dicts = {};
const listeners = new Set();

function initialLang() {
  const q = new URLSearchParams(location.search).get('lang');
  if (SUPPORTED.includes(q)) return q;
  try {
    const saved = localStorage.getItem(KEY);
    if (SUPPORTED.includes(saved)) return saved;
  } catch {}
  return 'id';
}

let current = initialLang();

export const lang = () => current;

/** Translate a key; falls back to the other language, then to the key itself. {name} placeholders are filled from vars. */
export function t(key, vars) {
  const s = dicts[current]?.[key] ?? dicts.en?.[key] ?? dicts.id?.[key] ?? key;
  return vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : s;
}

export function onLangChange(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

async function load(l) {
  if (!dicts[l]) {
    const res = await fetch(`/i18n/${l}.json`);
    dicts[l] = res.ok ? await res.json() : {};
  }
}

function applyDom() {
  document.documentElement.lang = current;
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of document.querySelectorAll('[data-i18n-html]')) el.innerHTML = t(el.dataset.i18nHtml);
  for (const el of document.querySelectorAll('[data-i18n-attr]')) {
    for (const pair of el.dataset.i18nAttr.split(';')) {
      const [attr, key] = pair.split(':').map((s) => s.trim());
      if (attr && key) el.setAttribute(attr, t(key));
    }
  }
  const title = t('meta.title');
  if (title !== 'meta.title') document.title = title;
  for (const b of document.querySelectorAll('[data-lang-btn]')) b.setAttribute('aria-pressed', String(b.dataset.langBtn === current));
}

export async function setLang(l) {
  if (!SUPPORTED.includes(l)) return;
  await Promise.all([load(l), load(l === 'id' ? 'en' : 'id')]);
  current = l;
  try {
    localStorage.setItem(KEY, l);
  } catch {}
  const url = new URL(location.href);
  if (url.searchParams.has('lang')) {
    url.searchParams.set('lang', l);
    history.replaceState(null, '', url);
  }
  applyDom();
  for (const cb of listeners) cb(l);
}

/** Resolves once dictionaries are loaded and the DOM is translated. Scripts await this before first render. */
export const ready = setLang(current).then(() => {
  for (const b of document.querySelectorAll('[data-lang-btn]')) b.addEventListener('click', () => setLang(b.dataset.langBtn));
});
