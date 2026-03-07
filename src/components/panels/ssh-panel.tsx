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
  { label: "Tail OpenClaw log", value: "tail -f /tmp/openclaw/openclaw-*.log" },
  { label: "List OpenClaw logs", value: "ls -la /tmp/openclaw/" },
  { label: "Tail sandbox logs", value: "tail -f /vercel/sandbox/.logs" },
  { label: "View config", value: "cat /etc/openclaw/openclaw.json" },
  { label: "Running processes", value: "ps aux" },
  { label: "Disk usage", value: "df -h" },
  { label: "Memory info", value: "free -h" },
  { label: "Network listeners", value: "ss -tlnp" },
] as const;

const MAX_HISTORY = 5;
const HISTORY_KEY = "openclaw-ssh-history";

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

export function SshPanel({ status, busy, requestJson }: SshPanelProps) {
  const [command, setCommand] = useState("");
  const [results, setResults] = useState<CommandResult[]>([]);
  const [history, setHistory] = useState<string[]>(() => loadHistory());
  const [running, setRunning] = useState(false);
  const [copied, setCopied] = useState<number | null>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

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

  const runCommand = useCallback(
    async (cmd: string) => {
      const trimmed = cmd.trim();
      if (!trimmed || running) return;

      setRunning(true);
      setHistory((prev) => {
        const next = [trimmed, ...prev.filter((c) => c !== trimmed)];
        return next.slice(0, MAX_HISTORY);
      });

      // Parse command: first token is the command, rest are args
      const parts = trimmed.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [
        trimmed,
      ];
      const baseCmd = parts[0];
      const args = parts.slice(1).map((a) => a.replace(/^["']|["']$/g, ""));

      const result = await requestJson<{
        stdout: string;
        stderr: string;
        exitCode: number;
      }>("/api/admin/ssh", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ command: baseCmd, args }),
        label: `Run: ${trimmed.slice(0, 40)}`,
        refreshAfter: false,
      });

      if (result) {
        setResults((prev) => [
          {
            command: trimmed,
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.exitCode,
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
          <h2>Sandbox command execution.</h2>
        </div>
      </div>

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
