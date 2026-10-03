"""Independent question verification, rendering review and rubric judging."""

import json
import render_review
import quiz_harness as harness
from generation_contracts import _json_block
from prompts import _VERIFY_QUIZ, _JUDGE_RUBRIC


class QuizGeneration:
    def __init__(self, model):
        self.model = model

    def checked_questions(self, questions, previous=(), node=False, legacy=False):
        harness.validate_questions(questions, previous, node=node, legacy=legacy)
        verification_prompt = _VERIFY_QUIZ
        if legacy:
            verification_prompt += "\n本次为旧题兼容验题：未声明 scoring/blanks 的旧填空题沿用整题答案匹配，不要求补写空位或分值；已签发的结构化旧题缺失 match 时沿用 numeric，不要求补写；仍须检查题干、答案与解析是否正确。"
        verification = _json_block(
            self.model.nonempty(
                [
                    {"role": "system", "content": verification_prompt},
                    {
                        "role": "user",
                        "content": json.dumps(questions, ensure_ascii=False),
                    },
                ],
                max_tokens=self.model.settings.max_output_tokens,
                temperature=0,
            )
        )
        harness.validate_verification(verification, len(questions))
        return questions

    def review_rendered(self, candidate):
        try:
            return render_review.review(
                candidate,
                lambda messages: _json_block(
                    self.model.json(
                        messages,
                        max_tokens=self.model.settings.max_output_tokens,
                        temperature=0,
                        timeout=120,
                    )
                ),
            )
        except render_review.ReviewIssue as error:
            raise harness.QuizContractError(str(error)) from error

    def judge_criteria(self, items):
        return _json_block(
            self.model.nonempty(
                [
                    {"role": "system", "content": _JUDGE_RUBRIC},
                    {"role": "user", "content": json.dumps(items, ensure_ascii=False)},
                ],
                max_tokens=self.model.settings.max_output_tokens,
                temperature=0,
            )
        )
