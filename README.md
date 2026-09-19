# llm-mock

OpenAI Chat Completions 的脚本化 mock 服务：把一段预设的响应序列写进 JSON，
**第 i 次 `/v1/chat/completions` 请求返回第 i 条**；`stream: true` 时把同一条
完整响应转换成 OpenAI 规范的 SSE chunk 序列。

用于在不调用真实模型的前提下复现 agent 的多轮循环、工具调用与流式渲染。

## 快速开始

```bash
bun install
bun run src/server.ts --script script.json   # 脚本必填；默认监听 :3457
bun run src/server.ts --help                 # 完整选项与脚本格式
```

脚本文件必须显式指定（`--script` 或 `SCRIPT_PATH`）：mock 的行为完全由脚本
决定，不提供隐式默认路径，避免误加载别的剧本。

```bash
curl -s localhost:3457/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"看看项目"}]}'

curl -N -s localhost:3457/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"stream":true,"stream_options":{"include_usage":true},"messages":[]}'
```

## 脚本格式

顶层是数组，或 `{ "defaults": {...}, "responses": [...] }`：

```json
{
    "defaults": { "delayMs": 200, "chunkDelayMs": 20, "chunkSize": 1 },
    "responses": [
        { "message": { "role": "assistant", "content": "我先看一下目录。" } },
        {
            "message": {
                "role": "assistant",
                "content": null,
                "tool_calls": [
                    { "id": "call_1", "function": { "name": "Bash", "arguments": { "command": "ls" } } }
                ]
            },
            "finish_reason": "tool_calls"
        },
        "目录里有 script.json 和 package.json。"
    ]
}
```

单条响应按顺序判定形态，越靠前越简：

| 写法 | 说明 |
| --- | --- |
| `"文本"` | 等价 `content`，`finish_reason: "stop"` |
| `{ "message": {...} \| "文本", "finish_reason": ... }` | 只给 message |
| `{ "content": ..., "tool_calls": [...] }` | message 字段直铺 |
| `{ "choices": [{ "message": ..., "finish_reason": ... }] }` | 完整 `chat.completion` |

- 有条目含 `tool_calls` 时 `finish_reason` 默认推导为 `"tool_calls"`，否则 `"stop"`；
- `tool_calls[].function.arguments` 可写字符串或对象（对象自动 `JSON.stringify`）；
- 条目可覆盖 `id` / `created` / `model` / `usage`，未写的由服务端补全。

### 节奏（模拟"边想边吐"）

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `delayMs` | 0 | 首包前的"思考"耗时（TTFT）；非流式时是整段耗时 |
| `chunkDelayMs` | 0 | 每个 SSE chunk 之间的间隔 |
| `chunkSize` | 1 | 每个 chunk 包含多少个字符（按 grapheme 切分，不拆坏 emoji） |

这三项写在条目顶层覆盖 `defaults`；命令行 / 环境变量显式给出的值优先于
脚本 `defaults`（「显式配置 > 脚本 defaults > 内置值」）。

### usage

脚本未声明 `usage` 时按字符估算：CJK 按 1 token/字，其余按 4 字符 1 token
（整体累加后向上取整）。估算与真实 tokenizer 有偏差，要精确值就在条目里写：

```json
{ "message": "hi", "usage": { "prompt_tokens": 10, "completion_tokens": 2, "total_tokens": 12 } }
```

