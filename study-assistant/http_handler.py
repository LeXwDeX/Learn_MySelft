"""HTTP framing, same-origin checks, bounded bodies and service routing."""

import json
import sqlite3
import sys
import threading
import urllib.error
import urllib.parse
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler
import material_parser
import quiz_harness as harness
from background_jobs import JobError
from user_accounts import AccountError, COOKIE_NAME
from state_schema import SCHEMA_VERSION
from http_io import read_json_body
from prompts import MANIM_TEACHING
from scene_contracts import animation_requested


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "study-assistant/1.1"

    @property
    def app(self):
        return self.server.application

    def _state_all(self, user_id=None):
        return self.app.repository.all(user_id or self.actor["id"])

    def _authorize_key(self, key, write):
        self.app.authorization.key(self.actor, self._selected_user_id(), key, write)

    def _authorize_body(self, path, body):
        self.app.authorization.body(self.actor, self._selected_user_id(), path, body)

    def _auth_post(self, path, body):
        return self.app.account_routes.post(self, path, body)

    def log_message(self, fmt, *args):
        sys.stderr.write("[%s] %s\n" % (self.log_date_time_string(), fmt % args))

    def _valid_origin(self):
        origin = self.headers.get("Origin", "")
        if not origin:
            return True
        parsed = urllib.parse.urlsplit(origin)
        host = urllib.parse.urlsplit("http://" + self.headers.get("Host", "")).hostname
        return parsed.scheme in ("http", "https") and parsed.hostname == host

    def _cors(self):
        origin = self.headers.get("Origin", "")
        if origin and self._valid_origin():
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Credentials", "true")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Learn-User")

    def send_response_only(self, code, message=None):
        self._response_status = code
        super().send_response_only(code, message)

    def end_headers(self):
        # Unread POST bytes must never become the next request line or its log.
        if (getattr(self, "_response_status", 0) >= 200
                and self.command == "POST"
                and not getattr(self, "_post_body_consumed", False)):
            self.close_connection = True
            self.send_header("Connection", "close")
        super().end_headers()

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if getattr(self, "session_cookie", None):
            self.send_header("Set-Cookie", self.session_cookie)
            self.session_cookie = None
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _session_token(self):
        try:
            cookie = SimpleCookie(self.headers.get("Cookie", ""))
            return cookie[COOKIE_NAME].value if COOKIE_NAME in cookie else ""
        except Exception:
            return ""

    def _authenticate(self):
        self.actor = self.app.accounts.authenticate(self._session_token())
        return self.actor

    def _selected_user_id(self):
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
        return (
            self.headers.get("X-Learn-User")
            or (query.get("user") or [self.actor["id"]])[0]
        )

    def _target_user(self, write=False):
        return self.app.accounts.authorize_target(
            self.actor, self._selected_user_id(), write=write
        )

    def do_GET(self):
        path = urllib.parse.urlsplit(self.path).path
        try:
            if path == "/health":
                self._json(
                    200,
                    {
                        "status": "ok",
                        "revision": self.app.release_revision(),
                        "quiz_harness_version": harness.VERSION,
                        "model": self.app.settings.llm_model,
                        "reasoning_effort": self.app.model.reasoning_effort
                        or "(unset)",
                    },
                )
                return
            if path == "/auth/session":
                try:
                    actor = self._authenticate()
                except (AccountError, JobError, material_parser.MaterialError) as error:
                    if error.status != 401:
                        raise
                    self._json(200, {"ok": True, "user": None})
                    return
                target = self._target_user()
                self._json(
                    200,
                    {
                        "ok": True,
                        "user": actor,
                        "target": target,
                        "read_only": target["id"] != actor["id"],
                    },
                )
                return
            self._authenticate()
            if path.startswith("/manim/assets/"):
                self.app.routes["manim"].get(self, path)
                return
            if path == "/state/access":
                self.app.routes["state"].get(self, path)
            elif path == "/state/all":
                target = self._target_user()
                entries = self._state_all(target["id"])
                revisions = {
                    record["key"]: record["revision"]
                    for record in self.app.repository.store.records()
                    if record["key"] in entries
                }
                self._json(
                    200,
                    {
                        "ok": True,
                        "schema_version": SCHEMA_VERSION,
                        "entries": entries,
                        "revisions": revisions,
                    },
                )
            elif path == "/jobs" or path.startswith("/jobs/"):
                target = self._target_user()
                if path == "/jobs":
                    query = urllib.parse.parse_qs(
                        urllib.parse.urlsplit(self.path).query
                    )
                    key = (query.get("key") or [None])[0]
                    if key:
                        self._authorize_key(key, write=False)
                    recent = (query.get("view") or [""])[0] == "recent"
                    jobs = (
                        self.app.jobs().recent(target["id"])
                        if recent
                        else self.app.jobs().list(target["id"], key)
                    )
                    self._json(200, {"ok": True, "jobs": jobs})
                elif path.endswith('/details'):
                    self._json(200, self.app.jobs().details(
                        path.removeprefix('/jobs/').removesuffix('/details'), target['id']))
                else:
                    self._json(
                        200,
                        {
                            "ok": True,
                            "job": self.app.jobs().get(
                                path.removeprefix("/jobs/"), target["id"]
                            ),
                        },
                    )
            elif path == "/admin/users":
                self._json(
                    200,
                    {"ok": True, "users": self.app.account_routes.overview(self.actor)},
                )
            else:
                self._json(404, {"error": "not found"})
        except (AccountError, JobError, material_parser.MaterialError) as error:
            self._json(error.status, {"ok": False, "error": str(error)})
        except (OSError, sqlite3.Error):
            self._json(503, {"ok": False, "error": "读取暂时不可用，请稍后重试"})

    def _read_body(self):
        body = read_json_body(
            self.headers,
            self.rfile,
            self.app.settings,
            getattr(self, "connection", None),
        )
        self._post_body_consumed = True
        return body

    def stream(self, messages, *, graphics_context=None):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.send_header("X-Accel-Buffering", "no")
        self.close_connection = True
        self._cors()
        self.end_headers()

        def sse(obj):
            self.wfile.write(
                ("data: " + json.dumps(obj, ensure_ascii=False) + "\n\n").encode(
                    "utf-8"
                )
            )
            self.wfile.flush()

        # Only the latest user turn determines this request's contract. Images
        # retain their original message; inspect text parts without logging them.
        latest = next((item.get("content") for item in reversed(messages)
                       if item.get("role") == "user"), "")
        question = latest if isinstance(latest, str) else "\n".join(
            item.get("text", "") for item in latest or []
            if isinstance(item, dict) and item.get("type") == "text"
        )
        require_animation = animation_requested(question)
        if require_animation:
            messages = list(messages)
            messages.insert(1, {"role": "system", "content": MANIM_TEACHING})

        gate = self.app.tutor_rendering.stream(server_graphics=True)
        cancelled = threading.Event()

        def animation():
            context = graphics_context or {}
            key, node_id = context.get("key"), context.get("node_id")
            if not isinstance(key, str) or not isinstance(node_id, str):
                raise JobError(400, "请从学习单元打开动画演示")
            self._authorize_key(key, write=True)
            material = self.app.repository.material(key)
            if material is None:
                raise JobError(404, "学习资料已删除或不存在")
            node = next((n for n in (material.get("plan") or {}).get("nodes", [])
                         if isinstance(n, dict) and n.get("id") == node_id), None)
            if node is None:
                raise JobError(404, "学习节点已删除或不存在")
            notes = ((material.get("nodeDetail") or {}).get(node_id) or {}).get("study_notes") or node.get("essence", "")
            return self.app.manim.generate(key, node_id, notes, node, actor=self.actor,
                                           cancelled=cancelled.is_set, question=question)

        def append_animation():
            # The SSE owner sends heartbeats and detects disconnection while a
            # separate bounded service call produces and checks the real media.
            done, outcome, outcome_lock = threading.Event(), [], threading.Lock()
            def work():
                try:
                    spec = animation()
                    with outcome_lock:
                        if cancelled.is_set():
                            self.app.manim.discard(spec["asset_id"])
                            spec = None
                        outcome.append((spec, None))
                        done.set()
                except Exception as error:
                    with outcome_lock:
                        outcome.append((None, error))
                        done.set()
            sse({"delta": "", "status": "正在生成并检查分步动画"})
            threading.Thread(target=work, daemon=True).start()
            try:
                while not done.wait(3):
                    sse({"delta": "", "status": "正在生成并检查分步动画"})
                spec, error = outcome[0]
                if error:
                    sse({"delta": "\n\n动画暂未生成成功，已保留讲解。请重试“动画演示”。\n"})
                    return
                sse({"delta": "\n\n" + self.app.manim.public_fence(spec) + "\n"})
            except (BrokenPipeError, ConnectionResetError):
                with outcome_lock:
                    cancelled.set()
                    if done.is_set() and outcome and outcome[0][0]:
                        self.app.manim.discard(outcome[0][0]["asset_id"])
                raise

        def delta(piece):
            for safe_piece in gate.feed(piece):
                sse({"delta": safe_piece})

        def interrupted():
            for safe_piece in gate.finish(interrupted=True):
                sse({"delta": safe_piece})

        try:
            with self.app.model.stream(messages) as resp:
                ctype = (resp.headers.get("Content-Type") or "").lower()
                if "event-stream" not in ctype:
                    data = json.loads(resp.read().decode("utf-8", "replace"))
                    text = (
                        (data.get("choices") or [{}])[0]
                        .get("message", {})
                        .get("content", "")
                    )
                    delta(text)
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
                            delta(piece)
            for safe_piece in gate.finish():
                sse({"delta": safe_piece})
            if require_animation:
                append_animation()
            sse({"done": True})
        except urllib.error.HTTPError as e:
            detail = ""
            try:
                detail = e.read().decode("utf-8", "replace")[:300]
            except Exception:
                pass
            interrupted()
            sse({"error": "upstream HTTP %s: %s" % (e.code, detail)})
        except (BrokenPipeError, ConnectionResetError):
            cancelled.set()
            # The client is gone. Do not launch a renderer or write another event.
            return
        except Exception as e:
            interrupted()
            sse({"error": "%s: %s" % (type(e).__name__, e)})

    def do_POST(self):
        self._post_body_consumed = False
        path = urllib.parse.urlsplit(self.path).path
        try:
            if not self._valid_origin():
                raise AccountError(403, "不允许的请求来源")
            if self.headers.get("Content-Type", "").split(";")[0] != "application/json":
                raise AccountError(415, "请使用application/json提交")
            if path.startswith(("/auth/", "/admin/")):
                body = self._read_body()
                if not isinstance(body, dict):
                    raise AccountError(400, "请求必须为JSON对象")
                self._auth_post(path, body)
                return
            self._authenticate()
        except (AccountError, JobError, material_parser.MaterialError) as error:
            self._json(error.status, {"ok": False, "error": str(error)})
            return
        except (OSError, sqlite3.Error):
            self._json(503, {"ok": False, "error": "保存暂时不可用，请稍后重试"})
            return
        except (ValueError, TypeError):
            self._json(400, {"ok": False, "error": "无效的JSON请求"})
            return
        routes = self.app.routes
        if path in ("/materials/parse", "/materials/quiz-draft"):
            controller = routes["materials"]
        elif path == "/jobs" or path.startswith("/jobs/"):
            controller = routes["jobs"]
        elif path in ("/state/delete", "/state/del", "/state/put", "/state/node-access"):
            controller = routes["state"]
        elif path.startswith("/path/"):
            controller = routes["path"]
        elif path == "/ask":
            controller = routes["tutor"]
        else:
            self._json(404, {"error": "not found"})
            return
        controller.post(self, path)
