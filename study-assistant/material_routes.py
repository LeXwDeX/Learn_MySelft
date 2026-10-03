"""MaterialRoutes HTTP routes use injected application services."""

import json
import sqlite3
import material_parser
from background_jobs import JobError
from user_accounts import AccountError


class MaterialRoutes:
    def __init__(self, repository):
        self.repository = repository

    def post(self, request, path):
        try:
            request._target_user(write=True)
            body = request._read_body()
            if not isinstance(body, dict):
                raise AccountError(400, "请求必须为 JSON 对象")
            if path == "/materials/parse":
                report = material_parser.parse_upload(
                    body.get("name"), body.get("data"), report=True
                )
                request._json(200, {"ok": True, **report})
            else:
                key = body.get("key")
                request._authorize_key(key, write=True)
                additions = material_parser.validate_materials(body.get("materials"))
                with self.repository.lock, self.repository.store.transaction():
                    source = self.repository.material(key)
                    if source is None or not key.split("/", 1)[1].startswith(
                        "learn-path-v1-"
                    ):
                        raise AccountError(404, "学习地图不存在")
                    material_parser.validate_materials(
                        (source.get("materials") or []) + additions
                    )
                    source["quizMaterials"] = additions
                    self.repository.write_key(
                        key, json.dumps(source, ensure_ascii=False)
                    )
                request._json(200, {"ok": True})
        except (AccountError, JobError, material_parser.MaterialError) as error:
            request._json(error.status, {"ok": False, "error": str(error)})
        except (ValueError, TypeError):
            request._json(400, {"ok": False, "error": "无效的资料请求"})
        except (OSError, sqlite3.Error):
            request._json(503, {"ok": False, "error": "资料保存暂时不可用"})
        return
