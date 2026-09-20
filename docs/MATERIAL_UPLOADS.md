# 个人参考资料

创建学习地图时可上传参考资料；测验地图入口可上传资料新建，或为已有学习地图补充本次测验资料。上传后显示文件名和提取字数，支持移除。仅解析后的文本进入当前用户的资料记录，刷新和重新登录仍可读取；原文件不长期保存。文字会用于需求采集、研究、路径、单元材料和综合测验生成，生成测验保留当次资料快照。

支持 TXT（UTF-8、带 BOM 的 UTF-16、GB18030）、PDF、Word DOC/DOCX、Excel XLS/XLSX、PowerPoint PPT/PPTX、PNG/JPEG/WebP/GIF/BMP/TIFF，以及 ZIP/7Z。图片识别文字，不承诺理解纯图形；多帧图片须拆分。PDF 无文字页采用中文及英文 OCR。Excel 读取已保存的单元格值，不执行或重新计算公式。Office 不运行宏、不访问外部链接、不执行嵌入对象；含宏或嵌入对象的文件拒绝。

每个上传文件最多 10 MB；每份地图连同测验补充最多 100 份资料、20 万字符；PDF 最多 200 页，其中扫描页最多 40 页；图片最多 1600 万像素。压缩包展开合计最多 50 MB，压缩比最多 200，目录条目最多 200。拒绝加密包、嵌套包、重复路径、绝对路径、路径穿越、链接、特殊文件及不在格式白名单内的成员。ZIP 优先使用 UTF-8 标记或有效的 Unicode Path 扩展，未标记名称兼容 UTF-8、GB18030，统一规范化后检查路径。整包安全校验通过后才解析；只跳过明确的 Word 锁定/恢复文件、AppleDouble 和桌面元数据，界面显示跳过文件清单与保存数量。其他不支持成员仍拒绝整包，失败包不保存，不截断文字。

## 部署依赖

HTTP 服务仍使用 Python 标准库；解析进程增加系统依赖，Linux 部署前安装：

```sh
apt-get install bubblewrap python3-pypdf python3-openpyxl python3-py7zr \
  python3-xlrd python3-olefile python3-defusedxml python3-pil \
  antiword catdoc tesseract-ocr tesseract-ocr-chi-sim poppler-utils
```

将 `material_parser.py`、`material_worker.py` 随后端部署，将 `shared/materials.js` 和 `shared/materials.css` 部署到 `/learn/assets/`，并重新生成和部署两个 HTML 页面。保持发行版安全更新，不从上传文件安装依赖。正式服务和测试服务各自保留原有环境配置、数据库和账号。

解析调用固定 `/usr/bin/bwrap`，建立无网络、无业务数据目录的命名空间，只读挂载 `/usr` 和解析脚本，使用临时目录及无权限 UID。压缩包成员通过内存接口读取，绝不按成员路径落盘。Office/PDF/OCR 仅调用固定的系统工具，输入使用服务生成的临时文件名。缺少沙箱时失败关闭，不降级到服务进程解析。最多两个解析进程，每个内存 768 MB、CPU 80 秒、墙钟 100 秒；超时杀死进程组，临时目录随沙箱销毁。

`POST /materials/parse` 接收 `{name, data}`（data 为 base64），沿用账号认证、来源检查和请求体上限；只允许写入自己的用户上下文。`POST /materials/quiz-draft` 原子保存自己的学习地图测验补充，不回写整份过时页面快照。`materials` 与 `quizMaterials` 在状态保存时再次校验格式和字符上限。

## 验证

`sh scripts/check-local.sh` 检查资料校验、恶意成员拒绝、账号隔离、模型上下文与原有回归。真实格式与沙箱验收使用部署主机隔离目录，不将原始夹具提交到产品或写入普通用户空间。浏览器回归统一使用 `regression_bot`，覆盖桌面/手机、上传/移除、失败提示、刷新恢复及两类生成入口。
