"""Teaching capabilities are optional and do not weaken answer/material boundaries."""
import unittest
import test_state_regressions as base


class MarkdownContractTests(unittest.TestCase):
    def test_generation_prompts_share_supported_syntax_and_self_check(self):
        for kind in ('node', 'requiz', 'quizmap'):
            prompt = base.study._path_system(kind)
            self.assertIn('可选，不必每次画图', prompt)
            self.assertIn('输出前自检', prompt)
            self.assertIn('```mermaid', prompt)
            self.assertIn('不包含答案', prompt)
            self.assertNotIn('不要用表格', prompt)
            self.assertIn('评分契约', prompt)

    def test_unready_tutor_cannot_claim_material_or_reveal_answers(self):
        prompt = base.study.build_system({'material_status': 'generating'})
        self.assertIn('不要主动公布', prompt)
        self.assertIn('本单元正文尚未就绪', prompt)
        self.assertIn('图也不能提前泄露', prompt)
        self.assertIn('不声称已通过浏览器验证', prompt)
