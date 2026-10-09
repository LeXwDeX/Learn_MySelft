/* Opt-in real model regression. Uses only the isolated regression_bot material.
 * Browser requests reach the deployed API. Two route aborts reproduce a missing
 * submission and a lost acknowledgement; no model replies are fabricated.
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {randomUUID, createHash} = require('node:crypto');
const playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const environment = process.env.RELEASE_ENV || 'test';
assert(['test','production'].includes(environment));
const engine = process.env.BROWSER_ENGINE || 'chromium';
assert(['chromium','webkit'].includes(engine));
const phone = process.env.PHONE_MODE === '1';
const api = 'http://192.168.33.146:' + (environment === 'test' ? '8111' : '8101');
const site = 'http://192.168.33.146:' + (environment === 'test' ? '8112' : '8100');
const uid = environment === 'test' ? 'u370119af344c603c' : 'ub3fd33db1b3e5638';
const revision = process.env.RELEASE_REVISION;
assert.match(revision || '', /^[0-9a-f]{40}$/);
assert(path.isAbsolute(process.env.BATCH_RUNTIME_OUTPUT || ''), 'absolute output required');
const output = process.env.BATCH_RUNTIME_OUTPUT;
fs.mkdirSync(output,{recursive:true,mode:0o700});
const fixture = 'batch-runtime-' + randomUUID().slice(0,12);
const key = uid + '/learn-path-v1-' + fixture;
const titles = [
  ['特征值与特征向量：矩阵的固有方向','特征向量经变换后仍在原直线上，特征值表示缩放倍数。'],
  ['余弦相似度与注意力打分','余弦相似度比较方向。注意力用点积衡量词向量之间的关联。'],
  ['奇异值分解 SVD：拆成三步','SVD把矩阵分解成两次正交变换和一次缩放，奇异值表示方向的重要性。'],
  ['变化、损失与梯度的直觉','梯度表示损失对参数的敏感度，负梯度给出减小损失的局部方向。'],
  ['矩阵求导与反向传播','反向传播沿链式法则计算各层参数的梯度，然后更新权重。']
];
const nodes = titles.map(([title,essence],i)=>({id:'n'+(i+1),title,essence,objectives:['用白话和类比解释本单元概念。','说明它在大模型中的用途。'],deps:[]}));
const spec = {topic:'线性代数白话解析',level:'非数学专业初学者',goal:'看懂大模型相关术语。',depth:'直觉理解',preferences:['白话','类比'],constraints:'不涉及证明与手算。'};
const material = {topic:spec.topic,title:'真实批量生成回归',stage:'learning',spec,pending:null,plan:{title:fixture,summary:spec.goal,nodes},nodeDetail:{},nodeState:{},unknown:'keep'};
const hash = value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const report = {environment,revision,engine,phone,fixture_id:fixture,sourceURL:site+'/learn/u/'+uid+'/learning-path.html?t='+fixture,model_responses_mocked:false,cases:[],jobs:[],progress:[]};
const save = ()=>fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2),{mode:0o600});
let phase = 'setup';
async function main(){
  const browser = await playwright[engine].launch({headless:true});
  try{
    const context = await browser.newContext({viewport:phone?{width:390,height:844}:{width:1440,height:1000},isMobile:phone,hasTouch:phone});
    const credentials = JSON.parse(execFileSync('ssh',['-o','BatchMode=yes','root@192.168.33.146','cat /opt/study-assistant/regression-credentials/'+environment+'.json'],{encoding:'utf8',timeout:25000}));
    const headers = {'X-Learn-User':uid};
    async function request(route,data){
      const response = data === undefined ? await context.request.get(api+route,{headers}) : await context.request.post(api+route,{headers,data});
      assert(response.ok(),phase+'_http_'+response.status());
      return response.json();
    }
    assert.equal((await request('/health')).revision,revision);
    assert.equal((await (await context.request.get(site+'/learn/revision.json')).json()).revision,revision);
    assert.equal((await request('/auth/login',{username:'regression_bot',password:credentials.password})).user.id,uid);
    delete credentials.password;
    await request('/state/put',{entries:{[key]:JSON.stringify(material)}});
    const page = await context.newPage();
    const browserErrors=[];page.on('pageerror',error=>browserErrors.push(error.name));
    const browserReceiptReads=new Set(), browserStateReads=new Map(), requestEpochs=new WeakMap();
    let browserEpoch=0;
    page.on('request',req=>{
      const url=new URL(req.url()),match=/^\/jobs\/([0-9a-f]{32})$/.exec(url.pathname);
      if(req.method()==='GET'&&url.origin===api&&match)browserReceiptReads.add(match[1]);
      if(req.method()==='GET'&&url.origin===api&&url.pathname==='/state/all')requestEpochs.set(req,browserEpoch);
    });
    page.on('response',async response=>{
      const epoch=requestEpochs.get(response.request());
      if(epoch===undefined||epoch!==browserEpoch||!response.ok())return;
      try{
        const entries=(await response.json()).entries;
        if(epoch!==browserEpoch||typeof entries?.[key]!=='string')return;
        const restored=JSON.parse(entries[key]);
        for(const [id,detail] of Object.entries(restored.nodeDetail||{}))
          browserStateReads.set(id,{hash:hash(detail),ready:['passed','not_needed'].includes(detail.manim_review?.status)});
      }catch(_){ /* An incomplete read cannot prove browser recovery. */ }
    });
    const submissions = new Map();
    const scenePosts=new Map(), materialSnapshots=new Map();
    let acceptedLostJobId=null;
    let missingDone=false,lostDone=false,pauseDone=false,pauseResumed=false,activeInterrupt=null,recoveryCheck=null;
    await page.route(api+'/jobs',async route=>{
      const req=route.request();
      if(req.method()!=='POST'){await route.continue();return;}
      const body=req.postDataJSON();
      if(body.body?.key!==key){await route.continue();return;}
      const id=body.body.node?.id,op=body.operation;
      submissions.set(body.request_id,body);
      if(op==='/path/node/scene'){
        scenePosts.set(id,(scenePosts.get(id)||0)+1);
        if(!materialSnapshots.has(id)){
          const detail=await page.evaluate(nid=>window.LearnPathApp.get('path.model').state.nodeDetail[nid],id);
          assert(detail?.study_notes&&detail.quiz?.round_id,'browser_has_issued_material_before_scene');
          materialSnapshots.set(id,{notes:detail.study_notes,notesHash:hash(detail.study_notes.trim()),quiz:hash(detail.quiz)});
        }
      }
      if(op==='/path/node/scene'&&id==='n1'&&!missingDone){
        missingDone=true;activeInterrupt='missing-scene-submission';
        await route.abort('aborted');return;
      }
      if(op==='/path/node/scene'&&id==='n2'&&!lostDone){
        const accepted=await route.fetch();
        assert(accepted.ok(),'lost_ack_real_acceptance');
        const receipt=(await accepted.json()).job;
        assert.match(receipt?.id||'',/^[0-9a-f]{32}$/,'lost_ack_exact_real_job_id');
        acceptedLostJobId=receipt.id;
        lostDone=true;activeInterrupt='lost-scene-acknowledgement';
        await route.abort('aborted');return;
      }
      await route.continue();
    });
    phase='batch';save();
    await page.goto(report.sourceURL);
    await page.locator('#gen-all-btn').waitFor({state:'visible'});
    await page.locator('#gen-all-btn').click();
    const started=Date.now(),deadline=started+5*2*660000;
    let previous='';
    while(Date.now()<deadline){
      if(activeInterrupt){
        const label=activeInterrupt;activeInterrupt=null;
        const node=label==='missing-scene-submission'?'n1':'n2';
        const before=JSON.parse((await request('/state/all')).entries[key]).nodeDetail[node];
        assert(before?.study_notes&&before.quiz?.round_id,'body_committed_before_interrupt');
        const existing=(await request('/jobs?key='+encodeURIComponent(key))).jobs.filter(j=>j.node_id===node&&j.operation==='/path/node/scene');
        assert.equal(existing.length,node==='n1'?0:1,'interruption_has_expected_real_receipt');
        const original=materialSnapshots.get(node);
        assert(original,'initial_browser_material_snapshot');
        recoveryCheck={label,node,notes:original.notes,notesHash:original.notesHash,quiz:original.quiz,
          acceptedId:node==='n2'?acceptedLostJobId:null,started:Date.now()};
        if(recoveryCheck.acceptedId)assert.equal(existing[0].id,recoveryCheck.acceptedId,'lost_ack_original_receipt_identity');
        browserReceiptReads.clear();
        browserStateReads.clear();browserEpoch++;
        await page.reload();
        await page.locator('#gen-all-btn').waitFor({state:'visible'});
        report.cases.push(label+'_reload');save();
      }
      const jobs=(await request('/jobs?key='+encodeURIComponent(key))).jobs;
      const entries=(await request('/state/all')).entries;
      const current=JSON.parse(entries[key]);
      if(recoveryCheck){
        const sceneJobs=jobs.filter(j=>j.node_id===recoveryCheck.node&&j.operation==='/path/node/scene');
        assert(sceneJobs.length<=1,'recovery_never_duplicates_scene_job');
        const scene=sceneJobs[0];
        if(scene&&recoveryCheck.acceptedId)assert.equal(scene.id,recoveryCheck.acceptedId,'recovery_reuses_exact_accepted_receipt');
        const browserRead=browserStateReads.get(recoveryCheck.node);
        const restored=await page.evaluate(nid=>{
          const model=window.LearnPathApp.get('path.model');
          return {detail:model.state.nodeDetail[nid],remaining:model.state.pending?.remaining||[]};
        },recoveryCheck.node);
        const received=!!(scene&&browserReceiptReads.has(scene.id));
        const completedRead=!!(recoveryCheck.acceptedId&&scene?.status==='succeeded'&&browserRead?.ready&&
          browserRead.hash===hash(current.nodeDetail[recoveryCheck.node])&&restored.detail&&
          browserRead.hash===hash(restored.detail)&&['passed','not_needed'].includes(restored.detail.manim_review?.status)&&
          !restored.remaining.includes(recoveryCheck.node));
        if(received||completedRead){
          const preserved=current.nodeDetail[recoveryCheck.node];
          assert.equal(hash(preserved.quiz),recoveryCheck.quiz,'automatic_recovery_keeps_issued_quiz');
          assert.equal(preserved.study_notes.split('```learn-manim')[0].trim(),recoveryCheck.notes.trim(),'automatic_recovery_keeps_prose');
          if(recoveryCheck.acceptedId)assert.equal(scenePosts.get(recoveryCheck.node),1,'lost_ack_never_resubmits_scene');
          else assert.equal(scenePosts.get(recoveryCheck.node),2,'missing_scene_is_automatically_submitted_after_reload');
          (report.recovery_evidence||(report.recovery_evidence=[])).push({
            interruption:recoveryCheck.label,method:received?'browser_receipt_get':'browser_completed_state_read',
            accepted_job_id:recoveryCheck.acceptedId,scene_job_id:scene.id,scene_posts:scenePosts.get(recoveryCheck.node),
            material_notes_sha256:recoveryCheck.notesHash,quiz_sha256:recoveryCheck.quiz,
            restored_node_detail_sha256:completedRead?browserRead.hash:null
          });
          report.cases.push(recoveryCheck.label+(received?'_automatic_receipt_recovered':'_completed_state_restored')+'_before_manual_continue');
          recoveryCheck=null;save();
        }else assert(Date.now()-recoveryCheck.started<45000,'automatic_scene_handoff_not_observed');
      }
      const done=nodes.filter(n=>['passed','not_needed'].includes(current.nodeDetail?.[n.id]?.manim_review?.status));
      const running=jobs.find(j=>j.status==='running');
      const signature=JSON.stringify([done.length,running?.node_id,running?.operation,running?.progress?.label]);
      if(signature!==previous){
        previous=signature;const progress={completed:done.length,total:5,node:running?.node_id,operation:running?.operation,phase:running?.progress?.label,seconds:Math.round((Date.now()-started)/1000)};
        report.progress.push(progress);save();console.log(JSON.stringify(progress));
      }
      const failed=jobs.find(j=>['failed','interrupted','cancelled'].includes(j.status));
      if(failed){
        // Lists omit failure metadata. Read the real receipts for diagnostics;
        // never persist their prompts, generated material or error bodies.
        const receipts=await Promise.all(jobs.map(j=>request('/jobs/'+j.id).then(r=>r.job)));
        report.jobs=receipts.map(j=>({id:j.id,node:j.node_id,operation:j.operation,status:j.status,category:j.error_category,phase:j.failure_phase,attempt:j.attempt}));
        save();assert.fail('real_job_'+failed.status);
      }
      if(!pauseDone&&jobs.some(j=>j.node_id==='n3'&&j.operation==='/path/node'&&j.status==='running')){
        await page.locator('#gen-all-btn').click();pauseDone=true;
      }
      if(pauseDone&&!pauseResumed&&done.length===3&&!jobs.some(j=>j.node_id==='n4')){
        await page.waitForFunction(()=>document.getElementById('gen-all-btn')?.textContent==='继续准备未完成节点',null,{timeout:10000});
        await page.reload();await page.locator('#gen-all-btn').waitFor({state:'visible'});
        assert.equal((await request('/jobs?key='+encodeURIComponent(key))).jobs.some(j=>j.node_id==='n4'),false);
        await page.locator('#gen-all-btn').click();pauseResumed=true;report.cases.push('pause_finishes_current_node_and_explicit_resume');save();
      }else if(!recoveryCheck&&done.length<5&&!jobs.some(j=>['queued','running'].includes(j.status))&&
               await page.locator('#gen-all-btn').textContent()==='继续准备未完成节点'){
        // Recovery observes accepted material tasks. A deliberate click starts
        // the next materials that were never submitted before the reload.
        await page.locator('#gen-all-btn').click();
        report.cases.push('explicit_continue_after_recovery');save();
      }
      if(done.length===5){
        assert(missingDone&&lostDone&&pauseDone&&pauseResumed&&!recoveryCheck,'all_interruptions_and_resume_exercised');
        assert.equal(jobs.length,10,'one_material_and_scene_job_per_node');
        for(const node of nodes){
          const detail=current.nodeDetail[node.id];
          assert(detail.study_notes?.trim());assert(detail.quiz?.round_id);
          assert.equal(detail.quiz.questions.length,6);
          assert.equal(detail.quiz.questions.reduce((n,q)=>n+q.points,0),100);
          assert(['passed','not_needed'].includes(detail.render_review?.status));
          assert.equal(jobs.filter(j=>j.node_id===node.id&&j.operation==='/path/node').length,1);
          assert.equal(jobs.filter(j=>j.node_id===node.id&&j.operation==='/path/node/scene').length,1);
        }
        assert.equal(current.unknown,'keep');
        const baseline=hash(current.nodeDetail);
        report.node_details_sha256=baseline;
        phase='cache';
        for(const body of submissions.values())assert.equal((await request('/jobs',body)).job.status,'succeeded');
        assert.equal((await request('/jobs?key='+encodeURIComponent(key))).jobs.length,10);
        assert.equal(hash(JSON.parse((await request('/state/all')).entries[key]).nodeDetail),baseline);
        await page.reload();await page.locator('#gen-all-btn').waitFor({state:'visible'});
        await page.locator('#gen-all-btn').click();
        assert.equal((await request('/jobs?key='+encodeURIComponent(key))).jobs.length,10);
        assert.equal(hash(JSON.parse((await request('/state/all')).entries[key]).nodeDetail),baseline);
        report.jobs=jobs.map(j=>({id:j.id,node:j.node_id,operation:j.operation,status:j.status,attempt:j.attempt,timeout_seconds:j.timeout_seconds}));
        report.cases.push('five_real_nodes_completed','six_verified_questions_per_node','original_material_preserved','receipts_reused_after_lost_ack','completed_batch_skips_generation','reload_keeps_material');
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
        assert.deepEqual(browserErrors,[]);
        report.cases.push('actual_deployed_page_fits_viewport');
        await page.screenshot({path:path.join(output,'completed.png'),fullPage:true});
        report.status='passed';report.elapsed_seconds=Math.round((Date.now()-started)/1000);save();
        console.log(JSON.stringify({status:'passed',completed:5,jobs:10,elapsed_seconds:report.elapsed_seconds,cases:report.cases}));return;
      }
      await page.waitForTimeout(2000);
    }
    assert.fail('real_batch_deadline');
  }finally{await browser.close();}
}
main().catch(error=>{report.status='failed';report.failure_phase=phase;report.exception=error.name;save();console.error(JSON.stringify({status:'failed',phase,exception:error.name}));process.exitCode=1;});
