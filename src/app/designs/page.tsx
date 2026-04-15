import Link from "next/link";

const VARIATIONS = [
  {
    slug: "grid",
    label: "Grid",
    blurb:
      "Vercel Dashboard-style 12-column card grid. Conservative, tabular, Geist Mono eyebrows on every card.",
  },
  {
    slug: "editorial",
    label: "Editorial",
    blurb:
      "Geist.dev-inspired long-form document. Oversized hero, hairline rules, minimal boxes, typography-led.",
  },
  {
    slug: "command",
    label: "Command",
    blurb:
      "Linear-inspired dense sidebar + main + right rail. Keyboard hints, tight rows, live log tail.",
  },
] as const;

export default function DesignsIndexPage() {
  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#000",
        color: "#ededed",
        padding: "64px 32px",
        fontFamily:
          "var(--font-geist-sans), -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif",
      }}
    >
      <div style={{ maxWidth: 960, margin: "0 auto" }}>
        <header
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            marginBottom: 48,
          }}
        >
          <img
            src="/openclaw-logo.svg"
            width={24}
            height={24}
            alt="OpenClaw"
          />
          <span
            style={{
              fontFamily: "var(--font-geist-mono), ui-monospace, monospace",
              fontSize: 11,
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              color: "#666",
            }}
          >
            OpenClaw / Designs
          </span>
        </header>

        <h1
          style={{
            fontSize: "clamp(1.75rem, 3.5vw, 2.5rem)",
            fontWeight: 700,
            lineHeight: 1.1,
            letterSpacing: "-0.02em",
            margin: 0,
          }}
        >
          Design variations
        </h1>
        <p
          style={{
            color: "#888",
            fontSize: "0.875rem",
            lineHeight: 1.5,
            marginTop: 12,
            marginBottom: 48,
            maxWidth: 560,
          }}
        >
          Three parallel redesign directions for the OpenClaw admin surface,
          generated against the Geist design guidelines. Pick one to promote,
          or combine elements.
        </p>

        <div
          style={{
            display: "grid",
            gap: 1,
            background: "rgba(255,255,255,0.08)",
            border: "1px solid rgba(255,255,255,0.08)",
            borderRadius: 8,
            overflow: "hidden",
          }}
        >
          {VARIATIONS.map((v) => (
            <Link
              key={v.slug}
              href={`/designs/${v.slug}`}
              style={{
                display: "flex",
                alignItems: "baseline",
                gap: 24,
                padding: "20px 24px",
                background: "#0a0a0a",
                color: "#ededed",
                textDecoration: "none",
                transition: "background 150ms ease",
              }}
            >
              <span
                style={{
                  fontFamily:
                    "var(--font-geist-mono), ui-monospace, monospace",
                  fontSize: 11,
                  textTransform: "uppercase",
                  letterSpacing: "0.08em",
                  color: "#666",
                  minWidth: 24,
                }}
              >
                0{VARIATIONS.indexOf(v) + 1}
              </span>
              <div style={{ flex: 1 }}>
                <div
                  style={{
                    fontSize: "1.25rem",
                    fontWeight: 600,
                    lineHeight: 1.2,
                    marginBottom: 4,
                  }}
                >
                  {v.label}
                </div>
                <div
                  style={{
                    color: "#888",
                    fontSize: "0.875rem",
                    lineHeight: 1.5,
                  }}
                >
                  {v.blurb}
                </div>
              </div>
              <span
                style={{
                  fontFamily:
                    "var(--font-geist-mono), ui-monospace, monospace",
                  fontSize: 11,
                  color: "#666",
                }}
              >
                /designs/{v.slug} →
              </span>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
