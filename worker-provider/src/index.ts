import { join } from 'node:path';
import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import { AllocationJournal } from './journal.js';
import { createVercelWorkerProvider } from './provider.js';
import { registerHostAdmission } from './host-admission.js';

export default definePluginEntry({
  id: 'vercel-worker', name: 'Vercel Sandbox Worker',
  description: 'OpenClaw worker turns and Codex remote execution in disposable Vercel Sandboxes.',
  register(api) {
    if (process.env.OPENCLAW_HOST_ADMISSION_PATH) registerHostAdmission(api, process.env.OPENCLAW_HOST_ADMISSION_PATH);
    let journal: AllocationJournal | undefined;
    const provider = createVercelWorkerProvider({
      get journal() {
        return journal ??= new AllocationJournal(join(api.runtime.state.resolveStateDir(process.env), 'vercel-worker', 'allocations.sqlite'));
      },
    });
    api.registerWorkerProvider(provider);
    api.registerService({
      id: 'vercel-worker-journal', start() {},
      async stop() { await provider.dispose(); journal?.close(); },
    });
  },
});
