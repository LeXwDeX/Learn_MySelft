#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""study-assistant — 学习地图的 AI 辅助后端（33.146:8101）

职责：
  1) POST /ask      —— 接收带「单元上下文」的提问，拼装带上下文的 system prompt，
                       转发到本地 LLM 代理（192.168.33.110:8000），SSE 流式回传
  2) POST /suggest  —— 按当前话题（+已有对话）生成「接下来最可能想问的问题」，
                       供前端渲染建议问题，随对话变化而变化
  3) GET  /health

只用标准库，无第三方依赖。监听 0.0.0.0:8101。
"""
import hashlib
import json
import os
import re
import ssl
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LLM_BASE = os.environ.get("LLM_BASE", "http://192.168.33.110:8000/v1")
LLM_KEY = os.environ.get("LLM_KEY", "")
LLM_MODEL = os.environ.get("LLM_MODEL", "deepseek")
# 思考档：学习类工具统一「高」，与 Hermes 侧 agent.reasoning_effort=high 对齐。
# 实测本上游（33.110:8000 → deepseek）只在低档起作用：reasoning_effort=none 关闭思考、
# minimal 压短；high 及以上等于「不设上限」，思考量由题目难度决定（high/xhigh/max 无差别，
# ultra 是非法值会 400）。所以这里就是「思考不设限」。
REASONING_EFFORT = os.environ.get("REASONING_EFFORT", "max")
THINK = {"reasoning_effort": REASONING_EFFORT} if REASONING_EFFORT else {}
MAX_QUESTION = 2000
# 上下文预算：每个「单元对话」上限 500K token，超了由前端调 /compress 把更早的对话压成摘要。
# 后端只做硬保护：按字符预算从新到旧取，取满为止（约 2.4 字符/token 的保守换算）。
CONTEXT_LIMIT_TOKENS = 500_000
MAX_HISTORY_CHARS = 1_200_000
MAX_MSG_CHARS = 8000
COMPRESS_CHUNK_CHARS = 100_000
MAX_IMAGE_B64 = 8 * 1024 * 1024   # 压缩后的图片 base64 体量上限（前端已压成 JPG90%/≤4K）
DATA_URL_RE = re.compile(r"^data:image/(jpeg|jpg|png|webp|gif);base64,([A-Za-z0-9+/=\s]+)$")
MAX_TOKENS = 393216        # DeepSeek API 官方最大输出（384K=393216；实测有效范围 [1,393216]，393217 被 400）。
# 思考虽然走 reasoning_content 独立字段，但按官方设计其 token 计入 max_tokens 总输出配额
#（实测 max_tokens=64 → reasoning_tokens=64、正文空），因此一律给足顶格，杜绝思考挤爆预算导致截断。
UPSTREAM_TIMEOUT = 180

# ---- 学习路径（/path/*）相关常量 ----
SEARXNG_BASE = os.environ.get("SEARXNG_BASE", "http://192.168.33.146:8103")
# 路径类端点（尤其 /path/plan、/path/node）输出长；思考与正文共享输出配额（DeepSeek 官方设计），
# 一律顶格官方最大输出 393216（384K），不再出现被思考挤爆→正文截断。
PATH_MAX_TOKENS = 393216
PATH_MAX_ROUNDS = 4        # 采集阶段最多轮询轮数，超过必须产出 Spec
SEARXNG_TIMEOUT = 30
MAX_TOPIC = 2000

# 只允许本机/私有网段来源，避免任意网页把这个服务当免费代理用
ALLOWED_ORIGIN = re.compile(
    r"^https?://(localhost|127\.0\.0\.1|192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3})(:\d+)?$"
)

# ---- 学习数据服务端持久化（/state/*）----
# 浏览器里的所有学习数据（进度标记、单元对话、学习路径生成物等 localStorage 键）会实时同步到这里。
# 每键一个 JSON 文件，内容 {"key","v","ts"}；v=null 表示已删除（墓碑，防止旧设备把已删数据推回来）。
STATE_DIR = os.environ.get("STATE_DIR", os.path.join(os.path.dirname(os.path.abspath(__file__)), "state"))
STATE_LOCK = threading.Lock()
STATE_MAX_KEYS = 2000            # 单次请求键数上限
STATE_MAX_VALUE = 2_000_000      # 单键值长度上限（字符）

# ============================================================================
# 学习路径：system prompt 集中管理
# ============================================================================
# kind: intake / research_queries / research_brief / plan / node / quiz
_PATH_SYSTEM = {
    "intake": """你是一位学习规划助手，正在通过对话采集用户的学习需求，最终产出一份可执行的学习路径需求单（Spec）。

你每轮只能输出下面两种格式之一（严格、不要任何多余文字）：
ASK: <一个中文问题>          —— 信息还不够时，一次只问一个问题
SPEC: <一个 JSON 对象>        —— 信息足够时，直接给出需求单

SPEC 的 JSON 字段（全部必填）：
{"topic":"...","goal":"...","level":"零基础/入门/进阶","depth":"了解/系统掌握/能实战","budget":"可投入时间，如 每天1小时×2周","preferences":["例子","练习","理论","图"],"constraints":"...","outline_hint":["...","..."]}
- preferences 至少 1 项，从 例子/练习/理论/图 里选。
- outline_hint 给 3~6 条你认为该覆盖的主题。
- 不知道的字段要根据 topic 与常识合理默认，不要留空、不要写「未知」。

采集纪律：
1. 一次只问 1 个问题，问题要短、具体、口语化。
2. 重点采集：学习目的 / 现有基础 / 期望深度 / 可投入时间 / 偏好形式（例子、练习、理论、图）。
3. 已经知道的信息不要再问。
4. 用户已经回答满 4 轮后，必须输出 SPEC，不得再问。
5. 若 topic 已经给出，第一个问题必须针对这个 topic（例如先确认目标或基础）。""",
    "research_queries": """你在为一个学习路径做前期检索。根据需求单，给出 3~5 条用于搜索引擎（SearXNG）的中文或英文检索式。

