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
async function run(engine,name,size){
 const browser=await engine.launch({headless:true,...(name==='chromium' && process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}:{})});
 try{
  const context=await browser.newContext({viewport:size});if(live)await login(context);
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(origin,{waitUntil:'networkidle'});
  if(live){await page.waitForSelector('#node-n1');await page.locator('#node-n1 .node-head').click();}
  const player=page.locator('figure[data-manim="ready"]').first();await player.waitFor({timeout:45000});
  const frameBounds=await player.evaluate(f=>({width:f.getBoundingClientRect().width,parent:f.parentElement.clientWidth}));assert(frameBounds.width>=frameBounds.parent*.85,'animation uses the available content width');
  const video=player.locator('video'),play=player.getByRole('button',{name:'播放本步',exact:true});await play.waitFor();await page.waitForFunction(()=>document.querySelector('.learn-manim video')?.readyState>=1);
  if(live){const res=await context.request.get(api+'/manim/assets/'+id+'/manifest',{headers:{'X-Learn-User':await page.evaluate(()=>LearnUser.userId)}});assert.equal(res.status(),200);manifest=await res.json();}
  await page.waitForTimeout(300);const initial=await video.evaluate(v=>({paused:v.paused,time:v.currentTime,width:v.videoWidth}));assert(initial.paused && initial.time===0);assert.equal(initial.width,1280);
  await play.click();await page.waitForFunction(()=>document.querySelector('.learn-manim video').paused && document.querySelector('.learn-manim-status').textContent.includes('本步完成'),null,{timeout:15000});
  const result=await video.evaluate(v=>v.currentTime);assert(Math.abs(result-manifest.steps[0].result_frame/30)<1/30);await player.locator('.learn-manim-snapshot').waitFor({state:'visible'});
  const second=manifest.steps[Math.min(1,manifest.steps.length-1)];
  if(manifest.steps.length>1)await player.getByRole('button',{name:'下一步',exact:true}).click();else assert(await player.getByRole('button',{name:'下一步',exact:true}).isDisabled());const afterNext=await video.evaluate(v=>({time:v.currentTime,paused:v.paused}));assert(afterNext.paused);assert(Math.abs(afterNext.time-second.start_frame/30)<1/30);
  const range=player.getByRole('slider',{name:'本步进度'});await range.fill(String(second.result_frame-2));await range.dispatchEvent('input');assert(Math.abs(await video.evaluate(v=>v.currentTime)-(second.result_frame-2)/30)<1/30);
  if(manifest.steps.length>1)await player.getByRole('button',{name:'上一步',exact:true}).click();await player.getByLabel('连续演示').check();await play.click();
  await page.waitForFunction(hold=>document.querySelector('.learn-manim video').currentTime>=hold/30+.15,manifest.steps[0].hold_start_frame,{timeout:15000});assert.equal(await video.evaluate(v=>v.paused),false,'continuous authored hold keeps playing');
  if(manifest.steps.length>1){await page.waitForFunction(()=>document.querySelector('.learn-manim-steps [aria-current="step"]').textContent==='2',null,{timeout:10000});assert.equal(await video.evaluate(v=>v.paused),false);}
  if(!await video.evaluate(v=>v.paused))await player.getByRole('button',{name:'暂停',exact:true}).click();const saved=await video.evaluate(v=>v.currentTime);
  if(!live){await player.evaluate(f=>{window.savedFigure=f;window.savedVideo=f.querySelector('video');document.querySelector('#lightbox').appendChild(f);document.querySelector('#lightbox').showModal();LearnMarkdown.enhance(f);});assert.equal(await video.evaluate(v=>v===window.savedVideo),true);assert(Math.abs(await video.evaluate(v=>v.currentTime)-saved)<.04);await page.setViewportSize({width:390,height:844});assert.equal(await video.evaluate(v=>v.paused),true);await player.evaluate(f=>{document.querySelector('#lightbox').close();document.querySelector('#notes').appendChild(f);LearnMarkdown.enhance(f);});}
  await page.setViewportSize(size);const bounds=await player.evaluate(f=>({scroll:document.documentElement.scrollWidth,view:innerWidth,controls:[...f.querySelectorAll('button,label')].filter(b=>!b.hidden && b.getClientRects().length).map(b=>({text:b.textContent,w:b.clientWidth,sw:b.scrollWidth}))}));assert(bounds.scroll<=bounds.view+1,'mobile page does not overflow');assert(bounds.controls.every(b=>b.sw<=b.w+1),'controls do not cut text: '+JSON.stringify(bounds));
  await page.screenshot({path:path.join(output,name+'-'+size.width+'.png'),fullPage:true});
  if(!live){const rangeResponse=await context.request.get(api+'/manim/assets/'+id+'/video.mp4?user=regression_fixture',{headers:{Range:'bytes=0-31'}});assert.equal(rangeResponse.status(),206);assert.equal((await rangeResponse.body()).length,32);
   await page.route('**/manim/assets/*/video.mp4*',r=>r.abort('failed'));await player.getByRole('button',{name:'重播本步',exact:true}).click();await video.evaluate(v=>{v.removeAttribute('src');v.src=LearnUser.apiBase+'/manim/assets/'+ '7'.repeat(32) +'/video.mp4?user=regression_fixture&failure=1';v.load();});await page.waitForFunction(()=>document.querySelector('.learn-manim-status').textContent.includes('解码失败'));assert((await page.locator('#notes').textContent()).includes('正文说明保留'));await page.unroute('**/manim/assets/*/video.mp4*');await player.getByRole('button',{name:'重新加载',exact:true}).click();await play.waitFor();await page.waitForFunction(()=>Array.from(document.querySelectorAll('.learn-manim-controls button')).some(b=>b.textContent==='播放本步' && !b.disabled));
  }
  assert.deepEqual(errors,[]);report.cases.push({engine:name,viewport:size,passed:true,initial,result,range:!live,domMove:!live,errors});await context.close();
 }finally{await browser.close();}
}
(async()=>{
 if(!live)await setupLocal();
 for(const [name,engine] of [['chromium',chromium],['webkit',webkit]])for(const size of [{width:1440,height:1000},{width:390,height:844}]){console.log(JSON.stringify({phase:name+'-'+size.width}));await run(engine,name,size);}
 report.assetRequests=assetRequests;fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({passed:true,cases:report.cases.length,output}));
})().catch(error=>{report.error=error.message;fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));console.error(error);process.exitCode=1;}).finally(()=>servers.forEach(s=>s.close()));
