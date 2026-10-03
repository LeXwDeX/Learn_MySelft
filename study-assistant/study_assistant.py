#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Start the learning backend with one explicitly assembled application."""

import fcntl
import os
import sys

from app_config import Settings
from application import create_application


def main():
    settings = Settings.from_env()
    os.makedirs(settings.state_dir, exist_ok=True)
    writer_lock = os.open(
        os.path.join(settings.state_dir, ".writer.lock"), os.O_CREAT | os.O_RDWR, 0o600
    )
    try:
        try:
            fcntl.flock(writer_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise RuntimeError(
                "Another backend already owns this state directory"
            ) from error
        app = create_application()
        try:
            app.jobs()
            with app.server() as server:
                sys.stderr.write(
                    "study-assistant listening on 0.0.0.0:%d (model=%s, base=%s)\n"
                    % (settings.port, settings.llm_model, settings.llm_base)
                )
                server.serve_forever()
        finally:
            app.close()
    finally:
        os.close(writer_lock)


if __name__ == "__main__":
    main()
