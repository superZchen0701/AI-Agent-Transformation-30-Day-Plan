/**
 * 参考资料：
 * - [《Hello-Agents》第6章「框架开发实践」6.2 AutoGen 软件开发团队](https://datawhalechina.github.io/hello-agents/#/./chapter6/%E7%AC%AC%E5%85%AD%E7%AB%A0%20%E6%A1%86%E6%9E%B6%E5%BC%80%E5%8F%91%E5%AE%9E%E8%B7%B5?id=_62-%e6%a1%86%e6%9e%b6%e4%b8%80%ef%bc%9aautogen)，产品经理 / 工程师 / 代码审查员四个角色的任务分解与协作——正是"规划者 + 编码者 + 测试者"的原型。
 * - [《Hello-Agents》第6章「框架开发实践」6.5 LangGraph 共享状态（State）](https://datawhalechina.github.io/hello-agents/#/./chapter6/%E7%AC%AC%E5%85%AD%E7%AB%A0%20%E6%A1%86%E6%9E%B6%E5%BC%80%E5%8F%91%E5%AE%9E%E8%B7%B5?id=_65-%e6%a1%86%e6%9e%b6%e5%9b%9b%ef%bc%9alanggraph)，节点间上下文传递的机制。
 * - [Anthropic《构建高效Agent》中文翻译·多智能体系统章节](https://blog.csdn.net/weixin_43807749/article/details/152788870)，Orchestrator-Worker、Pipeline、Debate、Hierarchical 四种编排模式的出处。
 * 
 * 实战任务：
 * 1.用 LangGraph 实现 Orchestrator-Worker 模式
 * 2.实现 Agent 间的消息传递和上下文共享机制
 * 3.测试：让三个 Agent 协作完成一个简单编程任务
 *
 * 架构：
 *   START → Orchestrator（LLM 动态分解任务）→(Send 扇出)→ Worker × N（并行）→ Synthesizer（汇总）→ END
 *
 * 核心机制：
 *   - Send 动态扇出：Orchestrator 运行时决定子任务数量，路由函数为每个子任务生成 Send
 *   - 每个 Send 携带独立 State 副本：Worker 间互不干扰，各自处理自己的子任务
 *   - reducer 汇总：Worker 结果通过 concat reducer 自动累积到共享状态
 */
import { ChatOpenAI } from '@langchain/openai';
import {
  START,
  END,
  StateGraph,
  Annotation,
  Send,
} from '@langchain/langgraph';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// 加载根目录下的.env到process.env
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

if (!process.env.DEEPSEEK_API_KEY) {
  throw new Error('未设置环境变量 DEEPSEEK_API_KEY，请先执行: export DEEPSEEK_API_KEY=你的key');
}

// ======================================================================
// 一、模型初始化
// ======================================================================
const model = new ChatOpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  modelName: 'deepseek-flash',
  temperature: 0,
  configuration: { baseURL: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com' },
  timeout: 120_000,
  maxRetries: 2,
});

// ======================================================================
// 二、State 设计（核心：Worker 间上下文共享机制）
//
// subtasks: Orchestrator 产出的子任务清单（数量运行时由 LLM 决定）
// worker_results: 各 Worker 的产出（concat reducer 自动累积，不覆盖）
// final_output: Synthesizer 汇总后的最终交付物
// ======================================================================
const OrchestratorState = Annotation.Root({
  // 用户原始需求
  requirement: Annotation(),
  // 子任务清单：[{ id, title, description, worker }]
  // 整体覆盖（Orchestrator 产出一批新任务，不需要追加）
  subtasks: Annotation({
    reducer: (_, update) => update,
    default: () => [],
  }),
  // Worker 产出累积区：每个 Worker 返回 { task_id, code, explanation }
  // 必须用 concat reducer！否则多个并行 Worker 的结果会互相覆盖
  worker_results: Annotation({
    reducer: (old, update) => [...(old || []), ...(update || [])],
    default: () => [],
  }),
  // 最终汇总结果
  final_output: Annotation(),
});

// Worker 独立 State 副本（通过 Send 传入，与主图 State 隔离）
// 每个 Worker 只看到自己的子任务，不看到其他 Worker 的中间状态
const WorkerState = Annotation.Root({
  // 当前 Worker 负责的子任务
  task: Annotation(),
  // Worker 产出的结果（写回主图 OrchestratorState 的 worker_results）
  worker_results: Annotation({
    reducer: (old, update) => [...(old || []), ...(update || [])],
    default: () => [],
  }),
});

// ======================================================================
// 三、节点函数
// ======================================================================

