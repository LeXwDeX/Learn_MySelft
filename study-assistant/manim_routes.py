"""Authenticated, bounded Manim media delivery with single byte ranges."""

import os
import re
import stat

from background_jobs import JobError


def byte_range(header, size):
    if not header:
        return 0, size - 1, False
    match = re.fullmatch(r"bytes=(\d*)-(\d*)", header)
    if not match or not any(match.groups()):
        raise ValueError("invalid range")
    first, last = match.groups()
    if not first:
        suffix = int(last)
        if suffix <= 0:
            raise ValueError("invalid suffix")
        start, end = max(0, size - suffix), size - 1
    else:
        start, end = int(first), min(int(last), size - 1) if last else size - 1
    if start >= size or start > end or size <= 0:
        raise ValueError("unsatisfiable range")
    return start, end, True


class ManimRoutes:
    def __init__(self, service):
        self.service = service

    def get(self, request, path):
        match = re.fullmatch(r"/manim/assets/([0-9a-f]{32})/(manifest|video\.mp4|poster\.png|step-[0-7]\.png)", path)
        if not match:
            raise JobError(404, "动画资源不存在")
        target = request._target_user()
        asset, content_type = self.service.asset(request.actor, target["id"], *match.groups())
        descriptor = os.open(asset, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        with os.fdopen(descriptor, "rb") as source:
            info = os.fstat(source.fileno())
            if not stat.S_ISREG(info.st_mode) or not 0 < info.st_size <= 32 * 1024 * 1024:
                raise JobError(404, "动画资源不可用")
            try:
                start, end, partial = byte_range(request.headers.get("Range"), info.st_size)
            except (ValueError, OverflowError):
                request.send_response(416)
                request.send_header("Content-Range", "bytes */%d" % info.st_size)
                request.send_header("Content-Length", "0")
                request.send_header("Cache-Control", "private, no-store")
                request._cors()
                request.end_headers()
                return
            request.send_response(206 if partial else 200)
            request.send_header("Content-Type", content_type)
            request.send_header("Content-Length", str(end - start + 1))
            request.send_header("Accept-Ranges", "bytes")
            request.send_header("Cache-Control", "private, no-store")
            request.send_header("X-Content-Type-Options", "nosniff")
            if partial:
                request.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, info.st_size))
            request._cors()
            request.end_headers()
            source.seek(start)
            remaining = end - start + 1
            try:
                while remaining:
                    piece = source.read(min(65536, remaining))
                    if not piece:
                        break
                    request.wfile.write(piece)
                    remaining -= len(piece)
            except (BrokenPipeError, ConnectionResetError):
                return
