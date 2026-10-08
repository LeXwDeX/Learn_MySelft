/* Real ManimGL video. Local mode needs MANIM_ASSET_DIR. Deployed mode needs
 * MANIM_PAGE_URL, MANIM_ASSET_ID and RELEASE_ENV. Output stays outside the repo.
 * Deployed mode reads only the fixed regression account's existing assets.
 */
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {execFileSync}=require('node:child_process');
const {chromium,webkit}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const runtime=process.env.MANIM_RUNTIME_REPORT?JSON.parse(fs.readFileSync(process.env.MANIM_RUNTIME_REPORT,'utf8')):null;
const pageURL=process.env.MANIM_PAGE_URL || runtime?.sourceURL;
const repo=path.resolve(__dirname,'..'),output=process.env.RELEASE_OUTPUT,live=!!pageURL;
assert(output && path.isAbsolute(output) && !path.resolve(output).startsWith(repo+path.sep));fs.mkdirSync(output,{recursive:true});
const id=process.env.MANIM_ASSET_ID || runtime?.assets.new_material.asset_id || '7'.repeat(32);assert(/^[0-9a-f]{32}$/.test(id));
let origin,api,manifest,servers=[],assetRequests=[];
const report={mode:live?'deployed':'actual-renderer-local',revision:process.env.RELEASE_REVISION || null,cases:[]};
const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve('http://127.0.0.1:'+server.address().port)));
async function setupLocal(){
 const dir=process.env.MANIM_ASSET_DIR;assert(dir && path.isAbsolute(dir));
 manifest={...JSON.parse(fs.readFileSync(path.join(dir,'manifest.json'),'utf8')),asset_id:id,title:'向量分量与维度',summary:'先观察分量的位置，再理解维度和分量顺序。'};
 const assets=http.createServer((req,res)=>{
  res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Access-Control-Allow-Credentials','true');res.setHeader('Access-Control-Allow-Headers','X-Learn-User');res.setHeader('Cache-Control','no-store');
  if(req.method==='OPTIONS'){res.writeHead(204);res.end();return;}
  const url=new URL(req.url,api),file=url.pathname.split('/').pop();
  if(!req.headers.cookie?.includes('manim_fixture=owned') || (file==='manifest'?req.headers['x-learn-user']!=='regression_fixture':url.searchParams.get('user')!=='regression_fixture')){res.writeHead(403);res.end();return;}
  assetRequests.push({file,range:req.headers.range || null,credentialed:true});
  if(file==='manifest'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(manifest));return;}
  if(!/^(video\.mp4|poster\.png|step-[0-7]\.png)$/.test(file)){res.writeHead(404);res.end();return;}
  const target=path.join(dir,file);if(!fs.existsSync(target)){res.writeHead(404);res.end();return;}
  const size=fs.statSync(target).size;res.setHeader('Content-Type',file.endsWith('.mp4')?'video/mp4':'image/png');res.setHeader('Accept-Ranges','bytes');
  const match=/^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
  if(match){const start=Number(match[1]),end=match[2]?Math.min(size-1,Number(match[2])):size-1;res.writeHead(206,{'Content-Range':`bytes ${start}-${end}/${size}`,'Content-Length':end-start+1});fs.createReadStream(target,{start,end}).pipe(res);}
  else{res.setHeader('Content-Length',size);fs.createReadStream(target).pipe(res);}
 });
 const web=http.createServer((req,res)=>{
  if(req.url==='/'){
   res.setHeader('Content-Type','text/html; charset=utf-8');res.setHeader('Set-Cookie','manim_fixture=owned; Path=/; SameSite=Lax');
   const ref={version:1,asset_id:id,title:manifest.title,summary:manifest.summary};
   const notes='正文说明保留。\n\n```learn-manim\n'+JSON.stringify(ref)+'\n```';
   res.end('<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>真实 ManimGL 播放器验收</title><link rel="stylesheet" href="/shared/ui.css"><link rel="stylesheet" href="/shared/learning-scenes.css"><link rel="stylesheet" href="/shared/markdown.css"><style>body{margin:0;padding:16px;font:16px var(--learn-font);background:var(--learn-paper)}main{max-width:850px;margin:auto}dialog{width:min(900px,calc(100% - 40px));padding:12px;border:0;background:var(--learn-paper)}dialog::backdrop{background:#0008}</style><main><h1>分步观察向量</h1><div id="notes"></div></main><dialog id="lightbox"></dialog><script>window.LearnUser={apiBase:'+JSON.stringify(api)+',userId:"regression_fixture",fetch:function(url,options){return fetch(url,Object.assign({},options,{credentials:"include",headers:{"X-Learn-User":"regression_fixture"}}));}}</script><script src="/shared/vendor-markdown-it.js"></script><script src="/shared/manim-player.js"></script><script src="/shared/markdown.js"></script><script>var notes='+JSON.stringify(notes)+';document.getElementById("notes").innerHTML=LearnMarkdown.render(notes);LearnMarkdown.enhance(document.getElementById("notes"));</script></html>');return;
  }
  const relative=new URL(req.url,'http://local').pathname;
  if(!/^\/shared\/[\w.-]+$/.test(relative)){res.writeHead(404);res.end();return;}
  const file=path.join(repo,relative);res.setHeader('Content-Type',file.endsWith('.css')?'text/css':'text/javascript');fs.createReadStream(file).on('error',()=>res.end()).pipe(res);
 });
 servers=[assets,web];api=await listen(assets);origin=await listen(web);
}
async function login(context){
 const environment=process.env.RELEASE_ENV || runtime?.environment;assert(['test','production'].includes(environment));api='http://192.168.33.146:'+(environment==='test'?8111:8101);
 const credentials=JSON.parse(execFileSync('ssh',['-o','BatchMode=yes','root@192.168.33.146','cat /opt/study-assistant/regression-credentials/'+environment+'.json'],{encoding:'utf8'}));
 const auth=await context.request.post(api+'/auth/login',{data:{username:'regression_bot',password:credentials.password}});assert.equal(auth.status(),200,'fixed regression login');const identity=await auth.json();assert.equal(identity.user.id,environment==='test'?'u370119af344c603c':'ub3fd33db1b3e5638','regression account identity');origin=pageURL;
}
async function installPlaybackTrace(player){
 await player.evaluate(figure=>{
  const shell=figure.querySelector('.learn-manim'),video=shell.querySelector('video'),media=shell.querySelector('.learn-manim-media');
  const trace={video:[],phases:[],steps:[],transitions:[]};
  const activeStep=()=>Array.from(figure.querySelectorAll('.learn-manim-steps button')).findIndex(button=>button.getAttribute('aria-current')==='step')+1;
  const recordStep=()=>{const step=activeStep();if(trace.steps.at(-1)?.step!==step)trace.steps.push({step,time:performance.now()});};
  trace.phases.push({phase:shell.dataset.phase||null,step:activeStep(),time:performance.now()});recordStep();
  ['pause','play','playing'].forEach(type=>video.addEventListener(type,()=>trace.video.push({type,phase:shell.dataset.phase||null,step:activeStep(),time:performance.now(),mediaTime:video.currentTime,paused:video.paused})));
  const observer=new MutationObserver(records=>{
   for(const record of records){
    if(record.attributeName==='data-phase'&&record.target===shell)trace.phases.push({phase:shell.dataset.phase||null,step:activeStep(),time:performance.now()});
    if(record.attributeName==='aria-current')recordStep();
   }
  });
  observer.observe(figure,{attributes:true,subtree:true,attributeFilter:['data-phase','aria-current']});
  media.addEventListener('transitionrun',event=>{
   if(event.target!==media||event.propertyName!=='opacity')return;
   const item={phase:shell.dataset.phase||null,start:performance.now(),samples:[],elapsedTime:null,end:null,endOpacity:null,cancelled:false};trace.transitions.push(item);
   const sample=()=>{if(item.end!==null||item.cancelled)return;item.samples.push(Number(getComputedStyle(media).opacity));requestAnimationFrame(sample);};requestAnimationFrame(sample);
  });
  media.addEventListener('transitionend',event=>{
   if(event.target!==media||event.propertyName!=='opacity')return;
   const item=trace.transitions.slice().reverse().find(value=>value.end===null&&!value.cancelled);if(!item)return;
   item.end=performance.now();item.elapsedTime=event.elapsedTime;item.endOpacity=Number(getComputedStyle(media).opacity);
  });
  media.addEventListener('transitioncancel',event=>{
   if(event.target!==media||event.propertyName!=='opacity')return;
   const item=trace.transitions.slice().reverse().find(value=>value.end===null&&!value.cancelled);if(item)item.cancelled=true;
  });
  window.__manimPlaybackTrace=trace;
 });
}
async function resetPlaybackTrace(player){
 await player.evaluate(figure=>{
  const trace=window.__manimPlaybackTrace;trace.video.length=0;trace.phases.length=0;trace.steps.length=0;trace.transitions.length=0;
  const index=Array.from(figure.querySelectorAll('.learn-manim-steps button')).findIndex(button=>button.getAttribute('aria-current')==='step')+1;
  trace.steps.push({step:index,time:performance.now()});
 });
}
async function readPlaybackTrace(player){return player.evaluate(figure=>{
 const trace=window.__manimPlaybackTrace;
 const gaps=[];
 trace.phases.forEach((entry,index)=>{
  if(entry.phase!=='gap')return;
  const end=trace.phases.slice(index+1).find(next=>next.phase==='seeking');
  if(end)gaps.push({fromStep:entry.step,durationMs:end.time-entry.time});
 });
 return {video:trace.video,phases:trace.phases,steps:trace.steps,transitions:trace.transitions,gaps};
});}
async function run(engine,name,size){
 const browser=await engine.launch({headless:true,...(name==='chromium' && process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}:{})});
 try{
  const context=await browser.newContext({viewport:size});if(live)await login(context);
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(origin,{waitUntil:'networkidle'});
  if(live){await page.waitForSelector('#node-n1');await page.locator('#node-n1 .node-head').click();}
  const player=page.locator('figure[data-manim="ready"]').first();await player.waitFor({timeout:45000});
  const frameBounds=await player.evaluate(f=>({width:f.getBoundingClientRect().width,parent:f.parentElement.clientWidth}));assert(frameBounds.width>=frameBounds.parent*.85,'animation uses the available content width');
  const video=player.locator('video'),auto=player.getByRole('button',{name:'自动播放',exact:true});await auto.waitFor();await page.waitForFunction(()=>document.querySelector('.learn-manim video')?.readyState>=1);
  if(live){const res=await context.request.get(api+'/manim/assets/'+id+'/manifest',{headers:{'X-Learn-User':await page.evaluate(()=>LearnUser.userId)}});assert.equal(res.status(),200);manifest=await res.json();}
  assert(manifest.steps.length>1,'playback fixture needs at least two steps');
  const primary=()=>player.getByRole('button',{name:'播放',exact:true});
  const manualPlay=()=>player.getByRole('button',{name:'播放本步',exact:true});
  const waitForStepResult=async stepIndex=>page.waitForFunction(index=>{
   const figure=document.querySelector('figure[data-manim="ready"]'),video=figure?.querySelector('video');
   return video?.paused && figure.querySelector('.learn-manim-status').textContent.includes('本步完成') &&
    Math.abs(video.currentTime-Number(figure.querySelector('.learn-manim-progress input').max)/30)<1/30 &&
    Array.from(figure.querySelectorAll('.learn-manim-steps [aria-current="step"]')).findIndex(button=>button.getAttribute('aria-current')==='step')+1===index;
  },stepIndex,{timeout:20000});
  const initial=await video.evaluate(v=>({paused:v.paused,time:v.currentTime,width:v.videoWidth,playbackRate:v.playbackRate}));
  assert(initial.paused && initial.time===0,'page must remain still until the learner starts playback');assert.equal(initial.width,1280);assert.equal(initial.playbackRate,0.9);
  assert.equal(await auto.getAttribute('aria-pressed'),'true','automatic playback is the default mode');
  await auto.click();assert.equal(await auto.getAttribute('aria-pressed'),'false','button disables automatic playback');
  await manualPlay().click();await waitForStepResult(1);
  const result=await video.evaluate(v=>({time:v.currentTime,playbackRate:v.playbackRate}));
  assert(Math.abs(result.time-manifest.steps[0].result_frame/30)<1/30);assert.equal(result.playbackRate,0.9);await player.locator('.learn-manim-snapshot').waitFor({state:'visible'});
  const second=manifest.steps[1];
  await player.getByRole('button',{name:'下一步',exact:true}).click();await page.waitForFunction(frame=>{
   const video=document.querySelector('.learn-manim video');return video?.paused&&Math.abs(video.currentTime-frame/30)<1/30;
  },second.start_frame,{timeout:5000});
  const range=player.getByRole('slider',{name:'本步进度'});await range.fill(String(second.result_frame-2));await range.dispatchEvent('input');
  await page.waitForFunction(frame=>Math.abs(document.querySelector('.learn-manim video').currentTime-frame/30)<1/30,second.result_frame-2,{timeout:5000});
  await player.getByRole('button',{name:'上一步',exact:true}).click();await page.waitForFunction(frame=>Math.abs(document.querySelector('.learn-manim video').currentTime-frame/30)<1/30,manifest.steps[0].start_frame,{timeout:5000});
  await player.getByRole('button',{name:'重播本步',exact:true}).click();await waitForStepResult(1);
  assert.equal(await player.locator('.learn-manim-steps [aria-current="step"]').count(),1);
  await auto.click();assert.equal(await auto.getAttribute('aria-pressed'),'true');
  await installPlaybackTrace(player);await primary().click();
  await page.waitForFunction(resultFrame=>{
   const figure=document.querySelector('figure[data-manim="ready"]');
   return figure?.querySelector('.learn-manim')?.dataset.phase==='hold'&&figure.querySelector('video').paused&&
    figure.querySelector('.learn-manim-steps [aria-current="step"]')?.textContent==='1'&&
    Math.abs(figure.querySelector('video').currentTime-resultFrame/30)<1/30&&!figure.querySelector('.learn-manim-snapshot').hidden;
  },manifest.steps[0].result_frame,{timeout:10000});
  const pausedBoundary=await player.evaluate(figure=>({phase:figure.querySelector('.learn-manim').dataset.phase,paused:figure.querySelector('video').paused,time:figure.querySelector('video').currentTime,
   playbackRate:figure.querySelector('video').playbackRate,step:figure.querySelector('.learn-manim-steps [aria-current="step"]')?.textContent,
   primary:Array.from(figure.querySelectorAll('button')).find(button=>button.textContent==='暂停')?.textContent||null,
   resultVisible:!figure.querySelector('.learn-manim-snapshot').hidden}));
  assert(pausedBoundary.paused&&pausedBoundary.resultVisible);assert.equal(pausedBoundary.playbackRate,0.9);assert.equal(pausedBoundary.step,'1');assert.equal(pausedBoundary.primary,'暂停');
  assert(Math.abs(pausedBoundary.time-manifest.steps[0].result_frame/30)<1/30,'automatic hold pauses on the exact result frame');
  await player.getByRole('button',{name:'暂停',exact:true}).click();await primary().waitFor();
  assert.equal(await video.evaluate(v=>v.paused),true,'logical pause cancels automatic playback while media is in authored hold');
  assert.equal(await player.locator('.learn-manim-steps [aria-current="step"]').textContent(),'1','logical pause stays on the current step');
  await resetPlaybackTrace(player);await primary().click();
  await page.waitForFunction(()=>{
   const figure=document.querySelector('figure[data-manim="ready"]'),video=figure?.querySelector('video');
   return video&&!video.paused&&figure.querySelector('.learn-manim-steps [aria-current="step"]')?.textContent==='2'&&figure.querySelector('.learn-manim')?.dataset.phase==='playback';
  },null,{timeout:15000});
  await page.waitForFunction(()=>{
   const trace=window.__manimPlaybackTrace;return trace?.transitions.length===2&&trace.transitions.every(item=>item.end!==null||item.cancelled);
  },null,{timeout:2000});
  const playbackTrace=await readPlaybackTrace(player),expectedSteps=[1,2];
  assert.deepEqual(playbackTrace.steps.map(item=>item.step),expectedSteps,'automatic playback advances to the next authored step');
  assert.equal(playbackTrace.gaps.length,1,'the first automatic boundary has one blank gap');
  assert(playbackTrace.gaps[0].durationMs>=250,'the first inter-step gap lasts at least 250 ms');
  const fades=playbackTrace.transitions;assert.equal(fades.length,2,'the boundary has one fade-out and one fade-in');
  const out=fades[0],into=fades[1];assert.equal(out.phase,'fadeout');assert.equal(into.phase,'fadein');
  for(const [transition,target] of [[out,0],[into,1]]){
   assert(transition.end!==null&&!transition.cancelled,'opacity fade completes');assert(Math.abs(transition.elapsedTime-.15)<.04,'opacity fade lasts 150 ms');
   assert(Math.abs(transition.endOpacity-target)<.02,'fade reaches its target opacity');assert(transition.samples.some(value=>value>.05&&value<.95),'opacity changes through an intermediate value');
  }
  const boundaryPauses=playbackTrace.video.filter(event=>event.type==='pause'&&event.phase==='hold');
  assert.equal(boundaryPauses.length,1,'video pauses at the automatic step boundary');
  assert.equal(boundaryPauses[0].step,1);assert(boundaryPauses[0].paused);
  assert(Math.abs(boundaryPauses[0].mediaTime-manifest.steps[0].result_frame/30)<1/30,'pause boundary seeks to the exact result frame');
  const hold=playbackTrace.phases.find(event=>event.phase==='hold'&&event.step===1),fade=playbackTrace.phases.find(event=>event.phase==='fadeout'&&event.step===1);
  assert(hold&&fade,'the result hold transitions to fade-out');
  const expectedHoldMs=(manifest.steps[0].end_frame-manifest.steps[0].hold_start_frame)/manifest.fps/.9*1000;
  const holdDurationMs=fade.time-hold.time;
  assert(holdDurationMs>=expectedHoldMs-100&&holdDurationMs<=expectedHoldMs+500,'authored result hold is converted to 0.9-speed wall time');
  await player.getByRole('button',{name:'暂停',exact:true}).click();await primary().waitFor();
  const lastIndex=manifest.steps.length-1,lastStep=manifest.steps[lastIndex];
  await player.locator('.learn-manim-steps button').nth(lastIndex).click();
  await page.waitForFunction(({frame,index})=>{
   const figure=document.querySelector('figure[data-manim="ready"]'),video=figure?.querySelector('video');
   return video?.paused&&Math.abs(video.currentTime-frame/30)<1/30&&figure.querySelector('.learn-manim-steps [aria-current="step"]')?.textContent===String(index);
  },{frame:lastStep.start_frame,index:lastIndex+1},{timeout:10000});
  assert.equal(await auto.getAttribute('aria-pressed'),'true','automatic mode stays enabled after selecting the last step');
  await primary().click();
  await page.waitForFunction(stepCount=>{
   const figure=document.querySelector('figure[data-manim="ready"]'),video=figure?.querySelector('video');
   const current=figure?.querySelector('.learn-manim-steps [aria-current="step"]')?.textContent;
   return video?.paused&&figure.querySelector('.learn-manim-status').textContent.includes('全部步骤完成')&&current===String(stepCount);
  },manifest.steps.length,{timeout:20000});
  const finalAuto=await video.evaluate(v=>({paused:v.paused,time:v.currentTime,playbackRate:v.playbackRate}));
  assert.equal(finalAuto.paused,true,'the last automatic step ends in a still frame');assert.equal(finalAuto.playbackRate,0.9);
  assert(Math.abs(finalAuto.time-lastStep.result_frame/30)<1/30,'the last step stops on its result frame');
  await player.locator('.learn-manim-snapshot').waitFor({state:'visible'});
  const holdDurationsMs=[holdDurationMs];
  let reducedMotion=null;
  if(name==='webkit'&&size.width===390){
   await page.emulateMedia({reducedMotion:'reduce'});await page.reload({waitUntil:'networkidle'});
   if(live){await page.waitForSelector('#node-n1');await page.locator('#node-n1 .node-head').click();}
   const reducedPlayer=page.locator('figure[data-manim="ready"]').first();await reducedPlayer.waitFor();
   const reducedVideo=reducedPlayer.locator('video');await page.waitForFunction(()=>document.querySelector('.learn-manim video')?.readyState>=1);
   assert.equal(await page.evaluate(()=>matchMedia('(prefers-reduced-motion: reduce)').matches),true);
   assert.equal(await reducedVideo.evaluate(v=>v.playbackRate),0.9);
   await installPlaybackTrace(reducedPlayer);await reducedPlayer.getByRole('button',{name:'播放',exact:true}).click();
   await page.waitForFunction(()=>{
    const figure=document.querySelector('figure[data-manim="ready"]');
    return figure?.querySelector('.learn-manim-steps [aria-current="step"]')?.textContent==='2'&&figure.querySelector('.learn-manim')?.dataset.phase==='playback'&&!figure.querySelector('video').paused;
   },null,{timeout:15000});
   const reducedTrace=await readPlaybackTrace(reducedPlayer);assert.deepEqual(reducedTrace.steps.map(item=>item.step),[1,2]);
   assert.equal(reducedTrace.transitions.length,0,'reduced motion skips opacity fades');assert.equal(reducedTrace.gaps.length,1);assert(reducedTrace.gaps[0].durationMs>=250,'reduced motion keeps the 250 ms gap');
   reducedMotion={passed:true,playbackRate:0.9,steps:reducedTrace.steps.map(item=>item.step),gapMs:reducedTrace.gaps[0].durationMs,fadeCount:reducedTrace.transitions.length};
   await reducedPlayer.getByRole('button',{name:'暂停',exact:true}).click();
  }
  const playbackSummary={playbackRate:0.9,steps:playbackTrace.steps.map(item=>item.step),
   pauseBoundaries:boundaryPauses.length,gapDurationsMs:playbackTrace.gaps.map(gap=>gap.durationMs),
   fadeDurationsMs:fades.map(transition=>transition.elapsedTime*1000),holdDurationsMs,reducedMotion};
  const saved=await video.evaluate(v=>v.currentTime);
  if(!live){await player.evaluate(f=>{window.savedFigure=f;window.savedVideo=f.querySelector('video');document.querySelector('#lightbox').appendChild(f);document.querySelector('#lightbox').showModal();LearnMarkdown.enhance(f);});assert.equal(await video.evaluate(v=>v===window.savedVideo),true);assert(Math.abs(await video.evaluate(v=>v.currentTime)-saved)<.04);await page.setViewportSize({width:390,height:844});assert.equal(await video.evaluate(v=>v.paused),true);await player.evaluate(f=>{document.querySelector('#lightbox').close();document.querySelector('#notes').appendChild(f);LearnMarkdown.enhance(f);});}
  await page.setViewportSize(size);const bounds=await player.evaluate(f=>({scroll:document.documentElement.scrollWidth,view:innerWidth,controls:[...f.querySelectorAll('button,label')].filter(b=>!b.hidden && b.getClientRects().length).map(b=>({text:b.textContent,w:b.clientWidth,sw:b.scrollWidth}))}));assert(bounds.scroll<=bounds.view+1,'mobile page does not overflow');assert(bounds.controls.every(b=>b.sw<=b.w+1),'controls do not cut text: '+JSON.stringify(bounds));
  await page.screenshot({path:path.join(output,name+'-'+size.width+'.png'),fullPage:true});
  if(!live){const rangeResponse=await context.request.get(api+'/manim/assets/'+id+'/video.mp4?user=regression_fixture',{headers:{Range:'bytes=0-31'}});assert.equal(rangeResponse.status(),206);assert.equal((await rangeResponse.body()).length,32);
   await page.route('**/manim/assets/*/video.mp4*',r=>r.abort('failed'));await player.getByRole('button',{name:'重播本步',exact:true}).click();await video.evaluate(v=>{v.removeAttribute('src');v.src=LearnUser.apiBase+'/manim/assets/'+ '7'.repeat(32) +'/video.mp4?user=regression_fixture&failure=1';v.load();});await page.waitForFunction(()=>document.querySelector('.learn-manim-status').textContent.includes('解码失败'));assert((await page.locator('#notes').textContent()).includes('正文说明保留'));await page.unroute('**/manim/assets/*/video.mp4*');await player.getByRole('button',{name:'重新加载',exact:true}).click();await player.getByRole('button',{name:'播放',exact:true}).waitFor();await page.waitForFunction(()=>Array.from(document.querySelectorAll('.learn-manim-controls button')).some(b=>b.textContent==='播放' && !b.disabled));
  }
  assert.deepEqual(errors,[]);report.cases.push({engine:name,viewport:size,passed:true,initial,result,playback:playbackSummary,range:!live,domMove:!live,errors});await context.close();
 }finally{await browser.close();}
}
(async()=>{
 if(!live)await setupLocal();
 const selected=process.env.MANIM_BROWSER_CASES?new Set(process.env.MANIM_BROWSER_CASES.split(',')):null;
 for(const [name,engine] of [['chromium',chromium],['webkit',webkit]])for(const size of [{width:1440,height:1000},{width:390,height:844}]){
  if(selected&&!selected.has(name+'-'+size.width))continue;
  console.log(JSON.stringify({phase:name+'-'+size.width}));await run(engine,name,size);
 }
 report.assetRequests=assetRequests;fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({passed:true,cases:report.cases.length,output}));
})().catch(error=>{report.error=error.message;fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));console.error(error);process.exitCode=1;}).finally(()=>servers.forEach(s=>s.close()));
