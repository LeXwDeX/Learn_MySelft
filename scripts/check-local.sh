#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
if [ -n "${PYTHON:-}" ]; then
  test_python=$PYTHON
elif [ -x .venv/bin/python ]; then
  test_python=.venv/bin/python
else
  test_python=python3
fi
if ! command -v "$test_python" >/dev/null 2>&1; then
  printf '%s\n' "缺少 Python：${test_python}。请按 README 的本地测试步骤创建 .venv。" >&2
  exit 1
fi
"$test_python" - <<'PY'
import sys

if sys.version_info < (3, 10):
    raise SystemExit("本地测试需要 Python 3.10+；建议按 README 使用 Python 3.12 创建 .venv。")
try:
    import py7zr
    from py7zr.io import Py7zIO, WriterFactory
except ImportError as exc:
    raise SystemExit(
        "缺少或无法加载 py7zr 测试依赖。请按 README 创建 .venv，并运行：\n"
        ".venv/bin/python -m pip install --require-hashes -r requirements-test.txt\n"
        f"当前解释器：{sys.executable}\n原因：{exc}"
    ) from None
print(f"测试环境：Python {sys.version.split()[0]} ({sys.executable})；py7zr {py7zr.__version__}")
PY
for tool in node ffmpeg; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    printf '%s\n' "缺少测试工具：${tool}。请按 README 的本地测试步骤安装后重试。" >&2
    exit 1
  fi
done
node --version
ffmpeg -version >/dev/null
"$test_python" scripts/build_frontend.py --check
"$test_python" learning-path/gen_path_page.py --check
"$test_python" scripts/check_architecture.py
"$test_python" -m unittest discover -s tests -v
node tests/test_frontend_regressions.js
node tests/test_refinement_hierarchy_frontend.js
node tests/test_reliability_frontend.js
node tests/test_generation_stages_frontend.js
node tests/test_job_details_frontend.js
node tests/test_quiz_frontend.js
node tests/test_quiz_save_state.js
node tests/test_flywheel_frontend.js
node tests/test_markdown.js
node tests/test_learning_scenes.js
node tests/test_manim_player.cjs
node tests/test_scene_supplement_frontend.js
node tests/test_logout_recovery.js
node tests/test_ui_kit.js
node tests/test_account_dialog.js
node tests/test_page_module_contracts.js
node tests/test_home_recovery.js
node tests/test_path_library_recovery.js
node tests/test_quiz_catalog_recovery.js
node --check learning-path/path_app.js
node --check learning-path/quiz_dialog.js
node --check home/home.js
node --check shared/user-session.js
for source in shared/*.js home/modules/*.js learning-path/modules/*.js learning-path/bundle_runtime.js; do node --check "$source"; done
"$test_python" -m compileall -q study-assistant
git diff --check
