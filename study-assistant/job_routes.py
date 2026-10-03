"""JobRoutes HTTP routes use injected application services."""

import re
import sqlite3
import material_parser
from background_jobs import JobError, OPERATIONS
from user_accounts import AccountError


class JobRoutes:
    def __init__(self, repository, jobs):
        self.repository = repository
        self.jobs = jobs

    def post(self, request, path):
        try:
            body = request._read_body()
            if not isinstance(body, dict):
                raise JobError(400, "请求必须为JSON对象")
            target = request._target_user(write=True)
            if path == "/jobs":
                operation, payload = (body.get("operation"), body.get("body"))
                if (
                    not isinstance(operation, str)
                    or operation not in OPERATIONS
                    or (not isinstance(payload, dict))
                ):
                    raise JobError(400, "不支持的后台操作")
                if not payload.get("key"):
                    raise JobError(400, "请先保存学习资料再开始任务")
                request._authorize_body(operation, payload)
                if self.repository.material(payload["key"]) is None:
                    raise JobError(404, "学习资料已删除或不存在")
                job = self.jobs().submit(
                    target["id"], body.get("request_id"), operation, payload
                )
            elif re.fullmatch("/jobs/[0-9a-f]{32}/retry", path):
                job = self.jobs().retry(path.split("/")[2], target["id"])
            else:
                raise JobError(404, "任务操作不存在")
            request._json(202, {"ok": True, "job": job})
        except (AccountError, JobError, material_parser.MaterialError) as error:
            request._json(error.status, {"ok": False, "error": str(error)})
        except (ValueError, TypeError):
            request._json(400, {"ok": False, "error": "无效的任务请求"})
        except (OSError, sqlite3.Error):
            request._json(503, {"ok": False, "error": "任务保存暂时不可用，请稍后重试"})
        return
