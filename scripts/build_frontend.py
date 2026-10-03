#!/usr/bin/env python3
"""Build the shared UI Kit and home. Page factories use the same bundle contract."""
from __future__ import annotations
import argparse
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'learning-path'))
from bundle_builder import build_bundle, load_manifest


def shared_head(manifest: dict) -> str:
    lines = ['<script src="/learn/config.js"></script>',
             '<link rel="stylesheet" href="/learn/assets/ui.css">']
    for module in manifest['scripts']:
        lines.append(f'<script src="/learn/assets/{module["source"]}"></script>')
    lines.extend(['<link rel="stylesheet" href="/learn/assets/markdown.css">',
                  '<link rel="stylesheet" href="/learn/assets/materials.css">'])
    return '\n'.join(lines)


def artifacts() -> dict[Path, str]:
    shared = json.loads((ROOT / 'shared/manifest.json').read_text())
    css = '/* Generated UI Kit. Edit shared/uikit sources and run scripts/build_frontend.py. */\n'
    css += '\n'.join((ROOT / 'shared' / source).read_text().rstrip() for source in shared['styles']['sources']) + '\n'
    result = {ROOT / 'shared' / shared['styles']['output']: css}
    for bundle in load_manifest(ROOT / 'home/manifest.json')['bundles']:
        result[ROOT / 'home' / bundle['output']] = build_bundle(ROOT / 'home', bundle)
    template = (ROOT / 'home/index_template.html').read_text()
    if template.count('__SHARED_HEAD__') != 1:
        raise ValueError('Home template requires one shared head placeholder')
    result[ROOT / 'home/index.html'] = template.replace('__SHARED_HEAD__', shared_head(shared))
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    stale = []
    for path, content in artifacts().items():
        if args.check:
            if not path.exists() or path.read_text() != content:
                stale.append(str(path.relative_to(ROOT)))
        else:
            path.write_text(content)
    if stale:
        print('Generated assets differ: ' + ', '.join(stale), file=sys.stderr)
        return 1
    print('Shared UI Kit and home ' + ('verified' if args.check else 'built'))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