/**
 * Orchestrator 节点（编排者）：接收用户需求，用 LLM 动态分解为子任务清单
 *
 * 这是 Orchestrator-Worker 模式的核心：
 *   - 子任务数量在运行时由 LLM 决定（不是编码期固定的）
 *   - LLM 根据需求复杂度判断需要几个 Worker、每个做什么
 *   - 输出格式化的子任务列表，供下游 fan-out
 */
async function orchestratorNode(state) {
  console.log('\n🎯 Orchestrator: 正在分析需求并分解任务...');

  const prompt = [
    {
      role: 'system',
      content: `你是一个技术项目经理（Orchestrator）。用户会给你一个编程需求，你需要将其分解为 2-4 个独立的子任务。

每个子任务由一个 Worker 独立完成。分解原则：
1. 子任务之间尽量独立，可并行执行
2. 每个子任务明确产出物（函数/类/模块）
3. 子任务粒度适中，不要太大也不要太碎

你必须严格返回 JSON 格式，不要包含任何其他文字：
\`\`\`json
{
  "subtasks": [
    {
      "id": "task-1",
      "title": "子任务标题（简短）",
      "description": "详细描述要实现什么，包括函数签名、输入输出、边界条件",
      "worker": "worker"
    }
  ]
}
\`\`\``
    },
    { role: 'user', content: state.requirement },
  ];

  const response = await model.invoke(prompt);
  const content = response.content.toString().trim();

  // 从 LLM 输出中提取 JSON（兼容 markdown 代码块包裹）
  const jsonMatch = content.match(/```json\s*([\s\S]*?)```/) || content.match(/(\{[\s\S]*\})/);
  let subtasks;
  try {
    const jsonStr = jsonMatch ? jsonMatch[1].trim() : content;
    const parsed = JSON.parse(jsonStr);
    subtasks = parsed.subtasks || parsed;
  } catch {
    // JSON 解析失败：降级为单任务 Worker 处理
    console.log('  ⚠️ JSON 解析失败，降级为单任务 Worker');
    subtasks = [{ id: 'task-1', title: '完整实现', description: state.requirement, worker: 'worker' }];
  }

  console.log(`  📋 分解出 ${subtasks.length} 个子任务:`);
  subtasks.forEach((t, i) => {
    console.log(`     ${i + 1}. ${t.title || t.id}`);
  });

  return { subtasks };
}

/**
 * Worker 节点（工作者）：接收单个子任务，用 LLM 实现代码
 *
 * 关键点：
 *   - Worker 通过 Send 收到独立 State 副本 { task }，只看到自己的子任务
 *   - 多个 Worker 在同一超级步骤并行执行（Pregel 模型）
 *   - 返回结果写入 worker_results，由 concat reducer 自动累积
 */
async function workerNode(state) {
  const task = state.task;
  console.log(`  🔧 Worker 处理: ${task.title || task.id}`);

  const prompt = [
    {
      role: 'system',
      content: `你是一个高级工程师。请实现以下子任务，只输出代码和必要的注释。

要求：
1. 输出完整可运行的 JavaScript 函数/模块
2. 带关键注释
3. 只输出代码块，不要多余解释

输出格式：
\`\`\`javascript
// 代码内容
\`\`\``
    },
    {
      role: 'user',
      content: `子任务：${task.title}\n详细要求：${task.description}`,
    },
  ];

  const response = await model.invoke(prompt);
  const code = response.content.toString().trim();

  console.log(`  ✅ Worker 完成: ${task.title || task.id} (${code.length} 字符)`);

  return {
    worker_results: [{
      task_id: task.id,
      title: task.title,
      code: code,
    }],
  };
}

/**
 * Synthesizer 节点（汇总者）：收集所有 Worker 产出，整合为最终交付物
 *
 * 关键点：
 *   - 此时 state.worker_results 已通过 concat reducer 累积了所有 Worker 的产出
 *   - 用 LLM 做整合：检查接口兼容性、补全导入导出、生成使用示例
 */
async function synthesizerNode(state) {
  const results = state.worker_results || [];
  console.log(`\n📦 Synthesizer: 正在汇总 ${results.length} 个 Worker 的产出...`);

  // 拼接所有 Worker 的代码
  const allCode = results.map((r) => {
    return `// ===== ${r.title} (task: ${r.task_id}) =====\n${r.code}`;
  }).join('\n\n');

  const prompt = [
    {
      role: 'system',
      content: `你是代码整合工程师。多个 Worker 各自实现了模块的一部分代码。
请将它们整合为一个完整可运行的模块：

1. 检查函数间的接口兼容性，必要时调整
2. 补全必要的 import/export 语句
3. 添加模块级注释说明用法
4. 生成一个简单的使用示例
5. 输出完整代码

只输出最终的完整代码，不要额外解释。`
    },
    {
      role: 'user',
      content: `用户原始需求：${state.requirement}\n\n各 Worker 产出：\n${allCode}`,
    },
  ];

  const response = await model.invoke(prompt);
  const finalCode = response.content.toString().trim();

  console.log(`  ✅ 汇总完成，最终代码 ${finalCode.length} 字符`);

  return { final_output: finalCode };
}

