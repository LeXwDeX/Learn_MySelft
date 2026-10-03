"""Instance-owned cache and single-flight generation gates."""

import threading
import time
from service_limits import GEN_CACHE_TTL


class GenerationCache:
    def __init__(self):
        self.lock = threading.Lock()
        self.gates = {}
        self.results = {}

    def get(self, key, ttl=GEN_CACHE_TTL):
        now = time.time()
        with self.lock:
            hit = self.results.get(key)
            if hit and now - hit[1] < ttl:
                return hit[0]
            if hit:
                self.results.pop(key, None)
        return None

    def put(self, key, out):
        with self.lock:
            self.results[key] = (out, time.time())
            if len(self.results) > 300:
                for k, _ in sorted(self.results.items(), key=lambda kv: kv[1][1])[:100]:
                    self.results.pop(k, None)

    def join(self, key):
        """并发单飞：返回 (gate, owner)。owner=True 的请求负责生成，然后 `_gen_gate_finish`。"""
        now = time.time()
        with self.lock:
            g = self.gates.get(key)
            if g is not None and (not g["owner"].is_alive()):
                g = None
            if g is None:
                g = {
                    "ev": threading.Event(),
                    "out": None,
                    "err": None,
                    "ts": now,
                    "owner": threading.current_thread(),
                }
                self.gates[key] = g
                return (g, True)
        return (g, False)

    def finish(self, key, gate, out=None, err=None):
        """收口单飞闸门：所有等待者拿到同一结果。"""
        gate["out"], gate["err"] = (out, err)
        with self.lock:
            if self.gates.get(key) is gate:
                self.gates.pop(key, None)
        gate["ev"].set()
