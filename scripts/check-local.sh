#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
python3 -m unittest discover -s tests -v
node tests/test_frontend_regressions.js
node --check learning-path/path_app.js
node --check learning-path/quiz_dialog.js
git diff --check
