/* Deployed regression_bot only. Credentials stay in memory; no traces/headers logged. */
'use strict';
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const {execFileSync} = require('node:child_process');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const env = process.env.MATERIAL_ENV || 'test';
assert(['test', 'production'].includes(env));
const root = 'http://192.168.33.146:' + (env === 'test' ? '8112' : '8100');
const api = 'http://192.168.33.146:' + (env === 'test' ? '8111' : '8101');
const output = process.env.MATERIAL_OUTPUT || '/tmp/material-browser-' + env;
fs.mkdirSync(output, {recursive:true});
const credentials = JSON.parse(execFileSync('ssh', ['root@192.168.33.146', 'cat /opt/study-assistant/regression-credentials/' + env + '.json'], {encoding:'utf8'}));
const lesson = `星桥分拣协议（回归专用原创资料）
1. 入库标记：蓝色表示待复核，绿色表示已确认；不使用红色标记。
2. 编码规则：每箱编号由前缀 XQ、两位批次号、三位流水号构成。
3. 封箱规则：每箱固定装七个样本，不足七个进入等待区。
4. 复核规则：必须由两名不同人员核对编号，不能由同一人签两次。
5. 转运规则：只有绿色标记的箱子才能转运，蓝色必须先复核。
6. 交接规则：记录交接时间、交出人和接收人三个字段。
7. 退回规则：编号错误退回编码台，不足数量退回等待区。
8. 日终统计：统计绿色箱数乘以七得到已确认样本数。`;
(async () => {
  const browser = await chromium.launch({headless:true});
  const context = await browser.newContext({viewport:{width:1440,height:1000}});
  const page = await context.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const report = {environment:env, cases:[]};
  try {
    const login = await context.request.post(api + '/auth/login', {data:{username:'regression_bot',password:credentials.password}});
    assert.equal(login.status(),200,'regression login');
    const user=(await login.json()).user;
    const base=root+'/learn/u/'+user.id+'/';
    await page.goto(base+'learning-path.html?new=1');
    await page.locator('#learning-materials input').waitFor();
    await page.locator('#learning-materials input').setInputFiles({name:'星桥协议-'+env+'.txt',mimeType:'text/plain',buffer:Buffer.from(lesson)});
    await page.getByText('解析完成，资料已保存，将用于生成地图和测验。',{exact:true}).waitFor({timeout:120000});
    assert.equal(await page.locator('.materials-list li').count(),1);
    const sourceURL=page.url();
    await page.reload();await page.locator('.materials-list li').waitFor();
    assert((await page.locator('.materials-list').innerText()).includes('星桥协议'));
    report.cases.push('text_upload_and_reload');
    await page.locator('#learning-materials input').setInputFiles({name:'refused.exe',mimeType:'application/octet-stream',buffer:Buffer.from('MZ')});
    await page.getByText(/上传未完成：不支持的文件格式/).waitFor();
    report.cases.push('unsupported_file_feedback');
    await page.locator('#learning-materials input').setInputFiles({name:'remove-me.txt',mimeType:'text/plain',buffer:Buffer.from('待移除的附加笔记')});
    await page.getByText('解析完成，资料已保存，将用于生成地图和测验。',{exact:true}).waitFor();
    await page.getByRole('button',{name:'移除 remove-me.txt',exact:true}).click();
    await page.getByText('已移除并保存',{exact:true}).waitFor();
    await page.reload();await page.locator('.materials-list li').waitFor();assert.equal(await page.locator('.materials-list li').count(),1);
    for (const width of [1440,390]) {
      await page.setViewportSize({width,height:900});
      assert(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth+1),'no horizontal overflow');
      await page.screenshot({path:output+'/upload-'+width+'.png',fullPage:true});
    }
    report.cases.push('remove_persists_and_responsive_upload');
    await page.setViewportSize({width:1440,height:1000});
    // Complete known intake answers to exercise the real, persisted background pipeline.
    const slug=new URL(sourceURL).searchParams.get('t'), key=user.id+'/learn-path-v1-'+slug;
    const entries=(await (await context.request.get(api+'/state/all')).json()).entries;
    const source=JSON.parse(entries[key]);
    source.history=Array.from({length:4},()=>({role:'user',content:'零基础，仅掌握上传协议全部八项规则，按原文学习并测验，不增加外部知识。'}));
    assert.equal((await context.request.post(api+'/state/put',{data:{entries:{[key]:JSON.stringify(source)}}})).status(),200);
    await page.reload();await page.locator('#chat-input').fill('请直接依据上传资料生成知识地图，范围已确认。');await page.locator('#chat-send').click();
    await page.waitForFunction(()=>!document.getElementById('stage-learning').hidden && document.querySelectorAll('.node-card').length>0,{},{timeout:480000});
    const persisted=JSON.parse((await (await context.request.get(api+'/state/all')).json()).entries[key]);
    assert(persisted.plan.nodes.length>=6);assert(JSON.stringify(persisted.plan).includes('星桥'));
    report.cases.push('real_model_intake_research_plan_from_uploaded_reference');
    report.sourceKey=key;report.sourceURL=sourceURL;
    await page.locator('#quizmap-btn').click();await page.locator('.materials-dialog input').waitFor();
    await page.locator('.materials-dialog input').setInputFiles({name:'测验补充.txt',mimeType:'text/plain',buffer:Buffer.from('测验应覆盖星桥协议原文，特别检查七个样本、两人复核、蓝绿标记与三个交接字段。')});
    await page.locator('.materials-dialog').getByText('解析完成，资料已保存，将用于生成地图和测验。',{exact:true}).waitFor();
    await page.locator('.materials-dialog .cancel').click();await page.reload();await page.locator('#quizmap-btn').click();
    await page.locator('.materials-dialog .materials-list li').waitFor();
    report.cases.push('quiz_extra_reference_draft_survives_reload');
    await page.setViewportSize({width:390,height:900});await page.screenshot({path:output+'/quiz-dialog-mobile.png',fullPage:true});
    assert(await page.locator('.materials-dialog').evaluate(e=>e.getBoundingClientRect().right<=innerWidth),'dialog mobile fits');
    await page.locator('.materials-dialog .generate').click();
    await page.waitForURL(/quiz-map\.html\?t=/,{timeout:480000});
    await page.locator('fieldset').first().waitFor({timeout:30000});
    const qslug=new URL(page.url()).searchParams.get('t');
    const quiz=JSON.parse((await (await context.request.get(api+'/state/all')).json()).entries[user.id+'/quiz-map-v1-'+qslug]);
    assert(quiz.questions.length>=8);assert.equal(quiz.materials.length,2);
    assert(/七|7|蓝|绿/.test(JSON.stringify(quiz.questions)));
    report.cases.push('real_model_quiz_from_base_and_added_references');report.quizURL=page.url();
    await page.screenshot({path:output+'/quiz-result.png',fullPage:true});
    await page.goto(base+'quiz-map.html');await page.getByRole('link',{name:'上传资料创建测验地图'}).click();
    await page.getByRole('heading',{name:'用自己的资料创建测验地图'}).waitFor();
    report.cases.push('new_quiz_upload_entry');
    assert.deepEqual(errors,[]);report.pageErrors=errors;
    fs.writeFileSync(output+'/report.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
  } catch(error) {
    report.error=error.message;report.pageErrors=errors;
    fs.writeFileSync(output+'/report.json',JSON.stringify(report,null,2));await page.screenshot({path:output+'/failure.png',fullPage:true}).catch(()=>{});throw error;
  } finally {await browser.close();}
})().catch(error=>{console.error(error.message);process.exitCode=1;});
