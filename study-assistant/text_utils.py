"""Pure text and bounded conversation helpers."""

from service_limits import MAX_HISTORY_CHARS, MAX_MSG_CHARS


def clip(s, n):
    if not isinstance(s, str):
        return ""
    return s.strip()[:n]


def history_messages(history, budget_chars=MAX_HISTORY_CHARS):
    """把历史转成 messages。

    - role=summary 的条目（前端压缩后的前情摘要）作为 system 消息放在最前
    - 其余按「从新到旧」累计字符，累计到预算为止（保证绝不超 500K token 的硬上限）
    """
    if not isinstance(history, list):
        return []
    summary = None
    for m in history:
        if isinstance(m, dict) and m.get("role") == "summary" and m.get("content"):
            summary = clip(m["content"], MAX_MSG_CHARS)
    picked, used = ([], 0)
    for m in reversed(history):
        if not isinstance(m, dict):
            continue
        if m.get("role") not in ("user", "assistant"):
            continue
        c = clip(m.get("content"), MAX_MSG_CHARS)
        if not c:
            continue
        if used + len(c) > budget_chars:
            break
        used += len(c)
        picked.append({"role": m["role"], "content": c})
    picked.reverse()
    out = []
    if summary:
        out.append(
            {
                "role": "system",
                "content": "【更早对话的压缩摘要，供你延续上下文】\n" + summary,
            }
        )
    out.extend(picked)
    return out
