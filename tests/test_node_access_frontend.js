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
let raw = {plan: model.state.plan, nodeAccess: {}, nodeState:{}}, status = 200, offline = false, renders = 0, waiting;
const user = {readOnly:false, fetch: async () => {
  if (offline) throw Error('offline');
  if (waiting) return waiting;
  return {ok:status===200,status,json:async()=>({ok:true,entries:{'u/learn-path-v1-test':typeof raw==='string'?raw:raw===null?null:JSON.stringify(raw)}})};
}};
const format = {storeKey:()=> 'u/learn-path-v1-test', $:()=>null};
const persistence = load('learning-path/modules/path-persistence.js', {'path.model':model,'path.domain':domain,'path.format':format,'path.hooks':{renderPlan(){renders++;}}}, {window:{LearnUser:user,addEventListener(){}},document:{addEventListener(){}}});

function miniDom() {
 const document={activeElement:null};
 class Element {
  constructor(tag){this.tagName=tag;this.children=[];this.attrs={};this.style={};this.listeners={};this.value='';this.hidden=false;this.disabled=false;this.readOnly=false;this.isConnected=true;this._html='';this.className='';this.classList={contains:name=>this.className.split(' ').includes(name),toggle:(name,on)=>{const set=new Set(this.className.split(' ').filter(Boolean));on?set.add(name):set.delete(name);this.className=[...set].join(' ');}};}
  get childNodes(){return this.children;}
  appendChild(child){if(child.parentNode)child.parentNode.children=child.parentNode.children.filter(node=>node!==child);this.children.push(child);child.parentNode=this;return child;}
  replaceChildren(...nodes){this.children=[];nodes.forEach(node=>this.appendChild(node));}
  setAttribute(key,value){this.attrs[key]=String(value);if(key==='id')this.id=String(value);if(key==='class')this.className=String(value);}
  getAttribute(key){return this.attrs[key]??null;}
  querySelectorAll(selector){const selectors=selector.split(',').map(x=>x.trim());return walk(this).filter(node=>selectors.some(value=>value.startsWith('.')?node.className.split(' ').includes(value.slice(1)):value.startsWith('#')?node.id===value.slice(1):node.tagName===value));}
  querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
  addEventListener(name,handler){(this.listeners[name]||=[]).push(handler);}
  focus(){document.activeElement=this;}
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
 offline=true;await assert.rejects(persistence.ensureAccess('b'),/offline/);assert(!domain.canAccess('b'),'offline confirmation fails closed');
 offline=false;await persistence.ensureAccess('b');assert(domain.canAccess('b'),'fresh access allows retry');
 status=401;await assert.rejects(persistence.ensureAccess('b'),/登录/);assert(!domain.canAccess('b'));
 status=200;raw=null;await assert.rejects(persistence.ensureAccess('b'),/删除/);assert(!domain.canAccess('b'));
 raw={plan:{nodes:[]},nodeAccess:{b:'unlocked'}};await assert.rejects(persistence.ensureAccess('b'),/不存在/);
 raw={plan:model.state.plan,nodeAccess:{a:'unlocked',b:'unlocked'},nodeState:{}};
 let concurrentResolve;waiting=new Promise(resolve=>{concurrentResolve=resolve;});
 const simultaneousA=persistence.ensureAccess('a'),simultaneousB=persistence.ensureAccess('b');
 concurrentResolve({ok:true,json:async()=>({ok:true,entries:{'u/learn-path-v1-test':JSON.stringify(raw)}})});
 await Promise.all([simultaneousA,simultaneousB]);waiting=null;assert(domain.canAccess('a')&&domain.canAccess('b'),'same-document concurrent entry guards share the authoritative read');
 let finish;waiting=new Promise(resolve=>{finish=resolve;});const old=persistence.refreshAccess();persistence.applyNodeAccess({a:'locked'});finish({ok:true,json:async()=>({ok:true,entries:{'u/learn-path-v1-test':JSON.stringify({nodeAccess:{a:'unlocked'}})}})});await assert.rejects(old,/已更新/);assert.equal(model.state.nodeAccess.a,'locked','late GET cannot undo confirmed password switch');waiting=null;
 user.readOnly=true;
 const shell=load('learning-path/modules/path-shell.js', {'path.model':model,'path.domain':domain,'path.format':format,'path.persistence':{save(){throw Error('readonly must not save');}},'path.hooks':{}}, {window:{LearnUser:user}});
 const before=JSON.stringify(model.state.nodeState);shell.setMark('a','mastered');assert.equal(JSON.stringify(model.state.nodeState),before,'readonly marking cannot mutate memory');
 verifyDirectoryPreservesReading();verifyReadOnlyAssistant();
 assert(renders>0);
 console.log('PASS node access defaults, explicit own overrides, completion independence, authoritative refresh, draft preservation, offline/401/deletion, stale reads and readonly marks');
})().catch(error=>{console.error(error);process.exitCode=1;});
