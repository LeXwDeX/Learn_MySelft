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
  const snapshot=shell.querySelector('.learn-manim-snapshot');
  const trace={video:[],phases:[],steps:[],holds:[],seeks:[],transitions:[],opacity:{min:1,max:1,samples:0,badSamples:0}};
  const activeStep=()=>Array.from(figure.querySelectorAll('.learn-manim-steps button')).findIndex(button=>button.getAttribute('aria-current')==='step')+1;
  const recordStep=()=>{const step=activeStep();if(trace.steps.at(-1)?.step!==step)trace.steps.push({step,time:performance.now()});};
  let lastPhase=shell.dataset.phase||null,currentHold=null,currentSeek=null;
  const readScreen=()=>({step:activeStep(),snapshotVisible:!snapshot.hidden&&snapshot.complete&&snapshot.naturalWidth>0,opacity:Number(getComputedStyle(media).opacity),time:performance.now()});
  const recordPhase=()=>{
   const phase=shell.dataset.phase||null,step=activeStep(),time=performance.now();
   if(phase===lastPhase)return;
   trace.phases.push({phase,step,time});lastPhase=phase;
   if(phase==='hold'){
    currentHold={step,start:time,snapshotVisible:!snapshot.hidden&&snapshot.complete&&snapshot.naturalWidth>0,allSnapshotsVisible:true,checks:0,videoPaused:video.paused,mediaTime:video.currentTime};trace.holds.push(currentHold);
   } else if(currentHold && phase!=='hold') {currentHold.end=time;currentHold.durationMs=time-currentHold.start;currentHold.endPhase=phase;currentHold=null;}
   if(phase==='seeking'){
    currentSeek={fromStep:step,start:time,snapshotVisible:!snapshot.hidden&&snapshot.complete&&snapshot.naturalWidth>0,checks:0,violations:0};trace.seeks.push(currentSeek);
   } else if(currentSeek && phase!=='seeking') {currentSeek.end=time;currentSeek.durationMs=time-currentSeek.start;currentSeek.toStep=step;currentSeek.endPhase=phase;currentSeek=null;}
  };
  trace.phases.push({phase:lastPhase,step:activeStep(),time:performance.now()});recordStep();
  ['pause','play','playing'].forEach(type=>video.addEventListener(type,()=>trace.video.push({type,phase:shell.dataset.phase||null,step:activeStep(),time:performance.now(),mediaTime:video.currentTime,paused:video.paused})));
  const observer=new MutationObserver(records=>{
   for(const record of records){
    if(record.attributeName==='data-phase'&&record.target===shell)recordPhase();
    if(record.attributeName==='aria-current')recordStep();
   }
  });
  observer.observe(figure,{attributes:true,subtree:true,attributeFilter:['data-phase','aria-current','style']});
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
  const sample=()=>{
   const value=Number(getComputedStyle(media).opacity);trace.opacity.min=Math.min(trace.opacity.min,value);trace.opacity.max=Math.max(trace.opacity.max,value);trace.opacity.samples++;
   if(Math.abs(value-1)>.001)trace.opacity.badSamples++;
   if(shell.dataset.phase==='hold'&&currentHold){currentHold.checks++;if(snapshot.hidden||!snapshot.complete||snapshot.naturalWidth<1)currentHold.allSnapshotsVisible=false;}
   if(shell.dataset.phase==='seeking'&&currentSeek){const state=readScreen();currentSeek.checks++;if(!state.snapshotVisible||state.step!==currentSeek.fromStep||Math.abs(state.opacity-1)>.001)currentSeek.violations++;}
   window.__manimTraceFrame=requestAnimationFrame(sample);
  };
  window.__manimTraceStop=()=>cancelAnimationFrame(window.__manimTraceFrame);
  window.__manimTraceFrame=requestAnimationFrame(sample);
  window.__manimPlaybackTrace=trace;
 });
}
async function resetPlaybackTrace(player){
 await player.evaluate(figure=>{
  const trace=window.__manimPlaybackTrace;trace.video.length=0;trace.phases.length=0;trace.steps.length=0;trace.holds.length=0;trace.seeks.length=0;trace.transitions.length=0;trace.opacity.min=1;trace.opacity.max=1;trace.opacity.samples=0;trace.opacity.badSamples=0;
  const index=Array.from(figure.querySelectorAll('.learn-manim-steps button')).findIndex(button=>button.getAttribute('aria-current')==='step')+1;
  trace.steps.push({step:index,time:performance.now()});trace.phases.push({phase:figure.querySelector('.learn-manim')?.dataset.phase||null,step:index,time:performance.now()});
 });
}
async function readPlaybackTrace(player){return player.evaluate(figure=>{
 const trace=window.__manimPlaybackTrace;
 window.__manimTraceStop?.();
 return {video:trace.video,phases:trace.phases,steps:trace.steps,holds:trace.holds,seeks:trace.seeks,transitions:trace.transitions,opacity:trace.opacity};
});}
async function run(engine,name,size){
 const browser=await engine.launch({headless:true,...(name==='chromium' && process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}:{})});
 try{
  const context=await browser.newContext({viewport:size});if(live)await login(context);
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  const reducedCase=name==='webkit'&&size.width===390;
  if(reducedCase)await page.emulateMedia({reducedMotion:'reduce'});
  await page.goto(origin,{waitUntil:'networkidle'});
  if(live){await page.waitForSelector('#node-n1');await page.locator('#node-n1 .node-head').click();}
  const player=page.locator('figure[data-manim="ready"]').first();await player.waitFor({timeout:45000});
  const frameBounds=await player.evaluate(f=>({width:f.getBoundingClientRect().width,parent:f.parentElement.clientWidth}));assert(frameBounds.width>=frameBounds.parent*.85,'animation uses the available content width');
  const video=player.locator('video'),auto=player.getByRole('button',{name:'自动播放',exact:true});await auto.waitFor();await page.waitForFunction(()=>document.querySelector('.learn-manim video')?.readyState>=1);
  const displayed=await video.evaluate(v=>{const u=new URL(v.currentSrc||v.src,location.href),m=u.pathname.match(/\/manim\/assets\/([0-9a-f]{32})\/video\.mp4$/);return {assetId:m?.[1]||null,path:u.pathname,duration:Number.isFinite(v.duration)?v.duration:null};});
  assert.equal(displayed.assetId,id,'displayed video uses the explicitly selected fixed regression asset');
  const playerStepCount=await player.locator('.learn-manim-steps button').count();
  if(live){const res=await context.request.get(api+'/manim/assets/'+displayed.assetId+'/manifest',{headers:{'X-Learn-User':await page.evaluate(()=>LearnUser.userId)}});assert.equal(res.status(),200);manifest=await res.json();}
  assert.equal(manifest.asset_id,displayed.assetId,'manifest belongs to the displayed video');
  assert(manifest.steps.length>1,'playback fixture needs at least two steps');
  const stepCount=manifest.steps.length;assert.equal(playerStepCount,stepCount,'displayed player controls match its manifest');
  const firstStep=manifest.steps[0],lastStep=manifest.steps.at(-1);
  const fixture={assetId:displayed.assetId,fps:manifest.fps,stepCount,firstResultFrame:firstStep.result_frame,lastResultFrame:lastStep.result_frame};
  report.fixture=fixture;
  assert.equal(manifest.fps,30,'Manim playback uses its contracted 30 fps');
  const initial=await video.evaluate(v=>({paused:v.paused,time:v.currentTime,width:v.videoWidth,playbackRate:v.playbackRate}));
  assert(initial.paused&&initial.time===0,'page must remain still until the learner starts playback');assert.equal(initial.width,1280);assert.equal(initial.playbackRate,0.9);
  assert.equal(await auto.getAttribute('aria-pressed'),null,'automatic playback is an action, not a mode toggle');
  assert.equal(await page.evaluate(()=>matchMedia('(prefers-reduced-motion: reduce)').matches),reducedCase);
  const primary=()=>player.getByRole('button',{name:'播放',exact:true}),paused=()=>player.getByRole('button',{name:'暂停',exact:true});
  const range=player.getByRole('slider',{name:'本步进度'});
  assert.equal(Number(await range.getAttribute('min')),firstStep.start_frame);assert.equal(Number(await range.getAttribute('max')),firstStep.result_frame);
  const waitForStep=async(index,frame,pausedState=true)=>page.waitForFunction(({index,frame,pausedState})=>{
   const f=document.querySelector('figure[data-manim="ready"]'),v=f?.querySelector('video'),active=Array.from(f?.querySelectorAll('.learn-manim-steps button')||[]).findIndex(b=>b.getAttribute('aria-current')==='step')+1;
   return !!v&&v.paused===pausedState&&active===index&&Math.abs(v.currentTime-frame/30)<1/30;
  },{index,frame,pausedState},{timeout:10000});
  await primary().click();await page.waitForFunction(()=>{const v=document.querySelector('.learn-manim video'),s=document.querySelector('.learn-manim');return v&&!v.paused&&s?.dataset.phase==='playback';},null,{timeout:10000});
  await paused().click();const pausePoint=await video.evaluate(v=>({paused:v.paused,time:v.currentTime}));assert(pausePoint.paused,'play can pause playback');
  await primary().click();await page.waitForFunction(()=>{const v=document.querySelector('.learn-manim video'),s=document.querySelector('.learn-manim');return v&&!v.paused&&s?.dataset.phase==='playback';},null,{timeout:10000});
  await paused().click();assert.equal(await video.evaluate(v=>v.paused),true,'play resumes from a pause');
  await player.getByRole('button',{name:'下一步',exact:true}).click();await waitForStep(2,manifest.steps[1].start_frame);
  await player.getByRole('button',{name:'上一步',exact:true}).click();await waitForStep(1,firstStep.start_frame);
  await range.fill(String(firstStep.start_frame+2));await range.dispatchEvent('input');await page.waitForFunction(frame=>Math.abs(document.querySelector('.learn-manim video').currentTime-frame/30)<1/30,firstStep.start_frame+2,{timeout:5000});
  await player.getByRole('button',{name:'重播本步',exact:true}).click();
  await page.waitForFunction(frame=>{const f=document.querySelector('figure[data-manim="ready"]'),v=f?.querySelector('video'),s=f?.querySelector('.learn-manim-snapshot'),active=f?.querySelector('.learn-manim-steps [aria-current="step"]');return v?.paused&&active?.textContent==='1'&&!s.hidden&&s.complete&&s.naturalWidth>0&&Math.abs(v.currentTime-frame/30)<1/30;},firstStep.result_frame,{timeout:20000});
  assert.equal(await player.locator('.learn-manim-steps [aria-current="step"]').textContent(),'1','replay finishes only the current step');
  await installPlaybackTrace(player);
  await auto.evaluate(button=>{window.__autoClicks=0;button.addEventListener('click',()=>window.__autoClicks++,{once:true});});
  await auto.click();
  await page.waitForFunction(()=>{const f=document.querySelector('figure[data-manim="ready"]'),v=f?.querySelector('video'),s=f?.querySelector('.learn-manim');return v&&!v.paused&&s?.dataset.phase==='playback'&&f.querySelector('.learn-manim-steps [aria-current="step"]')?.textContent==='1';},null,{timeout:15000});
  await resetPlaybackTrace(player);
  assert.equal(await page.evaluate(()=>window.__autoClicks),1,'one automatic-play click starts the full run');
  assert.equal(await video.evaluate(v=>v.playbackRate),0.9);
  await page.waitForFunction(({stepCount,lastFrame})=>{const f=document.querySelector('figure[data-manim="ready"]'),v=f?.querySelector('video'),s=f?.querySelector('.learn-manim-snapshot'),shell=f?.querySelector('.learn-manim'),active=Array.from(f?.querySelectorAll('.learn-manim-steps button')||[]).findIndex(b=>b.getAttribute('aria-current')==='step')+1;return !!v&&v.paused&&active===stepCount&&shell?.dataset.phase==='idle'&&!s.hidden&&s.complete&&s.naturalWidth>0&&Math.abs(v.currentTime-lastFrame/30)<1/30;},{stepCount,lastFrame:lastStep.result_frame},{timeout:60000});
  const playbackTrace=await readPlaybackTrace(player),expectedSteps=Array.from({length:stepCount},(_,i)=>i+1);
  assert.deepEqual(playbackTrace.steps.map(item=>item.step),expectedSteps,'one automatic-play click runs every step in order');
  assert.equal(playbackTrace.holds.length,stepCount,'every step has one fixed result hold');
  assert(playbackTrace.holds.every(item=>item.durationMs>=240&&item.durationMs<=400&&item.snapshotVisible&&item.allSnapshotsVisible&&item.videoPaused&&item.checks>0),'each actual result image remains visible during the 250 ms hold: '+JSON.stringify(playbackTrace.holds.map(item=>({step:item.step,durationMs:item.durationMs,snapshotVisible:item.snapshotVisible,allSnapshotsVisible:item.allSnapshotsVisible,videoPaused:item.videoPaused,checks:item.checks,mediaTime:item.mediaTime}))));
  assert.deepEqual(playbackTrace.seeks.map(item=>[item.fromStep,item.toStep]),Array.from({length:stepCount-1},(_,i)=>[i+1,i+2]),'each next step follows a successful seek');
  assert(playbackTrace.seeks.every(item=>item.snapshotVisible&&item.violations===0),'the previous result image stays visible from seek start through every observed animation frame: '+JSON.stringify(playbackTrace.seeks));
  assert.equal(playbackTrace.transitions.length,0,'no opacity transition runs');
  assert(playbackTrace.opacity.samples>0&&playbackTrace.opacity.badSamples===0&&Math.abs(playbackTrace.opacity.min-1)<.001&&Math.abs(playbackTrace.opacity.max-1)<.001,'media opacity stays at 1 throughout playback');
  assert(!playbackTrace.phases.some(item=>['fadeout','fadein','gap'].includes(item.phase)),'no fade or blank-gap phase occurs');
  assert.equal(await video.evaluate(v=>v.playbackRate),0.9);assert.equal(await video.evaluate(v=>v.paused),true);
  const finalRange={min:Number(await range.getAttribute('min')),max:Number(await range.getAttribute('max'))};assert.equal(finalRange.min,lastStep.start_frame);assert.equal(finalRange.max,lastStep.result_frame);
  await player.locator('.learn-manim-snapshot').waitFor({state:'visible'});
  const bounds=await player.evaluate(f=>({scroll:document.documentElement.scrollWidth,view:innerWidth,controls:[...f.querySelectorAll('button,label')].filter(b=>!b.hidden&&b.getClientRects().length).map(b=>({width:b.clientWidth,scrollWidth:b.scrollWidth}))}));
  assert(bounds.scroll<=bounds.view+1,'mobile page does not overflow');assert(bounds.controls.every(b=>b.scrollWidth<=b.width+1),'controls do not cut text');
  await page.screenshot({path:path.join(output,name+'-'+size.width+'.png'),fullPage:true});
  assert.deepEqual(errors,[]);report.cases.push({engine:name,viewport:size,passed:true,fixture,initial,playback:{playbackRate:0.9,steps:playbackTrace.steps.map(item=>item.step),holdDurationsMs:playbackTrace.holds.map(item=>item.durationMs),seeks:playbackTrace.seeks.map(item=>({fromStep:item.fromStep,toStep:item.toStep,checks:item.checks,violations:item.violations})),opacity:playbackTrace.opacity,transitionCount:playbackTrace.transitions.length,reducedMotion:reducedCase},errors});await context.close();
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
