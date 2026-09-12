/**
 * 参考资料：
 * - [LangGraph 官方文档 Multi-Agent Tutorials 章节：Supervisor 模式、Network 模式](https://github.langchain.ac.cn/langgraphjs/concepts/multi_agent/)
 * 
 * 实战任务：
 * 1. 用 LangGraph Supervisor 模式实现代码审查系统：Planner / Coder / Reviewer / Tester 四个 Agent。
 * 2. 实现 Agent 间的结构化消息传递。
 * 3. 理解为什么上下文隔离是 Multi-Agent 的关键设计（给出详细解释）。
 * 4. 添加循环终止条件（最大迭代次数 / 任务完成判定）。
 *
 * 架构：
 *   START → Supervisor（LLM 决策下一个调谁）→ Planner / Coder / Reviewer / Tester
 *               ↑                                          ↓
 *               └──────────────────────────────────────────┘（每个 Agent 执行完回到 Supervisor）
 *
 * 核心机制：
 *   - Supervisor 模式：中央 LLM 负责调度，每个 Agent 执行完返回 Supervisor
 *   - Command 对象：同时控制流（goto）+ 状态更新（update）
 *   - withStructuredOutput：Supervisor 强制返回 { next_agent, task_complete } 结构化决策
 *   - 循环终止：最大迭代次数 max_iterations 防死循环 + Reviewer/Tester 的任务完成判定
 *   - 上下文隔离：每个 Agent 只收到"必要的"消息摘要，而非完整历史（避免上下文污染）
 */
import { ChatOpenAI } from '@langchain/openai';
import {
  START,
  END,
  StateGraph,
  Annotation,
  Command,
  MessagesAnnotation,
} from '@langchain/langgraph';
import { HumanMessage, AIMessage, SystemMessage } from '@langchain/core/messages';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// ======================================================================
// 零、环境初始化
// ======================================================================
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

// 注意：deepseek-flash 不支持 withStructuredOutput，Supervisor 用手动 JSON 提示 + 解析

// ======================================================================
// 二、State 设计
//
// 设计哲学：**共享必要信息 + 隔离思考过程**
//   - messages：消息列表（共享，所有 Agent 能看到之前的摘要）
//   - iteration_count：迭代计数（防死循环）
//   - max_iterations：最大迭代次数（硬终止）
//   - plan：Planner 的规划结果
//   - current_code：当前最新代码（Coder 产出，Reviewer/Tester 消费）
//   - review_feedback：Reviewer 的结构化反馈
//   - test_result：Tester 的测试结果
//   - final_output：最终交付物（task_complete=true 时填入）
// ======================================================================
const CodeReviewState = Annotation.Root({
  // 继承 LangGraph 内置的消息通道（带 concat reducer）
  ...MessagesAnnotation.spec,
  // 用户原始需求
  requirement: Annotation(),
  // 迭代计数（每轮 Supervisor 决策 +1）
  iteration_count: Annotation({
    reducer: (_, update) => update,
    default: () => 0,
  }),
  // 最大迭代次数（硬终止安全闸）
  max_iterations: Annotation({
    reducer: (_, update) => update,
    default: () => 10,
  }),
  // 四个 Agent 的产出槽位（覆盖式，只保留最新版本）
  plan: Annotation(),           // Planner 产出
  current_code: Annotation(),   // Coder 产出（当前最新代码）
  review_feedback: Annotation(), // Reviewer 产出（结构化反馈）
  test_result: Annotation(),    // Tester 产出（测试结果）
  // 最终交付物
  final_output: Annotation(),
});

// ======================================================================
// 三、Agent 节点函数
//
// 每个 Agent 的共同模式：
//   1. 从 state 中提取自己需要的最小必要信息（而非读全部 messages）
//   2. 用专属 system prompt + 精简上下文调 LLM
//   3. 返回 Command：goto='supervisor' + update（写入自己的产出槽）
//
// ！！这就是"上下文隔离"的体现：
//   - Agent 间不共享完整思考链（避免信息过载 + 上下文污染）
//   - 只通过结构化产出槽位传递"结果"，而非"思维过程"
//   - 每个 Agent 的 system prompt 独立，角色边界清晰
// ======================================================================

/**
 * Supervisor 节点（中央调度者）：
 *   - 接收完整 messages（需要全局视角做决策）
 *   - 用手动 JSON 提示 + 解析（因为 deepseek-flash 不支持 withStructuredOutput），强制返回：
 *     { next_agent, task_complete, reasoning }
 *   - 迭代超限则强制结束（硬终止）
 */
