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
  nonce?: string,
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
    :root {
      color-scheme: dark;
      --bg: #081018;
      --panel: rgba(10, 17, 24, 0.82);
      --border: rgba(255, 255, 255, 0.12);
      --text: #f3efe6;
      --muted: #a9b3be;
      --accent: #f59e0b;
      --accent-2: #7dd3fc;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      background:
        radial-gradient(circle at top, rgba(125, 211, 252, 0.14), transparent 30%),
        radial-gradient(circle at bottom, rgba(245, 158, 11, 0.12), transparent 35%),
        linear-gradient(180deg, #07111b, #03070d 60%);
      color: var(--text);
      font-family: "Iowan Old Style", "Palatino Linotype", Georgia, serif;
      padding: 24px;
    }
    .panel {
      width: min(560px, 100%);
      border: 1px solid var(--border);
      background: var(--panel);
      backdrop-filter: blur(24px);
      border-radius: 28px;
      padding: 28px;
      box-shadow: 0 30px 90px rgba(0, 0, 0, 0.35);
    }
    .eyebrow {
      font: 600 12px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      color: var(--accent-2);
      margin-bottom: 12px;
    }
    h1 {
      margin: 0 0 10px;
      font-size: clamp(30px, 5vw, 48px);
      line-height: 0.95;
    }
    p {
      margin: 0;
      color: var(--muted);
      font: 400 16px/1.6 ui-sans-serif, system-ui, sans-serif;
    }
    .pulse {
      width: 14px;
      height: 14px;
      margin-top: 28px;
      border-radius: 999px;
      background: linear-gradient(135deg, var(--accent), var(--accent-2));
      box-shadow: 0 0 0 0 rgba(245, 158, 11, 0.5);
      animation: pulse 1.8s infinite;
    }
    .hint {
      margin-top: 18px;
      font: 500 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
      color: rgba(255, 255, 255, 0.58);
    }
    @keyframes pulse {
      0% { box-shadow: 0 0 0 0 rgba(245, 158, 11, 0.5); }
      70% { box-shadow: 0 0 0 18px rgba(245, 158, 11, 0); }
      100% { box-shadow: 0 0 0 0 rgba(245, 158, 11, 0); }
    }
  </style>
</head>
<body>
  <div class="panel" data-return-path="${escapedReturnPath}">
    <div class="eyebrow">OpenClaw Single</div>
    <h1>${escapedLabel}</h1>
    <p>The sandbox is working through a one-time lifecycle step. This page will reload once the gateway is ready.</p>
    <div class="pulse" aria-hidden="true"></div>
    <div class="hint">Polling /api/status every 2 seconds</div>
  </div>
  <script${nonce ? ` nonce="${escapeHtml(nonce)}"` : ""}>
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
