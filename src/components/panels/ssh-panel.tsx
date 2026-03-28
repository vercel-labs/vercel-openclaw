"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { StatusPayload, RequestJson } from "@/components/admin-types";
import { ExitCodeBadge } from "@/components/ui/badge";

type CommandResult = {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  timestamp: number;
};

type SshPanelProps = {
  status: StatusPayload;
  busy: boolean;
  requestJson: RequestJson;
};

const SUGGESTED_COMMANDS = [
  { label: "Tail OpenClaw log", value: "tail -n 200 /tmp/openclaw/openclaw-*.log" },
  { label: "List OpenClaw logs", value: "ls -la /tmp/openclaw/" },
  { label: "Tail sandbox logs", value: "tail -n 200 /vercel/sandbox/.logs" },
  { label: "View config", value: "cat /etc/openclaw/openclaw.json" },
  { label: "Running processes", value: "ps aux" },
  { label: "Disk usage", value: "df -h" },
  { label: "Memory info", value: "free -h" },
  { label: "Network listeners", value: "ss -tlnp" },
] as const;

const MAX_HISTORY = 5;
const HISTORY_KEY = "openclaw-ssh-history";

/** IDs safe to embed in a copy-paste shell command (avoids injection if metadata were tampered with). */
const SAFE_SANDBOX_ID = /^[a-zA-Z0-9_-]{1,128}$/;
const SAFE_CLI_FLAG_VALUE = /^[a-zA-Z0-9_.-]{1,256}$/;

function isSafeSandboxId(id: string): boolean {
  return SAFE_SANDBOX_ID.test(id);
}

function loadHistory(): string[] {
  try {
    const stored = localStorage.getItem(HISTORY_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as unknown;
      if (Array.isArray(parsed) && parsed.every((v) => typeof v === "string")) {
        return (parsed as string[]).slice(0, MAX_HISTORY);
      }
    }
  } catch {
    // localStorage unavailable or corrupt
  }
  return [];
}

function saveHistory(history: string[]): void {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  } catch {
    // localStorage unavailable
  }
}

