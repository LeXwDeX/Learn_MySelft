# -*- coding: utf-8 -*-
"""Build learning and quiz pages from markup, styles and explicit module graphs."""
from __future__ import annotations
import argparse
import hashlib
from pathlib import Path
from bundle_builder import build_bundle, load_manifest

HERE = Path(__file__).resolve().parent


def generated_files() -> dict[str, str]:
    manifest = load_manifest(HERE / 'manifest.json')
    files = {bundle['output']: build_bundle(HERE, bundle) for bundle in manifest['bundles']}
    fingerprint = hashlib.sha256(''.join(files[name] for name in sorted(files)).encode()).hexdigest()[:12]
    for template, output in [('path_template.html', 'learning-path.html'), ('quiz_map_template.html', 'quiz-map.html')]:
        document = (HERE / template).read_text(encoding='utf-8')
        if '<style' in document or '__APP_JS__' in document or '__QUIZ_DIALOG_JS__' in document:
            raise ValueError(f'Template must contain only markup and resource links: {template}')
        files[output] = document.replace('__BUILD__', fingerprint)
    return files


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', help='Check generated files without modifying them')
    arguments = parser.parse_args()
    stale = []
    for name, content in generated_files().items():
        target = HERE / name
        if arguments.check:
            if not target.exists() or target.read_text(encoding='utf-8') != content:
                stale.append(name)
        else:
            target.write_text(content, encoding='utf-8')
    if stale:
        raise SystemExit('Stale generated files: ' + ', '.join(stale))
    print('Learning and quiz bundles: ' + ('verified' if arguments.check else 'generated'))


if __name__ == '__main__':
    main()
