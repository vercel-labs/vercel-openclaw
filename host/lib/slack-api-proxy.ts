import { timingSafeEqual } from 'node:crypto';

const HOST_AUTH_HEADER = 'x-openclaw-slack-host-authorization';
const SLACK_METHOD_RE = /^[a-zA-Z0-9._]+$/;

type SlackTokenProvider = () => Promise<string>;
type Fetcher = typeof fetch;

interface SlackApiProxyDependencies {
  bridgeToken: () => string | undefined;
  slackToken: SlackTokenProvider;
  fetcher?: Fetcher;
}

function authorized(request: Request, expected: string | undefined): boolean {
  if (!expected) return false;
  const actual = request.headers.get(HOST_AUTH_HEADER);
  if (!actual) return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(`Bearer ${expected}`);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

/**
 * Narrow Slack Web API broker. The sandbox proves only its host-bridge
 * identity; the short-lived Slack token is minted and consumed in this host.
 */
export function createSlackApiProxy(deps: SlackApiProxyDependencies) {
  const fetcher = deps.fetcher ?? fetch;

  return async function proxySlackApi(request: Request, method: string): Promise<Response> {
    if (!authorized(request, deps.bridgeToken())) {
      return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
    }
    if (!SLACK_METHOD_RE.test(method)) {
      return Response.json({ ok: false, error: 'invalid_method' }, { status: 400 });
    }

    const slackToken = await deps.slackToken();
    const headers = new Headers();
    headers.set('authorization', `Bearer ${slackToken}`);
    for (const name of ['accept', 'content-type']) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    const body = request.method === 'GET' || request.method === 'HEAD'
      ? undefined
      : await request.arrayBuffer();
    const upstream = await fetcher(`https://slack.com/api/${method}`, {
      method: request.method,
      headers,
      body,
      redirect: 'error',
    });

    const responseHeaders = new Headers();
    for (const name of ['content-type', 'retry-after', 'x-slack-req-id']) {
      const value = upstream.headers.get(name);
      if (value) responseHeaders.set(name, value);
    }
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  };
}

export { HOST_AUTH_HEADER };
