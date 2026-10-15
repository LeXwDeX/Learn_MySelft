/* Chromium regression for learning-document boot identity and write gates.
 * Uses generated local assets and a route.fulfill fixture.invalid site. Every
 * API response is synthetic and held in browser memory; no server, credentials,
 * model endpoint, or external network is used.
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const root = path.resolve(__dirname, '..');
const fixtureSlug = 'boot192-original';
const fixtureKey = 'u192probe/learn-path-v1-' + fixtureSlug;
const otherSlug = 'boot192-other';
const otherKey = 'u192probe/learn-path-v1-' + otherSlug;
const storageKeys = {entries:'__boot_probe_entries', calls:'__boot_probe_calls', serverReads:'__boot_probe_server_reads'};
const output = process.env.CREATION_BOOT_OUTPUT || '/private/tmp';
const originalMaterial = {name:'original-note.txt', text:'合成原始资料'};
const fixture = {
  stage:'intake', title:'启动竞态合成资料', topic:'topic192', history:[], materials:[originalMaterial],
  spec:null, queries:[], sources:[], research_version:0, brief:'', plan:null,
  nodeDetail:{}, nodeState:{}, nodeAccess:{}, pending:null
};
const otherFixture = {...fixture, title:'另一个合成资料', topic:'topicOther', materials:[{name:'other-note.txt',text:'其他合成资料'}]};
const mime = file => file.endsWith('.html')?'text/html':file.endsWith('.css')?'text/css':file.endsWith('.svg')?'image/svg+xml':file.endsWith('.woff2')?'font/woff2':'application/javascript';

function assetFor(url) {
  const p = url.pathname;
  if (p.endsWith('/learning-path.html')) return path.join(root,'learning-path/learning-path.html');
  if (p.startsWith('/diagram-design/learning-path/')) return path.join(root,'learning-path',path.basename(p));
  if (p.startsWith('/learn/assets/')) {
    const name = path.basename(p);
    if (['user-shell.js','user-session.js','saves.js','job-details.js','jobs.js'].includes(name)) return null;
    return path.join(root,'shared',name);
  }
  for (const dir of ['katex','highlight']) {
    const needle = '/' + dir + '/';
    const index = p.indexOf(needle);
    if (index >= 0) return path.join(root,'learning-path',p.slice(index + 1));
  }
  return null;
}

function seedEntries() {
  return {
    [fixtureKey]:JSON.stringify(fixture),
    [otherKey]:JSON.stringify(otherFixture),
    'u192probe/learn-path-v1-last':fixtureSlug
  };
}

async function makePage(browser, options={}) {
  const page = await browser.newPage({viewport:{width:options.width || 1440,height:900}});
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    const asset = assetFor(url);
    if (asset && fs.existsSync(asset)) return route.fulfill({status:200,contentType:mime(asset),body:fs.readFileSync(asset)});
    return route.fulfill({status:200,contentType:url.pathname.endsWith('.css')?'text/css':'application/javascript',body:''});
  });
  const config = {
    holdFirstServerRead:!!options.holdFirstServerRead,
    failureMode:options.failureMode || null,
    readOnly:!!options.readOnly,
    parseFailure:!!options.parseFailure,
    saveFailure:!!options.saveFailure,
    targetFixtureMissing:!!options.targetFixtureMissing
  };
  await page.addInitScript(({seed,config,storageKeys,fixtureKey,otherKey}) => {
    if (!sessionStorage.getItem(storageKeys.entries)) sessionStorage.setItem(storageKeys.entries,JSON.stringify(seed));
    if (!sessionStorage.getItem(storageKeys.calls)) sessionStorage.setItem(storageKeys.calls,'[]');
    if (!sessionStorage.getItem(storageKeys.serverReads)) sessionStorage.setItem(storageKeys.serverReads,'0');
    window.LearnConfig = {apiBase:'/api'};
    window.LearnJobs = {supports:()=>false,list:async()=>[],requestId:()=> 'boot-probe-192'};
    window.LearnUser = {userId:'u192probe',apiBase:'/api',readOnly:config.readOnly,ready:Promise.resolve(),fetch:async(url,request={}) => {
      const parsed = new URL(url,location.href), path = parsed.pathname, method=(request.method||'GET').toUpperCase();
      const calls = JSON.parse(sessionStorage.getItem(storageKeys.calls)||'[]');
      function record(extra={}) { calls.push({path,method,...extra});sessionStorage.setItem(storageKeys.calls,JSON.stringify(calls)); }
      const entries = JSON.parse(sessionStorage.getItem(storageKeys.entries)||'{}');
      const isServerRead = path==='/api/state/all' && !!request.signal;
      if (path==='/api/state/all') {
        if (!isServerRead) { record({kind:'library-read'});return Response.json({ok:true,entries}); }
        const reads=Number(sessionStorage.getItem(storageKeys.serverReads)||'0')+1;
        sessionStorage.setItem(storageKeys.serverReads,String(reads));
        const target=new URLSearchParams(location.search).get('t');
        record({kind:'document-read',target,read:reads});
        if (config.holdFirstServerRead && reads===1) return new Promise(resolve=>{
          const pending=window.__pendingBootReads || (window.__pendingBootReads=[]);
          pending.push(()=>resolve(Response.json({ok:true,entries:JSON.parse(sessionStorage.getItem(storageKeys.entries)||'{}')})));
        });
        if (config.failureMode==='http' && reads===1) return Response.json({error:'synthetic read failure'},{status:503});
        if (config.failureMode==='invalid' && reads===1) return Response.json({ok:true,entries:[]});
        let responseEntries=JSON.parse(sessionStorage.getItem(storageKeys.entries)||'{}');
        if (config.targetFixtureMissing && target===fixtureSlug) { responseEntries={...responseEntries};delete responseEntries[fixtureKey]; }
        return Response.json({ok:true,entries:responseEntries});
      }
      if (path==='/api/materials/parse') {
        record({kind:'parse',name:JSON.parse(request.body||'{}').name});
        if (config.parseFailure) return Response.json({error:'synthetic parse failure'},{status:422});
        return Response.json({ok:true,materials:[{name:'added-note.txt',text:'合成新增资料'}],skipped:[]});
      }
      if (path==='/api/state/put') {
        const payload=JSON.parse(request.body||'{}').entries||{};
        record({kind:'put',keys:Object.keys(payload)});
        if (config.saveFailure) return Response.json({error:'synthetic save conflict',code:'conflict'},{status:409});
        Object.assign(entries,payload);sessionStorage.setItem(storageKeys.entries,JSON.stringify(entries));
        return Response.json({ok:true});
      }
      if (path==='/api/path/intake') {
        const body=JSON.parse(request.body||'{}');record({kind:'intake',key:body.key,topic:body.topic});
        return Response.json({ok:true,question:'合成追问'});
      }
      record({kind:'unexpected'});
      return Response.json({error:'unexpected synthetic endpoint: '+path},{status:500});
    }};
    window.__releaseBootReads=()=>{const pending=window.__pendingBootReads||[];window.__pendingBootReads=[];pending.forEach(resolve=>resolve());return pending.length;};
    window.__probeCalls=()=>JSON.parse(sessionStorage.getItem(storageKeys.calls)||'[]');
    window.__probeEntries=()=>JSON.parse(sessionStorage.getItem(storageKeys.entries)||'{}');
    window.__setProbeEntries=value=>sessionStorage.setItem(storageKeys.entries,JSON.stringify(value));
    window.__settings=config;
    window.__fixtureKey=fixtureKey;window.__otherKey=otherKey;
  },{seed:seedEntries(),config,storageKeys,fixtureKey,otherKey});
  return {page,pageErrors};
}

async function waitBoot(page,state) {
  await page.waitForFunction(expected=>window.LearnPathApp && window.LearnPathApp.get('path.model').session.bootState===expected,state);
}
async function waitForHeldRead(page) {
  try { await page.waitForFunction(()=>window.__pendingBootReads && window.__pendingBootReads.length>0,null,{timeout:5000}); }
  catch (error) { const state=await page.evaluate(()=>({calls:window.__probeCalls(),bootState:window.LearnPathApp?.get('path.model').session.bootState,ready:!!window.LearnPathApp}));throw new Error(error.message+'; probe='+JSON.stringify(state)); }
}
async function releaseHeldReads(page) { return page.evaluate(()=>window.__releaseBootReads()); }
async function calls(page) { return page.evaluate(()=>window.__probeCalls()); }
async function currentEntries(page) { return page.evaluate(()=>window.__probeEntries()); }
async function waitReady(page) { await waitBoot(page,'ready'); }
async function assertLocked(page,label) {
  assert.equal(await page.locator('#chat-send').isDisabled(),true,label+': send disabled');
  assert.equal(await page.locator('#learning-materials input').isDisabled(),true,label+': upload disabled');
  assert.match(await page.locator('#chat-send').innerText(),/正在读取|读取失败/);
}
async function prepareHeldPage(browser,width) {
  const {page,pageErrors}=await makePage(browser,{width,holdFirstServerRead:true});
  await page.goto(`http://fixture.invalid/learn/u/u192probe/learning-path.html?t=${fixtureSlug}`);
  await waitForHeldRead(page);
  await waitBoot(page,'loading');
  return {page,pageErrors};
}
async function saveScreenshot(page,name) {
  fs.mkdirSync(output,{recursive:true});await page.screenshot({path:path.join(output,name),fullPage:true});
}

(async()=>{
  const executablePath=process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const browser=await chromium.launch({headless:true,executablePath});
  const report={mode:'generated-page-with-fixture.invalid-routes-and-memory-only-API',fixtureKey,viewportCases:[],checks:{},failures:{},reload:{},staleResponse:{},readOnly:{},fresh:{},pageErrors:[]};
  try {
    for (const width of [1440,390]) {
      const {page,pageErrors}=await prepareHeldPage(browser,width);
      await assertLocked(page,'initial read '+width);
      assert.equal(await page.locator('.materials-list button').count(),0,'unloaded materials are not rendered before restore');
      await page.locator('#chat-input').fill('保留的合成问题');
      await page.evaluate(()=>window.LearnPathApp.get('path.workflow').sendMessage());
      assert.equal(await page.locator('#chat-input').inputValue(),'保留的合成问题','loading guard retains typed input');
      assert.equal((await calls(page)).some(call=>call.kind==='intake'),false,'manual workflow dispatch cannot call intake while loading');
      // The real panel is empty until hydration. Seed a synthetic stale row so
      // the remove callback itself is exercised while its boot lock is held.
      const removeDisabled=await page.evaluate(()=>{
        const model=window.LearnPathApp.get('path.model');
        model.state.materials=[{name:'synthetic-stale-row.txt',text:'synthetic stale row'}];
        model.session.materialsPanel.render();
        const remove=document.querySelector('.materials-list button');
        const disabled=remove.disabled;
        remove.onclick();
        return disabled;
      });
      assert.equal(removeDisabled,true,'remove control is locked while initial restore is pending');
      assert.equal((await calls(page)).some(call=>call.kind==='put'),false,'manual remove callback cannot write while loading');
      const input=page.locator('#learning-materials input');
      await input.evaluate(element=>{element.disabled=false;});
      await input.setInputFiles({name:'manual-early.txt',mimeType:'text/plain',buffer:Buffer.from('synthetic')});
      await page.waitForTimeout(80);
      assert.equal((await calls(page)).some(call=>call.kind==='parse'),false,'manually dispatched upload change cannot parse while loading');
      assert.equal((await calls(page)).some(call=>call.kind==='put'),false,'early actions cannot write a temporary key');
      if (width===1440) await saveScreenshot(page,'learn-192-boot-fixed-loading-desktop.png');
      await releaseHeldReads(page);await waitReady(page);
      assert.equal(await page.locator('#chat-input').inputValue(),'保留的合成问题','successful restore preserves typed text for explicit send');
      assert.equal(await page.locator('.materials-list li').count(),1,'fixture material appears after restore');
      await page.locator('#chat-send').click();
      await page.waitForFunction(()=>window.__probeCalls().some(call=>call.kind==='intake'));
      const intake=(await calls(page)).find(call=>call.kind==='intake');
      assert.equal(intake.key,fixtureKey,'send after readiness targets fixture key');
      assert.equal(intake.topic,'topic192','send after readiness retains fixture topic');
      report.viewportCases.push({width,lockedDuringRead:true,programmaticSendBlocked:true,programmaticUploadBlocked:true,programmaticRemoveBlocked:true,fixtureRecovered:true,sendUsesFixtureKey:true,noOverflow:await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)});
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,'layout fits '+width);
      if (width===390) await saveScreenshot(page,'learn-192-boot-fixed-ready-mobile.png');
      report.pageErrors.push(...pageErrors);
      await page.close();
    }
    report.checks.slowReadGatesAllWrites=report.viewportCases.every(c=>c.lockedDuringRead&&c.programmaticSendBlocked&&c.programmaticUploadBlocked&&c.programmaticRemoveBlocked);

    // Full success path: load fixture, upload, send, then reload from saved memory state.
    {
      const {page,pageErrors}=await makePage(browser);
      await page.goto(`http://fixture.invalid/learn/u/u192probe/learning-path.html?t=${fixtureSlug}`);await waitReady(page);
      await page.locator('#learning-materials input').setInputFiles({name:'added-note.txt',mimeType:'text/plain',buffer:Buffer.from('synthetic added file')});
      await page.getByText(/已保存 1 份资料/).waitFor();
      const afterUpload=await currentEntries(page),uploaded=JSON.parse(afterUpload[fixtureKey]);
      assert.equal(uploaded.materials.length,2);assert(uploaded.materials.some(material=>material.name==='original-note.txt'));assert(uploaded.materials.some(material=>material.name==='added-note.txt'));
      assert.equal(afterUpload['u192probe/learn-path-v1-last'],fixtureSlug);
      assert.equal((await calls(page)).filter(call=>call.kind==='put').every(call=>call.keys.includes(fixtureKey)),true,'upload saves only on fixture key');
      await page.locator('#chat-input').fill('围绕原始 topic192 的合成追问');await page.locator('#chat-send').click();
      await page.waitForFunction(()=>window.__probeCalls().some(call=>call.kind==='intake'));
      const intake=(await calls(page)).filter(call=>call.kind==='intake').at(-1);
      assert.equal(intake.key,fixtureKey);assert.equal(intake.topic,'topic192');
      await page.waitForFunction(()=>window.__probeEntries()[window.__fixtureKey] && JSON.parse(window.__probeEntries()[window.__fixtureKey]).history.some(item=>item.content==='围绕原始 topic192 的合成追问'));
      await page.reload();await waitReady(page);
      const reloaded=JSON.parse((await currentEntries(page))[fixtureKey]);
      assert.equal(reloaded.materials.length,2);assert(reloaded.history.some(item=>item.content==='围绕原始 topic192 的合成追问'));
      assert.equal(await page.locator('.materials-list li').count(),2);
      report.reload={uploadAndSendBoundToFixture:true,bothSurviveReload:true,fixtureSlugRetained:true};
      report.pageErrors.push(...pageErrors);await page.close();
    }

    // Load errors stay locked. Retrying uses the current URL and the same controls.
    for (const failureMode of ['http','invalid','missing','empty-t']) {
      const {page,pageErrors}=await makePage(browser,{failureMode:failureMode==='empty-t'?null:failureMode,targetFixtureMissing:failureMode==='missing'});
      const target=failureMode==='empty-t'?'':fixtureSlug;
      await page.goto(`http://fixture.invalid/learn/u/u192probe/learning-path.html?t=${encodeURIComponent(target)}`);
      if (failureMode==='empty-t') await waitBoot(page,'error');
      else await waitBoot(page,'error');
      await assertLocked(page,'failed read '+failureMode);
      assert(await page.locator('#errretry').isVisible(),failureMode+': retry is visible');
      const currentInput=page.locator('#learning-materials input');await currentInput.evaluate(element=>{element.disabled=false;});
      await currentInput.setInputFiles({name:'blocked.txt',mimeType:'text/plain',buffer:Buffer.from('synthetic')});
      await page.evaluate(()=>window.LearnPathApp.get('path.workflow').sendMessage());
      assert.equal((await calls(page)).some(call=>call.kind==='parse'||call.kind==='intake'),false,failureMode+': error state remains write locked');
      if (failureMode==='empty-t') await page.evaluate(slug=>history.replaceState({},'',`?t=${slug}`),fixtureSlug);
      if (failureMode==='missing') await page.evaluate(({fixtureKey,fixture})=>{const entries=window.__probeEntries();entries[fixtureKey]=JSON.stringify(fixture);window.__setProbeEntries(entries);window.__settings.targetFixtureMissing=false;},{fixtureKey,fixture});
      if (failureMode==='http'||failureMode==='invalid') await page.evaluate(()=>{window.__settings.failureMode=null;});
      await page.locator('#errretry').click();await waitReady(page);
      assert.equal(await page.locator('#errbar').isHidden(),true,failureMode+': successful retry clears error');
      assert.equal(await page.locator('#learning-materials input').isDisabled(),false,failureMode+': successful retry enables upload');
      assert.equal((await calls(page)).some(call=>call.kind==='put'),false,failureMode+': blocked input did not write');
      report.failures[failureMode]={staysLockedBeforeRetry:true,retryRecovers:true};
      report.pageErrors.push(...pageErrors);await page.close();
    }

    // Fresh routes without t and with ?new=1 can start once their local no-load decision completes.
    for (const query of ['', '?new=1']) {
      const {page,pageErrors}=await makePage(browser);
      await page.goto('http://fixture.invalid/learn/u/u192probe/learning-path.html'+query);await waitReady(page);
      assert.equal((await calls(page)).some(call=>call.kind==='document-read'),false,'fresh route skips document restore '+query);
      await page.locator('#chat-input').fill('合成的新主题');await page.locator('#chat-send').click();
      await page.waitForFunction(()=>window.__probeCalls().some(call=>call.kind==='intake'));
      const intake=(await calls(page)).find(call=>call.kind==='intake');
      assert(intake.key.startsWith('u192probe/learn-path-v1-'));assert.notEqual(intake.key,fixtureKey);
      report.fresh[query||'no-query']={readyWithoutRestore:true,firstSendCreatesNewDocument:true};
      report.pageErrors.push(...pageErrors);await page.close();
    }

    // Read-only state is guarded even when handlers are invoked directly.
    {
      const {page,pageErrors}=await makePage(browser,{readOnly:true});
      await page.goto(`http://fixture.invalid/learn/u/u192probe/learning-path.html?t=${fixtureSlug}`);await waitReady(page);
      assert.equal(await page.locator('#chat-send').isDisabled(),true);assert.equal(await page.locator('#learning-materials input').isDisabled(),true);
      await page.locator('#chat-input').fill('只读合成输入');await page.evaluate(()=>window.LearnPathApp.get('path.workflow').sendMessage());
      const input=page.locator('#learning-materials input');await input.evaluate(element=>{element.disabled=false;});
      await input.setInputFiles({name:'readonly.txt',mimeType:'text/plain',buffer:Buffer.from('synthetic')});
      assert.equal((await calls(page)).some(call=>call.kind==='intake'||call.kind==='parse'||call.kind==='put'),false);
      report.readOnly={sendUploadAndPutBlocked:true};report.pageErrors.push(...pageErrors);await page.close();
    }

    // Existing material survives parse and save failures; save conflict keeps the parsed additions visible.
    for (const failure of ['parse','save']) {
      const {page,pageErrors}=await makePage(browser,{parseFailure:failure==='parse',saveFailure:failure==='save'});
      await page.goto(`http://fixture.invalid/learn/u/u192probe/learning-path.html?t=${fixtureSlug}`);await waitReady(page);
      await page.locator('#learning-materials input').setInputFiles({name:'added-note.txt',mimeType:'text/plain',buffer:Buffer.from('synthetic added file')});
      await page.getByText(/上传未完成：/).waitFor();
      const list=await page.locator('.materials-list').innerText();assert(list.includes('original-note.txt'),failure+': original material remains');
      if (failure==='save') assert(list.includes('added-note.txt'), 'save failure retains parsed addition in the current view');
      assert.equal((await currentEntries(page))[fixtureKey],JSON.stringify(fixture),'failed operation does not replace acknowledged fixture');
      report.failures[failure]={originalMaterialRemains:true,fixtureServerRecordUnchanged:true,parsedAdditionRemainsVisible:failure==='save'};
      report.pageErrors.push(...pageErrors);await page.close();
    }

    // Exercise a late old response after a new URL/load has won.
    {
      const {page,pageErrors}=await makePage(browser,{holdFirstServerRead:true});
      await page.goto(`http://fixture.invalid/learn/u/u192probe/learning-path.html?t=${fixtureSlug}`);await waitForHeldRead(page);
      await page.evaluate(({otherSlug,otherKey,otherFixture})=>{
        const entries=window.__probeEntries();entries[otherKey]=JSON.stringify(otherFixture);window.__setProbeEntries(entries);
        history.replaceState({},'',`?t=${otherSlug}`);
      },{otherSlug,otherKey,otherFixture});
      await page.evaluate(()=>window.LearnPathApp.get('path.persistence').serverLoad());await waitReady(page);
      assert.equal(await page.evaluate(()=>window.LearnPathApp.get('path.model').state.topic),'topicOther');
      await releaseHeldReads(page);await page.waitForTimeout(30);
      assert.equal(await page.evaluate(()=>window.LearnPathApp.get('path.model').state.topic),'topicOther','late old read cannot overwrite newer identity');
      assert.equal(await page.evaluate(()=>window.LearnPathApp.get('path.model').session.materialSlug),otherSlug);
      report.staleResponse={newerIdentityWins:true,lateOldResponseIgnored:true};report.pageErrors.push(...pageErrors);await page.close();
    }

    assert.deepEqual(report.pageErrors,[],'no browser page errors');
    report.checks.desktopAndMobile=report.viewportCases.map(item=>item.width).join(',')==='1440,390';
    report.checks.successfulUploadSendReload=report.reload.bothSurviveReload===true;
    report.checks.errorRetry=Object.values(report.failures).filter(value=>value.retryRecovers!==undefined).length===4;
    report.checks.noPageErrors=report.pageErrors.length===0;
    fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,'learn-192-boot-fixed-report.json'),JSON.stringify(report,null,2));
    console.log(JSON.stringify(report,null,2));
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
