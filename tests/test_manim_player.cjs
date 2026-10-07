'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
class Element {
  constructor(tag, doc) { this.tagName=tag; this.ownerDocument=doc; this.children=[]; this.dataset={}; this.attrs={}; this.handlers={}; this.hidden=false; this.currentTime=0; this.paused=true; this.textContent=''; this.tick=null; }
  appendChild(n) { this.children.push(n); n.parent=this; return n; }
  insertBefore(n) { this.children.unshift(n); n.parent=this; }
  replaceChildren() { this.children=[]; }
  setAttribute(k,v) { this.attrs[k]=v; }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(k,v) { (this.handlers[k] ||= []).push(v); }
  removeEventListener(k,v) { this.handlers[k]=(this.handlers[k] || []).filter(x=>x!==v); }
  emit(k) { for (const fn of this.handlers[k] || []) fn(); }
  querySelector(selector) { if (selector==='figcaption') return this.children.find(n=>n.tagName==='figcaption'); if(selector==='pre code') return this.code; return null; }
  querySelectorAll() { return this.figures || []; }
  matches() { return this.tagName==='figure'; }
  pause() { this.paused=true; }
  play() { this.paused=false; return this.rejectPlay ? Promise.reject(Error('decode')) : Promise.resolve(); }
  load() {}
  remove() { if(this.parent) this.parent.children=this.parent.children.filter(n=>n!==this); }
  requestVideoFrameCallback(fn) { this.tick=fn; return 1; }
  cancelVideoFrameCallback() { this.tick=null; }
  frame(time) { this.currentTime=time; const fn=this.tick; this.tick=null; if(fn) fn(0,{mediaTime:time}); }
}
const doc={createElement(tag){return new Element(tag,doc);},createTextNode(text){const e=new Element('#text',doc);e.textContent=text;return e;}};
const id='a'.repeat(32);
const manifest={version:1,asset_id:id,fps:30,width:1280,height:720,duration:4,engine:{name:'ManimGL',version:'1.7.2'},steps:[{caption:'先建立向量',start_frame:0,end_frame:60,result_frame:59,hold_start_frame:29},{caption:'再观察变换',start_frame:60,end_frame:120,result_frame:119,hold_start_frame:99}]};
let fetchCount=0, aborted=false, response=manifest, status=200;
const window={setTimeout(){return 3;},clearTimeout(){},LearnUser:{apiBase:'http://local/api',userId:'target',fetch(url,opts){fetchCount++; assert.equal(url,'http://local/api/manim/assets/'+id+'/manifest');opts.signal.addEventListener('abort',()=>{aborted=true;});return Promise.resolve({ok:status===200,status,json:()=>Promise.resolve(response)});}},requestAnimationFrame(fn){this.raf=fn;return 2;},cancelAnimationFrame(){this.raf=null;}};
vm.runInNewContext(fs.readFileSync('shared/manim-player.js','utf8'),{window,AbortController,console});
function figure(state='pending') { const f=new Element('figure',doc);f.dataset.manim=state;f.code={textContent:JSON.stringify({version:1,asset_id:id,title:'向量变换',summary:'观察方向与长度。'})};f.appendChild(new Element('figcaption',doc));return f; }
function descendants(root) { return root.children.flatMap(n=>[n,...descendants(n)]); }
function button(root,label) { return descendants(root).find(n=>n.tagName==='button' && n.textContent===label); }
const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
(async()=>{
  const markdownWindow={markdownit:require('../shared/vendor-markdown-it.js')};
  vm.runInNewContext(fs.readFileSync('shared/markdown.js','utf8'),{window:markdownWindow,WeakMap,Promise});
  const fence='```learn-manim\n'+JSON.stringify({version:1,asset_id:id,title:'<script>unsafe</script>',summary:'观察'})+'\n```';
  assert.match(markdownWindow.LearnMarkdown.render(fence),/data-manim="pending"/);
  assert.match(markdownWindow.LearnMarkdown.render(fence,{streaming:true}),/data-manim="waiting"/);
  assert.match(markdownWindow.LearnMarkdown.render(fence.slice(0,-3)),/data-manim="invalid"/);
  assert.doesNotMatch(markdownWindow.LearnMarkdown.render(fence),/<script>/);
  const validate=window.LearnManim.validate;
  assert.equal(validate(manifest,id),manifest);
  for(const patch of [{fps:60},{duration:91},{asset_id:'b'.repeat(32)},{engine:{name:'SVG',version:'1.7.2'}},{steps:[{caption:'坏步骤',start_frame:0,end_frame:20,result_frame:19}]}]) assert.throws(()=>validate({...manifest,...patch},id));
  assert.throws(()=>validate({...manifest,steps:[{...manifest.steps[0],hold_start_frame:40},manifest.steps[1]]},id),'hold must contain at least 21 frames');
  assert.throws(()=>validate({...manifest,steps:[manifest.steps[0],{...manifest.steps[1],start_frame:61}]},id));
  const waiting=figure('waiting');window.LearnManim.enhance(waiting);assert.equal(fetchCount,0,'streaming must not fetch media');
  const f=figure();window.LearnManim.enhance(f);await flush();
  const video=descendants(f).find(n=>n.tagName==='video');
  assert.equal(video.paused,true,'initial view never autoplays');assert.ok(video.poster.endsWith('poster.png?user=target'));
  window.LearnManim.enhance(f);assert.equal(fetchCount,1,'DOM move/enhance must preserve player');
  button(f,'播放本步').emit('click');await flush();video.frame(28/30);assert.equal(video.paused,false);video.frame(29/30);
  assert.equal(video.paused,true);assert.equal(video.currentTime,59/30,'stop at hold onset and seek exact result, never cross next step');
  const snapshot=descendants(f).find(n=>n.tagName==='img');snapshot.complete=true;snapshot.naturalWidth=1280;snapshot.emit('load');assert.equal(snapshot.hidden,false,'result image can load before seek completion');
  snapshot.hidden=true;video.emit('seeked');assert.equal(snapshot.hidden,false,'seek completion restores cached result image');
  button(f,'下一步').emit('click');snapshot.emit('load');assert.equal(snapshot.hidden,true,'late previous result never covers the new step');assert.equal(video.currentTime,2);assert.equal(video.paused,true);
  const range=descendants(f).find(n=>n.tagName==='input'&&n.type==='range');range.value='999';range.emit('input');assert.equal(video.currentTime,119/30,'seek clamps to current step');
  button(f,'上一步').emit('click');const continuous=descendants(f).find(n=>n.type==='checkbox');continuous.checked=true;
  button(f,'播放本步').emit('click');await flush();video.frame(50/30);assert.equal(video.paused,false,'continuous mode plays full authored hold');video.frame(60/30);assert.equal(video.paused,false);assert.equal(range.min,'60');
  button(f,'暂停').emit('click');assert.equal(video.tick,null,'pause cancels frame callback');
  video.emit('error');assert.ok(descendants(f).find(n=>n.textContent.includes('解码失败')));assert.equal(button(f,'播放本步').disabled,true);assert.equal(button(f,'重新加载').hidden,false);
  button(f,'重新加载').emit('click');await flush();assert.equal(button(f,'播放本步').disabled,false);
  video.rejectPlay=true;button(f,'播放本步').emit('click');await flush();assert.ok(descendants(f).find(n=>n.textContent.includes('未能播放')));assert.equal(video.tick,null);
  video.rejectPlay=false;button(f,'重新加载').emit('click');await flush();let completePlay;video.play=()=>new Promise(resolve=>{completePlay=resolve;});button(f,'播放本步').emit('click');button(f,'暂停').emit('click');completePlay();await flush();assert.equal(video.paused,true,'late play promise cannot restart a cancelled step');
  window.LearnManim.dispose(f);assert.equal(video.tick,null);assert.equal(aborted,true);assert.equal(f.dataset.manim,'pending');
  status=403;const denied=figure();window.LearnManim.enhance(denied);await flush();assert.ok(descendants(denied).find(n=>n.textContent.includes('无权查看')));
  status=200;response={...manifest,fps:24};const invalid=figure();window.LearnManim.enhance(invalid);await flush();assert.ok(descendants(invalid).find(n=>n.textContent==='动画清单无效'));
  response=manifest;const fallback=figure();window.LearnManim.enhance(fallback);await flush();const fv=descendants(fallback).find(n=>n.tagName==='video');fv.requestVideoFrameCallback=undefined;button(fallback,'播放本步').emit('click');await flush();fv.currentTime=40/30;window.raf();assert.equal(fv.paused,true);assert.equal(fv.currentTime,59/30);window.LearnManim.dispose(fallback);
  const assistantSource=fs.readFileSync('learning-path/modules/path-assistant.js','utf8');
  const levelModel={state:{spec:{},nodeDetail:{n:{study_notes:'已有正文'}},topic:'数学'},session:{nodeMaterialStatus:{}}};
  let levelAssistant;
  vm.runInNewContext(assistantSource,{define(name,deps,factory){levelAssistant=factory({'path.format':{},'path.model':levelModel,'path.domain':{nodeById:()=>({title:'当前单元'}),dispId:id=>id},'path.persistence':{}});}});
  for(const level of ['小学','初中','高中','本科']){
    levelModel.state.spec={level,goal:'按当前基础理解'};
    const unit=levelAssistant.aiUnit('n');assert.equal(unit.learner_level,level);assert.equal(unit.learning_goal,'按当前基础理解');assert.equal(unit.notes,'已有正文');
  }
  levelModel.state.spec={};assert.equal(levelAssistant.aiUnit('n').learner_level,'','missing level is not guessed');
  levelModel.state.spec={level:'长'.repeat(300),goal:'长'.repeat(500)};assert.equal(levelAssistant.aiUnit('n').learner_level.length,200);assert.equal(levelAssistant.aiUnit('n').learning_goal.length,400);
  const sendSource=assistantSource.slice(assistantSource.indexOf('function sendAi('),assistantSource.indexOf('  return Object.freeze'));
  const body=new Element('div',doc), box=new Element('div',doc);box.querySelector=()=>null;
  const input={value:'question',style:{},focus(){}};
  const view={input,box};
  const model={state:{aiHist:{}},session:{API:'http://local/api'}};
  const rendered=[];let finishStream,failStream,reads=0;
  const statusText='正在生成并检查分步动画… <img onerror=bad>';
  const encoder=new TextEncoder();
  const reader={read(){reads++;if(reads===1)return Promise.resolve({value:encoder.encode('data: '+JSON.stringify({delta:'已有正文'})+'\n')});if(reads===2)return Promise.resolve({value:encoder.encode('data: '+JSON.stringify({status:statusText,delta:''})+'\n')});return new Promise((resolve,reject)=>{finishStream=resolve;failStream=reject;});}};
  const assistantContext={document:doc,TextDecoder,session:{aiBusy:false,aiViews:new Map([['real-node',view]])},model,format:{storeKey:()=> 'owner/material'},persistence:{saveAi(){}},aiHistTail:()=>[],aiHistTrim(){},aiClip:s=>s,aiScroll(){},syncAiBusy(){},aiUnit:()=>({}),aiRenderInto(el,content,streaming){rendered.push({content,streaming});el.textContent=content;},aiBubble(role){const t=new Element('div',doc);const b=role==='assistant'?body:new Element('div',doc);t.appendChild(b);t.querySelector=()=>b;return t;},window:{LearnUser:{fetch:()=>Promise.resolve({ok:true,body:{getReader:()=>reader}})}}};
  vm.runInNewContext(sendSource+'\nsendAi("real-node","question");',assistantContext);await flush();
  const target=box.children[1], statusNode=target.children.find(n=>n.tagName==='p');
  assert.equal(statusNode.textContent,statusText,'SSE status is displayed as plain text');assert.equal(statusNode.hidden,false);assert.equal(statusNode.attrs.role,'status');
  assert.equal(body.textContent,'已有正文','heartbeat preserves the answer DOM');assert.equal(rendered.length,1,'status does not render/enhance markdown');assert.equal(rendered[0].streaming,true);
  finishStream({done:true});await flush();assert.equal(target.children.includes(statusNode),false,'completed response removes generation status');assert.equal(model.state.aiHist['real-node'][1].content,'已有正文','generation status never enters saved history');
  assert.equal(rendered.at(-1).streaming,undefined,'enhancement happens only when response completes');
  reads=0;vm.runInNewContext(sendSource+'\nsendAi("real-node","question again");',assistantContext);await flush();const failedTarget=box.children[3],failedStatus=failedTarget.children.find(n=>n.tagName==='p');assert.equal(failedStatus.hidden,false);failStream(Error('network interrupted'));await flush();assert.equal(failedTarget.children.includes(failedStatus),false,'network failure removes generation status');assert.equal(assistantContext.session.aiBusy,false,'network failure unlocks next request');
  console.log('Manim player boundary, continuous hold, auth/error/retry, cancellation and RAF fallback passed');
})().catch(error=>{console.error(error);process.exitCode=1;});
