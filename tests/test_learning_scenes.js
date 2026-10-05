'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const window = {};
vm.runInNewContext(fs.readFileSync('shared/learning-scenes.js', 'utf8'), {window});
const validate = window.LearnScenes.validate;
const base = {version: 1, title: '数学场景', summary: '先观察，再计算。'};
const linear = {...base, type: 'linear_transform', matrix: [[2, 1], [1, 2]], vector: [-2, 3]};
const secant = {...base, type: 'secant', coefficients: [0, 0, 1], domain: [-1, 4], baseX: 1, gap: {min: 0.01, max: 3, value: 1.2}};
const surface = {...base, type: 'surface_slice', coefficient: 2, radius: 1.5, height: {min: 0.1, max: 4.5, value: 2}};
function equal(a, b) { assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b))); }
equal(validate(linear), linear); equal(validate(secant), secant); equal(validate(surface), surface);
equal(validate({...linear, vector: undefined}).vector, [1, 1]);
const clone = validate(linear); clone.matrix[0][0] = -4; clone.vector[0] = 0;
assert.equal(linear.matrix[0][0], 2); assert.equal(linear.vector[0], -2);
for (const matrix of [[[0, 0], [0, 0]], [[-4, 4], [4, -4]], [[1, 1], [2, 2]]]) assert.doesNotThrow(() => validate({...linear, matrix}));
assert.doesNotThrow(() => validate({...secant, coefficients: [0], gap: {min: 0.013, max: 0.013, value: 0.013}}));
assert.doesNotThrow(() => validate({...surface, height: {min: 0.0013, max: 0.0013, value: 0.0013}}));
const invalid = [null, [], {...linear, version: 2}, {...linear, type: '__proto__'}, {...linear, title: ' '}, {...linear, summary: ''}, {...linear, title: 'a'.repeat(81)}, {...linear, summary: 'a'.repeat(501)},
  {...linear, matrix: [[2, 1, 0], [1, 2]]}, {...linear, matrix: [[NaN, 0], [0, 1]]}, {...linear, matrix: [[5, 0], [0, 1]]}, {...linear, matrix: [[], []]}, {...linear, vector: [4, 0]}, {...linear, vector: ['1', 1]},
  {...linear, url: 'https://example.com'}, {...linear, coefficients: [1]}, {...linear, steps: ['alert(1)']}, {...secant, coefficients: []}, {...secant, coefficients: [21]}, {...secant, coefficients: [1, 2, 3, 4, 5, 6]},
  {...secant, domain: [1, 1]}, {...secant, baseX: 3}, {...secant, gap: {min: 0, max: 1, value: 1}}, {...secant, gap: {min: 0.1, max: 1, value: 2}}, {...secant, gap: {min: 0.1, max: 1, value: 0.2, expression: 'x'}},
  {...surface, coefficient: Infinity}, {...surface, radius: 0}, {...surface, height: {min: 0.1, max: 5, value: 1}}, {...surface, height: {min: 0, max: 1, value: 1}}];
invalid.forEach(spec => assert.throws(() => validate(spec)));
let reads = 0;
const getter = {...linear}; Object.defineProperty(getter, 'matrix', {get() { reads++; return [[1, 0], [0, 1]]; }});
assert.throws(() => validate(getter)); assert.equal(reads, 0, 'accessors are rejected without execution');
const row = [1, 0]; Object.defineProperty(row, '0', {get() { reads++; return 1; }});
assert.throws(() => validate({...linear, matrix: [row, [0, 1]]})); assert.equal(reads, 0);
const inherited = Object.create(Object.assign(Object.create(null), linear)); assert.throws(() => validate(inherited));
const polluted = JSON.parse(JSON.stringify({...linear}) .replace('"version":1', '"__proto__":{"polluted":true},"version":1'));
assert.throws(() => validate(polluted)); assert.equal({}.polluted, undefined);
const symbol = {...linear}; symbol[Symbol('action')] = 1; assert.throws(() => validate(symbol));
const coercion = {toString() { reads++; return 'linear_transform'; }}; assert.throws(() => validate({...linear, type: coercion})); assert.equal(reads, 0);
const sparse = new Array(2); const inheritedArray = Object.create(Array.prototype); Object.defineProperty(inheritedArray, '0', {get() { reads++; return 1; }}); Object.setPrototypeOf(sparse, inheritedArray);
assert.throws(() => validate({...linear, vector: sparse})); assert.equal(reads, 0);
console.log('PASS learning scene schema, bounds, clone isolation and untrusted data rejection');
