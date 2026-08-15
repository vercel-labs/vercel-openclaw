import { timingSafeEqual } from 'node:crypto';

const HOST_AUTH_HEADER = 'x-openclaw-slack-host-authorization';
const SLACK_METHOD_RE = /^[a-zA-Z0-9._]+$/;

type SlackTokenProvider = () => Promise<string>;
type Fetcher = typeof fetch;

interface SlackApiProxyDependencies {
  bridgeToken: () => string | undefined;
  slackToken: SlackTokenProvider;
  fetcher?: Fetcher;
  logger?: (entry: Record<string, unknown>) => void;
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
  const logger = deps.logger ?? ((entry: Record<string, unknown>) => console.info(entry));

  return async function proxySlackApi(request: Request, method: string): Promise<Response> {
    if (!authorized(request, deps.bridgeToken())) {
      return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
    }
    if (!SLACK_METHOD_RE.test(method)) {
      return Response.json({ ok: false, error: 'invalid_method' }, { status: 400 });
    }

    const upstreamUrl = new URL(`https://slack.com/api/${method}`);
    const requestUrl = new URL(request.url);
    for (const [name, value] of requestUrl.searchParams) {
      if (name !== 'token') upstreamUrl.searchParams.append(name, value);
    }

    const headers = new Headers();
    for (const name of ['accept', 'content-type']) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    let body: BodyInit | undefined;
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      const contentType = request.headers.get('content-type') ?? '';
      if (contentType.startsWith('application/x-www-form-urlencoded')) {
        const fields = new URLSearchParams(await request.text());
        // Connect is the only Slack credential owner. The sandbox may provide
        // method arguments, but it can never select or override Slack auth.
        fields.delete('token');
        body = fields.toString();
      } else if (contentType.startsWith('application/json')) {
        const fields = await request.json() as Record<string, unknown>;
        delete fields.token;
        body = JSON.stringify(fields);
      } else if (contentType.startsWith('multipart/form-data')) {
        const fields = await request.formData();
        fields.delete('token');
        body = fields;
        // Fetch must generate a new boundary for the sanitized FormData body.
        headers.delete('content-type');
      } else {
        return Response.json({ ok: false, error: 'unsupported_content_type' }, { status: 415 });
      }
    }
    const slackToken = await deps.slackToken();
    headers.set('authorization', `Bearer ${slackToken}`);
    const upstream = await fetcher(upstreamUrl.toString(), {
      method: request.method,
      headers,
      body,
      redirect: 'error',
    });

    logger({
      event: 'slack_proxy_upstream',
      method,
      tokenSource: 'connect',
      status: upstream.status,
      slackRequestId: upstream.headers.get('x-slack-req-id') ?? undefined,
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