async function supervisorNode(state) {
  const iteration = (state.iteration_count || 0) + 1;
  console.log(`\n🎯 Supervisor [第 ${iteration} 轮]: 正在分析当前进度...`);

  // 硬终止：超过最大迭代次数
  if (iteration >= state.max_iterations) {
    console.log(`  ⚠️ 达到最大迭代次数 ${state.max_iterations}，强制结束`);
    return new Command({
      goto: END,
      update: {
        iteration_count: iteration,
        final_output: `[强制终止] 已迭代 ${iteration} 次仍未完成，最后产出代码：\n${state.current_code || '(无)'}`,
      },
    });
  }

  // 构建 Supervisor 的决策上下文（精简版）+ 手动 JSON 输出约束
  // ！！下个节点派发给哪个 Agent 由决策规则决定
  const prompt = [
    new SystemMessage(`
你是代码审查系统的 Supervisor（中央调度者）。你需要根据当前项目进度，决定下一步调用哪个 Agent。

四个 Agent 职责：
- planner: 分析需求，输出实现计划（函数签名、数据结构、边界条件）
- coder: 根据计划写代码，或根据 Reviewer 反馈修改代码
- reviewer: 审查代码，检查规范性、边界条件、潜在 bug
- tester: 设计测试用例，验证代码正确性

决策规则：
1. 如果还没有 plan → 选 planner
2. 如果有 plan 但没有代码 → 选 coder
3. 如果有代码但没 review → 选 reviewer
4. 如果有 review 但没 test → 选 tester
5. 如果 reviewer 或 tester 发现问题 → 回到 coder 修复
6. 如果 reviewer 和 tester 都通过 → task_complete=true，选 __end__
7. 不要循环调用同一个 Agent，除非有明确反馈回路

你必须严格返回 JSON 格式，不要包含任何其他文字：
\`\`\`json
{
  "next_agent": "planner" | "coder" | "reviewer" | "tester" | "__end__",
  "task_complete": true | false,
  "reasoning": "选择理由（50字以内）"
}
\`\`\`
`),
    new HumanMessage(`
用户需求：${state.requirement || '无'}

当前项目状态：
- plan（规划）：${state.plan ? '✅ 已有' : '❌ 暂无'}
- current_code（代码）：${state.current_code ? '✅ 已有（长度 ' + state.current_code.length + '）' : '❌ 暂无'}
- review_feedback（审查反馈）：${state.review_feedback ? state.review_feedback.substring(0, 300) : '❌ 暂无'}
- test_result（测试结果）：${state.test_result ? state.test_result.substring(0, 300) : '❌ 暂无'}

消息历史摘要：${state.messages?.slice(-4).map(m => `${m.constructor.name}: ${m.content?.toString().substring(0, 100)}`).join('\n') || '无'}
`)
  ];

  try {
    const response = await model.invoke(prompt);
    const content = response.content.toString().trim();

    // 从 LLM 输出中提取 JSON（兼容 markdown 代码块包裹）
    const jsonMatch = content.match(/```json\s*([\s\S]*?)```/) || content.match(/(\{[\s\S]*\})/);
    const jsonStr = jsonMatch ? jsonMatch[1].trim() : content;
    const decision = JSON.parse(jsonStr);

    console.log(`  📋 决策: ${decision.next_agent} | task_complete=${decision.task_complete}`);
    console.log(`  💭 理由: ${decision.reasoning}`);

    // 如果 task_complete=true 或 next_agent=__end__，设置 final_output 并结束
    if (decision.task_complete || decision.next_agent === '__end__') {
      return new Command({
        goto: END,
        update: {
          iteration_count: iteration,
          final_output: state.current_code || '(无代码产出)',
        },
      });
    }

    return new Command({
      goto: decision.next_agent,
      update: { iteration_count: iteration },
    });
  } catch (err) {
    // JSON 解析失败：降级为安全默认值
    console.log(`  ⚠️ Supervisor 输出解析失败: ${err.message}`);
    return new Command({
      goto: END,
      update: {
        iteration_count: iteration,
        final_output: `[解析失败] 已迭代 ${iteration} 次，最后产出：\n${state.current_code || '(无)'}`,
      },
    });
  }
}

/**
 * Planner 节点（规划者）：分析需求 → 输出实现计划
 */
