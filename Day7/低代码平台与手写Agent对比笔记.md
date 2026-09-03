# 对比笔记：手写 Agent vs 低代码平台（Coze/Dify）搭建智能体

> 参照：[hello-agents 第五章《基于低代码平台的智能体搭建》](https://datawhalechina.github.io/hello-agents/#/./chapter5/%E7%AC%AC%E4%BA%94%E7%AB%A0%20%E5%9F%BA%E4%BA%8E%E4%BD%8E%E4%BB%A3%E7%A0%81%E5%B9%B3%E5%8F%B0%E7%9A%84%E6%99%BA%E8%83%BD%E4%BD%93%E6%90%AD%E5%BB%BA)
> 对照项目：[GitHub仓库手写的个人助手 Agent（ReAct / PlanAndSolve / Reflection 三范式 + Function Calling + Memory + 工具注册中心 + 调度中心 + CLI）](https://github.com/superZchen0701/homework-project1-personal-agent)
> 目的：手写一遍后回头看低代码平台，把平台的每个图形化能力"透视"回底层原理，反向加深理解。

---

## 一、先说结论

| | 低代码平台（Coze/Dify） | 手写 Agent（本项目） |
|---|---|---|
| 本质 | **配置驱动的编排**：平台已实现好所有底层能力，你做的是"连接和配置" | **代码驱动的实现**：你亲手实现平台封装掉的每一个环节 |
| 抽象层级 | 应用层（业务逻辑） | 原理层（Agent 运行机制） |
| 上手速度 | 分钟级出原型 | 天级（但每行代码都透明） |
| 灵活性边界 | 受限于平台提供的节点/模块类型 | 无边界，任何逻辑皆可写 |
| 学习价值 | 学"如何组织 AI 应用" | 学"AI 应用内部如何运转" |

一句话：**低代码平台把第四章的代码变成了图形节点；手写项目则是把这些节点拆开，看清里面的齿轮。**

---

## 二、能力维度逐项对照

### 1. 意图理解与任务路由

- **Coze/Dify**：提供"意图识别节点"、分类器节点，在画布上拖一个节点，配置几个意图分类和分支即可。底层同样是调 LLM 做分类，只是平台把提示词和解析逻辑封装成了 GUI 配置项。
- **本项目**：[scheduler/index.js](scheduler/index.js) 的 `_classifyComplexity()` —— 用一个 `CLASSIFY_PROMPT` 让 LLM 输出 `complex/simple`，再正则解析、异常兜底（识别失败/调用失败均降级为 simple）。
- **原理洞察**：平台的"意图识别节点" ≈ 我的"复杂度判断提示词 + 结果解析 + 兜底"。GUI 背后没有任何魔法，就是一次非流式的 LLM 调用（我在 scheduler 里显式 `stream: false`，因为分类是控制信号，不值得流式）。

### 2. 流程编排

- **Coze/Dify**：可视化画布，拖节点、连线、配置输入输出映射（如 `{{articles}}` 变量引用）。Coze 分单 Agent 自主规划/对话流/多 Agent 模式。
- **本项目**：[scheduler/index.js](scheduler/index.js) 的 `_runHybrid()` —— PlanAndSolve 做骨架（全局计划）→ 每步 ReAct 执行（携带上下文的子问题）→ 最后一步 Reflection 把关 → LLM 汇总。纯代码实现"连线"：`stepResults` 数组就是节点间的"连线"，`subQuestion` 的模板拼接就是"变量引用"。
- **原理洞察**：画布上的每条线，代码里就是"上一步的输出变量被下一步的提示词模板引用"。手写后你才知道：**编排的本质是上下文（context）的构造与传递**，而不是那根视觉上的线。

### 3. 提示词工程

- **Coze/Dify**：提示词配置面板，支持 System/User 提示分区、变量插值（`{{question}}`）。Coze 案例中用 `# 角色`/`## 工作流` 的结构化 Markdown 提示词。
- **本项目**：提示词即代码常量——[react_agent.js](agents/react_agent.js) 的 `REACT_PROMPT_TEMPLATE`（Thought/Action 格式 + 工具 schema + 示例 + 禁止项）、[reflection_agent.js](agents/reflection_agent.js) 的三段式提示词（初始执行/反思/优化，含"事实纪律"）。
- **原理洞察**：完全一致，都是模板字符串 + 变量替换（我用的 `.replace('{question}', question)`，等价于平台的 `{{question}}`）。差异只在载体：GUI 文本框 vs 代码常量（后者可版本管理、可 diff、可 code review）。

### 4. 工具系统（插件 vs Tool）

- **Coze**：插件市场一键添加（RSS/GitHub/arXiv…），表单式配置参数，平台自动生成工具描述供 LLM 选择。
- **本项目**：
  - [tools/base.js](tools/base.js)：`Tool` 基类，`name + description + parameters(JSON Schema)` + `_execute()`；
  - [tools/registry.js](tools/registry.js)：`ToolRegistry` 注册中心，输出工具描述（含参数 schema）和标准 OpenAI tools schema 两种格式。
- **原理洞察**：平台插件 = 我的 Tool 类实例。插件市场的"表单配置"，本质是在帮你生成 `parameters` JSON Schema。**我踩过的坑印证了工具描述的重要性**：早期工具列表只有 `- 名称: 描述` 不含参数 schema，LLM 调 memory 工具时瞎猜格式（`memory[add]`、`add(content=...)`），连环失败浪费 4 步循环；补上 schema 输出后一次调用即成功。平台帮你把 schema 生成好了，所以你感知不到这个坑的存在。

### 5. Function Calling

- **Coze/Dify**：完全封装。你配置完插件，平台自动以 Function Calling（或文本解析）方式让模型调用，用户无感。
- **本项目**：双模式实现，且刻意做成可切换——
  - **ReAct 文本模式**（默认）：LLM 输出 `Action: tool[JSON]` 文本，代码 `_parseAction` 解析后调 `execute_tool`；
  - **原生 Function Calling**：`ENABLE_FUNCTION_CALLING=true` 时，`get_tools_schemas()` 传给 API，LLM 返回 `tool_calls`，基类 `_handleToolCalls()` 统一执行并以 `role:'tool'` 回传。
- **原理洞察**：平台的"无感"恰恰是黑盒的代价。手写后才理解两条通道的本质区别：**文本模式靠提示词约定 + 正则解析（对模型无要求、行为可控），FC 模式靠 API 协议层的结构化返回（更可靠但依赖模型能力）**。以及为什么不能两者同时开：模型会在两个通道间摇摆（双重触发问题）。

### 6. 记忆与知识库

- **Coze/Dify**：
  - Coze"数据库"模块（云存档）、会话记忆开箱即用；
  - Dify/Coze 知识库 = RAG Pipeline：上传文档 → 自动分块 → 向量化 → 检索挂载。
- **本项目**：[memory/](memory/) 目录手写了认知五阶段——
  - 三种类型：工作记忆（FIFO 短期）/ 情景记忆（按时间）/ 语义记忆（按重要性）；
  - [manager.js](memory/manager.js)：编码→存储→检索→整合→遗忘（7 天未访问 + 低重要性淘汰）；
  - 跨类型综合检索排序 + 降级兜底；
  - 通过 `memory` 工具暴露给 LLM 自主存取。
- **原理洞察**：平台的"知识库/RAG"是一个高度封装的子系统，我的记忆系统只覆盖了轻量级对话记忆（无向量检索——语义匹配靠 LLM 打的重要性分数而非 embedding）。对比后能看清差距：**生产级 RAG 还需要分块策略、embedding 模型、向量库、重排序**，这些是平台内部更深的黑盒。但对话记忆的状态管理逻辑（什么该忘、什么该留、按什么优先级检索）我已经亲手实现过一遍。

### 7. 模型接入

- **Coze/Dify**：模型管理菜单里选（GPT/豆包/通义…），填 key 即可。平台处理多模型协议差异。
- **本项目**：[core/llm.js](core/llm.js) —— OpenAI 兼容单例客户端 + `chatCompletion` 统一入口（屏蔽 SDK 细节）+ `ENABLE_STREAM` 全局流式开关 + 流式 `tool_calls` 分片累积。
- **原理洞察**：所谓"模型中立"，工程上就是**都走 OpenAI 兼容协议 + baseURL 可换**这一个事实。全项目所有 LLM 调用收敛到一个函数后，重试/限流/日志才有统一的挂载点——这是平台"模型管理"背后做的事。

### 8. 调试与可观测性

- **Coze/Dify**：端到端可视化运行轨迹，每个节点耗时、输入输出、失败原因一目了然（第五章明确把这点列为平台核心优势，"纯代码开发难以比拟"）。
- **本项目**：结构化 console 日志——`[Scheduler]` 阶段标题、ReAct 的 `Thought/Action/Observation`、`🔧 [Tool]` 执行记录、Reflection 迭代轮次。
- **原理洞察**：认同第五章的判断——终端日志的调试体验确实不如可视化轨迹。但手写日志的过程中，你被迫回答"**哪些信息是调试必需的**"：中间决策（Thought/Action）、工具输入输出、每步耗时、迭代轮次。这份"可观测性需求清单"换个场景就是平台轨迹面板的设计稿。进阶方向：接入 LangSmith/Langfuse 类 tracing，日志结构化上报。

### 9. 部署与发布

- **Coze**：一键发布到微信/飞书/抖音/豆包，或 API 接入业务系统。
- **本项目**：`node cli.js`，readline 交互循环。
- **原理洞察**：平台一键发布的背后是**为每个渠道适配消息协议**（ webhook / bot 协议 / HTTP API）。CLI 是最简渠道，从 CLI 到 HTTP 服务只差一层接口转换（`cli.js` 的 `scheduler.run(text)` 已经是渠道无关的入口，返回 `{answer, streamed}`）。

---

## 三、低代码平台做不了（或很难做）的事

以下每一项都是本项目真实需要的逻辑，画布式编排要么无法表达，要么表达得极其别扭：

1. **运行时自适应的范式混合调度**
   "先 LLM 判断复杂度 → 复杂问题才走 Plan→ReAct→Reflection 混合"是运行时才确定的分支。平台画布是静态拓扑，要实现类似逻辑得把四种流程都画出来再用意图节点分流——分支一多，画布即失控。代码里这就是一个 `if`。

2. **精细的迭代控制策略**
   Reflection 的收敛检测（`/无[需须]改进|不需[要]?改进|已(达到)?最优/` 正则 + 3 轮上限）、每步 maxSteps 独立配置（`{react: 8, planAndSolve: 6, reflection: 3}`）、降级链（规划失败→直接 ReAct、汇总失败→拼接产出）。这些精细控制散落在流程各处，画布节点表达不了"循环直到正则匹配"。

3. **提示词与执行的深度耦合调试**
   实际调试中发现的两个提示词级问题，都依赖"看到完整中间输出"才能定位：
   - 工具描述缺参数 schema → LLM 反复猜错格式（上面第 4 节的坑）；
   - Reflection 无事实约束 → 把工具真实返回的"北京雾霾 26°C"优化成"无法获取实时数据，请访问天气网"，产出与工具事实脱节。修复方式是在 REFLECT_PROMPT 中加入"事实纪律"（工具返回的数据是最权威事实，禁止伪改进），并把把关上下文从"单步产出"扩为"全量步骤结果"。
   平台上你能看到节点红了，但改不了节点内部的提示词纪律——因为提示词模板是平台的标准件。

4. **输出通道的全局一致性治理**
   "流式输出开关打开时，LLM 内容全流程恰好打印一次"——需要统一约定所有调用点：中间决策非流式（或流式但跳过结构化日志）、汇总跟随开关、CLI 按 `streamed` 标记决定是否重复打印。这类**跨模块的输出协议**在配置式平台里没有对应概念。

5. **免费的架构演进能力**
   双模式（文本/FC）切换、记忆类型扩展、渠道替换，都只是加一个 if/一个模块文件。平台的边界就是平台功能的清单；代码的边界是你的想象力。

---

## 四、反向收获：平台 GUI 背后的原理透视表

手写后，再看 Coze/Dify 的每个配置项，都能映射到底层实现：

| 平台上的操作 | 背后实际发生的事 | 本项目对应 |
|---|---|---|
| 填写"人设与回复逻辑"（提示词框） | 模板字符串作为 system message 发给 LLM | 各 Agent 的 `*_PROMPT_TEMPLATE` |
| 添加插件并配置参数表单 | 生成 JSON Schema，注入 tools 参数或拼进提示词 | `Tool.parameters` + `get_tools_description()` |
| 打开"自主规划"开关 | 启用 Function Calling 循环（或 ReAct 文本循环） | `ENABLE_FUNCTION_CALLING` + `_handleToolCalls` |
| 添加知识库并挂载 | 用户消息先经检索，把召回片段注入上下文（RAG） | `memory/` 三类型检索（轻量版，无向量） |
| 设置开场白/变量 | 在 messages 首部插入固定内容 | `_sendMessages` 的 messages 构造 |
| 选择模型 + 温度滑杆 | 请求体的 `model` / `temperature` 字段 | `chatCompletion(messages, tools, options)` |
| 测试预览 & 运行轨迹 | 逐节点记录输入输出与耗时 | 结构化 `[Scheduler]/Thought/Action/🔧` 日志 |
| 一键发布到渠道 | 消息协议适配（webhook/bot/HTTP） | `cli.js` readline 循环（最简渠道） |

---

## 五、选型建议（结合两者经历）

| 场景 | 建议 |
|---|---|
| 快速验证想法、做活动 Bot、非技术团队 | Coze（插件生态 + 一键分发，效率碾压） |
| 企业级 LLM 应用、需要私有化 + RAG + 数据闭环 | Dify（开源可自部署，生产链路完整） |
| 学习 Agent 原理、需要深度定制控制流 | 手写（本项目路径），再回头看平台会完全透明 |
| 混合策略 | **平台 + 代码**：用 Dify 编排标准流程，自定义逻辑用代码节点/外部 API 透出——很多团队的最终形态 |

---

## 六、写在最后

第五章说"低代码平台并非要取代代码，而是提供了一种更高层次的抽象"。手写完这个项目后对这句话的体会是：**抽象是有代价的——代价就是你不再需要知道（也不再知道）底下发生了什么**。

- 平台的价值：把"API 调用、状态管理、并发控制"（5.1.1 原文）封装成节点，你因此不用踩我踩过的坑（工具 schema 缺失导致 LLM 瞎猜参数、Reflection 把事实优化成幻觉、流式与结构化日志双重打印）。
- 手写的价值：正是这些坑构成了对 Agent 运行机理的真实理解。平台文档里的"工作流/插件/知识库/数据库"游戏化比喻（5.2.1），手写者看一眼就知道每个"装备"对应的代码模块。

理想的成长路径正是本作业的路径：**先用代码把轮子拆开装一遍（第四章 → 本项目），再用平台快速组装（第五章）——此时平台对你不再是黑盒，而是你亲手实现过的东西的速记符号。**
