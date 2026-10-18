"""Tutor prompt and answer routes."""

import material_parser
from background_jobs import JobError
from user_accounts import AccountError
from text_utils import clip, history_messages
from prompts import build_system
from service_limits import (
    MAX_QUESTION,
    MAX_IMAGE_B64,
    DATA_URL_RE,
)


class TutorRoutes:
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
        ctx = body.get("unit")
        if ctx is None:
            ctx = {}
        if not isinstance(ctx, dict):
            request._json(400, {"error": "学习单元格式不正确"})
            return
        history = body.get("history")
        if not isinstance(history, list):
            history = []
        raw_question = body.get("question")
        if not isinstance(raw_question, str):
            request._json(400, {"error": "question required"})
            return
        question = clip(raw_question, MAX_QUESTION)
        if not question:
            request._json(400, {"error": "question required"})
            return
        messages = [{"role": "system", "content": build_system(ctx)}]
        messages += history_messages(history)
        raw_image = body.get("image")
        if raw_image is not None and not isinstance(raw_image, str):
            request._json(
                400,
                {"error": "image must be a base64 data URL (jpeg/png/webp/gif)"},
            )
            return
        img = (raw_image or "").strip()
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
