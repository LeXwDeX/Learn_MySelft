'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
class Element {
  constructor(tag, doc) { this.tagName=tag; this.ownerDocument=doc; this.children=[]; this.dataset={}; this.attrs={}; this.handlers={}; this.hidden=false; this._currentTime=0; this.seeking=false; this.readyState=2; this.style=new Proxy({},{set(target,key,value){if(key==='opacity')assert.equal(value,'1','the complete Manim picture must never fade to black');target[key]=value;return true;}}); this.paused=true; this.playCount=0; this.complete=tag==='img'; this.naturalWidth=tag==='img'?1280:0; this.textContent=''; this.tick=null; }
  appendChild(n) { this.children.push(n); n.parent=this; return n; }
  insertBefore(n) { this.children.unshift(n); n.parent=this; }
  replaceChildren() { this.children=[]; }
  setAttribute(k,v) { this.attrs[k]=v; }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(k,v) { (this.handlers[k] ||= []).push(v); }
  removeEventListener(k,v) { this.handlers[k]=(this.handlers[k] || []).filter(x=>x!==v); }
  get currentTime() { return this._currentTime; }
  set currentTime(value) { if(value!==this._currentTime) this.seeking=true; this._currentTime=value; }
  emit(k) { if(k==='seeked') this.seeking=false; for (const fn of this.handlers[k] || []) fn(); }
  querySelector(selector) { if (selector==='figcaption') return this.children.find(n=>n.tagName==='figcaption'); if(selector==='pre code') return this.code; return null; }
  querySelectorAll() { return this.figures || []; }
  matches() { return this.tagName==='figure'; }
  pause() { this.paused=true; }
  play() { this.playCount++; this.paused=false; return this.rejectPlay ? Promise.reject(Error('decode')) : Promise.resolve(); }
  load() {}
  remove() { if(this.parent) this.parent.children=this.parent.children.filter(n=>n!==this); }
  requestVideoFrameCallback(fn) { this.tick=fn; return 1; }
  cancelVideoFrameCallback() { this.tick=null; }
  frame(time) { this._currentTime=time; const fn=this.tick; this.tick=null; if(fn) fn(0,{mediaTime:time}); }
}
const doc={handlers:{},hidden:false,addEventListener:Element.prototype.addEventListener,removeEventListener:Element.prototype.removeEventListener,emit:Element.prototype.emit,createElement(tag){return new Element(tag,doc);},createTextNode(text){const e=new Element('#text',doc);e.textContent=text;return e;}};
const id='a'.repeat(32);
const manifest={version:1,asset_id:id,fps:30,width:1280,height:720,duration:4,engine:{name:'ManimGL',version:'1.7.2'},steps:[{caption:'先建立向量',start_frame:0,end_frame:60,result_frame:59,hold_start_frame:29},{caption:'再观察变换',start_frame:60,end_frame:120,result_frame:119,hold_start_frame:99}]};
let fetchCount=0, aborted=false, response=manifest, status=200;
let now=0, timerId=0, reducedMotion=false; const timers=new Map();
const window={handlers:{},addEventListener:Element.prototype.addEventListener,removeEventListener:Element.prototype.removeEventListener,emit:Element.prototype.emit,matchMedia(){return {matches:reducedMotion};},setTimeout(fn,ms){const id=++timerId;timers.set(id,{fn,at:now+ms});return id;},clearTimeout(id){timers.delete(id);},LearnUser:{apiBase:'http://local/api',userId:'target',fetch(url,opts){fetchCount++; assert.equal(url,'http://local/api/manim/assets/'+id+'/manifest');opts.signal.addEventListener('abort',()=>{aborted=true;});return Promise.resolve({ok:status===200,status,json:()=>Promise.resolve(response)});}},requestAnimationFrame(fn){this.raf=fn;return 2;},cancelAnimationFrame(){this.raf=null;}};
vm.runInNewContext(fs.readFileSync('shared/manim-player.js','utf8'),{window,AbortController,console});
function figure(state='pending') { const f=new Element('figure',doc);f.dataset.manim=state;f.code={textContent:JSON.stringify({version:1,asset_id:id,title:'向量变换',summary:'观察方向与长度。'})};f.appendChild(new Element('figcaption',doc));return f; }
function descendants(root) { return root.children.flatMap(n=>[n,...descendants(n)]); }
function button(root,label) { return descendants(root).find(n=>n.tagName==='button' && n.textContent===label); }
const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
async function advance(ms) { const end=now+ms; while(true){const next=[...timers.entries()].filter(([,t])=>t.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;now=next[1].at;timers.delete(next[0]);next[1].fn();await flush();}now=end;await flush(); }
function phase(f){return descendants(f).find(n=>n.className==='learn-manim').dataset.phase;}
function range(f){return descendants(f).find(n=>n.tagName==='input'&&n.type==='range');}
function layer(f){return descendants(f).find(n=>n.className==='learn-manim-media');}
async function fixture(ready=true){const f=figure();window.LearnManim.enhance(f);await flush();const result=descendants(f).find(n=>n.tagName==='img');result.complete=ready;result.naturalWidth=ready?1280:0;return {f,v:descendants(f).find(n=>n.tagName==='video'),result};}
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
  assert.equal(validate({...manifest,engine:{name:'ManimGX',version:'0.1.1'}},id).engine.name,'ManimGX');
  for(const patch of [{fps:60},{duration:91},{asset_id:'b'.repeat(32)},{engine:{name:'SVG',version:'1.7.2'}},{engine:{name:'ManimGX',version:'0.1.0'}},{engine:{name:'constructor',version:'1'}},{steps:[{caption:'坏步骤',start_frame:0,end_frame:20,result_frame:19}]}]) assert.throws(()=>validate({...manifest,...patch},id));
  assert.throws(()=>validate({...manifest,steps:[{...manifest.steps[0],hold_start_frame:40},manifest.steps[1]]},id),'hold must contain at least 21 frames');
  assert.throws(()=>validate({...manifest,steps:[manifest.steps[0],{...manifest.steps[1],start_frame:61}]},id));
  const waiting=figure('waiting');window.LearnManim.enhance(waiting);assert.equal(fetchCount,0,'streaming must not fetch media');
  const {f,v:video,result:snapshot}=await fixture();
  assert.equal(video.paused,true,'initial view never autoplays');assert.ok(video.poster.endsWith('poster.png?user=target'));
  assert.equal(video.playbackRate,.9,'all steps run at 90% speed');assert.equal(video.muted,true,'silent media may resume after asynchronous seeks');
  assert.equal(button(f,'自动播放').attrs['aria-pressed'],undefined,'automatic playback is an action, not a mode toggle');assert.equal(descendants(f).some(n=>n.type==='checkbox'),false);
  assert.ok(snapshot.src.endsWith('step-0.png?user=target'),'preload the current real Manim result');
  window.LearnManim.enhance(f);assert.equal(fetchCount,1,'DOM move/enhance must preserve player');
  button(f,'自动播放').emit('click');assert.equal(video.playCount,1,'a single automatic click starts media immediately');await flush();
  video.frame(28/30);assert.equal(video.paused,false);video.frame(29/30);
  assert.equal(video.paused,true);assert.equal(video.currentTime,59/30);assert.equal(phase(f),'hold');assert.equal(snapshot.hidden,false);assert.ok(button(f,'暂停'));
  video.emit('seeked');const count=video.playCount;button(f,'自动播放').emit('click');button(f,'自动播放').emit('click');assert.equal(video.playCount,count,'repeated clicks do not stack sessions');
  await advance(249);assert.equal(phase(f),'hold');assert.equal(range(f).min,'0');assert.equal(layer(f).style.opacity,'1');
  await advance(1);assert.equal(phase(f),'seeking');assert.equal(video.currentTime,2,'only 250ms is added; authored tail and 0.9 rate do not extend the interval');assert.equal(range(f).min,'0');assert.equal(snapshot.hidden,false,'previous real result shields the next seek');
  assert.equal(layer(f).style.opacity,'1');await advance(500);assert.equal(video.paused,true);assert.equal(snapshot.hidden,false,'network/decode delay never exposes an unready frame');
  button(f,'自动播放').emit('click');assert.equal(video.playCount,count);
  video._currentTime=59/30;video.emit('seeked');assert.equal(phase(f),'seeking','stale seek completion does not reveal a previous-step frame');assert.equal(snapshot.hidden,false);
  video._currentTime=2;video.emit('seeked');await flush();assert.equal(phase(f),'playback');assert.equal(range(f).min,'60');assert.equal(snapshot.hidden,true);assert.equal(video.paused,false);assert.equal(video.playbackRate,.9);
  video.frame(99/30);video.emit('seeked');await advance(249);assert.equal(phase(f),'hold');await advance(1);
  assert.equal(video.paused,true);assert.equal(video.currentTime,119/30);assert.equal(phase(f),'idle');assert.equal(snapshot.hidden,false,'final authored result stays visible');assert.equal(layer(f).style.opacity,'1');
  button(f,'上一步').emit('click');video.emit('seeked');button(f,'重播本步').emit('click');video.emit('seeked');await flush();video.frame(29/30);await advance(1000);
  assert.equal(range(f).min,'0');assert.equal(phase(f),'idle','replay remains bounded to the selected step');assert.equal(video.currentTime,59/30);
  button(f,'下一步').emit('click');snapshot.emit('load');assert.equal(snapshot.hidden,true,'late previous result never covers a manually selected step');assert.equal(video.currentTime,2);assert.equal(video.paused,true);
  const progress=range(f);progress.value='999';progress.emit('input');assert.equal(video.currentTime,119/30,'manual seek clamps to the selected step');
  video.emit('error');assert.ok(descendants(f).find(n=>n.textContent.includes('解码失败')));assert.equal(button(f,'播放').disabled,true);assert.equal(button(f,'重新加载').hidden,false);
  button(f,'重新加载').emit('click');await flush();assert.equal(button(f,'播放').disabled,false);assert.equal(video.playbackRate,.9);
  video.rejectPlay=true;button(f,'自动播放').emit('click');await flush();assert.ok(descendants(f).find(n=>n.textContent.includes('未能播放')));assert.equal(video.tick,null);
  video.rejectPlay=false;button(f,'重新加载').emit('click');await flush();let completePlay;video.play=()=>new Promise(resolve=>{completePlay=resolve;});button(f,'播放').emit('click');button(f,'暂停').emit('click');completePlay();await flush();assert.equal(video.paused,true,'late play promise cannot restart a cancelled step');
  window.LearnManim.dispose(f);assert.equal(video.tick,null);assert.equal(aborted,true);assert.equal(f.dataset.manim,'pending');

  // Cancel both result holding and each asynchronous preparation path.
  for(const at of ['hold','waiting-result','seeking']) {
    for(const action of ['pause','previous','next','step','scrub','hidden','error','reload','dispose','pagehide']) {
      const {f,v,result}=await fixture(at!=='waiting-result');button(f,'自动播放').emit('click');await flush();v.frame(29/30);v.emit('seeked');
      if(at!=='hold')await advance(250);
      assert.equal(phase(f),at==='hold'?'hold':'seeking');assert.equal(layer(f).style.opacity,'1');const stale=[...timers.values()].map(t=>t.fn);
      if(action==='pause')button(f,'暂停').emit('click');
      if(action==='previous') {button(f,'下一步').emit('click');button(f,'上一步').emit('click');}
      if(action==='next')button(f,'下一步').emit('click');
      if(action==='step')descendants(f).find(n=>n.tagName==='button'&&n.textContent==='1').onclick();
      if(action==='scrub'){range(f).value=range(f).min;range(f).emit('input');}
      if(action==='hidden'){doc.hidden=true;doc.emit('visibilitychange');doc.hidden=false;}
      if(action==='error')v.emit('error');
      if(action==='reload'){v.emit('error');button(f,'重新加载').emit('click');await flush();}
      if(action==='dispose')window.LearnManim.dispose(f);
      if(action==='pagehide')window.emit('pagehide');
      const count=v.playCount;for(const callback of stale)callback();v.emit('seeked');result.complete=true;result.naturalWidth=1280;result.emit('load');await advance(11000);
      assert.equal(v.playCount,count,at+'/'+action+' cannot restart stale autoplay');assert.equal(v.paused,true);
      window.LearnManim.dispose(f);
    }
  }
  const ordinary=await fixture();button(ordinary.f,'播放').emit('click');await flush();ordinary.v.frame(29/30);ordinary.v.emit('seeked');await advance(250);ordinary.v.emit('seeked');await flush();assert.equal(range(ordinary.f).min,'60','ordinary playback also advances in order');assert.equal(ordinary.v.paused,false);window.LearnManim.dispose(ordinary.f);
  const promoted=await fixture();button(promoted.f,'重播本步').emit('click');await flush();const promotedCount=promoted.v.playCount;button(promoted.f,'自动播放').emit('click');assert.equal(promoted.v.playCount,promotedCount,'automatic action reuses active media instead of stacking another session');promoted.v.frame(29/30);promoted.v.emit('seeked');await advance(250);promoted.v.emit('seeked');await flush();assert.equal(range(promoted.f).min,'60','automatic action continues a current replay in step order');window.LearnManim.dispose(promoted.f);
  const same=await fixture();button(same.f,'重播本步').emit('click');await flush();assert.equal(same.v.paused,false,'same decoded first frame does not need an event');same.v.frame(10/30);button(same.f,'暂停').emit('click');button(same.f,'播放').emit('click');await flush();same.v.frame(29/30);await advance(1000);assert.equal(range(same.f).min,'0','resuming a paused replay still stays in its step');assert.equal(same.v.paused,true);window.LearnManim.dispose(same.f);
  const silent=await fixture();button(silent.f,'下一步').emit('click');button(silent.f,'自动播放').emit('click');await flush();assert.equal(silent.v.playCount,1,'user click primes playback before waiting for seek');assert.equal(silent.v.paused,true);silent.v.emit('seeked');await flush();assert.equal(silent.v.playCount,2);assert.equal(silent.v.paused,false);silent.v.frame(99/30);silent.v.emit('seeked');await advance(250);assert.equal(range(silent.f).min,'60','automatic action starts from the current step');assert.equal(silent.v.paused,true);window.LearnManim.dispose(silent.f);
  const interrupted=await fixture();button(interrupted.f,'下一步').emit('click');const normalPlay=interrupted.v.play.bind(interrupted.v);let priming=true;
  interrupted.v.play=()=>{if(priming){priming=false;const error=Error('pause interrupted pending play');error.name='AbortError';return Promise.reject(error);}return normalPlay();};
  button(interrupted.f,'自动播放').emit('click');await flush();assert.equal(button(interrupted.f,'重新加载').hidden,true,'expected priming AbortError does not report a playback failure');interrupted.v.emit('seeked');await flush();assert.equal(interrupted.v.paused,false,'resume after interrupted user-gesture priming');window.LearnManim.dispose(interrupted.f);
  const staleFrame=await fixture();button(staleFrame.f,'播放').emit('click');await flush();const oldTick=staleFrame.v.tick;button(staleFrame.f,'暂停').emit('click');button(staleFrame.f,'播放').emit('click');await flush();oldTick(0,{mediaTime:60/30});assert.equal(phase(staleFrame.f),'playback','old frame callback cannot advance a new session');assert.equal(range(staleFrame.f).min,'0');window.LearnManim.dispose(staleFrame.f);
  const stalled=await fixture();button(stalled.f,'自动播放').emit('click');await flush();stalled.v.frame(29/30);stalled.v.emit('seeked');await advance(250);const staleSeek=[...timers.values()].map(t=>t.fn);
  button(stalled.f,'暂停').emit('click');assert.equal(stalled.result.hidden,false);assert.equal(layer(stalled.f).style.opacity,'1');assert.ok(stalled.result.src.endsWith('step-0.png?user=target'));assert.equal(range(stalled.f).min,'0');assert.equal(stalled.v.currentTime,59/30);
  const stalledCount=stalled.v.playCount;await advance(250);await advance(10000);for(const callback of staleSeek)callback();await flush();assert.equal(stalled.result.hidden,false);assert.equal(stalled.v.paused,true);assert.equal(stalled.v.playCount,stalledCount,'missing seeked never revives cancelled autoplay');window.LearnManim.dispose(stalled.f);
  const delayed=await fixture(false);button(delayed.f,'自动播放').emit('click');await flush();delayed.v.frame(29/30);delayed.v.emit('seeked');await advance(250);assert.equal(delayed.v.currentTime,59/30,'unavailable result PNG leaves the known result video in place');assert.equal(delayed.result.hidden,true);assert.equal(layer(delayed.f).style.opacity,'1');delayed.result.complete=true;delayed.result.naturalWidth=1280;delayed.result.emit('load');assert.equal(delayed.result.hidden,false);assert.equal(delayed.v.currentTime,2);delayed.v.emit('seeked');await flush();assert.equal(delayed.result.hidden,true);assert.equal(range(delayed.f).min,'60');assert.equal(delayed.v.paused,false);window.LearnManim.dispose(delayed.f);
  const missing=await fixture(false);button(missing.f,'自动播放').emit('click');await flush();missing.v.frame(29/30);missing.v.emit('seeked');await advance(10250);assert.ok(descendants(missing.f).find(n=>n.textContent.includes('结果画面加载失败')),'missing result shields fail with a bounded timeout');assert.equal(missing.v.paused,true);assert.equal(range(missing.f).min,'0');assert.equal(layer(missing.f).style.opacity,'1');window.LearnManim.dispose(missing.f);
  const imageError=await fixture(false);button(imageError.f,'自动播放').emit('click');await flush();imageError.v.frame(29/30);imageError.v.emit('seeked');await advance(250);imageError.result.emit('error');assert.ok(descendants(imageError.f).find(n=>n.textContent.includes('结果画面加载失败')));assert.equal(imageError.v.currentTime,59/30);assert.equal(imageError.v.paused,true);window.LearnManim.dispose(imageError.f);
  reducedMotion=true;const reduced=await fixture();button(reduced.f,'自动播放').emit('click');await flush();reduced.v.frame(50/30);reduced.v.emit('seeked');await advance(249);assert.equal(phase(reduced.f),'hold');await advance(1);assert.equal(phase(reduced.f),'seeking');assert.equal(layer(reduced.f).style.opacity,'1');assert.equal(reduced.result.hidden,false);reduced.v.emit('seeked');await flush();assert.equal(range(reduced.f).min,'60');assert.equal(reduced.v.paused,false);window.LearnManim.dispose(reduced.f);reducedMotion=false;
  const timed=await fixture();button(timed.f,'下一步').emit('click');button(timed.f,'自动播放').emit('click');await flush();await advance(10000);assert.ok(descendants(timed.f).find(n=>n.textContent.includes('无法定位')),'seek fails with a bounded timeout');assert.equal(timed.v.paused,true);window.LearnManim.dispose(timed.f);
  const reload=await fixture();reload.v.playbackRate=1;reload.v.emit('error');button(reload.f,'重新加载').emit('click');await flush();assert.equal(reload.v.playbackRate,.9);assert.equal(reload.v.paused,true);assert.equal(button(reload.f,'自动播放').attrs['aria-pressed'],undefined);window.LearnManim.dispose(reload.f);
  status=403;const denied=figure();window.LearnManim.enhance(denied);await flush();assert.ok(descendants(denied).find(n=>n.textContent.includes('无权查看')));window.LearnManim.dispose(denied);
  status=200;response={...manifest,fps:24};const invalid=figure();window.LearnManim.enhance(invalid);await flush();assert.ok(descendants(invalid).find(n=>n.textContent==='动画清单无效'));window.LearnManim.dispose(invalid);
  response=manifest;const {f:fallback,v:fv}=await fixture();fv.requestVideoFrameCallback=undefined;button(fallback,'重播本步').emit('click');await flush();fv._currentTime=40/30;window.raf();assert.equal(fv.paused,true);assert.equal(fv.currentTime,59/30);window.LearnManim.dispose(fallback);
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
  const rendered=[];let finishStream,failStream,reads=0,accessChecks=0,askRequests=0,rejectAccess=false;
  const statusText='正在生成并检查分步动画… <img onerror=bad>';
  const encoder=new TextEncoder();
  const reader={read(){reads++;if(reads===1)return Promise.resolve({value:encoder.encode('data: '+JSON.stringify({delta:'已有正文'})+'\n')});if(reads===2)return Promise.resolve({value:encoder.encode('data: '+JSON.stringify({status:statusText,delta:''})+'\n')});return new Promise((resolve,reject)=>{finishStream=resolve;failStream=reject;});}};
  const assistantContext={document:doc,TextDecoder,session:{aiBusy:false,aiViews:new Map([['real-node',view]])},model,format:{storeKey:()=> 'owner/material'},persistence:{saveAi(){},ensureAccess(id){accessChecks++;assert.equal(id,'real-node');return rejectAccess?Promise.reject(Error('node locked')):Promise.resolve(true);}},aiHistTail:()=>[],aiHistTrim(){},aiClip:s=>s,aiScroll(){},syncAiBusy(){},aiUnit:()=>({}),aiRenderInto(el,content,streaming){rendered.push({content,streaming});el.textContent=content;},aiBubble(role){const t=new Element('div',doc);const b=role==='assistant'?body:new Element('div',doc);t.appendChild(b);t.querySelector=()=>b;return t;},window:{LearnUser:{fetch:()=>{askRequests++;return Promise.resolve({ok:true,body:{getReader:()=>reader}});}}}};
  vm.runInNewContext(sendSource+'\nsendAi("real-node","question");',assistantContext);await flush();
  const target=box.children[1], statusNode=target.children.find(n=>n.tagName==='p');
  assert.equal(statusNode.textContent,statusText,'SSE status is displayed as plain text');assert.equal(statusNode.hidden,false);assert.equal(statusNode.attrs.role,'status');
  assert.equal(body.textContent,'已有正文','heartbeat preserves the answer DOM');assert.equal(rendered.length,1,'status does not render/enhance markdown');assert.equal(rendered[0].streaming,true);
  finishStream({done:true});await flush();assert.equal(target.children.includes(statusNode),false,'completed response removes generation status');assert.equal(model.state.aiHist['real-node'][1].content,'已有正文','generation status never enters saved history');
  assert.equal(rendered.at(-1).streaming,undefined,'enhancement happens only when response completes');
  reads=0;vm.runInNewContext(sendSource+'\nsendAi("real-node","question again");',assistantContext);await flush();const failedTarget=box.children[3],failedStatus=failedTarget.children.find(n=>n.tagName==='p');assert.equal(failedStatus.hidden,false);failStream(Error('network interrupted'));await flush();assert.equal(failedTarget.children.includes(failedStatus),false,'network failure removes generation status');assert.equal(assistantContext.session.aiBusy,false,'network failure unlocks next request');
  const beforeDeniedHistory=JSON.stringify(model.state.aiHist),beforeDeniedRequests=askRequests,beforeDeniedRenders=rendered.length;
  rejectAccess=true;input.value='keep this draft';
  vm.runInNewContext(sendSource+'\nsendAi("real-node","blocked question");',assistantContext);await flush();
  assert.equal(accessChecks,3,'every AI send confirms node access before changing conversation');
  assert.equal(askRequests,beforeDeniedRequests,'denied access never sends an AI request');
  assert.equal(input.value,'keep this draft','denied access preserves the unsent draft');
  assert.equal(JSON.stringify(model.state.aiHist),beforeDeniedHistory,'denied access preserves saved conversation');
  assert.equal(rendered.length,beforeDeniedRenders,'denied access does not replace the source answer DOM');
  assert.equal(assistantContext.session.aiAccessPending,false,'failed access check allows a later retry');
  const beforeReadonlyChecks=accessChecks;assistantContext.window.LearnUser.readOnly=true;
  vm.runInNewContext(sendSource+'\nsendAi("real-node","readonly question");',assistantContext);await flush();
  assert.equal(accessChecks,beforeReadonlyChecks,'readonly blocks before the access request');
  assert.equal(askRequests,beforeDeniedRequests,'readonly cannot send an AI request');
  console.log('Manim player one-click automatic playback, fixed 250ms result hold, visible seek shields, 90% speed, cancellation and errors passed');
})().catch(error=>{console.error(error);process.exitCode=1;});
