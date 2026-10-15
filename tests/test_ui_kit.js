'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
function setup() {
  const elements = new Map(), listeners = {}; let document;
  class Element {
    constructor(tag) { this.tagName=tag; this.children=[]; this.dataset={}; this.attributes={}; this.events={}; this.disabled=false; this.isConnected=true; this.textWrites=0; this._text=''; }
    set id(value) { this._id=value; elements.set(value,this); } get id() { return this._id; }
    set textContent(value) { this._text=value; this.textWrites++; } get textContent() { return this._text; }
    appendChild(child) { if(child.parentNode) child.remove(); this.children.push(child); child.parentNode=this; return child; }
    prepend(child) { this.children.unshift(child); child.parentNode=this; }
    remove() { if(this.parentNode) this.parentNode.children=this.parentNode.children.filter(child=>child!==this); this.parentNode=null; }
    replaceChildren() { this.children.forEach(child=>{child.parentNode=null;}); this.children=[]; }
    setAttribute(key,value) { this.attributes[key]=String(value); } getAttribute(key) { return this.attributes[key]??null; } removeAttribute(key) { delete this.attributes[key]; }
    addEventListener(name,fn) { (this.events[name]||=[]).push(fn); } emit(name) { (this.events[name]||[]).forEach(fn=>fn({currentTarget:this})); }
    focus() { document.activeElement=this; }
    querySelectorAll(selector) { return this.children.filter(child=>selector==='input[type="password"]'&&child.type==='password'); }
    showModal() { this.open=true; this.opened=(this.opened||0)+1; }
    close() { if(!this.open)return; this.open=false; if(this.asyncClose)(this.closeTasks||=[]).push(()=>this.emit('close')); else this.emit('close'); }
    flushClose() { const tasks=this.closeTasks||[]; this.closeTasks=[]; tasks.forEach(run=>run()); }
    escape() { const event={defaultPrevented:false,preventDefault(){this.defaultPrevented=true;}}; (this.events.cancel||[]).forEach(fn=>fn(event)); if(!event.defaultPrevented)this.close(); }
  }
  document={readyState:'loading',body:null,activeElement:null,addEventListener(name,fn){listeners[name]=fn;},getElementById(id){return elements.get(id);},createElement(tag){return new Element(tag);},querySelector(){return null;}};
  const env={document}; env.window=env; vm.createContext(env); vm.runInContext(fs.readFileSync('shared/ui.js','utf8'),env);
  return {ui:env.LearnUI,document,Element,listeners};
}
async function main() {
  const {ui,document,Element,listeners}=setup();
  const error=new Element('p'); error.id='error'; const input=new Element('input'); input.id='input'; input.setAttribute('aria-describedby','hint');
  ui.dom.showError('error','<img src=x onerror=attack()>','input');
  assert.equal(error.textContent,'<img src=x onerror=attack()>'); assert.equal(error.hidden,false);
  assert.equal(input.getAttribute('aria-invalid'),'true'); assert.equal(input.getAttribute('aria-describedby'),'hint error');
  ui.dom.showError(error,'another error',input); assert.equal(input.getAttribute('aria-describedby'),'hint error');
  ui.dom.showError(error,'',input); assert.equal(error.hidden,true); assert.equal(input.getAttribute('aria-describedby'),'hint'); assert.equal(input.getAttribute('aria-invalid'),null);
  assert.equal(ui.dom.escapeHTML('<b>"&\'</b>'),'&lt;b&gt;&quot;&amp;&#39;&lt;/b&gt;');
  const trigger=new Element('button'),dialog=new Element('dialog'),password=new Element('input'),cancel=new Element('button'); password.type='password'; password.value='sensitive'; dialog.appendChild(password);
  let cleaned=0; trigger.focus(); ui.dialog.bind(dialog,cancel,()=>cleaned++); ui.dialog.bind(dialog,cancel,()=>cleaned++);
  ui.dialog.open(dialog,password); ui.dialog.open(dialog); assert.equal(dialog.opened,1); assert.equal(document.activeElement,password);
  cancel.emit('click'); ui.dialog.close(dialog); assert.equal(cleaned,1,'repeated binding invokes cleanup once'); assert.equal(password.value,''); assert.equal(document.activeElement,trigger);
  password.value='again'; ui.dialog.open(dialog,password); dialog.close(); assert.equal(password.value,'','native Escape close uses the same cleanup'); assert.equal(document.activeElement,trigger);
  const nextFocus=new Element('button');
  ui.dialog.bind(dialog,cancel,()=>nextFocus.focus()); ui.dialog.open(dialog,password); dialog.close();
  assert.equal(document.activeElement,nextFocus,'cleanup can deliberately focus the next dialog or destination');
  const asyncDialog=new Element('dialog'), asyncPassword=new Element('input'), firstTrigger=new Element('button'), nextTrigger=new Element('button');
  asyncDialog.asyncClose=true; asyncPassword.type='password'; asyncDialog.appendChild(asyncPassword);
  let oldCleanup=0,newCleanup=0;
  ui.dialog.bind(asyncDialog,null,()=>oldCleanup++); firstTrigger.focus(); ui.dialog.open(asyncDialog,asyncPassword);
  ui.dialog.close(asyncDialog);
  ui.dialog.bind(asyncDialog,null,()=>newCleanup++); nextTrigger.focus(); ui.dialog.open(asyncDialog,asyncPassword); asyncPassword.value='new round';
  asyncDialog.flushClose();
  assert.equal(asyncPassword.value,'new round','an old asynchronous close cannot clear the reopened password');
  assert.equal(oldCleanup,0); assert.equal(newCleanup,0,'an old close cannot run the new cleanup'); assert.equal(document.activeElement,asyncPassword);
  ui.dialog.close(asyncDialog); asyncDialog.flushClose(); assert.equal(newCleanup,1); assert.equal(asyncPassword.value,''); assert.equal(document.activeElement,nextTrigger);
  // Both close events can arrive after the second cycle has already closed.
  firstTrigger.focus(); ui.dialog.open(asyncDialog,asyncPassword); ui.dialog.close(asyncDialog);
  nextTrigger.focus(); ui.dialog.open(asyncDialog,asyncPassword); ui.dialog.close(asyncDialog); asyncDialog.flushClose();
  assert.equal(newCleanup,2,'only the current closed cycle is cleaned'); assert.equal(document.activeElement,nextTrigger);
  // Native Escape produces cancel followed by an asynchronous close event.
  firstTrigger.focus(); ui.dialog.open(asyncDialog,asyncPassword); asyncDialog.escape();
  nextTrigger.focus(); ui.dialog.open(asyncDialog,asyncPassword); ui.dialog.close(asyncDialog); asyncDialog.flushClose();
  assert.equal(newCleanup,3,'a stale native Escape close cannot consume the next close cycle'); assert.equal(document.activeElement,nextTrigger);
  let preventEscape=true; asyncDialog.addEventListener('cancel',event=>{if(preventEscape)event.preventDefault();});
  ui.dialog.open(asyncDialog,asyncPassword); asyncPassword.value='keep'; asyncDialog.escape(); assert.equal(asyncDialog.open,true); assert.equal(asyncPassword.value,'keep');
  preventEscape=false; ui.dialog.close(asyncDialog); asyncDialog.flushClose(); assert.equal(newCleanup,4,'prevented Escape does not queue a phantom close');
  let ready=0; ui.dom.ready(()=>ready++); assert.equal(ready,0); listeners.DOMContentLoaded(); assert.equal(ready,1);
  document.body=new Element('body'); let reject,calls=0;
  const action=()=>{calls++;return new Promise((resolve,fail)=>{reject=fail;});};
  ui.set('job','处理中','info',action,'继续');
  const area=document.getElementById('learn-status-area'),row=area.children[0],text=row.children[0],button=row.children[1]; button.focus(); const writes=text.textWrites;
  ui.set('job','处理中','info',action,'继续'); assert.equal(area.children[0],row); assert.equal(row.children[1],button); assert.equal(document.activeElement,button); assert.equal(text.textWrites,writes,'unchanged status does not rewrite live text');
  button.onclick(); await Promise.resolve(); ui.set('job','新进度','info',action,'继续'); button.onclick(); await Promise.resolve(); assert.equal(calls,1,'polling does not unlock a pending action'); assert.equal(button.disabled,true);
  ui.set('job','已完成','success'); reject(new Error('旧请求失败')); await new Promise(resolve=>setImmediate(resolve)); assert.equal(text.textContent,'已完成','stale failure cannot overwrite newer state');
  ui.set('job','再次尝试','error',()=>Promise.reject(new Error('仍然失败')),'重试'); button.onclick(); await new Promise(resolve=>setImmediate(resolve)); assert.equal(text.textContent,'仍然失败'); assert.equal(button.disabled,false);
  ui.toast('job','提示','success',action,'继续'); assert.equal(document.getElementById('learn-toast-area').children[0],row,'changing placement preserves row');
  button.onclick(); await Promise.resolve(); ui.clear('job'); ui.set('job','新的通知','success'); reject(new Error('已清理的旧请求')); await new Promise(resolve=>setImmediate(resolve)); assert.equal(area.children[0].children[0].textContent,'新的通知','cleared action cannot change a reused key');
  ui.clear('job');
  let detailTarget;
  ui.set('detail','有可用详情','info',null,null,{secondaryAction:event=>{detailTarget=event.currentTarget;}});
  const detail=area.children[0].children[2], event={currentTarget:detail};
  detail.onclick(event); event.currentTarget=null;
  assert.equal(detailTarget,detail,'detail callbacks receive currentTarget during event dispatch');
  await new Promise(resolve=>setImmediate(resolve)); ui.clear('detail');
  assert.equal(area.children.length,0); assert.equal(document.getElementById('learn-toast-area').children.length,0);
  console.log('PASS UI Kit stable status identity, focus, pending actions, stale failures, accessible errors and dialog lifecycle');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
