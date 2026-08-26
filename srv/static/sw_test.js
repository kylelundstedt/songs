'use strict';

const assert = require('node:assert/strict');
const cryptoModule = require('node:crypto');
const fs = require('node:fs');
const vm = require('node:vm');

const origin = 'http://songs.test';
const normalize = value => new URL(typeof value === 'string' ? value : value.url, origin).href;

class MemoryCache {
  constructor() { this.entries = new Map(); }
  async match(request) { const response=this.entries.get(normalize(request)); return response?.clone(); }
  async put(request, response) { this.entries.set(normalize(request), response.clone()); }
  async delete(request) { return this.entries.delete(normalize(request)); }
  async keys() { return [...this.entries.keys()].map(url => new Request(url)); }
}

class MemoryCacheStorage {
  constructor() { this.caches = new Map(); }
  async open(name) { if(!this.caches.has(name))this.caches.set(name,new MemoryCache());return this.caches.get(name); }
  async has(name) { return this.caches.has(name); }
  async delete(name) { return this.caches.delete(name); }
  async keys() { return [...this.caches.keys()]; }
}

const sha256 = body => cryptoModule.createHash('sha256').update(body).digest('hex');
const caches = new MemoryCacheStorage();
const listeners = new Map();
let manifest;
let failURL = '';
const bodies = new Map();

const context = vm.createContext({
  AbortController,
  console,
  crypto: cryptoModule.webcrypto,
  Request,
  Response,
  URL,
  caches,
  clearTimeout,
  fetch: async request => {
    const url = new URL(typeof request === 'string' ? request : request.url, origin);
    if(url.pathname === '/api/offline/library')return new Response(JSON.stringify(manifest),{status:200,headers:{'Content-Type':'application/json'}});
    const canonical = url.searchParams.get('url');
    if(canonical === failURL)return new Response('failure',{status:500,headers:{'Content-Type':'text/plain'}});
    const body=bodies.get(canonical);
    if(body===undefined)return new Response('missing',{status:404,headers:{'Content-Type':'text/plain'}});
    return new Response(body,{status:200,headers:{'Content-Type':canonical==='/api/catalog'?'application/json':'text/html; charset=utf-8'}});
  },
  self: {
    location:{origin},
    clients:{claim:async()=>{}},
    skipWaiting:async()=>{},
    addEventListener:(type,handler)=>listeners.set(type,handler)
  },
  setTimeout
});
context.globalThis = context;
vm.runInContext(fs.readFileSync('srv/static/sw.js','utf8'),context,{filename:'sw.js'});

async function dispatchMessage(data) {
  const messages=[];
  let work=Promise.resolve();
  listeners.get('message')({data,source:{postMessage:message=>messages.push(message)},waitUntil:promise=>{work=promise;}});
  await work;
  return messages;
}

(async()=>{
  const oldBody='<html>old songs</html>';
  const oldResource={url:'/songs',fetch_url:'/api/offline/resource?snapshot=old&url=%2Fsongs',fingerprint:sha256(oldBody)};
  const oldCache=await caches.open('songs-library-v1-old');
  await oldCache.put(new Request(origin+'/songs'),new Response(oldBody,{headers:{'Content-Type':'text/html'}}));
  const meta=await caches.open('songs-meta-v1');
  await meta.put('/__songs_offline__/active',new Response(JSON.stringify({schema:1,snapshot_id:'old',cache_name:'songs-library-v1-old',resource_count:1,resources:[oldResource],updated_at:'2026-08-26T00:00:00Z'}),{headers:{'Content-Type':'application/json'}}));

  const aboutBody='<html>new about</html>';
  bodies.set('/about',aboutBody);
  manifest={schema:1,snapshot_id:'new',resource_count:2,resources:[oldResource,{url:'/about',fetch_url:'/api/offline/resource?snapshot=new&url=%2Fabout',fingerprint:sha256(aboutBody)}]};
  failURL='/about';
  const failed=await dispatchMessage({type:'UPDATE_LIBRARY',job_id:'failed-update'});
  const afterFailure=await (await meta.match('/__songs_offline__/active')).json();
  assert.equal(afterFailure.snapshot_id,'old','failed update replaced active pointer');
  assert.equal(await caches.has('songs-library-v1-old'),true,'failed update deleted active cache');
  assert.equal((await caches.keys()).filter(name=>name.includes('failed-update')).length,0,'failed staging cache survived');
  assert.equal(failed.at(-1).type,'LIBRARY_CACHE_ERROR');
  assert.equal(failed.at(-1).preserved_active_snapshot,true);

  failURL='';
  const completed=await dispatchMessage({type:'UPDATE_LIBRARY',job_id:'successful-update'});
  const afterSuccess=await (await meta.match('/__songs_offline__/active')).json();
  assert.equal(afterSuccess.snapshot_id,'new');
  assert.equal(afterSuccess.resource_count,2);
  assert.equal(await caches.has('songs-library-v1-old'),false,'old cache was not cleaned after commit');
  assert.equal(completed.some(message=>message.type==='LIBRARY_CACHE_COMPLETE'),true);
  const active=await caches.open(afterSuccess.cache_name);
  assert.equal((await active.keys()).length,2);

  await active.delete(new Request(origin+'/about'));
  const status=await dispatchMessage({type:'GET_LIBRARY_STATUS',job_id:'status'});
  assert.equal(status.at(-1).type,'LIBRARY_CACHE_STATUS');
  assert.equal(status.at(-1).ready,false,'incomplete cache reported ready');

  await dispatchMessage({type:'REMOVE_LIBRARY',job_id:'remove'});
  assert.equal(await meta.match('/__songs_offline__/active'),undefined);
  assert.equal((await caches.keys()).some(name=>name.startsWith('songs-library-v1-')),false);
  console.log('service worker offline cache tests passed');
})().catch(error=>{console.error(error);process.exitCode=1;});
