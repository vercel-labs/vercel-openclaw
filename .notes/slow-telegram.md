# Slow Telegram Restore Investigation

Date: 2026-04-13

## Problem

Telegram replies are delayed after a sandbox restore in current OpenClaw-based builds. Older OpenClaw around `v2026.3.28` did not show the same restore latency.

The target is not just faster startup logs. The target is faster time-to-first-Telegram-response after sandbox wake.

## What was already fixed

The original Telegram startup path used to await a startup probe before the provider was considered started. That meant Telegram startup was blocked on the probe itself.

That path has already been improved in `openclaw/extensions/telegram/src/channel.ts` so the provider starts immediately and the probe runs in the background.

This helped, but did not fully fix the restore delay.

## What the measurements showed

### 1. Direct transport is not the main issue

Direct network tests to Telegram completed quickly, generally a few hundred milliseconds.

That included direct `fetch`, `curl`, `undici`, and the same fetch helper path used by Telegram integration code.

Conclusion: raw transport to Telegram is not the primary cause.

### 2. The delay happens in startup context

In startup logs, Telegram requests are launched promptly, but their aborts/completions are delayed by several seconds.

Example from `/tmp/oc-measure-skip-prewarm/gateway.log`:

- Telegram startup probe begins at `2026-04-13T13:51:27.536-06:00`
- `transport.fetch.begin` logs immediately
- the 2500ms abort does not surface until about `2026-04-13T13:51:34.455-06:00`
- total elapsed is about `6922ms`

Conclusion: this looks like event-loop starvation or startup contention, not ordinary network delay.

### 3. `acpx` startup is strongly correlated with the stall

In the same `skip-prewarm` run:

- `embedded acpx runtime backend registered` logs almost immediately
- `embedded acpx runtime backend ready` logs at `2026-04-13T13:51:34.475-06:00`
- Telegram startup probe becomes unstuck right before that

With `OPENCLAW_SKIP_ACPX_RUNTIME=1`, Telegram startup probe time dropped to about `230-250ms`.

Conclusion: current `acpx` startup/probe behavior is a major contributor to the Telegram restore stall.

### 4. Provider/model warmup is a separate startup blocker

In another local measurement with `acpx` skipped, startup still spent about `9351ms` in provider discovery before channels started.

This came from model warmup flow in `server-startup-post-attach.ts`, specifically `prewarmConfiguredPrimaryModel()` and `ensureOpenClawModelsJson(...)`.

Conclusion: there are two restore regressions:

1. model/provider warmup delaying channel startup before Telegram starts
2. `acpx` probe starving Telegram after channels start

## Current patch direction

### Gateway startup

`openclaw/src/gateway/server-startup-post-attach.ts`

- channel startup now runs before startup model warmup
- model warmup is scheduled in the background instead of being awaited on the restore critical path
- default delay is `2500ms`
- tunable via `OPENCLAW_STARTUP_MODEL_WARMUP_DELAY_MS`

### ACPX startup

`openclaw/extensions/acpx/src/service.ts`

- runtime registration still happens immediately
- `probeAvailability()` is now scheduled after a startup grace period instead of firing immediately during channel startup
- default delay is `2500ms`
- tunable via `OPENCLAW_ACPX_STARTUP_PROBE_DELAY_MS`

## Final delivery approach for this repo

This repo does not run the local `openclaw/` fork directly in production.

It installs official npm `openclaw` in sandbox setup, then launches from the installed `dist`.

That means the practical fix here is:

1. keep using pinned npm `openclaw@2026.4.11`
2. patch the installed `dist` after `npm install -g`
3. keep the patch as small and version-gated as possible

## What was verified locally on the real install path

I installed the exact production-shaped package locally:

- `npm install -g openclaw@2026.4.11 --ignore-scripts`

Then I patched the installed `dist` files and reran the startup measurement.

### Important integration finding

The existing install patch script was only scanning:

- `server.impl-*.js`

But the `acpx` startup code for `openclaw@2026.4.11` lives in:

- `register.runtime-*.js`

So the patch runner had to be updated to scan both:

1. `server.impl-*.js`
2. `register.runtime-*.js`

### Exact npm-package result after patching

On a fresh local install of `openclaw@2026.4.11` patched in place:

- `embedded acpx runtime backend registered` logged at `15:00:27.265`
- Telegram provider started at `15:00:27.397`
- Telegram failed fast at `15:00:27.901`
- `embedded acpx runtime backend ready` came later at `15:00:30.208`

That is the key behavioral change.

Before this fix, Telegram was getting pinned behind `acpx` readiness and taking multiple seconds to surface the result.

After this fix, Telegram is no longer blocked on `acpx` startup.

## Final patch scope

The repo-side hotfix now does two things:

1. existing qmd warmup delay patch in `server.impl-*`
2. new `acpx` startup probe delay patch in `register.runtime-*`

The new `acpx` patch is:

- version-gated to `openclaw@2026.4.11`
- marker-based and idempotent
- configurable via `OPENCLAW_ACPX_STARTUP_PROBE_DELAY_MS`

## Confidence

Confidence is now high that the `acpx` restore stall was a real root cause and that the npm-install hotfix addresses it in the actual production-shaped runtime.

Remaining validation is a real deployed sandbox restore triggered from Telegram.

## Why this patch is reasonable

The restore-critical path should prioritize:

1. bind gateway
2. start channels
3. accept/drain inbound messages

Warmup and ACPX health probing are secondary work. They should not compete with Telegram webhook readiness during sandbox wake.

## Package diff notes

A quick package diff between `v2026.3.28` and current OpenClaw shows some plausible suspects:

- `undici` changed from `^7.24.6` to `8.0.2`
- `grammy` was added/updated
- `@grammyjs/runner` added
- `@grammyjs/transformer-throttler` added

Those changes are worth keeping in mind, but the stronger evidence still points to startup concurrency/starvation rather than a simple dependency-level transport regression.

## Files instrumented during investigation

- `openclaw/extensions/telegram/src/channel.ts`
- `openclaw/extensions/telegram/src/probe.ts`
- `openclaw/extensions/telegram/src/fetch.ts`
- `openclaw/extensions/telegram/src/bot.ts`
- `openclaw/extensions/telegram/src/bot-native-commands.ts`
- `openclaw/extensions/telegram/src/bot-native-command-menu.ts`
- `openclaw/extensions/telegram/src/webhook.ts`
- `openclaw/extensions/acpx/src/service.ts`

## Next validation

1. run focused tests
2. rebuild runtime artifact
3. rerun `scripts/measure-openclaw-telegram-startup.mjs`
4. compare:
   - baseline
   - skip-prewarm
   - skip-acpx
   - patched default
5. validate the deployed sandbox with a real Telegram restore
