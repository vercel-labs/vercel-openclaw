import {
  CHANNEL_NAMES,
  createUnknownUserVisibleReply,
  isChannelName,
  isChannelUserVisibleReply,
  normalizeChannelLastForward,
  normalizeChannelUserVisibleReply,
  type ChannelLastForward,
  type ChannelName,
  type ChannelUserVisibleReply,
} from "@/shared/channels";

export const CHANNEL_DELIVERY_STATES = [
  "received",
  "validated",
  "dedup-checked",
  "fast-path-eligible",
  "fast-path-forwarding",
  "workflow-planned",
  "wake-running",
  "native-forwarding",
  "native-forward-failed",
  "reply-observation-pending",
  "rejected",
  "duplicate",
  "accepted-noop",
  "native-accepted",
  "visibility-unknown",
  "reply-observed",
  "terminal-failed",
  "workflow-start-failed",
] as const;

export type ChannelDeliveryState = (typeof CHANNEL_DELIVERY_STATES)[number];

export const CHANNEL_DELIVERY_TERMINAL_STATES = [
  "rejected",
  "duplicate",
  "accepted-noop",
  "native-accepted",
  "visibility-unknown",
  "reply-observed",
  "terminal-failed",
  "workflow-start-failed",
] as const satisfies readonly ChannelDeliveryState[];

export type ChannelDeliveryTerminalState =
  (typeof CHANNEL_DELIVERY_TERMINAL_STATES)[number];

export const CHANNEL_NOTICE_STATES = [
  "not-needed",
  "unavailable",
  "send-pending",
  "sent",
  "update-pending",
  "cleared",
  "failed",
] as const;

export type ChannelNoticeState = (typeof CHANNEL_NOTICE_STATES)[number];

export type ChannelDeliverySource =
  | "webhook-plan"
  | "fast-path-outcome"
  | "last-forward"
  | "user-visible-reply"
  | "manual"
  | "legacy-projection";

export type ChannelDeliveryFinality =
  | "in-progress"
  | "latest-attempt"
  | "terminal"
  | "terminal-revisable";

export const CHANNEL_DELIVERY_EVENTS = [
  "webhook-received",
  "validated",
  "validation-rejected",
  "dedup-checked",
  "duplicate-detected",
  "fast-path-eligible",
  "fast-path-started",
  "fast-path-accepted",
  "fast-path-accepted-noop",
  "fast-path-fallback",
  "workflow-planned",
  "workflow-start-failed",
  "wake-started",
  "native-forward-started",
  "native-forward-accepted",
  "native-forward-failed",
  "reply-observation-started",
  "reply-observed",
  "reply-observation-timeout",
  "visibility-unknown",
  "terminal-failed",
] as const;

export type ChannelDeliveryEvent = (typeof CHANNEL_DELIVERY_EVENTS)[number];

export type ChannelDeliveryTransition = {
  from: ChannelDeliveryState | "*";
  event: ChannelDeliveryEvent;
  to: ChannelDeliveryState;
  terminal?: boolean;
  note?: string;
};

export type ChannelDeliveryTransitionRecord = {
  from: ChannelDeliveryState | "*";
  event: ChannelDeliveryEvent;
  to: ChannelDeliveryState;
  at: number;
  reason: string | null;
};

export type ChannelNoticeSnapshot = {
  state: ChannelNoticeState;
  reason: string | null;
  messageId: string | number | null;
  updatedAt: number | null;
  error: string | null;
};

export type ChannelNativeAcceptanceSnapshot = {
  ok: boolean;
  status: number | null;
  classification: string | null;
  attempts: number | null;
  totalMs: number | null;
  transport: "public" | "local" | null;
  sandboxUrl: string | null;
  sandboxId: string | null;
  completedAt: number | null;
};

export type ChannelFastPathSnapshot = {
  kind: string;
  reason: string | null;
  classification: string | null;
  status: number | null;
  transport: "public" | "local" | null;
  sandboxUrl: string | null;
  sandboxId: string | null;
  indeterminateDelivery: boolean;
};

