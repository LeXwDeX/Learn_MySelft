#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
python3 -m unittest discover -s tests -v
node tests/test_frontend_regressions.js
node tests/test_reliability_frontend.js
node tests/test_quiz_frontend.js
node tests/test_quiz_save_state.js
node tests/test_flywheel_frontend.js
node tests/test_markdown.js
node --check learning-path/path_app.js
node --check learning-path/quiz_dialog.js
node --check home/home.js
node --check shared/user-session.js
for source in shared/*.js; do node --check "$source"; done
python3 -m compileall -q study-assistant
git diff --check
