"""HTTP clients for the model gateway and research search service."""

import json
import ssl
import secrets
import urllib.error
import urllib.parse
import urllib.request
from service_limits import SEARXNG_TIMEOUT
from text_utils import clip
import model_transport
from job_execution import JobDeadlineExceeded, check_deadline


class ModelClient:
    def __init__(
        self,
        settings,
        key="",
        reasoning_effort="max",
        search_engines="brave,google cse,wikipedia",
        *, detail_store=None,
    ):
        self.settings = settings
        self.key = key
        self.reasoning_effort = reasoning_effort
        self.think = {"reasoning_effort": reasoning_effort} if reasoning_effort else {}
        self.search_engines = search_engines
        self.detail_store = detail_store

    def _event(self, kind, label, **fields):
        try:
            if self.detail_store is not None:
                if kind == 'phase' and getattr(self.detail_store.local, 'job_id', None):
                    self.detail_store.local.phase = label
                self.detail_store.job_event(kind, label, known_secrets=(self.key,), **fields)
        except Exception:
            pass

    def json(self, messages, max_tokens=None, temperature=0.7, timeout=None, *, reasoning_effort=None, response_format=None):
        if reasoning_effort is not None and (not isinstance(reasoning_effort, str)
                or reasoning_effort not in ('none', 'low', 'medium', 'high', 'max')):
            raise ValueError('invalid request reasoning effort')
        if response_format is not None and response_format != 'json_object':
            raise ValueError('invalid request response format')
        max_tokens = (
            self.settings.max_output_tokens if max_tokens is None else max_tokens
        )
        body = {
            "model": self.settings.llm_model,
            "messages": messages,
            "stream": False,
            "temperature": temperature,
            "max_tokens": max_tokens,
        }
        body.update(self.think)
        if reasoning_effort is not None:
            body['reasoning_effort'] = reasoning_effort
        if response_format is not None:
            body['response_format'] = {'type': response_format}
        payload = json.dumps(body).encode("utf-8")
        req = urllib.request.Request(
            self.settings.llm_base.rstrip("/") + "/chat/completions",
            data=payload,
            headers={
                "Content-Type": "application/json",
                "Authorization": "Bearer " + self.key,
            },
            method="POST",
        )
        check_deadline()
        call_id = secrets.token_hex(8)
        # Record only actual role/content messages. Hidden reasoning and gateway
        # envelope fields are never copied into the task database.
        recorded = [{'role': item.get('role', ''), 'content': item.get('content', '')}
                    for item in messages if isinstance(item, dict) and item.get('role') in ('system', 'user', 'assistant', 'tool')]
        self._event('model_request', '向模型发送请求', call_id=call_id, messages=recorded)
        try:
            raw = model_transport.post(req.full_url, payload, dict(req.header_items()),
                                       timeout or self.settings.upstream_timeout)
            data = json.loads(raw.decode("utf-8", "replace"))
            content = (data.get("choices") or [{}])[0].get("message", {}).get("content", "") or ""
            self._event('model_response', '模型最终回复', call_id=call_id, content=content)
            check_deadline()
            return content
        except Exception as error:
            category = ('deadline' if isinstance(error, JobDeadlineExceeded) else
                        'remote_api' if isinstance(error, urllib.error.HTTPError) else
                        'network' if isinstance(error, (TimeoutError, urllib.error.URLError)) else 'program')
            fields = {'call_id': call_id, 'error_category': category}
            if isinstance(error, urllib.error.HTTPError):
                fields['http_status'] = error.code
            self._event('model_error', '模型请求未完成', **fields)
            raise

    def stream(self, messages):
        body = {
            "model": self.settings.llm_model,
            "messages": messages,
            "stream": True,
            "temperature": 0.3,
            "max_tokens": self.settings.max_output_tokens,
        }
        body.update(self.think)
        payload = json.dumps(body).encode("utf-8")
        req = urllib.request.Request(
            self.settings.llm_base.rstrip("/") + "/chat/completions",
            data=payload,
            headers={
                "Content-Type": "application/json",
                "Authorization": "Bearer " + self.key,
                "Accept": "text/event-stream",
            },
            method="POST",
        )
        ctx = ssl.create_default_context()
        return urllib.request.urlopen(
            req, timeout=self.settings.upstream_timeout, context=ctx
        )

    def nonempty(self, msgs, tries=2, **kw):
        """模型偶发返回空正文（max 档思考吃满预算），空则重试一次。"""
        t = ""
        for _ in range(max(1, tries)):
            t = self.json(msgs, **kw)
            if (t or "").strip():
                return t
        return t or ""

    def search(self, query, n=5):
        """Use this app's engine selection without changing the shared instance."""
        q = clip(query, 300)
        if not q:
            return []
        params = {"q": q, "format": "json", "engines": self.search_engines}
        url = (
            self.settings.searxng_base.rstrip("/")
            + "/search?"
            + urllib.parse.urlencode(params)
        )
        try:
            req = urllib.request.Request(
                url, headers={"User-Agent": "study-assistant/1.1"}
            )
            self._event('phase', '请求搜索服务')
            data = json.loads(model_transport.post(req.full_url, None, dict(req.header_items()),
                                                  SEARXNG_TIMEOUT, method='GET').decode('utf-8', 'replace'))
        except JobDeadlineExceeded:
            raise
        except Exception as error:
            raise RuntimeError("搜索服务暂时不可用，请重试研究") from error
        if not isinstance(data, dict) or not isinstance(data.get("results"), list):
            raise RuntimeError("搜索服务返回格式异常，请重试研究")
        if not data["results"] and data.get("unresponsive_engines"):
            raise RuntimeError("搜索引擎暂时不可用，请重试研究")
        out = []
        for r in data.get("results") or []:
            if not isinstance(r, dict):
                continue
            u = (r.get("url") or "").strip()
            if not u:
                continue
            out.append(
                {
                    "title": clip(r.get("title") or u, 200),
                    "url": u,
                    "snippet": clip(r.get("content") or "", 400),
                }
            )
            if len(out) >= n:
                break
        return out
