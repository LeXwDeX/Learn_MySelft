FROM python:3.12.3-slim-bookworm@sha256:afc139a0a640942491ec481ad8dda10f2c5b753f5c969393b12480155fe15a63

ENV DEBIAN_FRONTEND=noninteractive \
    LIBGL_ALWAYS_SOFTWARE=1 \
    MESA_LOADER_DRIVER_OVERRIDE=llvmpipe \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONDONTWRITEBYTECODE=1

RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential pkg-config ffmpeg xvfb xauth \
      libpango1.0-dev libcairo2-dev libgl1 libglx0 libegl1 libgles2 \
      libgl1-mesa-dri libglx-mesa0 libegl-mesa0 libglib2.0-0 \
      libsm6 libxext6 libxrender1 libx11-6 fontconfig fonts-noto-cjk ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 manim \
    && useradd --uid 10001 --gid 10001 --create-home --shell /usr/sbin/nologin manim

# Build context is the packaged backend directory, never the runtime state directory.
COPY manim-runtime/requirements.lock /tmp/requirements.lock
RUN python -m pip install --no-cache-dir --require-hashes -r /tmp/requirements.lock \
    && rm /tmp/requirements.lock

RUN mkdir -p /opt/learn
COPY manim_worker.py manim_contracts.py /opt/learn/
WORKDIR /opt/learn
USER 10001:10001
