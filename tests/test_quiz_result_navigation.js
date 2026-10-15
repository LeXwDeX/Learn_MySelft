'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
function environment() {
  const factories = {}, cache = {}, elements = {};
  const element = id => elements[id] || (elements[id] = {hidden:false,disabled:false,textContent:'',innerHTML:'',
    classList:{toggle(){}},querySelector:()=>({textContent:''}),focus(){this.focused=true},addEventListener(){}});
  const context = {console, Promise, setTimeout,clearTimeout,Date,Math,localStorage:{getItem:()=>null},
    document:{activeElement:null,addEventListener(){}},window:{LearnUser:{userId:'u0',readOnly:false},
    LearnUI:{dialog:{close(dialog){dialog.open=false},open(dialog){dialog.open=true}}}}};
  context.define = (name, deps, factory) => { factories[name] = {deps,factory}; };
  vm.createContext(context);
  function load(name) {
    vm.runInContext(fs.readFileSync(path.join(__dirname,'../learning-path/modules/',name+'.js'),'utf8'),context);
  }
  function get(name) {
    if (!(name in cache)) { const definition=factories[name];
      cache[name]=definition.factory(Object.fromEntries(definition.deps.map(dep=>[dep,get(dep)]))); }
    return cache[name];
  }
  load('quiz-dialog-model');
  const realModel=get('quiz-dialog.model');
  // Keep production identity calculations and accessors, with only the DOM replaced.
  realModel.session.dialog={open:true,querySelector:selector=>element(selector.slice(1))};
  const drafts={currentRecord:()=>null,flushCurrent:()=>Promise.resolve(true),chooseDraft(){},captureDraft(){},flushAll(){}};
  const view={render(){},renderSaveState(){},status(){}};
  const question={hasAnswer:Boolean,localKey:(config,id)=>config.key+'/'+id};
  cache['quiz-dialog.drafts']=drafts;cache['quiz-dialog.view']=view;cache['quiz-dialog.question']=question;
  const network={api:()=>Promise.reject(new Error('offline'))};cache['quiz-dialog.network']=network;
  load('quiz-dialog-controller');
  return {context,cache,load,get,element,model:realModel,drafts,network,controller:get('quiz-dialog.controller')};
}
function issuedView(env,extra={}) {
  const round={id:'r1',storageKey:'u0/learn-path-v1-a',questions:[],attempts:[]};
  const active={config:{key:round.storageKey,nodeId:'n1'},quiz:{round_id:'r1',rounds:[round]},index:0,
    answers:[],busy:false,readOnly:false,...extra};
  env.model.session.view=active;env.model.session.dialog.open=true;
  return active;
}
const deferred=()=>{let resolve,reject;const promise=new Promise((done,fail)=>{resolve=done;reject=fail});return {promise,resolve,reject}};
(async()=>{
  let env=environment(), active=issuedView(env);
  const record={saved:false,localSaved:false};env.drafts.currentRecord=()=>record;env.drafts.flushCurrent=()=>Promise.resolve(false);
  assert.equal(await env.controller.close(),false);
  assert(env.model.session.dialog.open);assert.equal(env.element('qd-error').hidden,false);
  record.localSaved=true;assert.equal(await env.controller.close(),true);assert(!env.model.session.dialog.open);

  env=environment();active=issuedView(env);let pending=deferred();env.drafts.flushCurrent=()=>pending.promise;
  const first=env.controller.close();assert.equal(env.controller.close(),first,'duplicate close shares operation');
  const next=issuedView(env);pending.resolve(true);assert.equal(await first,false);assert(env.model.session.dialog.open,'old completion cannot close a new view');
  pending=deferred();env.drafts.flushCurrent=()=>pending.promise;
  next.quiz.rounds.push({...next.quiz.rounds[0],id:'r2'});const changing=env.controller.close();next.index=1;
  pending.resolve(true);assert.equal(await changing,false,'round changes invalidate pending close');

  env=environment();let returns=0, focused=0;const fresh={isConnected:true,focus(){focused++}};
  active=issuedView(env,{attempt:{id:'a1',result:{score:30,pass:false}}});
  active.config.restoreFocus=()=>fresh;active.config.resultReturn={onReturn(context){returns++;assert.equal(context.roundId,'r1');assert.equal(context.isCurrentRound,true);assert(!env.model.session.dialog.open)}};
  env.model.session.returnFocus={isConnected:false,focus(){throw new Error('detached trigger')}};
  const returning=env.controller.returnToLearning();assert.equal(env.controller.returnToLearning(),returning);await returning;
  assert.equal(returns,1);assert.equal(focused,1);
  active.quiz.rounds[0].storageKey='u0/another';assert.equal(env.model.resultContext().isCurrentRound,false);

  env=environment();active=issuedView(env);active.quiz.rounds.push({...active.quiz.rounds[0],id:'r2'});
  env.drafts.currentRecord=()=>({saved:false,localSaved:false});env.drafts.flushCurrent=()=>Promise.resolve(false);
  assert.equal(await env.controller.navigate(1),false);assert.equal(active.index,0,'unsafe draft prevents navigation');
  env.drafts.currentRecord=()=>null;await env.controller.open({key:'u0/learn-path-v1-a'});
  assert.equal(env.element('qd-reload').hidden,false);assert.match(env.element('qd-body').textContent,/无法打开题集/);

  env=environment();env.cache['quiz-map.model']={session:{USER_PATH:'u0/',MAP_PREFIX:'learn-path-v1-'}};
  env.load('quiz-map-identity');const identity=env.get('quiz-map.identity');
  const doc={sourceKey:'u0/learn-path-v1-source',questions:[{node_id:'n2'},{point:'基础',q:'旧题'},{node_id:'gone'},{node_id:'n2'}]};
  const entries={[doc.sourceKey]:JSON.stringify({plan:{nodes:[{id:'n1',title:'基础'},{id:'n2',title:'练习'}]}})};
  const result={per_question:doc.questions.map(()=>({earned:0,max_points:25}))};
  let targets=identity.reviewTargets(doc,entries,result);
  assert.equal(targets.units.length,1);assert.equal(targets.units[0].href,'learning-path.html?t=source&node=n2');assert(targets.hasUnmapped);
  targets=identity.reviewTargets({...doc,questions:[{point:'基础'}]},entries,result);
  assert.equal(targets.units.length,0,'old titles never guess a source node');assert.equal(targets.sourceHref,'learning-path.html?t=source');
  assert.equal(identity.reviewTargets({...doc,sourceKey:'other/learn-path-v1-source'},entries,result).sourceHref,'');
  assert.equal(identity.reviewTargets(doc,{},result).sourceHref,'','deleted source has no invented link');

  env=environment();let listPending=deferred();let submitCalls=0;
  env.context.window.LearnJobs={list:()=>listPending.promise};
  env.drafts.chooseDraft=()=>{env.model.session.view.answers=[]};
  env.network.api=(config,endpoint)=>{if(endpoint==='/path/quiz')submitCalls++;return Promise.resolve({round_id:'r1',rounds:[{id:'r1',questions:[],attempts:[]}]})};
  await env.controller.open({key:'u0/learn-path-v1-a'});
  assert(env.model.session.view.busy);env.controller.submit();assert.equal(submitCalls,0,'task lookup blocks duplicate submit');
  listPending.resolve([]);for(let i=0;i<8;i++)await Promise.resolve();assert(!env.model.session.view.busy);
  env.context.window.LearnJobs.list=()=>Promise.reject(Error('task lookup offline'));
  await env.controller.open({key:'u0/learn-path-v1-a'});for(let i=0;i<8;i++)await Promise.resolve();
  assert(env.model.session.view.recovering);env.controller.submit();assert.equal(submitCalls,0,'unknown task state still blocks submit');
  assert.equal(env.element('qd-reload').hidden,false);

  for (const recovery of ['running-job','lookup-failure']) {
    env=environment();let submissions=0, watched=0;const watching=deferred();
    const config={key:'u0/learn-path-v1-a'};
    env.context.window.LearnJobs={list:()=>Promise.resolve([]),watch(){watched++;return watching.promise}};
    env.context.window.QuizDialog={open:env.controller.open};
    env.drafts.chooseDraft=()=>{env.model.session.view.answers=['initial answer']};
    env.network.api=(config,endpoint)=>{
      if(endpoint==='/path/quiz'){submissions++;return Promise.reject(Error('submission acknowledgement lost'));}
      return Promise.resolve({round_id:'r1',rounds:[{id:'r1',questions:[{type:'short'}],attempts:[]}]});
    };
    await env.controller.open(config);for(let i=0;i<8;i++)await Promise.resolve();
    await env.controller.submit();
    env.model.session.view.answers=['edited after acknowledgement loss'];
    await env.controller.submit();
    assert.equal(submissions,1,'editing answers after lost acknowledgement cannot create another job');
    assert(env.model.session.view.recovering);assert.equal(env.element('qd-reload').hidden,false);
    env.context.window.LearnJobs.list=recovery==='running-job'?
      ()=>Promise.resolve([{operation:'/path/quiz',key:config.key,round_id:'r1',status:'running'}]):
      ()=>Promise.reject(Error('lookup unavailable'));
    await env.controller.open(config);for(let i=0;i<12;i++)await Promise.resolve();
    env.model.session.view.answers=['another changed answer'];await env.controller.submit();assert.equal(submissions,1);
    if(recovery==='running-job') {
      assert.equal(watched,1,'reread recovers the original running job');assert(env.model.session.view.busy);
      env.context.window.LearnJobs.list=()=>Promise.resolve([]);watching.resolve();
      for(let i=0;i<28;i++)await Promise.resolve();
      assert(!env.model.session.view.busy && !env.model.session.view.recovering,'confirmed reread restores editing');
    } else assert(env.model.session.view.recovering,'failed lookup keeps the submission outcome unknown');
  }

  for (const outcome of ['no-job','list-failure','job-success','job-failure']) {
    env=environment();const listing=deferred(), watching=deferred();let watched=0, posts=0;
    const config={key:'u0/learn-path-v1-a'};
    env.context.window.LearnJobs={list:()=>listing.promise,watch(){watched++;return watching.promise}};
    env.context.window.QuizDialog={open:env.controller.open};
    env.drafts.chooseDraft=()=>{env.model.session.view.answers=[]};
    env.network.api=(config,endpoint)=>{if(endpoint==='/path/quiz')posts++;return Promise.resolve({round_id:'r1',rounds:[{id:'r1',questions:[],attempts:[]}]})};
    await env.controller.open(config);const closedView=env.model.session.view;
    assert(closedView.busy);assert.equal(await env.controller.close(),true);
    if(outcome==='list-failure')listing.reject(Error('lookup offline'));
    else listing.resolve(outcome==='no-job'?[]:[{operation:'/path/quiz',key:config.key,round_id:'r1',status:'running'}]);
    for(let i=0;i<12;i++)await Promise.resolve();
    env.context.window.LearnJobs.list=()=>Promise.resolve([]);
    if(outcome.startsWith('job-')) {
      assert.equal(watched,1,'closed active view must still watch its existing job');assert(closedView.busy);
      await env.controller.open(config);assert.equal(env.model.session.view,closedView,'reopening a known job keeps its recovery identity');
      env.controller.submit();assert.equal(posts,0,'existing job cannot be submitted again');
      if(outcome==='job-success')watching.resolve();else watching.reject(Error('watch offline'));
      for(let i=0;i<24;i++)await Promise.resolve();
      if(outcome==='job-failure'){assert(closedView.recovering);env.controller.submit();assert.equal(posts,0,'unknown watch outcome blocks submit');}
    } else {
      assert(!closedView.busy,'closing during lookup must not leave a stuck busy flag');
      assert.equal(!!closedView.recovering,outcome==='list-failure');
    }
    await env.controller.open(config);for(let i=0;i<12;i++)await Promise.resolve();
    assert(!env.model.session.view.busy && !env.model.session.view.recovering,'reopen must finish a fresh lookup and become usable');
    assert.equal(posts,0);
  }

  env=environment();active=issuedView(env);env.load('quiz-dialog-drafts');delete env.cache['quiz-dialog.drafts'];
  env.cache['quiz-dialog.hooks']={renderSaveState(){},updateProgress(){}};
  const drafts=env.get('quiz-dialog.drafts');active.quiz.rounds[0].questions=[{type:'short'}];
  const key=env.cache['quiz-dialog.question'].localKey(active.config,'r1');
  drafts.storeRecord({key,answers:['memory only'],saved:false,localSaved:false,version:1});
  drafts.chooseDraft();assert.equal(active.answers[0],'memory only','unpersisted memory survives a reread');
  env.context.localStorage.getItem=()=>JSON.stringify({answers:['older local draft'],version:0});
  drafts.chooseDraft();assert.equal(active.answers[0],'memory only');assert.equal(drafts.currentRecord().answers[0],'memory only','older local copy must not replace newer memory after storage fails');

  env.cache['quiz-map.model']={session:{}};env.cache['quiz-map.identity']={};
  env.cache['quiz-map.format']={};env.cache['quiz-map.network']={post(){throw new Error('read-only write')}};
  env.context.window.LearnUser.readOnly=true;env.load('quiz-map-diagnosis');
  const diagnosis=env.get('quiz-map.diagnosis');diagnosis.runGaps();diagnosis.runRefine();
  console.log('PASS quiz safe close/navigation, stale async guards, result return/focus, precise source links, read-only and memory recovery');
})().catch(error=>{console.error(error);process.exitCode=1});