export type ChannelWorkflowSnapshot = {
  planned: boolean;
  startReason: string | null;
  startedAt: number | null;
  startFailedAt: number | null;
};

export type ChannelDeliverySnapshot = {
  version: 1;
  channel: ChannelName;
  deliveryId: string | null;
  state: ChannelDeliveryState;
  finality: ChannelDeliveryFinality;
  terminal: boolean;
  receivedAt: number | null;
  updatedAt: number;
  completedAt: number | null;
  source: ChannelDeliverySource;
  reason: string | null;
  routeOutcome: string | null;
  workflow: ChannelWorkflowSnapshot | null;
  fastPath: ChannelFastPathSnapshot | null;
  native: ChannelNativeAcceptanceSnapshot | null;
  reply: ChannelUserVisibleReply | null;
  notice: ChannelNoticeSnapshot;
  transitions: ChannelDeliveryTransitionRecord[];
};

export type ChannelDeliveryExtension = {
  channel: ChannelName;
  nativeHandlerPath: string;
  nativeHandlerPort: 3000 | 8787;
  replyObservation: "none" | "manual" | "platform-api" | "synthetic-canary";
  userNoticeSupported: boolean;
  notes: readonly string[];
};

export const CHANNEL_DELIVERY_EXTENSIONS = {
  slack: {
    channel: "slack",
    nativeHandlerPath: "/slack/events",
    nativeHandlerPort: 3000,
    replyObservation: "platform-api",
    userNoticeSupported: true,
    notes: ["oauth-config-sync", "threaded-replies"],
  },
  telegram: {
    channel: "telegram",
    nativeHandlerPath: "/telegram-webhook",
    nativeHandlerPort: 8787,
    replyObservation: "platform-api",
    userNoticeSupported: true,
    notes: ["native-8787-listener-readiness"],
  },
  discord: {
    channel: "discord",
    nativeHandlerPath: "/discord-webhook",
    nativeHandlerPort: 3000,
    replyObservation: "platform-api",
    userNoticeSupported: true,
    notes: ["interaction-expiry"],
  },
  whatsapp: {
    channel: "whatsapp",
    nativeHandlerPath: "/whatsapp-webhook",
    nativeHandlerPort: 3000,
    replyObservation: "platform-api",
    userNoticeSupported: true,
    notes: ["link-state-is-separate"],
  },
} as const satisfies Record<ChannelName, ChannelDeliveryExtension>;

export const CHANNEL_DELIVERY_TRANSITIONS = [
  { from: "*", event: "webhook-received", to: "received" },
  { from: "received", event: "validated", to: "validated" },
  { from: "received", event: "validation-rejected", to: "rejected", terminal: true },
  { from: "validated", event: "dedup-checked", to: "dedup-checked" },
  { from: "validated", event: "duplicate-detected", to: "duplicate", terminal: true },
  { from: "dedup-checked", event: "fast-path-eligible", to: "fast-path-eligible" },
  { from: "fast-path-eligible", event: "fast-path-started", to: "fast-path-forwarding" },
  { from: "fast-path-forwarding", event: "fast-path-accepted", to: "visibility-unknown", terminal: true },
  { from: "fast-path-forwarding", event: "fast-path-accepted-noop", to: "accepted-noop", terminal: true },
  { from: "fast-path-forwarding", event: "fast-path-fallback", to: "workflow-planned" },
  { from: "dedup-checked", event: "workflow-planned", to: "workflow-planned" },
  { from: "workflow-planned", event: "workflow-start-failed", to: "workflow-start-failed", terminal: true },
  { from: "workflow-planned", event: "wake-started", to: "wake-running" },
  { from: "wake-running", event: "native-forward-started", to: "native-forwarding" },
  { from: "native-forwarding", event: "native-forward-accepted", to: "visibility-unknown", terminal: true },
  { from: "native-forwarding", event: "native-forward-failed", to: "native-forward-failed" },
  { from: "native-forward-failed", event: "terminal-failed", to: "terminal-failed", terminal: true },
  { from: "visibility-unknown", event: "reply-observation-started", to: "reply-observation-pending" },
  { from: "reply-observation-pending", event: "reply-observed", to: "reply-observed", terminal: true },
  { from: "reply-observation-pending", event: "reply-observation-timeout", to: "visibility-unknown", terminal: true },
  { from: "visibility-unknown", event: "reply-observed", to: "reply-observed", terminal: true },
] as const satisfies readonly ChannelDeliveryTransition[];