## 端点

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/v1/chat/completions` | 主端点（`/chat/completions` 别名同样可用） |
| GET | `/v1/models` | 返回配置的模型名 |
| GET | `/__mock/status` | 当前游标与脚本信息 |
| POST | `/__mock/reset[?index=N]` | 重置游标（或跳到第 N 条） |
| POST | `/__mock/reload` | 重新读取脚本文件并重置游标 |

不校验 `Authorization`：mock 的职责是按脚本回放。错误响应为 OpenAI 风格
`{"error": {"message", "type", "code"}}`。

## 选项

```
--script <path>        脚本文件（必填，亦可用 SCRIPT_PATH）
--port <n>             监听端口（默认 3457）
--exhausted <policy>   脚本耗尽后: error | hold | loop | stop（默认 error）
--model <name>         响应中补全的模型名（默认 llm-mock）
--delay-ms <n>         首包前延迟毫秒
--chunk-delay-ms <n>   流式 chunk 间隔毫秒
--chunk-size <n>       每个流式 chunk 的字符数
```

环境变量同名大写加前缀：`PORT` / `SCRIPT_PATH` / `MOCK_EXHAUSTED` /
`MOCK_MODEL` / `MOCK_DELAY_MS` / `MOCK_CHUNK_DELAY_MS` / `MOCK_CHUNK_SIZE`。

**耗尽策略**决定脚本播完之后的行为：

- `error`（默认）：返回 500 与 `code: "script_exhausted"`，提示 use `/__mock/reset`；
- `hold`：每次重复最后一条；
- `loop`：从头循环；
- `stop`：返回一条「任务结束」纯文本（`finish_reason: "stop"`，无工具调用）。harness 收到后
  会当作任务完成、自行收尾退出——用于「跑完一整个长剧本、测端到端时长」的压测场景，
  避免 harness 卡在等下一次响应上直到被超时强杀。`/__mock/status` 里的 `requests` 统计
  累计请求数（含这些收尾响应，`index` 不推进）。

默认不静默兜底，避免把"剧本已播完"伪装成正常响应。

游标是进程级的：第 i 次请求消费第 i 条，取号发生在响应开始之前——流式响应
即使被客户端中途取消，该条目也已消费。

## 与 Perihelion 集成

本项目自带一份局部配置 `.peri/settings.json`，把 provider 指向本 mock
（`{cwd}/.peri/settings.json` 只在 cwd 命中本项目时生效）：

```json
{
    "config": {
        "active_alias": "sonnet",
        "providers": [
            {
                "id": "llm-mock",
                "type": "openai",
                "apiKey": "mock-key",
                "baseUrl": "http://127.0.0.1:3457/v1",
                "models": { "fable": "llm-mock", "opus": "llm-mock", "sonnet": "llm-mock", "haiku": "llm-mock" }
            }
        ],
        "profiles": {
            "sonnet": { "provider": "llm-mock", "model": "llm-mock", "effort": "low" }
        }
    }
}
```

`{cwd}/.peri/settings.json` 只在 cwd 命中时生效：`providers` 整体替换全局
providers，`active_alias` 与同名 profile 档位覆盖全局。

> 注意：`apiKey` 只是占位值，mock 不校验 `Authorization`；项目目前不在任何
> git 仓库内，若将来纳入版本控制，请自行决定是否提交这份配置（也可以绕过
> 文件，直接把同一段 JSON 交给 `peri --settings '<json>'`——单文件来源，
> 不合并全局与工作区配置）。

随后在本项目目录下运行（peri 用 PATH 里的发布版；本仓库不拿 perihelion 的本地 debug 构建当
测试 harness——debug 构建的读数与发布版不可比）：

```bash
# 终端 1：起 mock（用配套的多轮演示脚本，含 Bash 工具调用）
bun run src/server.ts --script scripts/peri-demo.json

# 终端 2：在本目录下跑 peri（非交互 print 模式）
peri -p "你好" --max-turns 1 --no-session-persistence
peri -p "看一下目录里有什么" --max-turns 4 --dangerously-skip-permissions
```

### 一个 prompt 会消费几条脚本

**peri 每次 prompt 结束都会再发一次「预测用户下一步输入」请求**（客户端声明
prediction 能力时；TUI 与 print 模式都会），它是一个无工具的最小调用，同样
消费一条脚本。所以一段对话的消费序列是：

```text
主回答 → 预测 → （有工具调用时：工具结果回传后的下一轮）→ …… → 预测
```

`scripts/peri-demo.json` 正是按这个规律编排的：

| 条目 | 消费方 |
| --- | --- |
| 1 | prompt「你好」的主回答 |
| 2 | 该次 prompt 的预测请求（结果被 peri 当作占位建议，无可见输出） |
| 3 | prompt「看一下目录里有什么」→ `Bash` tool_call |
| 4 | 工具结果回传后的第二轮回答 |
| 5 | 该次 prompt 的预测请求 |
| 6 | 下一次 prompt 的主回答 |

mock 的访问日志会打印每次请求的 `stream / model / messages / last=role:"…"`，
用于确认是哪一类请求消费了脚本——当游标推进比预期快时，先看这里。

实测（PATH 里的 peri 3.17）：peri 会输出脚本内容、真实执行 `Bash`、把 `ls`
结果作为 tool 消息回传后继续消费下一条；脚本播完后主流程仍正常退出
（后续预测请求收到 500 `script_exhausted`，不影响已完成的回答）。

## 限制

- 只实现 `chat/completions` 与 `models`，不含 embeddings / responses 等其它端点；
- `choices` 恰好 1 个（不支持 `n > 1`）；
- 游标是全局单游标：并发客户端会共享同一条序列，不做会话隔离；
- 不模拟真实鉴权、限流、超时与错误注入。

## 测试

```bash
bun test          # 脚本解析、游标、SSE 序列、路由集成
bun run typecheck # tsc --noEmit
```
