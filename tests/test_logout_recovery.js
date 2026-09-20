'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function savesEnvironment(saved,entries){
 const storage=new Map(Object.entries(saved)), notices=new Map(),events={};
 const env={console,Response,AbortController,setTimeout,clearTimeout,location:{reload(){}},
 localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k),key:i=>Array.from(storage.keys())[i],get length(){return storage.size}},
 addEventListener:(k,f)=>events[k]=f,LearnUI:{set:(k,...v)=>notices.set(k,v),clear:k=>notices.delete(k)},
 LearnUser:{userId:'u0',user:{id:'u0'},ready:Promise.resolve(),apiBase:'http://localhost:8101',fetch:async()=>Response.json({entries})}};
 env.window=env;vm.createContext(env);vm.runInContext(fs.readFileSync('shared/saves.js','utf8'),env);return {env,storage,notices,events};
}
(async()=>{
 const gone='u0/learn-path-v1-gone',keep='u0/learn-path-v1-keep',ai='u0/learn-ai-v1-gone',draft='quiz-draft-v1:'+JSON.stringify([gone,'n1','r1']),other='quiz-draft-v1:'+JSON.stringify(['u-other/learn-path-v1-gone','n1','r1']);
 const x=savesEnvironment({'learn-unsaved-v1/u0':JSON.stringify({[gone]:'old',[keep]:'new',[ai]:'old ai'}),[draft]:'answers',[other]:'others'}, {[gone]:null});await x.env.LearnUser.ready;
 assert.deepEqual(JSON.parse(x.storage.get('learn-unsaved-v1/u0')),{[keep]:'new'});assert(!x.storage.has(draft));assert(x.storage.has(other));assert(x.env.LearnSaves.pending());
 x.env.LearnSaves.prepareExit();let blocked=false;x.events.beforeunload({preventDefault(){blocked=true}});assert(!blocked);assert(x.storage.has('learn-unsaved-v1/u0'));x.env.LearnSaves.cancelExit();x.events.beforeunload({preventDefault(){blocked=true}});assert(blocked);
 const y=savesEnvironment({'learn-unsaved-v1/u0':JSON.stringify({[gone]:'old'})},{[gone]:null});await y.env.LearnUser.ready;assert(!y.env.LearnSaves.pending());let sends=0;const old=await y.env.LearnSaves.send({body:JSON.stringify({entries:{[gone]:'late'}})},async()=>{sends++;return Response.json({ok:true})});assert.equal(old.status,409);assert.equal(sends,0);assert(!y.env.LearnSaves.pending());
 const renamed=savesEnvironment({'learn-unsaved-v1/u0':JSON.stringify({[keep]:JSON.stringify({topic:'原始输入',title:'旧标题'})})},{[keep]:JSON.stringify({topic:'原始输入',title:'正式标题'})});await renamed.env.LearnUser.ready;assert(!renamed.env.LearnSaves.pending(),'server-owned title differences do not trap an acknowledged snapshot');
 const unknown=savesEnvironment({'learn-unsaved-v1/u0':JSON.stringify({[keep]:'offline'})},{});await unknown.env.LearnUser.ready;assert(unknown.env.LearnSaves.pending());unknown.env.localStorage.setItem=()=>{throw new Error('quota')};assert.throws(()=>unknown.env.LearnSaves.prepareExit(),/本机草稿/);
 const expired=savesEnvironment({},{});await expired.env.LearnUser.ready;await expired.env.LearnSaves.send({body:JSON.stringify({entries:{[keep]:'offline'}})},async()=>Response.json({error:'expired'},{status:401}));assert.equal(expired.notices.get('state-save')[3],'重新登录');assert(expired.env.LearnSaves.pending());
 const concurrent=savesEnvironment({},{});await concurrent.env.LearnUser.ready;let resolve;
 const first=concurrent.env.LearnSaves.send({body:JSON.stringify({entries:{[keep]:'old'}})},()=>new Promise(r=>resolve=r));
 const second=concurrent.env.LearnSaves.send({body:JSON.stringify({entries:{[keep]:'new'}})},async()=>Response.json({error:'offline'},{status:503}));resolve(Response.json({ok:true}));await first;await second;assert.equal(JSON.parse(concurrent.storage.get('learn-unsaved-v1/u0'))[keep],'new');
 async function logoutCase(alive,pending,confirmValue){
  const calls=[],events=[],env={console,URL,Headers,Response,AbortController,Event,setTimeout,clearTimeout,location:{href:'http://localhost/learn/',pathname:'/learn/',protocol:'http:',hostname:'localhost'},document:{readyState:'loading',addEventListener(){}},addEventListener(){},dispatchEvent:e=>events.push(e.type),confirm:()=>confirmValue};
  let initial=true;env.fetch=async(url)=>{calls.push(url);if(url.endsWith('/auth/session')){const user=initial?null:alive?{id:'u0'}:null;initial=false;return Response.json({ok:true,user})}return Response.json({ok:true})};
  env.window=env;vm.createContext(env);vm.runInContext(fs.readFileSync('shared/user-session.js','utf8'),env);await env.LearnUser.ready;
  let prepared=0;env.LearnSaves={pending:()=>pending,refresh:async()=>{},prepareExit:()=>prepared++,cancelExit(){}};
  const one=env.LearnUser.logout(),two=env.LearnUser.logout();assert.equal(one,two);await one;return {calls,events,env,prepared};
 }
 const logged=await logoutCase(false,true,false);assert.equal(logged.prepared,1);assert.equal(logged.env.location.href,'/learn/');assert(!logged.events.includes('pagehide'));assert.equal(logged.calls.filter(x=>x.endsWith('/auth/logout')).length,1);
 const cancelled=await logoutCase(true,true,false);assert.equal(cancelled.prepared,0);assert(!cancelled.calls.some(x=>x.endsWith('/auth/logout')));
 const preserved=await logoutCase(true,true,true);assert.equal(preserved.prepared,1);assert(preserved.events.includes('pagehide'));
 console.log('PASS tombstone recovery, account isolation, unavailable storage, expired session logout, retained drafts and logout cancellation');
})().catch(e=>{console.error(e);process.exitCode=1});
