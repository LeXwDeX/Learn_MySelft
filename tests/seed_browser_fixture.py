"""Prepare synthetic browser data in an explicitly selected, isolated state directory."""
import argparse
import copy
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'study-assistant'))
import study_assistant as study
from test_quiz_harness import questions


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--state-dir', required=True)
    args = parser.parse_args()
    directory = Path(args.state_dir).resolve()
    if 'state-e2e' not in directory.parts:
        parser.error('Browser fixtures require an isolated state-e2e directory')
    study.STATE_DIR = str(directory)
    quiz = study._issued_quiz(study.harness.validate_questions(questions(), node=True))
    second = copy.deepcopy(quiz['questions'])
    second[0]['q'] = '第二套测试：整数加法结果是哪项？'
    study.harness.add_round(quiz, second)
    key = 'u0/learn-path-v1-dialog-e2e-20260914'
    material = {'topic': 'dialog-e2e-20260914', 'stage': 'learning', 'spec': {'topic': '弹窗回归'},
                'plan': {'title': '弹窗回归', 'nodes': [{'id': 'n1', 'title': '答题体验验证', 'deps': [],
                         'objectives': ['测试草稿恢复']}], 'edges': []},
                'nodeDetail': {'n1': {'study_notes': '隔离测试材料', 'quiz': quiz}}, 'nodeState': {}}
    study._state_write_key(key, json.dumps(material, ensure_ascii=False))
    for index in (1, 2):
        exam = {'kind': 'quiz-map', 'sourceKey': key, 'sourceSlug': 'dialog-e2e-20260914',
                'created': index, 'title': '综合测验弹窗验证', 'attempts': [],
                **study._issued_quiz(study.harness.validate_questions(questions(), node=True))}
        study._state_write_key('u0/quiz-map-v1-dialog-e2e-' + str(index), json.dumps(exam, ensure_ascii=False))
    print('Isolated browser fixtures ready')


if __name__ == '__main__':
    main()
