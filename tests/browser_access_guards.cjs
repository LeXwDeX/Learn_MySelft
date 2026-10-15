/* Real generated UI in Chromium; memory-only API fixtures, no credentials or model calls. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const key = 'u0/learn-path-v1-access-fixture';
const learning = {title:'访问确认回归', topic:'访问确认回归', stage:'learning', spec:{topic:'访问确认回归'}, history:[],
  plan:{nodes:[{id:'n1',title:'第一单元',deps:[]},{id:'n2',title:'第二单元',deps:[]}]},
  nodeState:{}, nodeAccess:{}, nodeDetail:{n1:{study_notes:'第一单元缓存正文'},n2:{study_notes:'第二单元缓存正文'}}};

(async () => {
  const browser = await chromium.launch({headless:true, executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH});
  const report = {mode:'local-generated-assets-with-memory-api', cases:[], errors:[]};
  try {
    for (const width of [1440,390]) {
      const page = await browser.newPage({viewport:{width,height:900}});
      page.on('pageerror', error=>report.errors.push(error.message));
      await page.route('**/*', route=>{
        const url = new URL(route.request().url()); let file;
        if(url.pathname.endsWith('/learning-path.html'))file=path.join(root,'learning-path/learning-path.html');
        else if(url.pathname.startsWith('/diagram-design/learning-path/'))file=path.join(root,'learning-path',path.basename(url.pathname));
        else if(url.pathname.startsWith('/learn/assets/')){
          const name=path.basename(url.pathname);
          if(!['user-shell.js','user-session.js','saves.js','job-details.js','jobs.js'].includes(name))file=path.join(root,'shared',name);
        }
        return route.fulfill({contentType:url.pathname.endsWith('.html')?'text/html':url.pathname.endsWith('.css')?'text/css':'application/javascript',body:file&&fs.existsSync(file)?fs.readFileSync(file):''});
      });
      await page.addInitScript(({learning,key})=>{
        const entries={[key]:JSON.stringify(learning),'u0/learn-path-v1-last':'access-fixture'};
        window.__accessRequests=[];window.__requests=[];
        window.__finishAccess=(access={},status=200)=>{
          const request=window.__accessRequests.shift();
          if(!request)throw Error('No pending access request');
          request.resolve(new Response(JSON.stringify({ok:status===200,key,revision:1,plan:{nodes:[{id:'n1'},{id:'n2'}]},nodeAccess:access,nodeState:{n1:{completed:false},n2:{completed:false}}}),{status}));
        };
        window.LearnJobs={supports:()=>false,list:async()=>[],requestId:()=> 'access-fixture-request'};
        window.LearnUser={userId:'u0',apiBase:'/api',readOnly:false,ready:Promise.resolve(),fetch:(url,options={})=>{
          window.__requests.push(url);
          if(url.includes('/state/access?'))return new Promise((resolve,reject)=>{
            window.__accessRequests.push({resolve,reject});
            options.signal?.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError')),{once:true});
          });
          if(url.endsWith('/state/put'))return Promise.resolve(Response.json({ok:true}));
          if(url.endsWith('/state/all'))return Promise.resolve(Response.json({ok:true,entries}));
          return Promise.reject(Error('Unexpected API request: '+url));
        }};
      },{learning,key});
      await page.goto('http://fixture.invalid/learn/u/u0/learning-path.html?t=access-fixture');
      await page.waitForFunction(()=>window.__accessRequests.length===1);
      assert.equal(await page.getByText('第一单元缓存正文',{exact:true}).count(),0);
      await page.getByText('正在确认单元访问状态…',{exact:true}).waitFor();
      assert(await page.locator('.workspace-ai').isDisabled());
      await page.evaluate(()=>window.__finishAccess());
      await page.getByText('第一单元缓存正文',{exact:true}).waitFor();
      const allReads=await page.evaluate(()=>window.__requests.filter(url=>url.endsWith('/state/all')).length);

      async function select(title) {
        await page.locator('#path-open').click();
        await page.locator('.workspace-path-unit').filter({hasText:title}).click();
      }
      await select('第二单元');
      await page.waitForFunction(()=>window.__accessRequests.length===1);
      assert.equal(await page.getByText('第二单元缓存正文',{exact:true}).count(),0);
      assert.equal(await page.getByText('第一单元缓存正文',{exact:true}).count(),0);
      assert(await page.locator('.workspace-ai').isDisabled());
      if(process.env.ACCESS_QA_OUTPUT){fs.mkdirSync(process.env.ACCESS_QA_OUTPUT,{recursive:true});await page.screenshot({path:path.join(process.env.ACCESS_QA_OUTPUT,'pending-'+width+'.png'),fullPage:true});}
      await page.evaluate(()=>window.__finishAccess({n2:'locked'}));
      await page.getByRole('heading',{name:'此单元已手动锁定'}).waitFor();
      assert.equal(await page.getByText('第二单元缓存正文',{exact:true}).count(),0);
      assert(await page.locator('.workspace-ai').isDisabled());

      await select('第二单元');
      await select('第一单元');
      await select('第二单元');
      assert.equal(await page.evaluate(()=>window.__accessRequests.length),1,'rapid selections share a single document snapshot');
      await page.evaluate(()=>window.__finishAccess());
      await page.getByText('第二单元缓存正文',{exact:true}).waitFor();
      assert.equal(await page.getByText('第一单元缓存正文',{exact:true}).count(),0);

      await select('第一单元');
      await page.locator('#path-open').click();
      await page.locator('#workspace-goal').click();
      await page.evaluate(()=>window.__finishAccess());
      assert.equal(await page.locator('body').evaluate(el=>el.classList.contains('workspace-reading')),false,'late selection must not undo navigation');
      await page.locator('.stab[data-stage="learning"]').click();
      await page.waitForFunction(()=>window.__accessRequests.length===1);
      await page.evaluate(()=>window.__finishAccess({},503));
      await page.getByRole('heading',{name:'暂时无法确认单元访问状态'}).waitFor();
      assert.equal(await page.getByText('第一单元缓存正文',{exact:true}).count(),0);
      await page.getByRole('button',{name:'重新确认访问状态'}).click();
      await page.evaluate(()=>window.__finishAccess());
      await page.getByText('第一单元缓存正文',{exact:true}).waitFor();
      assert(await page.locator('#errbar').evaluate(el=>el.hidden),'successful access retry clears its obsolete error');
      assert.equal(await page.evaluate(()=>window.__requests.filter(url=>url.endsWith('/state/all')).length),allReads,'guarded actions never download the whole library');
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'layout fits viewport');
      if(process.env.ACCESS_QA_OUTPUT)await page.screenshot({path:path.join(process.env.ACCESS_QA_OUTPUT,'recovered-'+width+'.png'),fullPage:true});
      report.cases.push({width,checks:['initial_confirmation','pending_hides_cached_body','server_lock','rapid_selection','navigation_cancellation','failure_retry','key_scoped_reads','viewport']});
      await page.close();
    }
    assert.deepEqual(report.errors,[]);
    if(process.env.ACCESS_QA_OUTPUT)fs.writeFileSync(path.join(process.env.ACCESS_QA_OUTPUT,'report.json'),JSON.stringify(report,null,2));
    console.log(JSON.stringify(report));
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
