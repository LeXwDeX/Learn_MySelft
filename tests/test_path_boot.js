'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => {resolve=a;reject=b;}); return {promise,resolve,reject}; };
const tick = async () => { for(let i=0;i<15;i++) await Promise.resolve(); };
function harness(search='?t=original') {
  const modules={}, calls=[], timers=new Map();let timer=0, reply=async()=>Response.json({ok:true,entries:{'u/learn-path-v1-original':JSON.stringify({topic:'original',materials:[{name:'old.txt',text:'old'}]})}});
  const elements={};
  function element(id) { return elements[id] ||= {value:'typed while waiting',disabled:false,textContent:'',innerHTML:'',children:[],focus(){},appendChild(n){this.children.push(n);},hidden:false}; }
  const env={console,AbortController,Response,Blob,URLSearchParams,location:{search},setTimeout(fn,ms){const id=++timer;timers.set(id,{fn,ms});return id;},clearTimeout(id){timers.delete(id);},
    document:{addEventListener(){},createElement(){return {remove(){}};}},
    window:{addEventListener(){},LearnUser:{apiBase:'',userId:'u',readOnly:false,fetch(url,options){calls.push({url,options});return url.endsWith('/state/all')?reply(options):Promise.resolve(Response.json({ok:true}));}},LearnTitles:{document:d=>d.title||d.topic||'title'},LearnJobs:{requestId:()=> 'synthetic-request',supports:()=>false}},
    define(name,names,factory){modules[name]=factory(modules);}};
  vm.createContext(env);vm.runInContext(fs.readFileSync('learning-path/modules/path-model.js','utf8'),env);
  const model=modules['path.model'];
  modules['path.format']={$:element,slug:s=>s,entryVal:(entries,key)=>entries['u/'+key],storeKey:()=> 'u/learn-path-v1-'+(model.session.materialSlug||model.state.topic),aiKey:()=> 'u/learn-ai-v1-'+model.session.materialSlug};
  modules['path.hooks']={renderDocumentTitle(){},renderPlan(){}};modules['path.domain']={};
  vm.runInContext(fs.readFileSync('learning-path/modules/path-persistence.js','utf8'),env);
  modules['path.shell']={hideError(){},showError(){}};
  vm.runInContext(fs.readFileSync('learning-path/modules/path-workflow.js','utf8'),env);
  const persistence=modules['path.persistence'],workflow=modules['path.workflow'];
  return {model,persistence,workflow,env,calls,elements,element,timers,setReply(fn){reply=fn;},expire(){[...timers.values()].filter(t=>t.ms===model.session.TIMEOUT).forEach(t=>t.fn());}};
}
(async()=>{
  {
    const h=harness(),gate=deferred();h.setReply(()=>gate.promise);
    const loading=h.persistence.serverLoad();await tick();
    h.workflow.setChatDisabled(false);h.workflow.sendMessage();h.model.state.topic='untrusted temporary state';h.persistence.save();h.persistence.saveAi();await assert.rejects(h.persistence.putState({'u/wrong':'no'}),error=>error.code==='state_write_blocked');h.persistence.flushBeacon();
    await assert.rejects(h.persistence.post('/path/intake',{}),/尚未准备/);
    assert.equal(h.element('chat-input').value,'typed while waiting');assert(h.element('chat-send').disabled);assert.equal(h.calls.length,1);
    gate.resolve(Response.json({ok:true,entries:{'u/learn-path-v1-original':JSON.stringify({topic:'restored',materials:[{name:'old.txt',text:'old'}]})}}));
    assert.equal(await loading,true);assert.equal(h.model.session.materialSlug,'original');assert.equal(h.model.state.topic,'restored');assert.equal(h.model.session.bootState,'ready');
    h.workflow.setChatDisabled(false);assert.equal(h.element('chat-send').disabled,false);
    h.persistence.save();await h.persistence.flushSave();
    const writes=h.calls.filter(c=>c.url.endsWith('/state/put')).map(c=>JSON.parse(c.options.body).entries);
    assert(writes.some(e=>e['u/learn-path-v1-original']));assert(!writes.some(e=>e['u/learn-path-v1-untrusted temporary state']));
  }
  for (const state of ['loading','error']) {
    const h=harness('?new=1');await h.persistence.serverLoad();h.model.state.topic='pending draft';h.model.session.materialSlug='draft';h.persistence.save();
    h.model.session.bootState=state;
    const timer=[...h.timers.values()].find(t=>t.ms===350);timer.fn();await tick();
    await assert.rejects(h.persistence.flushSave(),error=>error.code==='state_write_blocked');assert.equal(h.calls.length,0);
    h.model.session.bootState='ready';await h.persistence.flushSave();assert.equal(h.calls.length,1);
    const saved=JSON.parse(h.calls[0].options.body).entries;assert.equal(JSON.parse(saved['u/learn-path-v1-draft']).topic,'pending draft');
  }
  {
    const h=harness('?new=1');await h.persistence.serverLoad();h.model.state.topic='queued';h.model.session.materialSlug='queued';h.persistence.save();
    h.env.window.LearnUser.fetch=async(url,options)=>{h.calls.push({url,options});throw Error('offline');};
    const flushing=h.persistence.flushSave().catch(error=>error);await tick();
    h.model.session.loadGeneration++;h.model.session.materialSlug='other';
    [...h.timers.values()].filter(t=>t.ms===1500).forEach(t=>t.fn());
    assert.equal((await flushing).code,'state_write_stale');assert.equal(h.calls.length,1,'stale retry must not dispatch');
    await assert.rejects(h.persistence.flushSave(),error=>error.code==='state_write_stale');
    h.model.session.materialSlug='queued';h.env.window.LearnUser.fetch=async(url,options)=>{h.calls.push({url,options});return Response.json({ok:true});};
    await h.persistence.flushSave();assert.equal(h.calls.length,2,'failed snapshot remains available for an explicit retry on its original identity');
  }
  for(const [name,response] of [
    ['http',()=>Response.json({error:'bad'},{status:503})],['json',()=>new Response('{')],['envelope',()=>Response.json({ok:false,entries:{}})],['missing',()=>Response.json({ok:true,entries:{}})],
    ['malformed',()=>Response.json({ok:true,entries:{'u/learn-path-v1-original':'[]'}})],
    ['topic',()=>Response.json({ok:true,entries:{'u/learn-path-v1-original':JSON.stringify({materials:[]})}})],
    ['materials',()=>Response.json({ok:true,entries:{'u/learn-path-v1-original':JSON.stringify({topic:'x',materials:{}})}})]]) {
    const h=harness();h.model.state.topic='preserved';h.setReply(async()=>response());await assert.rejects(h.persistence.serverLoad(),undefined,name);
    assert.equal(h.model.session.bootState,'error',name);assert.equal(h.model.state.topic,'preserved',name);assert.equal(h.model.session.materialSlug,null,name);
    h.persistence.save();h.persistence.saveAi();assert.equal(h.calls.length,1,name);
    h.workflow.sendMessage();assert.equal(h.element('chat-input').value,'typed while waiting');
    h.setReply(async()=>Response.json({ok:true,entries:{'u/learn-path-v1-original':JSON.stringify({plan:{title:'legacy',nodes:[]}})}}));
    assert.equal(await h.persistence.serverLoad(),true);assert.equal(h.model.state.topic,'legacy');
  }
  {
    const h=harness('?t=');await assert.rejects(h.persistence.serverLoad(),/地址无效/);assert.equal(h.calls.length,0);
    h.env.location.search='?new=1&t=';assert.equal(await h.persistence.serverLoad(),false);assert.equal(h.model.session.bootState,'ready');
  }
  {
    const h=harness();
    h.setReply(async()=>Response.json({ok:true,entries:{'u/learn-path-v1-original':JSON.stringify({topic:'legacy nulls',history:null,materials:null,queries:null,sources:null}), 'u/learn-path-v1-last':'original'}}));
    await h.persistence.serverLoad();assert.equal(h.calls.length,1,'unchanged last pointer needs no write');assert.equal(h.model.state.materials.length,0);
    h.env.location.search='?new=1';await h.persistence.serverLoad();assert.equal(h.model.session.materialSlug,null);assert.equal(h.model.state.topic,'');assert.equal(h.model.state.history.length,0);
  }
  for (const stage of [null, '']) {
    const h=harness();h.setReply(async()=>Response.json({ok:true,entries:{'u/learn-path-v1-original':JSON.stringify({topic:'legacy stage',stage})}}));
    await h.persistence.serverLoad();assert.equal(h.model.state.stage,'intake');
  }
  for(const search of ['', '?new=1&t=missing']) {const h=harness(search);assert.equal(await h.persistence.serverLoad(),false);assert.equal(h.calls.length,0);assert.equal(h.model.session.bootState,'ready');}
  {
    const h=harness(),gate=deferred();h.setReply(()=>gate.promise);const load=h.persistence.serverLoad();await tick();const signal=h.calls[0].options.signal;h.expire();await assert.rejects(load,/超时/);assert(signal.aborted);
    gate.resolve(Response.json({ok:true,entries:{'u/learn-path-v1-original':JSON.stringify({topic:'late'})}}));await tick();assert.equal(h.model.state.topic,'');assert.equal(h.model.session.bootState,'error');
    h.setReply(async()=>Response.json({ok:true,entries:{'u/learn-path-v1-original':JSON.stringify({spec:{topic:'retry'}})}}));await h.persistence.serverLoad();assert.equal(h.model.state.topic,'retry');
  }
  for(const rejectOld of [false,true]) {
    const h=harness(),old=deferred();h.setReply(()=>old.promise);const first=h.persistence.serverLoad().catch(e=>e);await tick();
    h.env.location.search='?new=1';await h.persistence.serverLoad();
    if(rejectOld)old.reject(new Error('late failure'));else old.resolve(Response.json({ok:true,entries:{'u/learn-path-v1-original':JSON.stringify({topic:'late success'})}}));
    assert((await first).staleLoad);assert.equal(h.model.state.topic,'');assert.equal(h.model.session.bootState,'ready');assert.equal(h.calls.length,1);
  }
  {
    const h=harness(),old=deferred();h.setReply(()=>old.promise);const first=h.persistence.serverLoad().catch(e=>e);await tick();h.env.location.search='?t=elsewhere';old.reject(Error('old'));
    assert((await first).staleLoad);assert.equal(h.model.session.bootState,'loading');assert.equal(h.calls.length,1);
  }
  {
    const h=harness();h.env.window.LearnUser.readOnly=true;await h.persistence.serverLoad();h.workflow.setChatDisabled(false);assert(h.element('chat-send').disabled);h.workflow.sendMessage();h.persistence.save();h.persistence.saveAi();
    await assert.rejects(h.persistence.post('/path/intake',{}));assert.equal(h.calls.length,1);assert.equal(h.element('chat-input').value,'typed while waiting');
    h.env.window.LearnUser.readOnly=false;h.model.session.materialsPanel={busy:()=>true,lock(value){assert(value);}};h.workflow.setChatDisabled(false);assert(h.element('chat-send').disabled);
  }
  async function withSaves(h, saved={}) {
    const storage=new Map(Object.entries(saved)), notices=new Map(), user=h.env.window.LearnUser;
    user.user={id:'u'};user.ready=Promise.resolve();user.attachPersistence=()=>{};
    h.env.localStorage={getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)};
    h.env.window.LearnUI={set:(key,...args)=>notices.set(key,args),clear:key=>notices.delete(key)};
    h.env.location.reload=()=>{h.reloaded=true;};
    vm.runInContext(fs.readFileSync('shared/saves.js','utf8'),h.env);await user.ready;
    return {storage,notices,saves:h.env.window.LearnSaves};
  }
  {
    const h=harness('?new=1'),s=await withSaves(h);await h.persistence.serverLoad();
    h.model.state.topic='pre-read local';h.model.session.materialSlug='original';h.persistence.save();h.env.location.search='?t=original';
    await h.persistence.serverLoad();h.persistence.save();
    const backup=JSON.parse(s.storage.get('learn-unsaved-v1/u'));
    assert.equal(JSON.parse(backup['u/learn-path-v1-original']).topic,'pre-read local','fast hydration cannot replace pre-read edit');
    assert.equal(h.model.state.topic,'original');assert.throws(()=>s.saves.assertReady(),/恢复/);
  }
  {
    const h=harness('?new=1'),s=await withSaves(h);await h.persistence.serverLoad();
    h.model.state.topic='timeout draft';h.model.session.materialSlug='original';h.persistence.save();h.env.location.search='?t=original';h.setReply(()=>new Promise(()=>{}));
    const reading=h.persistence.serverLoad();await tick();h.expire();await assert.rejects(reading,/超时/);
    const reloaded=harness('?t=original'),recovery=await withSaves(reloaded,Object.fromEntries(s.storage));
    assert.equal(JSON.parse(JSON.parse(recovery.storage.get('learn-unsaved-v1/u'))['u/learn-path-v1-original']).topic,'timeout draft');
    reloaded.env.window.LearnUser.fetch=(url,options)=>recovery.saves.send(options,async()=>Response.json({ok:true}));
    await recovery.saves.retry();assert(reloaded.reloaded);assert.equal(recovery.saves.pending(),false);
  }
  {
    const original={'u/learn-path-v1-original':JSON.stringify({topic:'older recovery'})},h=harness('?new=1');
    const s=await withSaves(h,{'learn-unsaved-v1/u':JSON.stringify(original)});await h.persistence.serverLoad();
    h.model.state.topic='temporary';h.model.session.materialSlug='original';h.persistence.save();h.env.location.search='?t=original';await h.persistence.serverLoad();
    assert.equal(s.storage.get('learn-unsaved-v1/u'),JSON.stringify(original),'existing recovery has priority');
  }
  {
    const h=harness('?new=1'),s=await withSaves(h);await h.persistence.serverLoad();h.model.state.topic='must survive';h.model.session.materialSlug='original';h.persistence.save();
    h.env.localStorage.setItem=()=>{throw Error('quota');};h.env.location.search='?t=original';
    await assert.rejects(h.persistence.serverLoad(),/备份不可用/);assert.equal(h.model.state.topic,'must survive');assert.equal(h.model.session.bootState,'error');assert.equal(h.calls.length,0);
    h.env.localStorage.setItem=(key,value)=>s.storage.set(key,value);await h.persistence.serverLoad();
    assert.equal(JSON.parse(JSON.parse(s.storage.get('learn-unsaved-v1/u'))['u/learn-path-v1-original']).topic,'must survive');
  }
  {
    const h=harness('?new=1'),s=await withSaves(h),ack=deferred();
    const old=s.saves.send({body:JSON.stringify({entries:{'u/learn-path-v1-original':'old'}})},()=>ack.promise);
    assert(s.saves.retain({'u/learn-path-v1-original':'new','other/foreign':'no','u/tombstone':null}));
    ack.resolve(Response.json({ok:true}));await old;
    assert.equal(JSON.parse(s.storage.get('learn-unsaved-v1/u'))['u/learn-path-v1-original'],'new','old acknowledgement cannot clear newer retained value');
    assert.equal(JSON.parse(s.storage.get('learn-unsaved-v1/u'))['other/foreign'],undefined);
    assert.equal(JSON.parse(s.storage.get('learn-unsaved-v1/u'))['u/tombstone'],undefined);
  }
  {
    const h=harness('?new=1'),s=await withSaves(h),ack=deferred();await h.persistence.serverLoad();
    h.model.state.topic='new local edit';h.model.session.materialSlug='original';h.persistence.save();
    const user=h.env.window.LearnUser,fetch=user.fetch;
    user.fetch=(url,options)=>url.endsWith('/state/put')?s.saves.send(options,()=>ack.promise):fetch(url,options);
    const writing=h.persistence.flushSave();h.env.location.search='?t=original';await h.persistence.serverLoad();
    assert.equal(h.model.state.topic,'original','read hydrated the older server snapshot');
    ack.resolve(Response.json({ok:true}));await writing;assert.equal(s.saves.pending(),false);
    assert.throws(()=>s.saves.assertReady(),/恢复/,'old page stays locked after acknowledgement');
    let staleDispatches=0;
    user.fetch=(url,options)=>s.saves.send(options,async()=>{staleDispatches++;return Response.json({ok:true});});
    h.persistence.save();await assert.rejects(h.persistence.flushSave(),/恢复/);assert.equal(staleDispatches,0,'old hydrated model cannot overwrite the acknowledged local edit');
    await s.saves.retry();assert(h.reloaded,'acknowledged recovery reloads before editing continues');
  }
  {
    const h=harness('?new=1'),s=await withSaves(h);h.env.window.LearnUser.readOnly=true;
    assert.equal(s.saves.retain({'u/owned':'blocked'}),false);assert.equal(s.saves.pending(),false);
    h.env.window.LearnUser.readOnly=false;h.env.window.LearnUser.fetch=async()=>Response.json({entries:{'u/dead':null}});await s.saves.refresh();
    s.saves.retain({'u/dead':'resurrection'});assert.equal(s.saves.pending(),false,'explicit tombstones must reject retained drafts');
  }
  for (const conflict of [false,true]) {
    const h=harness('?new=1'),s=await withSaves(h),ack=deferred();await h.persistence.serverLoad();
    h.model.state.topic='confirmed newer content';h.model.session.materialSlug='original';h.persistence.save();
    const user=h.env.window.LearnUser,fetch=user.fetch;let saved;
    user.fetch=(url,options)=>url.endsWith('/state/put')?s.saves.send(options,()=>{saved=JSON.parse(options.body).entries;return ack.promise;}):fetch(url,options);
    const writing=h.persistence.flushSave().catch(error=>error);h.env.location.search='?t=original';await h.persistence.serverLoad();
    assert.equal(h.model.state.topic,'original');h.setReply(async()=>Response.json({ok:true,entries:saved}));
    if(conflict) ack.resolve(Response.json({error:'conflict'},{status:409}));
    else {await s.saves.refresh();ack.resolve(Response.json({ok:true}));}
    await writing;assert.equal(s.saves.pending(),false);assert.throws(()=>s.saves.assertReady(),/恢复/);
    let staleDispatches=0;
    user.fetch=(url,options)=>s.saves.send(options,async()=>{staleDispatches++;return Response.json({ok:true});});
    h.persistence.save();await assert.rejects(h.persistence.flushSave(),/恢复/);assert.equal(staleDispatches,0,'snapshot confirmation must not unlock a hydrated old page');
    await s.saves.retry();assert(h.reloaded);
  }
  console.log('PASS boot atomic restoration, loading/error write guards, HTTP/JSON/envelope/missing/malformed/empty target, timeout+retry, late success/failure/navigation, legacy topic, explicit new and readonly');
})().catch(error=>{console.error(error);process.exitCode=1;});