// ======================================================================
// 四、路由函数：Send 动态扇出（Orchestrator-Worker 的核心机制）
//
// 为每个子任务生成一个 Send 对象，指定：
//   - 目标节点：'worker'
//   - 独立 State 副本：{ task: 子任务对象 }
//
// 框架会在同一超级步骤并行执行所有 Send 目标，结果通过 reducer 汇总
// ======================================================================
function fanoutToWorkers(state) {
  const subtasks = state.subtasks || [];
  console.log(`\n📡 扇出 ${subtasks.length} 个 Worker 并行执行...`);

  return subtasks.map((task) => new Send('worker', { task }));
}

// ======================================================================
// 五、组装工作流图
//
// 结构：
//   START → orchestrator →(Send 扇出)→ worker × N（并行）→ synthesizer → END
//
// 与 Pipeline 的区别：worker 数量运行时由 LLM 决定，不在编译期固定
// ======================================================================
function buildGraph() {
  const workflow = new StateGraph(OrchestratorState)
    .addNode('orchestrator', orchestratorNode)
    .addNode('worker', workerNode, WorkerState)  // Worker 用独立 State schema
    .addNode('synthesizer', synthesizerNode)
    // 入口：用户需求 → Orchestrator 分解
    .addEdge(START, 'orchestrator')
    // 条件边 + Send 扇出：Orchestrator → 动态 N 个 Worker（并行）
    .addConditionalEdges('orchestrator', fanoutToWorkers, ['worker'])
    // 所有 Worker 完成后 → Synthesizer 汇总
    .addEdge('worker', 'synthesizer')
    // 汇总完 → 结束
    .addEdge('synthesizer', END);

  return workflow.compile();
}

// ======================================================================
// 六、测试场景
// ======================================================================

/**
 * 测试：三个 Agent 协作完成一个简单编程任务
 *
 * 用户需求："实现一个用户管理模块"
 * Orchestrator 会动态分解为（数量由 LLM 决定）：
 *   - Worker 1: 实现用户创建（createUser）
 *   - Worker 2: 实现用户查询（findUser / listUsers）
 *   - Worker 3: 实现用户删除（deleteUser）
 * Synthesizer 整合为完整模块 + 使用示例
 */
async function main() {
  console.log('═'.repeat(60));
  console.log('Orchestrator-Worker 模式：三 Agent 协作编程');
  console.log('═'.repeat(60));

  const app = buildGraph();

  const requirement = '实现一个简单的用户管理模块，包含：创建用户（校验邮箱格式）、查询用户列表、删除指定用户。数据用内存数组存储。';

  console.log(`\n👤 用户需求: ${requirement}`);

  const result = await app.invoke({ requirement });

  // 输出最终结果
  console.log('\n' + '═'.repeat(60));
  console.log('🎉 最终交付物:');
  console.log('═'.repeat(60));
  console.log(result.final_output);

  // 展示中间过程（上下文共享机制验证）
  console.log('\n' + '═'.repeat(60));
  console.log('📊 执行过程回顾:');
  console.log('═'.repeat(60));
  console.log(`  子任务数: ${result.subtasks?.length || 0}`);
  console.log(`  Worker 产出数: ${result.worker_results?.length || 0}`);

  if (result.worker_results) {
    result.worker_results.forEach((r, i) => {
      console.log(`  Worker ${i + 1}: ${r.title} → ${r.code.length} 字符`);
    });
  }

  // 验证上下文共享：Synthesizer 能看到所有 Worker 的产出
  console.log('\n✅ 上下文共享验证:');
  console.log('  - Orchestrator → Worker: 通过 Send 传递独立 task 副本');
  console.log('  - Worker → Synthesizer: 通过 concat reducer 累积到 worker_results');
  console.log(`  - Synthesizer 收到 ${result.worker_results?.length || 0} 个 Worker 产出并整合`);
}

// 统一捕获主流程异常
main().catch((err) => {
  console.error('\n❌ Agent 执行出错:', err.message);
  process.exit(1);
});
