"use client";

import { redirect } from "next/navigation";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { StatusPanel } from "@/components/panels/status-panel";
import { FirewallPanel } from "@/components/panels/firewall-panel";
import { ChannelsPanel } from "@/components/panels/channels-panel";
import { SshPanel } from "@/components/panels/ssh-panel";
import { LogsPanel } from "@/components/panels/logs-panel";
import { SnapshotsPanel } from "@/components/panels/snapshots-panel";
import {
  STATUS_UNINITIALIZED,
  STATUS_CREATING,
  STATUS_SETUP,
  STATUS_RUNNING,
  STATUS_STOPPED,
  STATUS_ERROR,
  STATUS_RESTORING,
  STATUS_BOOTING,
  STATUS_FIREWALL_DISABLED,
  STATUS_FIREWALL_LEARNING,
  STATUS_FIREWALL_ENFORCING,
  STATUS_CHANNELS_CONFIGURED,
  NOOP_RUN_ACTION,
  NOOP_REQUEST_JSON,
  NOOP_REFRESH,
  MOCK_READ_DEPS,
} from "./mock-data";

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section style={{ marginBottom: 48 }}>
      <h2
        style={{
          margin: "0 0 16px",
          fontSize: 20,
          fontWeight: 600,
          color: "var(--foreground)",
          borderBottom: "1px solid var(--border)",
          paddingBottom: 8,
        }}
      >
        {title}
      </h2>
      {children}
    </section>
  );
}

function Variant({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ marginBottom: 32 }}>
      <h3
        style={{
          margin: "0 0 12px",
          fontSize: 13,
          fontWeight: 500,
          color: "var(--foreground-muted)",
          fontFamily: "var(--font-geist-mono)",
          textTransform: "uppercase",
          letterSpacing: "0.05em",
        }}
      >
        {label}
      </h3>
      <div
        style={{
          border: "1px solid var(--border)",
          borderRadius: 12,
          overflow: "hidden",
        }}
      >
        {children}
      </div>
    </div>
  );
}

