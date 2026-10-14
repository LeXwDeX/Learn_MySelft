"use strict";
const assert = require('assert');
const fs = require('fs');
const {chromium, webkit} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
(async () => {
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch({headless: true});
    try {
      const page = await browser.newPage({viewport: {width: 390, height: 844}});
      const template = fs.readFileSync('learning-path/path_template.html', 'utf8');
      const dialog = template.slice(template.indexOf('<dialog id="del-modal"'), template.indexOf('</dialog>', template.indexOf('<dialog id="del-modal"')) + 9);
      await page.setContent('<button id="lib-btn">资料库</button><div id="lib-wrap"><div id="lib-pop"><button id="trigger">删除资料</button></div></div><span id="lib-count"></span>' + dialog);
      await page.addScriptTag({path: 'shared/ui.js'});
      await page.evaluate(() => {
        window.LearnUser = {readOnly: false, fetch: async () => ({ok: true, json: async () => ({entries: {}})})};
        window.LearnTitles = {document: d => d.topic, quiz: d => ({title: d.title})};
        window.define = (name, names, factory) => {
          window.library = factory({'path.persistence': {deleteState: () => window.pendingDelete ? new Promise(resolve => {window.finishDelete = resolve;}) : Promise.resolve({ok: false, error: '密码错误，请重试'})}, 'path.shell': {}, 'path.model': {session: {API: '', STORE_PREFIX: 'learn-path-v1-', USER_PATH: 'u/'}}, 'path.format': {$: id => document.getElementById(id), storeKey: () => 'other', stripUser: key => key, esc: value => value}});
        };
      });
      await page.addScriptTag({path: 'learning-path/modules/path-library.js'});
      await page.evaluate(() => {
        const dialog = document.getElementById('del-modal');
        LearnUI.dialog.bind(dialog, null, () => {if (!dialog.open) library.resetDeletion();});
        dialog.addEventListener('cancel', event => {event.preventDefault(); library.closeDelModal();});
        document.getElementById('trigger').onclick = event => library.openDelModal('sample', '很长的资料标题'.repeat(20), null, event.currentTarget);
        document.getElementById('dm-cancel').onclick = library.closeDelModal;
        document.getElementById('dm-ok').onclick = library.submitDel;
      });
      await page.getByRole('button', {name: '删除资料', exact: true}).click();
      await page.getByLabel('当前登录密码', {exact: true}).fill('fixture-password');
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('#del-modal').evaluate(dialog => dialog.open), false);
      assert.equal(await page.locator('#dm-pass').inputValue(), '');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'trigger');
      await page.locator('#trigger').click();
      await page.evaluate(() => {window.pendingDelete = true;});
      await page.getByRole('button', {name: '确认删除', exact: true}).click();
      assert.equal(await page.locator('#dm-cancel').isDisabled(), true);
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('#del-modal').evaluate(dialog => dialog.open), true, 'Pending deletion stays open on Escape');
      await page.evaluate(() => {window.finishDelete({ok: false, error: '密码错误，请重试'});});
      await page.getByRole('alert').waitFor({state: 'visible'});
      assert.equal(await page.locator('#dm-ok').isEnabled(), true);
      await page.getByRole('button', {name: '取消', exact: true}).click();
      assert.equal(await page.evaluate(() => document.activeElement.id), 'trigger');
      console.log(engine.name() + ': dialog focus, Escape, password clearing, retry passed');
    } finally {await browser.close();}
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
