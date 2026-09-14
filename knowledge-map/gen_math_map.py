# -*- coding: utf-8 -*-
"""交互式知识地图生成器：读取同目录数据文件 math_data.py → 生成页面 + 种子 JSON。

数据文件需自备（仓库未附数据）；模板用占位符替换（不用 f-string），避免 CSS/JS 花括号转义问题。
"""
import json, html, os, importlib.util

HERE = os.path.dirname(os.path.abspath(__file__))

# 复用数据模块
DATA = os.path.join(HERE, "math_data.py")
if not os.path.exists(DATA):
    raise SystemExit("未找到数据文件 math_data.py —— 请先在 knowledge-map/ 下提供你的数据（格式见 README）。")
spec = importlib.util.spec_from_file_location("data", DATA)
data_mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(data_mod)
DOMAINS, NODES, LINALG = data_mod.DOMAINS, data_mod.NODES, data_mod.LINALG

def esc(s): return html.escape(s, quote=True)

def node_card(nid, name, essence, musts, traps, quizzes):
    musts_html = "".join("<li>%s</li>" % esc(m) for m in musts)
    traps_html = "".join("<li>%s</li>" % esc(t) for t in traps)
    quiz_html = ""
    for i, (q, a, why) in enumerate(quizzes, 1):
        quiz_html += (
            '<div class="quiz">'
            '<p class="qq"><span class="qno">%d</span>%s</p>'
            '<button class="reveal" type="button">看答案</button>'
            '<div class="ans" hidden><p class="answerline"><strong>答案：</strong>%s</p>'
            '<p class="whyline">%s</p></div></div>' % (i, esc(q), esc(a), esc(why))
        )
    return (
        '<article class="node" id="{nid}" data-id="{nid}">'
        '<header class="node-head">'
        '<div class="node-id">{nid}</div>'
        '<div class="node-title"><h3>{name}</h3><p class="essence">{essence}</p></div>'
        '<div class="state-ui" role="group" aria-label="{name} 掌握状态">'
        '<button class="st" data-state="todo" type="button">未学</button>'
        '<button class="st" data-state="doing" type="button">学习中</button>'
        '<button class="st" data-state="done" type="button">已掌握</button>'
        '<button class="st" data-state="again" type="button">需复习</button>'
        '</div>'
        '<button class="ai-open" type="button" data-ai="1">AI 辅助</button>'
        '</header>'
        '<div class="node-body">'
        '<div class="col"><p class="col-label">必会</p><ul class="musts">{musts}</ul></div>'
        '<div class="col"><p class="col-label">陷阱</p><ul class="traps">{traps}</ul></div>'
        '</div>'
        '<div class="quizzone" hidden><p class="col-label">自测（先想，再看答案）</p>{quiz}</div>'
        '<button class="toggle-quiz" type="button">展开自测 ▾</button>'
        '</article>'
    ).format(nid=nid, name=esc(name), essence=esc(essence),
             musts=musts_html, traps=traps_html, quiz=quiz_html)

domains_html = ""
for dname, dcode, ddesc in DOMAINS:
    cards = "".join(node_card(*n) for n in NODES if n[0].startswith(dcode))
    domains_html += (
        '<section class="domain tabpanel" id="dom-%s" data-tab="%s" data-label="%s %s">'
        '<div class="domain-head"><h2><span class="dcode">%s</span>%s</h2><p>%s</p></div>'
        '<div class="nodes">%s</div></section>' % (dcode, dcode, dcode, esc(dname), dcode, esc(dname), esc(ddesc), cards)
    )

linalg_html = ""
for day, title, core, checks, (q, a, why), prereqs in LINALG:
    core_html = "".join("<li>%s</li>" % esc(c) for c in core)
    chk_html = "".join("<li>%s</li>" % esc(c) for c in checks)
    pre_html = "".join('<span class="pre">%s</span>' % esc(p) for p in prereqs)
    linalg_html += (
        '<article class="day">'
        '<div class="day-head"><span class="daytag">%s</span><h3>%s</h3></div>'
        '<div class="day-grid">'
        '<div><p class="col-label">今日核心</p><ul>%s</ul></div>'
        '<div><p class="col-label">当日检验标准</p><ul class="checks">%s</ul></div>'
        '</div>'
        '<div class="quiz"><p class="qq"><span class="qno">测</span>%s</p>'
        '<button class="reveal" type="button">看答案</button>'
        '<div class="ans" hidden><p class="answerline"><strong>答案：</strong>%s</p>'
        '<p class="whyline">%s</p></div></div>'
        '<p class="prereq"><span class="col-label">需先补</span>%s</p>'
        '</article>' % (esc(day), esc(title), core_html, chk_html, esc(q), esc(a), esc(why), pre_html)
    )

linalg_html = (
    '<section class="domain tabpanel" data-tab="linalg" data-label="线代 7 天冲刺">'
    '<p class="eyebrow">Sprint · 7 Days</p>'
    '<h2 style="margin-bottom:6px">7 天冲刺</h2>'
    '<p class="sub" style="margin-bottom:18px">每天一个主题，当天必须通过检验自测才进入下一天。'
    '标了「需先补」的知识点，卡住时就切到对应标签页点开那张卡片。</p>'
    + linalg_html + '</section>'
)

with open(os.path.join(HERE, "template.html"), "r", encoding="utf-8") as f:
    doc = f.read()
doc = doc.replace("__DOMAINS__", domains_html)
doc = doc.replace("__LINALG__", linalg_html)
doc = doc.replace("__NCOUNT__", str(len(NODES)))

out = os.path.join(HERE, "math-knowledge-map.html")
with open(out, "w", encoding="utf-8") as f:
    f.write(doc)
print("生成完成:", out, os.path.getsize(out), "bytes")
print("知识点数:", len(NODES), "| 域:", len(DOMAINS), "| 线代天数:", len(LINALG))

seed = {
    "domains": [{"code": c, "name": n, "desc": d} for n, c, d in DOMAINS],
    "nodes": [{"id": i, "name": n, "essence": e, "musts": m, "traps": t,
               "quizzes": [{"q": q, "a": a, "why": w} for q, a, w in qs]} for i, n, e, m, t, qs in NODES],
    "linalg_7day": [{"day": d, "title": t, "core": c, "checks": k,
                     "quiz": {"q": q, "a": a, "why": w}, "prereqs": p} for d, t, c, k, (q, a, w), p in LINALG],
}
with open(os.path.join(HERE, "math-knowledge-map.json"), "w", encoding="utf-8") as f:
    json.dump(seed, f, ensure_ascii=False, indent=2)
print("种子 JSON:", os.path.getsize(os.path.join(HERE, "math-knowledge-map.json")), "bytes")
