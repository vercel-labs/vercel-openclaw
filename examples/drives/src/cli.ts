import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { agentDriveName, redact, sessionId, settingsFromEnv, VERSION } from './config.js';
import { Receipt } from './receipt.js';
import { initializeDrive } from './initialize.js';
import { AgentRun } from './runtime.js';
import { verifyRestart } from './verify.js';

let receipt: Receipt | undefined;
let secrets: string[] = [];
try {
  const { values, positionals, tokens } = parseArgs({ allowPositionals: true, tokens: true, options: {
    'env-file': { type: 'string' }, name: { type: 'string' }, session: { type: 'string', default: 'main' },
    message: { type: 'string' }, results: { type: 'string', default: 'results' }, help: { type: 'boolean' },
  } });
  const seen = new Set<string>();
  for (const token of tokens) {
    if (token.kind !== 'option') continue;
    if (seen.has(token.name)) throw new Error(`Duplicate option --${token.name}.`);
    seen.add(token.name);
  }

  const command = positionals[0];
  if (values.help || !command) {
    console.log('Commands: preflight | init --name NAME | verify | agent --name NAME --message TEXT [--session NAME]\nOptions: --env-file PATH, --results DIR\nEvery agent invocation starts fresh compute, reuses its Drive, completes one turn, and stops cleanly.');
  } else {
    if (!['preflight','init','verify','agent'].includes(command) || positionals.length !== 1) throw new Error('Unknown command. Use --help.');
    const allowed = new Set(['env-file', 'help', ...(command === 'preflight' ? [] : ['results']), ...(command === 'agent' ? ['name', 'message', 'session'] : command === 'init' ? ['name'] : [])]);
    for (const name of seen) if (!allowed.has(name)) throw new Error(`--${name} does not apply to ${command}.`);
    if (command === 'init') {
      if (!values.name) throw new Error('init requires --name.');
      agentDriveName(values.name);
    }
    if (command === 'agent') {
      if (!values.name || !values.message) throw new Error('agent requires --name and --message.');
      agentDriveName(values.name);
      sessionId(values.session!);
    }
    const envFile = values['env-file'] ?? (existsSync('.env.local') ? '.env.local' : undefined);
    if (envFile && !existsSync(envFile)) throw new Error('Environment file is missing. Run vercel env pull in the linked project.');
    if (envFile) loadEnvFile(resolve(envFile));
    const settings = settingsFromEnv(process.env);
    secrets = [settings.credentials.token, settings.gatewayKey];
    if (command === 'preflight') {
      console.log(JSON.stringify({ status: 'local-preflight-passed', release: VERSION, image: settings.image,
        model: settings.model, projectId: settings.credentials.projectId, remoteAccess: 'NOT_TESTED' }, null, 2));
    } else {
      receipt = new Receipt(resolve(values.results!), secrets);
      console.log(`Evidence: ${receipt.directory}`);
      receipt.event('run-start', { command, release: VERSION, image: settings.image, model: settings.model,
        projectId: settings.credentials.projectId, teamId: settings.credentials.teamId });
      if (command === 'init') {
        const initialized = await initializeDrive(settings, values.name!, receipt);
        receipt.finish('passed', initialized);
        console.log('Drive prepared and detached. Agent sessions can now use it.');
      } else if (command === 'verify') {
        const checks = await verifyRestart(settings, receipt);
        receipt.finish('passed', checks);
        console.log('PASS: fresh VM recovered state, conversation, memory file and workspace.');
      } else {
        const run = await AgentRun.attach(settings, values.name!, receipt);
        await run.start();
        const reply = await run.turn(sessionId(values.session!), values.message!);
        await run.quiesce();
        await run.stop();
        receipt.finish('passed', { drive: run.drive.name, sandbox: run.sandbox.name, image: run.sandbox.image,
          sessionId: run.sandbox.currentSession().sessionId, conversation: values.session, cleanShutdown: true });
        console.log(reply.text);
      }
    }
  }
} catch (error) {
  const message = redact(error instanceof Error ? error.message : String(error), secrets);
  receipt?.event('failure', { message });
  receipt?.finish('failed', { message, resourcesPreserved: true, nextStep: 'Inspect events.jsonl; no resources were deleted.' });
  console.error(message);
  if (receipt) console.error(`Evidence and resource IDs: ${receipt.directory}`);
  process.exitCode = 1;
}
