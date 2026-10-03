#!/usr/bin/env python3
"""Install verified code/assets on the existing test or production host.

Run on the server as root. Preserve the running environment and learning data.
Back up data with the existing SQLite backup tool while the backend is stopped.
Rollback restores code/assets and retains subsequent learning writes.
"""
from __future__ import annotations
import argparse
import ast
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request

TARGETS = {
    'test': {'backend': '/tmp/e2e-backend', 'site': '/tmp/e2e-site', 'port': 8111, 'service': None},
    'production': {'backend': '/opt/study-assistant', 'site': '/DATA/AppData/zixueshe-web', 'port': 8101, 'service': 'study-assistant'},
}


def allowed_path(scope, name):
    if scope == 'backend':
        return name in {'REVISION', 'architecture.json'} or bool(re.fullmatch(r'[a-z][a-z0-9_]*\.py', name))
    if scope == 'site':
        return name in {'learn/index.html', 'learn/revision.json'} or bool(re.fullmatch(r'(?:learn/assets|diagram-design/learning-path)/[A-Za-z0-9_.-]+\.(?:js|css|html|json)', name))
    return False


def verified_payload(release_directory: Path, staging: Path):
    manifest = json.loads((release_directory / 'release.json').read_text())
    if not re.fullmatch(r'[0-9a-f]{40}', manifest['revision']) or set(manifest['files']) != {'backend', 'site'}:
        raise ValueError('Invalid release manifest')
    required = {'backend': {'study_assistant.py', 'application.py', 'backup_state.py', 'REVISION'},
                'site': {'learn/index.html', 'learn/revision.json', 'learn/assets/user-shell.js', 'diagram-design/learning-path/path_app.js'}}
    for scope, files in manifest['files'].items():
        if not required[scope] <= set(files) or any(not allowed_path(scope, name) for name in files):
            raise ValueError('Release contains an undeclared target or omits an entry')
        archive_path = release_directory / (scope + '.tar.gz')
        if hashlib.sha256(archive_path.read_bytes()).hexdigest() != manifest['archives'][archive_path.name]:
            raise ValueError('Release archive hash differs')
        with tarfile.open(archive_path) as archive:
            members = archive.getmembers()
            if len(members) != len(files) or {member.name for member in members} != set(files):
                raise ValueError('Archive members differ from manifest')
            for member in members:
                if not member.isfile() or member.size > 30 * 1024 * 1024:
                    raise ValueError('Invalid archive member')
                source = archive.extractfile(member)
                content = source.read()
                if hashlib.sha256(content).hexdigest() != files[member.name]:
                    raise ValueError('Release source hash differs')
                target = staging / scope / member.name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(content)
    if (staging / 'backend/REVISION').read_text().strip() != manifest['revision']:
        raise ValueError('Backend revision differs')
    if json.loads((staging / 'site/learn/revision.json').read_text())['revision'] != manifest['revision']:
        raise ValueError('Site revision differs')
    return manifest


def running_environment(target):
    if target['service']:
        pid = int(subprocess.check_output(['systemctl', 'show', target['service'], '--property=MainPID', '--value'], text=True).strip())
    else:
        script = str(Path(target['backend']) / 'study_assistant.py').encode()
        matches = []
        for path in Path('/proc').iterdir():
            if not path.name.isdigit():
                continue
            try:
                if script in (path / 'cmdline').read_bytes().split(b'\0'):
                    matches.append(int(path.name))
            except OSError:
                continue
        if len(matches) != 1:
            raise RuntimeError('Expected one existing test backend')
        pid = matches[0]
    if not pid:
        raise RuntimeError('Backend is not running; inspect its saved environment')
    environment = dict(part.split(b'=', 1) for part in Path(f'/proc/{pid}/environ').read_bytes().split(b'\0') if b'=' in part)
    environment = {key.decode(): value.decode() for key, value in environment.items()}
    if int(environment.get('PORT', 8101)) != target['port']:
        raise RuntimeError('Running environment belongs to another port')
    state = Path(environment.get('STATE_DIR', str(Path(target['backend']) / 'state')))
    if not (state / 'state.sqlite3').is_file():
        raise RuntimeError('Expected existing authoritative SQLite data')
    return pid, environment, state


def verify_existing_backend(target, manifest):
    """Reject an incomplete rollback source before stopping its running process."""
    modules = {Path(name).stem: name for name in manifest['files']['backend'] if name.endswith('.py')}
    for name in ('study_assistant.py', 'backup_state.py'):
        if not destination(target, 'backend', name).is_file():
            raise RuntimeError('Current backend is missing required source: ' + name)
    for name in modules.values():
        path = destination(target, 'backend', name)
        if not path.is_file():
            continue  # Modules newly introduced by this release need no old snapshot.
        try:
            tree = ast.parse(path.read_text(), filename=name)
        except (OSError, UnicodeError, SyntaxError):
            raise RuntimeError('Current backend has unreadable or invalid source: ' + name) from None
        imports = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                imports.update(alias.name.split('.')[0] for alias in node.names)
            elif isinstance(node, ast.ImportFrom) and node.module:
                imports.add(node.module.split('.')[0])
        for dependency in sorted(imports & modules.keys()):
            if not destination(target, 'backend', modules[dependency]).is_file():
                raise RuntimeError('Current backend dependency is missing: ' + name + ' -> ' + modules[dependency])


def wait_for_idle(state, seconds=300):
    deadline = time.monotonic() + seconds
    while True:
        with sqlite3.connect(f'file:{state / "state.sqlite3"}?mode=ro', uri=True) as database:
            count = database.execute("SELECT COUNT(*) FROM jobs WHERE status IN ('queued','running')").fetchone()[0]
        if not count:
            return
        if time.monotonic() >= deadline:
            raise RuntimeError('Backend still has active jobs; release was not installed')
        time.sleep(2)


