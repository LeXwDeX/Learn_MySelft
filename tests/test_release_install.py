"""Installer verification rejects altered, missing and unsafe release content."""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


release = load('release_for_install', 'package_release.py')
installer = load('release_installer', 'install_release.py')
sys.path.insert(0, str(ROOT / 'study-assistant'))
from application import create_application


class ReleaseInstallTest(unittest.TestCase):
    def test_health_uses_actual_http_status_and_exact_revision(self):
        with tempfile.TemporaryDirectory() as directory:
            app = create_application({'STATE_DIR': directory, 'DELETE_PASSWORD': 'test-password'})
            server = app.server(('127.0.0.1', 0))
            thread = threading.Thread(target=lambda: server.serve_forever(poll_interval=.01), daemon=True)
            thread.start()
            target = {'port': server.server_port}
            try:
                installer.wait_for_health(target, app.release_revision())
                installer.wait_for_health(target)
                with patch.object(installer.time, 'monotonic', side_effect=[0, 31]):
                    with self.assertRaisesRegex(RuntimeError, 'health/revision did not pass'):
                        installer.wait_for_health(target, 'different-release')
            finally:
                server.shutdown()
                server.server_close()
                thread.join()
                app.close()

    def test_verified_payload_and_tampered_archive(self):
        with tempfile.TemporaryDirectory() as directory:
            output, stage = Path(directory) / 'release', Path(directory) / 'stage'
            manifest = release.package(ROOT, output, 'a' * 40)
            self.assertEqual(installer.verified_payload(output, stage), manifest)
            self.assertEqual((stage / 'backend/REVISION').read_text().strip(), 'a' * 40)
            with (output / 'backend.tar.gz').open('ab') as stream:
                stream.write(b'changed')
            with self.assertRaisesRegex(ValueError, 'archive hash differs'):
                installer.verified_payload(output, Path(directory) / 'changed')

    def test_manifest_cannot_target_learning_data_or_parent_paths(self):
        for name in ('../accounts.json', 'state/state.sqlite3', 'regression-credentials/production.json'):
            self.assertFalse(installer.allowed_path('backend', name))
            self.assertFalse(installer.allowed_path('site', name))
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'release'
            manifest = release.package(ROOT, output, 'a' * 40)
            manifest['files']['backend']['../accounts.json'] = '0' * 64
            (output / 'release.json').write_text(json.dumps(manifest))
            with self.assertRaisesRegex(ValueError, 'undeclared target'):
                installer.verified_payload(output, Path(directory) / 'stage')

    def test_code_rollback_retains_runtime_data(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            target = {'backend': str(base / 'backend'), 'site': str(base / 'site')}
            Path(target['backend']).mkdir(); Path(target['site']).mkdir()
            state = Path(target['backend']) / 'state.sqlite3'; state.write_bytes(b'new learning data')
            code = Path(target['backend']) / 'application.py'; code.write_text('old code')
            backup = base / 'backup'; backup.mkdir()
            manifest = {'files': {'backend': {'application.py': '', 'new_module.py': ''}, 'site': {}}}
            present = installer.snapshot_files(target, manifest, backup)
            code.write_text('new code')
            (Path(target['backend']) / 'new_module.py').write_text('new module')
            installer.restore_files(target, {'manifest': manifest, 'present': present}, backup)
            self.assertEqual(code.read_text(), 'old code')
            self.assertFalse((Path(target['backend']) / 'new_module.py').exists())
            self.assertEqual(state.read_bytes(), b'new learning data')


if __name__ == '__main__':
    unittest.main()
