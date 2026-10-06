'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const source = fs.readFileSync('learning-path/path_app.js', 'utf8');
const alerts = [];
function element() { return {dataset:{}, style:{setProperty(key,value){this[key]=value;}},addEventListener(){}, querySelector(){return {addEventListener(){}};},querySelectorAll(){return [];}}; }
const context = {console, setTimeout, clearTimeout, alert: value=>alerts.push(value), location:{search:''},
 document:{readyState:'loading',addEventListener(){},createElement:element}, window:{addEventListener(){},LearnUser:{apiBase:'',userId:'u0'}}};
vm.createContext(context);require('./load_uikit.cjs')(context); vm.runInContext(source,context);
const get=context.window.LearnPathApp.get;
const api={...get('path.domain'),...get('path.cards'),...get('path.assessment'),state:get('path.model').state};
const root={id:'n1',deps:[]}, second={id:'n2',deps:['n1']};
const children=Array.from({length:12},(_,index)=>({id:'n'+(index+3),deps:index?['n'+(index+2)]:[],remediation:{parent:'n1'}}));
const nested={id:'n15',deps:[],remediation:{parent:'n3'}}, deepest={id:'n16',deps:[],remediation:{parent:'n15'}};
const plan={nodes:[root,second,...children,nested,deepest]};
api.normalizePlan(plan); api.state.plan=plan;
assert.deepEqual(Array.from(plan.nodes,node=>node.id),['n1','n3','n15','n16',...children.slice(1).map(node=>node.id),'n2']);
assert.equal(api.dispId('n14'),'L1.12');assert.equal(api.dispId('n16'),'L1.1.1.1');assert.equal(api.dispId('n2'),'L2');
assert.equal(api.canRefine('n16'),false);api.refineNode('n16');assert.match(alerts[0],/四层/);
assert.equal(api.canRefine('n15'),true);
const parentCard=api.nodeCard(root), childCard=api.nodeCard(children[0]), otherCard=api.nodeCard(second);
assert.equal(parentCard.dataset.group,childCard.dataset.group);assert.notEqual(parentCard.dataset.group,otherCard.dataset.group);
assert.equal(parentCard.style['--group-color'],'var(--learn-level-1)');assert.equal(childCard.style['--group-color'],'var(--learn-level-2)');
assert.equal(parentCard.style['--group-color'],otherCard.style['--group-color']);
assert.match(childCard.innerHTML,/>L1.1<\/span>/);
const levels=['--learn-level-1','--learn-level-2','--learn-level-3','--learn-level-4'];
const levelNodes=[];
for(const rootId of ['a','b']){
  for(let depth=1;depth<=4;depth++){
    const id=rootId+depth;
    levelNodes.push({id,deps:depth===2&&rootId==='b'?['missing']:[],...(depth>1?{remediation:{parent:rootId+(depth-1)}}:{})});
  }
}
const levelPlan={nodes:levelNodes};api.state.plan=levelPlan;api.state.nodeState={b1:{completed:true},a3:{score:45}};
const levelColorsById=nodes=>Object.fromEntries(api.planHierarchy(nodes).map(entry=>[entry.node.id,api.nodeCard(entry.node,entry).style['--group-color']]));
const levelEntries=api.planHierarchy(levelPlan.nodes);
for(let depth=1;depth<=4;depth++){
  const sameDepth=levelEntries.filter(entry=>entry.depth===depth);
  assert.equal(sameDepth.length,2);
  assert.equal(api.nodeCard(sameDepth[0].node,sameDepth[0]).style['--group-color'],'var('+levels[depth-1]+')');
  assert.equal(api.nodeCard(sameDepth[1].node,sameDepth[1]).style['--group-color'],'var('+levels[depth-1]+')');
}
assert.equal(api.nodeCard(levelPlan.nodes.find(node=>node.id==='b1'),levelEntries.find(entry=>entry.node.id==='b1')).className,'node done');
assert.equal(api.nodeCard(levelPlan.nodes.find(node=>node.id==='b2'),levelEntries.find(entry=>entry.node.id==='b2')).className,'node locked');
assert.equal(api.nodeCard(levelPlan.nodes.find(node=>node.id==='a3'),levelEntries.find(entry=>entry.node.id==='a3')).className,'node failed');
const originalLevelColors=levelColorsById(levelPlan.nodes);
const reorderedLevelColors=levelColorsById(levelPlan.nodes.slice().reverse());
assert.deepEqual(reorderedLevelColors,originalLevelColors);
const tokenCss=fs.readFileSync('shared/uikit/tokens.css','utf8');
const declaredLevelColors=levels.map(token=>tokenCss.match(new RegExp(token+':\\s*(#[0-9a-f]{6})','i'))?.[1]);
assert.ok(declaredLevelColors.every(Boolean));assert.equal(new Set(declaredLevelColors).size,4);
const gate={nodes:[{id:'n1',deps:['n3']},{id:'n2',deps:['n1']},{id:'n3',deps:[],remediation:{parent:'n1'}}]};
api.normalizePlan(gate);api.state.plan=gate;
assert.deepEqual(Array.from(gate.nodes[0].deps),['n3']);assert.equal(api.isUnlocked('n1'),false);
api.state.nodeState.n3={completed:true};assert.equal(api.isUnlocked('n1'),true);
const bad={nodes:[{id:'a',deps:['b'],remediation:{parent:'b'}},{id:'b',deps:['a'],remediation:{parent:'a'}},{id:'orphan',deps:['missing','orphan'],remediation:{parent:'missing'}},{id:'self',deps:[],remediation:{parent:'self'}}]};
api.normalizePlan(bad);
assert.deepEqual(Array.from(api.planHierarchy(bad.nodes),entry=>entry.label),['L1','L1.1','L2','L3']);
assert.deepEqual(Array.from(bad.nodes[1].deps),[]);assert.deepEqual(Array.from(bad.nodes[2].deps),[]);
const css=fs.readFileSync('learning-path/path.css','utf8');
assert.match(css,/border-left:4px solid var\(--group-color/);assert.doesNotMatch(css,/\.node\.(?:done|failed|unlocked)\{border-left-color/);
console.log('PASS hierarchy ordering, numeric siblings, cycles, cross-root level colors, reorder stability, prerequisite preservation and depth guard');
