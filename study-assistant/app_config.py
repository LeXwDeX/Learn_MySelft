"""Validated runtime settings; secrets never appear in public configuration."""
from dataclasses import dataclass
import os
from pathlib import Path
from urllib.parse import urlsplit


def integer(env, name, default, minimum, maximum):
    try:
        value = int(env.get(name, default))
    except (TypeError, ValueError) as error:
        raise ValueError(name + ' must be an integer') from error
    if not minimum <= value <= maximum:
        raise ValueError('%s must be between %s and %s' % (name, minimum, maximum))
    return value


def endpoint(value, name):
    parsed = urlsplit(value)
    if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError(name + ' must be an HTTP(S) URL without embedded credentials')
    if parsed.query or parsed.fragment:
        raise ValueError(name + ' cannot contain a query or fragment')
    return value.rstrip('/')


@dataclass(frozen=True)
class Settings:
    port: int
    state_dir: str
    llm_base: str
    llm_model: str
    upstream_timeout: int
    max_output_tokens: int
    max_request_bytes: int
    body_timeout: int
    job_workers: int
    job_queue_limit: int
    searxng_base: str

    @classmethod
    def from_env(cls, env=None):
        env = os.environ if env is None else env
        model = env.get('LLM_MODEL', 'deepseek').strip()
        if not model:
            raise ValueError('LLM_MODEL cannot be empty')
        return cls(
            port=integer(env, 'PORT', 8101, 1, 65535),
            state_dir=str(Path(env.get('STATE_DIR', Path(__file__).resolve().parent / 'state')).expanduser().absolute()),
            llm_base=endpoint(env.get('LLM_BASE', 'http://192.168.33.110:8000/v1'), 'LLM_BASE'),
            llm_model=model,
            upstream_timeout=integer(env, 'UPSTREAM_TIMEOUT', 180, 5, 900),
            max_output_tokens=integer(env, 'MAX_OUTPUT_TOKENS', 393216, 1024, 393216),
            max_request_bytes=integer(env, 'MAX_REQUEST_BYTES', 16 * 1024 * 1024, 1024, 64 * 1024 * 1024),
            body_timeout=integer(env, 'BODY_TIMEOUT', 30, 1, 120),
            job_workers=integer(env, 'JOB_WORKERS', 2, 1, 8),
            job_queue_limit=integer(env, 'JOB_QUEUE_LIMIT', 64, 1, 1000),
            searxng_base=endpoint(env.get('SEARXNG_BASE', 'http://192.168.33.146:8103'), 'SEARXNG_BASE'),
        )
