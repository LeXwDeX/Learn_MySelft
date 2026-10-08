"""A worker-local execution budget; no timer thread can run business code."""

from contextlib import contextmanager
import math
import threading
import time


class JobDeadlineExceeded(TimeoutError):
    status = 504

    def __init__(self):
        super().__init__('单元生成超过执行时限，请重试')


_LOCAL = threading.local()


def budget_active():
    return getattr(_LOCAL, 'deadline', None) is not None


def check_deadline():
    deadline = getattr(_LOCAL, 'deadline', None)
    if deadline is not None and time.monotonic() >= deadline:
        raise JobDeadlineExceeded()


def remaining_timeout(phase_limit):
    deadline = getattr(_LOCAL, 'deadline', None)
    if deadline is None:
        return phase_limit
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise JobDeadlineExceeded()
    return min(phase_limit, remaining)


@contextmanager
def execution_budget(seconds):
    if not math.isfinite(seconds) or seconds <= 0:
        raise ValueError('execution budget must be positive and finite')
    previous = getattr(_LOCAL, 'deadline', None)
    deadline = time.monotonic() + seconds
    _LOCAL.deadline = min(previous, deadline) if previous is not None else deadline
    try:
        check_deadline()
        yield
    finally:
        if previous is None:
            del _LOCAL.deadline
        else:
            _LOCAL.deadline = previous
