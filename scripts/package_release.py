#!/usr/bin/env python3
"""Package declared code and public assets, excluding all runtime data and secrets."""
from __future__ import annotations
import argparse
import gzip
import hashlib
import io
import json
from pathlib import Path
import re
import subprocess
import tarfile

ROOT = Path(__file__).resolve().parents[1]


def checked_source(root: Path, relative: str) -> Path:
    path = root / relative
    if path.is_symlink() or not path.resolve().is_relative_to(root.resolve()) or not path.is_file():
        raise ValueError(f'Invalid release source: {relative}')
    return path


def collect_files(root: Path) -> dict[str, dict[str, bytes]]:
    architecture = json.loads((root / 'study-assistant/architecture.json').read_text())
    backend, site = {}, {}
    for name in architecture['modules']:
        if not re.fullmatch(r'[a-z][a-z0-9_]*\.py', name):
            raise ValueError(f'Invalid backend release module: {name}')
        backend[name] = checked_source(root, 'study-assistant/' + name).read_bytes()
    backend['architecture.json'] = checked_source(root, 'study-assistant/architecture.json').read_bytes()
    for name in ('Dockerfile', 'requirements.lock'):
        backend['manim-runtime/' + name] = checked_source(root, 'deploy/manim-runtime/' + name).read_bytes()
    shared = json.loads((root / 'shared/manifest.json').read_text())
    names = [module['source'] for module in shared['scripts']]
    names += ['ui.css', 'markdown.css', 'learning-scenes.css', 'materials.css', 'vendor-mermaid.js', 'vendor-manifest.json']
    for name in names:
        if not re.fullmatch(r'[a-zA-Z0-9_.-]+\.(js|css|json)', name):
            raise ValueError(f'Invalid shared release asset: {name}')
        site['learn/assets/' + name] = checked_source(root, 'shared/' + name).read_bytes()
    for source, target in [('index.html', 'learn/index.html'), ('home.js', 'learn/assets/home.js'), ('home.css', 'learn/assets/home.css')]:
        site[target] = checked_source(root, 'home/' + source).read_bytes()
    manifest = json.loads((root / 'learning-path/manifest.json').read_text())
    pages = ['learning-path.html', 'quiz-map.html', 'path.css', 'quiz-map.css', 'quiz-dialog.css']
    pages += [bundle['output'] for bundle in manifest['bundles']]
    for name in pages:
        if not re.fullmatch(r'[a-zA-Z0-9_.-]+\.(js|css|html)', name):
            raise ValueError(f'Invalid page release asset: {name}')
        site['diagram-design/learning-path/' + name] = checked_source(root, 'learning-path/' + name).read_bytes()
    return {'backend': backend, 'site': site}


def write_archive(path: Path, files: dict[str, bytes]):
    # Fix metadata so identical code and revision produce identical archives.
    with path.open('wb') as raw, gzip.GzipFile(filename='', mode='wb', fileobj=raw, mtime=0) as compressed:
        with tarfile.open(fileobj=compressed, mode='w') as archive:
            for name, content in sorted(files.items()):
                info = tarfile.TarInfo(name)
                info.size, info.mode, info.mtime = len(content), 0o644, 0
                archive.addfile(info, io.BytesIO(content))


def package(root: Path, output: Path, revision: str) -> dict:
    if not re.fullmatch(r'[0-9a-f]{40}', revision):
        raise ValueError('Release revision must be a full Git commit')
    files = collect_files(root)
    files['backend']['REVISION'] = (revision + '\n').encode()
    files['site']['learn/revision.json'] = (json.dumps({'revision': revision}, sort_keys=True) + '\n').encode()
    manifest = {'revision': revision, 'files': {}, 'archives': {}}
    output.mkdir(parents=True, exist_ok=True)
    for scope, contents in files.items():
        manifest['files'][scope] = {name: hashlib.sha256(content).hexdigest() for name, content in sorted(contents.items())}
        archive = output / (scope + '.tar.gz')
        write_archive(archive, contents)
        manifest['archives'][archive.name] = hashlib.sha256(archive.read_bytes()).hexdigest()
    (output / 'release.json').write_text(json.dumps(manifest, sort_keys=True, indent=2) + '\n')
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    # A package must represent a concrete committed tree, never a label on uncommitted code.
    subprocess.run(['git', '-C', str(ROOT), 'diff', '--exit-code', 'HEAD', '--quiet'], check=True)
    untracked = subprocess.check_output(['git', '-C', str(ROOT), 'ls-files', '--others', '--exclude-standard'], text=True).strip()
    if untracked:
        raise SystemExit('Commit release sources before packaging')
    revision = subprocess.check_output(['git', '-C', str(ROOT), 'rev-parse', 'HEAD'], text=True).strip()
    manifest = package(ROOT, args.output.resolve(), revision)
    print(json.dumps({'revision': revision, 'files': {scope: len(files) for scope, files in manifest['files'].items()}}))


if __name__ == '__main__':
    main()
