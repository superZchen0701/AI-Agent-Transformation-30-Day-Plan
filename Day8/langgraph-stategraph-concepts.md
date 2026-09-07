# LangGraph 核心概念笔记：StateGraph 三大要素 —— State / Node / Edge

> 来源：[LangGraphJS 官方文档 - Low Level Concepts](https://github.langchain.ac.cn/langgraphjs/concepts/low_level/)
> 一句话总纲：**节点负责工作（干活），边决定下一步做什么（路由），状态在节点间流转（共享内存）。**

---

## 0. 全局心智模型

LangGraph 的核心思想：**把 Agent 工作流建模为一张图（Graph）**，由三个关键组件定义行为：

| 组件 | 本质 | 职责 | 类比 |
| --- | --- | --- | --- |
| **State（状态）** | 共享数据结构（`Annotation` 对象） | 应用当前快照，所有节点读写的"全局内存" | 流水线上的托盘 |
| **Node（节点）** | JS/TS 函数（同步或 async） | 接收当前 State → 执行计算/副作用 → 返回 State 更新 | 流水线上的工位 |
| **Edge（边）** | JS/TS 函数或固定连线 | 根据当前 State 决定下一个执行哪个 Node | 工位间的传送带/道岔 |

关键认知：

1. **Node 和 Edge 本质上就是普通 JS/TS 函数** —— 函数体内可以调 LLM，也可以只是普通代码（如读文件、算数学）。
2. **Node 不需要返回完整 State，只需返回"更新片段"**；如何合并由 State 中每个键各自的 **reducer（归约函数）** 决定。
3. 底层执行引擎受 Google [Pregel](https://research.google/pubs/pregel-a-system-for-large-scale-graph-processing/) 启发，采用**消息传递 + 超级步骤（superstep）**模型：
   - 初始所有节点 `inactive`；节点在传入边（通道）收到新消息时变为 `active`；
   - **同一超级步骤内的节点并行执行，不同超级步骤顺序执行**；
   - 每个超级步骤结束时，收不到消息的节点投票 `halt`；全部 inactive 且无在途消息时，图终止。

---

## 1. 图（Graph）与编译

### 1.1 StateGraph —— 主图类

`StateGraph` 是核心图类，通过用户用 `Annotation` 定义的 State 对象进行参数化：

```js
import { StateGraph, Annotation } from '@langchain/langgraph';

// ① 先定义 State schema
const StateAnnotation = Annotation.Root({
  foo: Annotation<number>,
  bar: Annotation<string[]>,
});

// ② 用 State 初始化图构建器
const graphBuilder = new StateGraph(StateAnnotation);
```

> `MessageGraph`（传统类）的 State 仅为一个消息数组，除纯聊天机器人外很少使用 —— 大多数应用的 State 远比消息数组复杂。

### 1.2 编译（compile）—— 使用前必须执行

定义完 State、添加完节点和边后，**必须编译**才能运行：

```js
const graph = graphBuilder.compile({
  checkpointer: agentCheckpointer, // 可选：检查点（状态持久化）
  // interruptBefore / interruptAfter 等断点也在此指定
});
```

编译做两件事：

1. **结构校验**：检查图是否合法（如不存在孤立节点）；
2. **挂载运行时参数**：checkpointer、断点（interrupts）等。

---

## 2. State（状态）—— 图的全局共享内存

State 是定义图时**第一件要做的事**。它包含两类信息：

- 数据本身（图结构信息 + 业务字段）；
- 每个字段如何被更新的规则（**reducer 函数**）。

State 的 schema 是所有 Node 和 Edge 的**输入 schema**。

### 2.1 Annotation —— 定义 State schema

用 `Annotation.Root({...})` 定义，每个键对应状态中的一个通道（channel）：

```js
const State = Annotation.Root({
  foo: Annotation<number>,   // 通道 foo：number 类型
  bar: Annotation<string[]>, // 通道 bar：string 数组
});
```

### 2.2 Reducer（归约函数）—— 控制"更新如何合并"

**每个键拥有独立的 reducer。未显式指定时，默认行为是"覆盖"（新值直接替换旧值）。**

reducer 签名固定为 `(state, update) => newValue`：`state` 是当前值，`update` 是节点返回的新值。

**示例 A：默认覆盖语义**

```js
const State = Annotation.Root({
  foo: Annotation<number>,
  bar: Annotation<string[]>,
});
// 输入 { foo: 1, bar: ["hi"] }
// 节点1返回 { foo: 2 }        → State = { foo: 2, bar: ["hi"] }      （foo 被覆盖）
// 节点2返回 { bar: ["bye"] }  → State = { foo: 2, bar: ["bye"] }     （bar 被覆盖，"hi" 丢失）
```

**示例 B：自定义 reducer —— 数组追加**

```js
const State = Annotation.Root({
  foo: Annotation<number>,
  bar: Annotation<string[]>({
    // 自定义归约：把更新拼接到现有数组后（而非覆盖）
    reducer: (state: string[], update: string[]) => state.concat(update),
    default: () => [], // 通道初始默认值
  }),
});
// 输入 { foo: 1, bar: ["hi"] }
// 节点1返回 { foo: 2 }       → State = { foo: 2, bar: ["hi"] }
// 节点2返回 { bar: ["bye"] } → State = { foo: 2, bar: ["hi", "bye"] }（bar 被追加保留）
```

> 经验法则：**"单值"字段（当前意图、中间结果）用默认覆盖；"累积"字段（消息列表、文档列表）必须配追加型 reducer**，否则历史会被每次更新冲掉。

### 2.3 多 Schema：input / output / private 状态

默认所有节点读写同一组状态通道。需要更细控制时，可定义三类 schema：

- **Input Schema**：图的对外输入（Overall 的子集）；
- **Output Schema**：图的对外输出（Overall 的子集，可只暴露一个结果键）；
- **Private State**：内部节点间传递、无需暴露给图外的通道。

```js
const InputStateAnnotation = Annotation.Root({
  user_input: Annotation<string>,
});
const OutputStateAnnotation = Annotation.Root({
  graph_output: Annotation<string>,
});
// 内部完整状态 = 输入 + 输出 + 内部字段
const OverallStateAnnotation = Annotation.Root({
  foo: Annotation<string>,
  bar: Annotation<string>,
  user_input: Annotation<string>,
  graph_output: Annotation<string>,
});

const graph = new StateGraph({
  input: InputStateAnnotation,       // 对外输入过滤
  output: OutputStateAnnotation,     // 对外输出过滤
  stateSchema: OverallStateAnnotation,
})
  .addNode('node1', node1)
  // ...
  .compile();

await graph.invoke({ user_input: 'My' });
// → { graph_output: 'My name is Lance' }（foo/bar 等内部字段不外露）
```

重要规则：**节点可以写入图状态中的任意通道**（即使该通道不在它的输入 schema 里）——图状态是初始化时所有通道的并集。

### 2.4 在 State 中处理消息（Messages）

LLM 聊天接口输入是消息列表（`HumanMessage` / `AIMessage` / `ToolMessage`...）。把对话历史放进 State 时有两个要点：

**(1) 必须用追加型 reducer**，否则每条新消息都会覆盖整个历史列表。

**(2) 要用 `messagesStateReducer` 而非简单 concat**，因为它额外提供：

- **按消息 ID 覆盖**：人在回路（human-in-the-loop）手动更新某条已有消息时，是替换而非追加；
- **自动反序列化**：支持传入 LangChain `Message` 对象，也支持原生 OpenAI 格式 `{ role, content }`，自动转换。

```js
import type { BaseMessage } from '@langchain/core/messages';
import { Annotation, messagesStateReducer, type Messages } from '@langchain/langgraph';

const StateAnnotation = Annotation.Root({
  messages: Annotation<BaseMessage[], Messages>({
    reducer: messagesStateReducer, // 追加新消息 + 按 ID 更新旧消息 + 格式归一化
  }),
});
```

**预构建 `MessagesAnnotation`**：消息场景太常见，框架内置了只含 `messages` 一个键的注解，可直接用或展开扩展：

```js
import { MessagesAnnotation, StateGraph, Annotation } from '@langchain/langgraph';

// 直接用
const graph = new StateGraph(MessagesAnnotation).addNode(/* ... */);

// 扩展：消息 + 业务字段（典型做法）
const StateWithDocuments = Annotation.Root({
  ...MessagesAnnotation.spec,        // 展开内置 messages 通道
  documents: Annotation<string[]>,   // 追加自定义通道
});
```

> 另有 `MessagesZodState`，用 Zod 而非 Annotation API 定义同等结构。

---

## 3. Node（节点）—— 干活的函数

### 3.1 节点函数签名

节点就是普通函数（sync/async 均可）：

- **第一个参数**：当前 State；
- **第二个参数（可选）**：`config`，含可配置运行时参数（如 `thread_id`、`user_id`）。

```js
import { RunnableConfig } from '@langchain/core/runnables';
import { StateGraph, Annotation } from '@langchain/langgraph';

const GraphAnnotation = Annotation.Root({
  input: Annotation<string>,
  results: Annotation<string>,
});

// 节点：读 state.input，写 state.results
const myNode = (state: typeof GraphAnnotation.State, config?: RunnableConfig) => {
  console.log('In node: ', config.configurable?.user_id);
  return { results: `Hello, ${state.input}!` }; // 只返回更新片段
};

// 第二个参数可省略
const myOtherNode = (state: typeof GraphAnnotation.State) => state;

const builder = new StateGraph(GraphAnnotation)
  .addNode('myNode', myNode)
  .addNode('myOtherNode', myOtherNode);
```

底层机制：函数会被包装成 `RunnableLambda`，自动获得**批处理、流式输出、链路追踪与调试**能力。

### 3.2 两个虚拟节点：`START` 与 `END`

| 虚拟节点 | 含义 | 用途 |
| --- | --- | --- |
| `START` | 用户输入进入图的入口 | 标记**最先执行**哪个节点 |
| `END` | 终止节点 | 标记某些边执行完后**无后续**（图在此分支结束） |

```js
import { START, END } from '@langchain/langgraph';

graph.addEdge(START, 'nodeA');  // nodeA 是入口
graph.addEdge('nodeA', END);    // nodeA 执行完图即终止
```

---

## 4. Edge（边）—— 路由与停止的规则

边定义"逻辑如何流转、图何时停止"。共四种：

| 边类型 | API | 语义 |
| --- | --- | --- |
| 普通边 | `addEdge(a, b)` | 无条件：a 执行完**总是**去 b |
| 条件边 | `addConditionalEdges(a, router, map?)` | a 执行完调用**路由函数**，按返回值决定去哪个（些）节点 |
| 入口点 | `addEdge(START, a)` | 图启动时固定先跑 a |
| 条件入口点 | `addConditionalEdges(START, router, map?)` | 图启动时按路由函数决定从哪个节点开始 |

### 4.1 普通边

```js
graph.addEdge('nodeA', 'nodeB'); // A → B，固定流转
```

### 4.2 条件边（Agent 循环的核心机制）

```js
// 路由函数：接收当前 state，返回"下一个节点名"（或节点名数组）
graph.addConditionalEdges('nodeA', routingFunction);

// 推荐写法：返回分支 key + 提供 key→节点名 的映射表，拓扑集中维护、无歧义
graph.addConditionalEdges('nodeA', routingFunction, {
  true: 'nodeB',
  false: 'nodeC',
  // 也可映射到 END 表示终止
});
```

要点：

- 路由函数**只做判断、返回 key**，不要在里面写业务更新（业务更新归节点管）；
- 返回**数组**（或映射目标为多个）时，目标节点在下一超级步骤**并行执行（fan-out）**；
- 一个节点有多条出站边时，所有目标同样并行；
- 若想在一个函数里**同时完成状态更新 + 路由**，使用 [`Command`](https://github.langchain.ac.cn/langgraphjs/concepts/low_level/#command) 对象而非条件边。

### 4.3 入口点 / 条件入口点

```js
// 固定入口
new StateGraph(/* ... */).addEdge(START, 'nodeA');

// 条件入口：输入到达时先跑路由函数决定起点
new StateGraph(/* ... */).addConditionalEdges(START, routingFunction, {
  true: 'nodeB',
  false: 'nodeC',
});
```

### 4.4 `Send` —— 动态扇出（map-reduce 模式）

普通边的目标节点在编译期固定、且共享同一份 State。但 map-reduce 场景下：

- 第一个节点生成**数量未知**的对象数组（边数无法预知）；
- 下游节点需要对**每个对象用不同的 State 副本**并行处理。

此时路由函数可返回 `Send` 对象数组：`new Send(nodeName, stateForThatNode)`，分别指定"发给哪个节点 + 该节点收到的独立状态"，实现运行时动态展开并行分支。

```js
/**
 * LangGraph 路由函数（Routing Function）一种形态演示：
 * - Send 动态扇出 —— 路由函数返回「Send 对象数组」，运行时动态决定扇出数量，
 *         每个 Send 携带独立 State 副本（map-reduce 模式）
 *         适用：分支数量运行时才知道（如对 N 个主题并行处理）
 */
import { StateGraph, Annotation, Send, START, END } from '@langchain/langgraph';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ts = () => new Date().toISOString().slice(11, 23); // 毫秒级时间戳，用于观察并行

// ======================================================================
// Send 动态扇出（map-reduce，分支数量运行时才确定）
// ======================================================================

const FanoutState = Annotation.Root({
  topics: Annotation, // map 阶段产出的主题列表（数量运行时才知道）
  // 累积型通道：必须配 concat reducer，否则多个 worker 的结果会互相覆盖
  jokes: Annotation({
    reducer: (current, update) => current.concat(update),
    default: () => [],
  }),
});

// map 节点：生成 N 个待处理对象（模拟 LLM 拆任务，此处数量写死但可任意变化）
const mapNode = () => {
  const topics = ['猫', '程序员', '咖啡'];
  console.log(`[${ts()}] mapNode 生成 ${topics.length} 个主题: ${topics.join(' / ')}`);
  return { topics };
};

// worker 节点：每个 Send 携带独立 State 副本 { topic }，同一超级步骤内并行执行
const jokeWorker = async (state) => {
  const start = Date.now();
  console.log(`[${ts()}] jokeWorker 开始处理: ${state.topic}`);
  await sleep(300); // 模拟 LLM 生成耗时
  console.log(`[${ts()}] jokeWorker 完成处理: ${state.topic}（耗时 ${Date.now() - start}ms）`);
  // 返回的是累积通道 jokes 的更新片段，由 concat reducer 合并
  return { jokes: [`关于「${state.topic}」的笑话：这是一个模拟笑话 😄`] };
};

/**
 * 路由函数（fan-out）：为每个 topic 生成一个 Send
 * - Send 第 1 参数：目标节点名
 * - Send 第 2 参数：该节点独立收到的 State（各 worker 互不干扰）
 * - 第三参数 ['jokeWorker']：声明可能的目标节点，供编译期做图结构校验
 */
const fanoutRouter = (state) =>
  state.topics.map((topic) => new Send('jokeWorker', { topic }));

const fanoutGraph = new StateGraph(FanoutState)
  .addNode('mapNode', mapNode)
  .addNode('jokeWorker', jokeWorker)
  .addEdge(START, 'mapNode')
  .addConditionalEdges('mapNode', fanoutRouter, ['jokeWorker'])
  .addEdge('jokeWorker', END)
  .compile();

async function main() {
  console.log('========== Send 动态扇出（map-reduce）==========');
  const fanoutStart = Date.now();
  const fanoutResult = await fanoutGraph.invoke({ topics: [] });
  console.log(`\n总耗时: ${Date.now() - fanoutStart}ms（3 个 worker 各 sleep 300ms，并行则 ≈300ms，串行则 ≈900ms）`);
  console.log('reduce 合并结果:');
  fanoutResult.jokes.forEach((joke, i) => console.log(`  ${i + 1}. ${joke}`));
}

main().catch((err) => {
  console.error('❌ 执行出错:', err);
  process.exit(1);
});
```

---

## 5. 串起来：一张图的完整构建流程

```js
import { StateGraph, Annotation, START, END, MessagesAnnotation } from '@langchain/langgraph';
import { MemorySaver } from '@langchain/langgraph';

// ① 定义 State（含 reducer 规则）
const StateAnnotation = Annotation.Root({
  ...MessagesAnnotation.spec,            // messages 通道：追加 + 按 ID 更新
  intent: Annotation<string>,            // 单值字段：默认覆盖
});

// ② 定义节点函数：(state, config?) => 状态更新片段
const callModel = async (state) => {
  // ...调 LLM，返回 { messages: [aiMessage] }（messages 走追加 reducer）
  return { messages: [aiMessage] };
};
const routeByIntent = (state) => (state.intent === 'search' ? 'search' : 'answer');

// ③ 组装图：节点 + 边
const graph = new StateGraph(StateAnnotation)
  .addNode('agent', callModel)
  .addNode('search', searchNode)
  .addNode('answer', answerNode)
  .addEdge(START, 'agent')                       // 入口
  .addConditionalEdges('agent', routeByIntent, { // 条件分支
    search: 'search',
    answer: 'answer',
  })
  .addEdge('search', 'agent')                    // 工具结果回到 agent → 形成循环
  .addEdge('answer', END)                        // 终止
  .compile({ checkpointer: new MemorySaver() }); // ④ 编译 + 挂载检查点
```

> 这正是 `createReactAgent` 预构建图的手写等价形态：**agent 节点 ↔ tools 节点之间的条件边循环**，就是 ReAct「思考→行动→观察」循环的图表达。

---

## 6. 与本目录 Day8 代码的对应关系

| 概念 | 在 `langgraph-react-agent.js` 中的体现 |
| --- | --- |
| State | `createReactAgent` 内部使用 `MessagesAnnotation`（`messages` 通道 + `messagesStateReducer`） |
| Node | 预构建的 `agent` 节点（调 LLM）与 `tools` 节点（执行 TavilySearch） |
| Edge | agent →（条件边：有无 tool_calls）→ tools → agent 循环；无工具调用时 → END |
| Checkpointer | `new MemorySaver()`：编译期挂载，使同一 `thread_id` 的多轮 `invoke` 间状态不丢 |
| 超级步骤 | LLM 调用与工具执行交替进行，每轮"模型决策/工具执行"各属一个超级步骤 |

---

## 7. 易错点速查

1. **忘记 compile**：不编译直接 invoke 会报错；checkpointer/断点只能在 compile 时传入。
2. **累积字段没配 reducer**：消息/列表类字段用默认覆盖语义，历史每次被清空 —— 必须用 `messagesStateReducer` 或自定义 concat reducer。
3. **节点返回完整 State**：不需要也不应该，只返回变更的键；合并且由 reducer 负责。
4. **路由函数里写业务逻辑**：路由函数只返回分支 key（或 `Send`/`Command`），业务更新放节点。
5. **条件边漏了映射表**：直接返回节点名字符串可用，但返回业务 key（true/false、意图名）时必须提供第三参数映射，否则框架会把 key 当节点名报错。
6. **Node/Edge 不是黑盒**：它们就是普通函数，可以不依赖 LLM 做任意计算，调试时可直接单测。
