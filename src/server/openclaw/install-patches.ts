export const OPENCLAW_QMD_WARMUP_DELAY_PATCH_MARKER = "vercel-openclaw:qmd-warmup-delay";
const OPENCLAW_QMD_WARMUP_DELAY_MS = 3_000;
export const OPENCLAW_ACPX_STARTUP_PROBE_DELAY_PATCH_MARKER =
  "vercel-openclaw:acpx-startup-probe-delay";
const OPENCLAW_ACPX_STARTUP_PROBE_DELAY_MS = 2_500;
const OPENCLAW_ACPX_STARTUP_PROBE_DELAY_SUPPORTED_VERSIONS = new Set(["2026.4.11"]);
const OPENCLAW_PACKAGE_DIR = "/home/vercel-sandbox/.global/npm/lib/node_modules/openclaw";
const OPENCLAW_PATCH_TARGET_REGEX =
  /startGatewayMemoryBackend\(\{\s*cfg: params\.cfg,\s*log: params\.log\s*\}\)\.catch\(\(err\) => \{\s*params\.log\.warn\(`qmd memory startup initialization failed: \$\{String\(err\)\}`\);\s*\}\);/m;
const OPENCLAW_PATCH_REPLACEMENT = [
  "const startMemoryBackend = () => { startGatewayMemoryBackend({ cfg: params.cfg, log: params.log }).catch((err) => { params.log.warn(`qmd memory startup initialization failed: ${String(err)}`); }); };",
  `/* ${OPENCLAW_QMD_WARMUP_DELAY_PATCH_MARKER} */`,
  'if (isTruthyEnvValue(process.env.OPENCLAW_SKIP_CHANNELS) || isTruthyEnvValue(process.env.OPENCLAW_SKIP_PROVIDERS)) startMemoryBackend();',
  `else { const memoryStartupTimer = setTimeout(() => startMemoryBackend(), ${OPENCLAW_QMD_WARMUP_DELAY_MS}); memoryStartupTimer.unref?.(); }`,
].join(" ");
const OPENCLAW_ACPX_PATCH_TARGET_REGEX =
  /if \(process\.env\.OPENCLAW_SKIP_ACPX_RUNTIME_PROBE === "1"\) return;\s*lifecycleRevision \+= 1;\s*const currentRevision = lifecycleRevision;\s*\(async \(\) => \{\s*try \{\s*await runtime\?\.probeAvailability\(\);\s*if \(currentRevision !== lifecycleRevision\) return;\s*if \(runtime\?\.isHealthy\(\)\) \{\s*ctx\.logger\.info\("embedded acpx runtime backend ready"\);\s*return;\s*\}\s*const doctorReport = await runtime\?\.doctor\?\.\(\);\s*if \(currentRevision !== lifecycleRevision\) return;\s*ctx\.logger\.warn\(`embedded acpx runtime backend probe failed: \$\{doctorReport \? formatDoctorFailureMessage\(doctorReport\) : "backend remained unhealthy after probe"\}`\);\s*\} catch \(err\) \{\s*if \(currentRevision !== lifecycleRevision\) return;\s*ctx\.logger\.warn\(`embedded acpx runtime setup failed: \$\{formatErrorMessage\$1\(err\)\}`\);\s*\}\s*\}\)\(\);/m;
const OPENCLAW_ACPX_PATCH_REPLACEMENT = [
  'if (process.env.OPENCLAW_SKIP_ACPX_RUNTIME_PROBE === "1") return;',
  "\t\t\tlifecycleRevision += 1;",
  "\t\t\tconst currentRevision = lifecycleRevision;",
  `\t\t\t/* ${OPENCLAW_ACPX_STARTUP_PROBE_DELAY_PATCH_MARKER} */`,
  '\t\t\tconst parsedProbeDelayMs = Number.parseInt(process.env.OPENCLAW_ACPX_STARTUP_PROBE_DELAY_MS?.trim() || "", 10);',
  `\t\t\tconst resolvedProbeDelayMs = Number.isFinite(parsedProbeDelayMs) && parsedProbeDelayMs >= 0 ? parsedProbeDelayMs : ${OPENCLAW_ACPX_STARTUP_PROBE_DELAY_MS};`,
  '\t\t\tif (process.env.OPENCLAW_DEBUG_ACPX_STARTUP === "1" || process.env.OPENCLAW_DEBUG_INGRESS_TIMING === "1") ctx.logger.info(`embedded acpx runtime probe scheduled delayMs=${resolvedProbeDelayMs}`);',
  "\t\t\tconst acpxProbeTimer = setTimeout(() => {",
  "\t\t\t\t(async () => {",
  "\t\t\t\t\ttry {",
  "\t\t\t\t\t\tawait runtime?.probeAvailability();",
  "\t\t\t\t\t\tif (currentRevision !== lifecycleRevision) return;",
  "\t\t\t\t\t\tif (runtime?.isHealthy()) {",
  '\t\t\t\t\t\t\tctx.logger.info("embedded acpx runtime backend ready");',
  "\t\t\t\t\t\t\treturn;",
  "\t\t\t\t\t\t}",
  "\t\t\t\t\t\tconst doctorReport = await runtime?.doctor?.();",
  "\t\t\t\t\t\tif (currentRevision !== lifecycleRevision) return;",
  '\t\t\t\t\t\tctx.logger.warn(`embedded acpx runtime backend probe failed: ${doctorReport ? formatDoctorFailureMessage(doctorReport) : "backend remained unhealthy after probe"}`);',
  "\t\t\t\t\t} catch (err) {",
  "\t\t\t\t\t\tif (currentRevision !== lifecycleRevision) return;",
  '\t\t\t\t\t\tctx.logger.warn(`embedded acpx runtime setup failed: ${formatErrorMessage$1(err)}`);',
  "\t\t\t\t\t}",
  "\t\t\t\t})();",
  "\t\t\t}, resolvedProbeDelayMs);",
  "\t\t\tacpxProbeTimer.unref?.();",
].join("\n");

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

