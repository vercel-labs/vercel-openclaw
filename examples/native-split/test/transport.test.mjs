import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import {once} from 'node:events';
import {randomBytes, createHash} from 'node:crypto';
import {createServer, createControllerProvider} from '../src/server.mjs';

async function listen(server) {server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port;}
const control = {phase: 'ready', owner: {assertCurrent: async () => {}}, status: () => ({phase: 'ready'})};
test('HTTP forwarding preserves the complete binary payload and path', async t => {
  const payload = randomBytes(196613); let received;
  const native = http.createServer(async (req, res) => {const parts=[]; for await (const part of req) parts.push(part); received = {body: Buffer.concat(parts), url: req.url, auth: req.headers.authorization, routing: req.headers['x-vercel-affinity-id'], oidc: req.headers['x-vercel-oidc-token']}; res.end('native');});
  const port = await listen(native); const front = createServer({getController: req => {assert.equal(req.headers['x-vercel-oidc-token'], 'platform-workload-token'); return control;}, controlToken: 's'.repeat(32), port}); const exposed = await listen(front);
  t.after(() => {front.closeAllConnections();front.close();native.closeAllConnections();native.close();});
  const response = await fetch(`http://127.0.0.1:${exposed}/native/path?exact=a%2Fb`, {method: 'POST', body: payload, headers: {Authorization: 'Bearer native-auth', 'x-vercel-affinity-id': 'untrusted', 'x-vercel-oidc-token': 'platform-workload-token'}});
  assert.equal(await response.text(), 'native'); assert.equal(createHash('sha256').update(received.body).digest('hex'), createHash('sha256').update(payload).digest('hex'));
  assert.equal(received.url, '/native/path?exact=a%2Fb'); assert.equal(received.auth, 'Bearer native-auth'); assert.equal(received.routing, undefined); assert.equal(received.oidc, undefined);
});
test('WebSocket upgrade preserves early bytes in both directions', async t => {
  const nativeSockets = []; const native = http.createServer(); native.on('upgrade', (req, socket, head) => {nativeSockets.push(socket); socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\nSERVER-EARLY'); if (head.length) socket.write(head); socket.on('data', x => socket.write(x));});
  const port = await listen(native); const front = createServer({getController: () => control, port}); const exposed = await listen(front);
  const socket = net.connect(exposed, '127.0.0.1'); await once(socket, 'connect');
  t.after(() => {socket.destroy(); for (const remote of nativeSockets) remote.destroy(); front.close();native.close();});
  const received = new Promise((resolve,reject) => {let text=''; const timer=setTimeout(()=>reject(new Error('upgrade deadline')),3000); socket.on('data', chunk => {text+=chunk; if(text.includes('CLIENT-EARLY')&&text.includes('SERVER-EARLY')){clearTimeout(timer);resolve(text);}});});
  socket.write('GET / HTTP/1.1\r\nHost: local\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\nCLIENT-EARLY');
  assert.match(await received, /^HTTP\/1.1 101/);
});
test('unauthorized control requests cannot construct or allocate a controller', async t => {
  let created = false; const front = createServer({controlToken: 's'.repeat(32), getController: () => {created=true;throw new Error('unexpected');}}); const port=await listen(front);
  t.after(()=>{front.closeAllConnections();front.close();});
  const response=await fetch(`http://127.0.0.1:${port}/_split/bootstrap`,{method:'POST'}); assert.equal(response.status,401);assert.equal(created,false);
});
test('nonowner native HTTP is rejected before forwarding', async t => {
  let forwarded=false; const native=http.createServer((req,res)=>{forwarded=true;res.end();});const port=await listen(native);
  const front=createServer({port,getController:()=>({owner:{assertCurrent:async()=>{throw Object.assign(new Error('not owner'),{statusCode:503});}}})});const exposed=await listen(front);
  t.after(()=>{front.closeAllConnections();front.close();native.close();});
  assert.equal((await fetch(`http://127.0.0.1:${exposed}/`)).status,503);assert.equal(forwarded,false);
});

test('bootstrap captures its own identity once and keeps a booting or booted controller', async()=>{
  let count=0;let closed=0;
  const controllers=createControllerProvider(req=>({identity:req.headers['x-vercel-oidc-token'],number:++count,close:async()=>{closed++;}}));
  const request=(url,identity)=>({method:url==='/_split/bootstrap'?'POST':'GET',url,headers:{'x-vercel-oidc-token':identity}});
  const observed=controllers.get(request('/_split/status','status-token'));
  assert.equal(controllers.get(request('/native','native-token')),observed);
  const bootstrap=controllers.get(request('/_split/bootstrap','bootstrap-token'));
  assert.notEqual(bootstrap,observed);assert.equal(bootstrap.identity,'bootstrap-token');
  let finish;bootstrap.boot=new Promise(resolve=>{finish=resolve;});
  assert.equal(controllers.get(request('/_split/bootstrap','concurrent-token')),bootstrap);
  finish();await bootstrap.boot;
  assert.equal(controllers.get(request('/_split/bootstrap','later-token')),bootstrap);
  assert.equal(count,2);await controllers.close();assert.equal(closed,1);
});
