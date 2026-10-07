"""Tutor prompt, suggestions and history compression routes."""

import material_parser
from background_jobs import JobError
from user_accounts import AccountError
from text_utils import clip, chunk_text, history_messages
from prompts import build_system, build_suggest_system, COMPRESS_SYSTEM
from generation_contracts import parse_questions
from service_limits import (
    MAX_QUESTION,
    MAX_MSG_CHARS,
    COMPRESS_CHUNK_CHARS,
    MAX_IMAGE_B64,
    DATA_URL_RE,
)


class TutorRoutes:
    def __init__(self, model):
        self.model = model

    def compress_history(self, unit_id, msgs, chunk_chars=COMPRESS_CHUNK_CHARS):
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
                sys_txt += (
                    "\n\n注意：这是整段对话的第 %d/%d 段，只压缩这一段，输出该段要点即可。"
                    % (i + 1, len(chunks))
                )
            out = self.model.json(
                [
                    {"role": "system", "content": sys_txt},
                    {"role": "user", "content": c},
                ],
                max_tokens=self.model.settings.max_output_tokens,
                temperature=0.3,
            )
            out = (out or "").strip()
            if out:
                parts.append(out)
        if not parts:
            return ("", len(chunks), chars_in)
        if len(parts) == 1:
            return (clip(parts[0], MAX_MSG_CHARS), len(chunks), chars_in)
        merged = "\n\n".join(
            ("第%d段要点：\n%s" % (i + 1, p) for i, p in enumerate(parts))
        )
        final = self.model.json(
            [
                {
                    "role": "system",
                    "content": COMPRESS_SYSTEM
                    + "\n\n下面是整段对话分段压缩后的若干份要点，请合并成一份最终摘要（含主题归类、薄弱点、已掌握、未解决疑问）。",
                },
                {"role": "user", "content": clip(merged, 60000)},
            ],
            max_tokens=self.model.settings.max_output_tokens,
            temperature=0.3,
        ).strip()
        return (clip(final or "\n".join(parts), MAX_MSG_CHARS), len(chunks), chars_in)

    def post(self, request, path):
        try:
            body = request._read_body()
        except Exception as e:
            request._json(400, {"error": "bad json: %s" % e})
            return
        try:
            request._authorize_body(path, body)
        except (AccountError, JobError, material_parser.MaterialError) as error:
            request._json(error.status, {"ok": False, "error": str(error)})
            return
        ctx = body.get("unit") or {}
        history = body.get("history") or []
        if path.startswith("/suggest"):
            if not clip(ctx.get("unit_id"), 20):
                request._json(200, {"questions": [], "reason": "no unit"})
                return
            sys_txt = build_suggest_system(ctx)
            asked = [
                clip(m.get("content"), 60)
                for m in history
                if isinstance(m, dict) and m.get("role") == "user" and m.get("content")
            ]
            if asked:
                sys_txt += (
                    "\n\n他已经问过下面这些问题，**一个都不要重复**，请给出他没问过、但按学习顺序下一步最该问的 4 个：\n"
                    + "\n".join(("- " + a for a in asked[-6:]))
                )
            msgs = [{"role": "system", "content": sys_txt}]
            msgs += history_messages(history)
            msgs.append({"role": "user", "content": "请给出 4 个建议问题，每行一个。"})
            try:
                text = self.model.json(
                    msgs,
                    max_tokens=self.model.settings.max_output_tokens,
                    temperature=0.8,
                )
                qs = parse_questions(text)
                request._json(200, {"questions": qs})
            except Exception as e:
                request._json(
                    200, {"questions": [], "error": "%s: %s" % (type(e).__name__, e)}
                )
            return
        if path.startswith("/compress"):
            src = body.get("messages")
            if not isinstance(src, list):
                src = history
            msgs = [
                m
                for m in src
                if isinstance(m, dict)
                and m.get("role") in ("user", "assistant")
                and m.get("content")
            ]
            if not msgs:
                request._json(200, {"summary": "", "chunks": 0, "chars_in": 0})
                return
            try:
                summary, nchunks, chars_in = self.compress_history(
                    ctx.get("unit_id"), msgs
                )
                request._json(
                    200,
                    {
                        "summary": summary,
                        "chunks": nchunks,
                        "chars_in": chars_in,
                        "chars_out": len(summary),
                    },
                )
            except Exception as e:
                request._json(500, {"error": "%s: %s" % (type(e).__name__, e)})
            return
        question = clip(body.get("question"), MAX_QUESTION)
        if not question:
            request._json(400, {"error": "question required"})
            return
        messages = [{"role": "system", "content": build_system(ctx)}]
        messages += history_messages(history)
        img = (body.get("image") or "").strip()
        if img:
            m = DATA_URL_RE.match(img)
            if not m:
                request._json(
                    400,
                    {"error": "image must be a base64 data URL (jpeg/png/webp/gif)"},
                )
                return
            if len(m.group(2)) > MAX_IMAGE_B64:
                request._json(413, {"error": "image too large after encoding"})
                return
            messages.append(
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": question},
                        {"type": "image_url", "image_url": {"url": img}},
                    ],
                }
            )
        else:
            messages.append({"role": "user", "content": question})
        node = body.get("node") or {}
        if not isinstance(node, dict):
            request._json(400, {"error": "学习节点格式不正确"})
            return
        if body.get("key") is not None:
            request.stream(messages, graphics_context={"key": body.get("key"), "node_id": node.get("id")})
        else:
            request.stream(messages)
