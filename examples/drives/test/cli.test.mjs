import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const cli = new URL('../dist/cli.js',import.meta.url).pathname;
test('missing env file is rejected with no cloud allocation and a readable error',()=>{
  const result=spawnSync(process.execPath,['--',cli,'preflight','--env-file','/tmp/openclaw-intentionally-missing-credential-file'],{encoding:'utf8'});
  assert.equal(result.status,1);assert.match(result.stderr,/Environment file is missing/);
  assert(!result.stdout.includes('Evidence:'));
});
test('help needs no credentials',()=>{
  const result=spawnSync(process.execPath,['--',cli,'--help'],{encoding:'utf8',env:{PATH:process.env.PATH}});
  assert.equal(result.status,0);assert.match(result.stdout,/preflight/);
});

test('duplicate and command-inapplicable flags fail before credentials or allocation',()=>{
  for(const args of [
    ['agent','--name','a','--message','first','--message','second'],
    ['preflight','--name','a'],['verify','--session','other'],['preflight','--results','elsewhere'],
  ]) {
    const result=spawnSync(process.execPath,['--',cli,...args],{encoding:'utf8',env:{PATH:process.env.PATH}});
    assert.equal(result.status,1);assert.match(result.stderr,/Duplicate option|does not apply/);
    assert(!result.stdout.includes('Evidence:'));
  }
});
