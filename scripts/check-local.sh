#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
python3 scripts/build_frontend.py --check
python3 learning-path/gen_path_page.py --check
python3 scripts/check_architecture.py
python3 -m unittest discover -s tests -v
node tests/test_frontend_regressions.js
node tests/test_refinement_hierarchy_frontend.js
node tests/test_reliability_frontend.js
node tests/test_quiz_frontend.js
node tests/test_quiz_save_state.js
node tests/test_flywheel_frontend.js
node tests/test_markdown.js
node tests/test_logout_recovery.js
node tests/test_ui_kit.js
node tests/test_page_module_contracts.js
node --check learning-path/path_app.js
node --check learning-path/quiz_dialog.js
node --check home/home.js
node --check shared/user-session.js
for source in shared/*.js home/modules/*.js learning-path/modules/*.js learning-path/bundle_runtime.js; do node --check "$source"; done
python3 -m compileall -q study-assistant
git diff --check
