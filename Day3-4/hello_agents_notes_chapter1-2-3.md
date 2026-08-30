# Hello-Agents 第 1–3 章 读书笔记

## 一、通读第1–3章（初识智能体 / 发展史 / LLM 基础），建立 Agent 全局认知

- [第一章 初识智能体](https://datawhalechina.github.io/hello-agents/#/./chapter1/%E7%AC%AC%E4%B8%80%E7%AB%A0%20%E5%88%9D%E8%AF%86%E6%99%BA%E8%83%BD%E4%BD%93)

- [第二章 智能体发展史](https://datawhalechina.github.io/hello-agents/#/./chapter2/%E7%AC%AC%E4%BA%8C%E7%AB%A0%20%E6%99%BA%E8%83%BD%E4%BD%93%E5%8F%91%E5%B1%95%E5%8F%B2)

- [第三章 大语言模型基础](https://datawhalechina.github.io/hello-agents/#/./chapter3/%E7%AC%AC%E4%B8%89%E7%AB%A0%20%E5%A4%A7%E8%AF%AD%E8%A8%80%E6%A8%A1%E5%9E%8B%E5%9F%BA%E7%A1%80)

### 关于 Agent 循环

#### Agent 的五大核心组件

| 组件 | 作用 | 在 LLM Agent 中的对应 |
| ------ | ------ | --------------------- |
| 大脑 (LLM) | 推理、决策、理解自然语言 | DeepSeek / GPT 等大模型 |
| 记忆 (Memory) | 存储历史交互与上下文 | messages 数组（短期）/ 向量库（长期） |
| 规划 (Planning) | 任务分解、子目标制定 | LLM 内部推理 + 思维链 |
| 工具 (Tools) | 扩展能力边界（联网/计算/代码执行） | Function Calling 注册的工具 |
| 行动 (Action) | 执行器，对环境产生实际影响 | 调用本地 JS 函数 / API |

#### 循环的四个阶段

这个循环主要包含以下几个相互关联的阶段：

1. **感知 (Perception)**：这是循环的起点。智能体通过其传感器（例如，API 的监听端口、用户输入接口）接收来自环境的输入信息。这些信息，即**观察 (Observation)**，既可以是用户的初始指令，也可以是上一步行动所导致的环境状态变化反馈。
2. **思考 (Thought)**：接收到观察信息后，智能体进入其核心决策阶段。对于 LLM 智能体而言，这通常是由大语言模型驱动的内部推理过程。"思考"阶段可进一步细分为两个关键环节：
   - **规划 (Planning)**：智能体基于当前的观察和其内部记忆，更新对任务和环境的理解，并制定或调整一个行动计划。这可能涉及将复杂目标分解为一系列更具体的子任务。
   - **工具选择 (Tool Selection)**：根据当前计划，智能体从其可用的工具库中，选择最适合执行下一步骤的工具，并确定调用该工具所需的具体参数。
3. **行动 (Action)**：决策完成后，智能体通过其执行器（Actuators）执行具体的行动。这通常表现为调用一个选定的工具（如代码解释器、搜索引擎 API），从而对环境施加影响，意图改变环境的状态。
4. **观察 (Observation)**：行动引起环境 (Environment) 的状态变化 (State Change)，环境随即产生一个新的观察作为结果反馈。

#### 循环的闭环与终止

行动并非循环的终点。新的观察又会在下一轮循环中被智能体的感知系统捕获，形成一个持续的"**感知 → 思考 → 行动 → 观察 → 感知 → ...**"闭环。智能体正是通过不断重复这一循环，逐步推进任务，从初始状态向目标状态演进。

**循环终止条件**（任一满足即停）：

- 任务完成：LLM 不再发起工具调用，直接生成最终回复（如 Day2/function-calling-ds-demo.js 代码中 `if (!toolCalls) break;`）
- 达到上限：防止无限循环的安全阀（如 Day2/function-calling-ds-demo.js 代码中 `if (curTurn > MAX_ROUNDS) break;`）
- 用户中止：用户主动停止交互

#### 经典范式：ReAct

思考 + 行动交替的循环范式被称为 **ReAct (Reasoning + Acting)**：每一步先"推理"再"行动"，再"观察"结果反馈下一步推理。Day2 的 function-calling-ds-demo.js 即是 ReAct 的最小实现。

## 二、对照【第一章 初识智能体】「感知→规划→行动」循环定义，在 Day2/function-calling-ds-demo.js 里逐行标出：哪几行是感知、哪几行是规划（LLM 决定调哪个工具）、哪几行是行动（真正执行函数）、哪几行是观察（结果回传）

> 四阶段在代码中并非孤立块，而是循环交织：感知收集输入→触发 LLM 规划→解析规划结果→执行行动→回传观察→进入下一轮感知。

### 感知（接收外部输入与 LLM 响应，更新内部状态）

```javascript
// 第110行：接收用户原始输入
const messages = [{ role: 'user', content: '北京天气如何， plus 3*7 等于多少' }];

// 第114行：显示感知到的输入
console.log(`User: ${messages[0].content}`);

// 第123行：把上下文发给 LLM 并接收其响应（响应里含规划结果 tool_calls）
const message = await send_messages(messages);

// 第124行：把 LLM 响应加入 messages 上下文（更新内部记忆）
messages.push(message);

// 第125-127行：从响应中提取内容与工具调用列表，并打印当前轮次状态
const content = message.content;
const toolCalls = message.tool_calls;
console.log(`当前轮次: ${curTurn}\ncontent: ${content}\ntool_calls: ${JSON.stringify(toolCalls)}`);
```

> 注：第119-122行 `if (curTurn > MAX_ROUNDS) { ... break; }` 是**循环控制/终止条件**，不属于感知阶段，只是防止无限循环的安全阀。

### 规划（LLM 决定调哪个工具、传什么参数）

```javascript
// 第101-108行：send_messages 内部调用 create，把上下文+tools 交给 LLM
// LLM 在模型侧完成"规划"——决定是否调工具、调哪个、传什么参数
async function send_messages(messages) {
  const completion = await openai.chat.completions.create({
    messages,
    model: 'deepseek-v4-flash',
    tools
  });
  return completion.choices[0].message;
}

// 第126行：从 LLM 响应中解析出规划结果（要调用的工具列表）
const toolCalls = message.tool_calls;

// 第132行：取出具体工具名（LLM 已决定调哪个）
const toolFuncName = tool.function.name;

// 第136-141行：解析 LLM 给出的 JSON 参数字符串（规划的具体参数）
let args = {};
try {
  args = JSON.parse(tool.function.arguments);
} catch {
  console.error(`⚠️ 工具 '${toolFuncName}' 的参数不是合法JSON: ${tool.function.arguments}`);
}
```

### 行动（真正执行本地函数）

```javascript
// 第143行：根据 LLM 规划的工具名，动态调用对应 JS 函数并传入参数
const toolResult = await TOOL_CALL_MAP[toolFuncName](args);

// 第144行：打印行动结果（兼有观察性质，供开发者监控）
console.log(`tool result for ${toolFuncName}: ${toolResult}\n`);
```

### 观察（结果回传上下文，供下一轮感知使用）

```javascript
// 第146-150行：把工具执行结果以 role:'tool' 回传 messages
// tool_call_id 用于关联到 LLM 发起的那次工具调用
messages.push({
  role: 'tool',
  tool_call_id: tool.id,
  content: toolResult
});
```

> 注：第152行 `curTurn++` 是**循环控制变量递增**，不属于观察阶段。

### 循环全景

```bash
用户输入(感知) → LLM规划(调tool_calls) → 解析参数(规划收尾) → 执行函数(行动)
    ↑                                                              ↓
    └───────────────── 结果回传messages(观察) ←──────────────────────┘
```

下一轮感知会读到 messages 里新增的 tool 结果，LLM 据此决定：继续调工具 / 生成最终回复（无 tool_calls 时 break 退出）。

## 三、第3章讲 LLM 三大局限（幻觉 / 没有实时数据 / 上下文窗口有限）——对照你的 Day2/function-calling-ds-demo.js 代码，说清解决了哪一个、还有哪两个没解决

| 局限 | 是否解决 | 代码佐证 |
| ------ | ------ | ------ |
| 1 幻觉 | **部分缓解** | `calculator` 工具把算术外包给确定性 JS 函数，消除"计算类幻觉"；但事实性/组织回复时的幻觉仍存在 |
| 2 没有实时数据 | **部分解决** | `get_weather` 调 wttr.in 拿到实时天气，解决了天气类实时数据；但新闻/股价等其他实时信息还需扩展工具 |
| 3 上下文窗口有限 | **未解决** | `messages` 数组无限累积，无截断/摘要/记忆管理，长对话必超窗 |

### 局限1 - 幻觉（部分缓解）

```javascript
// calculator 把"算术"外包给 JS，LLM 不再自己瞎算 → 计算类幻觉被消除
const toolResult = await TOOL_CALL_MAP[toolFuncName](args);  // "3*7 = 21"
```

**未根除的部分**：LLM 在最后组织回复时仍可能误解工具结果、在非工具话题上编造事实。例如把 wttr.in 返回的"晴"说成"雨"，或在没工具支撑的话题上胡说。

### 局限2 - 没有实时数据（部分解决）

```javascript
// get_weather 调 wttr.in 拿实时天气，绕开 LLM 训练数据截止的问题
const url = `https://wttr.in/${encodeURIComponent(location)}?format=j1&lang=zh`;
const resp = await fetch(url);
```

**未覆盖的部分**：只解决了"天气类"实时数据，新闻、股价、汇率等还需新增对应工具（Day2 后续已加 `web_search` 网络搜索工具，进一步缓解此局限）。

### 局限3 - 上下文窗口有限（未解决）

```javascript
// messages 一直 push，没有任何长度控制/记忆管理
messages.push(message);        // 第124行：LLM 响应入栈
messages.push({ role: 'tool', tool_call_id: tool.id, content: toolResult });  // 第146行：工具结果入栈
```

**问题**：每轮对话 messages 持续增长，多轮后必超出 DeepSeek 的 context window（deepseek-v4-flash 约 1M tokens），届时 API 返回 400 或内容被截断。

**解决思路（后续课程会讲）**：摘要压缩 / 滑动窗口 / 向量检索记忆（RAG）。当前 demo 还没涉及。