def stop_backend(target, pid):
    if target['service']:
        subprocess.run(['systemctl', 'stop', target['service']], check=True)
    else:
        os.kill(pid, signal.SIGTERM)
        deadline = time.monotonic() + 20
        while Path(f'/proc/{pid}').exists():
            if time.monotonic() >= deadline:
                raise RuntimeError('Test backend did not stop')
            time.sleep(.1)


def start_backend(target, environment, log):
    if target['service']:
        subprocess.run(['systemctl', 'start', target['service']], check=True)
    else:
        with log.open('ab') as output:
            subprocess.Popen([sys.executable, str(Path(target['backend']) / 'study_assistant.py')], cwd=target['backend'], env=environment,
                             stdout=output, stderr=output, start_new_session=True)


def destination(target, scope, name):
    root = Path(target[scope])
    path = root / name
    if not allowed_path(scope, name) or not path.resolve().is_relative_to(root.resolve()):
        raise ValueError('Release target escapes its code/static directory')
    return path


def snapshot_files(target, manifest, backup):
    present = {'backend': [], 'site': []}
    for scope, files in manifest['files'].items():
        for name in files:
            source = destination(target, scope, name)
            if source.exists():
                saved = backup / 'files' / scope / name
                saved.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, saved)
                present[scope].append(name)
    return present


def apply_files(target, manifest, staging):
    for scope, files in manifest['files'].items():
        for name, expected in files.items():
            path = destination(target, scope, name)
            path.parent.mkdir(parents=True, exist_ok=True)
            temporary = path.with_name(path.name + '.release-new')
            shutil.copyfile(staging / scope / name, temporary)
            temporary.chmod(0o644)
            os.replace(temporary, path)
            if hashlib.sha256(path.read_bytes()).hexdigest() != expected:
                raise RuntimeError('Installed source hash differs')


def restore_files(target, record, backup):
    for scope, files in record['manifest']['files'].items():
        for name in files:
            path = destination(target, scope, name)
            if name in record['present'][scope]:
                shutil.copy2(backup / 'files' / scope / name, path)
            else:
                path.unlink(missing_ok=True)


def wait_for_health(target, revision=None):
    deadline = time.monotonic() + 30
    while True:
        try:
            with urllib.request.urlopen(f'http://127.0.0.1:{target["port"]}/health', timeout=2) as response:
                result = json.load(response)
            if result.get('status') == 'ok' and (revision is None or result.get('revision') == revision):
                return
        except (OSError, ValueError):
            pass
        if time.monotonic() >= deadline:
            raise RuntimeError('Backend health/revision did not pass')
        time.sleep(.3)


def install(environment, release_directory):
    target = TARGETS[environment]
    with tempfile.TemporaryDirectory(prefix='learn-release-') as temporary:
        staging = Path(temporary)
        manifest = verified_payload(release_directory, staging)
        verify_existing_backend(target, manifest)
        pid, settings, state = running_environment(target)
        production_state = Path('/opt/study-assistant/state').resolve()
        if (environment == 'test' and state.resolve() == production_state) or (environment == 'production' and state.resolve() != production_state):
            raise RuntimeError('Environment data isolation does not match')
        wait_for_idle(state)
        backup = Path('/opt/study-assistant/backups/modular-uikit') / (time.strftime('%Y%m%d-%H%M%S') + '-' + environment + '-' + manifest['revision'][:12])
        backup.mkdir(parents=True, mode=0o700)
        config = backup / 'environment.json'
        config.write_text(json.dumps(settings)); config.chmod(0o600)
        present = snapshot_files(target, manifest, backup)
        record = {'environment': environment, 'state_dir': str(state), 'manifest': manifest, 'present': present}
        (backup / 'rollback.json').write_text(json.dumps(record, indent=2))
        stop_backend(target, pid)
        try:
            subprocess.run([sys.executable, str(Path(target['backend']) / 'backup_state.py'), str(state), str(backup / 'data')], check=True, stdout=subprocess.DEVNULL)
            apply_files(target, manifest, staging)
            start_backend(target, settings, backup / 'backend.log')
            wait_for_health(target, manifest['revision'])
        except Exception:
            # A newly started process may need stopping before its files are restored.
            try:
                new_pid, _, _ = running_environment(target)
                stop_backend(target, new_pid)
            except (RuntimeError, ProcessLookupError):
                pass
            restore_files(target, record, backup)
            start_backend(target, settings, backup / 'rollback.log')
            wait_for_health(target)
            raise
    print(json.dumps({'environment': environment, 'revision': manifest['revision'], 'backup': str(backup), 'health': 'passed', 'files_verified': sum(len(files) for files in manifest['files'].values())}))


def rollback(environment, backup):
    target = TARGETS[environment]
    record = json.loads((backup / 'rollback.json').read_text())
    if record['environment'] != environment:
        raise ValueError('Rollback belongs to another environment')
    pid, _, state = running_environment(target)
    if str(state) != record['state_dir']:
        raise ValueError('Rollback data directory differs')
    wait_for_idle(state)
    settings = json.loads((backup / 'environment.json').read_text())
    stop_backend(target, pid)
    restore_files(target, record, backup)
    start_backend(target, settings, backup / 'rollback.log')
    wait_for_health(target)
    print(json.dumps({'environment': environment, 'rollback': 'passed', 'learning_data': 'retained'}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--environment', choices=TARGETS, required=True)
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument('--release-dir', type=Path)
    action.add_argument('--rollback', type=Path)
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise SystemExit('Install on the deployment host as root')
    if args.rollback:
        rollback(args.environment, args.rollback.resolve())
    else:
        install(args.environment, args.release_dir.resolve())


if __name__ == '__main__':
    main()
