#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
python3 -m unittest discover -s tests -v
node tests/test_frontend_regressions.js
node --check learning-path/path_app.js
node --check learning-path/quiz_dialog.js
node --check home/home.js
node --check shared/user-session.js
python3 -m py_compile study-assistant/user_accounts.py study-assistant/web_server.py
git diff --check
