"""Release payloads contain declared code and assets, with stable content hashes."""
import importlib.util
from pathlib import Path
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('release_package', ROOT / 'scripts/package_release.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class ReleasePackageTest(unittest.TestCase):
    def test_payload_excludes_data_and_contains_external_page_assets(self):
        files = release.collect_files(ROOT)
        self.assertIn('application.py', files['backend'])
        self.assertIn('learn/assets/user-shell.js', files['site'])
        self.assertIn('diagram-design/learning-path/path_app.js', files['site'])
        self.assertIn('diagram-design/learning-path/quiz-map-app.js', files['site'])
        self.assertIn('diagram-design/learning-path/page-shell.css', files['site'])
        self.assertIn('diagram-design/learning-path/path.css', files['site'])
        for page in ('learning-path/learning-path.html', 'learning-path/quiz-map.html'):
            self.assertIn(
                '/diagram-design/learning-path/page-shell.css',
                (ROOT / page).read_text(encoding='utf-8'),
                page,
            )
        for paths in files.values():
            self.assertFalse(any('credentials' in name or 'state.sqlite' in name or 'accounts.json' in name for name in paths))
            self.assertFalse(any('modules/' in name or 'template.html' in name for name in paths))

    def test_identical_revision_produces_identical_verified_archives(self):
        with tempfile.TemporaryDirectory() as directory:
            one, two = Path(directory) / 'one', Path(directory) / 'two'
            a = release.package(ROOT, one, 'a' * 40)
            b = release.package(ROOT, two, 'a' * 40)
            self.assertEqual(a, b)
            for scope in ('backend', 'site'):
                self.assertEqual((one / (scope + '.tar.gz')).read_bytes(), (two / (scope + '.tar.gz')).read_bytes())
                with tarfile.open(one / (scope + '.tar.gz')) as archive:
                    self.assertEqual(set(archive.getnames()), set(a['files'][scope]))

    def test_source_paths_cannot_escape_or_follow_links(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'root'; root.mkdir()
            outside = Path(directory) / 'secret'; outside.write_text('sensitive')
            (root / 'alias').symlink_to(outside)
            for name in ('../secret', 'alias'):
                with self.assertRaisesRegex(ValueError, 'Invalid release source'):
                    release.checked_source(root, name)


if __name__ == '__main__':
    unittest.main()
