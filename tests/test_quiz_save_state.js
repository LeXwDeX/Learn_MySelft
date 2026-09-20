'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const elements={};function element(id){return elements[id]||(elements[id]={textContent:'',hidden:false,disabled:false,classList:{toggle(){}}});}
const requests=[];const storage=new Map();const context={console,setTimeout,clearTimeout,AbortController,Blob,
 localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},
 window:{LearnUser:{fetch:(url,options)=>new Promise((resolve,reject)=>requests.push({url,body:JSON.parse(options.body),resolve,reject}))}}};
vm.createContext(context);vm.runInContext(fs.readFileSync('learning-path/quiz_dialog.js','utf8').replace('  window.QuizDialog = {',`  globalThis.testApi={transmit,retrySave,flushCurrent,flushAll,renderSaveState,localKey,records,
 setView(value){view=value;dialog={open:true,querySelector:s=>globalThis.getElement(s.slice(1))}},closeDialog(){dialog.open=false}};
 window.QuizDialog = {`),Object.assign(context,{getElement:element}));
const t=context.testApi,config={key:'u0/learn-path-v1-test',api:'http://localhost',nodeId:'n1'};
function makeRecord(id='r1'){const issued={id,questions:[],draft:null};const key=t.localKey(config,id);const r={key,config,roundId:id,round:issued,version:1,answers:['a'],saved:false,localSaved:true,syncState:'failed'};t.records[key]=r;return r;}
function show(r,extra={}){t.setView({config,quiz:{rounds:[r.round]},index:0,busy:false,readOnly:false,...extra});t.renderSaveState();}
async function tick(){for(let i=0;i<8;i++)await Promise.resolve();}
function respond(req){req.resolve({ok:true,json:async()=>({draft:{answers:req.body.answers}})});}
(async()=>{
 const r=makeRecord();show(r);assert.equal(element('qd-sync').hidden,false);
 const p=t.retrySave();assert.equal(element('qd-save').textContent,'正在重试保存…');assert(element('qd-sync').hidden);t.retrySave();await tick();assert.equal(requests.length,1);respond(requests[0]);await p;assert(r.saved);assert(element('qd-sync').hidden);
 r.version=2;r.saved=false;r.syncState='failed';show(r);const fail=t.retrySave();await tick();requests[1].reject(new Error('offline'));await fail;assert(!r.saved);assert(!element('qd-sync').hidden);assert.match(element('qd-save').textContent,/同步失败/);
 const older=t.retrySave();await tick();r.version=3;r.answers=['new'];r.syncState='pending';r.retrying=false;t.renderSaveState();respond(requests[2]);await older;assert(!r.saved);assert.doesNotMatch(element('qd-save').textContent,/已自动保存/);
 const newer=t.transmit(r);await tick();show(r,{readOnly:true,attempt:{id:'a1'}});const history=element('qd-save').textContent;respond(requests[3]);await newer;assert.equal(element('qd-save').textContent,history);assert(element('qd-sync').hidden);
 r.version=4;r.saved=false;r.syncState='failed';show(r,{readOnly:true,attempt:{}});assert.equal(t.retrySave(),undefined);const background=t.flushCurrent();await tick();assert.equal(requests.length,5);respond(requests[4]);await background;assert(r.saved,'background flush remains active from a history view');
 r.version=5;r.saved=false;r.syncState='failed';show(r);const switched=t.retrySave();await tick();const other=makeRecord('r2');other.saved=true;show(other);const unchanged=element('qd-save').textContent;requests[5].reject(new Error('old'));await switched;assert.equal(element('qd-save').textContent,unchanged);
 show(r,{config:{...config,readOnly:true},readOnly:true});assert(element('qd-sync').hidden);assert.equal(t.retrySave(),undefined);
 show(r,{busy:true});assert(element('qd-sync').hidden);show(r);const closing=t.retrySave();await tick();t.closeDialog();respond(requests[6]);await closing;show(r);assert(element('qd-sync').hidden);assert.match(element('qd-save').textContent,/已自动保存/);
 console.log('PASS quiz retry visibility, duplicate suppression, version/record isolation, history background save, admin/grading/close');
})().catch(e=>{console.error(e);process.exitCode=1});
