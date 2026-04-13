export const OPENCLAW_QMD_WARMUP_DELAY_PATCH_MARKER = "vercel-openclaw:qmd-warmup-delay";
const OPENCLAW_QMD_WARMUP_DELAY_MS = 3_000;
const OPENCLAW_PACKAGE_DIR = "/home/vercel-sandbox/.global/npm/lib/node_modules/openclaw";
const OPENCLAW_PATCH_TARGET_REGEX =
  /startGatewayMemoryBackend\(\{\s*cfg: params\.cfg,\s*log: params\.log\s*\}\)\.catch\(\(err\) => \{\s*params\.log\.warn\(`qmd memory startup initialization failed: \$\{String\(err\)\}`\);\s*\}\);/m;
const OPENCLAW_PATCH_REPLACEMENT = [
  "const startMemoryBackend = () => { startGatewayMemoryBackend({ cfg: params.cfg, log: params.log }).catch((err) => { params.log.warn(`qmd memory startup initialization failed: ${String(err)}`); }); };",
  `/* ${OPENCLAW_QMD_WARMUP_DELAY_PATCH_MARKER} */`,
  'if (isTruthyEnvValue(process.env.OPENCLAW_SKIP_CHANNELS) || isTruthyEnvValue(process.env.OPENCLAW_SKIP_PROVIDERS)) startMemoryBackend();',
  `else { const memoryStartupTimer = setTimeout(() => startMemoryBackend(), ${OPENCLAW_QMD_WARMUP_DELAY_MS}); memoryStartupTimer.unref?.(); }`,
].join(" ");

export type OpenClawInstallPatchOutcome = {
  status: "applied" | "already-patched" | "skipped";
  filePath?: string;
  reason?: string;
  candidateCount?: number;
  distDir?: string;
};

export type ApplyQmdWarmupDelayPatchResult = {
  status: "applied" | "already-patched" | "skipped";
  nextContent: string;
  reason?: string;
};

export function applyQmdWarmupDelayPatch(source: string): ApplyQmdWarmupDelayPatchResult {
  if (source.includes(OPENCLAW_QMD_WARMUP_DELAY_PATCH_MARKER)) {
    return { status: "already-patched", nextContent: source };
  }
  if (!OPENCLAW_PATCH_TARGET_REGEX.test(source)) {
    return { status: "skipped", nextContent: source, reason: "target-not-found" };
  }
  return {
    status: "applied",
    nextContent: source.replace(OPENCLAW_PATCH_TARGET_REGEX, OPENCLAW_PATCH_REPLACEMENT),
  };
}

export function parseOpenClawInstallPatchOutcome(raw: string): OpenClawInstallPatchOutcome | null {
  try {
    const parsed = JSON.parse(raw.trim()) as Partial<OpenClawInstallPatchOutcome> | null;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    if (
      parsed.status !== "applied"
      && parsed.status !== "already-patched"
      && parsed.status !== "skipped"
    ) {
      return null;
    }
    return {
      status: parsed.status,
      ...(typeof parsed.filePath === "string" ? { filePath: parsed.filePath } : {}),
      ...(typeof parsed.reason === "string" ? { reason: parsed.reason } : {}),
      ...(typeof parsed.candidateCount === "number" ? { candidateCount: parsed.candidateCount } : {}),
      ...(typeof parsed.distDir === "string" ? { distDir: parsed.distDir } : {}),
    };
  } catch {
    return null;
  }
}

function buildInstallPatchRunner(): string {
  return [
    "function applyPatch(source) {",
    `  const marker = ${JSON.stringify(OPENCLAW_QMD_WARMUP_DELAY_PATCH_MARKER)};`,
    `  const target = new RegExp(${JSON.stringify(OPENCLAW_PATCH_TARGET_REGEX.source)}, ${JSON.stringify(OPENCLAW_PATCH_TARGET_REGEX.flags)});`,
    `  const replacement = ${JSON.stringify(OPENCLAW_PATCH_REPLACEMENT)};`,
    "  if (source.includes(marker)) {",
    '    return { status: "already-patched", nextContent: source };',
    "  }",
    "  if (!target.test(source)) {",
    '    return { status: "skipped", nextContent: source, reason: "target-not-found" };',
    "  }",
    "  return {",
    '    status: "applied",',
    "    nextContent: source.replace(target, replacement),",
    "  };",
    "}",
  ].join("\n");
}

export function buildOpenClawInstallPatchScript(): string {
  return [
    "#!/usr/bin/env node",
    'import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";',
    'import { join } from "node:path";',
    `const packageDir = ${JSON.stringify(OPENCLAW_PACKAGE_DIR)};`,
    "const distDir = join(packageDir, \"dist\");",
    "",
    "function emit(payload) {",
    "  process.stdout.write(`${JSON.stringify(payload)}\\n`);",
    "}",
    "",
    "function listCandidateFiles(dir) {",
    "  const direct = readdirSync(dir, { withFileTypes: true })",
    '    .filter((entry) => entry.isFile() && entry.name.startsWith("server.impl-") && entry.name.endsWith(".js"))',
    "    .map((entry) => join(dir, entry.name));",
    "  if (direct.length > 0) {",
    "    return direct;",
    "  }",
    "  const files = [];",
    "  const stack = [dir];",
    "  while (stack.length > 0) {",
    "    const current = stack.pop();",
    "    if (!current) {",
    "      continue;",
    "    }",
    "    for (const entry of readdirSync(current, { withFileTypes: true })) {",
    "      const filePath = join(current, entry.name);",
    "      if (entry.isDirectory()) {",
    "        stack.push(filePath);",
    '      } else if (entry.isFile() && entry.name.endsWith(".js")) {',
    "        files.push(filePath);",
    "      }",
    "    }",
    "  }",
    "  return files;",
    "}",
    "",
    buildInstallPatchRunner(),
    "",
    "if (!existsSync(distDir)) {",
    '  emit({ status: "skipped", reason: "dist-missing", distDir });',
    "  process.exit(0);",
    "}",
    "",
    "const candidates = listCandidateFiles(distDir);",
    "for (const filePath of candidates) {",
    '  const source = readFileSync(filePath, "utf8");',
    "  const result = applyPatch(source);",
    '  if (result.status === "skipped") {',
    "    continue;",
    "  }",
    '  if (result.status === "applied") {',
    '    writeFileSync(filePath, result.nextContent, "utf8");',
    "  }",
    "  emit({ status: result.status, filePath });",
    "  process.exit(0);",
    "}",
    "",
    'emit({ status: "skipped", reason: "target-not-found", distDir, candidateCount: candidates.length });',
  ].join("\n");
}
