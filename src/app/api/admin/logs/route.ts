import { Sandbox } from "@vercel/sandbox";

import type { LogEntry, LogLevel, LogSource } from "@/shared/types";
import { requireJsonRouteAuth, authJsonOk } from "@/server/auth/route-auth";
import { getFilteredServerLogs } from "@/server/log";
import { getInitializedMeta } from "@/server/store/store";

const MAX_LOG_LINES = 200;
const LOG_FILE_GLOB = "/tmp/openclaw/openclaw-*.log";

/**
 * Parse a raw log line into a structured LogEntry.
 * Expected format: JSON lines with ts/level/msg/ctx, or plain text fallback.
 */
function parseLogLine(line: string, index: number): LogEntry | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(trimmed) as {
      ts?: string;
      level?: string;
      msg?: string;
      ctx?: Record<string, unknown>;
    };

    const level = normalizeLevel(parsed.level);
    const data = parsed.ctx && Object.keys(parsed.ctx).length > 0
      ? parsed.ctx
      : undefined;
    return {
      id: `log-${parsed.ts ?? index}-${index}`,
      timestamp: parsed.ts ? new Date(parsed.ts).getTime() : Date.now(),
      level,
      source: normalizeSource(parsed.ctx?.source),
      message: parsed.msg ?? trimmed,
      ...(data ? { data } : {}),
    };
  } catch {
    // Plain text line — treat as info
    return {
      id: `log-plain-${index}`,
      timestamp: Date.now(),
      level: "info",
      source: "system",
      message: trimmed,
    };
  }
}

function normalizeLevel(raw: unknown): LogLevel {
  if (raw === "error" || raw === "warn" || raw === "info" || raw === "debug") {
    return raw;
  }
  return "info";
}

function normalizeSource(raw: unknown): LogSource {
  const valid: LogSource[] = [
    "lifecycle",
    "proxy",
    "firewall",
    "channels",
    "auth",
    "system",
  ];
  if (typeof raw === "string" && valid.includes(raw as LogSource)) {
    return raw as LogSource;
  }
  return "system";
}

function isValidLevel(value: string): value is LogLevel {
  return value === "error" || value === "warn" || value === "info" || value === "debug";
}

function isValidSource(value: string): value is LogSource {
  const valid = ["lifecycle", "proxy", "firewall", "channels", "auth", "system"];
  return valid.includes(value);
}

export async function GET(request: Request): Promise<Response> {
  const auth = await requireJsonRouteAuth(request);
  if (auth instanceof Response) {
    return auth;
  }

  const url = new URL(request.url);
  const levelParam = url.searchParams.get("level") ?? undefined;
  const sourceParam = url.searchParams.get("source") ?? undefined;
  const searchParam = url.searchParams.get("search") ?? undefined;

  const level = levelParam && isValidLevel(levelParam) ? levelParam : undefined;
  const source = sourceParam && isValidSource(sourceParam) ? sourceParam : undefined;

  // Collect server-side structured logs from the ring buffer
  const serverLogs = getFilteredServerLogs({ level, source, search: searchParam });

  // Collect sandbox logs if running
  let sandboxLogs: LogEntry[] = [];
  const meta = await getInitializedMeta();
  if (meta.status === "running" && meta.sandboxId) {
    try {
      const sandbox = await Sandbox.get({ sandboxId: meta.sandboxId });
      const result = await sandbox.runCommand("bash", [
        "-c",
        `tail -n ${MAX_LOG_LINES} ${LOG_FILE_GLOB} 2>/dev/null || echo ""`,
      ]);

      const stdout = await result.output("stdout");
      const lines = stdout.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const entry = parseLogLine(lines[i], i);
        if (entry) {
          // Apply filters to sandbox logs too
          if (level && entry.level !== level) continue;
          if (source && entry.source !== source) continue;
          if (searchParam) {
            const term = searchParam.toLowerCase();
            const matches =
              entry.message.toLowerCase().includes(term) ||
              (entry.data && JSON.stringify(entry.data).toLowerCase().includes(term));
            if (!matches) continue;
          }
          sandboxLogs.push(entry);
        }
      }
    } catch {
      // Sandbox logs unavailable — return server logs only
      sandboxLogs = [];
    }
  }

  // Merge and sort by timestamp descending (newest first)
  const allLogs = [...serverLogs, ...sandboxLogs].sort(
    (a, b) => b.timestamp - a.timestamp,
  );

  return authJsonOk({ logs: allLogs }, auth);
}
