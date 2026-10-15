'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {webcrypto} = require('node:crypto');

class Element {
  constructor(tag, doc) { this.tagName=tag; this.ownerDocument=doc; this.children=[]; this.dataset={}; this.attributes={}; this.listeners={}; this.hidden=false; this.textContent=''; this.open=false; }
  appendChild(node) { if(node.parentElement)node.parentElement.children=node.parentElement.children.filter(x=>x!==node);this.children.push(node);node.parentElement=this;return node; }
  append(...nodes) { nodes.forEach(node=>this.appendChild(node)); }
  replaceChildren(...nodes) { this.children.forEach(n=>n.parentElement=null);this.children=[];nodes.forEach(n=>this.appendChild(n)); }
  after(node) { const parent=this.parentElement;parent.appendChild(node);parent.children.splice(parent.children.indexOf(node),1);parent.children.splice(parent.children.indexOf(this)+1,0,node); }
  prepend(node) { this.appendChild(node);this.children.unshift(this.children.pop()); }
  setAttribute(k,v) { this.attributes[k]=String(v); }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attributes,k)?this.attributes[k]:null; }
  removeAttribute(k) { delete this.attributes[k]; }
  get parentNode() { return this.parentElement||null; }
  remove() { if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(node=>node!==this);this.parentElement=null; }
  addEventListener(k,fn) { (this.listeners[k] ||= []).push(fn); }
  get isConnected() { return this===this.ownerDocument.body || !!(this.parentElement&&this.parentElement.isConnected); }
  focus(options) { this.ownerDocument.activeElement=this;this.focusOptions=options; }
  showModal() { this.open=true; }
  close() { if(!this.open)return;this.open=false;this.dispatch('close'); }
  dispatch(k,event={}) { (this.listeners[k]||[]).forEach(fn=>fn({currentTarget:this,target:this,stopPropagation(){},preventDefault(){},...event})); }
  click() { if(this.disabled)return;const event={currentTarget:this,target:this,stopPropagation(){},preventDefault(){}};if(this.onclick)this.onclick(event);this.dispatch('click',event); }
  querySelectorAll(selector) { if(selector[0]==='.')return all(this).filter(n=>(n.className||'').split(' ').includes(selector.slice(1)));return all(this).filter(n=>n.tagName===selector.toLowerCase()); }
  querySelector(selector) { return this.querySelectorAll(selector)[0]||null; }
}
function all(node) { return [node,...node.children.flatMap(all)]; }
const flush=async()=>{for(let i=0;i<24;i++)await Promise.resolve();};
function deferred(){let resolve,reject;const promise=new Promise((r,j)=>{resolve=r;reject=j;});return {promise,resolve,reject};}
function detail(id,status='pending'){return {study_notes:id+' 正文',quiz:{round_id:'quiz-'+id,questions:[{answer:'saved'}]},unknown:'preserved',manim_review:{status,retryable:true}};}
function harness({failNodes=[],failScenes=[],readOnly=false,realPersistence=false,nodeCount=3,server=null}={}) {
  const backend=server||{jobs:new Map(),receipts:new Map(),serial:0,dropNextAck:0};
  const doc={createElement(tag){return new Element(tag,doc);},addEventListener(){},getElementById(id){return all(doc.body).find(n=>n.id===id)||null;},querySelector(selector){return doc.body.querySelector(selector);},querySelectorAll(selector){return doc.body.querySelectorAll(selector);}};
  doc.body=doc.createElement('body');const anchor=doc.createElement('div');anchor.id='resume-bar';doc.body.appendChild(anchor);const gen=doc.createElement('button');gen.id='gen-all-btn';doc.body.appendChild(gen);
  const model={state:{stage:'learning',plan:{nodes:Array.from({length:nodeCount},(_,i)=>'n'+(i+1)).map(id=>({id,title:id+' 课程',objectives:[]}))},spec:{},nodeDetail:{},pending:null},session:{nodeMaterialStatus:{},expandedId:'n1'}};
  const calls=[],jobs=backend.jobs,storage=new Map(),observed=[],opened=[],renders=[];let clock=Date.now(),timer=0,currentKey='u0/material';
  const env={document:doc,console,Response,AbortController,Uint8Array,crypto:webcrypto,location:{reload(){}},
    Date:class extends Date {static now(){return clock;}},setTimeout(fn,ms){const id=++timer;if(ms===1500||ms===3500){if(env.expireWatch)clock+=3600001;queueMicrotask(fn);}return id;},clearTimeout(){},
    localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},
    LearnUser:{userId:'u0',apiBase:'http://api',readOnly,ready:Promise.resolve()},
    LearnJobDetails:{observe(job){observed.push(job);},open(job,view,focus){opened.push({job,focus});}},window:null};
  env.window=env;vm.createContext(env);
  env.LearnUser.fetch=async(url,opts={})=>{
    calls.push({url,method:opts.method||'GET',body:opts.body&&JSON.parse(opts.body)});
    if(url.endsWith('/state/all')) {
      const saved={nodeDetail:Object.fromEntries(Object.entries(model.state.nodeDetail).map(([id,d])=>[id,{...d,manim_review:failScenes.includes(id)?{status:'failed',retryable:true,failure_code:'render_unavailable'}:d.manim_review}]))};
      return Response.json({ok:true,entries:{[currentKey]:JSON.stringify(saved)}});
    }
    if(url.includes('/jobs?'))return Response.json({jobs:[...jobs.values()].map(j=>{const thin={...j,status:j.finalStatus};delete thin.result;return thin;})});
    if(url.endsWith('/jobs')) {
      const body=JSON.parse(opts.body),signature=JSON.stringify([body.operation,body.body]);
      if(body.operation==='/path/node/scene'&&env.failNextSceneNetwork){const name=env.failNextSceneNetwork;env.failNextSceneNetwork=false;const error=new Error(name==='AbortError'?'The operation was aborted':'Failed to fetch');error.name=name;throw error;}
      const prior=body.request_id&&backend.receipts.get(body.request_id);
      if(prior) {
        if(prior.signature!==signature)return Response.json({error:'request id conflicts with submitted content',error_category:'request_id_conflict'},{status:409});
        return Response.json({job:prior.job});
      }
      const id='j'+(++backend.serial),nid=body.body.node.id,visual=body.operation==='/path/node/scene';
      const failed=(visual?failScenes:failNodes).includes(nid);
      const result=visual?{node_id:nid,source_notes:model.state.nodeDetail[nid].study_notes,study_notes:model.state.nodeDetail[nid].study_notes,needed:false,manim_review:{status:'not_needed'}}:detail(nid);
      const job={id,key:currentKey,node_id:nid,operation:body.operation,status:'running',finalStatus:failed?'failed':'succeeded',result,error:failed?'真实失败 '+nid:null,created_ms:backend.serial};
      jobs.set(id,job);if(body.request_id)backend.receipts.set(body.request_id,{job,signature});
      if(backend.dropNextAck>0){backend.dropNextAck--;throw new TypeError('connection lost after server accepted the request');}
      return Response.json({job});
    }
    const id=url.split('/').pop()==='retry'?url.split('/').at(-2):url.split('/').pop(),job=jobs.get(id);assert(job,'unknown job '+url);
    if(url.endsWith('/retry')) {job.finalStatus='succeeded';job.error=null;job.status='running';return Response.json({job});}
    if(env.blockRead){const gate=env.blockRead;env.blockRead=null;await gate.promise;}
    return Response.json({job:{...job,status:env.keepRunning?'running':job.finalStatus}});
  };
  for(const file of ['shared/ui.js','shared/jobs.js'])vm.runInContext(fs.readFileSync(file,'utf8'),env);
  let persistence={save(){env.saves=(env.saves||0)+1;},post(path,body,options){return env.LearnJobs.run(path,body,options);}};
  const format={$:id=>doc.getElementById(id),storeKey:()=>currentKey};
  const domain={nodeById:id=>model.state.plan.nodes.find(n=>n.id===id),depTitles:()=>[]};
  const hooks={syncAiMaterial(){},renderNodeDetail(id){renders.push({id,detail:model.state.nodeDetail[id]});}};
  if(realPersistence) {
    env.addEventListener=()=>{};env.Blob=Blob;model.session.API='http://api';
    const ports={'path.model':model,'path.format':format,'path.hooks':hooks};
    env.define=(name,names,factory)=>{persistence=factory(ports);};
    vm.runInContext(fs.readFileSync('learning-path/modules/path-persistence.js','utf8'),env);
  }
  const deps={'path.model':model,'path.format':format,'path.persistence':persistence,'path.domain':domain,'path.workflow':{hideResumeBar(){}},'path.hooks':hooks};
  env.define=(name,names,factory)=>{env.generation=factory(deps);};
  vm.runInContext(fs.readFileSync('learning-path/modules/path-generation.js','utf8'),env);
  const notices=()=>all(doc.body).filter(n=>n.className==='learn-status');
  return {env,model,doc,calls,jobs,opened,observed,renders,generation:env.generation,notices,setKey(key){currentKey=key;}};
}

