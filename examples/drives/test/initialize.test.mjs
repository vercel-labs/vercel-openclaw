import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { initializeDrive, prepareDriveScript } from '../dist/initialize.js';
import { MOUNT } from '../dist/config.js';

const require = createRequire(import.meta.url);
const settings = { credentials: {token:'token',projectId:'prj_test',teamId:'team_test'},gatewayKey:'never-in-initializer' };
function fixture(exitCode=0) {
  const calls=[];const drive={name:'openclaw-test',driveId:'drive-test'};
  const sandbox={name:'init-test',image:'managed@sha256:test',persistent:false,mounts:{[MOUNT]:drive},
    currentSession:()=>({sessionId:'init-session'}),
    runCommand:async p=>{calls.push(['command',p]);return {cmdId:'cmd-init',exitCode,stdout:async()=>exitCode?'':'drive-prepared',stderr:async()=>exitCode?'refused':''}},
    stop:async()=>{calls.push(['stop'])}};
  const services={drive:async()=>drive,create:async p=>{calls.push(['create',p]);return sandbox}};
  const receipt={event(){}};return {calls,services,receipt};
}
test('initializer uses separate managed compute without credentials or network egress, then releases Drive',async()=>{
  const f=fixture();const result=await initializeDrive(settings,'test',f.receipt,f.services);
  const opts=f.calls.find(x=>x[0]==='create')[1];
  assert.equal(opts.networkPolicy,'deny-all');assert.equal(opts.persistent,false);assert.equal(opts.env,undefined);
  assert(!JSON.stringify(opts).includes(settings.gatewayKey));assert.equal(opts.image,'vercel/sandbox/node:24');
  assert.equal(f.calls.find(x=>x[0]==='command')[1].sudo,true);
  assert.equal(result.detached,true);assert(f.calls.some(x=>x[0]==='stop'));
});
test('initializer failure preserves sandbox and Drive for inspection',async()=>{
  const f=fixture(1);await assert.rejects(initializeDrive(settings,'test',f.receipt,f.services),/resources preserved/);
  assert(!f.calls.some(x=>x[0]==='stop'));
});
test('preparation refuses existing user content and nonempty or linked recovery directories before any writes',()=>{
  for(const variant of ['user-content','recovered-file','linked-recovery']) {
    const root=realpathSync(mkdtempSync(join(tmpdir(),'openclaw-prepare-')));
    const saved=join(root,'keep');writeFileSync(saved,'preserve');
    if(variant==='recovered-file') {mkdirSync(join(root,'lost+found'));require('node:fs').renameSync(saved,join(root,'lost+found','keep'))}
    if(variant==='linked-recovery') symlinkSync(saved,join(root,'lost+found'));
    const before=readdirSync(root);
    assert.throws(()=>runInNewContext(prepareDriveScript,{require,process:{getuid:()=>0,argv:['node',root]},console}),/Unrecognized Drive|Unexpected recovery/);
    assert.deepEqual(readdirSync(root),before);
    assert.equal(readFileSync(variant==='recovered-file'?join(root,'lost+found','keep'):saved,'utf8'),'preserve');
  }
});
