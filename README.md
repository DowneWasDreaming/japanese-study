# 木漏れ日 · 个人日语学习室

中文界面的本地个人学习网站：React + TypeScript + Express + Node.js 内置 SQLite。学习数据保存在本机；AI 通过官方 **Sign in with ChatGPT / ChatGPT plan usage** 授权调用 OpenAI。没有 API Key 配置或备用计费路径。

## 安装与启动

需要 **Node.js 24+** 和 **pnpm 11+**。数据库使用 Node 内置 `node:sqlite`，不需要额外安装数据库服务。

```powershell
pnpm install --frozen-lockfile
pnpm run init
pnpm dev
```

浏览器打开 **http://127.0.0.1:3210**。开发模式通过同一本地后端提供 Vite 页面；仅监听 `127.0.0.1`。首次启动自动执行无损迁移和原创种子初始化，`init` 可以重复运行。它不会清空已有学习记录。

生产运行仍是本机运行：

```powershell
pnpm build
pnpm start
```

```powershell
pnpm check
pnpm test
pnpm audit:files
```

Windows 可使用 `./scripts/start.ps1 -Install`；使用 `-Production` 时构建并启动生产模式。此脚本优先使用本机 pnpm/npm，也支持当前 Codex 环境已捆绑的 pnpm。代码不依赖该机器的绝对路径。

默认无需 `.env`。配置示例见 `.env.example`。要加载自定义环境文件，可用 Node 的 `--env-file=.env` 运行 `node --env-file=.env --import tsx server/index.ts`，生产模式在末尾加 `--production`。修改端口时网站地址和本次 OAuth 回调 URI 会同步调整。

## ChatGPT 登录及真实接入验证

1. 启动网站后进入“连接与设置”。点击 **Continue with ChatGPT**，由浏览器打开 OpenAI 官方授权页面。
2. 亲自登录自己的 ChatGPT 账号，选择工作区，并批准套餐使用权限。服务端接收回调并验证身份。
3. 页面会分别显示“已连接”和“套餐使用已授权”。仅有身份登录成功还不能请求模型。
4. 刷新模型列表，选择该账号实际可用的模型。列表来自官方接口，不写死型号。
5. 点击“生成一道题并验证”。这将获取模型、通过官方 Responses 端点完成真实流式调用、校验题目结构，并把一道 N5 题保存为 SQLite 试卷。打开这份练习完成作答和评分。

首次注册使用 `dynamic_agent_client`；回调返回的真实 `client_id` 与注册记录关联并保存，以供重新授权复用。安装有稳定的、不包含个人身份的 host ID。每次授权重新生成 PKCE、state 和 nonce。回调为 `http://127.0.0.1:3210/auth/callback`（更换端口只改变端口），授权和换取凭据时使用完全一致的 URI。

身份令牌通过 OpenAI JWKS 验证签名、issuer、audience、有效期和 nonce。以令牌响应实际授予的 `chatgpt.tokens.use.direct` 范围判断套餐权限。令牌保留在后端受保护目录；刷新串行化，轮换后的凭据原子保存。退出连接不删除学习数据。重新连接可以复用注册，新增账号的授权记录独立保存。

此流程无需单独购买 API 额度，但底层依然使用 OAuth 和模型 HTTP 请求。应用不读取 Codex 或其他应用的登录文件。AI 所需学习文本会发给 OpenAI；**本地存储不代表完全离线**。

