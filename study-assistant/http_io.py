"""Bound request reads before allocating memory or waiting on a client."""

import json
import re
from user_accounts import AccountError


def read_json_body(headers, stream, settings, connection=None):
    if "Transfer-Encoding" in headers:
        raise AccountError(400, "不支持分块请求体")
    lengths = headers.get_all("Content-Length", [])
    if not lengths:
        raise AccountError(411, "请求必须提供内容长度")
    if len(lengths) != 1 or not re.fullmatch(r"[0-9]+", lengths[0]):
        raise AccountError(400, "无效的请求长度")
    # Compare decimal strings first, avoiding unbounded integer conversion.
    normalized = lengths[0].lstrip("0") or "0"
    limit = str(settings.max_request_bytes)
    if len(normalized) > len(limit) or (len(normalized) == len(limit) and normalized > limit):
        raise AccountError(413, "请求内容过大，请缩小图片或分次提交")
    length = int(normalized)
    if not length:
        raise AccountError(400, "请求必须包含JSON内容")
    if connection is not None:
        connection.settimeout(settings.body_timeout)
    try:
        raw = stream.read(length)
    except TimeoutError as error:
        raise AccountError(408, "接收请求超时，请重试") from error
    finally:
        if connection is not None:
            connection.settimeout(None)
    if len(raw) != length:
        raise AccountError(400, "请求内容不完整")
    return json.loads(raw.decode("utf-8"))
