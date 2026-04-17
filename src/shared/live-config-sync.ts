/**
 * Shared types and header constants for live config sync outcomes.
 *
 * Used by both server (route-factory, lifecycle) and client (admin UI)
 * to communicate whether a gateway config update took effect on the
 * running sandbox.
 */

export const LIVE_CONFIG_SYNC_OUTCOME_HEADER =
  "x-openclaw-live-config-sync-outcome";
export const LIVE_CONFIG_SYNC_MESSAGE_HEADER =
  "x-openclaw-live-config-sync-message";

export type LiveConfigSyncOutcome = "skipped" | "applied" | "degraded" | "failed";

export type LiveConfigSyncResult =
  | {
      outcome: "skipped";
      reason: "sandbox_not_running";
      liveConfigFresh: false;
      operatorMessage: null;
    }
  | {
      outcome: "applied";
      reason: "config_written_and_restarted";
      liveConfigFresh: true;
      operatorMessage: null;
    }
  | {
      outcome: "degraded";
      reason: "config_written_restart_failed";
      liveConfigFresh: false;
      operatorMessage: string;
    }
  | {
      outcome: "failed";
      reason: string;
      liveConfigFresh: false;
      operatorMessage: string;
    };
