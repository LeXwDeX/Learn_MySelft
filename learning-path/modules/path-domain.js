/* 补习层级、前置条件和学习状态计算。 */
define("path.domain", ["path.model"], function (deps) {
  'use strict';
  var model = deps["path.model"];

// ---------- 图状态 ----------
  // Refinement ancestry is independent of prerequisite edges. Preserve sibling
  // insertion order and detach the earliest member of malformed parent cycles.

function planHierarchy(nodes) {
    var byId = new Map(), positions = new Map(), parents = new Map(), children = new Map();
    nodes.forEach(function (node, index) { byId.set(node.id, node); positions.set(node.id, index); children.set(node.id, []); });
    nodes.forEach(function (node) {
      var parent = node.remediation && node.remediation.parent;
      parents.set(node.id, parent !== node.id && byId.has(parent) ? parent : null);
    });
    nodes.forEach(function (node) {
      var path = [], seen = new Map(), current = node.id;
      while (current != null) {
        if (seen.has(current)) {
          var cycle = path.slice(seen.get(current));
          var first = cycle.reduce(function (best, id) { return positions.get(id) < positions.get(best) ? id : best; });
          parents.set(first, null);
          break;
        }
        seen.set(current, path.length); path.push(current); current = parents.get(current);
      }
    });
    var roots = [];
    nodes.forEach(function (node) {
      var parent = parents.get(node.id);
      if (parent == null) roots.push(node); else children.get(parent).push(node);
    });
    var entries = [];
    function visit(node, label, depth, rootId, rootIndex) {
      entries.push({node: node, label: label, depth: depth, root_id: rootId, root_index: rootIndex, parent_id: parents.get(node.id)});
      children.get(node.id).forEach(function (child, index) { visit(child, label + '.' + (index + 1), depth + 1, rootId, rootIndex); });
    }
    roots.forEach(function (node, index) { visit(node, 'L' + (index + 1), 1, node.id, index); });
    return entries;
  }

function hierarchyEntry(id) {
    return planHierarchy((model.state.plan && model.state.plan.nodes) || []).find(function (entry) { return entry.node.id === id; });
  }

function dispId(id) {
    var entry = hierarchyEntry(id);
    return entry ? entry.label : String(id).replace(/^n(\d+)$/, 'L$1');
  }

function canRefine(id) { var entry = hierarchyEntry(id); return !!entry && entry.depth < 4; }

function nodeById(id) {
    if (!model.state.plan) return null;
    for (var i = 0; i < model.state.plan.nodes.length; i++) if (model.state.plan.nodes[i].id === id) return model.state.plan.nodes[i];
    return null;
  }

function depsOf(id) {
    var n = nodeById(id);
    return (n && n.deps) || [];
  }

function isDone(id) { return !!(model.state.nodeState[id] && model.state.nodeState[id].completed); }

function isUnlocked(id) {
    var node = nodeById(id);
    if (!node) return false;
    return depsOf(id).every(function (dependency) {
      if (isDone(dependency)) return true;
      var parent = nodeById(dependency);
      // Older refine-marked units point at the failed parent. Chained
      // remediation still requires the preceding remedial unit to pass.
      return !!(node.refine && parent && !parent.refine && depsOf(dependency).every(isDone));
    });
  }

function canAccess(id) {
    if (model.session.accessUnavailable || !nodeById(id)) return false;
    var overrides = model.state.nodeAccess || {};
    var access = Object.prototype.hasOwnProperty.call(overrides, id) ? overrides[id] : null;
    if (access === 'locked') return false;
    if (access === 'unlocked') return true;
    return isDone(id) || isUnlocked(id);
  }

function depTitles(id) {
    return depsOf(id).map(function (d) { var n = nodeById(d); return n ? n.title : dispId(d); });
  }

// ---------- 单元状态标记（mark：与完成/解锁门控相互独立） ----------

function markNormalize(m) {
    for (var i = 0; i < model.session.MARK_LABELS.length; i++) if (model.session.MARK_LABELS[i][0] === m) return m;
    return 'none';
  }

function markOf(id) {
    return markNormalize((model.state.nodeState[id] || {}).mark);
  }

function countReview() {
    var nodes = (model.state.plan && model.state.plan.nodes) || [];
    var n = 0;
    nodes.forEach(function (x) { if (markOf(x.id) === 'review') n++; });
    return n;
  }

// Keep valid prerequisites even when hierarchy order places them later.
  // Accept edges deterministically while rejecting missing, self and cyclic links.

function normalizePlan(plan) {
    plan.nodes.forEach(function (n, i) { if (!n.id) n.id = 'n' + (i + 1); });
    var accepted = new Map();
    plan.nodes.forEach(function (node) { accepted.set(node.id, []); });
    function reaches(start, target, visited) {
      if (start === target) return true;
      if (visited.has(start)) return false;
      visited.add(start);
      return accepted.get(start).some(function (dependency) { return reaches(dependency, target, visited); });
    }
    plan.nodes.forEach(function (node) {
      (Array.isArray(node.deps) ? node.deps : []).forEach(function (dependency) {
        var dependencies = accepted.get(node.id);
        if (accepted.has(dependency) && dependencies.indexOf(dependency) === -1 && !reaches(dependency, node.id, new Set())) dependencies.push(dependency);
      });
      node.deps = accepted.get(node.id);
      node.objectives = node.objectives || [];
    });
    plan.nodes = planHierarchy(plan.nodes).map(function (entry) { return entry.node; });
    var edges = [];
    plan.nodes.forEach(function (n) {
      n.deps.forEach(function (d) { edges.push([d, n.id]); });
    });
    plan.edges = edges;

    plan.summary = plan.summary || '';
  }

  return Object.freeze({planHierarchy: planHierarchy, hierarchyEntry: hierarchyEntry, dispId: dispId, canRefine: canRefine, nodeById: nodeById, depsOf: depsOf, isDone: isDone, isUnlocked: isUnlocked, canAccess: canAccess, depTitles: depTitles, markNormalize: markNormalize, markOf: markOf, countReview: countReview, normalizePlan: normalizePlan});
});