const TRANSITION_HISTORY_LIMIT = 20;
const STATE_SET = new Set<string>(CHANNEL_DELIVERY_STATES);
const TERMINAL_STATE_SET = new Set<string>(CHANNEL_DELIVERY_TERMINAL_STATES);
const NOTICE_STATE_SET = new Set<string>(CHANNEL_NOTICE_STATES);
const EVENT_SET = new Set<string>(CHANNEL_DELIVERY_EVENTS);

const DEFAULT_NOTICE: ChannelNoticeSnapshot = {
  state: "not-needed",
  reason: null,
  messageId: null,
  updatedAt: null,
  error: null,
};

export function isChannelDeliveryState(value: unknown): value is ChannelDeliveryState {
  return typeof value === "string" && STATE_SET.has(value);
}

export function isChannelDeliveryTerminalState(
  value: unknown,
): value is ChannelDeliveryTerminalState {
  return typeof value === "string" && TERMINAL_STATE_SET.has(value);
}

export function isChannelNoticeState(value: unknown): value is ChannelNoticeState {
  return typeof value === "string" && NOTICE_STATE_SET.has(value);
}

export function isChannelDeliveryEvent(value: unknown): value is ChannelDeliveryEvent {
  return typeof value === "string" && EVENT_SET.has(value);
}

export function listChannelDeliveryTransitions(): readonly ChannelDeliveryTransition[] {
  return CHANNEL_DELIVERY_TRANSITIONS;
}

export function isTerminalChannelDeliveryState(state: ChannelDeliveryState): boolean {
  return TERMINAL_STATE_SET.has(state);
}

export function createDefaultNoticeSnapshot(
  patch: Partial<ChannelNoticeSnapshot> = {},
): ChannelNoticeSnapshot {
  return { ...DEFAULT_NOTICE, ...patch };
}

export function createInitialChannelDeliverySnapshot(input: {
  channel: ChannelName;
  deliveryId: string | null;
  receivedAt?: number | null;
  now?: number;
  source?: ChannelDeliverySource;
}): ChannelDeliverySnapshot {
  const now = input.now ?? Date.now();
  const receivedAt = input.receivedAt ?? now;
  return {
    version: 1,
    channel: input.channel,
    deliveryId: input.deliveryId,
    state: "received",
    finality: "in-progress",
    terminal: false,
    receivedAt,
    updatedAt: now,
    completedAt: null,
    source: input.source ?? "manual",
    reason: null,
    routeOutcome: null,
    workflow: null,
    fastPath: null,
    native: null,
    reply: null,
    notice: createDefaultNoticeSnapshot(),
    transitions: [
      {
        from: "*",
        event: "webhook-received",
        to: "received",
        at: now,
        reason: null,
      },
    ],
  };
}

export function findChannelDeliveryTransition(
  from: ChannelDeliveryState,
  event: ChannelDeliveryEvent,
): ChannelDeliveryTransition | null {
  return CHANNEL_DELIVERY_TRANSITIONS.find(
    (transition) =>
      (transition.from === from || transition.from === "*") &&
      transition.event === event,
  ) ?? null;
}

