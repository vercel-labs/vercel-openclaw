export type WorkerSandboxVcpus = 1 | 2 | 4 | 8;

export type WorkerSandboxFile = {
  path: string;
  contentBase64: string;
};

export type WorkerSandboxExecuteRequest = {
  task: string;
  files?: WorkerSandboxFile[];
  command: {
    cmd: string;
    args?: string[];
    env?: Record<string, string>;
  };
  capturePaths?: string[];
  vcpus?: WorkerSandboxVcpus;
  sandboxTimeoutMs?: number;
};

export type WorkerSandboxCapturedFile = {
  path: string;
  contentBase64: string;
};

export type WorkerSandboxExecuteResponse = {
  ok: boolean;
  task: string;
  sandboxId: string | null;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  capturedFiles: WorkerSandboxCapturedFile[];
  error?: string;
};

// ---------------------------------------------------------------------------
// Batch types
// ---------------------------------------------------------------------------

export type WorkerSandboxBatchJob = {
  id: string;
  request: WorkerSandboxExecuteRequest;
};

export type WorkerSandboxBatchExecuteRequest = {
  task: string;
  jobs: WorkerSandboxBatchJob[];
  maxConcurrency?: number;
  continueOnError?: boolean;
  passAiGatewayKey?: boolean;
};

export type WorkerSandboxBatchJobResult = {
  id: string;
  result: WorkerSandboxExecuteResponse;
};

export type WorkerSandboxBatchExecuteResponse = {
  ok: boolean;
  task: string;
  totalJobs: number;
  succeeded: number;
  failed: number;
  results: WorkerSandboxBatchJobResult[];
};
