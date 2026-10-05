"""Scene source survives node normalization while both text budgets stay bounded."""
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'study-assistant'))
from generation_contracts import _norm_node_detail


class LearningSceneStorageTests(unittest.TestCase):
    def test_four_complete_scenes_survive_without_rewriting_source(self):
        scene = {'version': 1, 'type': 'linear_transform', 'title': '列向量',
                 'summary': '比较基底和结果。', 'matrix': [[2, 1], [1, 2]], 'vector': [1, 1]}
        raw = json.dumps(scene, ensure_ascii=False) + ' ' * 11600
        self.assertLessEqual(len(raw), 12000)
        fence = '```learn-scene\n' + raw + '\n```'
        notes = '引导文字。\n\n' + '\n\n'.join([fence] * 4) + '\n\n观察后再作答。'
        self.assertGreater(len(notes), 3000)
        self.assertLess(len(notes), 50000)
        result = _norm_node_detail({'study_notes': notes})
        self.assertEqual(result['study_notes'], notes)
        self.assertEqual(result['study_notes'].count('```learn-scene'), 4)
        # The existing legacy alias remains compatible with the same source.
        self.assertEqual(_norm_node_detail({'notes': notes})['study_notes'], notes)

    def test_plain_text_and_other_code_keep_existing_budget(self):
        for source in ('字' * 6000, '```mermaid\n' + 'A' * 6000 + '\n```'):
            with self.subTest(prefix=source[:12]):
                self.assertEqual(len(_norm_node_detail({'study_notes': source})['study_notes']), 3000)

    def test_scene_budget_is_hard_and_does_not_repair_incomplete_fences(self):
        for marker in ('```learn-scene\n', '~~~learn-scene\n', '````learn-scene\n'):
            with self.subTest(marker=marker):
                source = marker + '{"title":"' + '字' * 60000 + '"}\n' + marker.split('learn')[0]
                saved = _norm_node_detail({'study_notes': source})['study_notes']
                self.assertEqual(len(saved), 50000)
                self.assertEqual(saved, source[:50000])
                self.assertFalse(saved.endswith('```') or saved.endswith('~~~'))


if __name__ == '__main__':
    unittest.main()
