# -*- coding: utf-8 -*-
"""生成《学习路径》单页应用（采集 → 研究 → 路径图 + 解锁门控）。

读模板，用占位符替换内联 JS，避免 f-string 花括号转义问题。
"""
import os
import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
TPL = os.path.join(HERE, "path_template.html")
APP = os.path.join(HERE, "path_app.js")
OUT = os.path.join(HERE, "learning-path.html")


def main():
    with open(TPL, "r", encoding="utf-8") as f:
        doc = f.read()
    with open(APP, "r", encoding="utf-8") as f:
        app_js = f.read()

    if "__APP_JS__" not in doc:
        raise SystemExit("模板缺少 __APP_JS__ 占位符")

    with open(os.path.join(HERE, "quiz_dialog.js"), encoding="utf-8") as f:
        dialog_js = f.read()
    doc = doc.replace("__QUIZ_DIALOG_JS__", dialog_js)
    doc = doc.replace("__APP_JS__", app_js)
    with open(os.path.join(HERE, "quiz_map_template.html"), encoding="utf-8") as f:
        quiz_page = f.read().replace("__QUIZ_DIALOG_JS__", dialog_js)
    with open(os.path.join(HERE, "quiz-map.html"), "w", encoding="utf-8") as f:
        f.write(quiz_page)
    doc = doc.replace("__BUILD__", datetime.datetime.now().strftime("%Y-%m-%d %H:%M"))

    with open(OUT, "w", encoding="utf-8") as f:
        f.write(doc)

    print("生成完成:", OUT)
    print("大小:", os.path.getsize(OUT), "bytes")
    print("模板:", len(doc.splitlines()), "行 | JS:", len(app_js.splitlines()), "行")


if __name__ == "__main__":
    main()
