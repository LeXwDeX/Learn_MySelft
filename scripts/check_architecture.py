#!/usr/bin/env python3
"""Verify declared runtime boundaries and generated frontend contracts."""
from __future__ import annotations
import argparse
import ast
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'learning-path'))
from bundle_builder import load_manifest, validate_bundle


def topological_order(dependencies: dict[str, list[str]]) -> list[str]:
    """Check every component, including components unreachable from an entry."""
    active, complete, ordered = [], set(), []

    def visit(name):
        if name not in dependencies:
            raise ValueError(f'Missing dependency: {name}')
        if name in active:
            raise ValueError('Circular dependency: ' + ' -> '.join(active + [name]))
        if name in complete:
            return
        active.append(name)
        for dependency in dependencies[name]:
            visit(dependency)
        active.pop()
        complete.add(name)
        ordered.append(name)

    for name in sorted(dependencies):
        visit(name)
    return ordered


def check_python(directory: Path, declaration: dict) -> dict:
    layers = declaration.get('layers', {})
    if 'modules' in declaration:
        for name, layer in declaration['modules'].items():
            layers.setdefault(layer, []).append(Path(name).stem)
    ownership = {}
    for layer, names in layers.items():
        for name in names:
            if name in ownership:
                raise ValueError(f'Module has two layers: {name}')
            ownership[name] = layer
    files = {path.stem: path for path in directory.glob('*.py')}
    if set(files) != set(ownership):
        raise ValueError(f'Python ownership differs: undeclared={sorted(set(files)-set(ownership))}; missing={sorted(set(ownership)-set(files))}')
    dependencies = {name: [] for name in files}
    standard = sys.stdlib_module_names | {'__future__'}
    for name, path in files.items():
        external = standard | set(declaration.get('external_imports', {}).get(path.name, []))
        source = path.read_text()
        tree = ast.parse(source, filename=str(path))
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                imports = [alias.name.split('.')[0] for alias in node.names]
            elif isinstance(node, ast.ImportFrom):
                imports = [node.module.split('.')[0]] if node.module else []
            else:
                continue
            for imported in imports:
                if imported not in files:
                    if imported not in external:
                        raise ValueError(f'Undeclared external or missing local import: {name} -> {imported}')
                    continue
                if imported == 'study_assistant':
                    raise ValueError(f'Runtime module imports startup entry: {name}')
                if ownership[imported] not in declaration['allowed_dependencies'][ownership[name]]:
                    raise ValueError(f'Forbidden layer dependency: {name}({ownership[name]}) -> {imported}({ownership[imported]})')
                dependencies[name].append(imported)
        if 'object.__new__(Handler)' in source or re.search(r'\b(exec|eval)\s*\(', source):
            raise ValueError(f'Dynamic code or fabricated handler: {name}')
    topological_order(dependencies)
    return {'modules': len(files), 'imports': sum(len(set(names)) for names in dependencies.values()), 'layers': {layer: len(names) for layer, names in layers.items()}}


class ResourceParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.scripts, self.styles, self.inline, self.in_script = [], [], [], False

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'style' or 'style' in attrs:
            self.inline.append('inline style')
        if tag == 'script':
            self.in_script = True
            if attrs.get('src'):
                self.scripts.append(attrs['src'])
            else:
                self.inline.append('inline script')
        if tag == 'link' and attrs.get('rel') == 'stylesheet':
            self.styles.append(attrs.get('href', ''))

    def handle_endtag(self, tag):
        if tag == 'script':
            self.in_script = False


