/**
 * Behavior probes for two review findings. No OpenClaw involved — these are
 * platform/SDK semantics, so the default runtime image is enough.
 *
 * N1: is extendTimeout(d) ADDITIVE (timeout += d, anchored at session start)
 *     or an absolute reset (deadline = now + d)?
 *     Matters because the webhook path calls it per message.
 *
 * N3: does onResume fire DURING the first runCommand (after the 410
 *     sandbox-stopped retry) rather than at Sandbox.get time — and does the
 *     retried command therefore execute before an onResume-spawned server can
 *     bind? That is the mechanism behind "first health probe always fails".
 *
 * Usage from host/:  npx tsx --env-file=.env.local scripts/sdk-probe.ts
 */
import { Sandbox } from '@vercel/sandbox';

const NAME = `sdk-probe-review-${Date.now()}`;
const TIMEOUT_MS = 5 * 60 * 1000;
const EXTEND_BY_MS = 5 * 60 * 1000;

const ms = (n: number) => `${(n / 1000).toFixed(1)}s`;
const line = (s: string) => console.log(s);

async function main() {
  line(`sandbox name: ${NAME}`);
  let sandbox: Sandbox | undefined;

  try {
    // ---------- N1: extendTimeout semantics ----------
    line(`\n${'='.repeat(62)}\nN1  extendTimeout: additive or absolute reset?\n${'='.repeat(62)}`);
    const tCreate = Date.now();
    sandbox = await Sandbox.create({ name: NAME, timeout: TIMEOUT_MS });
    line(`created in ${ms(Date.now() - tCreate)}, status=${sandbox.status}`);

    const exp0 = sandbox.expiresAt?.getTime();
    line(`\nconfigured timeout      : ${ms(TIMEOUT_MS)}`);
    line(`sandbox.timeout         : ${sandbox.timeout !== undefined ? ms(sandbox.timeout) : '(undefined)'}`);
    line(`expiresAt (T0)          : ${sandbox.expiresAt?.toISOString()}`);
    line(`T0 - now                : ${exp0 ? ms(exp0 - Date.now()) : 'n/a'}`);

    line(`\n-> extendTimeout(${ms(EXTEND_BY_MS)})  [call #1]`);
    const tExtend1 = Date.now();
    await sandbox.extendTimeout(EXTEND_BY_MS);
    const exp1 = sandbox.expiresAt?.getTime();
    line(`sandbox.timeout         : ${sandbox.timeout !== undefined ? ms(sandbox.timeout) : '(undefined)'}`);
    line(`expiresAt (T1)          : ${sandbox.expiresAt?.toISOString()}`);
    line(`T1 - now                : ${exp1 ? ms(exp1 - Date.now()) : 'n/a'}`);
    const delta1 = exp0 && exp1 ? exp1 - exp0 : undefined;
    line(`T1 - T0 (the verdict)   : ${delta1 !== undefined ? ms(delta1) : 'n/a'}`);
    const elapsed1 = Date.now() - tExtend1;

    line(`\n-> extendTimeout(${ms(EXTEND_BY_MS)})  [call #2 — does it accumulate?]`);
    await sandbox.extendTimeout(EXTEND_BY_MS);
    const exp2 = sandbox.expiresAt?.getTime();
    line(`sandbox.timeout         : ${sandbox.timeout !== undefined ? ms(sandbox.timeout) : '(undefined)'}`);
    line(`expiresAt (T2)          : ${sandbox.expiresAt?.toISOString()}`);
    line(`T2 - now                : ${exp2 ? ms(exp2 - Date.now()) : 'n/a'}`);
    const delta2 = exp1 && exp2 ? exp2 - exp1 : undefined;
    line(`T2 - T1                 : ${delta2 !== undefined ? ms(delta2) : 'n/a'}`);

    line('');
    if (delta1 !== undefined && Math.abs(delta1 - EXTEND_BY_MS) < 30_000) {
      line(`N1 VERDICT: ADDITIVE. Deadline moved by ~the full ${ms(EXTEND_BY_MS)} argument,`);
      line(`            not to now+${ms(EXTEND_BY_MS)}. Total runway is now ${exp2 ? ms(exp2 - Date.now()) : '?'}`);
      line(`            from a ${ms(TIMEOUT_MS)} sandbox after 2 calls => per-message calls accumulate.`);
    } else if (delta1 !== undefined && Math.abs(delta1 - (EXTEND_BY_MS - elapsed1)) < 30_000) {
      line(`N1 VERDICT: ABSOLUTE RESET. Deadline became now+${ms(EXTEND_BY_MS)}; N1 is WRONG.`);
    } else {
      line(`N1 VERDICT: INCONCLUSIVE — delta ${delta1 !== undefined ? ms(delta1) : 'n/a'} matches neither model.`);
    }

    // ---------- N3: onResume ordering vs the retried command ----------
    line(`\n${'='.repeat(62)}\nN3  onResume ordering, and whether the retried command races it\n${'='.repeat(62)}`);
    line('stopping the sandbox so the next call must resume it...');
    await sandbox.stop();
    line(`stopped. status=${sandbox.status}`);

    const t: Record<string, number> = {};
    t.getStart = Date.now();
    // resume omitted => the API default (false) applies => no eager resume.
    const resumed = await Sandbox.get({
      name: NAME,
      onResume: async (sbx) => {
        t.onResumeStart = Date.now();
        // Stand-in for startGateway: a detached server that needs ~4s to bind,
        // exactly like a real gateway process that must boot before listening.
        await sbx.runCommand({
          cmd: 'sh',
          args: [
            '-c',
            `nohup node -e "setTimeout(()=>require('http').createServer((q,s)=>s.end('ok')).listen(3000),4000)" > /tmp/binder.log 2>&1 &`,
          ],
          detached: true,
        });
        t.onResumeEnd = Date.now();
      },
    });
    t.getEnd = Date.now();
    line(`Sandbox.get returned in ${ms(t.getEnd - t.getStart)}, status=${resumed.status}`);
    line(`onResume fired during get()? ${t.onResumeStart !== undefined ? 'YES' : 'NO'}`);

    line(`\nnow issuing the first runCommand — a "health probe" against port 3000`);
    t.cmdStart = Date.now();
    const probe = await resumed.runCommand({
      cmd: 'node',
      args: [
        '-e',
        `require('http').get({host:'127.0.0.1',port:3000,timeout:1500},r=>{console.log('BOUND '+r.statusCode);process.exit(0)}).on('error',e=>{console.log('NOT_BOUND '+e.code);process.exit(1)})`,
      ],
    });
    t.cmdEnd = Date.now();

    line(`\n--- timeline (ms relative to Sandbox.get start) ---`);
    const rel = (k: string) => (t[k] !== undefined ? `+${t[k] - t.getStart}ms` : 'never');
    line(`  Sandbox.get start        ${rel('getStart')}`);
    line(`  Sandbox.get returned     ${rel('getEnd')}`);
    line(`  runCommand issued        ${rel('cmdStart')}`);
    line(`  onResume START           ${rel('onResumeStart')}`);
    line(`  onResume END (spawned)   ${rel('onResumeEnd')}`);
    line(`  runCommand returned      ${rel('cmdEnd')}`);
    line(`\nprobe exitCode=${probe.exitCode}  stdout=${(await probe.stdout()).trim()}`);

    const onResumeAfterCmdIssued =
      t.onResumeStart !== undefined && t.cmdStart !== undefined && t.onResumeStart > t.cmdStart;
    const gapAfterSpawn = t.onResumeEnd !== undefined ? t.cmdEnd - t.onResumeEnd : undefined;

    line('');
    line(`N3 VERDICT:`);
    line(`  onResume fired during the runCommand (not at get)?  ${onResumeAfterCmdIssued ? 'YES' : 'NO'}`);
    line(`  probe ran ${gapAfterSpawn !== undefined ? ms(gapAfterSpawn) : '?'} after the server was spawned`);
    line(`  probe result: ${probe.exitCode === 0 ? 'BOUND (would pass)' : 'NOT BOUND (health probe would FAIL)'}`);

    // Show it does bind shortly after, i.e. the failure is purely a race.
    line(`\n  polling to confirm the server binds a moment later...`);
    for (let i = 1; i <= 5; i++) {
      const again = await resumed.runCommand({
        cmd: 'node',
        args: [
          '-e',
          `require('http').get({host:'127.0.0.1',port:3000,timeout:1500},r=>{console.log('BOUND');process.exit(0)}).on('error',e=>{console.log('NOT_BOUND');process.exit(1)})`,
        ],
      });
      line(`    attempt ${i}: exit=${again.exitCode} ${(await again.stdout()).trim()}`);
      if (again.exitCode === 0) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
  } finally {
    if (sandbox) {
      try {
        const s = await Sandbox.get({ name: NAME, resume: false });
        if (s.status === 'running') {
          await s.stop();
          line(`\ncleanup: stopped ${NAME}`);
        } else {
          line(`\ncleanup: ${NAME} already ${s.status}`);
        }
      } catch (err) {
        line(`\ncleanup WARNING for ${NAME}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}

main().catch((err) => {
  console.error('\nPROBE FAILED:', err);
  process.exit(1);
});