async function plannerNode(state) {
  console.log(`\n📐 Planner: 正在分析需求并制定实现计划...`);

  const prompt = [
    new SystemMessage(`
你是资深技术规划师。将用户的编程需求拆解为清晰的实现计划。

输出格式（Markdown）：
## 实现计划

### 1. 函数签名
列出所有需要实现的函数/类，含参数类型和返回值。

### 2. 数据结构
定义核心数据结构（接口/类型）。

### 3. 边界条件
列出需要处理的异常情况。

### 4. 实现步骤
按顺序列出编码步骤。
`),
    new HumanMessage(`需求：${state.requirement}`)
  ];

  const response = await model.invoke(prompt);
  const plan = response.content.toString().trim();

  console.log(`  ✅ Planner 完成（${plan.length} 字符）`);

  return new Command({
    goto: 'supervisor',
    update: {
      plan,
      messages: [new AIMessage({ content: `【Planner 产出】\n${plan}` })],
    },
  });
}

/**
 * Coder 节点（编码者）：根据计划写代码，或根据 Reviewer 反馈修改代码
 */
async function coderNode(state) {
  console.log(`\n💻 Coder: 正在编写/修改代码...`);

  // 构建精简上下文（上下文隔离：只给 Coder 必要信息）
  const parts = [`需求：${state.requirement}`];
  if (state.plan) parts.push(`\n实现计划：\n${state.plan}`);
  if (state.current_code) parts.push(`\n当前代码：\n${state.current_code}`);
  if (state.review_feedback) parts.push(`\nReviewer 反馈（需修复）：\n${state.review_feedback}`);
  if (state.test_result) parts.push(`\nTester 反馈（需修复）：\n${state.test_result}`);

  const prompt = [
    new SystemMessage(`
你是高级工程师。根据给定的信息编写完整可运行的 JavaScript 代码。

要求：
1. 代码必须完整，可直接运行
2. 含关键注释
3. 如果有 Reviewer/Tester 反馈，先修复问题再输出完整代码
4. 只输出代码块，不要多余解释

输出格式：
\`\`\`javascript
// 完整代码
\`\`\`
`),
    new HumanMessage(parts.join('\n'))
  ];

  const response = await model.invoke(prompt);
  let code = response.content.toString().trim();

  // 提取代码块（兼容 markdown 包裹）
  const codeMatch = code.match(/```javascript\s*([\s\S]*?)```/) || code.match(/```js\s*([\s\S]*?)```/);
  if (codeMatch) code = codeMatch[1].trim();

  console.log(`  ✅ Coder 完成（${code.length} 字符）`);

  return new Command({
    goto: 'supervisor',
    update: {
      current_code: code,
      messages: [new AIMessage({ content: `【Coder 产出】代码长度 ${code.length}` })],
    },
  });
}

/**
 * Reviewer 节点（审查者）：审查代码质量 → 输出结构化反馈
 */
async function reviewerNode(state) {
  console.log(`\n🔍 Reviewer: 正在审查代码...`);

  if (!state.current_code) {
    console.log(`  ⚠️ 无代码可审查，跳过`);
    return new Command({
      goto: 'supervisor',
      update: {
        review_feedback: '无代码可审查，建议先让 Coder 产出代码',
        messages: [new AIMessage({ content: `【Reviewer】无代码可审查` })],
      },
    });
  }

  const prompt = [
    new SystemMessage(`
你是严格的代码审查员。审查代码并输出结构化反馈。

审查维度：
1. 正确性：逻辑是否正确，边界条件是否覆盖
2. 规范性：命名、格式、注释是否规范
3. 健壮性：异常处理、输入校验是否充分
4. 性能：是否有明显性能问题

输出 JSON 格式：
\`\`\`json
{
  "approved": true/false,
  "issues": ["问题1", "问题2"],
  "suggestions": ["建议1", "建议2"],
  "summary": "总体评价（50字以内）"
}
\`\`\`
`),
    new HumanMessage(`需求：${state.requirement}\n\n待审查代码：\n${state.current_code}`)
  ];

  const response = await model.invoke(prompt);
  const content = response.content.toString().trim();

  // 尝试解析 JSON
  const jsonMatch = content.match(/```json\s*([\s\S]*?)```/) || content.match(/(\{[\s\S]*\})/);
  let feedback;
  let approved = false;
  try {
    feedback = jsonMatch ? JSON.parse(jsonMatch[1].trim()) : JSON.parse(content);
    approved = feedback.approved || false;
    feedback = JSON.stringify(feedback, null, 2);
  } catch {
    feedback = content; // 降级：直接用原始文本
    approved = content.includes('approved: true') || content.includes('通过');
  }

  console.log(`  ✅ Reviewer 完成 | approved=${approved}`);

  return new Command({
    goto: 'supervisor',
    update: {
      review_feedback: feedback,
      messages: [new AIMessage({ content: `【Reviewer 产出】approved=${approved}\n${feedback.substring(0, 200)}` })],
    },
  });
}

