type WaitingStatus =
  | "creating"
  | "setup"
  | "restoring"
  | "booting"
  | "starting"
  | string;

const STATUS_LABELS: Record<string, string> = {
  creating: "Creating sandbox",
  setup: "Installing OpenClaw",
  restoring: "Restoring snapshot",
  booting: "Waiting for gateway",
  starting: "Starting",
};

export function getWaitingPageHtml(
  returnPath: string,
  status: WaitingStatus,
): string {
  const label = STATUS_LABELS[status] ?? "Starting";
  const escapedReturnPath = escapeHtml(returnPath);
  const escapedLabel = escapeHtml(label);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapedLabel}</title>
  <style>
    * { box-sizing: border-box; margin: 0; }
    body {
      min-height: 100vh;
      display: grid;
      place-items: center;
      background: #000;
      color: #ededed;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
      -webkit-font-smoothing: antialiased;
      padding: 24px;
    }
    .panel {
      width: min(480px, 100%);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 12px;
      background: #0a0a0a;
      padding: 24px;
    }
    .eyebrow {
      font-size: 11px;
      font-weight: 500;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: #666;
      margin-bottom: 12px;
    }
    h1 {
      font-size: 24px;
      font-weight: 600;
      letter-spacing: -0.02em;
      line-height: 1.2;
      margin-bottom: 8px;
    }
    p {
      color: #888;
      font-size: 14px;
      line-height: 1.6;
    }
    .indicator {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-top: 24px;
      padding-top: 16px;
      border-top: 1px solid rgba(255, 255, 255, 0.08);
    }
    .dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #ededed;
      animation: pulse 1.5s ease-in-out infinite;
    }
    .hint {
      font-size: 12px;
      color: #666;
      font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.2; }
    }
  </style>
</head>
<body>
  <div class="panel" data-return-path="${escapedReturnPath}">
    <div class="eyebrow">OpenClaw</div>
    <h1>${escapedLabel}</h1>
    <p>The sandbox is working through a lifecycle step. This page will reload once the gateway is ready.</p>
    <div class="indicator">
      <div class="dot" aria-hidden="true"></div>
      <span class="hint">Polling /api/status every 2s</span>
    </div>
  </div>
  <script>
    (() => {
      const returnPath = document.querySelector('[data-return-path]')?.getAttribute('data-return-path') || '/gateway';
      const poll = async () => {
        try {
          const response = await fetch('/api/status?health=1', {
            headers: { accept: 'application/json' },
            credentials: 'same-origin',
          });
          if (!response.ok) {
            return;
          }
          const payload = await response.json();
          if (payload.status === 'running' && payload.gatewayReady) {
            location.replace(returnPath);
          }
        } catch (error) {}
      };

      void poll();
      window.setInterval(poll, 2000);
    })();
  </script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[<>&"']/g, (char) => {
    switch (char) {
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "&":
        return "&amp;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return char;
    }
  });
}
