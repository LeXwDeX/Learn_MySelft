/* 学习状态与页面会话数据。 */
define("path.model", [], function (deps) {
  'use strict';

  var session = {};

session.API = window.LearnUser.apiBase;

session.TIMEOUT = 25000;

// 短请求；长操作使用可恢复后台任务

session.USER_PATH = window.LearnUser.userId + '/';

session.STORE_PREFIX = 'learn-path-v1-';

session.LAST_KEY = session.USER_PATH + 'learn-path-v1-last';

// 指向最近一次会话的 slug（带用户前缀）

session.state = {
    stage: 'intake',                  // intake | research | learning
    topic: '',
    title: '',
    materials: [],
    history: [],                      // [{role:'assistant'|'user', content}]
    spec: null,
    queries: [],
    sources: [],
    research_version: 0,
    brief: '',
    plan: null,
    nodeDetail: {},                   // {id: NodeDetail}
    nodeAccess: {},                  // Server-owned per-node access override
    nodeState: {},                    // {id: {completed, score, mark}}
    aiHist: {},                       // {id: [{role, content}]} —— 每单元独立的 AI 辅助对话
    pending: null                     // {kind:'research'|'plan'|'node', nid?, at} —— 生成防中断
  };

session.materialsPanel = null;

session.quizCreation = false;

session.materialSlug = null;

// Stable document identity, independent of its title

session.selectedId = null;

session.busy = false;

session.retryFn = null;

session.expandedId = null;

// 手风琴：当前展开的卡片（同时只展开一张）

session.activeScope = null;

// 当前展开卡片的 .node-content（测验交互的作用域根）

session.generatingNode = null;

// 正在生成材料的节点 id（防重复请求）

session.nodeMaterialStatus = {};

session.reviewFilter = false;

// 只看「需复习」（纯显示层）

session.resumeAttempts = 0;

// 自动恢复重试计数

session.MARK_LABELS = [['none', '未学'], ['learning', '学习中'], ['mastered', '已掌握'], ['review', '需复习']];

// ---------- 阶段/进度 ----------

session.STAGE_LABEL = { intake: '阶段 I · 需求采集', research: '阶段 R · 主动研究', learning: '阶段 L · 学习路径' };

  return Object.freeze({state: session.state, session: session});
});
