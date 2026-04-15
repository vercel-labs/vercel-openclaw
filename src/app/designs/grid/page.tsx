"use client";

import React, { useState } from 'react';

export default function GridDesign() {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="container">
      <style dangerouslySetInnerHTML={{ __html: `
        :root {
          --background: #000;
          --background-elevated: #0a0a0a;
          --background-hover: #111;
          --foreground: #ededed;
          --foreground-muted: #888;
          --foreground-subtle: #666;
          --border: rgba(255,255,255,0.08);
          --border-strong: rgba(255,255,255,0.14);
          --success: #45a557;
          --warning: #f5a623;
          --danger: #e5484d;
          --info: #0070f3;
          --radius: 8px;
          --font-sans: var(--font-geist-sans), -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
          --font-mono: var(--font-geist-mono), ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        }
        * {
          box-sizing: border-box;
          margin: 0;
          padding: 0;
        }
        body {
          background-color: var(--background);
          color: var(--foreground);
          font-family: var(--font-sans);
          -webkit-font-smoothing: antialiased;
          line-height: 1.5;
          font-size: 0.875rem;
        }
        .container {
          max-width: 1440px;
          margin: 0 auto;
          padding: 32px;
          display: flex;
          flex-direction: column;
          gap: 24px;
        }
        header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding-bottom: 24px;
          border-bottom: 1px solid var(--border);
        }
        .header-left {
          display: flex;
          align-items: center;
          gap: 12px;
        }
        .logo-text {
          font-size: 1.25rem;
          font-weight: 600;
          letter-spacing: -0.02em;
        }
        .header-url {
          color: var(--foreground-muted);
          font-size: 0.875rem;
        }
        .header-right {
          display: flex;
          align-items: center;
        }
        .avatar-pill {
          border: 1px solid var(--border);
          border-radius: 9999px;
          padding: 4px 12px;
          font-family: var(--font-mono);
          font-size: 11px;
          color: var(--foreground-subtle);
          text-transform: uppercase;
          letter-spacing: 0.08em;
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .avatar-pill::before {
          content: "";
          display: block;
          width: 16px;
          height: 16px;
          border-radius: 50%;
          background: linear-gradient(135deg, #333, #111);
          border: 1px solid var(--border);
        }
        
        .hero-strip {
          display: flex;
          align-items: center;
          justify-content: space-between;
          background: var(--background-elevated);
          border: 1px solid var(--border);
          border-radius: var(--radius);
          padding: 20px 24px;
        }
        .hero-info {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .hero-status-row {
          display: flex;
          align-items: center;
          gap: 12px;
        }
        .status-badge {
          display: flex;
          align-items: center;
          gap: 8px;
          font-family: var(--font-mono);
          font-size: 11px;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          color: var(--foreground);
        }
        .status-dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background-color: var(--success);
          box-shadow: 0 0 8px rgba(69, 165, 87, 0.4);
        }
        .hero-id {
          font-family: var(--font-mono);
          font-size: 13px;
          color: var(--foreground-muted);
        }
        .hero-meta {
          display: flex;
          align-items: center;
          gap: 16px;
          font-size: 0.875rem;
          color: var(--foreground-subtle);
        }
        .hero-actions {
          display: flex;
          align-items: center;
          gap: 12px;
        }
        .btn {
          background: transparent;
          border: 1px solid var(--border);
          color: var(--foreground);
          padding: 0 16px;
          height: 36px;
          border-radius: var(--radius);
          font-size: 0.875rem;
          font-weight: 500;
          cursor: pointer;
          transition: all 150ms ease;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          font-family: var(--font-sans);
        }
        .btn:hover {
          background: var(--background-hover);
          border-color: var(--border-strong);
        }
        .btn-primary {
          background: var(--foreground);
          color: var(--background);
          border-color: var(--foreground);
        }
        .btn-primary:hover {
          background: #fff;
          color: var(--background);
        }
        
        .grid-12 {
          display: grid;
          grid-template-columns: repeat(12, 1fr);
          gap: 24px;
        }
        .card {
          background: var(--background-elevated);
          border: 1px solid var(--border);
          border-radius: var(--radius);
          display: flex;
          flex-direction: column;
        }
        .card-header {
          padding: 16px 20px;
          border-bottom: 1px solid var(--border);
          display: flex;
          align-items: center;
          justify-content: space-between;
        }
        .eyebrow {
          font-family: var(--font-mono);
          font-size: 11px;
          font-weight: 500;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          color: var(--foreground-subtle);
        }
        .card-content {
          padding: 20px;
          display: flex;
          flex-direction: column;
          flex: 1;
        }
        
        /* Lifecycle */
        .metrics-list {
          display: flex;
          flex-direction: column;
        }
        .metric-row {
          display: flex;
          justify-content: space-between;
          padding: 8px 0;
          border-bottom: 1px solid var(--border);
          font-family: var(--font-mono);
          font-size: 12px;
        }
        .metric-row:last-child {
          border-bottom: none;
          padding-bottom: 0;
        }
        .metric-row.total {
          color: var(--foreground);
          font-weight: 600;
          margin-top: 4px;
          border-top: 1px solid var(--border-strong);
          border-bottom: none;
          padding-top: 12px;
        }
        .metric-label {
          color: var(--foreground-muted);
        }
        .metric-val {
          color: var(--foreground);
        }
        .metric-meta {
          margin-top: 16px;
          display: flex;
          justify-content: space-between;
          font-size: 12px;
          color: var(--foreground-subtle);
        }
        
        /* Channels */
        .channel-list {
          display: flex;
          flex-direction: column;
          gap: 12px;
        }
        .channel-item {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 12px;
          border: 1px solid var(--border);
          border-radius: 6px;
        }
        .channel-info {
          display: flex;
          align-items: center;
          gap: 12px;
        }
        .channel-icon {
          width: 16px;
          height: 16px;
          color: var(--foreground-muted);
        }
        .channel-name {
          font-weight: 500;
          font-size: 0.875rem;
        }
        .channel-status {
          font-family: var(--font-mono);
          font-size: 11px;
          text-transform: uppercase;
        }
        .status-green { color: var(--success); }
        .status-yellow { color: var(--warning); }
        .status-muted { color: var(--foreground-subtle); }
        .webhook-preview {
          margin-top: auto;
          padding-top: 16px;
          font-family: var(--font-mono);
          font-size: 11px;
          color: var(--foreground-subtle);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        
        /* Firewall */
        .fw-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 16px;
        }
        .pill {
          border: 1px solid var(--border);
          border-radius: 9999px;
          padding: 2px 8px;
          font-family: var(--font-mono);
          font-size: 11px;
          color: var(--foreground-subtle);
          text-transform: uppercase;
        }
        .domain-list {
          display: flex;
          flex-direction: column;
          gap: 8px;
          font-family: var(--font-mono);
          font-size: 12px;
          color: var(--foreground-muted);
        }
        .domain-item {
          display: flex;
          align-items: center;
        }
        .domain-item::before {
          content: "✓";
          color: var(--success);
          margin-right: 8px;
          font-size: 10px;
        }
        .fw-stats {
          margin-top: auto;
          padding-top: 16px;
          display: flex;
          justify-content: space-between;
          font-size: 12px;
          color: var(--foreground-subtle);
        }
        
        /* Terminal */
        .cli-block {
          background: #000;
          border: 1px solid var(--border);
          border-radius: 6px;
          padding: 16px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          font-family: var(--font-mono);
          font-size: 13px;
        }
        .cli-text {
          color: var(--foreground);
        }
        .cli-prompt {
          color: var(--foreground-subtle);
          margin-right: 12px;
          user-select: none;
        }
        .copy-btn {
          background: transparent;
          border: none;
          color: var(--foreground-muted);
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 4px;
          border-radius: 4px;
        }
        .copy-btn:hover {
          background: var(--background-hover);
          color: var(--foreground);
        }
        
        /* Logs */
        .logs-table {
          width: 100%;
          border-collapse: collapse;
          font-family: var(--font-mono);
          font-size: 12px;
        }
        .logs-table th {
          text-align: left;
          padding: 12px 20px;
          border-bottom: 1px solid var(--border);
          color: var(--foreground-subtle);
          font-weight: 500;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          font-size: 11px;
        }
        .logs-table td {
          padding: 12px 20px;
          border-bottom: 1px solid var(--border);
          color: var(--foreground-muted);
        }
        .logs-table tr:last-child td {
          border-bottom: none;
        }
        .log-level-info { color: var(--info); }
        .log-level-warn { color: var(--warning); }
        .log-level-error { color: var(--danger); }
        .log-message { color: var(--foreground); }
        
        /* Footer */
        footer {
          margin-top: 24px;
          padding-top: 24px;
          border-top: 1px solid var(--border);
          display: flex;
          justify-content: space-between;
          font-family: var(--font-mono);
          font-size: 11px;
          color: var(--foreground-subtle);
          text-transform: uppercase;
          letter-spacing: 0.08em;
        }
        .footer-items {
          display: flex;
          gap: 24px;
        }
        
        @media (max-width: 1024px) {
          .grid-12 {
            display: flex;
            flex-direction: column;
          }
        }
      `}} />

      <header>
        <div className="header-left">
          <img src="/openclaw-logo.svg" width={24} height={24} alt="OpenClaw" />
          <span className="logo-text">OpenClaw</span>
          <span className="header-url">oc.acme.vercel.app</span>
        </div>
        <div className="header-right">
          <div className="avatar-pill">admin</div>
        </div>
      </header>

      <div className="hero-strip">
        <div className="hero-info">
          <div className="hero-status-row">
            <div className="status-badge">
              <div className="status-dot"></div>
              RUNNING
            </div>
            <span className="hero-id">oc-prj-rmayazjosjflloz94grssevda4yr</span>
          </div>
          <div className="hero-meta">
            <span>Uptime: 14m 32s</span>
            <span>Timeout remaining: 15m 28s</span>
          </div>
        </div>
        <div className="hero-actions">
          <button className="btn">Snapshot</button>
          <button className="btn">Stop</button>
          <button className="btn btn-primary">Restore</button>
        </div>
      </div>

      <div className="grid-12">
        <div className="card" style={{ gridColumn: 'span 4' }}>
          <div className="card-header">
            <span className="eyebrow">Lifecycle Metrics</span>
          </div>
          <div className="card-content">
            <div className="metrics-list">
              <div className="metric-row">
                <span className="metric-label">sandboxCreateMs</span>
                <span className="metric-val">842</span>
              </div>
              <div className="metric-row">
                <span className="metric-label">assetSyncMs</span>
                <span className="metric-val">310</span>
              </div>
              <div className="metric-row">
                <span className="metric-label">startupScriptMs</span>
                <span className="metric-val">1_204</span>
              </div>
              <div className="metric-row">
                <span className="metric-label">localReadyMs</span>
                <span className="metric-val">2_301</span>
              </div>
              <div className="metric-row">
                <span className="metric-label">publicReadyMs</span>
                <span className="metric-val">3_110</span>
              </div>
              <div className="metric-row total">
                <span className="metric-label">totalMs</span>
                <span className="metric-val">7_767</span>
              </div>
            </div>
            <div className="metric-meta">
              <span>vcpus=2</span>
              <span>recorded 2m ago</span>
            </div>
          </div>
        </div>

        <div className="card" style={{ gridColumn: 'span 4' }}>
          <div className="card-header">
            <span className="eyebrow">Channels</span>
          </div>
          <div className="card-content">
            <div className="channel-list">
              <div className="channel-item">
                <div className="channel-info">
                  <svg className="channel-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><line x1="10" y1="9" x2="8" y2="9"></line></svg>
                  <span className="channel-name">Slack</span>
                </div>
                <span className="channel-status status-green">Connected</span>
              </div>
              <div className="channel-item">
                <div className="channel-info">
                  <svg className="channel-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M22 2L11 13"></path><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>
                  <span className="channel-name">Telegram</span>
                </div>
                <span className="channel-status status-green">Connected</span>
              </div>
              <div className="channel-item">
                <div className="channel-info">
                  <svg className="channel-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path></svg>
                  <span className="channel-name">WhatsApp</span>
                </div>
                <span className="channel-status status-muted">Not Configured</span>
              </div>
              <div className="channel-item">
                <div className="channel-info">
                  <svg className="channel-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>
                  <span className="channel-name">Discord</span>
                </div>
                <span className="channel-status status-yellow">Warning</span>
              </div>
            </div>
            <div className="webhook-preview">
              URL: https://oc.acme.vercel.app/api/webhook/...
            </div>
          </div>
        </div>

        <div className="card" style={{ gridColumn: 'span 4' }}>
          <div className="card-header">
            <span className="eyebrow">Firewall</span>
          </div>
          <div className="card-content">
            <div className="fw-header">
              <span className="pill">Learning Mode</span>
              <span style={{ fontSize: '12px', color: 'var(--foreground-muted)' }}>6 Domains</span>
            </div>
            <div className="domain-list">
              <div className="domain-item">ai-gateway.vercel.sh</div>
              <div className="domain-item">api.openai.com</div>
              <div className="domain-item">api.anthropic.com</div>
              <div className="domain-item">github.com</div>
              <div className="domain-item">registry.npmjs.org</div>
              <div className="domain-item">pypi.org</div>
            </div>
            <div className="fw-stats">
              <span>wouldBlock count</span>
              <span style={{ color: 'var(--warning)', fontFamily: 'var(--font-mono)' }}>2</span>
            </div>
          </div>
        </div>

        <div className="card" style={{ gridColumn: 'span 12' }}>
          <div className="card-header">
            <span className="eyebrow">Terminal</span>
          </div>
          <div className="card-content" style={{ padding: '16px' }}>
            <div className="cli-block">
              <div>
                <span className="cli-prompt">$</span>
                <span className="cli-text">npx sandbox connect oc-prj-rmayazjosjflloz94grssevda4yr</span>
              </div>
              <button className="copy-btn" onClick={handleCopy} aria-label="Copy command">
                {copied ? (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
                ) : (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                )}
              </button>
            </div>
          </div>
        </div>

        <div className="card" style={{ gridColumn: 'span 12' }}>
          <div className="card-header">
            <span className="eyebrow">Logs</span>
          </div>
          <table className="logs-table">
            <thead>
              <tr>
                <th style={{ width: '150px' }}>Timestamp</th>
                <th style={{ width: '100px' }}>Level</th>
                <th>Message</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>10:14:02.123</td>
                <td className="log-level-info">INFO</td>
                <td className="log-message">watchdog.run_completed</td>
              </tr>
              <tr>
                <td>10:14:05.441</td>
                <td className="log-level-info">INFO</td>
                <td className="log-message">gateway.ready</td>
              </tr>
              <tr>
                <td>10:14:12.890</td>
                <td className="log-level-info">INFO</td>
                <td className="log-message">channel.slack.delivered</td>
              </tr>
              <tr>
                <td>10:15:01.002</td>
                <td className="log-level-warn">WARN</td>
                <td className="log-message">firewall.policy.applied</td>
              </tr>
              <tr>
                <td>10:15:30.555</td>
                <td className="log-level-info">INFO</td>
                <td className="log-message">sandbox.snapshot.saved</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <footer>
        <div className="footer-items">
          <span>STORE: UPSTASH</span>
          <span>AUTH: ADMIN-SECRET</span>
          <span>AI GATEWAY: OIDC</span>
        </div>
        <div>
          <span>REGION: IAD1</span>
        </div>
      </footer>
    </div>
  );
}
