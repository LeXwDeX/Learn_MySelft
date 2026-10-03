"""Bound request reads before allocating memory or waiting on a client."""

import json
from user_accounts import AccountError


def read_json_body(headers, stream, settings, connection=None):
    if headers.get("Transfer-Encoding"):
        raise AccountError(400, "不支持分块请求体")
    try:
        length = int(headers.get("Content-Length") or 0)
    except ValueError as error:
        raise AccountError(400, "无效的请求长度") from error
    if length < 0 or length > settings.max_request_bytes:
        raise AccountError(413, "请求内容过大，请缩小图片或分次提交")
    if connection is not None:
        connection.settimeout(settings.body_timeout)
    try:
        raw = stream.read(length) if length else b"{}"
    except TimeoutError as error:
        raise AccountError(408, "接收请求超时，请重试") from error
    finally:
        if connection is not None:
            connection.settimeout(None)
    if length and len(raw) != length:
        raise AccountError(400, "请求内容不完整")
    return json.loads(raw.decode("utf-8") or "{}")
