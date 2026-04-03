import { logDebug } from "@/server/log";

type WrapperContext = {
  sandboxOrigin: string;
  gatewayToken: string;
  heartbeatIntervalMs: number;
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
  const encodedContext = escapeForInlineScriptJson({
    sandboxOrigin: context.sandboxOrigin,
    gatewayToken: context.gatewayToken,
    heartbeatIntervalMs: context.heartbeatIntervalMs,
  });

  return `<script>
(function() {
  var CONTEXT = ${encodedContext};
  var SANDBOX_ORIGIN = CONTEXT.sandboxOrigin;
  var GATEWAY_TOKEN = CONTEXT.gatewayToken;
  var TOUCH_URL = '/api/status';
  var HEARTBEAT_INTERVAL_MS = CONTEXT.heartbeatIntervalMs;
  var openSocketCount = 0;
  var heartbeatIntervalId = null;
  var heartbeatInFlight = false;
  var heartbeatConsecutiveFailures = 0;
  var HEARTBEAT_FAILURE_THRESHOLD = 3;

  var shouldHeartbeat = function() {
    return openSocketCount > 0 && document.visibilityState === 'visible';
  };

  var stopHeartbeat = function() {
    if (heartbeatIntervalId !== null) {
      clearInterval(heartbeatIntervalId);
      heartbeatIntervalId = null;
    }
  };

  var sendHeartbeat = async function() {
    if (heartbeatInFlight || !shouldHeartbeat()) {
      return;
    }

    heartbeatInFlight = true;
    try {
      var resp = await fetch(TOUCH_URL, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          accept: 'application/json',
        },
      });
      if (!resp.ok) {
        heartbeatConsecutiveFailures += 1;
        if (heartbeatConsecutiveFailures === HEARTBEAT_FAILURE_THRESHOLD) {
          console.warn('[openclaw] heartbeat failing (' + heartbeatConsecutiveFailures + ' consecutive, status ' + resp.status + '). Sandbox may time out.');
        }
      } else {
        if (heartbeatConsecutiveFailures >= HEARTBEAT_FAILURE_THRESHOLD) {
          console.info('[openclaw] heartbeat recovered after ' + heartbeatConsecutiveFailures + ' failures');
        }
        heartbeatConsecutiveFailures = 0;
      }
    } catch (error) {
      heartbeatConsecutiveFailures += 1;
      if (heartbeatConsecutiveFailures === HEARTBEAT_FAILURE_THRESHOLD) {
        console.warn('[openclaw] heartbeat failing (' + heartbeatConsecutiveFailures + ' consecutive, network error). Sandbox may time out.');
      }
    } finally {
      heartbeatInFlight = false;
    }
  };

  var syncHeartbeat = function() {
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

  var OriginalWebSocket = window.WebSocket;
  var appendGatewayAuthProtocol = function(protocols) {
    if (!GATEWAY_TOKEN) return protocols;
    var authProtocol = 'openclaw.gateway-token.' + encodeURIComponent(GATEWAY_TOKEN);
    var protocolList =
      protocols == null ? [] : Array.isArray(protocols) ? protocols.slice() : [protocols];
    if (!protocolList.includes(authProtocol)) {
      protocolList.push(authProtocol);
    }
    return protocolList.length === 0 ? undefined : protocolList;
  };

  var trackSocketLifecycle = function(socket) {
    var countedAsOpen = false;
    var markOpen = function() {
      if (countedAsOpen) return;
      countedAsOpen = true;
      openSocketCount += 1;
      syncHeartbeat();
    };
    var markClosed = function() {
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
    var wsUrl = url;
    var nextProtocols = protocols;
    var shouldTrackLifecycle = false;

    try {
      var parsed = new URL(url, window.location.href);
      var sandboxUrl = new URL(SANDBOX_ORIGIN);
      if (parsed.host === window.location.host) {
        parsed.hostname = sandboxUrl.hostname;
        parsed.port = sandboxUrl.port;
        parsed.protocol = sandboxUrl.protocol === 'http:' ? 'ws:' : 'wss:';
        if (parsed.pathname.indexOf('/gateway') === 0) {
          var stripped = parsed.pathname.slice('/gateway'.length);
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
    } catch (error) {
      console.warn('[openclaw] WebSocket URL rewrite failed for', url, error);
    }

    var socket =
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

  // Pass the gateway token to the OpenClaw app via the URL hash fragment.
  // The app reads token from the hash (not query params) and cleans it up
  // itself after consuming it.  The hash fragment is never sent to servers,
  // so there is no leakage risk.
  if (GATEWAY_TOKEN) {
    var u = new URL(location.href);
    var hashParams = new URLSearchParams(u.hash.startsWith('#') ? u.hash.slice(1) : u.hash);
    hashParams.set('token', GATEWAY_TOKEN);
    u.hash = '#' + hashParams.toString();
    history.replaceState(null, '', u.pathname + u.search + u.hash);
  }
})();
</script>`;
}

function injectIntoHead(html: string, injection: string, basePath: string): string {
  const headMatch = html.match(/<head[^>]*>/i);
  const baseTag = `<base href="${basePath}">`;
  if (!headMatch || !headMatch[0]) {
    return `${baseTag}${injection}${html}`;
  }
  return html.replace(headMatch[0], `${headMatch[0]}${baseTag}<meta name="referrer" content="no-referrer">${injection}`);
}

export function injectWrapperScript(
  html: string,
  context: WrapperContext,
): string {
  logDebug("gateway.html_injection_applied", {
    sandboxOrigin: context.sandboxOrigin,
    htmlLength: html.length,
  });
  return injectIntoHead(html, buildInterceptorScript(context), "/gateway/");
}
