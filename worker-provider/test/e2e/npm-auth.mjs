import assert from 'node:assert/strict';

export function registryAuthorization(source, registry, env = {}) {
  const url = new URL(registry);
  assert(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash);
  const prefix = `//${url.host}${url.pathname.endsWith('/') ? url.pathname : url.pathname + '/'}:`;
  const fields = new Map();
  for (const line of source.split(/\r?\n/)) {
    const split = line.indexOf('=');
    if (split < 0) continue;
    const name = line.slice(0, split).trim();
    if (!name.startsWith(prefix)) continue;
    let value = line.slice(split + 1).trim();
    if (/^["'].*["']$/.test(value)) value = value.slice(1, -1);
    value = value.replace(/\$\{([^}]+)\}/g, (_, key) => { assert(env[key], 'Missing registry credential environment variable'); return env[key]; });
    fields.set(name.slice(prefix.length), value);
  }
  const token = fields.get('_authToken');
  if (token) { assert(!/[\r\n]/.test(token)); return `Bearer ${token}`; }
  const username = fields.get('username');
  const password = fields.get('_password');
  if (username && password) return `Basic ${Buffer.from(`${username}:${Buffer.from(password, 'base64').toString('utf8')}`).toString('base64')}`;
  const auth = fields.get('_auth');
  if (auth) { assert(/^[A-Za-z0-9+/]+={0,2}$/.test(auth)); return `Basic ${auth}`; }
  return undefined;
}

export function authenticatedRegistryFetch(registry, authorization, fetcher = fetch) {
  const base = new URL(registry);
  const path = base.pathname.endsWith('/') ? base.pathname : base.pathname + '/';
  return (input, options = {}) => {
    const url = new URL(input);
    assert(url.origin === base.origin && url.pathname.startsWith(path) && !url.username && !url.password, 'Registry credentials cannot leave their exact scope');
    const headers = new Headers(options.headers);
    if (authorization) headers.set('authorization', authorization);
    return fetcher(url, { ...options, headers, redirect: 'error' });
  };
}
