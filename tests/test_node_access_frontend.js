"use strict";
const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
function load(file, deps, extra = {}) {
  let result;
  const env = {console, Promise, AbortController, setTimeout, clearTimeout, ...extra,
    define(name, names, factory) { result = factory(deps); }};
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), env, {filename: file});
  return result;
}
const model = {state: {plan: {nodes: [{id: 'a', deps: []}, {id: 'b', deps: ['a']}]}, nodeState: {}, nodeAccess: {}, nodeDetail: {a: {study_notes:'unsaved'}}, topic:'test'}, session: {API:'', TIMEOUT:1000, MARK_LABELS:[['none','未学'],['mastered','已掌握']]}};
const domain = load('learning-path/modules/path-domain.js', {'path.model':model});
const accessKey='u/learn-path-v1-test';
function snapshot(value=raw) {return {ok:true,key:accessKey,revision:1,plan:value.plan,nodeAccess:value.nodeAccess || {},nodeState:value.nodeState || {}};}
let urls=[],override=null,currentKey=accessKey;
let raw = {plan: model.state.plan, nodeAccess: {}, nodeState:{}}, status = 200, offline = false, renders = 0, waiting;
const user = {readOnly:false, fetch: async (url,options) => {
  urls.push(url);
  if (offline==='timeout') return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>{const error=Error('aborted');error.name='AbortError';reject(error);}));
  if (offline) throw Error('offline');
  if (waiting) return waiting;
  return {ok:status===200,status,json:async()=>override || snapshot()};
}};
const format = {storeKey:()=> currentKey, $:()=>null};
const persistence = load('learning-path/modules/path-persistence.js', {'path.model':model,'path.domain':domain,'path.format':format,'path.hooks':{renderPlan(){renders++;}}}, {window:{LearnUser:user,addEventListener(){}},document:{addEventListener(){}}});

