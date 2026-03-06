type WrapperContext = {
  sandboxOrigin: string;
  gatewayToken: string;
};

function escapeForInlineScriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/[<\u2028\u2029]/g, (char) => {
    switch (char) {
      case "<":
        return "\\u003c";
      case "\u2028":
        return "\\u2028";
      case "\u2029":
        return "\\u2029";
      default:
        return char;
    }
  });
}

function buildInterceptorScript(context: WrapperContext): string {
  const encodedContext = escapeForInlineScriptJson(context);

  return `<script>
(function() {
  const CONTEXT = ${encodedContext};
  const SANDBOX_ORIGIN = CONTEXT.sandboxOrigin;
  const GATEWAY_TOKEN = CONTEXT.gatewayToken;
  const TOUCH_URL = '/api/status';
  const HEARTBEAT_INTERVAL_MS = 4 * 60 * 1000;
  let openSocketCount = 0;
  let heartbeatIntervalId = null;
  let heartbeatInFlight = false;

  const shouldHeartbeat = function() {
    return openSocketCount > 0 && document.visibilityState === 'visible';
  };

  const stopHeartbeat = function() {
    if (heartbeatIntervalId !== null) {
      clearInterval(heartbeatIntervalId);
      heartbeatIntervalId = null;
    }
  };

  const sendHeartbeat = async function() {
    if (heartbeatInFlight || !shouldHeartbeat()) {
      return;
    }

    heartbeatInFlight = true;
    try {
      await fetch(TOUCH_URL, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          accept: 'application/json',
        },
      });
    } catch (error) {
    } finally {
      heartbeatInFlight = false;
    }
  };

  const syncHeartbeat = function() {
    if (!shouldHeartbeat()) {
      stopHeartbeat();
      return;
    }

    if (heartbeatIntervalId === null) {
      heartbeatIntervalId = window.setInterval(function() {
        void sendHeartbeat();
      }, HEARTBEAT_INTERVAL_MS);
      void sendHeartbeat();
    }
  };

  document.addEventListener('visibilitychange', syncHeartbeat);
  window.addEventListener('beforeunload', stopHeartbeat);
  window.addEventListener('pagehide', stopHeartbeat);

  const OriginalWebSocket = window.WebSocket;
  const appendGatewayAuthProtocol = function(protocols) {
    const authProtocol = 'openclaw.gateway-token.' + encodeURIComponent(GATEWAY_TOKEN);
    const protocolList =
      protocols == null ? [] : Array.isArray(protocols) ? protocols.slice() : [protocols];
    if (!protocolList.includes(authProtocol)) {
      protocolList.push(authProtocol);
    }
    return protocolList.length === 0 ? undefined : protocolList;
  };

  const trackSocketLifecycle = function(socket) {
    let countedAsOpen = false;
    const markOpen = function() {
      if (countedAsOpen) return;
      countedAsOpen = true;
      openSocketCount += 1;
      syncHeartbeat();
    };
    const markClosed = function() {
      if (!countedAsOpen) return;
      countedAsOpen = false;
      openSocketCount = Math.max(0, openSocketCount - 1);
      syncHeartbeat();
    };

    socket.addEventListener('open', markOpen);
    socket.addEventListener('close', markClosed);
    socket.addEventListener('error', function() {
      if (socket.readyState === OriginalWebSocket.CLOSED) {
        markClosed();
      }
    });
  };

  window.WebSocket = function(url, protocols) {
    let wsUrl = url;
    let nextProtocols = protocols;
    let shouldTrackLifecycle = false;

    try {
      const parsed = new URL(url, window.location.href);
      const sandboxUrl = new URL(SANDBOX_ORIGIN);
      if (parsed.host === window.location.host) {
        parsed.hostname = sandboxUrl.hostname;
        parsed.port = sandboxUrl.port;
        parsed.protocol = sandboxUrl.protocol === 'http:' ? 'ws:' : 'wss:';
        if (parsed.pathname.indexOf('/gateway') === 0) {
          const stripped = parsed.pathname.slice('/gateway'.length);
          parsed.pathname = stripped || '/';
        }
        parsed.searchParams.delete('token');
        wsUrl = parsed.toString();
        nextProtocols = appendGatewayAuthProtocol(protocols);
        shouldTrackLifecycle = true;
      } else if (parsed.host === sandboxUrl.host) {
        parsed.searchParams.delete('token');
        wsUrl = parsed.toString();
        nextProtocols = appendGatewayAuthProtocol(protocols);
        shouldTrackLifecycle = true;
      }
    } catch (error) {}

    const socket =
      nextProtocols === undefined
        ? new OriginalWebSocket(wsUrl)
        : new OriginalWebSocket(wsUrl, nextProtocols);

    if (shouldTrackLifecycle) {
      trackSocketLifecycle(socket);
    }

    return socket;
  };
  window.WebSocket.prototype = OriginalWebSocket.prototype;
  window.WebSocket.CONNECTING = OriginalWebSocket.CONNECTING;
  window.WebSocket.OPEN = OriginalWebSocket.OPEN;
  window.WebSocket.CLOSING = OriginalWebSocket.CLOSING;
  window.WebSocket.CLOSED = OriginalWebSocket.CLOSED;

  const currentUrl = new URL(location.href);
  currentUrl.searchParams.set('token', GATEWAY_TOKEN);
  history.replaceState(null, '', currentUrl.pathname + currentUrl.search + currentUrl.hash);

  const stripToken = function() {
    const cleaned = new URL(location.href);
    cleaned.searchParams.delete('token');
    history.replaceState(null, '', cleaned.pathname + cleaned.search + cleaned.hash);
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', stripToken, { once: true });
  } else {
    stripToken();
  }
})();
</script>`;
}

function injectIntoHead(html: string, injection: string): string {
  const headMatch = html.match(/<head[^>]*>/i);
  if (!headMatch || !headMatch[0]) {
    return `${injection}${html}`;
  }
  return html.replace(headMatch[0], `${headMatch[0]}<meta name="referrer" content="no-referrer">${injection}`);
}

export function injectWrapperScript(
  html: string,
  context: WrapperContext,
): string {
  return injectIntoHead(html, buildInterceptorScript(context));
}