/**
 * Tester 节点（测试者）：设计测试用例 → 验证代码 → 输出测试结果
 */
async function testerNode(state) {
  console.log(`\n🧪 Tester: 正在设计测试用例并验证...`);

  if (!state.current_code) {
    console.log(`  ⚠️ 无代码可测试，跳过`);
    return new Command({
      goto: 'supervisor',
      update: {
        test_result: '无代码可测试，建议先让 Coder 产出代码',
        messages: [new AIMessage({ content: `【Tester】无代码可测试` })],
      },
    });
  }

  const prompt = [
    new SystemMessage(`
你是测试工程师。为代码设计测试用例并进行逻辑验证。

输出 JSON 格式：
\`\`\`json
{
  "passed": true/false,
  "test_cases": [
    {"name": "用例名", "input": "输入描述", "expected": "预期输出", "actual": "逻辑推演实际结果", "pass": true/false}
  ],
  "failures": ["失败用例及原因"],
  "summary": "测试总结（50字以内）"
}
\`\`\`

注意：你无法实际运行代码，需要通过逻辑推演判断结果。`),
    new HumanMessage(`需求：${state.requirement}\n\n待测代码：\n${state.current_code}`)
  ];

  const response = await model.invoke(prompt);
  const content = response.content.toString().trim();

  // 尝试解析 JSON
  const jsonMatch = content.match(/```json\s*([\s\S]*?)```/) || content.match(/(\{[\s\S]*\})/);
  let result;
  let passed = false;
  try {
    result = jsonMatch ? JSON.parse(jsonMatch[1].trim()) : JSON.parse(content);
    passed = result.passed || false;
    result = JSON.stringify(result, null, 2);
  } catch {
    result = content;
    passed = content.includes('passed: true') || content.includes('通过');
  }

  console.log(`  ✅ Tester 完成 | passed=${passed}`);

  return new Command({
    goto: 'supervisor',
    update: {
      test_result: result,
      messages: [new AIMessage({ content: `【Tester 产出】passed=${passed}\n${result.substring(0, 200)}` })],
    },
  });
}

// ======================================================================
// 四、组装工作流图
//
// 结构（Supervisor 模式）：
//
//                    ┌──────────────────────┐
//                    │  所有 Agent 执行完   │
//                    │  统一回到 Supervisor  │
//                    └──────────▲───────────┘
//                               │
//   START ──► Supervisor ──┬──► Planner
//                          ├──► Coder
//                          ├──► Reviewer
//                          └──► Tester
//                               │
//               task_complete   │ 迭代超限
//               ────────────────┴──────────────► END
//
// 关键：Agent 间不直接路由，由 Supervisor 根据全局状态
// （plan / current_code / review_feedback / test_result）
// 决定下一个派谁，或判定完成后路由到 END。
// ======================================================================
function buildGraph() {
  const workflow = new StateGraph(CodeReviewState)
    // 添加四个 Agent 节点（均通过 Command 返回 supervisor）
    .addNode('supervisor', supervisorNode, {
      ends: ['planner', 'coder', 'reviewer', 'tester', END],
    })
    .addNode('planner', plannerNode, { ends: ['supervisor'] })
    .addNode('coder', coderNode, { ends: ['supervisor'] })
    .addNode('reviewer', reviewerNode, { ends: ['supervisor'] })
    .addNode('tester', testerNode, { ends: ['supervisor'] })
    // 入口：用户需求 → Supervisor 首次决策
    .addEdge(START, 'supervisor');

  return workflow.compile();
}

// ======================================================================
// 五、测试场景
// ======================================================================

