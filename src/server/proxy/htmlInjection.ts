import { logDebug } from "@/server/log";

type WrapperContext = {
  sandboxOrigin: string;
  ticketId: string;
  nonce: string;
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
    ticketId: context.ticketId,
  });

  return `<script nonce="${context.nonce}">
(function() {
  var CONTEXT = ${encodedContext};
  var SANDBOX_ORIGIN = CONTEXT.sandboxOrigin;
  var TICKET_ID = CONTEXT.ticketId;
  var TOUCH_URL = '/api/status';
  var TICKET_URL = '/api/gateway-ticket';
  var HEARTBEAT_INTERVAL_MS = 4 * 60 * 1000;
  var openSocketCount = 0;
  var heartbeatIntervalId = null;
  var heartbeatInFlight = false;
  var GATEWAY_TOKEN = null;
  var pendingConnections = [];

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
  var appendGatewayAuthProtocol = function(protocols, token) {
    var authProtocol = 'openclaw.gateway-token.' + encodeURIComponent(token);
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

  var createProxiedSocket = function(url, protocols) {
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
        nextProtocols = appendGatewayAuthProtocol(protocols, GATEWAY_TOKEN);
        shouldTrackLifecycle = true;
      } else if (parsed.host === sandboxUrl.host) {
        parsed.searchParams.delete('token');
        wsUrl = parsed.toString();
        nextProtocols = appendGatewayAuthProtocol(protocols, GATEWAY_TOKEN);
        shouldTrackLifecycle = true;
      }
    } catch (error) {}

    var socket =
      nextProtocols === undefined
        ? new OriginalWebSocket(wsUrl)
        : new OriginalWebSocket(wsUrl, nextProtocols);

    if (shouldTrackLifecycle) {
      trackSocketLifecycle(socket);
    }

    return socket;
  };

  window.WebSocket = function(url, protocols) {
    if (GATEWAY_TOKEN !== null) {
      return createProxiedSocket(url, protocols);
    }

    // Token not yet available — queue and connect once redeemed.
    var deferred = { url: url, protocols: protocols, resolve: null, socket: null };
    var promise = new Promise(function(resolve) { deferred.resolve = resolve; });
    pendingConnections.push(deferred);

    // Return a placeholder that will be swapped once the real socket is ready.
    // We create a dummy that connects to nothing; the caller will get 'open' from
    // the real socket once the ticket is redeemed.
    promise.then(function(realSocket) { deferred.socket = realSocket; });

    // We cannot return a promise from the WebSocket constructor, so we eagerly
    // wait for the ticket and return a real socket.  In practice the ticket
    // redeems in <50 ms, well before any app code tries to send data.
    // Fall through: queue will be flushed by redeemTicket().
    // For safety, return a deferred-connect socket:
    return createDeferredSocket(deferred);
  };

  // Minimal wrapper that delays the real WebSocket until the token arrives.
  function createDeferredSocket(deferred) {
    var handler = {
      _listeners: {},
      _socket: null,
      addEventListener: function(type, fn) {
        if (!this._listeners[type]) this._listeners[type] = [];
        this._listeners[type].push(fn);
        if (this._socket) this._socket.addEventListener(type, fn);
      },
      removeEventListener: function(type, fn) {
        if (this._listeners[type]) {
          this._listeners[type] = this._listeners[type].filter(function(f) { return f !== fn; });
        }
        if (this._socket) this._socket.removeEventListener(type, fn);
      },
    };

    // Once the real socket is available, replay listeners.
    deferred.resolve = function(realSocket) {
      handler._socket = realSocket;
      var types = Object.keys(handler._listeners);
      for (var i = 0; i < types.length; i++) {
        var fns = handler._listeners[types[i]];
        for (var j = 0; j < fns.length; j++) {
          realSocket.addEventListener(types[i], fns[j]);
        }
      }
    };

    // Return a thin proxy — supports addEventListener and common props.
    var proxy = Object.create(OriginalWebSocket.prototype);
    proxy.addEventListener = function(t, f) { handler.addEventListener(t, f); };
    proxy.removeEventListener = function(t, f) { handler.removeEventListener(t, f); };
    Object.defineProperty(proxy, 'readyState', {
      get: function() { return handler._socket ? handler._socket.readyState : OriginalWebSocket.CONNECTING; },
    });
    Object.defineProperty(proxy, 'bufferedAmount', {
      get: function() { return handler._socket ? handler._socket.bufferedAmount : 0; },
    });
    proxy.send = function(data) {
      if (handler._socket) return handler._socket.send(data);
      throw new DOMException('WebSocket is not yet connected', 'InvalidStateError');
    };
    proxy.close = function(code, reason) {
      if (handler._socket) return handler._socket.close(code, reason);
    };
    return proxy;
  }

  window.WebSocket.prototype = OriginalWebSocket.prototype;
  window.WebSocket.CONNECTING = OriginalWebSocket.CONNECTING;
  window.WebSocket.OPEN = OriginalWebSocket.OPEN;
  window.WebSocket.CLOSING = OriginalWebSocket.CLOSING;
  window.WebSocket.CLOSED = OriginalWebSocket.CLOSED;

  // Redeem the ticket to obtain the gateway token.
  (async function redeemTicket() {
    try {
      var resp = await fetch(TICKET_URL, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ ticket: TICKET_ID }),
      });
      if (!resp.ok) {
        // Ticket expired or already used — reload the page to get a fresh one.
        location.reload();
        return;
      }
      var data = await resp.json();
      GATEWAY_TOKEN = data.token;

      // Inject token into URL for OpenClaw's own auth, then strip it.
      var currentUrl = new URL(location.href);
      currentUrl.searchParams.set('token', GATEWAY_TOKEN);
      history.replaceState(null, '', currentUrl.pathname + currentUrl.search + currentUrl.hash);

      var stripToken = function() {
        var cleaned = new URL(location.href);
        cleaned.searchParams.delete('token');
        history.replaceState(null, '', cleaned.pathname + cleaned.search + cleaned.hash);
      };

      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', stripToken, { once: true });
      } else {
        stripToken();
      }

      // Flush any queued WebSocket connections.
      for (var i = 0; i < pendingConnections.length; i++) {
        var pending = pendingConnections[i];
        var realSocket = createProxiedSocket(pending.url, pending.protocols);
        if (pending.resolve) pending.resolve(realSocket);
      }
      pendingConnections = [];
    } catch (error) {
      // Network error — retry once after a short delay.
      setTimeout(redeemTicket, 1000);
    }
  })();
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