export function transitionChannelDelivery(
  current: ChannelDeliverySnapshot,
  event: ChannelDeliveryEvent,
  patch: Partial<ChannelDeliverySnapshot> = {},
): ChannelDeliverySnapshot {
  const transition = findChannelDeliveryTransition(current.state, event);
  if (!transition) {
    throw new Error(`Illegal channel delivery transition: ${current.state} -> ${event}`);
  }

  const now = patch.updatedAt ?? Date.now();
  const terminal = transition.terminal === true || isTerminalChannelDeliveryState(transition.to);
  const completedAt = terminal ? patch.completedAt ?? current.completedAt ?? now : patch.completedAt ?? current.completedAt;
  const nextTransitions = [
    ...current.transitions,
    {
      from: current.state,
      event,
      to: transition.to,
      at: now,
      reason: patch.reason ?? transition.note ?? current.reason,
    },
  ].slice(-TRANSITION_HISTORY_LIMIT);

  return {
    ...current,
    ...patch,
    state: transition.to,
    terminal,
    finality: patch.finality ?? (terminal ? (transition.to === "visibility-unknown" ? "terminal-revisable" : "terminal") : current.finality),
    completedAt,
    updatedAt: now,
    transitions: nextTransitions,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || typeof value === "number";
}

function isTransport(value: unknown): value is "public" | "local" | null {
  return value === null || value === "public" || value === "local";
}

function isChannelDeliverySource(value: unknown): value is ChannelDeliverySource {
  return (
    value === "webhook-plan" ||
    value === "fast-path-outcome" ||
    value === "last-forward" ||
    value === "user-visible-reply" ||
    value === "manual" ||
    value === "legacy-projection"
  );
}

function isChannelDeliveryFinality(value: unknown): value is ChannelDeliveryFinality {
  return (
    value === "in-progress" ||
    value === "latest-attempt" ||
    value === "terminal" ||
    value === "terminal-revisable"
  );
}

function normalizeNoticeSnapshot(value: unknown): ChannelNoticeSnapshot {
  if (!isRecord(value)) return createDefaultNoticeSnapshot();
  return createDefaultNoticeSnapshot({
    state: isChannelNoticeState(value.state) ? value.state : "not-needed",
    reason: isNullableString(value.reason) ? value.reason : null,
    messageId:
      typeof value.messageId === "string" || typeof value.messageId === "number"
        ? value.messageId
        : null,
    updatedAt: isNullableNumber(value.updatedAt) ? value.updatedAt : null,
    error: isNullableString(value.error) ? value.error : null,
  });
}

function normalizeNativeSnapshot(value: unknown): ChannelNativeAcceptanceSnapshot | null {
  if (!isRecord(value) || typeof value.ok !== "boolean") return null;
  return {
    ok: value.ok,
    status: isNullableNumber(value.status) ? value.status : null,
    classification: isNullableString(value.classification) ? value.classification : null,
    attempts: isNullableNumber(value.attempts) ? value.attempts : null,
    totalMs: isNullableNumber(value.totalMs) ? value.totalMs : null,
    transport: isTransport(value.transport) ? value.transport : null,
    sandboxUrl: isNullableString(value.sandboxUrl) ? value.sandboxUrl : null,
    sandboxId: isNullableString(value.sandboxId) ? value.sandboxId : null,
    completedAt: isNullableNumber(value.completedAt) ? value.completedAt : null,
  };
}

function normalizeFastPathSnapshot(value: unknown): ChannelFastPathSnapshot | null {
  if (!isRecord(value) || typeof value.kind !== "string") return null;
  return {
    kind: value.kind,
    reason: isNullableString(value.reason) ? value.reason : null,
    classification: isNullableString(value.classification) ? value.classification : null,
    status: isNullableNumber(value.status) ? value.status : null,
    transport: isTransport(value.transport) ? value.transport : null,
    sandboxUrl: isNullableString(value.sandboxUrl) ? value.sandboxUrl : null,
    sandboxId: isNullableString(value.sandboxId) ? value.sandboxId : null,
    indeterminateDelivery: value.indeterminateDelivery === true,
  };
}

function normalizeWorkflowSnapshot(value: unknown): ChannelWorkflowSnapshot | null {
  if (!isRecord(value) || typeof value.planned !== "boolean") return null;
  return {
    planned: value.planned,
    startReason: isNullableString(value.startReason) ? value.startReason : null,
    startedAt: isNullableNumber(value.startedAt) ? value.startedAt : null,
    startFailedAt: isNullableNumber(value.startFailedAt) ? value.startFailedAt : null,
  };
}

function normalizeTransitionRecords(value: unknown): ChannelDeliveryTransitionRecord[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is Record<string, unknown> => isRecord(entry))
    .map((entry) => {
      const from = entry.from === "*" || isChannelDeliveryState(entry.from) ? entry.from : null;
      const event = isChannelDeliveryEvent(entry.event) ? entry.event : null;
      const to = isChannelDeliveryState(entry.to) ? entry.to : null;
      if (!from || !event || !to || typeof entry.at !== "number") return null;
      return {
        from,
        event,
        to,
        at: entry.at,
        reason: isNullableString(entry.reason) ? entry.reason : null,
      } satisfies ChannelDeliveryTransitionRecord;
    })
    .filter((entry): entry is ChannelDeliveryTransitionRecord => entry !== null)
    .slice(-TRANSITION_HISTORY_LIMIT);
}