/**
 * 测试：让四个 Agent 协作完成一个编程任务
 *
 * 用户需求："实现一个简单的计算器模块，支持加减乘除，除零要报错"
 * 预期流程：
 *   Supervisor → Planner（制定计划）→ Supervisor → Coder（写代码）
 *   → Supervisor → Reviewer（审查）→ Supervisor → Tester（测试）
 *   → Supervisor（判断通过）→ END
 *
 * 可能的循环：
 *   - Reviewer 不通过 → Supervisor → Coder 修复 → Reviewer 再审
 *   - Tester 不通过 → Supervisor → Coder 修复 → Tester 再测
 */
async function main() {
  console.log('═'.repeat(60));
  console.log('Supervisor 模式：四 Agent 代码审查系统');
  console.log('Planner → Coder → Reviewer → Tester');
  console.log('═'.repeat(60));

  const app = buildGraph();

  const requirement = '实现一个简单的计算器模块，支持加减乘除四个函数。要求：1) 除法除零时抛出错误；2) 所有输入校验为数字类型；3) 函数签名清晰。';

  console.log(`\n👤 用户需求: ${requirement}`);
  console.log(`🔒 最大迭代次数: 10（防死循环安全闸）`);

  const result = await app.invoke({ requirement });

  // 输出最终结果
  console.log('\n' + '═'.repeat(60));
  console.log('🎉 最终交付物:');
  console.log('═'.repeat(60));
  console.log(result.final_output || '(无输出)');

  // 执行过程回顾
  console.log('\n' + '═'.repeat(60));
  console.log('📊 执行过程回顾:');
  console.log('═'.repeat(60));
  console.log(`  总迭代次数: ${result.iteration_count || 0}`);
  console.log(`  plan 产出: ${result.plan ? '✅ 有（' + result.plan.length + ' 字符）' : '❌ 无'}`);
  console.log(`  最终代码: ${result.current_code ? '✅ 有（' + result.current_code.length + ' 字符）' : '❌ 无'}`);
  console.log(`  Reviewer 反馈: ${result.review_feedback ? '✅ 有' : '❌ 无'}`);
  console.log(`  Tester 结果: ${result.test_result ? '✅ 有' : '❌ 无'}`);
  console.log(`  消息总数: ${result.messages?.length || 0}`);

/**
六、🧠 上下文隔离详解：为什么这是 Multi-Agent 的关键设计
【问题】为什么不让所有 Agent 共享完整的消息历史？

【根因】LLM 的注意力机制有"注意力稀释"问题：
  - 当上下文很长时，LLM 对关键信息的注意力会下降
  - 每个 Agent 的角色不同，关注的信息完全不同
  - Planner 关注"需求分析"，不关心 Reviewer 的"代码细节"
  - Coder 关注"计划 + 反馈"，不关心 Tester 的"测试推演过程"

【本实现的隔离策略】

1. 状态槽位隔离（plan / current_code / review_feedback / test_result）
    → 每个槽位只存"最终产出"，不存思考过程
    → 覆盖式更新：只保留最新版本，自动丢弃历史草稿

2. Agent 输入裁剪（见各 Agent 的 prompt 构建逻辑）
    → Planner 只看 requirement
    → Coder 看 requirement + plan + 最新 review_feedback + 最新 test_result
    → Reviewer 只看 requirement + current_code
    → Tester 只看 requirement + current_code
    → Supervisor 看精简的消息摘要（最后 4 条）

3. System Prompt 隔离
    → 每个 Agent 有独立的 system prompt，角色边界清晰
    → 避免"角色混淆"（Coder 不会去做 Reviewer 的事）

【如果不隔离会怎样？】

❌ Token 浪费：每个 Agent 都要处理全量历史，成本 N 倍增长
❌ 注意力稀释：关键信息被淹没在冗长的思考链中，产出质量下降
❌ 角色混淆：LLM 可能"越权"做其他 Agent 的事
❌ 调试困难：错误可能来自任何一轮历史，难以定位

【对比[Day10] langgraph-orchestrator-worker.js Orchestrator-Worker 模式的隔离方式】

Orchestrator-Worker 用 Send 给每个 Worker 传独立 State 副本，
Worker 间完全隔离（连共享状态都没有），结果通过 concat reducer 汇总。

本实现的 Supervisor 模式是"轻隔离"：
  → 所有 Agent 共享 state（能看到最终产出）
  → 但每个 Agent 的输入是裁剪后的，不是全量
  → 适合 Agent 间需要间接协作的场景
*/
}

// 统一捕获主流程异常
main().catch((err) => {
  console.error('\n❌ Agent 执行出错:', err.message);
  process.exit(1);
});