export default function DevPanelsPage() {
  if (process.env.NODE_ENV !== "development") {
    redirect("/");
  }

  return (
    <div
      style={{
        maxWidth: 1200,
        margin: "0 auto",
        padding: "24px 24px 120px",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 32,
        }}
      >
        <h1
          style={{
            margin: 0,
            fontSize: 24,
            fontWeight: 600,
            color: "var(--foreground)",
          }}
        >
          Panel Gallery
        </h1>
        <ThemeToggle />
      </div>

      {/* ── StatusPanel ── */}
      <Section title="StatusPanel">
        <Variant label="Uninitialized">
          <StatusPanel
            status={STATUS_UNINITIALIZED}
            busy={false}
            pendingAction={null}
            runAction={NOOP_RUN_ACTION}
          />
        </Variant>
        <Variant label="Creating">
          <StatusPanel
            status={STATUS_CREATING}
            busy={true}
            pendingAction="Create Sandbox"
            runAction={NOOP_RUN_ACTION}
          />
        </Variant>
        <Variant label="Setup (installing)">
          <StatusPanel
            status={STATUS_SETUP}
            busy={true}
            pendingAction="Create Sandbox"
            runAction={NOOP_RUN_ACTION}
          />
        </Variant>
        <Variant label="Running">
          <StatusPanel
            status={STATUS_RUNNING}
            busy={false}
            pendingAction={null}
            runAction={NOOP_RUN_ACTION}
          />
        </Variant>
        <Variant label="Restoring">
          <StatusPanel
            status={STATUS_RESTORING}
            busy={true}
            pendingAction="Start Sandbox"
            runAction={NOOP_RUN_ACTION}
          />
        </Variant>
        <Variant label="Booting">
          <StatusPanel
            status={STATUS_BOOTING}
            busy={true}
            pendingAction="Start Sandbox"
            runAction={NOOP_RUN_ACTION}
          />
        </Variant>
        <Variant label="Stopped">
          <StatusPanel
            status={STATUS_STOPPED}
            busy={false}
            pendingAction={null}
            runAction={NOOP_RUN_ACTION}
          />
        </Variant>
        <Variant label="Error">
          <StatusPanel
            status={STATUS_ERROR}
            busy={false}
            pendingAction={null}
            runAction={NOOP_RUN_ACTION}
          />
        </Variant>
      </Section>

      {/* ── FirewallPanel ── */}
      <Section title="FirewallPanel">
        <Variant label="Disabled">
          <FirewallPanel
            active={true}
            status={STATUS_FIREWALL_DISABLED}
            busy={false}
            requestJson={NOOP_REQUEST_JSON}
            refresh={NOOP_REFRESH}
            readDeps={MOCK_READ_DEPS}
          />
        </Variant>
        <Variant label="Learning (with domains)">
          <FirewallPanel
            active={true}
            status={STATUS_FIREWALL_LEARNING}
            busy={false}
            requestJson={NOOP_REQUEST_JSON}
            refresh={NOOP_REFRESH}
            readDeps={MOCK_READ_DEPS}
          />
        </Variant>
        <Variant label="Enforcing">
          <FirewallPanel
            active={true}
            status={STATUS_FIREWALL_ENFORCING}
            busy={false}
            requestJson={NOOP_REQUEST_JSON}
            refresh={NOOP_REFRESH}
            readDeps={MOCK_READ_DEPS}
          />
        </Variant>
      </Section>

      {/* ── ChannelsPanel ── */}
      <Section title="ChannelsPanel">
        <Variant label="Unconfigured (preflight fetch will fail)">
          <ChannelsPanel
            active={true}
            status={STATUS_RUNNING}
            busy={false}
            runAction={NOOP_RUN_ACTION}
            requestJson={NOOP_REQUEST_JSON}
            refresh={NOOP_REFRESH}
          />
        </Variant>
        <Variant label="All channels configured">
          <ChannelsPanel
            active={false}
            status={STATUS_CHANNELS_CONFIGURED}
            busy={false}
            runAction={NOOP_RUN_ACTION}
            requestJson={NOOP_REQUEST_JSON}
            refresh={NOOP_REFRESH}
          />
        </Variant>
      </Section>

      {/* ── SshPanel (Terminal) ── */}
      <Section title="SshPanel (Terminal)">
        <Variant label="Running">
          <SshPanel
            status={STATUS_RUNNING}
            busy={false}
            requestJson={NOOP_REQUEST_JSON}
          />
        </Variant>
        <Variant label="Stopped">
          <SshPanel
            status={STATUS_STOPPED}
            busy={false}
            requestJson={NOOP_REQUEST_JSON}
          />
        </Variant>
      </Section>

      {/* ── LogsPanel ── */}
      <Section title="LogsPanel">
        <Variant label="Running (with mock logs)">
          <LogsPanel
            active={true}
            status={STATUS_RUNNING}
            readDeps={MOCK_READ_DEPS}
          />
        </Variant>
      </Section>

      {/* ── SnapshotsPanel ── */}
      <Section title="SnapshotsPanel">
        <Variant label="Running (with mock snapshots)">
          <SnapshotsPanel
            active={true}
            status={STATUS_RUNNING}
            busy={false}
            runAction={NOOP_RUN_ACTION}
            requestJson={NOOP_REQUEST_JSON}
            readDeps={MOCK_READ_DEPS}
          />
        </Variant>
        <Variant label="Uninitialized (no danger zone)">
          <SnapshotsPanel
            active={true}
            status={STATUS_UNINITIALIZED}
            busy={false}
            runAction={NOOP_RUN_ACTION}
            requestJson={NOOP_REQUEST_JSON}
            readDeps={MOCK_READ_DEPS}
          />
        </Variant>
      </Section>
    </div>
  );
}