只输出一个 JSON 数组字面量，例如：["Rust 入门 学习路径","所有权机制 常见误区"]，不要任何解释、不要代码围栏。
检索式要覆盖：核心概念、前置知识、常见误区、优质教程/课程。""",
    "research_brief": """你在把检索结果整理成一份「研究简报」，供后续生成学习路径使用。

要求：
1. 中文，总长不超过 600 字。
2. 分四个小标题：核心事实 / 前置概念 / 常见误区 / 推荐学习顺序。
3. 引用检索结果时用序号标注来源，如 [1][2]。
4. 只写检索结果支持的内容，不要编造；检索结果不足时可基于常识补充，但不要标来源。""",
    "plan": """你在设计一条从零基础通往目标的学习路径（有向无环图）。

只输出一个 JSON 对象字面量，不要解释、不要代码围栏，格式：
{"title":"...","summary":"...","nodes":[{"id":"n1","title":"...","essence":"...","deps":[],"objectives":["...","..."]}],"edges":[["n1","n2"]]}

规则：
1. 节点数 8~12 个（最少 6、最多 12），id 从 n1 开始连续编号。
2. 每个节点 = 一个能在一段时间内学完的概念或技能；essence 一句话讲本质（≤60字）。
3. objectives 2~3 条可检验的目标。
4. deps 只能引用编号更小的节点 id（如 n3 的 deps 只能是 n1/n2），保证严格依赖链；起点节点 deps 为空。
5. 允许并行支线（同层多个节点），但整体要形成从零基础到目标。
6. edges 与 deps 等价（可由 deps 推导），两者保持一致。
7. 结合研究简报里的要点与误区安排节点顺序。""",
    "node": """你在为一个学习节点写学习材料。

只输出一个 JSON 对象字面量，不要解释、不要代码围栏，格式：
{"study_notes":"...","key_points":["..."],"examples":["..."],"misconceptions":["..."],"quiz":{"questions":[{"q":"...","answer":"...","explain":"..."}]}}

规则：
1. study_notes 为正文，≤1200 字，可用 `## ` 小标题与行内 $...$ 公式；只写纯文本/markdown，禁止输出 HTML 标签。
2. key_points 3~5 条；examples 2~3 条；misconceptions 2~3 条。
3. quiz.questions 1~3 题，每题必须给 answer（参考答案）与 explain（解析）。
4. 面向零基础，多举具体例子。
5. 公式统一用 LaTeX 并包在 $...$ 里（前端用 KaTeX 渲染）：向量写 \\mathbf{x}，范数写 \\|\\mathbf{x}\\|，点积写 \\cdot，矩阵写 \\mathbf{A}；不要用 \\( \\)、\\[ \\] 或 $$ 定界。
6. **每个例子里的数值计算必须自己验算一遍再输出**（如 (1,2,3)·(4,0,2)=1×4+2×0+3×2=10；范数 \\|\\mathbf{x}\\|_2=\\sqrt{\\mathbf{x}\\cdot\\mathbf{x}}），凡算错即为重大缺陷。
7. 同一段里前后符号保持一致（不要一处 |a|、一处 \\|a\\|）。""",
    "quiz": """你在批改学生的自测作答。

只输出一个 JSON 对象字面量，不要解释、不要代码围栏，格式：
{"pass":true,"score":85,"feedback":"...","per_question":[{"ok":true,"comment":"..."}]}

规则：
1. 按参考答案的语义判分，不要求字面一致；写清每题的正确点或缺漏。
2. score 为百分制整数。
3. per_question 数量与题目数一致、顺序一致。
4. pass 规则：score>=60 且没有任何一题完全跑题（完全答非所问/空白）时为 true，否则 false。
5. 评语用中文、直接、具体。""",
    "requiz": """你在为同一学习节点重新出题（学生上一次自测未通过，且已看过题目与讲解）。

只输出一个 JSON 对象字面量，不要解释、不要代码围栏，格式：
{"questions":[{"q":"...","answer":"...","explain":"..."}]}

规则：
1. 出 2~3 道全新题；覆盖本节点的知识要点，难度与上次相当或略低（学生未通过，以巩固与补漏为主）。
2. 严禁与「已出过的题目」相同或近似：题目情境、数字、问法、考察角度都必须变化；允许针对同一考点出变式题，但不得照搬。
3. 结合「上次批改要点」，优先覆盖学生暴露的薄弱点：先补错，再巩固。
4. 每题必须给 answer（参考答案）与 explain（解析）。
5. 公式统一用 $...$ 的 LaTeX（前端 KaTeX 渲染），不要用 \\( \\)、\\[ \\] 或 $$ 定界。
6. 数值必须自行验算正确。""",
}


def _path_system(kind):
    """取学习路径各阶段的 system prompt（集中管理，避免散落）。"""
    return _PATH_SYSTEM.get(kind, "")


SYSTEM_TMPL = """你是一位严谨、耐心的学习辅导老师，正在辅导一位成年学习者系统学习当前主题、打牢基础。

学生此刻正在学习的单元：
- 单元编号与名称：{unit_id} {unit_title}
- 所属知识域：{domain}
- 本单元的本质：{essence}
- 本单元必须掌握的要点：
{musts}
- 本单元常见陷阱（学生最容易错的地方）：
{traps}
- 本单元的自测题（含参考答案与解析，仅供你评估学生作答；不要主动公布）：
{quizzes}

回答纪律（严格遵守，第 1 条最高优先）：
1. **引导式学习，绝不主动给答案**：出题、布置练习、或学生正在解题时——只给题目，不附答案、不剧透解法；等学生提交答案后，先评估（对错、错在第几步、下次怎么避免），再给下一步提示，引导他自己修正。只有学生明确索要（"给答案/看答案/不会了直接讲"）才给出完整解答。
2. 学生问概念、定义、原理时可以直接回答：先一两句结论，再给必要的解释与例子；但如果是"帮我做这道题"类请求，先给一步提示，让他先试。
3. 用中文，不要铺垫；需要步骤时用编号列表，每步一句话，别写长篇。
4. 默认控制在 250 字以内；学生明确说"详细讲"时才展开。多举具体例子和反例，少讲抽象定义。
5. 学生答错时，直接指出错处，然后用提问或提示引导他自己修正——不要立刻抛完整正确步骤。
6. 优先只回答本单元及它的直接前置知识；若问题明显属于别的单元，先简短回答，再用一句话提示它属于哪个单元。
7. 不确定的事不要编。"""

SUGGEST_SYSTEM = """你在帮一位正在学习「{unit_id} {unit_title}」（所属：{domain}）的成年学生，生成他**接下来最可能想问的问题**，用来做成快捷提问按钮。

