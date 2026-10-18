FROM python:3.14-slim-trixie@sha256:a2b82f3c48559aa0a8446d9af49826b6e2b2016f4cd2afabfe6013ec53729170

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    XDG_CACHE_HOME=/tmp/.cache

# Headless Mesa lavapipe provides Vulkan on CPU. ffmpeg/ffprobe normalize the
# variable-rate ManimGX capture and cut review frames inside the sandbox.
RUN apt-get update && apt-get install -y --no-install-recommends \
      libvulkan1 mesa-vulkan-drivers libegl1 libxext6 ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 manim \
    && useradd --uid 10001 --gid 10001 --create-home --shell /usr/sbin/nologin manim

# Build context is the packaged backend directory, never the runtime state directory.
COPY manimgx-runtime/requirements.lock /tmp/requirements.lock
RUN python -m pip install --no-cache-dir --require-hashes -r /tmp/requirements.lock \
    && rm /tmp/requirements.lock

RUN mkdir -p /opt/learn
COPY manim_contracts.py animation_contracts.py manim_worker.py manimgx_runtime.py manimgx_worker.py /opt/learn/
WORKDIR /opt/learn
USER 10001:10001
