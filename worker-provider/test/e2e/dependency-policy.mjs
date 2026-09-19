import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { npmPolicyArgs } from '../../assets/bootstrap.mjs';

export async function verifyLockedDependencyAges(lock, policy, fetcher = fetch, now = Date.now()) {
  npmPolicyArgs(policy);
  const registry = new URL(policy.registry);
  const packages = Object.entries(lock.packages ?? {}).filter(([path]) => path);
  assert(packages.length > 0 && packages.length <= 5000, 'Missing or excessive lockfile packages');
  const checks = [];
  const metadata = new Map();
  const load = name => {
    if (!metadata.has(name)) metadata.set(name, (async () => {
      const url = new URL(encodeURIComponent(name), registry.href.endsWith('/') ? registry.href : registry.href + '/');
      let response, raw;
      try {
        response = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(30_000), headers: { accept: 'application/json' } });
        raw = await response.text();
      } catch { throw new Error(`Publication metadata request failed for ${name}`); }
      assert.equal(response.status, 200, `Cannot verify publication metadata for ${name}`);
      return { source: url.href, raw, value: JSON.parse(raw), sha256: createHash('sha256').update(raw).digest('hex') };
    })());
    return metadata.get(name);
  };
  let cursor = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (cursor < packages.length) {
      const [path, entry] = packages[cursor++];
      const name = entry.name ?? path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
      assert(/^(@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/i.test(name), 'Non-registry dependency name');
      assert(!entry.link && typeof entry.version === 'string' && entry.integrity, `Unverifiable locked dependency: ${name}`);
      if (entry.resolved !== undefined) {
        const resolved = new URL(entry.resolved);
        assert(resolved.protocol === 'https:' && !resolved.username && !resolved.password && !resolved.search && !resolved.hash, `Unsafe dependency URL: ${name}`);
        assert(resolved.href.startsWith(registry.href) || resolved.origin === 'https://registry.npmjs.org', `Lockfile bypasses selected registry: ${name}`);
      }
      const doc = await load(name);
      assert.equal(doc.value.name, name);
      assert.equal(doc.value.versions?.[entry.version]?.dist?.integrity, entry.integrity, `Published integrity mismatch: ${name}`);
      const publishedAt = doc.value.time?.[entry.version];
      const time = Date.parse(publishedAt);
      assert(Number.isFinite(time) && time <= now, `Missing or future publication timestamp: ${name}`);
      const excluded = policy.exclusions.includes(name);
      if (excluded) assert.equal(entry.version, '2026.9.2', `Exception does not cover ${name}@${entry.version}`);
      assert(excluded || time <= now - policy.minReleaseAgeDays * 86_400_000, `Dependency age policy blocks ${name}@${entry.version}`);
      checks.push({ name, version: entry.version, integrity: entry.integrity, publishedAt, exception: excluded, metadataSha256: doc.sha256 });
    }
  }));
  return { checkedAt: new Date(now).toISOString(), checks: checks.sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`)), sources: await Promise.all([...metadata.values()].map(async value => { const doc = await value; return { url: doc.source, sha256: doc.sha256, raw: doc.raw }; })) };
}
