'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../learning-path/quiz_dialog.js'), 'utf8');
const context = {window: {}};
vm.createContext(context);
vm.runInContext(source.replace('  window.QuizDialog = {', '  globalThis.quizTest = {fillBlanks, fillValues, hasAnswer, scoringLabel, roundLabel};\n  window.QuizDialog = {'), context);
const {fillBlanks, fillValues, hasAnswer, scoringLabel, roundLabel} = context.quizTest;
const q = {type:'fill', q:'转换 ____；类型 ____。', points:20};
assert.equal(fillBlanks(q).length,2);
assert.equal(fillBlanks({...q,q:'Python __name__ 的值为 ____。'}).length,1);
assert.equal(fillBlanks({...q,q:'补全（  ）与( )'}).length,2);
for (const text of ['float64(x)；隐式', 'float64(x);隐式', 'float64(x)\n隐式']) {
  assert.deepEqual(Array.from(fillValues(q,text)), ['float64(x)','隐式']);
}
assert.deepEqual(Array.from(fillValues(q,';隐式')), ['', '隐式']);
assert.deepEqual(Array.from(fillValues(q,'无法可靠拆分的；三；段')), ['无法可靠拆分的；三；段','']);
const structured = ['a;b,c\nd','隐式'];
assert.deepEqual(fillValues(q,structured),structured);
assert.equal(hasAnswer(['','']),false);
assert.equal(hasAnswer(['','隐式']),true);
assert.equal(hasAnswer(''),false);
assert.equal(hasAnswer('A'),true);
const blanks = [{id:'b1',points:8},{id:'b2',points:12}];
assert(scoringLabel({...q,blanks,scoring:{mode:'per_blank'}}).includes('第 1 空 8 分'));
assert(scoringLabel({...q,blanks,scoring:{mode:'per_blank'}}).includes('第 2 空 12 分'));
assert(scoringLabel({...q,blanks,scoring:{mode:'all_or_nothing'}}).includes('全部空答对得 20 分'));
assert(scoringLabel(q).includes('未设置每空分值'));
const rounds = [
  {id: 'legacy'},
  {id: 'edition', migration: {id: 'm1', source_round_id: 'legacy'}},
  {id: 'fresh'}
];
assert.equal(roundLabel(rounds, 0, 'fresh'), '第 1 套 · 原版');
assert.equal(roundLabel(rounds, 1, 'fresh'), '第 2 套 · 修订版');
assert.equal(roundLabel(rounds, 2, 'fresh'), '第 3 套 · 最新');
assert.equal(roundLabel([{id: 'only'}], 0, 'other'), '第 1 套');
assert.equal(roundLabel([{id: 'now'}], 0, 'now'), '第 1 套 · 最新');
console.log('PASS blank layout, legacy preservation, positional arrays, scoring labels and round labels');

const titleContext = {window: {}};
vm.createContext(titleContext);
vm.runInContext(fs.readFileSync('shared/titles.js', 'utf8'), titleContext);
const names = titleContext.window.LearnTitles.quiz;
const titleSource = {title:'八年级数学',topic:'请你帮我学习数学。', plan:{title:'旧路径标题'}};
assert.equal(names({title:'八年级数学综合测验',sourceKey:'source'}, {source:JSON.stringify(titleSource)}).title, '八年级数学综合测验');
assert.equal(names({title:'几何专项测验',sourceKey:'source'}, {source:JSON.stringify(titleSource)}).source, '八年级数学');
assert.equal(titleContext.window.LearnTitles.document({topic:'首句', plan:{title:'另一个标题'}}), '学习资料');
assert.equal(titleContext.window.LearnTitles.document({title:'正式标题',topic:'首句', plan:{title:'另一个标题'}}), '正式标题');