export function isChannelDeliverySnapshot(value: unknown): value is ChannelDeliverySnapshot {
  return normalizeChannelDeliverySnapshot(value) !== null;
}

export function normalizeChannelDeliverySnapshot(
  value: unknown,
): ChannelDeliverySnapshot | null {
  if (!isRecord(value)) return null;
  if (value.version !== 1) return null;
  if (typeof value.channel !== "string" || !isChannelName(value.channel)) return null;
  if (!isChannelDeliveryState(value.state)) return null;
  if (!isChannelDeliveryFinality(value.finality)) return null;
  if (typeof value.updatedAt !== "number") return null;

  const reply = normalizeChannelUserVisibleReply(value.reply);
  const terminal = isChannelDeliveryTerminalState(value.state)
    ? true
    : typeof value.terminal === "boolean"
      ? value.terminal
      : false;

  return {
    version: 1,
    channel: value.channel,
    deliveryId: isNullableString(value.deliveryId) ? value.deliveryId : null,
    state: value.state,
    finality: value.finality,
    terminal,
    receivedAt: isNullableNumber(value.receivedAt) ? value.receivedAt : null,
    updatedAt: value.updatedAt,
    completedAt: isNullableNumber(value.completedAt) ? value.completedAt : null,
    source: isChannelDeliverySource(value.source) ? value.source : "legacy-projection",
    reason: isNullableString(value.reason) ? value.reason : null,
    routeOutcome: isNullableString(value.routeOutcome) ? value.routeOutcome : null,
    workflow: normalizeWorkflowSnapshot(value.workflow),
    fastPath: normalizeFastPathSnapshot(value.fastPath),
    native: normalizeNativeSnapshot(value.native),
    reply,
    notice: normalizeNoticeSnapshot(value.notice),
    transitions: normalizeTransitionRecords(value.transitions),
  };
}

function nativeFromLastForward(lastForward: ChannelLastForward): ChannelNativeAcceptanceSnapshot {
  return {
    ok: lastForward.ok,
    status: lastForward.status,
    classification: lastForward.classification,
    attempts: lastForward.attempts,
    totalMs: lastForward.totalMs,
    transport: lastForward.transport,
    sandboxUrl: lastForward.sandboxUrl,
    sandboxId: lastForward.sandboxId,
    completedAt: lastForward.completedAt,
  };
}

