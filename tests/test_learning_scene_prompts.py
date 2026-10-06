"""The scene authoring contract is limited to learning prose and tutor answers."""

import json
import math
from pathlib import Path
import re
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'study-assistant'))
import prompts
from quiz_harness import validate_questions
from scene_contracts import validate_scene


def scene_examples():
    return [
        json.loads(match)
        for match in re.findall(
            r"```learn-scene\s*\n(.*?)\n```", prompts.SCENE_TEACHING, re.DOTALL
        )
    ]


def number_in(value, low, high):
    return type(value) in (int, float) and math.isfinite(value) and low <= value <= high


class LearningScenePromptTests(unittest.TestCase):
    def test_node_format_example_satisfies_current_quiz_contract(self):
        prompt = prompts._path_system("node")
        start = prompt.index("{")
        example, _end = json.JSONDecoder().raw_decode(prompt[start:])
        questions = example["quiz"]["questions"]

        validate_questions(questions, node=True)

        self.assertEqual(len(questions), 6)
        self.assertEqual([q["type"] for q in questions], ["choice"] * 4 + ["fill", "short"])
        self.assertEqual([q["points"] for q in questions], [10, 10, 10, 10, 30, 30])
        self.assertEqual(sum(q["points"] for q in questions), 100)
        self.assertEqual([q["answer"] for q in questions[:4]], ["A", "B", "C", "D"])
        self.assertEqual([q["scoring"]["mode"] for q in questions], [
            "single_choice", "single_choice", "single_choice", "single_choice", "per_blank", "rubric"
        ])
        fill, short = questions[4:]
        self.assertEqual(fill["blanks"], [{
            "id": "b1", "answer": "占位答案", "accepted_answers": ["占位答案"],
            "match": "text", "points": 30
        }])
        self.assertEqual(sum(item["points"] for item in short["rubric"]), 30)

    def test_only_node_and_tutor_prompts_offer_scenes(self):
        node = prompts._path_system("node")
        tutor = prompts.build_system({"material_status": "ready", "notes": "正文"})
        self.assertIn("交互场景", node)
        self.assertIn("```learn-scene", node)
        self.assertIn("把围栏作为 study_notes 正文内容", node)
        self.assertIn("交互场景", tutor)
        self.assertIn("```learn-scene", tutor)
        self.assertIn("输出前自检", node)
        self.assertIn("题干中的图和表只呈现已知条件", node)
        self.assertIn("图也不能提前泄露", tutor)
        self.assertIn("绝不主动给答案", tutor)

        excluded = [
            prompts._path_system("requiz"),
            prompts._path_system("quizmap"),
            prompts._path_system("intake"),
            prompts._path_system("research_queries"),
            prompts.build_suggest_system({"unit_title": "概念"}),
        ]
        for prompt in excluded:
            with self.subTest(prompt_start=prompt[:32]):
                self.assertNotIn("learn-scene", prompt)

    def test_examples_are_complete_v1_scenes_with_valid_numeric_ranges(self):
        examples = scene_examples()
        self.assertEqual([item["type"] for item in examples], [
            "diagram", "linear_transform", "secant", "surface_slice"
        ])
        for scene in examples:
            with self.subTest(scene_type=scene["type"]):
                self.assertEqual(scene["version"], 1)
                self.assertTrue(scene["title"].strip())
                self.assertLessEqual(len(scene["title"]), 80)
                self.assertTrue(scene["summary"].strip())
                self.assertLessEqual(len(scene["summary"]), 500)
                self.assertLessEqual(
                    len(json.dumps(scene, ensure_ascii=False, separators=(",", ":"))),
                    12000,
                )
                validate_scene(scene)

        diagram, linear, secant, surface = examples
        self.assertGreater(len(diagram["elements"]), 1)
        self.assertGreater(len(diagram["steps"]), 1)
        self.assertEqual(set(linear), {"version", "type", "title", "summary", "matrix", "vector"})
        self.assertEqual(len(linear["matrix"]), 2)
        self.assertTrue(all(len(row) == 2 for row in linear["matrix"]))
        self.assertTrue(all(number_in(n, -4, 4) for row in linear["matrix"] for n in row))
        self.assertEqual(len(linear["vector"]), 2)
        self.assertTrue(all(number_in(n, -3, 3) for n in linear["vector"]))

        self.assertEqual(
            set(secant),
            {"version", "type", "title", "summary", "coefficients", "domain", "baseX", "gap"},
        )
        self.assertTrue(1 <= len(secant["coefficients"]) <= 5)
        self.assertTrue(all(number_in(n, -20, 20) for n in secant["coefficients"]))
        left, right = secant["domain"]
        self.assertTrue(number_in(left, -5, 5) and number_in(right, -5, 5) and left < right)
        self.assertTrue(left <= secant["baseX"] <= right)
        gap = secant["gap"]
        self.assertEqual(set(gap), {"min", "max", "value"})
        self.assertTrue(0.01 <= gap["min"] <= gap["value"] <= gap["max"] <= 3)
        self.assertLessEqual(secant["baseX"] + gap["max"], right)

        self.assertEqual(
            set(surface),
            {"version", "type", "title", "summary", "coefficient", "radius", "height"},
        )
        self.assertTrue(number_in(surface["coefficient"], 0.2, 5))
        self.assertTrue(number_in(surface["radius"], 0.5, 3))
        height = surface["height"]
        self.assertEqual(set(height), {"min", "max", "value"})
        self.assertTrue(0 < height["min"] <= height["value"] <= height["max"])
        self.assertLessEqual(height["max"], surface["coefficient"] * surface["radius"] ** 2)

    def test_natural_learning_requests_have_generic_graphic_capability(self):
        for prompt in (prompts._path_system("node"), prompts.build_system({"unit_title": "概念"})):
            self.assertIn("Manim / 3Blue1Brown", prompt)
            self.assertIn("用户无需提出画图要求", prompt)
            self.assertIn("不限于数学或固定课程", prompt)
            self.assertIn("type=diagram", prompt)
            self.assertIn("实际高维嵌入", prompt)
        self.assertIn("字段只有 needed、reason、markdown", prompts.SCENE_SUPPLEMENT)

    def test_scene_contract_keeps_unready_material_and_answer_boundaries(self):
        for status in ("missing", "generating", "failed"):
            prompt = prompts.build_system({"material_status": status, "unit_title": "函数"})
            with self.subTest(status=status):
                self.assertIn("本单元正文尚未就绪", prompt)
                self.assertIn("不冒充已有正文或配套题", prompt)
                self.assertIn("图也不能提前泄露正在作答题目的答案", prompt)
                self.assertIn("learn-scene 围栏内只输出下面定义的 JSON 对象", prompt)


if __name__ == "__main__":
    unittest.main()
