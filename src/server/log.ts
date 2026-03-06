type LogLevel = "debug" | "info" | "warn" | "error";

export function log(level: LogLevel, msg: string, ctx?: Record<string, unknown>): void {
  const payload = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg,
    ctx: ctx ?? {},
  });

  switch (level) {
    case "debug":
      console.debug(payload);
      return;
    case "warn":
      console.warn(payload);
      return;
    case "error":
      console.error(payload);
      return;
    default:
      console.info(payload);
  }
}

export function logInfo(msg: string, ctx?: Record<string, unknown>): void {
  log("info", msg, ctx);
}

export function logWarn(msg: string, ctx?: Record<string, unknown>): void {
  log("warn", msg, ctx);
}

export function logError(msg: string, ctx?: Record<string, unknown>): void {
  log("error", msg, ctx);
}
