/* Exercise both generated pages with isolated in-memory quiz storage. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const questions = [
  {id:'q1', type:'choice', q:'选择 2', options:['1','2'], answer:'B', points:50},
  {id:'q2', type:'fill', q:'填写 ____。', answer:'2', points:50,
    blanks:[{id:'b1',points:50,answer:'2',match:'text'}], scoring:{mode:'per_blank'}}
];
const issued = {id:'fixture-round', questions, attempts:[], draft:null};
const quiz = {title:'模块回归测验',round_id:issued.id,questions,rounds:[issued],sourceSlug:'module-fixture',sourceKey:'u0/learn-path-v1-module-fixture'};
const scene = {version:1,type:'linear_transform',title:'列向量',summary:'观察标准基底如何变换。',matrix:[[2,1],[1,2]]};
const learning = {title:'模块回归学习',topic:'基础计算',stage:'learning',plan:{title:'基础计算',nodes:[{id:'n1',title:'基础单元',deps:[]}]},
  nodeDetail:{n1:{study_notes:'学习正文\n\n```learn-scene\n'+JSON.stringify(scene)+'\n```',quiz}},
  nodeState:{n1:{lastResult:{round_id:issued.id,score:80,pass:true}}}};
(async () => {
  const browser = await chromium.launch({headless:true, executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH});
  const page = await browser.newPage({viewport:{width:1440,height:1000}});
  const errors=[]; page.on('pageerror', error=>errors.push(error.message));
  await page.route('**/*', route => {
    const url=new URL(route.request().url()); let file=null;
    if (/\/(learning-path|quiz-map)\.html$/.test(url.pathname)) file=path.join(root,'learning-path',path.basename(url.pathname));
    if (url.pathname.startsWith('/diagram-design/learning-path/')) file=path.join(root,'learning-path',path.basename(url.pathname));
    if (url.pathname.startsWith('/learn/assets/')) {
      const relative=url.pathname.slice('/learn/assets/'.length);
      if (relative.endsWith('.css') || ['ui.js','titles.js','materials.js','learning-scenes.js','markdown.js','vendor-markdown-it.js'].includes(relative)) file=path.join(root,'shared',relative);
    }
    return route.fulfill({contentType:url.pathname.endsWith('.html')?'text/html':url.pathname.endsWith('.css')?'text/css':'application/javascript',body:file&&fs.existsSync(file)?fs.readFileSync(file,'utf8'):''});
  });
  await page.addInitScript(({learning,quiz})=>{
    const entries={'u0/learn-path-v1-module-fixture':JSON.stringify(learning),'u0/quiz-map-v1-module-fixture':JSON.stringify(quiz)};
    window.__fixtureQuiz=quiz;window.__fixtureWrites=[];
    window.LearnJobs={supports:()=>false,list:async()=>[],requestId:()=> 'module-fixture'};
    window.LearnUser={userId:'u0',apiBase:'/api',readOnly:false,ready:Promise.resolve(),fetch:async(url,options)=>{
      const body=options&&options.body?JSON.parse(options.body):{};
      if(url.endsWith('/path/quiz/state'))return new Response(JSON.stringify(quiz));
      if(url.endsWith('/path/quiz/draft')){
        window.__fixtureWrites.push(body);const round=quiz.rounds.find(r=>r.id===body.round_id);round.draft={answers:body.answers};
        return new Response(JSON.stringify({draft:round.draft}));
      }
      if(url.endsWith('/state/put'))Object.assign(entries,body.entries);
      return new Response(JSON.stringify({ok:true,entries}));
    }};
  },{learning,quiz});
  try{
    for(const kind of ['learning-path','quiz-map']){
      await page.goto('http://fixture.invalid/learn/u/u0/'+kind+'.html?t=module-fixture');
      if(kind==='learning-path'){
        await page.locator('#node-n1 .node-head').click();
        assert(await page.locator('#node-n1 .mat-pane-material').evaluate(el=>el.hidden), 'existing result initially opens the quiz tab');
        assert.equal(await page.locator('#node-n1 [data-scene="pending"]').count(),1);
        assert.equal(await page.locator('#node-n1 .learn-scene').count(),0,'hidden lesson does not mount a scene');
        await page.locator('#node-n1 [data-mat="material"]').click();
        await page.locator('#node-n1 [data-scene="ready"]').waitFor();
        assert.equal(await page.locator('#node-n1 .learn-scene').count(),1,'switching from quiz mounts the previously hidden lesson');
        await page.locator('#node-n1 [data-mat="material"]').click();
        assert.equal(await page.locator('#node-n1 .learn-scene').count(),1,'repeated lesson selection does not duplicate its scene');
        await page.locator('#node-n1 [data-mat="quiz"]').click();
      }
      await page.getByRole('button',{name:'打开测验',exact:true}).click();
      await page.locator('#qd-answer-1-blank-0').waitFor();
      assert.equal(await page.locator('.qd-question').count(),2);
      assert.equal(await page.locator('.qd-option').count(),2);
      await page.locator('[name="qd-answer-0"][value="B"]').check();
      await page.locator('#qd-answer-1-blank-0').fill('2');
      await page.waitForFunction(()=>window.__fixtureWrites.length>0);
      await page.locator('#qd-close').click();
      await page.getByRole('button',{name:'打开测验',exact:true}).click();
      await page.locator('#qd-answer-1-blank-0').waitFor();
      assert.equal(await page.locator('#qd-answer-1-blank-0').inputValue(),'2');
      assert(await page.locator('[name="qd-answer-0"][value="B"]').isChecked());
      for(const width of [1440,390]){
        await page.setViewportSize({width,height:844});
        assert(await page.locator('#quiz-workspace').evaluate(el=>el.scrollWidth<=el.clientWidth));
        assert(await page.locator('#qd-body').evaluate(el=>el.scrollWidth<=el.clientWidth));
      }
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('#quiz-workspace').evaluate(el=>el.open),false);
      await page.setViewportSize({width:1440,height:1000});
    }
    await page.goto('http://fixture.invalid/learn/u/u0/quiz-map.html');
    await page.getByRole('button',{name:'生成测验',exact:true}).waitFor();
    assert.equal(await page.locator('.lrow').count(),2,'catalog includes learning source and saved exam');
    assert.deepEqual(errors,[]);
    console.log('PASS generated pages, existing result quiz-to-lesson scene reveal, modal drafts, Escape, catalog and 1440/390 geometry');
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
