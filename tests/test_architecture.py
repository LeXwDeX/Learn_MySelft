"""Architecture rules reject malformed dependency graphs and page load contracts."""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('architecture_check', ROOT / 'scripts/check_architecture.py')
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)


class ArchitectureTest(unittest.TestCase):
    def test_full_runtime(self):
        backend = gate.check_python(ROOT / 'study-assistant', json.loads((ROOT / 'study-assistant/architecture.json').read_text()))
        frontend = gate.check_frontend(ROOT)
        self.assertGreater(backend['modules'], 30)
        self.assertEqual(frontend['bundles'], 4)

    def test_unreachable_cycles_and_missing_dependencies(self):
        self.assertEqual(gate.topological_order({'entry': ['model'], 'model': []}), ['model', 'entry'])
        with self.assertRaisesRegex(ValueError, 'Circular dependency'):
            gate.topological_order({'entry': [], 'unused': ['other'], 'other': ['unused']})
        with self.assertRaisesRegex(ValueError, 'Missing dependency'):
            gate.topological_order({'entry': ['misspelled']})

    def fixture(self, sources, declaration):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        root = Path(directory.name)
        for name, source in sources.items():
            (root / (name + '.py')).write_text(source)
        return gate.check_python(root, copy.deepcopy(declaration))

    def test_python_cycles_layer_violation_and_unowned_files(self):
        declaration = {'modules': {'a': 'domain', 'b': 'http'}, 'allowed_dependencies': {'domain': ['domain'], 'http': ['domain', 'http']}}
        with self.assertRaisesRegex(ValueError, 'Forbidden layer dependency'):
            self.fixture({'a': 'import b', 'b': ''}, declaration)
        declaration['allowed_dependencies']['domain'].append('http')
        with self.assertRaisesRegex(ValueError, 'Circular dependency'):
            self.fixture({'a': 'import b', 'b': 'import a'}, declaration)
        with self.assertRaisesRegex(ValueError, 'ownership differs'):
            self.fixture({'a': '', 'b': '', 'hidden': ''}, declaration)
        with self.assertRaisesRegex(ValueError, 'missing local import'):
            self.fixture({'a': 'import renamed_module', 'b': ''}, declaration)

    def test_domain_cannot_import_entry_or_fabricate_handler(self):
        declaration = {'modules': {'domain': 'domain', 'study_assistant': 'composition'}, 'allowed_dependencies': {'domain': ['domain', 'composition'], 'composition': ['domain']}}
        with self.assertRaisesRegex(ValueError, 'startup entry'):
            self.fixture({'domain': 'import study_assistant', 'study_assistant': ''}, declaration)
        with self.assertRaisesRegex(ValueError, 'fabricated handler'):
            self.fixture({'domain': 'handler = object.__new__(Handler)', 'study_assistant': ''}, declaration)

    def test_page_load_order_and_inline_business_code(self):
        shared = json.loads((ROOT / 'shared/manifest.json').read_text())
        dependencies = gate.check_shared(ROOT / 'shared', shared)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'page.html'
            for markup, reason in [
                ('<script src="/learn/assets/user-session.js"></script>', 'Incorrect script order'),
                ('<script src="/learn/assets/home.js"></script>', 'entry precedes'),
                ('<script>startBusiness()</script>', 'inline code'),
                ('<div style="color:red"></div>', 'inline code'),
            ]:
                path.write_text(markup)
                with self.assertRaisesRegex(ValueError, reason):
                    gate.check_page(path, shared, dependencies)


if __name__ == '__main__':
    unittest.main()
