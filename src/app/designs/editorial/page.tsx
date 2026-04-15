"use client";

import React, { useState } from 'react';

export default function EditorialDesign() {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="editorial-layout">
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
          --font-geist-sans: 'Geist Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
          --font-geist-mono: 'Geist Mono', SFMono-Regular, Consolas, 'Liberation Mono', Menlo, monospace;
        }

        .editorial-layout {
          min-height: 100vh;
          background: var(--background);
          color: var(--foreground);
          font-family: var(--font-geist-sans);
          -webkit-font-smoothing: antialiased;
          line-height: 1.5;
        }

        .container {
          max-width: 960px;
          margin: 0 auto;
          padding: 0 24px;
        }

        .header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 24px 0;
        }

        .brand-cluster {
          display: flex;
          align-items: center;
          gap: 12px;
        }

        .brand-name {
          font-weight: 600;
          font-size: 14px;
          letter-spacing: -0.01em;
        }

        .deployment-url {
          color: var(--foreground-subtle);
          font-family: var(--font-geist-mono);
          font-size: 13px;
        }

        .user-pill {
          display: flex;
          align-items: center;
          gap: 8px;
          border: 1px solid var(--border);
          border-radius: 999px;
          padding: 4px 12px 4px 6px;
          font-family: var(--font-geist-mono);
          font-size: 11px;
          color: var(--foreground-muted);
        }

        .avatar {
          width: 18px;
          height: 18px;
          border-radius: 50%;
          background: var(--foreground);
        }

        .hr {
          height: 1px;
          background: var(--border);
          width: 100%;
          margin: 0;
          border: none;
        }

        .section {
          padding: 80px 0;
        }

        .section-header {
          margin-bottom: 48px;
        }

        .eyebrow {
          font-family: var(--font-geist-mono);
          font-size: 11px;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          color: var(--foreground-subtle);
          margin-bottom: 16px;
          display: block;
          font-weight: 500;
        }

        h1 {
          font-size: clamp(1.75rem, 3.5vw, 2.5rem);
          font-weight: 700;
          line-height: 1.1;
          letter-spacing: -0.02em;
          margin: 0 0 24px 0;
        }

        h2 {
          font-size: 1.25rem;
          font-weight: 600;
          line-height: 1.2;
          letter-spacing: -0.02em;
          margin: 0;
        }

        .status-strip {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 24px 0;
          font-family: var(--font-geist-mono);
          font-size: 12px;
        }

        .status-left {
          display: flex;
          align-items: center;
          gap: 24px;
        }

        .status-indicator {
          display: flex;
          align-items: center;
          gap: 8px;
          color: var(--success);
          text-transform: uppercase;
        }

        .dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background: var(--success);
          box-shadow: 0 0 0 0 rgba(69, 165, 87, 0.4);
          animation: pulse 2s infinite;
        }

        @keyframes pulse {
          0% { box-shadow: 0 0 0 0 rgba(69, 165, 87, 0.4); }
          70% { box-shadow: 0 0 0 6px rgba(69, 165, 87, 0); }
          100% { box-shadow: 0 0 0 0 rgba(69, 165, 87, 0); }
        }

        .sandbox-id {
          color: var(--foreground-muted);
        }

        .status-metrics {
          display: flex;
          gap: 32px;
          color: var(--foreground-muted);
        }

        .metric-value {
          color: var(--foreground);
        }

        .actions {
          display: flex;
          gap: 12px;
        }

        .btn {
          background: transparent;
          border: 1px solid var(--border);
          color: var(--foreground);
          font-family: var(--font-geist-sans);
          font-size: 0.875rem;
          font-weight: 500;
          padding: 0 16px;
          height: 32px;
          border-radius: var(--radius);
          cursor: pointer;
          transition: all 0.15s ease;
          display: inline-flex;
          align-items: center;
          justify-content: center;
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
          border-color: #fff;
        }

        .def-list {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
          gap: 1px;
          background: var(--border);
          border: 1px solid var(--border);
        }

        .def-item {
          background: var(--background);
          padding: 24px;
          display: flex;
          flex-direction: column;
          gap: 8px;
        }

        .def-term {
          font-family: var(--font-geist-mono);
          font-size: 11px;
          color: var(--foreground-muted);
        }

        .def-desc {
          font-family: var(--font-geist-mono);
          font-size: 13px;
          color: var(--foreground);
          margin: 0;
        }

        .data-table {
          width: 100%;
          border-collapse: collapse;
          font-family: var(--font-geist-mono);
          font-size: 12px;
        }

        .data-table th, .data-table td {
          padding: 16px 0;
          text-align: left;
          border-bottom: 1px solid var(--border);
        }

        .data-table th {
          color: var(--foreground-subtle);
          font-weight: normal;
        }

        .data-table tr:last-child td {
          border-bottom: none;
        }

        .status-cell {
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .status-dot {
          width: 6px;
          height: 6px;
          border-radius: 50%;
        }

        .status-dot.green { background: var(--success); }
        .status-dot.yellow { background: var(--warning); }
        .status-dot.gray { background: var(--foreground-subtle); }

        .terminal-block {
          border: 1px solid var(--border);
          background: var(--background-elevated);
          padding: 24px;
          font-family: var(--font-geist-mono);
          font-size: 12px;
          display: flex;
          justify-content: space-between;
          align-items: center;
        }

        .terminal-prompt {
          color: var(--foreground-muted);
          margin-right: 12px;
        }

        .log-table {
          width: 100%;
          border-collapse: collapse;
          font-family: var(--font-geist-mono);
          font-size: 12px;
        }

        .log-table td {
          padding: 12px 0;
          border-bottom: 1px solid var(--border);
          vertical-align: top;
        }

        .log-table tr:last-child td {
          border-bottom: none;
        }

        .log-time { color: var(--foreground-subtle); width: 140px; }
        .log-level { width: 80px; }
        .log-level.info { color: var(--info); }
        .log-level.warn { color: var(--warning); }
        .log-level.error { color: var(--danger); }
        .log-msg { color: var(--foreground); }

        .footer {
          padding: 48px 0;
          display: flex;
          justify-content: space-between;
          font-family: var(--font-geist-mono);
          font-size: 11px;
          color: var(--foreground-muted);
        }

        .footer-item {
          display: flex;
          gap: 8px;
        }

        .footer-val {
          color: var(--foreground);
        }

        @media (max-width: 768px) {
          .status-strip {
            flex-direction: column;
            align-items: flex-start;
            gap: 24px;
          }
          .actions {
            width: 100%;
          }
          .actions .btn {
            flex: 1;
          }
          .footer {
            flex-direction: column;
            gap: 12px;
          }
          .section-header-row {
            flex-direction: column;
            align-items: flex-start !important;
            gap: 16px;
          }
        }
      `}} />

      <div className="container">
        <header className="header">
          <div className="brand-cluster">
            <img src="/openclaw-logo.svg" width={24} height={24} alt="OpenClaw" />
            <span className="brand-name">OpenClaw</span>
            <span className="deployment-url">oc.acme.vercel.app</span>
          </div>
          <div className="user-pill">
            <div className="avatar"></div>
            <span>admin</span>
          </div>
        </header>
      </div>

      <hr className="hr" />

      <div className="container">
        <div className="section" style={{ paddingTop: '100px', paddingBottom: '40px' }}>
          <h1>OpenClaw</h1>
          <div className="status-strip">
            <div className="status-left">
              <div className="status-indicator">
                <div className="dot"></div>
                RUNNING
              </div>
              <div className="sandbox-id">oc-prj-rmayazjosjflloz94grssevda4yr</div>
            </div>
            <div className="status-metrics">
              <div>Uptime <span className="metric-value">14m 32s</span></div>
              <div>Timeout <span className="metric-value">15m 28s</span></div>
            </div>
            <div className="actions">
              <button className="btn">Snapshot</button>
              <button className="btn" style={{ color: 'var(--danger)', borderColor: 'var(--border)' }}>Stop</button>
              <button className="btn btn-primary">Restore</button>
            </div>
          </div>
        </div>
      </div>

      <hr className="hr" />

      <div className="container">
        <section className="section">
          <div className="section-header">
            <span className="eyebrow">Metrics</span>
            <h2>Lifecycle</h2>
          </div>
          <div className="def-list">
            <div className="def-item">
              <span className="def-term">sandboxCreateMs</span>
              <p className="def-desc">842</p>
            </div>
            <div className="def-item">
              <span className="def-term">assetSyncMs</span>
              <p className="def-desc">310</p>
            </div>
            <div className="def-item">
              <span className="def-term">startupScriptMs</span>
              <p className="def-desc">1_204</p>
            </div>
            <div className="def-item">
              <span className="def-term">localReadyMs</span>
              <p className="def-desc">2_301</p>
            </div>
            <div className="def-item">
              <span className="def-term">publicReadyMs</span>
              <p className="def-desc">3_110</p>
            </div>
            <div className="def-item">
              <span className="def-term">totalMs</span>
              <p className="def-desc">7_767</p>
            </div>
            <div className="def-item">
              <span className="def-term">vcpus</span>
              <p className="def-desc">2</p>
            </div>
            <div className="def-item">
              <span className="def-term">recordedAt</span>
              <p className="def-desc">14m ago</p>
            </div>
          </div>
        </section>
      </div>

      <hr className="hr" />

      <div className="container">
        <section className="section">
          <div className="section-header">
            <span className="eyebrow">Integrations</span>
            <h2>Channels</h2>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Provider</th>
                  <th>Status</th>
                  <th>Webhook URL Preview</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Slack</td>
                  <td>
                    <div className="status-cell">
                      <div className="status-dot green"></div>
                      Connected
                    </div>
                  </td>
                  <td style={{ color: 'var(--foreground-muted)' }}>https://hooks.slack.com/services/T0...</td>
                </tr>
                <tr>
                  <td>Telegram</td>
                  <td>
                    <div className="status-cell">
                      <div className="status-dot green"></div>
                      Connected
                    </div>
                  </td>
                  <td style={{ color: 'var(--foreground-muted)' }}>https://api.telegram.org/bot123456...</td>
                </tr>
                <tr>
                  <td style={{ color: 'var(--foreground-muted)' }}>WhatsApp</td>
                  <td>
                    <div className="status-cell" style={{ color: 'var(--foreground-muted)' }}>
                      <div className="status-dot gray"></div>
                      Not Configured
                    </div>
                  </td>
                  <td style={{ color: 'var(--foreground-subtle)' }}>—</td>
                </tr>
                <tr>
                  <td>Discord</td>
                  <td>
                    <div className="status-cell" style={{ color: 'var(--warning)' }}>
                      <div className="status-dot yellow"></div>
                      Warning
                    </div>
                  </td>
                  <td style={{ color: 'var(--foreground-muted)' }}>https://discord.com/api/webhooks/...</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      </div>

      <hr className="hr" />

      <div className="container">
        <section className="section">
          <div className="section-header section-header-row" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
            <div>
              <span className="eyebrow">Security</span>
              <h2>Firewall</h2>
            </div>
            <div style={{ display: 'flex', gap: '24px', fontFamily: 'var(--font-geist-mono)', fontSize: '11px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ color: 'var(--foreground-muted)' }}>Mode:</span>
                <span style={{ border: '1px solid var(--border)', borderRadius: '999px', padding: '2px 8px' }}>enforcing</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ color: 'var(--foreground-muted)' }}>Domains:</span>
                <span>6</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ color: 'var(--foreground-muted)' }}>wouldBlock:</span>
                <span style={{ color: 'var(--warning)' }}>2</span>
              </div>
            </div>
          </div>
          <div className="def-list" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))' }}>
            <div className="def-item"><span className="def-desc">ai-gateway.vercel.sh</span></div>
            <div className="def-item"><span className="def-desc">api.openai.com</span></div>
            <div className="def-item"><span className="def-desc">api.anthropic.com</span></div>
            <div className="def-item"><span className="def-desc">github.com</span></div>
            <div className="def-item"><span className="def-desc">registry.npmjs.org</span></div>
            <div className="def-item"><span className="def-desc">pypi.org</span></div>
          </div>
        </section>
      </div>

      <hr className="hr" />

      <div className="container">
        <section className="section">
          <div className="section-header">
            <span className="eyebrow">Access</span>
            <h2>Terminal</h2>
          </div>
          <div className="terminal-block">
            <div>
              <span className="terminal-prompt">$</span>
              <span>npx sandbox connect oc-prj-rmayazjosjflloz94grssevda4yr</span>
            </div>
            <button className="btn" onClick={handleCopy} style={{ height: '28px', padding: '0 12px', fontSize: '11px', fontFamily: 'var(--font-geist-mono)' }}>
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        </section>
      </div>

      <hr className="hr" />

      <div className="container">
        <section className="section">
          <div className="section-header">
            <span className="eyebrow">Observability</span>
            <h2>Logs</h2>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table className="log-table">
              <tbody>
                <tr>
                  <td className="log-time">14:32:01.045</td>
                  <td className="log-level info">info</td>
                  <td className="log-msg">watchdog.run_completed</td>
                </tr>
                <tr>
                  <td className="log-time">14:31:58.212</td>
                  <td className="log-level info">info</td>
                  <td className="log-msg">gateway.ready</td>
                </tr>
                <tr>
                  <td className="log-time">14:30:11.890</td>
                  <td className="log-level info">info</td>
                  <td className="log-msg">channel.slack.delivered</td>
                </tr>
                <tr>
                  <td className="log-time">14:28:45.331</td>
                  <td className="log-level warn">warn</td>
                  <td className="log-msg">firewall.policy.applied</td>
                </tr>
                <tr>
                  <td className="log-time">14:15:02.100</td>
                  <td className="log-level info">info</td>
                  <td className="log-msg">sandbox.snapshot.saved</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      </div>

      <hr className="hr" />

      <div className="container">
        <footer className="footer">
          <div className="footer-item">
            <span>Store backend</span>
            <span className="footer-val">upstash</span>
          </div>
          <div className="footer-item">
            <span>Auth mode</span>
            <span className="footer-val">admin-secret</span>
          </div>
          <div className="footer-item">
            <span>AI Gateway auth</span>
            <span className="footer-val">oidc</span>
          </div>
          <div className="footer-item">
            <span>Deployment region</span>
            <span className="footer-val">iad1</span>
          </div>
        </footer>
      </div>
    </div>
  );
}