export function assertChannelDeliveryTransitionHistory(snapshot: ChannelDeliverySnapshot): void {
  let current: ChannelDeliveryState | null = null;
  for (const entry of snapshot.transitions) {
    if (entry.from === "*") {
      const transition = CHANNEL_DELIVERY_TRANSITIONS.find(
        (candidate) => candidate.from === "*" && candidate.event === entry.event && candidate.to === entry.to,
      );
      if (!transition) {
        throw new Error(`Illegal channel delivery transition history: * -> ${entry.event}`);
      }
      current = entry.to;
      continue;
    }
    if (current !== null && entry.from !== current) {
      throw new Error(
        `Illegal channel delivery transition history: expected from ${current}, got ${entry.from}`,
      );
    }
    const transition = findChannelDeliveryTransition(entry.from, entry.event);
    if (!transition || transition.to !== entry.to) {
      throw new Error(
        `Illegal channel delivery transition history: ${entry.from} -> ${entry.event} -> ${entry.to}`,
      );
    }
    current = entry.to;
  }
  if (current !== null && current !== snapshot.state) {
    throw new Error(
      `Illegal channel delivery transition history: final transition ${current} does not match state ${snapshot.state}`,
    );
  }
}

function buildTransitionHistory(input: {
  channel: ChannelName;
  deliveryId: string | null;
  now: number;
  receivedAt: number | null;
  source: ChannelDeliverySource;
  events: ChannelDeliveryEvent[];
  reasons?: Partial<Record<ChannelDeliveryEvent, string | null>>;
}): ChannelDeliveryTransitionRecord[] {
  let snapshot = createInitialChannelDeliverySnapshot({
    channel: input.channel,
    deliveryId: input.deliveryId,
    receivedAt: input.receivedAt,
    now: input.now,
    source: input.source,
  });
  for (const event of input.events) {
    snapshot = transitionChannelDelivery(snapshot, event, {
      updatedAt: input.now,
      reason: input.reasons?.[event] ?? snapshot.reason,
    });
  }
  return snapshot.transitions;
}

export function channelDeliveryFromLastForward(input: {
  channel: ChannelName;
  lastForward: ChannelLastForward;
  now?: number;
  source?: ChannelDeliverySource;
}): ChannelDeliverySnapshot {
  const now = input.now ?? Date.now();
  const lastForward = normalizeChannelLastForward(input.lastForward, now);
  if (!lastForward) {
    throw new Error("Cannot project invalid channel lastForward into delivery state.");
  }

  const reply = lastForward.userVisibleReply;
  const state: ChannelDeliveryState = lastForward.ok
    ? reply.status === "observed"
      ? "reply-observed"
      : "visibility-unknown"
    : "native-forward-failed";
  const terminal = state === "reply-observed" || state === "visibility-unknown";
  const reason = lastForward.ok
    ? reply.reason ?? (reply.status === "observed" ? "reply-observed" : "native-forward-only")
    : `last_forward_${lastForward.classification}`;
  const baseEvents: ChannelDeliveryEvent[] = lastForward.ok
    ? ["validated", "dedup-checked", "fast-path-eligible", "fast-path-started", "fast-path-accepted"]
    : [
        "validated",
        "dedup-checked",
        "workflow-planned",
        "wake-started",
        "native-forward-started",
        "native-forward-failed",
      ];
  const transitions = buildTransitionHistory({
    channel: input.channel,
    deliveryId: lastForward.deliveryId,
    now: lastForward.completedAt,
    receivedAt: lastForward.startedAt,
    source: input.source ?? "last-forward",
    events: state === "reply-observed" ? [...baseEvents, "reply-observed"] : baseEvents,
    reasons: {
      "fast-path-accepted": reason,
      "native-forward-failed": reason,
      "reply-observed": reason,
    },
  });

  return {
    version: 1,
    channel: input.channel,
    deliveryId: lastForward.deliveryId,
    state,
    finality: state === "native-forward-failed"
      ? "latest-attempt"
      : state === "visibility-unknown"
        ? "terminal-revisable"
        : "terminal",
    terminal,
    receivedAt: lastForward.startedAt,
    updatedAt: now,
    completedAt: terminal ? lastForward.completedAt : null,
    source: input.source ?? "last-forward",
    reason,
    routeOutcome: null,
    workflow: null,
    fastPath: null,
    native: nativeFromLastForward(lastForward),
    reply,
    notice: createDefaultNoticeSnapshot({
      state: "not-needed",
      reason,
    }),
    transitions,
  };
}

