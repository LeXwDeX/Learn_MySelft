"""Teaching capabilities are optional and do not weaken answer/material boundaries."""

import unittest
import prompts


class MarkdownContractTests(unittest.TestCase):
    def test_generation_prompts_share_supported_syntax_and_self_check(self):
        for kind in ("node", "requiz", "quizmap"):
            prompt = prompts._path_system(kind)
            self.assertIn("可选，不必每次画图", prompt)
            self.assertIn("输出前自检", prompt)
            self.assertIn("```mermaid", prompt)
            self.assertIn("不包含答案", prompt)
            self.assertNotIn("不要用表格", prompt)
            self.assertIn("评分契约", prompt)

    def test_unready_tutor_cannot_claim_material_or_reveal_answers(self):
        prompt = prompts.build_system({"material_status": "generating"})
        self.assertIn("不要主动公布", prompt)
        self.assertIn("本单元正文尚未就绪", prompt)
        self.assertIn("图也不能提前泄露", prompt)
        self.assertIn("不声称已通过浏览器验证", prompt)

    def test_rendering_contract_names_limits_and_forbids_html_breaks(self):
        for prompt in (prompts.build_system({}), prompts._path_system('node')):
            for required in ('不得输出未列出的渲染方式', 'flowchart、graph、sequenceDiagram',
                             '8000 字符', '100 条边', '最多 4 张图', '<br>', '<br/>',
                             'SVG', 'JavaScript', 'CSS', '%%{', 'front matter',
                             '不输出外部图片', '中文标签加双引号', '短标签',
                             r'\(', r'\[', '脚注', '提示块'):
                self.assertIn(required, prompt)
            self.assertIn('真正的 ManimGL 分步教学动画', prompt)
            self.assertIn('不要自行输出 learn-scene、learn-manim', prompt)
            self.assertIn('独立任务中生成实际场景代码、渲染视频', prompt)