账号或工作区是否符合接入条件，由 OpenAI 实际授权和调用结果决定。用量入口打开 [ChatGPT Settings → Usage](https://chatgpt.com/settings/usage)，不会用 token 数估算剩余百分比、恢复时间或人民币费用。达到额度限制时请查看该页面，不会自动切换计费。

## 学习与考试

内置原创词汇、语法、五十音和示例题，包含 JLPT N5～N1 参考等级。离线可浏览、搜索、收藏、加入生词本并完成客观题练习。等级仅供学习参考；原创和 AI 练习均不是官方试题，也不提供水平认证。

单词提供读音、词性、常见含义、搭配及双语例句；语法提供含义、接续、场景、语气、口语/书面差异、易错点和相似语法。句子解析和连续追问保存为本地对话；同条件讲解有缓存，可主动重新生成。

出卷可选难度、题量、题型、类别、知识点、生词、错题或薄弱点，支持练习/考试模式。题型为单选、填空、阅读理解、中译日、日译中及指定语法造句。完整试卷和评分标准在校验通过后持久化；AI 无效结构只允许有限修复。内置题池有容量限制，不能满足选项时会提示调整，避免伪造题目。

答题自动保存到 SQLite，刷新后继续。练习模式可逐题反馈，考试模式在交卷前由服务端隐藏答案、解析和评分标准。保存后的试卷版本用于评分。客观题本地评分；填空保留会影响日语含义的差异。翻译和造句使用已授权模型按标准评阅，接受不同合理表达。

重复交卷有并发保护与持久化结果，不会重复计分。开放题请求失败时已完成的客观题结果仍保留，失败部分标为“部分评分待完成”，仅重试这些题。没有授权时开放题无法 AI 评阅，不会被当成零分。可以报告题目疑问；报告保存在本机，作为学习内容纠错记录。

错题按等级、题型、知识点筛选并重新练习。统计来自真实本地答题：客观题全对记为正确，开放题达到该题分值的 80% 记为正确，尚未完成评分的题不进入正确率。复习推荐依据错误次数和上次练习时间，可查看推荐原因。查看历史、普通页面、客观评分和缓存命中的讲解不调用模型。

## 数据、凭据和备份

默认位置（相对于项目目录）：

| 内容 | 位置 |
| --- | --- |
| 学习 SQLite 数据库 | `.local/data/study.sqlite` |
| SQLite WAL/SHM | 数据库同目录 |
| 本机 host ID、授权注册和令牌 | `.local/credentials/` |
| 恢复前自动备份 | `.local/data/backups/` |
| 下载的导出 | 浏览器下载位置 |

可以通过 `STUDY_DATA_DIR` 和 `STUDY_CREDENTIAL_DIR` 自定义位置。凭据目录必须与学习目录分开。凭据目录由后端限制文件权限；在 Windows 使用当前用户 ACL，在 Unix 使用仅用户可读写权限。如果权限设置失败，授权流程应报错，不能声称凭据受到保护。

在设置页导出版本化 JSON 学习备份，包含试卷、草稿、成绩、错题、生词、收藏、对话和讲解缓存，不包含认证凭据。考试模式仍在答题或评分时，导出会提示先完成考试，避免备份绕过答案公开时机。恢复前严格验证结构、外键、成绩与考试状态，先自动备份当前学习数据，再事务恢复。恢复失败回滚。请优先通过导出/恢复搬迁学习数据；不要在服务运行时只复制 `.sqlite` 而忽略 WAL。凭据应通过重新登录恢复。

SQL 迁移在 `migrations/`。后续升级应新增递增版本的迁移，不能删除数据库重建。安装依赖、构建、初始化与迁移不清空学习数据。`localStorage` 仅用于界面主题，不保存学习记录或凭据。

本地模型请求尝试限制默认每小时 30 次、24 小时 150 次，记录保存在 SQLite；失败尝试也计入。可通过 `STUDY_AI_HOURLY_LIMIT`、`STUDY_AI_DAILY_LIMIT` 调整。该限额用于防止误操作，与 OpenAI 套餐限额相互独立。

## 常见错误

| 情况 | 处理 |
| --- | --- |
| 只登录成功，套餐未授权 | 点击重新授权，授予套餐权限 |
| state/nonce 不匹配，回调过期 | 回到连接页重新开始；不重放旧回调 |
| 令牌过期或授权撤销 | 刷新失败后提示重新连接，不循环登录 |
| 账号/工作区不符合资格 | 根据实际错误检查所选账号或工作区；不无限重试 |
| 套餐/应用用量达到上限 | 打开“管理 ChatGPT 使用量”；不猜测恢复时间 |
| 临时服务不可用 | 稍后手动重试，保留学习与部分评分 |
| 流中断、失败、不完整或 JSON 无效 | 请求失败；部分文本不视作完成，不保存为完整试卷 |
| 内置题池无法满足条件 | 调整条件或在授权后改用 AI 出卷 |
| 生词、错题或薄弱点暂时为空 | 先积累相应记录，或选择普通出卷；不会悄悄改成综合题 |
| 考试未完成时导出被阻止 | 先交卷并完成评分，然后导出学习备份 |
| 端口占用 | 更改 PORT；继续使用 `127.0.0.1` |
| npm 命令在当前环境不存在 | 使用 pnpm 或 Windows 启动脚本 |

模型请求严格遵循此授权流程：`GET https://api.openai.com/v1/models`；`POST https://api.openai.com/v1/responses`；`store:false`、`stream:true`、上下文作为 `input` 数组，使用 developer 消息。没有 `system` 消息、`temperature`、`max_output_tokens` 或 `previous_response_id`。只在收到 `response.completed` 且业务校验通过后记为完成。模型返回的失败、额度错误或断流都有独立处理。

## 验证记录与 GitHub

实际测试结果和待验证内容见 [verification/results.md](verification/results.md)。自动化网络响应使用模拟 transport，和真实 OAuth/套餐调用分开报告。真实验证必须由用户亲自登录并完成调用；没有令牌或未调用成功时不能声称已验证。

GitHub 只保存源代码、锁文件、迁移、原创种子内容和文档。`.gitignore` 排除数据库/WAL/SHM、学习文件、认证、环境文件、日志、缓存、导出、备份、依赖及构建产物。推送前运行 `pnpm audit:files` 检查已跟踪路径、工作目录、暂存区与可达提交历史中的疑似令牌。如果历史中发现凭据，停止推送并先处理历史和撤销凭据。

没有提供 GitHub 仓库地址时，仅完成本地项目与本地 Git 保存。连接用户指定的空仓库后：

```powershell
git remote add origin https://github.com/你的用户名/你的仓库.git
git branch -M main
pnpm audit:files
git push -u origin main
```

需要自己的 GitHub 认证。如果远端已有提交，先 fetch 并整合历史，不能强制推送覆盖。不要把本机 `.local` 或导出文件加入提交。

## 官方接入资料

实现时核查日期：2026-10-12。

- [概览与本机 host ID](https://developers.openai.com/siwc/token-sharing-open-source)
- [动态注册、登录与权限验证](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
- [账号、注册与令牌刷新](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)
- [模型发现与流式 Responses](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [错误与恢复](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery)
- [预览限制](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
- [令牌参考](https://developers.openai.com/siwc/token-sharing-open-source/token-reference)
- [套餐用量界面规范](https://developers.openai.com/siwc/ui-ux-guidelines)