def check_shared(directory: Path, manifest: dict) -> dict[str, list[str]]:
    by_global = {module['global']: module for module in manifest['scripts']}
    if len(by_global) != len(manifest['scripts']):
        raise ValueError('Duplicate shared global')
    dependencies = {name: [] for name in manifest['externals']}
    dependencies.update({name: module['dependencies'] for name, module in by_global.items()})
    topological_order(dependencies)
    declared_files = {module['source'] for module in manifest['scripts']}
    found = {path.name for path in directory.glob('*.js') if not path.name.startswith('vendor-')}
    if found != {name for name in declared_files if not name.startswith('vendor-')}:
        raise ValueError('Shared first-party scripts differ from manifest')
    for module in manifest['scripts']:
        source = (directory / module['source']).read_text()
        if module.get('vendor'):
            continue
        referenced = set(re.findall(r'window\.(Learn[A-Za-z]+)', source)) - {module['global']}
        if referenced - set(module['dependencies']):
            raise ValueError(f'Undeclared shared dependency: {module["source"]}: {sorted(referenced-set(module["dependencies"]))}')
    return dependencies


def check_page(path: Path, shared: dict, dependencies: dict[str, list[str]]):
    parser = ResourceParser()
    parser.feed(path.read_text())
    if parser.inline:
        raise ValueError(f'Page contains inline code/styles: {path.name}: {parser.inline}')
    seen = set()
    urls = {url: name for name, url in shared['externals'].items()}
    urls.update({'/learn/assets/' + module['source']: module['global'] for module in shared['scripts']})
    for url in parser.scripts:
        name = urls.get(url)
        if name:
            if name in seen:
                raise ValueError(f'Duplicate page dependency: {path.name}: {name}')
            missing = set(dependencies[name]) - seen
            if missing:
                raise ValueError(f'Incorrect script order: {path.name}: {name} before {sorted(missing)}')
            seen.add(name)
        elif url.endswith(('home.js', 'path_app.js', 'quiz-map-app.js', 'quiz_dialog.js')):
            missing = {'LearnUI', 'LearnUser', 'LearnSaves', 'LearnJobs', 'LearnTitles'} - seen
            if missing:
                raise ValueError(f'Page entry precedes shared dependencies: {path.name}: {sorted(missing)}')
    if '/learn/assets/ui.css' not in parser.styles:
        raise ValueError(f'Page omits the UI Kit: {path.name}')


def check_frontend(root: Path) -> dict:
    shared = json.loads((root / 'shared/manifest.json').read_text())
    dependencies = check_shared(root / 'shared', shared)
    module_count, bundle_count = 0, 0
    for directory in [root / 'home', root / 'learning-path']:
        manifest = load_manifest(directory / 'manifest.json')
        sources = set()
        for bundle in manifest['bundles']:
            modules = validate_bundle(directory, bundle)
            for module in modules:
                path = directory / module['source']
                source = path.read_text()
                read = set(re.findall(r"deps\[\s*['\"]([^'\"]+)['\"]\s*\]", source))
                if read - set(module['dependencies']):
                    raise ValueError(f'Undeclared factory dependency: {module["id"]}')
                if re.search(r'\b(eval|Function)\s*\(', source):
                    raise ValueError(f'Dynamic factory execution: {module["id"]}')
                sources.add(path.resolve())
            module_count += len(modules)
            bundle_count += 1
        actual = {path.resolve() for path in (directory / 'modules').glob('*.js')}
        if actual != sources:
            raise ValueError(f'Factory sources differ from manifest: {directory.name}')
    for relative in ['home/index.html', 'learning-path/learning-path.html', 'learning-path/quiz-map.html']:
        check_page(root / relative, shared, dependencies)
    return {'factory_modules': module_count, 'bundles': bundle_count, 'shared_modules': len(shared['scripts']), 'pages': 3}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--json', action='store_true')
    arguments = parser.parse_args()
    try:
        backend = check_python(ROOT / 'study-assistant', json.loads((ROOT / 'study-assistant/architecture.json').read_text()))
        frontend = check_frontend(ROOT)
    except (ValueError, OSError, KeyError, SyntaxError) as error:
        print(str(error), file=sys.stderr)
        return 1
    report = {'backend': backend, 'frontend': frontend, 'cycles': 0, 'missing_dependencies': 0, 'forbidden_dependencies': 0}
    print(json.dumps(report, ensure_ascii=False, indent=2) if arguments.json else 'Architecture contracts verified: ' + json.dumps(report, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
