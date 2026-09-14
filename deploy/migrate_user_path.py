#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把状态库中无 user path 的键迁移为固定 'u0/' 前缀（幂等；部署时在 33.146 执行）。

- 状态文件格式：{"key": <原键>, "v": <值, 删除墓碑为 null>, "ts": <毫秒>}
- 只迁移「键里不含 '/'」的旧格式键；已带前缀的跳过。
- 迁移 = 以新键 sha1 新建文件 + 删除旧文件；值原样保留（含墓碑）。
"""
import hashlib
import json
import os
import sys

STATE_DIR = os.environ.get("STATE_DIR") or "/opt/study-assistant/state"
USER_PATH = "u0/"

def main():
    if not os.path.isdir(STATE_DIR):
        print("state dir not found:", STATE_DIR)
        return 1
    n = 0
    for fn in sorted(os.listdir(STATE_DIR)):
        if not fn.endswith(".json"):
            continue
        fp = os.path.join(STATE_DIR, fn)
        try:
            with open(fp, "r", encoding="utf-8") as f:
                d = json.load(f)
        except Exception as e:
            print("skip (parse):", fn, e)
            continue
        if not isinstance(d, dict):
            continue
        k = str(d.get("key") or "")
        if not k or "/" in k:
            continue  # 空键或已带前缀/段的跳过
        nk = USER_PATH + k
        nfp = os.path.join(STATE_DIR, hashlib.sha1(nk.encode("utf-8")).hexdigest() + ".json")
        if os.path.exists(nfp):
            print("skip (target exists):", k)
            continue
        d["key"] = nk
        with open(nfp, "w", encoding="utf-8") as f:
            json.dump(d, f, ensure_ascii=False)
        os.remove(fp)
        n += 1
        print("migrated:", k, "->", nk)
    print("total migrated:", n)
    return 0

if __name__ == "__main__":
    sys.exit(main())
