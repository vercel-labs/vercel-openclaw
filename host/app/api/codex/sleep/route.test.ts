import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const mocks = vi.hoisted(() => ({ claim: vi.fn(), release: vi.fn(), stop: vi.fn(), token: vi.fn() }));
vi.mock('@/lib/codex-admission', () => ({ claimCodexSleep: mocks.claim }));
vi.mock('@/lib/codex-lifecycle', () => ({ stopCodexSession: mocks.stop }));
vi.mock('@vercel/oidc', () => ({ getVercelOidcToken: mocks.token }));
vi.mock('@/lib/codex-sleep-auth', async () => import('../../../../lib/codex-sleep-auth'));
vi.mock('@/lib/codex-diagnostics', async () => import('../../../../lib/codex-diagnostics'));
import { sleepCapability } from '../../../../lib/codex-sleep-auth';
import { POST } from './route';
const digest = 'a'.repeat(64), session = 'sbx_abc';
const request = (authorization = `Bearer ${sleepCapability('name', session, digest)}`) => new NextRequest('https://host.example.org/api/codex/sleep', { method: 'POST', headers: { authorization }, body: JSON.stringify({ platformSessionId: session, runtimeDigest: digest }) });
describe('resident-triggered sleep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(process.env, { OPENCLAW_ENGINE: 'codex', OPENCLAW_GATEWAY_TOKEN: 'test', OPENCLAW_CODEX_SANDBOX_NAME: 'name', OPENCLAW_CODEX_RUNTIME_DIGEST: digest });
    mocks.claim.mockResolvedValue({ accepted: true, release: mocks.release });
    mocks.token.mockResolvedValue('fresh-oidc');
    mocks.stop.mockResolvedValue({ action: 'sleep' });
  });
  it('cannot wake, refresh credentials or stop on an unauthorized request', async () => {
    expect((await POST(request('wrong'))).status).toBe(401);
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.token).not.toHaveBeenCalled();
    expect(mocks.stop).not.toHaveBeenCalled();
  });
  it('does not interrupt the turn that holds admission', async () => {
    mocks.claim.mockResolvedValueOnce({ accepted: false, release: mocks.release });
    expect(await (await POST(request())).json()).toEqual({ action: 'busy' });
    expect(mocks.stop).not.toHaveBeenCalled();
    expect(mocks.release).not.toHaveBeenCalled();
  });
  it('uses a fresh Function credential and releases admission after successful sleep', async () => {
    expect((await POST(request())).status).toBe(200);
    expect(mocks.stop).toHaveBeenCalledWith({ name: 'name', platformSessionId: session, oidcToken: 'fresh-oidc' });
    expect(mocks.release).toHaveBeenCalledOnce();
  });
  it('releases admission and reports failure without leaking token errors', async () => {
    mocks.token.mockRejectedValueOnce(new Error('private-token'));
    const response = await POST(request());
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('private-token');
    expect(mocks.release).toHaveBeenCalledOnce();
  });
});
