"use client";

import { useCallback, useEffect, useState } from "react";
import { ChannelPill } from "@/components/ui/badge";
import { ConfirmDialog, useConfirm } from "@/components/ui/confirm-dialog";
import {
  fetchAdminJsonCore,
  type ReadJsonDeps,
} from "@/components/admin-request-core";
import type { RequestJson } from "@/components/admin-types";

export type CodexAuthStatus = {
  connected: boolean;
  accountId: string | null;
  expires: number | null;
  updatedAt: number | null;
  expired?: boolean;
};

type CodexPanelProps = {
  active: boolean;
  busy: boolean;
  requestJson: RequestJson;
  readDeps: ReadJsonDeps;
  onStatusChange?: (status: CodexAuthStatus | null) => void;
};

function redactAccountId(accountId: string | null): string {
  if (!accountId) return "—";
  if (accountId.length <= 6) return accountId;
  return `…${accountId.slice(-6)}`;
}

function formatRelative(ts: number | null): string {
  if (!ts) return "—";
  const diff = ts - Date.now();
  const absMs = Math.abs(diff);
  const past = diff < 0;
  if (absMs < 60_000) return past ? "just now" : "in a few seconds";
  const mins = Math.floor(absMs / 60_000);
  if (mins < 60) return past ? `${mins}m ago` : `in ${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return past ? `${hrs}h ago` : `in ${hrs}h`;
  const days = Math.floor(hrs / 24);
  return past ? `${days}d ago` : `in ${days}d`;
}

function formatAbsolute(ts: number | null): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleString();
}

type PillModel = { label: string; variant: "good" | "bad" | "idle" | "warn" };

function pillFor(status: CodexAuthStatus | null): PillModel {
  if (!status || !status.connected) {
    return { label: "Disconnected", variant: "idle" };
  }
  if (status.expired) {
    return { label: "Expired", variant: "warn" };
  }
  return { label: "Connected", variant: "good" };
}

export function CodexPanel({
  active,
  busy,
  requestJson,
  readDeps,
  onStatusChange,
}: CodexPanelProps) {
  const [status, setStatus] = useState<CodexAuthStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [readError, setReadError] = useState<string | null>(null);

  const [paste, setPaste] = useState("");
  const [editing, setEditing] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const { confirm, dialogProps } = useConfirm();

  const refresh = useCallback(async () => {
    setLoading(true);
    const result = await fetchAdminJsonCore<CodexAuthStatus>(
      "/api/admin/auth/codex",
      readDeps,
      { toastError: false },
    );
    if (result.ok) {
      setStatus(result.data);
      setReadError(null);
      onStatusChange?.(result.data);
    } else {
      // Route not yet merged (Unit 2). Surface a disconnected state so the
      // panel still renders without console errors.
      if (result.status === 404) {
        setStatus({
          connected: false,
          accountId: null,
          expires: null,
          updatedAt: null,
        });
        setReadError(null);
        onStatusChange?.(null);
      } else {
        setReadError(result.error);
      }
    }
    setLoading(false);
  }, [readDeps, onStatusChange]);

  useEffect(() => {
    if (!active) return;
    void refresh();
  }, [active, refresh]);

  async function handleConnect(): Promise<void> {
    const raw = paste.trim();
    if (!raw) {
      setConnectError("Paste credentials before connecting.");
      return;
    }
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      setConnectError("Pasted content is not valid JSON.");
      return;
    }
    setConnectError(null);
    setNotice(null);
    const result = await requestJson<CodexAuthStatus>("/api/admin/auth/codex", {
      label: "Connect OpenAI Codex",
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      refreshAfter: false,
    });
    if (result.ok) {
      setPaste("");
      setEditing(false);
      setNotice(
        "Connected. Your next sandbox restore will use GPT-5.4 via OpenAI Codex.",
      );
      if (result.data) {
        setStatus(result.data);
        onStatusChange?.(result.data);
      } else {
        await refresh();
      }
    } else {
      setConnectError(result.error);
    }
  }

  async function handleDisconnect(): Promise<void> {
    const ok = await confirm({
      title: "Disconnect OpenAI Codex?",
      description:
        "This clears the stored credentials. The next sandbox restore will fall back to AI Gateway.",
      confirmLabel: "Disconnect",
      variant: "danger",
    });
    if (!ok) return;
    setConnectError(null);
    setNotice(null);
    const result = await requestJson("/api/admin/auth/codex", {
      label: "Disconnect OpenAI Codex",
      method: "DELETE",
      refreshAfter: false,
    });
    if (result.ok) {
      setStatus({
        connected: false,
        accountId: null,
        expires: null,
        updatedAt: null,
      });
      onStatusChange?.(null);
      setEditing(false);
      setPaste("");
    }
  }

  const pill = pillFor(status);
  const connected = Boolean(status?.connected);
  const showTextarea = !connected || editing;

  return (
    <section className="channel-card" data-channel="codex">
      <div className="channel-head">
        <div>
          <h3>OpenAI Codex</h3>
          <p className="muted-copy">
            {connected
              ? "Active provider for the next sandbox restore."
              : "Use a ChatGPT/Codex subscription instead of AI Gateway."}
          </p>
        </div>
        <ChannelPill variant={pill.variant}>{pill.label}</ChannelPill>
      </div>

      {readError ? <p className="error-banner">{readError}</p> : null}
      {notice ? <p className="success-copy">{notice}</p> : null}

      {loading && !status ? (
        <p className="muted-copy">Loading…</p>
      ) : connected && !editing ? (
        <div className="channel-connected-view">
          <div className="channel-detail-row">
            <span className="field-label">Account</span>
            <code className="inline-code">
              {redactAccountId(status?.accountId ?? null)}
            </code>
          </div>
          <div className="channel-detail-row">
            <span className="field-label">Expires</span>
            <code className="inline-code">
              {formatRelative(status?.expires ?? null)}
              {status?.expires
                ? ` · ${formatAbsolute(status.expires)}`
                : ""}
            </code>
          </div>
          <div className="channel-detail-row">
            <span className="field-label">Updated</span>
            <code className="inline-code">
              {formatRelative(status?.updatedAt ?? null)}
            </code>
          </div>
          <div className="inline-actions">
            <button
              type="button"
              className="button secondary"
              disabled={busy}
              onClick={() => {
                setConnectError(null);
                setNotice(null);
                setEditing(true);
              }}
            >
              Replace credentials
            </button>
            <button
              type="button"
              className="button ghost"
              disabled={busy}
              onClick={() => void handleDisconnect()}
            >
              Disconnect
            </button>
          </div>
        </div>
      ) : null}

      {showTextarea && !loading ? (
        <form
          className="channel-wizard"
          onSubmit={(e) => {
            e.preventDefault();
            void handleConnect();
          }}
        >
          <p className="channel-wizard-title">
            {connected ? "Replace credentials" : "Connect OpenAI Codex"}
          </p>
          <div className="stack">
            <span className="field-label">Credentials</span>
            <textarea
              className="text-input"
              rows={8}
              value={paste}
              onChange={(e) => setPaste(e.target.value)}
              placeholder={
                'Paste contents of ~/.codex/auth.json or an `openai-codex:default` entry from auth-profiles.json'
              }
              spellCheck={false}
              autoComplete="off"
              data-1p-ignore
              data-lpignore="true"
              data-form-type="other"
              style={{ fontFamily: "var(--font-geist-mono, ui-monospace, monospace)", minHeight: 160 }}
            />
          </div>
          {connectError ? (
            <p className="channel-validation-error">{connectError}</p>
          ) : null}
          <div className="inline-actions">
            <button
              type="submit"
              className="button primary"
              disabled={busy || paste.trim().length === 0}
            >
              {connected ? "Replace" : "Connect with pasted credentials"}
            </button>
            {connected && editing ? (
              <button
                type="button"
                className="button ghost"
                onClick={() => {
                  setEditing(false);
                  setPaste("");
                  setConnectError(null);
                }}
              >
                Cancel
              </button>
            ) : null}
          </div>
        </form>
      ) : null}

      <ConfirmDialog {...dialogProps} />
    </section>
  );
}
