/* Real DOM regression with isolated job receipts; no online user data. */
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const playwright=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const browserName=process.env.GENERATION_BROWSER||'chromium',mobile=process.env.GENERATION_MOBILE==='1';
const output=process.env.GENERATION_OUTPUT||path.join(os.tmpdir(),'generation-recovery-browser');
const root=path.resolve(__dirname,'..');fs.mkdirSync(output,{recursive:true});
(async()=>{
  const browser=await playwright[browserName].launch({headless:true,...(browserName==='chromium'&&process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}:{})});
  try {
    const page=await browser.newPage({viewport:mobile?{width:390,height:844}:{width:1280,height:900},isMobile:mobile,hasTouch:mobile});
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.setContent('<meta name="viewport" content="width=device-width, initial-scale=1"><header class="user-bar">学习资料</header><main class="wrap"><button class="btn" id="gen-all-btn">一键生成全部节点</button><div id="resume-bar" hidden></div><section id="readable-material" aria-label="学习正文"></section></main>');
    for(const file of ['shared/ui.css','learning-path/page-shell.css','learning-path/path.css'])await page.addStyleTag({content:fs.readFileSync(path.join(root,file),'utf8')});
    await page.evaluate(()=>{
      const nativeTimer=window.setTimeout.bind(window);window.setTimeout=(fn,ms,...args)=>nativeTimer(fn,ms===1500||ms===3500?10:ms,...args);
      window.fixture={calls:[],jobs:new Map(),serial:0,saved:{nodeDetail:{}},opened:[]};
      const f=window.fixture;let release;f.gate=new Promise(r=>release=r);f.release=release;
      window.LearnUser={userId:'fixture',apiBase:'http://fixture.invalid',ready:Promise.resolve(),readOnly:false,fetch:async(url,options={})=>{
        f.calls.push({url,method:options.method||'GET',operation:options.body?JSON.parse(options.body).operation:null});
        if(url.endsWith('/state/all'))return Response.json({ok:true,entries:{'fixture/material':JSON.stringify(f.saved)}});
        if(url.includes('/jobs?'))return Response.json({jobs:[...f.jobs.values()].map(job=>{const thin={...job};delete thin.result;return thin;})});
        if(url.endsWith('/jobs')){
          const request=JSON.parse(options.body),node=request.body.node.id,id='job-'+(++f.serial),visual=request.operation==='/path/node/scene',failed=visual||node!=='n3';
          const detail={study_notes:node+' 正文已保存。',quiz:{round_id:'original-round'},manim_review:{status:'pending',retryable:true}};
          if(!failed)f.saved.nodeDetail[node]=detail;
          const job={id,operation:request.operation,key:'fixture/material',node_id:node,created_ms:f.serial,status:'running',result:visual?null:detail,error:'生成失败：'+node+'，记录保留。',finalStatus:failed?'failed':'succeeded'};
          f.jobs.set(id,job);return Response.json({job});
        }
        const parts=url.split('/'),isDetails=parts.at(-1)==='details',isRetry=parts.at(-1)==='retry',id=isDetails||isRetry?parts.at(-2):parts.at(-1),job=f.jobs.get(id);
        if(isDetails)return Response.json({job,details:{available:true,events:[{id:1,kind:'error',content:job.error}]}});
        if(isRetry){job.finalStatus='succeeded';job.status='running';job.result={node_id:job.node_id,study_notes:f.saved.nodeDetail[job.node_id].study_notes,needed:false,manim_review:{status:'not_needed'}};return Response.json({job});}
        if(job.node_id==='n1'&&!f.released)await f.gate;
        job.status=job.finalStatus;
        if(job.operation==='/path/node/scene'&&job.status==='failed')f.saved.nodeDetail[job.node_id].manim_review={status:'failed',retryable:true,failure_code:'render_unavailable'};
        return Response.json({job});
      }};
      window.model={state:{stage:'learning',spec:{},nodeDetail:{},pending:null,plan:{nodes:['n1','n2','n3'].map(id=>({id,title:id+' 单元',objectives:[]}))}},session:{nodeMaterialStatus:{},expandedId:'n3'}};
      window.define=(name,names,factory)=>{window.generation=factory({
        'path.model':window.model,'path.format':{$:id=>document.getElementById(id),storeKey:()=> 'fixture/material'},
        'path.persistence':{save(){},ensureNodeExists:()=>Promise.resolve(),ensureAccess:()=>Promise.resolve(),waitForWrites:()=>Promise.resolve(),post:(operation,body,options)=>window.LearnJobs.run(operation,body,options)},
        'path.domain':{nodeById:id=>window.model.state.plan.nodes.find(n=>n.id===id),depTitles:()=>[]},
        'path.workflow':{hideResumeBar(){}},'path.hooks':{syncAiMaterial(){},renderNodeDetail(id){document.getElementById('readable-material').textContent=window.model.state.nodeDetail[id].study_notes;}}
      });};
    });
    for(const file of ['shared/ui.js','shared/job-details.js','shared/jobs.js','learning-path/modules/path-generation.js'])await page.addScriptTag({content:fs.readFileSync(path.join(root,file),'utf8')});
    await page.evaluate(()=>{window.work=window.generation.genAllStart(['n1','n2','n3']);});
    await page.waitForSelector('.generation-task-list li .btn',{state:'attached'});
    await page.locator('.learn-status .learn-job-detail-button').click();
    await page.locator('.generation-task-list li .btn').first().focus();
    await page.evaluate(()=>{window.stableButton=document.activeElement;window.fixture.released=true;window.fixture.release();});
    await page.evaluate(()=>window.work);
    assert.equal(await page.locator('.learn-status-area .learn-status').count(),1);
    assert.match(await page.locator('.learn-status-text').innerText(),/已完成 0\/3，失败 3/);
    assert.equal(await page.locator('.generation-task-list').evaluate(node=>node.open),true);
    assert.equal(await page.evaluate(()=>document.activeElement===window.stableButton),true,'polling keeps details-list focus');
    assert.match(await page.locator('#readable-material').innerText(),/正文已保存/);
    const body=await page.evaluate(()=>JSON.stringify(window.model.state.nodeDetail.n3)),posts=await page.evaluate(()=>window.fixture.calls.filter(c=>c.operation==='/path/node').length);
    await page.locator('.generation-task-list li .btn').last().click();
    await page.locator('.learn-job-detail-panel[open]').waitFor();
    await page.locator('.learn-job-detail-panel[open] .learn-job-diagnostics').evaluate(details=>{details.open=true;});
    await page.waitForSelector('.learn-job-detail-panel[open] .learn-job-conversation');
    assert.match(await page.locator('.learn-job-detail-panel[open] .learn-job-conversation').innerText(),/生成失败/);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.generation-task-list').evaluate(node=>node.open),true,'Escape closes only the details window');
    assert.equal(await page.locator('.generation-task-list li .btn').last().evaluate(node=>node===document.activeElement),true,'details returns focus to the list');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.generation-task-list').evaluate(node=>node.open),false,'Escape closes the list');
    await page.waitForFunction(()=>{const button=document.querySelector('.learn-status .learn-job-detail-button');return !!button&&button===document.activeElement;},null,{timeout:2000});
    assert.equal(await page.locator('.learn-status .learn-job-detail-button').evaluate(node=>node===document.activeElement),true,'list returns focus to the current summary action');
    await page.evaluate(()=>window.generation.genAllStart(['n3'],{recovering:true}));
    assert.equal(await page.evaluate(()=>window.fixture.calls.filter(c=>c.operation==='/path/node').length),posts,'recovery never regenerates material');
    assert.equal(await page.evaluate(()=>window.fixture.calls.filter(c=>c.url.endsWith('/retry')).length),0);
    assert.equal(await page.evaluate(()=>JSON.stringify(window.model.state.nodeDetail.n3)),body,'animation failure/recovery retains material and quiz');
    const recoveryWrites=await page.evaluate(()=>window.fixture.calls.filter(c=>c.method==='POST').length);
    await page.evaluate(()=>{
      const f=window.fixture,job=[...f.jobs.values()].find(j=>j.node_id==='n1'&&j.operation==='/path/node');
      job.status=job.finalStatus='succeeded';job.result.manim_review={status:'not_needed'};job.error=null;
      return window.generation.genAllStart(['n1'],{recovering:true});
    });
    assert.equal(await page.evaluate(()=>window.model.state.nodeDetail.n1.manim_review.status),'not_needed','thin successful body receipt restores full material');
    await page.evaluate(()=>{
      const f=window.fixture,job=[...f.jobs.values()].find(j=>j.node_id==='n3'&&j.operation==='/path/node/scene');
      job.status=job.finalStatus='succeeded';job.result={node_id:'n3',study_notes:window.model.state.nodeDetail.n3.study_notes,needed:false,manim_review:{status:'not_needed'}};job.error=null;
      return window.generation.genAllStart(['n3'],{recovering:true});
    });
    assert.equal(await page.evaluate(()=>window.model.state.nodeDetail.n3.manim_review.status),'not_needed','thin successful scene receipt restores full result');
    assert.equal(await page.evaluate(()=>window.model.state.nodeDetail.n3.quiz.round_id),'original-round');
    assert.equal(await page.evaluate(()=>window.fixture.calls.filter(c=>c.method==='POST').length),recoveryWrites,'successful thin-list recovery uses only GET');
    const previousScenePosts=await page.evaluate(()=>window.fixture.calls.filter(c=>c.operation==='/path/node/scene'&&c.method==='POST').length);
    const previousRetries=await page.evaluate(()=>window.fixture.calls.filter(c=>c.url.endsWith('/retry')).length);
    await page.evaluate(async()=>{
      const f=window.fixture,id='n2',saved={study_notes:'n2 已保存正文。',quiz:{round_id:'preserved-quiz'},manim_review:{status:'pending',retryable:true}};
      f.saved.nodeDetail[id]=saved;window.model.state.nodeDetail[id]=saved;
      window.model.state.pending={kind:'nodes',requestId:'persisted-scene-recovery',remaining:[id]};
      for(const [jobId,job] of f.jobs)if(job.node_id===id&&job.operation==='/path/node/scene')f.jobs.delete(jobId);
      await window.generation.genAllStart([id],{recovering:true});
    });
    assert.equal(await page.evaluate(()=>window.fixture.calls.filter(c=>c.operation==='/path/node').length),posts,'missing-animation recovery does not regenerate the saved body');
    assert.equal(await page.evaluate(()=>window.fixture.calls.filter(c=>c.operation==='/path/node/scene'&&c.method==='POST').length),previousScenePosts+1,'missing animation with a persisted batch ID is submitted once');
    assert.equal(await page.evaluate(()=>window.model.state.nodeDetail.n2.manim_review.status),'failed','a terminal animation failure remains visible');
    assert.equal(await page.evaluate(()=>window.fixture.calls.filter(c=>c.url.endsWith('/retry')).length),previousRetries,'recovery does not spend a failed animation retry');
    assert.equal(await page.evaluate(()=>[...window.fixture.jobs.values()].filter(j=>j.node_id==='n2'&&j.operation==='/path/node/scene').length),1,'the recovered animation has one task receipt');
    const recoveredSceneRow=page.locator('.generation-task-list li').filter({hasText:'n2 单元 · 教学动画'});
    assert.equal(await recoveredSceneRow.locator('.learn-job-detail-button').evaluate(button=>!button.hidden),true,'the recovered task exposes its details');
    assert.equal(await page.evaluate(()=>window.model.state.nodeDetail.n2.quiz.round_id),'preserved-quiz');
    const writes=await page.evaluate(()=>window.fixture.calls.filter(c=>c.method==='POST').length);
    await page.evaluate(async()=>{window.LearnUser.readOnly=true;await window.generation.genAllStart(['n3']);await window.generation.requestNodeDetail('n3',true).catch(()=>{});});
    assert.equal(await page.evaluate(()=>window.fixture.calls.filter(c=>c.method==='POST').length),writes,'read-only uses no write request');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),true,'task list fits the viewport');
    assert.deepEqual(errors,[]);
    await page.screenshot({path:path.join(output,browserName+(mobile?'-mobile':'-desktop')+'.png'),fullPage:true});
    fs.writeFileSync(path.join(output,browserName+(mobile?'-mobile':'-desktop')+'.json'),JSON.stringify({browserName,mobile,cases:['one-summary','stable-open-list-and-focus','actual-logs','material-survives-animation-error','GET-only-recovery','thin-successful-material-and-scene-recovery','missing-animation-receipt-resubmission','read-only-zero-writes','viewport'],errors},null,2));
    console.log('PASS '+browserName+' '+(mobile?'mobile':'desktop')+' generation recovery DOM');
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
