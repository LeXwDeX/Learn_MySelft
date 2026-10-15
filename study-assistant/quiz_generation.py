"""Independent question verification, rendering review and rubric judging."""

import json
import render_review
import quiz_harness as harness
from generation_contracts import _json_block
from prompts import _VERIFY_QUIZ, _JUDGE_RUBRIC


class QuizVerificationFormatError(harness.QuizContractError):
    """The complete verification report could not be read safely."""


class QuizVerificationQualityError(harness.QuizContractError):
    """A structurally complete report rejected the candidate's content."""

    def __init__(self, feedback):
        super().__init__("综合测验独立验题未通过")
        self.feedback = [dict(item) for item in feedback]


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
                max_tokens=min(self.model.settings.max_output_tokens, 8192),
                reasoning_effort='medium',
                response_format='json_object',
                temperature=0,
            )
        )
        harness.validate_verification(verification, len(questions))
        return questions

    def checked_quizmap_questions(self, questions, previous=(), on_attempt=None):
        """Retry report formatting on the same candidate, never its quality verdict."""
        harness.validate_questions(questions, previous)
        for attempt in range(1, 3):
            if on_attempt:
                on_attempt(attempt)
            verification = _json_block(self.model.nonempty(
                [
                    {"role": "system", "content": _VERIFY_QUIZ},
                    {"role": "user", "content": json.dumps(questions, ensure_ascii=False)},
                ],
                tries=1,
                max_tokens=min(self.model.settings.max_output_tokens, 16384),
                reasoning_effort="medium", response_format="json_object", temperature=0,
            ))
            items = verification.get("questions") if isinstance(verification, dict) else None
            complete = isinstance(items, list) and len(items) == len(questions) and all(
                isinstance(item, dict) and type(item.get("index")) is int and item["index"] == index
                and type(item.get("valid")) is bool and type(item.get("reference_complete")) is bool
                and isinstance(item.get("reason"), str) and bool(item["reason"].strip())
                for index, item in enumerate(items)
            )
            if not complete:
                continue
            if any(not item["valid"] or not item["reference_complete"] for item in items):
                raise QuizVerificationQualityError(items)
            harness.validate_verification(verification, len(questions))
            return questions
        raise QuizVerificationFormatError("综合测验验题报告格式无效，请重试")

    def review_rendered(self, candidate):
        try:
            return render_review.review(
                candidate,
                lambda messages: _json_block(
                    self.model.json(
                        messages,
                        max_tokens=min(self.model.settings.max_output_tokens, 2048),
                        reasoning_effort='none',
                        response_format='json_object',
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
