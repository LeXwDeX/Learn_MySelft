"""Source selection must not introduce or silently pass through unverified URLs."""
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'study-assistant'))
from research_sources import collect_sources, select_sources


class ResearchSourcesTests(unittest.TestCase):
    def setUp(self):
        self.sources = [
            {'title': 'GPT-6 news', 'url': 'https://example.org/news', 'snippet': 'AI news'},
            {'title': '日本語の動詞活用', 'url': 'https://example.org/verbs', 'snippet': '五段動詞'},
            {'title': '日语五十音', 'url': 'https://example.org/kana', 'snippet': '日语入门'},
        ]

    def test_retains_exact_selected_records_and_order(self):
        complete = Mock(return_value='{"selected_ids":[3,2]}')
        selected = select_sources({'topic': '日语'}, self.sources, complete)
        self.assertEqual(selected, [self.sources[2], self.sources[1]])
        self.assertIs(selected[0], self.sources[2])
        records = json.loads(complete.call_args.args[0][1]['content'])['candidates']
        self.assertEqual([r['id'] for r in records], [1, 2, 3])

    def test_bad_selection_never_passes_raw_sources(self):
        for text in ('{}', 'null', '[]', 'bad', '{"selected_ids":[true]}',
                     '{"selected_ids":[0]}', '{"selected_ids":[4]}',
                     '{"selected_ids":[1,1]}', '{"selected_ids":"1"}'):
            with self.subTest(text=text), self.assertRaisesRegex(ValueError, '相关性核验未完成'):
                select_sources({}, self.sources, Mock(return_value=text))

    def test_empty_or_rejected_sources(self):
        complete = Mock(return_value='{"selected_ids":[]}')
        self.assertEqual(select_sources({}, [], complete), [])
        complete.assert_not_called()
        self.assertEqual(select_sources({}, self.sources, complete), [])

    def test_all_queries_sampled_and_unsafe_urls_discarded(self):
        search = Mock(side_effect=[self.sources, [dict(self.sources[1], url=self.sources[1]['url'] + '#part')],
                                   [{'url': 'javascript:alert(1)'}, {'url': 'https://example.org/final'}]])
        result = collect_sources(['verbs', 'kana', 'last'], search)
        self.assertEqual(search.call_count, 3)
        self.assertEqual(len(result), 4)
        self.assertEqual(result[-1]['url'], 'https://example.org/final')


if __name__ == '__main__':
    unittest.main()
