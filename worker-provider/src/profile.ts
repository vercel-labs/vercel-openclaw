import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import type { NetworkPolicy, NetworkPolicyRule } from '@vercel/sandbox';
import { WorkerProviderError, type WorkerProfile } from 'openclaw/plugin-sdk/plugin-entry';

export type Profile = { gatewayOrigin: string; projectId: string; teamId: string; timeoutMs: number; npmRegistry: string; npmMinReleaseAgeDays: number; npmReleaseAgeExclusions: string[]; workerImage?: string; workerSnapshot?: string };
export const OWNER = 'openclaw-vercel-worker-v1';
export const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
export const allocationName = (operationId: string): string => {
  if (!operationId.trim() || operationId.length > 512) throw new WorkerProviderError('Invalid worker operation id.');
  return `ocw-${digest(operationId).slice(0, 40)}`;
};

export function parseProfile(input: WorkerProfile): Profile {
  if (Object.keys(input).some(key => !['gatewayOrigin', 'projectId', 'teamId', 'timeoutMs', 'npmRegistry', 'npmMinReleaseAgeDays', 'npmReleaseAgeExclusions', 'workerImage', 'workerSnapshot'].includes(key))) {
    throw new WorkerProviderError('Unknown Vercel worker setting. Credentials and setup commands do not belong in the profile.');
  }
  let origin: URL;
  try { origin = new URL(String(input.gatewayOrigin)); } catch { throw new WorkerProviderError('gatewayOrigin must be a public HTTPS origin.'); }
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash || origin.port || isIP(origin.hostname) || !origin.hostname.includes('.') || /\.(localhost|local|internal|test)$/.test(origin.hostname)) {
    throw new WorkerProviderError('gatewayOrigin must be a public HTTPS origin on port 443.');
  }
  if (typeof input.projectId !== 'string' || !/^prj_[A-Za-z0-9]+$/.test(input.projectId) || typeof input.teamId !== 'string' || !/^team_[A-Za-z0-9]+$/.test(input.teamId)) {
    throw new WorkerProviderError('Explicit Vercel projectId and teamId are required for stable lifecycle routing.');
  }
  const timeoutMs = input.timeoutMs ?? 2_700_000;
  if (typeof timeoutMs !== 'number' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1_200_000 || timeoutMs > 86_400_000) {
    throw new WorkerProviderError('timeoutMs must be between 20 minutes and 24 hours, within the selected Vercel plan limit.');
  }
  const npmRegistry = new URL(String(input.npmRegistry ?? 'https://registry.npmjs.org/'));
  if (npmRegistry.protocol !== 'https:' || npmRegistry.username || npmRegistry.password || npmRegistry.search || npmRegistry.hash || npmRegistry.port || isIP(npmRegistry.hostname) || !npmRegistry.hostname.includes('.') || /\.(localhost|local|internal|test)$/.test(npmRegistry.hostname)) throw new WorkerProviderError('npmRegistry must be a credential-free public HTTPS registry.');
  const npmMinReleaseAgeDays = input.npmMinReleaseAgeDays ?? 2;
  if (typeof npmMinReleaseAgeDays !== 'number' || !Number.isFinite(npmMinReleaseAgeDays) || npmMinReleaseAgeDays < 2 || npmMinReleaseAgeDays > 365) throw new WorkerProviderError('npmMinReleaseAgeDays must be between 2 and 365.');
  const npmReleaseAgeExclusions = input.npmReleaseAgeExclusions ?? [];
  if (!Array.isArray(npmReleaseAgeExclusions) || npmReleaseAgeExclusions.length > 2 || npmReleaseAgeExclusions.some(name => !['openclaw', '@openclaw/ai'].includes(String(name)))) throw new WorkerProviderError('Only explicitly approved OpenClaw release packages may be excluded from the age policy.');
  const workerImage = input.workerImage;
  const workerSnapshot = input.workerSnapshot;
  if (workerSnapshot !== undefined && (typeof workerSnapshot !== 'string' || !/^snap_[A-Za-z0-9]+$/.test(workerSnapshot) || workerImage !== undefined)) throw new WorkerProviderError('workerSnapshot must be an immutable snapshot ID, without a second image source.');
  if (workerImage !== undefined && (typeof workerImage !== 'string' || !/^(?:[a-z0-9][a-z0-9._-]*\/){0,3}[a-z0-9][a-z0-9._-]*@sha256:[a-f0-9]{64}$/.test(workerImage))) throw new WorkerProviderError('workerImage must be a digest-pinned Vercel image reference.');
  return { gatewayOrigin: origin.origin, projectId: input.projectId, teamId: input.teamId, timeoutMs, npmRegistry: npmRegistry.href, npmMinReleaseAgeDays, npmReleaseAgeExclusions: [...new Set(npmReleaseAgeExclusions as string[])].sort(), ...(workerImage ? { workerImage } : {}), ...(workerSnapshot ? { workerSnapshot } : {}) };
}

export type RegistryCredential = { registry: string; authorization: string };
export function registryNetworkRules(registry: string, credential?: RegistryCredential): NetworkPolicyRule[] {
  const url = new URL(registry);
  const fallback = { transform: [{ headers: { Host: url.hostname } }] };
  if (!credential) return [fallback];
  const scope = new URL(credential.registry);
  const normalized = (value: URL) => value.href.replace(/\/$/, '') + '/';
  if (normalized(scope) !== normalized(url) || !credential.authorization) throw new WorkerProviderError('npm credential registry scope mismatch.');
  return [{ match: { path: { startsWith: url.pathname.endsWith('/') ? url.pathname : url.pathname + '/' }, method: ['GET', 'HEAD'] },
    transform: [{ headers: { Host: url.hostname, Authorization: credential.authorization } }] }, fallback];
}

export function networkPolicy(profile: Profile, bootstrap: boolean, registryCredential?: RegistryCredential): NetworkPolicy {
  bootstrap = bootstrap && !profile.workerImage && !profile.workerSnapshot;
  const registryHost = new URL(profile.npmRegistry).hostname;
  const domains = [...new Set([new URL(profile.gatewayOrigin).hostname, ...(bootstrap ? [registryHost] : [])])];
  return { allow: Object.fromEntries(domains.map(host => [host, bootstrap && host === registryHost
    ? registryNetworkRules(profile.npmRegistry, registryCredential) : [{ transform: [{ headers: { Host: host } }] }]])) };
}

export const profileIntent = (profile: Profile): string => digest(JSON.stringify({ version: 1, ...profile, mode: 'worker-turn' }));
