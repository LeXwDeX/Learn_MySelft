"""HTTP clients for the model gateway and research search service."""

import json
import ssl
import urllib.error
import urllib.parse
import urllib.request
from service_limits import SEARXNG_TIMEOUT
from text_utils import clip
import model_transport


class ModelClient:
    def __init__(
        self,
        settings,
        key="",
        reasoning_effort="max",
        search_engines="brave,google cse,wikipedia",
    ):
        self.settings = settings
        self.key = key
        self.reasoning_effort = reasoning_effort
        self.think = {"reasoning_effort": reasoning_effort} if reasoning_effort else {}
        self.search_engines = search_engines

    def json(self, messages, max_tokens=None, temperature=0.7, timeout=None):
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
        raw = model_transport.post(req.full_url, payload, dict(req.header_items()),
                                   timeout or self.settings.upstream_timeout)
        data = json.loads(raw.decode("utf-8", "replace"))
        return (data.get("choices") or [{}])[0].get("message", {}).get(
            "content", ""
        ) or ""

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
            with urllib.request.urlopen(req, timeout=SEARXNG_TIMEOUT) as resp:
                data = json.loads(resp.read().decode("utf-8", "replace"))
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