本单元的本质：{essence}
必会点：{musts}
他的常见陷阱：{traps}

要求：
1. 输出 4 个中文短问题，**每行一个**，不要编号、不要项目符号、不要任何解释或其他文字。
2. 每个问题不超过 14 个字，要短到能当按钮文字。
3. 必须紧扣这个单元的具体内容，不要写"请解释一下这个单元"这类空泛问题。
4. 至少 1 个是"举反例 / 出道题考我"这类动手型问题。
5. 如果已经有对话，新问题要接着对话的脉络往下问（比如他刚问过区别，下一问就该是应用、反例或易错点），不要重复他已经问过的。"""


def clip(s, n):
    s = (s or "").strip()
    return s[:n]


COMPRESS_SYSTEM = """你在压缩一段「学生 × AI 老师」的学习对话，目的是让后续提问不丢失关键前情，同时把体量压到很小。

把给定内容压缩成给后续对话复用的【前情摘要】，只保留这几类信息：
1. 学生已经问过/纠结过的主题（按主题归类，不要逐条抄）
2. 学生的薄弱点、答错的地方、明确说过的困惑
3. 已经确认掌握、不必再重复的基础
4. 尚未解决的疑问

要求：中文；写成连贯的要点（最多 6 条，可用短句）；不要客套；不要复述题目原文；不要写「学生问/老师答」这种流程叙述；总长不超过 400 字。"""


def chunk_text(text, size):
    """按行切块，尽量不切断行。"""
    out, cur = [], ""
    for line in text.split("\n"):
        if cur and len(cur) + len(line) + 1 > size:
            out.append(cur)
            cur = ""
        cur = (cur + "\n" + line) if cur else line
    if cur:
        out.append(cur)
    return out or [text]


def compress_history(unit_id, msgs, chunk_chars=COMPRESS_CHUNK_CHARS):
    """把历史压成一份摘要。太长就分批压、再合并。返回 (summary, 批数, 原字符数)。"""
    lines = []
    for m in msgs:
        who = "学生" if m.get("role") == "user" else "老师"
        lines.append("%s：%s" % (who, clip(m.get("content"), 4000)))
    text = "\n".join(lines)
    chars_in = len(text)
    chunks = chunk_text(text, chunk_chars)
    parts = []
    for i, c in enumerate(chunks):
        sys_txt = COMPRESS_SYSTEM
        if len(chunks) > 1:
            sys_txt += ("\n\n注意：这是整段对话的第 %d/%d 段，只压缩这一段，输出该段要点即可。"
                        % (i + 1, len(chunks)))
        out = upstream_json([{"role": "system", "content": sys_txt},
                             {"role": "user", "content": c}],
                            max_tokens=MAX_TOKENS, temperature=0.3)
        out = (out or "").strip()
        if out:
            parts.append(out)
    if not parts:
        return "", len(chunks), chars_in
    if len(parts) == 1:
        return clip(parts[0], MAX_MSG_CHARS), len(chunks), chars_in
    merged = "\n\n".join("第%d段要点：\n%s" % (i + 1, p) for i, p in enumerate(parts))
    final = upstream_json([
        {"role": "system", "content": COMPRESS_SYSTEM + "\n\n下面是整段对话分段压缩后的若干份要点，请合并成一份最终摘要（含主题归类、薄弱点、已掌握、未解决疑问）。"},
        {"role": "user", "content": clip(merged, 60000)},
    ], max_tokens=MAX_TOKENS, temperature=0.3).strip()
    return clip(final or "\n".join(parts), MAX_MSG_CHARS), len(chunks), chars_in


def _block(title, items, limit, fallback="  （无）"):
    if not items:
        return fallback
    out = []
    for i, it in enumerate(items[:limit]):
        if isinstance(it, dict):
            line = "题：%s ｜ 答案：%s" % (clip(it.get("q"), 200), clip(it.get("a"), 200))
            if it.get("why"):
                line += "　解析：" + clip(it.get("why"), 200)
        else:
            line = clip(it, 200)
        out.append("  %d) %s" % (i + 1, line))
    return "\n".join(out)


def build_system(ctx):
    return SYSTEM_TMPL.format(
        unit_id=clip(ctx.get("unit_id"), 20),
        unit_title=clip(ctx.get("unit_title"), 80),
        domain=clip(ctx.get("domain"), 40),
        essence=clip(ctx.get("essence"), 300),
        musts=_block("必会", ctx.get("musts"), 8),
        traps=_block("陷阱", ctx.get("traps"), 6),
        quizzes=_block("自测", ctx.get("quizzes"), 4),
    )


def build_suggest_system(ctx):
    return SUGGEST_SYSTEM.format(
        unit_id=clip(ctx.get("unit_id"), 20),
        unit_title=clip(ctx.get("unit_title"), 80),
        domain=clip(ctx.get("domain"), 40),
        essence=clip(ctx.get("essence"), 300),
        musts=_block("必会", ctx.get("musts"), 8),
        traps=_block("陷阱", ctx.get("traps"), 6),
    )


def _ctx():
    return ssl.create_default_context()


def upstream_json(messages, max_tokens=MAX_TOKENS, temperature=0.7):
    body = {
        "model": LLM_MODEL,
        "messages": messages,
        "stream": False,
        "temperature": temperature,
        "max_tokens": max_tokens,
    }
    body.update(THINK)
    payload = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        LLM_BASE.rstrip("/") + "/chat/completions",
        data=payload,
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + LLM_KEY},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=UPSTREAM_TIMEOUT) as resp:
        data = json.loads(resp.read().decode("utf-8", "replace"))
    return (data.get("choices") or [{}])[0].get("message", {}).get("content", "") or ""


def upstream_stream(messages):
    body = {
        "model": LLM_MODEL,
        "messages": messages,
        "stream": True,
        "temperature": 0.3,
        "max_tokens": MAX_TOKENS,
    }
    body.update(THINK)
    payload = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        LLM_BASE.rstrip("/") + "/chat/completions",
        data=payload,
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer " + LLM_KEY,
            "Accept": "text/event-stream",
        },
        method="POST",
    )
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    return urllib.request.urlopen(req, timeout=UPSTREAM_TIMEOUT, context=ctx)


def parse_questions(text):
    """从模型输出里抠出干净的短问题列表。"""
    out = []
    for raw in (text or "").splitlines():
        line = raw.strip()
        if not line:
            continue
        line = re.sub(r"^[\-\*•·]+\s*", "", line)
        line = re.sub(r"^\d+[\.、\)）]\s*", "", line)
        line = line.strip(" \t\"'“”「」")
        if not line or len(line) > 24:
            continue
        if line.endswith("。") or line.endswith("."):
            line = line.rstrip("。.")
        if line and line not in out:
            out.append(line)
        if len(out) >= 4:
            break
    return out


# ============================================================================
# 学习路径：工具函数
# ============================================================================
def _upstream_nonempty(msgs, tries=2, **kw):
    """模型偶发返回空正文（max 档思考吃满预算），空则重试一次。"""
    t = ""
    for _ in range(max(1, tries)):
        t = upstream_json(msgs, **kw)
        if (t or "").strip():
            return t
    return t or ""


def _searxng(query, n=5):
    """调 SearXNG 检索，返回 [{"title","url","snippet"}]；任何失败都返回 []，不抛异常。"""
    q = clip(query, 300)
    if not q:
        return []
    url = SEARXNG_BASE.rstrip("/") + "/search?" + urllib.parse.urlencode({"q": q, "format": "json"})
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "study-assistant/1.1"})
        with urllib.request.urlopen(req, timeout=SEARXNG_TIMEOUT) as resp:
            data = json.loads(resp.read().decode("utf-8", "replace"))
    except Exception:
        return []
    out = []
    for r in (data.get("results") or []):
        if not isinstance(r, dict):
            continue
        u = (r.get("url") or "").strip()
        if not u:
            continue
        out.append({"title": clip(r.get("title") or u, 200), "url": u,
                    "snippet": clip(r.get("content") or "", 400)})
        if len(out) >= n:
            break
    return out


def _json_value(text):
    """从模型输出里抠出第一个平衡的 JSON 值（对象或数组）。失败返回 None。

    能处理 ```json ... ``` 围栏、前后解释性文字，以及字符串/转义里的花括号。"""
    if not text:
        return None
    s = re.sub(r"```[A-Za-z0-9_+-]*", "", text.strip()).replace("```", "")
    start = None
    for i, ch in enumerate(s):
        if ch in "[{":
            start = i
            break
    if start is None:
        return None
    stack, in_str, esc = [], False, False
    for i in range(start, len(s)):
        ch = s[i]
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch in "[{(":
            stack.append(ch)
        elif ch in "}])":
            if not stack:
                break
            stack.pop()
            if not stack:
                try:
                    return json.loads(s[start:i + 1])
                except Exception:
                    pass   # 已闭合但内容有瑕疵；落到末尾的"补括号"兜底
    # 兜底修复：模型偶发忘写结尾的 } / ]（正文完整、只差收尾）→ 按剩余栈补上再解析
    if not in_str and stack and len(stack) <= 12 and all(c in "[{" for c in stack):
        closer = {"{": "}", "[": "]"}
        try:
            return json.loads(s[start:] + "".join(closer[c] for c in reversed(stack)))
        except Exception:
            return None
    return None


def _json_block(text):
    """抓第一个平衡的 JSON 对象，返回 dict；否则 None。"""
    v = _json_value(text)
    return v if isinstance(v, dict) else None


def _json_list(text):
    """抓第一个平衡的 JSON 数组，返回 list；否则 None。"""
    v = _json_value(text)
    return v if isinstance(v, list) else None


def _str_list(v, n, limit):
    """把模型给的任意值归一成去空的短字符串列表。"""
    if not isinstance(v, list):
        v = [v] if v else []
    return [clip(str(x), limit) for x in v if str(x).strip()][:n]


def _norm_spec(spec, topic=""):
    """归一 Spec，字段严格对齐前端契约，缺失给合理默认。"""
    spec = spec if isinstance(spec, dict) else {}
    prefs = _str_list(spec.get("preferences"), 6, 20) or ["例子"]
    return {
        "topic": clip(spec.get("topic") or topic, 200),
        "goal": clip(spec.get("goal"), 400),
        "level": clip(spec.get("level"), 60),
        "depth": clip(spec.get("depth"), 60),
        "budget": clip(spec.get("budget"), 120),
        "preferences": prefs,
        "constraints": clip(spec.get("constraints"), 400),
        "outline_hint": _str_list(spec.get("outline_hint"), 8, 100),
    }


def _norm_plan(obj, spec):
    """校验并归一 Plan：6~14 节点、id 从 n1 连续、deps 只指向序号更小的节点，edges 由 deps 推导。

    非法（节点数 <4 或缺 deps 引用）返回 None，交给调用方重试。"""
    if not isinstance(obj, dict) or not isinstance(obj.get("nodes"), list):
        return None
    raw = []
    for n in obj["nodes"]:
        if not isinstance(n, dict):
            continue
        title = clip(n.get("title"), 120)
        if not title:
            continue
        raw.append({
            "oid": str(n.get("id") or "").strip(),
            "title": title,
            "essence": clip(n.get("essence"), 160),
            "objectives": _str_list(n.get("objectives"), 3, 160),
            "deps_raw": _str_list(n.get("deps"), 6, 20),
        })
        if len(raw) >= 14:
            break
    if len(raw) < 4:
        return None
    idmap, ids, idx = {}, set(), {}
    for i, r in enumerate(raw):
        r["id"] = "n%d" % (i + 1)
        ids.add(r["id"])
        idx[r["id"]] = i
        if r["oid"] and r["oid"] not in idmap:
            idmap[r["oid"]] = r["id"]
    nodes, edges, tmp = [], [], []
    for r in raw:
        good = []
        for d in r["deps_raw"]:
            nd = idmap.get(d) or (d if d in ids else None)
            if not nd or nd == r["id"] or idx[nd] >= idx[r["id"]] or nd in good:
                continue
            good.append(nd)
        tmp.append({"id": r["id"], "title": r["title"], "essence": r["essence"],
                    "deps": good, "objectives": r["objectives"], "oidx": idx[r["id"]]})
    # 稳定拓扑排序（level = 前置最大层级 + 1，同层保持原顺序）后按序重编号，
    # 保证「展示顺序（分层渲染）== 编号顺序 n1..nN」，避免出现 n6 显示在 n5 之前。
    lvl = {}
    for t in tmp:
        mx = -1
        for d in t["deps"]:
            if lvl.get(d) is not None and lvl[d] > mx:
                mx = lvl[d]
        lvl[t["id"]] = mx + 1
    ordered = sorted(tmp, key=lambda t: (lvl[t["id"]], t["oidx"]))
    ren = {t["id"]: "n%d" % (i + 1) for i, t in enumerate(ordered)}
    for t in ordered:
        nid = ren[t["id"]]
        deps = [ren[d] for d in t["deps"] if d in ren]
        nodes.append({"id": nid, "title": t["title"], "essence": t["essence"],
                      "deps": deps, "objectives": t["objectives"]})
        for d in deps:
            edges.append([d, nid])
    return {"title": clip(obj.get("title") or spec.get("topic"), 120) or "学习路径",
            "summary": clip(obj.get("summary"), 400), "nodes": nodes, "edges": edges}


def _norm_node_detail(obj):
    """归一 NodeDetail：study_notes + 三个清单 + 1~3 题自测（每题必须 answer/explain）。"""
    if not isinstance(obj, dict):
        return None
    notes = clip(obj.get("study_notes") or obj.get("notes"), 3000)
    quiz = obj.get("quiz") if isinstance(obj.get("quiz"), dict) else {}
    qs = []
    for q in (quiz.get("questions") if isinstance(quiz.get("questions"), list) else []):
        if not isinstance(q, dict):
            continue
        question = clip(q.get("q") or q.get("question"), 300)
        if not question:
            continue
        qs.append({"q": question, "answer": clip(q.get("answer"), 600),
                   "explain": clip(q.get("explain"), 600)})
        if len(qs) >= 3:
            break
    if not notes and not qs:
        return None
    return {"study_notes": notes,
            "key_points": _str_list(obj.get("key_points"), 5, 200),
            "examples": _str_list(obj.get("examples"), 3, 300),
            "misconceptions": _str_list(obj.get("misconceptions"), 3, 300),
            "quiz": {"questions": qs}}


def _norm_quiz_questions(obj):
    """归一「重新出题」结果：{questions:[{q,answer,explain}]}，最多 3 题，至少 1 题有效，否则 None。"""
    if not isinstance(obj, dict):
        return None
    qs = []
    for q in (obj.get("questions") if isinstance(obj.get("questions"), list) else []):
        if not isinstance(q, dict):
            continue
        question = clip(q.get("q") or q.get("question"), 300)
        if not question:
            continue
        qs.append({"q": question, "answer": clip(q.get("answer"), 600),
                   "explain": clip(q.get("explain"), 600)})
        if len(qs) >= 3:
            break
    if not qs:
        return None
    return {"questions": qs}


def _norm_quiz_result(obj, n):
    """归一 QuizResult；pass 硬规则：score>=60 且没有被判「完全跑题」。"""
    if not isinstance(obj, dict):
        return None
    try:
        score = int(round(float(obj.get("score"))))
    except Exception:
        score = 0
    score = max(0, min(100, score))
    per_in = obj.get("per_question") if isinstance(obj.get("per_question"), list) else []
    per = []
    for i in range(n):
        item = per_in[i] if i < len(per_in) and isinstance(per_in[i], dict) else {}
        per.append({"ok": bool(item.get("ok")),
                    "comment": clip(item.get("comment") or item.get("feedback"), 400)})
    passed = obj.get("pass")
    if not isinstance(passed, bool):
        passed = score >= 60 and all(p["ok"] or p["comment"] for p in per)
    return {"pass": bool(passed) and score >= 60, "score": score,
            "feedback": clip(obj.get("feedback"), 600), "per_question": per}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "study-assistant/1.1"

    def log_message(self, fmt, *args):
        sys.stderr.write("[%s] %s\n" % (self.log_date_time_string(), fmt % args))

    def _cors(self):
        origin = self.headers.get("Origin", "")
        if origin and ALLOWED_ORIGIN.match(origin):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    # ---------- 学习数据仓库：/state/*（浏览器 localStorage ⇄ 服务端文件）----------
    def _state_path(self, key):
        return os.path.join(STATE_DIR, hashlib.sha1(key.encode("utf-8")).hexdigest() + ".json")

    def _state_all(self):
        out = {}
        if not os.path.isdir(STATE_DIR):
            return out
        with STATE_LOCK:
            for fn in os.listdir(STATE_DIR):
                if not fn.endswith(".json"):
                    continue
                try:
                    with open(os.path.join(STATE_DIR, fn), "r", encoding="utf-8") as f:
                        d = json.load(f)
                    if isinstance(d, dict) and isinstance(d.get("key"), str):
                        out[d["key"]] = d.get("v")
                except Exception:
                    continue
        return out

    def _state_put(self, entries):
        """写入/删除（v=None 为墓碑）。返回成功条数。"""
        os.makedirs(STATE_DIR, exist_ok=True)
        n = 0
        now = int(time.time() * 1000)
        with STATE_LOCK:
            for k, v in list(entries.items())[:STATE_MAX_KEYS]:
                if not isinstance(k, str) or not k or len(k) > 512:
                    continue
                if v is not None:
                    if not isinstance(v, str):
                        v = json.dumps(v, ensure_ascii=False)
                    if len(v) > STATE_MAX_VALUE:
                        continue
                with open(self._state_path(k), "w", encoding="utf-8") as f:
                    json.dump({"key": k, "v": v, "ts": now}, f, ensure_ascii=False)
                n += 1
        return n

    def do_GET(self):
        if self.path.startswith("/state/all"):
            self._json(200, {"ok": True, "entries": self._state_all()})
        elif self.path.startswith("/health"):
            self._json(200, {"status": "ok", "model": LLM_MODEL, "base": LLM_BASE, "reasoning_effort": REASONING_EFFORT or "(unset)", "endpoints": ["/ask", "/suggest", "/compress", "/path/intake", "/path/research", "/path/plan", "/path/node", "/path/quiz", "/path/requiz", "/state/all", "/state/put", "/state/del"]})
        else:
            self._json(404, {"error": "not found"})

    def _read_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        return json.loads(raw.decode("utf-8") or "{}")

    def _history_messages(self, history, budget_chars=MAX_HISTORY_CHARS):
        """把历史转成 messages。

        - role=summary 的条目（前端压缩后的前情摘要）作为 system 消息放在最前
        - 其余按「从新到旧」累计字符，累计到预算为止（保证绝不超 500K token 的硬上限）
        """
        if not isinstance(history, list):
            return []
        summary = None
        for m in history:
            if isinstance(m, dict) and m.get("role") == "summary" and m.get("content"):
                summary = clip(m["content"], MAX_MSG_CHARS)
        picked, used = [], 0
        for m in reversed(history):
            if not isinstance(m, dict):
                continue
            if m.get("role") not in ("user", "assistant"):
                continue
            c = clip(m.get("content"), MAX_MSG_CHARS)
            if not c:
                continue
            if used + len(c) > budget_chars:
                break
            used += len(c)
            picked.append({"role": m["role"], "content": c})
        picked.reverse()
        out = []
        if summary:
            out.append({"role": "system", "content": "【更早对话的压缩摘要，供你延续上下文】\n" + summary})
        out.extend(picked)
        return out

    # ---------- 学习路径：/path/* ----------
    def _handle_path(self, path, body):
        # -- 采集：一轮一问，或直接产 Spec --
        if path.startswith("/path/intake"):
            topic = clip(body.get("topic"), MAX_TOPIC)
            history = body.get("history") or []
            rounds = sum(1 for m in history if isinstance(m, dict)
                         and m.get("role") == "user" and m.get("content"))
            msgs = [{"role": "system", "content": _path_system("intake")}]
            msgs += self._history_messages(history, budget_chars=60000)
            tail = ("学习主题：%s。请开始。" % topic) if topic else "请开始。"
            if rounds >= PATH_MAX_ROUNDS:
                tail += " 用户已回答满 %d 轮，本轮必须输出 SPEC。" % PATH_MAX_ROUNDS
            msgs.append({"role": "user", "content": tail})
            text = _upstream_nonempty(msgs, max_tokens=PATH_MAX_TOKENS, temperature=0.4)
            spec = None
            m = re.search(r"SPEC\s*[:：]\s*", text or "")
            if m:
                spec = _json_block(text[m.end():])
            if spec is None:
                spec = _json_block(text)
            if spec is not None:
                self._json(200, {"done": True, "question": "", "spec": _norm_spec(spec, topic)})
                return
            qm = re.search(r"ASK\s*[:：]\s*(.+)", text or "", re.S)
            question = clip(qm.group(1) if qm else (text or ""), MAX_QUESTION)
            if not question:
                question = "请告诉我你想学什么，以及你的学习目标。"
            self._json(200, {"done": False, "question": question, "spec": None})
            return

        # -- 研究：检索式 → SearXNG → 简报 --
        if path.startswith("/path/research"):
            spec = _norm_spec(body.get("spec"))
            qtext = _upstream_nonempty([
                {"role": "system", "content": _path_system("research_queries")},
                {"role": "user", "content": "需求单：\n" + json.dumps(spec, ensure_ascii=False)},
            ], max_tokens=PATH_MAX_TOKENS, temperature=0.5)
            arr = _json_list(qtext)
            if arr is None:
                d = _json_block(qtext)
                if isinstance(d, dict):
                    arr = d.get("queries") or d.get("search_queries")
            if not isinstance(arr, list) or not arr:
                arr = [spec.get("topic") or ""]
            queries = [clip(str(q), 200) for q in arr if str(q).strip()][:5]
            if not queries:
                queries = [spec.get("topic") or "学习路径"]
            sources, seen = [], set()
            for q in queries:
                for r in _searxng(q, 5):
                    if r["url"] in seen:
                        continue
                    seen.add(r["url"])
                    sources.append(r)
                    if len(sources) >= 12:
                        break
                if len(sources) >= 12:
                    break
            src_txt = "\n".join("[%d] %s | %s | %s" % (i + 1, s["title"], s["url"], s["snippet"])
                                for i, s in enumerate(sources)) or "（无检索结果）"
            brief = _upstream_nonempty([
                {"role": "system", "content": _path_system("research_brief")},
                {"role": "user", "content": "需求单：\n%s\n\n检索结果：\n%s" % (
                    json.dumps(spec, ensure_ascii=False), clip(src_txt, 12000))},
            ], max_tokens=PATH_MAX_TOKENS, temperature=0.5)
            self._json(200, {"queries": queries, "sources": sources, "brief": clip(brief, 2000)})
            return

        # -- 生成路径图（校验 6~14 节点）--
        if path.startswith("/path/plan"):
            spec = _norm_spec(body.get("spec"))
            brief = clip(body.get("brief"), 2000)

            def _mk(extra=""):
                return [
                    {"role": "system", "content": _path_system("plan")},
                    {"role": "user", "content": "需求单：\n%s\n\n研究简报：\n%s\n\n"
                     "请输出 8~12 个节点的学习路径 JSON。%s" % (
                         json.dumps(spec, ensure_ascii=False), brief, extra)},
                ]

            plan = _norm_plan(_json_block(upstream_json(
                _mk(), max_tokens=PATH_MAX_TOKENS, temperature=0.5)), spec)
            if plan is None or len(plan["nodes"]) < 6:
                plan = _norm_plan(_json_block(upstream_json(
                    _mk("注意：必须至少 6 个节点，id 从 n1 连续，deps 只引用编号更小的 id。"),
                    max_tokens=PATH_MAX_TOKENS, temperature=0.3)), spec)
            if plan is None or len(plan["nodes"]) < 6:
                self._json(502, {"error": "plan generation failed: need >=6 valid nodes", "plan": plan})
                return
            self._json(200, plan)
            return

        # -- 节点学习材料 --
        if path.startswith("/path/node"):
            spec = _norm_spec(body.get("spec"))
            node = body.get("node") or {}
            payload = {
                "需求单": spec,
                "前置节点": _str_list(body.get("dep_titles"), 6, 120),
                "本节点": {"id": clip(node.get("id"), 20), "title": clip(node.get("title"), 120),
                        "essence": clip(node.get("essence"), 200),
                        "objectives": _str_list(node.get("objectives"), 3, 160)},
            }
            def _mk_node(extra=""):
                return [
                    {"role": "system", "content": _path_system("node")},
                    {"role": "user", "content": json.dumps(payload, ensure_ascii=False)
                     + "\n请输出该节点的学习材料 JSON。" + extra},
                ]

            detail = _norm_node_detail(_json_block(_upstream_nonempty(
                _mk_node(), max_tokens=PATH_MAX_TOKENS, temperature=0.5)))
            if detail is None or not (detail.get("quiz") or {}).get("questions"):
                # 重试一次：强调完整闭合 + 控制篇幅，温度调低；缺自测题（截断降级）也重试
                d2 = _norm_node_detail(_json_block(_upstream_nonempty(
                    _mk_node(" 注意：只输出一个完整闭合的 JSON 对象（大括号成对），study_notes 控制在 1000 字内，必须带 1~3 道自测题。"),
                    max_tokens=PATH_MAX_TOKENS, temperature=0.3)))
                if d2 is not None and (((d2.get("quiz") or {}).get("questions")) or detail is None):
                    detail = d2
            if detail is None:
                self._json(502, {"error": "node detail generation failed"})
                return
            self._json(200, detail)
            return

        # -- 重新出题（换新题重测）--
        if path.startswith("/path/requiz"):
            node = body.get("node") or {}
            spec = _norm_spec(body.get("spec")) if body.get("spec") else None
            used = []
            for q in (body.get("used") or [])[:12]:
                if isinstance(q, dict) and clip(q.get("q"), 300):
                    used.append({"q": clip(q.get("q"), 300), "answer": clip(q.get("answer"), 300)})
            fb = body.get("feedback") if isinstance(body.get("feedback"), dict) else {}
            fb_payload = {
                "上次得分": fb.get("score"),
                "上次总评": clip(fb.get("feedback"), 600),
                "逐题批语": [{"ok": bool(x.get("ok")), "comment": clip(x.get("comment"), 300)}
                            for x in (fb.get("per_question") or [])[:3] if isinstance(x, dict)],
            }
            payload = {
                "需求单": spec,
                "节点": {"title": clip(node.get("title"), 120), "essence": clip(node.get("essence"), 200),
                       "objectives": _str_list(node.get("objectives"), 3, 160)},
                "已出过的题目": used,
                "上次批改要点": fb_payload,
            }
            def _mk_requiz(extra=""):
                return [
                    {"role": "system", "content": _path_system("requiz")},
                    {"role": "user", "content": json.dumps(payload, ensure_ascii=False)
                     + "\n请输出全新的自测题 JSON。" + extra},
                ]
            rq = _norm_quiz_questions(_json_block(_upstream_nonempty(
                _mk_requiz(), max_tokens=PATH_MAX_TOKENS, temperature=0.6)))
            if rq is None:
                rq = _norm_quiz_questions(_json_block(_upstream_nonempty(
                    _mk_requiz(" 注意：只输出一个完整闭合的 JSON 对象（大括号成对），必须含 2~3 道题，且与已出过的题目完全不同。"),
                    max_tokens=PATH_MAX_TOKENS, temperature=0.4)))
            if rq is None:
                self._json(502, {"error": "requiz failed"})
                return
            self._json(200, rq)
            return

        # -- 自测判分 --
        if path.startswith("/path/quiz"):
            node = body.get("node") or {}
            # 兼容两种形态：quiz.questions（设计契约）与顶层 questions
            qsrc = body.get("questions")
            if not qsrc and isinstance(body.get("quiz"), dict):
                qsrc = (body.get("quiz") or {}).get("questions")
            qs = []
            for q in (qsrc or [])[:3]:
                if isinstance(q, dict) and clip(q.get("q"), 300):
                    qs.append({"q": clip(q.get("q"), 300), "answer": clip(q.get("answer"), 600)})
            if not qs:
                self._json(400, {"error": "questions required"})
                return
            answers = [clip(str(a), 1000) for a in (body.get("answers") or [])[:len(qs)]]
            while len(answers) < len(qs):
                answers.append("")
            payload = {
                "节点": {"title": clip(node.get("title"), 120),
                       "essence": clip(node.get("essence"), 200),
                       "objectives": _str_list(node.get("objectives"), 3, 160)},
                "题目与参考答案": [{"q": q["q"], "answer": q["answer"]} for q in qs],
                "学生作答": answers,
            }
            res = _norm_quiz_result(_json_block(_upstream_nonempty([
                {"role": "system", "content": _path_system("quiz")},
                {"role": "user", "content": json.dumps(payload, ensure_ascii=False) + "\n请批改并输出 QuizResult JSON。"},
            ], max_tokens=PATH_MAX_TOKENS, temperature=0.3)), len(qs))
            if res is None:
                self._json(502, {"error": "quiz grading failed"})
                return
            self._json(200, res)
            return

        self._json(404, {"error": "not found"})

    def do_POST(self):
        path = self.path.split("?")[0]
        # 学习数据同步端点：浏览器端全量推送（含删除墓碑）
        if path.startswith("/state/put") or path.startswith("/state/del"):
            try:
                body = self._read_body()
            except Exception as e:
                self._json(400, {"error": "bad json: %s" % e})
                return
            try:
                if path.startswith("/state/put"):
                    entries = body.get("entries") or {}
                    if not isinstance(entries, dict):
                        self._json(400, {"error": "entries must be an object"})
                        return
                else:
                    keys = body.get("keys") or []
                    entries = {k: None for k in keys if isinstance(k, str)}
                n = self._state_put(entries)
                self._json(200, {"ok": True, "n": n})
            except Exception as e:
                self._json(500, {"error": "%s: %s" % (type(e).__name__, e)})
            return
        # 学习路径端点：单独入口，统一错误包装
        if path.startswith("/path/"):
            try:
                body = self._read_body()
            except Exception as e:
                self._json(400, {"error": "bad json: %s" % e})
                return
            try:
                self._handle_path(path, body)
            except urllib.error.HTTPError as e:
                self._json(502, {"error": "upstream HTTP %s" % e.code})
            except Exception as e:
                self._json(502, {"error": "%s: %s" % (type(e).__name__, e)})
            return
        if not (path.startswith("/ask") or path.startswith("/suggest") or path.startswith("/compress")):
            self._json(404, {"error": "not found"})
            return

        try:
            body = self._read_body()
        except Exception as e:
            self._json(400, {"error": "bad json: %s" % e})
            return

        ctx = body.get("unit") or {}
        history = body.get("history") or []

        # ---------- /suggest ----------
        if path.startswith("/suggest"):
            if not clip(ctx.get("unit_id"), 20):
                self._json(200, {"questions": [], "reason": "no unit"})
                return
            sys_txt = build_suggest_system(ctx)
            asked = [clip(m.get("content"), 60) for m in history
                     if isinstance(m, dict) and m.get("role") == "user" and m.get("content")]
            if asked:
                # 显式列出已问过的，模型才不会原样再给一遍
                sys_txt += ("\n\n他已经问过下面这些问题，**一个都不要重复**，请给出他没问过、"
                            "但按学习顺序下一步最该问的 4 个：\n" + "\n".join("- " + a for a in asked[-6:]))
            msgs = [{"role": "system", "content": sys_txt}]
            msgs += self._history_messages(history)
            msgs.append({"role": "user", "content": "请给出 4 个建议问题，每行一个。"})
            try:
                # 注意：deepseek 会先产 reasoning_content，max_tokens 太小会让正文为空
                text = upstream_json(msgs, max_tokens=MAX_TOKENS, temperature=0.8)
                qs = parse_questions(text)
                self._json(200, {"questions": qs})
            except Exception as e:
                self._json(200, {"questions": [], "error": "%s: %s" % (type(e).__name__, e)})
            return

        # ---------- /compress ----------
        if path.startswith("/compress"):
            src = body.get("messages")
            if not isinstance(src, list):
                src = history
            msgs = [m for m in src
                    if isinstance(m, dict) and m.get("role") in ("user", "assistant") and m.get("content")]
            if not msgs:
                self._json(200, {"summary": "", "chunks": 0, "chars_in": 0})
                return
            try:
                summary, nchunks, chars_in = compress_history(ctx.get("unit_id"), msgs)
                self._json(200, {"summary": summary, "chunks": nchunks,
                                 "chars_in": chars_in, "chars_out": len(summary)})
            except Exception as e:
                self._json(500, {"error": "%s: %s" % (type(e).__name__, e)})
            return

        # ---------- /ask ----------
        question = clip(body.get("question"), MAX_QUESTION)
        if not question:
            self._json(400, {"error": "question required"})
            return

        messages = [{"role": "system", "content": build_system(ctx)}]
        messages += self._history_messages(history)
        # 图片（前端已压缩：JPG 90%、最长边 ≤4K、原图 ≤10MB）转成 OpenAI 兼容 content 数组
        img = (body.get("image") or "").strip()
        if img:
            m = DATA_URL_RE.match(img)
            if not m:
                self._json(400, {"error": "image must be a base64 data URL (jpeg/png/webp/gif)"})
                return
            if len(m.group(2)) > MAX_IMAGE_B64:
                self._json(413, {"error": "image too large after encoding"})
                return
            messages.append({"role": "user", "content": [
                {"type": "text", "text": question},
                {"type": "image_url", "image_url": {"url": img}},
            ]})
        else:
            messages.append({"role": "user", "content": question})

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        # 关键：SSE 不声明长度，必须用 Connection: close 关连接来告诉浏览器「流结束了」，
        # 否则 HTTP/1.1 keep-alive 会让前端 reader 永远收不到 done，后续回调全不执行。
        self.send_header("Connection", "close")
        self.send_header("X-Accel-Buffering", "no")
        self.close_connection = True
        self._cors()
        self.end_headers()

        def sse(obj):
            self.wfile.write(("data: " + json.dumps(obj, ensure_ascii=False) + "\n\n").encode("utf-8"))
            self.wfile.flush()

        try:
            resp = upstream_stream(messages)
            ctype = (resp.headers.get("Content-Type") or "").lower()

            if "event-stream" not in ctype:
                data = json.loads(resp.read().decode("utf-8", "replace"))
                text = (data.get("choices") or [{}])[0].get("message", {}).get("content", "")
                sse({"delta": text})
            else:
                for line in resp:
                    line = line.decode("utf-8", "replace").strip()
                    if not line.startswith("data:"):
                        continue
                    chunk = line[5:].strip()
                    if chunk == "[DONE]":
                        break
                    try:
                        obj = json.loads(chunk)
                    except Exception:
                        continue
                    choices = obj.get("choices") or []
                    if not choices:
                        continue
                    piece = (choices[0].get("delta") or {}).get("content")
                    if piece:
                        sse({"delta": piece})
            sse({"done": True})
        except urllib.error.HTTPError as e:
            detail = ""
            try:
                detail = e.read().decode("utf-8", "replace")[:300]
            except Exception:
                pass
            sse({"error": "upstream HTTP %s: %s" % (e.code, detail)})
        except Exception as e:
            sse({"error": "%s: %s" % (type(e).__name__, e)})


def main():
    port = int(os.environ.get("PORT", "8101"))
    srv = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    srv.daemon_threads = True
    sys.stderr.write("study-assistant listening on 0.0.0.0:%d (model=%s, base=%s)\n" % (port, LLM_MODEL, LLM_BASE))
    srv.serve_forever()


if __name__ == "__main__":
    main()