(async()=>{
  {
    const h=harness({failNodes:['n1','n2']});await h.generation.genAllStart(['n1','n2','n3']);
    assert.equal(h.notices().length,1,'multiple terminal failures produce one top summary');assert.match(h.notices()[0].children[0].textContent,/已完成 1\/3，失败 2/);
    assert.equal(h.model.state.nodeDetail.n3.manim_review.status,'not_needed');assert.deepEqual(Array.from(h.model.state.pending.remaining),['n1','n2']);
    const panel=all(h.doc.body).find(n=>n.tagName==='dialog');const list=panel.querySelector('ol');assert.equal(list.children.length,4,'actual material and animation receipts stay accessible');
    const trigger=list.children[0].children[1].children[0];trigger.click();assert.equal(h.opened[0].job.id,'j1');
    h.notices()[0].querySelector('.learn-job-detail-button').click();assert.equal(panel.open,true);assert.strictEqual(h.doc.activeElement,panel.querySelector('.learn-task-dialog-body'));assert.equal(h.observed.some(j=>j.status==='failed'),true);
    panel.children[0].children[1].click();assert.equal(panel.open,false,'close button closes the batch dialog');
    const currentTrigger=h.notices()[0].querySelector('.learn-job-detail-button');assert.strictEqual(h.doc.activeElement,currentTrigger,'closing restores focus to the current trigger after status redraw');assert.equal(currentTrigger.focusOptions.preventScroll,true);
  }
  {
    const h=harness(),gate=deferred();h.env.blockRead=gate;const work=h.generation.genAllStart(['n1','n2']);await flush();
    const panel=all(h.doc.body).find(n=>n.tagName==='dialog'),list=panel.querySelector('ol'),row=list.children[0],button=row.children[1].children[0];
    h.notices()[0].querySelector('.learn-job-detail-button').click();button.focus();gate.resolve();await work;
    assert.strictEqual(list.children[0],row,'polls preserve the existing task row');assert.strictEqual(h.doc.activeElement,button,'polls keep task-list focus');assert.equal(panel.open,true);
    panel.children[0].children[1].click();assert.equal(panel.open,false);assert.strictEqual(h.doc.activeElement,h.notices()[0].querySelector('.learn-job-detail-button'),'closing after a status redraw focuses the current trigger');
    assert.match(h.notices()[0].children[0].textContent,/已完成 2\/2，失败 0/);
  }
  {
    const h=harness({failScenes:['n1']});await h.generation.genAllStart(['n1']);
    const saved=h.model.state.nodeDetail.n1,quiz=saved.quiz;
    assert.equal(saved.study_notes,'n1 正文');assert.equal(saved.manim_review.status,'failed');assert.equal(saved.manim_review.failure_code,'render_unavailable','animation failure refreshes actual server review metadata');assert.equal(h.renders.some(r=>r.detail===saved),true,'material is displayed before animation finishes');assert.equal(h.model.session.nodeMaterialStatus.n1,'ready');
    assert.equal(h.calls.filter(c=>c.body&&c.body.operation==='/path/node')[0].body.body.defer_visual,true);
    const count=h.calls.filter(c=>c.body&&c.body.operation==='/path/node').length;
    h.notices()[0].children[1].click();await flush();for(let i=0;i<100&&h.generation.isRunning();i++)await flush();assert.equal(h.generation.isRunning(),false);
    assert.equal(h.calls.filter(c=>c.body&&c.body.operation==='/path/node').length,count,'explicit animation retry never regenerates material');assert.strictEqual(h.model.state.nodeDetail.n1.quiz,quiz);
    assert.equal(h.calls.filter(c=>c.url.endsWith('/retry')).length,1);assert.equal(h.model.state.nodeDetail.n1.manim_review.status,'not_needed');
  }
  {
    const h=harness({failScenes:['n1']});await h.generation.genAllStart(['n1']);const before=h.calls.length;
    await h.generation.genAllStart(['n1'],{recovering:true});
    assert.equal(h.calls.slice(before).some(c=>c.method==='POST'),false,'refresh recovery only watches an existing failed scene task');assert.equal(h.calls.filter(c=>c.url.endsWith('/retry')).length,0,'recovery never spends a failed scene retry');assert.equal(h.model.state.nodeDetail.n1.manim_review.status,'failed');assert.match(h.notices()[0].children[0].textContent,/失败 1/);
    const missing=harness();missing.model.state.nodeDetail.n1=detail('n1');await missing.generation.genAllStart(['n1'],{recovering:true});assert.equal(missing.calls.some(c=>c.method==='POST'),false,'a new ID created during recovery is not proof that the scene submission was persisted');assert.match(missing.notices()[0].children[0].textContent,/失败 0，待确认 1/);assert.equal(missing.model.state.pending.requestId,undefined,'recovery without an old batch ID does not persist a fresh random ID');
    const secondRefresh=harness();secondRefresh.model.state.nodeDetail.n1=detail('n1');secondRefresh.model.state.pending=structuredClone(missing.model.state.pending);await secondRefresh.generation.genAllStart(['n1'],{recovering:true});assert.equal(secondRefresh.calls.some(c=>c.method==='POST'),false,'a second reload still cannot treat an ID minted by the first recovery as authorization');assert.equal(secondRefresh.model.state.pending.requestId,undefined);
    const noBody=harness();noBody.model.state.pending={kind:'nodes',requestId:'persisted-no-body-id',remaining:['n1']};await noBody.generation.genAllStart(['n1'],{recovering:true});assert.equal(noBody.calls.some(c=>c.method==='POST'),false,'missing body receipts are never submitted during recovery');
    const unreadable=harness();unreadable.model.state.nodeDetail.n1=detail('n1');unreadable.model.state.pending={kind:'nodes',requestId:'persisted-query-failure-id',remaining:['n1']};
    const fetch=unreadable.env.LearnUser.fetch;unreadable.env.LearnUser.fetch=async(url,options)=>url.includes('/jobs?')?Response.json({error:'offline'},{status:503}):fetch(url,options);
    await unreadable.generation.genAllStart(['n1'],{recovering:true});assert.equal(unreadable.calls.some(c=>c.method==='POST'),false,'a failed receipt query never triggers a new submission');
    const expired=harness();expired.model.state.nodeDetail.n1=detail('n1','failed');expired.model.state.pending={kind:'nodes',requestId:'persisted-failed-scene-id',remaining:['n1']};await expired.generation.genAllStart(['n1'],{recovering:true});assert.equal(expired.calls.some(c=>c.method==='POST'),false,'a failed scene without a visible list receipt is not resubmitted');assert.match(expired.notices()[0].children[0].textContent,/失败 1/);
  }
  for(const failureName of ['TypeError','AbortError']) {
    const first=harness();first.env.failNextSceneNetwork=failureName;await first.generation.genAllStart(['n1']);
    const attempted=first.calls.find(c=>c.method==='POST'&&c.body.operation==='/path/node/scene');
    assert(attempted);assert.equal(first.jobs.size,1,'network failure happened after material receipt only; no scene task was accepted');
    assert.equal(first.model.state.nodeDetail.n1.manim_review.status,'pending',failureName+' without a receipt keeps the scene pending');
    assert.match(first.notices()[0].children[0].textContent,/待确认 1/);
    const batchId=first.model.state.pending.requestId,reloaded=harness();reloaded.model.state.nodeDetail.n1=structuredClone(first.model.state.nodeDetail.n1);reloaded.model.state.pending=structuredClone(first.model.state.pending);
    await reloaded.generation.genAllStart(['n1'],{recovering:true});
    const retry=reloaded.calls.find(c=>c.method==='POST'&&c.body.operation==='/path/node/scene');
    assert(retry,'pending scene with persisted batch identity is retried after its receipt query');
    assert.equal(retry.body.request_id,attempted.body.request_id,'reload reuses the stable scene idempotency key derived from '+batchId);
    assert.equal(reloaded.model.state.pending,null,'successful recovered scene clears the pending batch');
  }
  {
    const h=harness(),saved=detail('n1'),quiz=saved.quiz;
    h.model.state.nodeDetail.n1=saved;
    h.model.state.pending={kind:'nodes',requestId:'persisted-batch-id',remaining:['n1']};
    await h.generation.genAllStart(['n1'],{recovering:true});
    const scenePosts=h.calls.filter(c=>c.method==='POST'&&c.body.operation==='/path/node/scene');
    assert.equal(scenePosts.length,1,'missing visual receipt submits the deferred animation once');
    assert.equal(h.calls.some(c=>c.method==='POST'&&c.body.operation==='/path/node'),false,'recovery keeps the saved body');
    assert.equal(scenePosts[0].body.body.node.id,'n1');assert.equal(scenePosts[0].body.request_id.length>8,true,'submission uses a stable id derived from the persisted batch ID');
    assert.equal(h.jobs.size,1);assert.equal(h.model.state.nodeDetail.n1.manim_review.status,'not_needed');
    assert.equal(h.model.state.nodeDetail.n1.study_notes,saved.study_notes);assert.strictEqual(h.model.state.nodeDetail.n1.quiz,quiz);
    assert.match(h.notices()[0].children[0].textContent,/已完成 1\/1，失败 0/);
  }
  {
    const server={jobs:new Map(),receipts:new Map(),serial:0,dropNextAck:1};
    const first=harness({server}),saved=detail('n1');
    first.model.state.nodeDetail.n1=saved;first.model.state.pending={kind:'nodes',requestId:'lost-ack-batch-id',remaining:['n1']};
    await first.generation.genAllStart(['n1'],{recovering:true});
    assert.equal(first.calls.filter(c=>c.method==='POST'&&c.body.operation==='/path/node/scene').length,1,'first tab submitted before losing its ACK');
    assert.equal(server.jobs.size,1,'the server accepted exactly one scene task');
    const reloaded=harness({server});reloaded.model.state.nodeDetail.n1=detail('n1');reloaded.model.state.pending={kind:'nodes',requestId:'lost-ack-batch-id',remaining:['n1']};
    await reloaded.generation.genAllStart(['n1'],{recovering:true});
    assert.equal(reloaded.calls.filter(c=>c.method==='POST').length,0,'reload finds and watches the accepted scene task');
    assert.equal(server.jobs.size,1,'lost ACK recovery does not create a duplicate task');
    assert.equal(reloaded.model.state.nodeDetail.n1.manim_review.status,'not_needed');
    assert.equal(reloaded.model.state.nodeDetail.n1.study_notes,saved.study_notes);assert.equal(reloaded.model.state.nodeDetail.n1.quiz.round_id,saved.quiz.round_id);
  }
  {
    const server={jobs:new Map(),receipts:new Map(),serial:0};
    const first=harness({server}),second=harness({server});
    for(const tab of [first,second]) {
      tab.model.state.nodeDetail.n1=detail('n1');
      tab.model.state.pending={kind:'nodes',requestId:'two-tab-batch-id',remaining:['n1']};
    }
    const firstWork=first.generation.genAllStart(['n1'],{recovering:true});
    const secondWork=second.generation.genAllStart(['n1'],{recovering:true});
    await Promise.all([firstWork,secondWork]);
    const posts=[...first.calls,...second.calls].filter(c=>c.method==='POST'&&c.body.operation==='/path/node/scene');
    assert.equal(posts.length,2,'both stale tabs may submit the same deterministic request');
    assert.equal(posts[0].body.request_id,posts[1].body.request_id,'tabs use the same idempotency key');
    assert.equal(server.jobs.size,1,'server request de-duplication creates one scene task');
    assert(first.model.state.nodeDetail.n1.manim_review.status==='not_needed');
    assert(second.model.state.nodeDetail.n1.manim_review.status==='not_needed');
  }
  {
    const h=harness(),material=detail('n1');
    h.jobs.set('restored-body',{id:'restored-body',operation:'/path/node',node_id:'n1',status:'succeeded',finalStatus:'succeeded',created_ms:1,result:material});
    h.jobs.set('restored-scene',{id:'restored-scene',operation:'/path/node/scene',node_id:'n1',status:'succeeded',finalStatus:'succeeded',created_ms:2,result:{node_id:'n1',study_notes:material.study_notes,needed:false,manim_review:{status:'not_needed'}}});
    await h.generation.genAllStart(['n1'],{recovering:true});
    assert.equal(h.model.state.nodeDetail.n1.study_notes,material.study_notes,'successful thin-list body receipt restores its full material');
    assert.equal(h.model.state.nodeDetail.n1.quiz.round_id,material.quiz.round_id);
    assert.equal(h.model.state.nodeDetail.n1.manim_review.status,'not_needed','successful thin-list scene receipt completes animation review');
    assert.match(h.notices()[0].children[0].textContent,/已完成 1\/1，失败 0/);
    assert.equal(h.calls.filter(c=>c.url.endsWith('/jobs/restored-body')).length,1);
    assert.equal(h.calls.filter(c=>c.url.endsWith('/jobs/restored-scene')).length,1);
    assert.equal(h.calls.some(c=>c.method==='POST'),false,'successful recovery only reads original full receipts');
    const scene=harness(),saved=detail('n2'),quiz=saved.quiz;
    scene.model.state.nodeDetail.n2=saved;
    scene.jobs.set('completed-scene',{id:'completed-scene',operation:'/path/node/scene',node_id:'n2',status:'succeeded',finalStatus:'succeeded',created_ms:1,result:{node_id:'n2',study_notes:saved.study_notes,needed:false,manim_review:{status:'not_needed'}}});
    await scene.generation.genAllStart(['n2'],{recovering:true});
    assert.strictEqual(scene.model.state.nodeDetail.n2.quiz,quiz);
    assert.equal(scene.model.state.nodeDetail.n2.manim_review.status,'not_needed');
    assert.equal(scene.calls.some(c=>c.method==='POST'),false);
  }
  {
    const h=harness();h.env.expireWatch=true;h.env.keepRunning=true;await h.generation.genAllStart(['n1']);assert.match(h.notices()[0].children[0].textContent,/失败 0，待确认 1/);assert.equal(h.calls.some(c=>c.url.endsWith('/retry')),false,'watch timeout never spends retry budget');
  }
  {
    const h=harness();h.model.state.nodeDetail.n1={study_notes:'旧正文',quiz:{round_id:'old'}};assert.equal(h.generation.missingNodeIds().includes('n1'),false,'old materials without review remain complete');await h.generation.requestNodeDetail('n1');assert.equal(h.calls.length,0);
    const late=harness(),gate=deferred();late.env.blockRead=gate;const work=late.generation.requestNodeDetail('n1');await flush();late.setKey('u0/other');gate.resolve();await assert.rejects(work);assert.equal(late.model.state.nodeDetail.n1,undefined,'late results cannot enter another material');
  }
  {
    const h=harness({readOnly:true});await h.generation.genAllStart(['n1']);await h.generation.onGenAllClick();await assert.rejects(h.generation.requestNodeDetail('n1',true));assert.equal(h.calls.length,0);assert.equal(h.env.saves||0,0,'read-only entry performs no writes');
  }
  {
    const h=harness();let recovered,flag;
    h.model.state.nodeDetail={n1:detail('n1','passed'),n2:detail('n2','failed'),n3:{study_notes:'legacy'}};
    h.model.state.pending={kind:'nodes',at:Date.now(),remaining:['n1','n2','n3']};
    const deps={'path.model':h.model,'path.format':{$:()=>null},'path.persistence':{save(){}},'path.shell':{},'path.domain':{},'path.hooks':{genAllStart(ids,options){recovered={ids,options};},selectNode(){flag=h.model.session.recoveringGeneration;}}};
    h.env.define=(name,names,factory)=>{h.workflow=factory(deps);};vm.runInContext(fs.readFileSync('learning-path/modules/path-workflow.js','utf8'),h.env);
    assert.equal(h.workflow.resumeIfPending(),true);assert.deepEqual(Array.from(recovered.ids),['n2'],'pending animation survives batch recovery while legacy bodies stay complete');assert.equal(recovered.options.recovering,true);
    h.model.state.nodeDetail={};h.model.state.pending={kind:'node',nid:'n1',at:Date.now()};h.workflow.resumeIfPending();assert.equal(flag,true,'single-node recovery is explicitly read-only task recovery');assert.equal(h.model.session.recoveringGeneration,false);
    h.env.LearnUser.readOnly=true;assert.equal(h.workflow.resumeIfPending(),false);
  }
  {
    const h=harness({realPersistence:true,nodeCount:6});
    h.model.state.pending={kind:'nodes',requestId:'legacy-six-node-base',remaining:['n1','n2','n3','n4','n5','n6']};
    const originalFetch=h.env.LearnUser.fetch;
    h.env.LearnUser.fetch=async(url,options)=>{
      if(url.endsWith('/jobs')&&options.method==='POST'&&JSON.parse(options.body).request_id.startsWith('legacy-six-node-base:')) {
        return Response.json({error:'old nondeferred receipt has another body',error_category:'request_id_conflict'},{status:409});
      }
      return originalFetch(url,options);
    };
    await h.generation.genAllStart(['n1','n2','n3','n4','n5','n6']);
    const submitted=h.calls.filter(c=>c.method==='POST'&&c.url.endsWith('/jobs'));
    assert.equal(submitted.filter(c=>c.body.operation==='/path/node').length,6);
    assert.equal(submitted.filter(c=>c.body.operation==='/path/node/scene').length,6);
    assert(submitted.filter(c=>c.body.operation==='/path/node').every(c=>c.body.body.defer_visual===true));
    assert.equal(new Set(submitted.map(c=>c.body.request_id)).size,12);
    assert.equal(Object.keys(h.model.state.nodeDetail).length,6);
    assert.equal(h.model.state.pending,null);
  }
  console.log('PASS two-stage material readiness, animation-only retry, one batch summary, stable details/focus, GET-only recovery and read-only');
})().catch(error=>{console.error(error);process.exitCode=1;});
