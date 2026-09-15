# 旧测验结构迁移

`study-assistant/migrate_quiz_v2.py` 用于经过内容复核的旧题迁移。它保留原轮次、题目、草稿、历史答案和成绩，为相同题目追加 v2 版本，并将当前旧题的结构化版本设为当前轮次。历史成绩继续关联原始规则，不会重算，也不会复制成新版本成绩。

计划文件在服务器受限目录保存，不提交用户数据。格式如下：

```json
{
  "version": 1,
  "id": "unique-migration-id",
  "documents": [{
    "key": "user-id/document-key",
    "source_sha256": "digest(parsed_document)",
    "editions": [{
      "path": ["nodeDetail", "n1", "quiz"],
      "source_round_id": "original-round-id",
      "source_sha256": "digest(original_round)",
      "questions": [],
      "review": "逐题核对空位、参考答案、匹配方式和计分分值的依据"
    }]
  }]
}
```

`questions` 必须填写完整题集，先用 `quiz_harness.validate_questions` 校验并规范化。`digest` 使用工具提供的规范 JSON SHA256。综合测验的 `path` 为 `[]`。题型和每题总分保持不变，逐空分值和同义答案由审核计划显式指定，不根据旧答案分隔符自动猜测。新题的 `verification.method` 为 `reviewed_migration`，不冒充模型验题结果。

先只读预览：

```sh
python3 migrate_quiz_v2.py --database /absolute/state/state.sqlite3 --plan /private/reviewed-plan.json
```

在服务器内用受限数据库副本演练，验证所有原轮次及非目标数据不变、迁移重复执行为零、新规则评分正确。正式应用前等待任务队列清空，停止对应后端服务，再执行：

```sh
python3 migrate_quiz_v2.py --database /absolute/state/state.sqlite3 --plan /private/reviewed-plan.json --apply --backup /private/new-backup.sqlite3
```

工具获取服务使用的 `.writer.lock`，备份包含已提交 WAL 数据的完整 SQLite，使用事务更新文档并增加 revision。服务仍运行、计划过期、题目契约错误或备份路径已存在都会拒绝执行。数据库备份和计划须限制访问；验证材料不得进入用户学习库。

应用后重新启动服务，核对健康状态、真实登录、旧成绩回显以及新版本空数和计分标注。账号不在迁移范围。发生问题时不得用旧数据库覆盖已产生的新学习记录；先停止写入，按备份和迁移来源核对受影响文档再制定恢复方案。