export type ApplyAcpxStartupProbeDelayPatchResult = {
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

export function applyAcpxStartupProbeDelayPatch(
  source: string,
  packageVersion: string | null | undefined,
): ApplyAcpxStartupProbeDelayPatchResult {
  if (source.includes(OPENCLAW_ACPX_STARTUP_PROBE_DELAY_PATCH_MARKER)) {
    return { status: "already-patched", nextContent: source };
  }
  if (!packageVersion || !OPENCLAW_ACPX_STARTUP_PROBE_DELAY_SUPPORTED_VERSIONS.has(packageVersion)) {
    return {
      status: "skipped",
      nextContent: source,
      reason: packageVersion ? `unsupported-version:${packageVersion}` : "version-unknown",
    };
  }
  if (!OPENCLAW_ACPX_PATCH_TARGET_REGEX.test(source)) {
    return { status: "skipped", nextContent: source, reason: "target-not-found" };
  }
  return {
    status: "applied",
    nextContent: source.replace(OPENCLAW_ACPX_PATCH_TARGET_REGEX, OPENCLAW_ACPX_PATCH_REPLACEMENT),
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
    "function applyQmdPatch(source) {",
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
    "",
    "function applyAcpxPatch(source, packageVersion) {",
    `  const marker = ${JSON.stringify(OPENCLAW_ACPX_STARTUP_PROBE_DELAY_PATCH_MARKER)};`,
    `  const supportedVersions = new Set(${JSON.stringify([...OPENCLAW_ACPX_STARTUP_PROBE_DELAY_SUPPORTED_VERSIONS])});`,
    `  const target = new RegExp(${JSON.stringify(OPENCLAW_ACPX_PATCH_TARGET_REGEX.source)}, ${JSON.stringify(OPENCLAW_ACPX_PATCH_TARGET_REGEX.flags)});`,
    `  const replacement = ${JSON.stringify(OPENCLAW_ACPX_PATCH_REPLACEMENT)};`,
    "  if (source.includes(marker)) {",
    '    return { status: "already-patched", nextContent: source };',
    "  }",
    "  if (!packageVersion) {",
    '    return { status: "skipped", nextContent: source, reason: "version-unknown" };',
    "  }",
    "  if (!supportedVersions.has(packageVersion)) {",
    '    return { status: "skipped", nextContent: source, reason: `unsupported-version:${packageVersion}` };',
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

export function buildOpenClawInstallPatchScript(options?: { packageDir?: string }): string {
  const packageDir = options?.packageDir?.trim() || OPENCLAW_PACKAGE_DIR;
  return [
    "#!/usr/bin/env node",
    'import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";',
    'import { join } from "node:path";',
    `const packageDir = ${JSON.stringify(packageDir)};`,
    "const distDir = join(packageDir, \"dist\");",
    'const packageJsonPath = join(packageDir, "package.json");',
    "",
    "function emit(payload) {",
    "  process.stdout.write(`${JSON.stringify(payload)}\\n`);",
    "}",
    "",
    "function listCandidateFiles(dir) {",
    "  const direct = readdirSync(dir, { withFileTypes: true })",
    '    .filter((entry) => entry.isFile() && entry.name.endsWith(".js") && (entry.name.startsWith("server.impl-") || entry.name.startsWith("register.runtime-")))',
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
    "const packageVersion = existsSync(packageJsonPath)",
    '  ? JSON.parse(readFileSync(packageJsonPath, "utf8")).version ?? null',
    "  : null;",
    "",
    "if (!existsSync(distDir)) {",
    '  emit({ status: "skipped", reason: "dist-missing", distDir });',
    "  process.exit(0);",
    "}",
    "",
    "const candidates = listCandidateFiles(distDir);",
    "let appliedCount = 0;",
    "let alreadyPatchedCount = 0;",
    "let firstPatchedFile = null;",
    "let lastReason = null;",
    "for (const filePath of candidates) {",
    '  const source = readFileSync(filePath, "utf8");',
    "  let nextContent = source;",
    "  let fileTouched = false;",
    "  for (const result of [applyQmdPatch(nextContent), applyAcpxPatch(nextContent, packageVersion)]) {",
    '    if (result.status === "skipped") {',
    "      lastReason = result.reason ?? lastReason;",
    "      continue;",
    "    }",
    '    if (result.status === "already-patched") {',
    "      alreadyPatchedCount += 1;",
    "      firstPatchedFile ??= filePath;",
    "      continue;",
    "    }",
    "    nextContent = result.nextContent;",
    "    fileTouched = true;",
    "    appliedCount += 1;",
    "    firstPatchedFile ??= filePath;",
    "  }",
    "  if (fileTouched) {",
    '    writeFileSync(filePath, nextContent, "utf8");',
    "  }",
    "}",
    "",
    'if (appliedCount > 0) emit({ status: "applied", filePath: firstPatchedFile ?? undefined, candidateCount: candidates.length, distDir });',
    'else if (alreadyPatchedCount > 0) emit({ status: "already-patched", filePath: firstPatchedFile ?? undefined, candidateCount: candidates.length, distDir });',
    'else emit({ status: "skipped", reason: lastReason ?? "target-not-found", candidateCount: candidates.length, distDir });',
  ].join("\n");
}