function buildSandboxConnectCommand(sandboxId: string): string | null {
  if (!isSafeSandboxId(sandboxId)) return null;
  const scope =
    typeof process.env.NEXT_PUBLIC_SANDBOX_SCOPE === "string"
      ? process.env.NEXT_PUBLIC_SANDBOX_SCOPE.trim()
      : "";
  const project =
    typeof process.env.NEXT_PUBLIC_SANDBOX_PROJECT === "string"
      ? process.env.NEXT_PUBLIC_SANDBOX_PROJECT.trim()
      : "";
  const scopeOk = !scope || SAFE_CLI_FLAG_VALUE.test(scope);
  const projectOk = !project || SAFE_CLI_FLAG_VALUE.test(project);
  if (!scopeOk || !projectOk) {
    return `npx sandbox connect ${sandboxId}`;
  }
  const scopeFlags = [
    scope ? `--scope ${scope}` : "",
    project ? `--project ${project}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return scopeFlags
    ? `npx sandbox connect ${sandboxId} ${scopeFlags}`
    : `npx sandbox connect ${sandboxId}`;
}

export function SshPanel({ status, busy, requestJson }: SshPanelProps) {
  const [command, setCommand] = useState("");
  const [results, setResults] = useState<CommandResult[]>([]);
  const [history, setHistory] = useState<string[]>(() => loadHistory());
  const [running, setRunning] = useState(false);
  const [copied, setCopied] = useState<number | null>(null);
  const [copiedCli, setCopiedCli] = useState<string | null>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cliCopyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const sandboxId = status.sandboxId;
  const hasScopeEnv =
    Boolean(
      (typeof process.env.NEXT_PUBLIC_SANDBOX_SCOPE === "string" &&
        process.env.NEXT_PUBLIC_SANDBOX_SCOPE.trim()) ||
        (typeof process.env.NEXT_PUBLIC_SANDBOX_PROJECT === "string" &&
          process.env.NEXT_PUBLIC_SANDBOX_PROJECT.trim()),
    );
  const connectCommand =
    sandboxId ? buildSandboxConnectCommand(sandboxId) : null;

  const copyCli = useCallback((text: string, key: string) => {
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopiedCli(key);
        if (cliCopyTimerRef.current) clearTimeout(cliCopyTimerRef.current);
        cliCopyTimerRef.current = setTimeout(() => setCopiedCli(null), 2000);
      })
      .catch(() => {
        setCopiedCli(`fail-${key}`);
        if (cliCopyTimerRef.current) clearTimeout(cliCopyTimerRef.current);
        cliCopyTimerRef.current = setTimeout(() => setCopiedCli(null), 3000);
      });
  }, []);

  const isRunning = status.status === "running";
  const isStarting = status.status === "booting" || status.status === "setup";

  const nonRunningMessage = isStarting
    ? "Sandbox is starting \u2014 commands available once running."
    : status.status === "stopped"
      ? "Sandbox is stopped \u2014 restore it to run commands."
      : "Sandbox is not running \u2014 start it from the Status tab first.";

  // Persist history to localStorage whenever it changes
  useEffect(() => {
    saveHistory(history);
  }, [history]);

  useEffect(() => {
    return () => {
      if (cliCopyTimerRef.current) clearTimeout(cliCopyTimerRef.current);
    };
  }, []);

  const runCommand = useCallback(
    async (cmd: string) => {
      const trimmed = cmd.trim();
      if (!trimmed || running) return;

      setRunning(true);
      setHistory((prev) => {
        const next = [trimmed, ...prev.filter((c) => c !== trimmed)];
        return next.slice(0, MAX_HISTORY);
      });

      const result = await requestJson<{
        stdout: string;
        stderr: string;
        exitCode: number;
      }>("/api/admin/ssh", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ command: trimmed }),
        label: `Run: ${trimmed.slice(0, 40)}`,
        refreshAfter: false,
      });

      if (result.ok && result.data) {
        setResults((prev) => [
          {
            command: trimmed,
            stdout: result.data!.stdout,
            stderr: result.data!.stderr,
            exitCode: result.data!.exitCode,
            timestamp: Date.now(),
          },
          ...prev,
        ]);
      }

      setRunning(false);
      setCommand("");
      inputRef.current?.focus();
    },
    [running, requestJson],
  );

  const copyOutput = useCallback((index: number, text: string) => {
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(index);
        if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
        copyTimerRef.current = setTimeout(() => setCopied(null), 1500);
      })
      .catch(() => {
        /* clipboard unavailable */
      });
  }, []);

  return (
    <article className="panel-card">
      <div className="panel-head">
        <div>
          <p className="eyebrow">Terminal</p>
          <h2>Sandbox command execution</h2>
        </div>
      </div>

      {sandboxId ? (
        <div className="ssh-connect-section">
          <div className="ssh-connect-field">
            <div className="ssh-connect-label">Sandbox ID</div>
            <div className="ssh-connect-row">
              <code className="ssh-connect-code" title={sandboxId}>
                {sandboxId}
              </code>
              <button
                type="button"
                className="button ghost ssh-connect-copy"
                onClick={() => copyCli(sandboxId, "id")}
              >
                {copiedCli === "id"
                  ? "Copied"
                  : copiedCli === "fail-id"
                    ? "Copy failed"
                    : "Copy"}
              </button>
            </div>
          </div>
          {connectCommand ? (
            <div className="ssh-connect-field">
              <div className="ssh-connect-label">Connect with Vercel CLI</div>
              <div className="ssh-connect-row">
                <code className="ssh-connect-code" title={connectCommand}>
                  {connectCommand}
                </code>
                <button
                  type="button"
                  className="button ghost ssh-connect-copy"
                  onClick={() => copyCli(connectCommand, "connect")}
                >
                  {copiedCli === "connect"
                    ? "Copied"
                    : copiedCli === "fail-connect"
                      ? "Copy failed"
                      : "Copy"}
                </button>
              </div>
            </div>
          ) : (
            <p className="ssh-connect-command-blocked">
              Connect command not shown: sandbox ID uses characters that are not
              safe to paste into a shell. Use the Vercel dashboard or run{" "}
              <code className="ssh-inline-code">npx sandbox connect</code> with
              the ID from above only if you trust this deployment.
            </p>
          )}
          <details className="ssh-cli-instructions">
            <summary>How to connect with <code>npx sandbox</code></summary>
            <ol>
              <li>
                Install or use the{" "}
                <a
                  href="https://vercel.com/docs/vercel-sandbox"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Vercel Sandbox CLI
                </a>
                . Log in: <code className="ssh-inline-code">npx sandbox login</code>
              </li>
              <li>
                {connectCommand ? (
                  <>
                    Copy the connect command above and run it in your terminal
                    for a full interactive shell in the sandbox MicroVM.
                  </>
                ) : (
                  <>
                    Run{" "}
                    <code className="ssh-inline-code">
                      npx sandbox connect &lt;SANDBOX_ID&gt;
                    </code>{" "}
                    using the sandbox ID shown above (verify the ID before
                    pasting into your terminal).
                  </>
                )}
              </li>
              {!hasScopeEnv && (
                <li>
                  If you get a 404, pass your team and project:{" "}
                  <code className="ssh-inline-code">
                    --scope TEAM_SLUG --project PROJECT_NAME
                  </code>{" "}
                  (append to the connect command). You can also set{" "}
                  <code className="ssh-inline-code">NEXT_PUBLIC_SANDBOX_SCOPE</code>{" "}
                  and{" "}
                  <code className="ssh-inline-code">
                    NEXT_PUBLIC_SANDBOX_PROJECT
                  </code>{" "}
                  so this page pre-fills them.
                </li>
              )}
            </ol>
            <p className="ssh-cli-note">
              The Run command box below executes one-off commands through this
              app. For an interactive terminal, use the CLI.
            </p>
          </details>
        </div>
      ) : (
        <p className="ssh-connect-unavailable">
          No sandbox ID yet. Start the sandbox from the Status tab, then refresh
          — you&apos;ll see the <code className="ssh-inline-code">npx sandbox connect</code>{" "}
          command here.
        </p>
      )}

      {!isRunning && <p className="error-banner">{nonRunningMessage}</p>}

      {/* Command input */}
      <form
        className="ssh-input-row"
        onSubmit={(e) => {
          e.preventDefault();
          void runCommand(command);
        }}
      >
        <span className="ssh-prompt">$</span>
        <input
          ref={inputRef}
          type="text"
          className="ssh-input"
          placeholder="Enter command..."
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          disabled={!isRunning || busy || running}
          autoComplete="off"
          spellCheck={false}
          data-1p-ignore
          data-lpignore="true"
          data-form-type="other"
        />
        <button
          type="submit"
          className="button primary"
          disabled={!isRunning || busy || running || !command.trim()}
        >
          {running ? "Running..." : "Run"}
        </button>
      </form>

      {/* Suggested commands */}
      <div className="ssh-suggestions">
        <span className="ssh-suggestions-label">Suggested:</span>
        {SUGGESTED_COMMANDS.map((cmd) => (
          <button
            key={cmd.value}
            type="button"
            className="ssh-suggestion-chip"
            disabled={!isRunning || busy || running}
            title={cmd.value}
            onClick={() => {
              setCommand(cmd.value);
              inputRef.current?.focus();
            }}
          >
            {cmd.label}
          </button>
        ))}
      </div>

      {/* Command history */}
      {history.length > 0 && (
        <div className="ssh-history">
          <span className="ssh-suggestions-label">History:</span>
          {history.map((cmd) => (
            <button
              key={cmd}
              type="button"
              className="ssh-suggestion-chip"
              disabled={!isRunning || busy || running}
              onClick={() => void runCommand(cmd)}
            >
              {cmd.length > 40 ? cmd.slice(0, 37) + "..." : cmd}
            </button>
          ))}
        </div>
      )}

      {/* Results */}
      {results.map((r, i) => {
        const fullOutput = [r.stdout, r.stderr].filter(Boolean).join("\n");
        return (
          <div key={r.timestamp} className="ssh-result">
            <div className="ssh-result-header">
              <code className="ssh-result-command">$ {r.command}</code>
              <ExitCodeBadge exitCode={r.exitCode} />
              <button
                type="button"
                className="button ghost ssh-copy-btn"
                onClick={() => copyOutput(i, fullOutput)}
              >
                {copied === i ? "Copied!" : "Copy"}
              </button>
            </div>
            {r.stdout && (
              <pre className="ssh-output ssh-stdout">{r.stdout}</pre>
            )}
            {r.stderr && (
              <pre className="ssh-output ssh-stderr">{r.stderr}</pre>
            )}
          </div>
        );
      })}
    </article>
  );
}