function miniDom() {
 const document={activeElement:null};
 class Element {
  constructor(tag){this.tagName=tag;this.dataset={};this.children=[];this.attrs={};this.style={};this.listeners={};this.value='';this.hidden=false;this.disabled=false;this.readOnly=false;this.isConnected=true;this._html='';this.className='';this.classList={contains:name=>this.className.split(' ').includes(name),toggle:(name,on)=>{const set=new Set(this.className.split(' ').filter(Boolean));on?set.add(name):set.delete(name);this.className=[...set].join(' ');}};}
  get childNodes(){return this.children;}
  appendChild(child){if(child.parentNode)child.parentNode.children=child.parentNode.children.filter(node=>node!==child);this.children.push(child);child.parentNode=this;return child;}
  replaceChildren(...nodes){this.children=[];nodes.forEach(node=>this.appendChild(node));}
  setAttribute(key,value){this.attrs[key]=String(value);if(key==='id')this.id=String(value);if(key==='class')this.className=String(value);if(key.startsWith('data-'))this.dataset[key.slice(5)]=String(value);}
  getAttribute(key){return this.attrs[key]??null;}
  removeAttribute(key){delete this.attrs[key];}
  querySelectorAll(selector){const selectors=selector.split(',').map(x=>x.trim());return walk(this).filter(node=>selectors.some(value=>value.startsWith('.')?node.className.split(' ').includes(value.slice(1)):value.startsWith('#')?node.id===value.slice(1):node.tagName===value));}
  querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
  addEventListener(name,handler){(this.listeners[name]||=[]).push(handler);}
  focus(){document.activeElement=this;}
  scrollIntoView(){}
  click(){if(this.disabled)return;if(this.onclick)this.onclick();for(const fn of this.listeners.click||[])fn({target:this,stopPropagation(){}});}
  edit(value){if(!this.disabled&&!this.readOnly)this.value=value;}
  set innerHTML(value){this._html=value;this.children=[];const stack=[this];for(const token of value.matchAll(/<\/?([a-z][a-z0-9-]*)([^>]*)>/gi)){if(token[0][1]==='/'){if(stack.length>1)stack.pop();continue;}const child=new Element(token[1]);for(const attr of token[2].matchAll(/([a-z-]+)="([^"]*)"/gi))child.setAttribute(attr[1],attr[2]);if(/\bdisabled\b/.test(token[2]))child.disabled=true;stack.at(-1).appendChild(child);if(!['input','br','hr','img'].includes(token[1]))stack.push(child);}}
  get innerHTML(){return this._html;}
 }
 function walk(root){return root.children.flatMap(node=>[node,...walk(node)]);}
 document.body=new Element('body');document.createElement=tag=>new Element(tag);document.getElementById=id=>walk(document.body).find(node=>node.id===id)||null;
 return {document,Element};
}
function verifyDirectoryPreservesReading() {
 const {document,Element}=miniDom();
 const elements={};for(const id of ['path-directory','review-filter-btn','node-a','graph-layer']){const node=new Element('div');node.id=id;elements[id]=node;document.body.appendChild(node);}
 const reading=new Element('article'),animation=new Element('video'),draft=new Element('textarea');reading.appendChild(animation);reading.appendChild(draft);animation.currentTime=12.5;draft.value='keep draft';elements['graph-layer'].appendChild(reading);
 const button=new Element('button');button.setAttribute('data-mark','mastered');button.className='mark-btn';elements['node-a'].appendChild(button);button.focus();
 const scope=reading,m={state:{plan:{nodes:[{id:'a',title:'Alpha',deps:[]},{id:'b',title:'Beta',deps:[]}]},nodeState:{a:{mark:'review'},b:{mark:'review'}},nodeDetail:{},nodeAccess:{}},session:{MARK_LABELS:[['none','未学'],['mastered','已掌握'],['review','需复习']],selectedId:'a',expandedId:'a',activeScope:scope,reviewFilter:true}};
 const d=load('learning-path/modules/path-domain.js',{'path.model':m});let cards;
 const hooks={refreshDirectory(){cards.refreshDirectory();},renderPlan(){elements['graph-layer'].innerHTML='replaced';document.activeElement=document.body;}};
 const format={$:id=>elements[id],esc:value=>String(value??'')};
 const shell=load('learning-path/modules/path-shell.js',{'path.model':m,'path.domain':d,'path.format':format,'path.persistence':{save(){}},'path.hooks':hooks},{window:{LearnUser:{readOnly:false}}});
 const browser={scrollY:140,history:{replaceState(){}}},positions=new Map();format.storeKey=()=> 'u/doc';
 cards=load('learning-path/modules/path-cards.js',{'path.model':m,'path.domain':d,'path.format':format,'path.shell':shell,'path.hooks':hooks},{document,window:browser,URL,location:{href:'http://local/path?t=doc'},sessionStorage:{setItem:(key,value)=>positions.set(key,value)}});
 cards.refreshDirectory();assert.equal(elements['path-directory'].children.length,2);
 shell.setMark('a','mastered');assert.equal(elements['path-directory'].children.length,1,'filtered directory removes only the changed unit');
 assert.equal(elements['graph-layer'].children[0],reading);assert.equal(reading.children[0],animation);assert.equal(animation.currentTime,12.5);assert.equal(draft.value,'keep draft');assert.equal(document.activeElement,button,'marking preserves actual focused control');assert.equal(m.session.selectedId,'a');assert.equal(m.session.expandedId,'a');assert.equal(m.session.activeScope,scope);assert.equal(button.getAttribute('aria-pressed'),'true');
 document.body.className='workspace-reading';cards.captureReadingPosition();assert.equal(JSON.parse(positions.get('learn-workspace-v1:u/doc')).scroll,140);
 document.body.className='';browser.scrollY=700;cards.captureReadingPosition();assert.equal(JSON.parse(positions.get('learn-workspace-v1:u/doc')).scroll,140,'temporary target/research views cannot overwrite the reading position');
 m.session.reviewFilter=false;shell.updateReviewFilterBtn();cards.refreshDirectory();assert.equal(elements['path-directory'].children.length,2);assert.equal(elements['graph-layer'].children[0],reading);assert.equal(document.activeElement,button,'filter toggle preserves reading focus');
}
async function verifyPendingSelection() {
 const {document,Element}=miniDom();
 for(const id of ['document-title','plan-title','plan-summary','workspace-goal','workspace-research','path-directory','graph-layer','agent-dialog','progress-text','progress-fill','review-filter-btn','errtext','errretry','errbar','stage-intake','stage-research','stage-learning']){const el=new Element('div');el.id=id;document.body.appendChild(el);}
 document.body.className='workspace-reading';document.querySelectorAll=selector=>document.body.querySelectorAll(selector);
 const m={state:{topic:'doc',plan:{nodes:[{id:'a',title:'Alpha',deps:[]},{id:'b',title:'Beta',deps:[]}]},nodeAccess:{},nodeState:{},nodeDetail:{a:{study_notes:'PRIVATE A'},b:{study_notes:'PRIVATE B'}}},session:{MARK_LABELS:[],nodeMaterialStatus:{},recoveringGeneration:false,workspaceKey:'u/doc'}};
 const d=load('learning-path/modules/path-domain.js',{'path.model':m});let key='u/doc',cards,requests=0,finish,fail,errors=[],generated=0,agents=0;
 const format={$:id=>document.getElementById(id),esc:value=>String(value??''),storeKey:()=>key};
 const hook={showAgent(){agents++;},selectNode(id){return cards.selectNode(id);},renderPlan(){cards.renderPlan();},renderAgentPanel(){},renderNodeDetail(id){if(d.canAccess(id))cards.cardContentEl(id).innerHTML='<div class="private-notes">'+m.state.nodeDetail[id].study_notes+'</div><button class="quiz-action">Quiz</button>';},requestNodeDetail(){generated++;return Promise.resolve({});}};
 const persistence={refreshAccess(){requests++;return new Promise((resolve,reject)=>{finish=resolve;fail=reject;});},ensureNodeExists(){return this.refreshAccess();},ensureAccess(){return Promise.resolve(true);},save(){}};
 let restoredScroll=null;
 const browser={LearnUser:{readOnly:false},LearnTitles:{document:()=> 'Doc'},LearnUI:{dialog:{close(el){el.open=false;}}},history:{replaceState(){}},scrollY:0,scrollTo(x,y){restoredScroll=y;}};
 const shell=load('learning-path/modules/path-shell.js',{'path.model':m,'path.domain':d,'path.format':format,'path.persistence':persistence,'path.hooks':hook},{document,window:browser,requestAnimationFrame:fn=>fn()});
 const cardShell={...shell,showError(message){errors.push(message);shell.showError(message);}};
 let workflow;const workflowPort={setPending(...args){return workflow.setPending(...args);},hideResumeBar(){return workflow.hideResumeBar();},handlePendingFailure(error){return workflow.handlePendingFailure(error);}};
 cards=load('learning-path/modules/path-cards.js',{'path.model':m,'path.domain':d,'path.format':format,'path.shell':cardShell,'path.hooks':hook,'path.persistence':persistence,'path.workflow':workflowPort,'path.generation':{isRunning:()=>false,setCardGenState(){}}},{document,window:browser,URL,URLSearchParams,location:{href:'http://local/path?t=doc',search:'?t=doc'},sessionStorage:{getItem:()=>JSON.stringify({node:'a',scroll:267}),setItem(){}},requestAnimationFrame:fn=>fn()});
 let pending=cards.selectNode('a');
 assert.equal(document.body.querySelector('.private-notes'),null,'cached正文 must not be rendered before access confirmation');
 assert.equal(document.body.querySelector('.quiz-action'),null,'quiz controls must not exist while pending');
 assert(document.body.querySelector('.workspace-ai').disabled,'AI must be disabled while pending');
 const realAssessment=load('learning-path/modules/path-assessment.js',{'path.model':m,'path.domain':d,'path.format':format,'path.cards':cards});
 realAssessment.renderNodeDetail('a');
 hook.renderNodeDetail('a');assert.equal(document.body.querySelector('.private-notes'),null,'late render hook cannot bypass pending');
 const duplicate=cards.selectNode('a');assert.equal(requests,1,'same pending selection shares its action');
 finish({});await Promise.all([pending,duplicate]);assert(document.body.querySelector('.private-notes'),'confirmed cached正文 is rendered');
 assert(!document.body.querySelector('.workspace-ai').disabled);
 pending=cards.selectNode('a');const finishOldA=finish;const firstA=pending;
 pending=cards.selectNode('b');const finishB=finish;const newest=cards.selectNode('a'),finishA=finish;
 finishOldA({});await firstA;assert.equal(document.body.querySelector('.private-notes'),null,'first A in A→B→A cannot render');
 finishB({});await pending;assert.equal(document.body.querySelector('.private-notes'),null,'interleaved old selection cannot expose latest cached正文');
 finishA({});await newest;assert.match(cards.cardContentEl('a').innerHTML,/PRIVATE A/);
 m.session.recoveringGeneration=true;delete m.state.nodeDetail.a;
 pending=cards.selectNode('a');const oldFinish=finish;shell.viewStage('research');const focus=document.activeElement;oldFinish({});await pending;
 assert.equal(document.activeElement,focus,'leaving reading invalidates old focus');assert.equal(generated,0,'leaving reading invalidates recovery generation');
 m.session.recoveringGeneration=false;shell.viewStage('learning');const returnFinish=finish;assert.equal(document.body.querySelector('.private-notes'),null,'returning reading reconfirms a cancelled selection');returnFinish({});await Promise.resolve();await Promise.resolve();
 pending=cards.selectNode('a');key='u/other';m.state.nodeDetail.a={study_notes:'OTHER DOC'};const switchedFocus=document.activeElement;finish({});await pending;
 assert.equal(document.activeElement,switchedFocus,'same node in another document cannot receive stale focus');assert.equal(document.body.querySelector('.private-notes'),null);
 assert.equal(errors.length,0);
 key='u/doc';m.session.workspaceKey=key;shell.showError('独立保存失败');const saveRetry=()=>{};m.session.retryFn=saveRetry;
 pending=cards.selectNode('a');fail(Error('offline'));await pending;
 assert.equal(format.$('errtext').textContent,'独立保存失败','access failure must preserve an unrelated global error');assert.equal(m.session.retryFn,saveRetry);
 assert(document.body.querySelector('.access-read-error'),'access error belongs to the reading surface');
 assert.equal(document.body.querySelector('.private-notes'),null);assert(document.body.querySelector('.refresh-access'),'failure offers retry');assert(document.body.querySelector('.workspace-ai').disabled);
 m.session.accessUnavailable=false;pending=cards.selectNode('a');finish({});await pending;
 assert.equal(document.body.querySelector('.access-read-error'),null,'successful retry clears its own access error');assert(document.body.querySelector('.private-notes'));
 assert.equal(format.$('errtext').textContent,'独立保存失败');assert.equal(format.$('errbar').hidden,false,'successful access retry preserves unrelated global error visibility');assert.equal(m.session.retryFn,saveRetry,'successful access retry preserves unrelated recovery action');
 let finishAi;persistence.ensureAccess=()=>new Promise(resolve=>{finishAi=resolve;});const ai=cards.openAiView('a');
 pending=cards.selectNode('b');finish({});await pending;finishAi(true);await ai;assert.equal(agents,0,'late AI authorization cannot reopen old selection');
 m.state.nodeAccess.a='locked';pending=cards.selectNode('a');finish({});await pending;assert.equal(document.body.querySelector('.private-notes'),null,'authoritative lock never renders cached正文');
 m.state.nodeAccess={};m.session.workspaceKey=null;cards.renderPlan();assert.equal(document.body.querySelector('.private-notes'),null,'initial document rendering also waits for authority');finish({});await Promise.resolve();await Promise.resolve();
 assert(document.body.querySelector('.private-notes'),'initial document displays正文 after confirmation');assert.equal(restoredScroll,267,'initial access confirmation preserves the saved reading scroll');
 // Boot restores the plan before asking workflow to resume its saved node task.
 let newRequests=0,newIds=0;const restoredJobs=[];const savedRequestId='original-request-123';
 const existingJob={id:'job-before-reload',operation:'/path/node',node_id:'a',status:'succeeded',created_ms:1,result:{study_notes:'RESTORED BODY',manim_review:{status:'not_needed'}}};
 browser.LearnJobs={requestId(){newIds++;return 'must-not-create';},list:async()=>[existingJob],get:async id=>{restoredJobs.push(id);return existingJob;},watch:async job=>job.result};
 persistence.post=()=>{newRequests++;return Promise.reject(Error('must not create a recovery job'));};persistence.ensureAccess=()=>Promise.resolve(true);
 hook.syncAiMaterial=()=>{};
 workflow=load('learning-path/modules/path-workflow.js',{'path.model':m,'path.domain':d,'path.format':format,'path.persistence':persistence,'path.shell':shell,'path.hooks':hook},{window:browser});
 const generation=load('learning-path/modules/path-generation.js',{'path.model':m,'path.domain':d,'path.format':format,'path.persistence':persistence,'path.workflow':workflow,'path.hooks':hook},{window:browser});
 let recoveryCalls=0;hook.requestNodeDetail=(id,manualRetry,options)=>{recoveryCalls++;assert(options.recovering,'merged selection preserves recovery intent');assert.equal(m.state.pending.requestId,savedRequestId);return generation.requestNodeDetail(id,manualRetry,options);};
 delete m.state.nodeDetail.a;m.state.pending={kind:'node',nid:'a',at:Date.now(),requestId:savedRequestId};m.session.workspaceKey=null;
 cards.renderPlan();const bootstrapSelection=cards.selectNode('a');assert(workflow.resumeIfPending());assert(workflow.resumeIfPending(),'repeated resume merges into the same pending selection');finish({});await bootstrapSelection;
 for(let i=0;i<30;i++)await Promise.resolve();
 assert.equal(recoveryCalls,1,'boot renderPlan then resumeIfPending recovers exactly once');assert.equal(newRequests,0,'recovery reads the existing job instead of creating another');assert.equal(newIds,0,'recovery preserves the persisted request identity');assert.deepEqual(restoredJobs,['job-before-reload']);assert.equal(m.state.nodeDetail.a.study_notes,'RESTORED BODY');assert.equal(m.state.pending,null);

}

function verifyReadOnlyAssistant() {
 const {document,Element}=miniDom();for(const id of ['panel-body','panel-foot']){const node=new Element('div');node.id=id;document.body.appendChild(node);}
 const m={state:{plan:{nodes:[{id:'a',title:'Alpha'}]},nodeDetail:{},nodeState:{},aiHist:{}},session:{nodeMaterialStatus:{}}};
 let writes=0,requests=0;
 const user={readOnly:true,fetch(){requests++;throw Error('readonly request');}};
 const format={$:id=>document.getElementById(id),aiKey:()=> 'u/a',bindAutoGrow(){},renderMathIn(){},highlightIn(){},mdRender:value=>String(value)};
 const assistant=load('learning-path/modules/path-assistant.js',{'path.model':m,'path.domain':{nodeById:()=>m.state.plan.nodes[0]},'path.format':format,'path.persistence':{saveAi(){writes++;},ensureAccess(){requests++;return Promise.resolve();}}},{document,window:{LearnUser:user}});
 assistant.renderAiPanel('a');const input=document.getElementById('ai-input'),send=document.getElementById('ai-send');input.value='preserved draft';input.edit('not allowed');assert.equal(input.value,'preserved draft');assert(input.readOnly);assert(send.disabled);assert.match(document.getElementById('panel-body').querySelector('.ai-note').textContent,/只读/);
 const shortcuts=document.getElementById('panel-body').querySelectorAll('.ai-chip, .ai-method');assert.equal(shortcuts.length,8);for(const shortcut of shortcuts){assert(shortcut.disabled);shortcut.click();}send.click();assert.equal(writes,0);assert.equal(requests,0);assert.equal(input.value,'preserved draft');assert.deepEqual(m.state.aiHist,{});
 assistant.renderAiPanel('a');assert.equal(document.getElementById('ai-input'),input,'reopening reuses the same readonly view');assert(input.readOnly);assert(send.disabled);
}
(async () => {
 assert(domain.canAccess('a')); assert(!domain.canAccess('b'));
 model.state.nodeAccess={b:'unlocked'}; assert(domain.canAccess('b')); assert(!domain.isDone('b')); assert(!domain.isUnlocked('b'));
 model.state.nodeState.a={completed:true};model.state.nodeAccess={a:'locked'};assert(!domain.canAccess('a'),'manual lock overrides completion');
 model.state.nodeAccess=Object.create({b:'unlocked'}); model.state.nodeState={};assert(!domain.canAccess('b'),'inherited policy cannot unlock');
 model.state.nodeAccess={b:'unknown'};assert(!domain.canAccess('b'));assert(!domain.canAccess('missing'));
 raw.nodeAccess={a:'locked'};await assert.rejects(persistence.ensureAccess('a'),/锁定/);assert.equal(model.state.nodeDetail.a.study_notes,'unsaved');
 raw.nodeAccess={b:'unlocked'};raw.nodeState={a:{completed:true}};await persistence.ensureAccess('b');assert(domain.isDone('a'));assert(!domain.isDone('b'));
 assert.equal(model.state.nodeDetail.a.study_notes,'unsaved','access synchronization must not overwrite drafts');
 assert(urls.every(url=>url==='/state/access?key='+encodeURIComponent(accessKey)),'access guards only request the single-document projection');
 model.state.nodeState.b={score:91,draft:{answer:'local'}};
 raw.nodeState.b={completed:false};await persistence.refreshAccess();assert.equal(model.state.nodeState.b.score,91);assert.equal(model.state.nodeState.b.draft.answer,'local');
 raw.nodeAccess={a:'locked'};await persistence.ensureNodeExists('a');assert(!domain.canAccess('a'),'generation existence guard must not unlock reading');
 raw.nodeAccess={b:'unlocked'};
 for(const malformed of [{...snapshot(),key:'u/other'},{...snapshot(),plan:{}},{...snapshot(),nodeAccess:[]},{...snapshot(),nodeState:{a:{completed:'yes'}}},{...snapshot(),revision:null}]) {
  override=malformed;await assert.rejects(persistence.refreshAccess(),/无法确认/);assert(!domain.canAccess('b'));
 }
 override=null;await persistence.refreshAccess();
 offline=true;await assert.rejects(persistence.ensureAccess('b'),/offline/);assert(!domain.canAccess('b'),'offline confirmation fails closed');
 offline='timeout';model.session.TIMEOUT=5;await assert.rejects(persistence.ensureAccess('b'),/超时/);assert(!domain.canAccess('b'));model.session.TIMEOUT=1000;
 offline=false;await persistence.ensureAccess('b');assert(domain.canAccess('b'),'fresh access allows retry');
 status=401;await assert.rejects(persistence.ensureAccess('b'),/登录/);assert(!domain.canAccess('b'));
 status=404;await assert.rejects(persistence.ensureAccess('b'),/删除/);assert(!domain.canAccess('b'));
 status=200;raw={plan:{nodes:[]},nodeAccess:{b:'unlocked'}};await assert.rejects(persistence.ensureAccess('b'),/不存在/);
 raw={plan:model.state.plan,nodeAccess:{a:'unlocked',b:'unlocked'},nodeState:{}};
 let concurrentResolve;waiting=new Promise(resolve=>{concurrentResolve=resolve;});
 const simultaneousA=persistence.ensureAccess('a'),simultaneousB=persistence.ensureAccess('b');
 concurrentResolve({ok:true,json:async()=>snapshot()});
 await Promise.all([simultaneousA,simultaneousB]);waiting=null;assert(domain.canAccess('a')&&domain.canAccess('b'),'same-document concurrent entry guards share the authoritative read');
 let finish;waiting=new Promise(resolve=>{finish=resolve;});const old=persistence.refreshAccess();persistence.applyNodeAccess({a:'locked'});finish({ok:true,json:async()=>snapshot({plan:model.state.plan,nodeAccess:{a:'unlocked'}})});await assert.rejects(old,/已更新/);assert.equal(model.state.nodeAccess.a,'locked','late GET cannot undo confirmed password switch');waiting=null;
 let rejectOld;waiting=new Promise((resolve,reject)=>{rejectOld=reject;});const rejected=persistence.refreshAccess();persistence.applyNodeAccess({b:'unlocked'});rejectOld(Error('offline'));await assert.rejects(rejected,error=>error.staleAccess);assert(!model.session.accessUnavailable,'stale network error cannot close a newer confirmed policy');waiting=null;
 let resolveA,resolveB,resolveNewA;
 waiting=new Promise(resolve=>{resolveA=resolve;});const docA=persistence.refreshAccess();
 currentKey='u/other';waiting=new Promise(resolve=>{resolveB=resolve;});const docB=persistence.refreshAccess();
 currentKey=accessKey;waiting=new Promise(resolve=>{resolveNewA=resolve;});const newA=persistence.refreshAccess();
 resolveNewA({ok:true,json:async()=>snapshot({plan:model.state.plan,nodeAccess:{a:'locked'}})});await newA;
 resolveA({ok:true,json:async()=>snapshot({plan:model.state.plan,nodeAccess:{a:'unlocked'}})});await assert.rejects(docA,error=>error.staleAccess);
 resolveB({ok:true,json:async()=>({...snapshot(),key:'u/other'})});await assert.rejects(docB,error=>error.staleAccess);assert.equal(model.state.nodeAccess.a,'locked','A→B→A old projection cannot undo the newest policy');waiting=null;
 user.readOnly=true;
 const shell=load('learning-path/modules/path-shell.js', {'path.model':model,'path.domain':domain,'path.format':format,'path.persistence':{save(){throw Error('readonly must not save');}},'path.hooks':{}}, {window:{LearnUser:user}});
 const before=JSON.stringify(model.state.nodeState);shell.setMark('a','mastered');assert.equal(JSON.stringify(model.state.nodeState),before,'readonly marking cannot mutate memory');
 await verifyPendingSelection();verifyDirectoryPreservesReading();verifyReadOnlyAssistant();
 assert(renders>0);
 console.log('PASS node access projection/schema, existence guard, concurrent/stale reads, draft preservation, pending DOM/controls, A→B→A, navigation/document races, owned-error retry, boot recovery identity, offline/timeout/401/404 and readonly regressions');
})().catch(error=>{console.error(error);process.exitCode=1;});
