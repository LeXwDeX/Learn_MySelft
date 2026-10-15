"use strict";
const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const elements={};const byId=id=>elements[id]||(elements[id]={textContent:'',hidden:true});
let captures=0,flushes=0,calls=0,discards=0,removed=0,resultCount=0,guardCalls=0;
let rejectAccess=true;
const history={id:'old',answers:['saved']},round={id:'r1',questions:[{}],attempts:[history]};
const active={config:{key:'u/doc',beforeSubmit:async()=>{guardCalls++;if(rejectAccess)throw Error('locked');},onResult(){resultCount++;}},answers:['current'],busy:false,readOnly:false,quiz:{rounds:[round]},index:0};
const model={session:{view:active},byId,round:()=>round,roundConfig:()=>active.config};
let controller;
const deps={'quiz-dialog.model':model,'quiz-dialog.drafts':{captureDraft(){captures++;},flushCurrent:async()=>{flushes++;},discardRecord(){discards++;}},'quiz-dialog.view':{render(){}},'quiz-dialog.question':{hasAnswer:answer=>!!answer,localKey:()=> 'draft'},'quiz-dialog.network':{api:async()=>{calls++;return {quiz:{rounds:[{id:'r1',attempts:[{id:'new'}]}]},attempt_id:'new'};}}};
vm.runInNewContext(fs.readFileSync('learning-path/modules/quiz-dialog-controller.js','utf8'),{Promise,window:{},localStorage:{removeItem(){removed++;}},define(name,names,factory){controller=factory(deps);}});
(async()=>{
 active.readOnly=true;await controller.submit();assert.equal(guardCalls,0);assert.equal(captures,0);active.readOnly=false;
 await controller.submit();assert.equal(calls,0);assert.equal(flushes,0);assert.equal(discards,0);assert.equal(removed,0);assert.equal(active.busy,false);assert.deepEqual(active.answers,['current']);assert.equal(round.attempts[0],history);assert.match(byId('qd-error').textContent,/locked/);
 assert.equal(active.recovering,true);const beforeRecovery=guardCalls;await controller.submit();assert.equal(guardCalls,beforeRecovery,'retry is blocked until the view is explicitly reread');
 // Simulate a successful state/task reread. Full reread and pending-job recovery are covered in test_quiz_result_navigation.js.
 active.recovering=false;let explicitDenials=0;
 active.config.beforeSubmit=()=>{explicitDenials++;return Promise.resolve(false);};await controller.submit();assert.equal(explicitDenials,1);assert.equal(calls,0);assert.equal(flushes,0);assert.equal(discards,0);assert.equal(removed,0);assert.deepEqual(active.answers,['current']);assert.equal(round.attempts[0],history);assert.equal(active.recovering,true);
 active.recovering=false;active.config.beforeSubmit=async()=>{guardCalls++;};rejectAccess=false;await controller.submit();assert.equal(calls,1);assert.equal(flushes,1);assert.equal(discards,1);assert.equal(removed,1);assert.equal(resultCount,1);assert.deepEqual(active.answers,['current']);
 console.log('PASS quiz submit access denial and async failure preserve answers/history/draft, explicit false blocks, restored access retries, readonly precedes guard');
})().catch(error=>{console.error(error);process.exitCode=1;});
