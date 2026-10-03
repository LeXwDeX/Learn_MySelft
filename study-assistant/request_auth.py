"""Actor and user-path authorization, independent of HTTP requests."""

import material_parser
from user_accounts import AccountError
from background_jobs import OPERATIONS


class RequestAuthorization:
    def __init__(self, accounts):
        self.accounts = accounts

    def key(self, actor, target, key, write):
        if not isinstance(key, str) or "/" not in key:
            raise AccountError(400, "状态键必须包含用户路径")
        user_id, business = key.split("/", 1)
        if not business or "/" in business or len(key) > 512:
            raise AccountError(400, "无效的状态键")
        self.accounts.authorize_target(actor, user_id, write=write)
        if user_id != self.accounts.authorize_target(actor, target, write=write)["id"]:
            raise AccountError(403, "请求与当前用户路径不一致")

    def body(self, actor, target, path, body):
        if not isinstance(body, dict):
            raise AccountError(400, "请求必须为JSON对象")
        if path.startswith("/path/"):
            if path not in OPERATIONS | {"/path/quiz/state", "/path/quiz/draft"}:
                raise AccountError(404, "不支持的学习操作")
            for field, kind in {
                "history": list,
                "spec": dict,
                "node": dict,
                "plan": dict,
                "answers": list,
                "items": list,
                "weaknesses": list,
            }.items():
                if (
                    field in body
                    and body[field] is not None
                    and (not isinstance(body[field], kind))
                ):
                    raise AccountError(400, field + "格式不正确")
        if "materials" in body:
            material_parser.validate_materials(body["materials"])
        read_only = path == "/path/quiz/state"
        self.accounts.authorize_target(actor, target, write=not read_only)
        if path == "/state/put":
            entries = body.get("entries")
            if not isinstance(entries, dict):
                raise AccountError(400, "entries must be an object")
            for key in entries:
                self.key(actor, target, key, write=True)
        elif path in ("/state/delete", "/state/del"):
            keys = body.get("keys")
            if not isinstance(keys, list):
                raise AccountError(400, "keys must be an array")
            for key in keys:
                self.key(actor, target, key, write=True)
        elif body.get("key") is not None:
            self.key(actor, target, body["key"], write=not read_only)
        if body.get("quiz_key") is not None:
            self.key(actor, target, body["quiz_key"], write=True)
