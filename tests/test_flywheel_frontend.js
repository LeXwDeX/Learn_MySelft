'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const code = fs.readFileSync('learning-path/quiz-map-app.js', 'utf8');
const elements = new Map(), calls = [], alerts = [];
const element = id => { if (!elements.has(id)) elements.set(id, {textContent:'', innerHTML:'', disabled:false, addEventListener(){}}); return elements.get(id); };
let finishDiagnosis;
const env = {console, setTimeout, clearTimeout, AbortController, URLSearchParams, location:{search:''},
  alert: message => alerts.push(message),
  document:{readyState:'loading',addEventListener(){},getElementById:element},
  window:{LearnUser:{userId:'u0',apiBase:'http://localhost',fetch:async()=>({json:async()=>({ok:true,entries:{'u0/learn-path-v1-map':JSON.stringify({plan:{nodes:[{id:'n1',title:'Basics'}]}})}})})},
    LearnJobs:{supports:()=>true,run:(path,body,options)=>{calls.push({path,body,options});if(path==='/path/gaps')return new Promise(resolve=>finishDiagnosis=resolve);return Promise.resolve({added:1});}}}};
vm.createContext(env);require('./load_uikit.cjs')(env);vm.runInContext(code,env);
const get=env.window.LearnQuizMapApp.get;
const session=get('quiz-map.model').session;
const api={...get('quiz-map.diagnosis'),...get('quiz-map.identity'),...get('quiz-map.view'),
 set(quiz){session.currentD=quiz;session.currentSlug='exam';session.currentQs=quiz.questions;session.currentRes=quiz.lastResult;},
 current(){return session.currentD;}};
function quiz(id,score=0){return {sourceKey:'u0/learn-path-v1-map',sourceSlug:'map',round_id:'r1',lastAttemptId:id,questions:[{q:'1+1?',point:'L1 Basics'}],rounds:[{id:'r1',attempts:[{id}]}],lastAnswers:[''],lastResult:{score,per_question:[{earned:score,max_points:100,ok:score===100}]}};}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
(async()=>{
 const current=quiz('new');current.gaps={gaps:[{unit:'L1 Basics',points:['old']}]};current.diagnosis={round_id:'r1',attempt_id:'old'};
 api.set(current);api.runRefine();await tick();assert.equal(calls.length,1);assert.equal(calls[0].path,'/path/gaps');assert.equal(calls[0].body.attempt_id,'new');assert(!('items' in calls[0].body));
 finishDiagnosis({gaps:[{unit:'L1 Basics',points:['fresh']}],diagnosis:{round_id:'r1',attempt_id:'new'}});await tick();await tick();assert.equal(calls.at(-1).path,'/path/refine');assert.equal(calls.at(-1).body.quiz_key,'u0/quiz-map-v1-exam');assert.equal(calls.at(-1).body.attempt_id,'new');assert(!('weaknesses' in calls.at(-1).body));
 api.set(quiz('newer'));api.runGaps();api.set(quiz('full',100));finishDiagnosis({gaps:[{unit:'L1 Basics',points:['late']}],diagnosis:{round_id:'r1',attempt_id:'newer'}});await tick();assert.equal(api.current().gaps,undefined);
 const count=calls.length;api.runRefine();assert.equal(calls.length,count);assert.match(alerts.at(-1),/没有失分/);
 const old=quiz('old');old.gaps={gaps:[{unit:'L1 Basics',points:['old']}]};old.diagnosis={round_id:'r1',attempt_id:'old'};api.set(old);api.syncQuiz(old,quiz('updated',100));assert.equal(api.current().gaps,undefined);assert.equal(api.current().diagnosis,undefined);
 console.log('PASS version-bound diagnosis, late-response rejection, server-derived refinement and full-score guard');
})().catch(error=>{console.error(error);process.exitCode=1});
