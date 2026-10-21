const ITERATIONS = 100_000;
const enc = new TextEncoder();

function b64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function unb64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

async function derive(pw: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

export async function hashPassword(pw: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(pw, salt, ITERATIONS);
  return `pbkdf2-sha256$${ITERATIONS}$${b64(salt)}$${b64(hash)}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  try {
    const [alg, iter, salt, hash] = stored.split('$');
    const n = Number(iter);
    if (alg !== 'pbkdf2-sha256' || !Number.isInteger(n) || n < 1 || n > ITERATIONS || !salt || !hash) return false;
    const expected = unb64(hash);
    const actual = await derive(pw, unb64(salt), n);
    if (expected.length !== actual.length) return false;
    let d = 0;
    for (let i = 0; i < actual.length; i++) d |= actual[i] ^ expected[i];
    return d === 0;
  } catch {
    return false;
  }
}

/** Hash of a random password, used so unknown usernames cost the same as known ones. */
let dummy: Promise<string> | null = null;
export function dummyHash(): Promise<string> {
  return (dummy ??= hashPassword('dummy-password-for-unknown-users'));
}

export function validateUsername(u: unknown): string | null {
  if (typeof u !== 'string' || u.length < 3 || u.length > 32) return 'Username must be 3-32 characters';
  if (!/^[A-Za-z0-9_.-]+$/.test(u)) return 'Username may only contain letters, numbers, dots, dashes and underscores';
  return null;
}

export function validatePassword(p: unknown): string | null {
  if (typeof p !== 'string' || p.length < 8) return 'Password must be at least 8 characters';
  if (p.length > 128) return 'Password must be at most 128 characters';
  return null;
}
