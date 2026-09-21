'use strict';
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),katex=process.env.KATEX_DIR;
const html='<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/learn/assets/markdown.css"><link rel="stylesheet" href="/diagram-design/learning-path/katex/katex.min.css"><script src="/learn/assets/vendor-markdown-it.js"></script><script src="/diagram-design/learning-path/katex/katex.min.js"></script><script src="/learn/assets/markdown.js"></script><main id="content"></main>';
(async()=>{
 let server,base=process.env.BASE_URL;
 if(!base){assert(katex,'KATEX_DIR is required for local tests');server=http.createServer((req,res)=>{
  if(req.url==='/fixture'){res.setHeader('Content-Type','text/html;charset=utf-8');return res.end(html)}
  const font=req.url.startsWith('/diagram-design/learning-path/katex/');
  const file=font?path.join(katex,req.url.split('/katex/')[1]):path.join(root,'shared',path.basename(req.url));
  if(!fs.existsSync(file)){res.statusCode=404;return res.end()}
  res.setHeader('Content-Type',file.endsWith('.css')?'text/css':file.endsWith('.js')?'application/javascript':'font/woff2');res.end(fs.readFileSync(file));
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+server.address().port;}
 const browser=await chromium.launch({headless:true});
 try{
 for(const width of [1440,390]){
  const page=await browser.newPage({viewport:{width,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  if(server)await page.goto(base+'/fixture');
  else {await page.goto(base+'/learn/');await page.setContent(html,{waitUntil:'load'});}
  async function render(text){await page.evaluate(async text=>{content.innerHTML=LearnMarkdown.render(text);await LearnMarkdown.enhance(content)},text)}
  await render('公式 $2^3$，$\\frac{a+b}{c+d}$，$p\\to q$，$x_{12}$。\n\n|p|q|\n|---|---|\n|$p$|$q$|\n\n定义[^1]。\n\n[^1]: **补充**解释。\n\n> [!WARNING]\n> 注意括号。');
  const copied=await page.evaluate(()=>{
   const r=document.createRange();r.selectNodeContents(content.firstElementChild);const s=getSelection();s.removeAllRanges();s.addRange(r);
   const d=new DataTransfer(),e=new ClipboardEvent('copy',{clipboardData:d,bubbles:true,cancelable:true});document.dispatchEvent(e);s.removeAllRanges();return {text:d.getData('text/plain'),html:d.getData('text/html'),handled:e.defaultPrevented,mathml:content.querySelectorAll('.katex-mathml').length};
  });
  assert(copied.handled);assert.match(copied.text,/2³/);assert.match(copied.text,/\(a\+b\)\/\(c\+d\)/);assert.match(copied.text,/p→q/);assert.match(copied.text,/x₁₂/);assert.match(copied.text,/p\tq/);assert(!copied.text.includes('$'));assert(copied.html.includes('<sup>3</sup>'));assert(copied.mathml>=6);
  assert.match(await page.locator('#content').innerText(),/补充说明〔1〕/);assert.match(await page.locator('#content').innerText(),/易错提醒/);
  await render('前文 $\\unknown{x}$ 后文 $2+2=4$。');assert.equal(await page.locator('.md-math-fallback').count(),1);assert.equal(await page.locator('.katex').count(),1);
  await render('\\[x^2\\] 和 \\(p\\to q\\)');assert.equal(await page.locator('.katex').count(),2);
  // A complex structure outside the safe conversion vocabulary retains its full expression.
  await render('$\\sum_{i=1}^{n} i$');
  const sum=await page.evaluate(()=>{const r=document.createRange();r.selectNodeContents(content.firstElementChild);getSelection().removeAllRanges();getSelection().addRange(r);const d=new DataTransfer();document.dispatchEvent(new ClipboardEvent('copy',{clipboardData:d,bubbles:true,cancelable:true}));getSelection().removeAllRanges();return d.getData('text/plain')});assert.match(sum,/\\sum/);
  await render('$\\binom{n}{k}$ 和 $\\mathbf{x}$');
  const structural=await page.evaluate(()=>{const r=document.createRange();r.selectNodeContents(content.firstElementChild);getSelection().removeAllRanges();getSelection().addRange(r);const d=new DataTransfer();document.dispatchEvent(new ClipboardEvent('copy',{clipboardData:d,bubbles:true,cancelable:true}));getSelection().removeAllRanges();return d.getData('text/plain')});assert.match(structural,/\\binom/);assert.match(structural,/\\mathbf/);
  const md='## 完整正文\n\n$2^3$\n\n[^1]: 原文保留';await render(md);
  await page.evaluate(md=>LearnMarkdown.exportButton(content,md,LearnMarkdown.unitFilename('命题逻辑与有效推理',1,'命题、变元与复合命题')),md);
  const pending=page.waitForEvent('download');await page.getByRole('button',{name:'导出 Markdown'}).click();const file=await pending;assert.equal(file.suggestedFilename(),'命题逻辑与有效推理_L1_命题、变元与复合命题.md');assert.equal(fs.readFileSync(await file.path(),'utf8'),md);
  await page.route('**/vendor-mermaid.js',r=>r.abort());
  await render('先检查条件，再得出结论。\n\n```mermaid\nflowchart TD\n A["条件"] --> B["结论"]\n```');assert.match(await page.locator('.md-diagram-fallback').innerText(),/条件 → 结论/);
  await render('讲解仍保留。\n\n```mermaid\nflowchart TD\n A["broken\n```');assert.match(await page.locator('.md-diagram-fallback').innerText(),/请先阅读/);
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));assert.deepEqual(errors,[]);
  if(process.env.ARTIFACT_DIR){fs.mkdirSync(process.env.ARTIFACT_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.ARTIFACT_DIR,'fallback-'+width+'.png'),fullPage:true});}
  console.log(JSON.stringify({width,status:'passed',cases:['math copy plain/rich','notes','isolated invalid formula','slash delimiters','complex exact fallback','complete filename and source','diagram loader failure','invalid diagram','mobile width']}));await page.close();
 }
 const page=await browser.newPage();await page.route('**/katex.min.js',r=>r.abort());if(server)await page.goto(base+'/fixture');else {await page.goto(base+'/learn/');await page.setContent(html,{waitUntil:'load'});}await page.evaluate(()=>{content.innerHTML=LearnMarkdown.render('文字 $a+b$ 继续。')});assert.match(await page.locator('#content').innerText(),/a\+b/);assert.equal(await page.locator('.md-math-fallback').count(),1);await page.close();
 }finally{await browser.close();if(server)await new Promise(r=>server.close(r))}
})().catch(e=>{console.error(e);process.exitCode=1});