export function applyUserVisibleReplyToChannelDelivery(input: {
  current: ChannelDeliverySnapshot | null;
  channel: ChannelName;
  deliveryId: string | null;
  userVisibleReply: ChannelUserVisibleReply;
  fallbackLastForward?: ChannelLastForward | null;
  now?: number;
}): ChannelDeliverySnapshot | null {
  const now = input.now ?? Date.now();
  const current = normalizeChannelDeliverySnapshot(input.current);
  const fallback = input.fallbackLastForward
    ? channelDeliveryFromLastForward({
        channel: input.channel,
        lastForward: input.fallbackLastForward,
        now,
        source: "user-visible-reply",
      })
    : null;
  const base = current ?? fallback;
  if (!base || base.deliveryId !== input.deliveryId) return null;

  const userVisibleReply = normalizeChannelUserVisibleReply(input.userVisibleReply);
  if (!userVisibleReply) return null;

  const state: ChannelDeliveryState = userVisibleReply.status === "observed"
    ? "reply-observed"
    : "visibility-unknown";
  const terminal = true;
  const reason = userVisibleReply.reason ?? userVisibleReply.status;
  let transitionBase = base;
  let transitionEvent: ChannelDeliveryEvent | null = null;

  if (userVisibleReply.status === "observed") {
    transitionEvent = "reply-observed";
  } else if (userVisibleReply.status === "timed-out") {
    if (transitionBase.state === "visibility-unknown") {
      transitionBase = transitionChannelDelivery(transitionBase, "reply-observation-started", {
        source: "user-visible-reply",
        reason,
        reply: userVisibleReply,
        updatedAt: now,
      });
    }
    transitionEvent = "reply-observation-timeout";
  }

  const transitioned = transitionEvent && findChannelDeliveryTransition(transitionBase.state, transitionEvent)
    ? transitionChannelDelivery(transitionBase, transitionEvent, {
        source: "user-visible-reply",
        reason,
        reply: userVisibleReply,
        updatedAt: now,
        completedAt: now,
        finality: state === "visibility-unknown" ? "terminal-revisable" : "terminal",
      })
    : null;
  if (transitionEvent && !transitioned) return null;
  const transitions = transitioned?.transitions ?? base.transitions;

  return {
    ...base,
    state,
    source: "user-visible-reply",
    finality: state === "visibility-unknown" ? "terminal-revisable" : "terminal",
    terminal,
    reason,
    reply: userVisibleReply,
    completedAt: now,
    updatedAt: now,
    transitions,
  };
}

export function renderChannelDeliveryMermaid(): string {
  const lines = [
    "stateDiagram-v2",
    "    [*] --> received: webhook-received",
  ];
  for (const transition of CHANNEL_DELIVERY_TRANSITIONS) {
    if (transition.from === "*") continue;
    lines.push(`    ${transition.from} --> ${transition.to}: ${transition.event}`);
  }
  return `${lines.join("\n")}\n`;
}

export function allChannelDeliveryStatesDocumented(text: string): boolean {
  return CHANNEL_DELIVERY_STATES.every((state) => text.includes(state)) &&
    CHANNEL_NOTICE_STATES.every((state) => text.includes(state));
}

export function listChannelDeliveryExtensionChannels(): ChannelName[] {
  return CHANNEL_NAMES.filter((channel) => CHANNEL_DELIVERY_EXTENSIONS[channel]);
}
