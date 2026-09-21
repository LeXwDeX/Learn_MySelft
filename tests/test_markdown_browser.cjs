'use strict';
// Real renderer integration. Set PLAYWRIGHT_MODULE if Playwright is not on NODE_PATH.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const fixture='<!doctype html><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/learn/assets/markdown.css"><script src="/learn/assets/vendor-markdown-it.js"></script><script src="/learn/assets/markdown.js"></script><main id="content"></main><main id="other"></main>';
const graph='先检查条件，再检查结论。\n\n```mermaid\nflowchart TD\n A["条件"] --> B["结论"]\n```';
(async()=>{
 const server=http.createServer((req,res)=>{
  if(req.url==='/'){res.setHeader('Content-Type','text/html;charset=utf-8');return res.end(fixture)}
  const file=path.join(root,'shared',path.basename(req.url));
  if(!fs.existsSync(file)){res.statusCode=404;return res.end()}
  res.setHeader('Content-Type',file.endsWith('.css')?'text/css':'application/javascript');res.end(fs.readFileSync(file));
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch({headless:true});
 try{
 for(const width of [1440,390]){
  const page=await browser.newPage({viewport:{width,height:900}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:'+server.address().port);
  async function render(source,streaming=false){await page.evaluate(async args=>{const el=document.querySelector('#content');el.innerHTML=LearnMarkdown.render(args.source,{streaming:args.streaming});await LearnMarkdown.enhance(el)}, {source,streaming})}
  await page.evaluate(async source=>{content.innerHTML='<div hidden>'+LearnMarkdown.render(source)+'</div>';await LearnMarkdown.enhance(content)},graph);
  assert.equal(await page.locator('figure img').count(),0);assert.equal(await page.locator('[data-diagram=pending]').count(),1);
  await page.evaluate(async()=>{content.firstElementChild.hidden=false;await LearnMarkdown.enhance(content)});assert.equal(await page.locator('[data-diagram=ready]').count(),1);
  await render(graph,true);assert.equal(await page.locator('[data-diagram=waiting]').count(),1);assert.equal(await page.locator('figure img').count(),0);
  await render(graph);await page.locator('[data-diagram=ready] img').waitFor();assert(await page.locator('figure img').evaluate(i=>i.complete&&i.naturalWidth>0));
  await page.getByRole('button',{name:'放大查看'}).click();assert(await page.locator('dialog').isVisible());await page.getByRole('button',{name:'放大',exact:true}).click();await page.getByRole('button',{name:'关闭',exact:true}).click();await page.locator('dialog').waitFor({state:'detached'});
  await page.evaluate(source=>LearnMarkdown.exportButton(document.querySelector('#content'),source,'讲解.md'),graph);
  const downloadPromise=page.waitForEvent('download');await page.getByRole('button',{name:'导出 Markdown'}).click();const download=await downloadPromise;assert.equal(fs.readFileSync(await download.path(),'utf8'),graph);
  await render('```mermaid\nflowchart TD\n A["bad\n```\n\n正文仍然可读');assert.equal(await page.locator('[data-diagram=failed]').count(),1);assert.match(await page.locator('#content').innerText(),/正文仍然可读/);
  await render(graph.slice(0,-3));assert.equal(await page.locator('[data-diagram=failed]').count(),1);
  await render('```mermaid\nflowchart TD\n A-->B\n click A "javascript:alert(1)"\n```');assert.equal(await page.locator('[data-diagram=failed]').count(),1);
  await render('```mermaid\nsequenceDiagram\n participant A as 学生\n participant B as 老师\n A->>B: 提问\n B-->>A: 提示\n```');assert.equal(await page.locator('[data-diagram=ready]').count(),1);
  await page.evaluate(async source=>{const el=document.querySelector('#content');el.innerHTML=LearnMarkdown.render(source);const work=LearnMarkdown.enhance(el);el.textContent='新视图';await work},graph);assert.equal(await page.locator('#content').innerText(),'新视图');
  await render(graph+'\n\n|概念|说明|\n|---|---|\n|加法|合并|');assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));assert.deepEqual(errors,[]);
  console.log(JSON.stringify({width,status:'passed',cases:['stream','real flowchart/sequence','bad syntax','unsafe diagram','zoom','MD export','detached view','mobile width']}));await page.close();
 }
 // Dependency failure must preserve the surrounding text and source.
 const page=await browser.newPage();await page.route('**/vendor-mermaid.js',r=>r.abort());await page.goto('http://127.0.0.1:'+server.address().port);await page.evaluate(async source=>{content.innerHTML=LearnMarkdown.render(source);await LearnMarkdown.enhance(content)},graph);assert.equal(await page.locator('[data-diagram=failed]').count(),1);assert.match(await page.locator('#content').innerText(),/条件/);await page.close();
 }finally{await browser.close();await new Promise(r=>server.close(r))}
})().catch(e=>{console.error(e);process.exitCode=1});
