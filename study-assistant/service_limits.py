"""Bounded request, context, state and generation budgets."""

import re

MAX_QUESTION = 2000

# About 500K tokens, using the conservative character budget from existing clients.
MAX_HISTORY_CHARS = 1_200_000

MAX_MSG_CHARS = 8000

COMPRESS_CHUNK_CHARS = 100_000

MAX_IMAGE_B64 = 8 * 1024 * 1024

DATA_URL_RE = re.compile(
    r"^data:image/(jpeg|jpg|png|webp|gif);base64,([A-Za-z0-9+/=\s]+)$"
)

PATH_MAX_ROUNDS = 4

SEARXNG_TIMEOUT = 30

MAX_TOPIC = 2000

STATE_MAX_KEYS = 2000

STATE_MAX_VALUE = 2_000_000

# Reuse completed generations for 30 minutes. Wait below the client timeout.
GEN_CACHE_TTL = 1800

GEN_WAIT_MAX = 150
