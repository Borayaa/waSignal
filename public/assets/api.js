export class ApiError extends Error {
  constructor(message, status, data) { super(message); this.status = status; this.data = data; }
}
export async function api(path, { method = 'GET', body, noRedirect = false } = {}) {
  const opts = { method, credentials: 'same-origin', headers: {} };
  if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  let res;
  try { res = await fetch(path, opts); } catch (e) { throw new ApiError('Network error', 0); }
  let data = null;
  const txt = await res.text();
  try { data = txt ? JSON.parse(txt) : null; } catch { data = { error: txt.slice(0, 200) }; }
  if (res.status === 401 && !noRedirect) { location.href = '/'; throw new ApiError('Unauthorized', 401, data); }
  if (!res.ok) throw new ApiError((data && data.error) || `HTTP ${res.status}`, res.status, data);
  return data;
}
export const get = (p, o) => api(p, o);
export const post = (p, body, o) => api(p, { method: 'POST', body: body ?? {}, ...o });
export const put = (p, body, o) => api(p, { method: 'PUT', body, ...o });
