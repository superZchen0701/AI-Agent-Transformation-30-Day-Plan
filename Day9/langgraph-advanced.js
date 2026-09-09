/**
 * 参考资料：
 * 1.[LangGraph JS 中文文档 · 「底层概念：节点 / 边 / 条件分支」](https://github.langchain.ac.cn/langgraphjs/concepts/low_level/#conditional-edges)
 * 2.[LangGraph 中文文档 · 「持久性：Checkpointer 检查点」](https://github.langchain.ac.cn/langgraph/concepts/persistence/)
 * 3.[LangGraph 中文文档 · 「人机协同 Human-in-the-loop」](https://github.langchain.ac.cn/langgraph/concepts/human_in_the_loop/)
 * 4.[LangGraph 中文文档 · 「添加人工干预」](https://github.langchain.ac.cn/langgraph/how-tos/human_in_the_loop/add-human-in-the-loop/)
 *
 * - 实现条件分支工作流：根据用户意图路由到不同处理节点
 * - 加 MemorySaver 检查点，实现对话中断后恢复
 * - 实现人机协作节点：执行危险操作前暂停等待用户确认
 * - 模拟失败场景，测试状态恢复能力
 *
 * 验收：Agent 能从断点继续，条件分支逻辑正确
 */
import { TavilySearch } from '@langchain/tavily';
import { ChatOpenAI } from '@langchain/openai';
import {
  START,
  MemorySaver,
  END,
  StateGraph,
  MessagesAnnotation,
  Annotation,
  interrupt,
  Command
} from '@langchain/langgraph';
import { HumanMessage, AIMessage } from '@langchain/core/messages';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import dotenv from 'dotenv';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';

// 加载根目录下的.env到process.env
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

if (!process.env.DEEPSEEK_API_KEY) {
  throw new Error('未设置环境变量 DEEPSEEK_API_KEY，请先执行: export DEEPSEEK_API_KEY=你的key');
}
if (!process.env.TAVILY_API_KEY) {
  throw new Error('未设置环境变量 TAVILY_API_KEY，请先执行: export TAVILY_API_KEY=你的key');
}

// ======================================================================
// 一、定义 State（全局共享状态）
// 使用 Annotation.Root 定义状态 schema，MessagesAnnotation 展开 messages 通道
// 额外增加 intent（用户意图）和 search_results（搜索结果）两个通道
// ======================================================================
const StateAnnotation = Annotation.Root({
  ...MessagesAnnotation.spec,                  // messages 通道（自动累积）
  intent: Annotation(),                         // 用户意图：search / calculate / danger / chat
  search_results: Annotation(),                 // 搜索结果存储
});

// ======================================================================
// 二、模型初始化
// ======================================================================
const model = new ChatOpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  modelName: 'deepseek-v4-flash',
  temperature: 0,
  configuration: { baseURL: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com' },
  timeout: 120_000,
  maxRetries: 2,
});

// ======================================================================
// 三、工具定义
// ======================================================================

// 计算器工具
const calculatorTool = new DynamicStructuredTool({
  name: 'calculator',
  description: '计算数学表达式并返回结果',
  schema: z.object({
    expr: z.string().describe('数学表达式，如 3*7、(1+2)*3'),
  }),
  func: async ({ expr }) => {
    const result = new Function('return ' + expr)();
    return `${expr} = ${result}`;
  },
});

// 搜索工具（Tavily）
const searchTool = new TavilySearch({ maxResults: 3 });

// ======================================================================
// 四、节点函数定义（像不像Coze/Dify平台的节点？）
// 每个节点接收 state，返回更新片段（由 reducer 合并到共享状态）
// ======================================================================

/**
 * 意图分类节点：分析用户输入，判定意图类型写入 state.intent
 * 这是条件分支的"决策点"——路由函数依据此值分流
 */
async function classifyNode(state) {
  const lastMessage = state.messages[state.messages.length - 1];
  const userText = typeof lastMessage.content === 'string'
    ? lastMessage.content
    : JSON.stringify(lastMessage.content);

  // 用 LLM 做意图分类（简单关键词判断也可，这里展示 LLM 分类方式）
  const classifyPrompt = [
    { role: 'system', content: '分析用户意图，只返回以下关键词之一：search / calculate / danger / chat。' +
      '\n- search: 用户想搜索信息、查找新闻、查询天气等' +
      '\n- calculate: 用户想进行数学计算' +
      '\n- danger: 用户要求执行危险操作（如删除文件、格式化、执行高风险命令等）' +
      '\n- chat: 普通闲聊或问答' },
    { role: 'user', content: userText },
  ];
  const response = await model.invoke(classifyPrompt);
  const intent = response.content.trim().toLowerCase();
  console.log(`  [classify] 意图: ${intent}`);
  return { intent };
}

/**
 * 搜索节点：调用 Tavily 搜索用户问题
 */
async function searchNode(state) {
  const lastMessage = state.messages[state.messages.length - 1];
  const userText = typeof lastMessage.content === 'string'
    ? lastMessage.content
    : JSON.stringify(lastMessage.content);

  console.log(`  [search] 正在搜索: ${userText}`);
  const rawResults = await searchTool.invoke({ query: userText });
  // TavilySearch 返回 { results: [{ title, content, url }, ...] }
  const results = rawResults.results || rawResults;
  const resultText = Array.isArray(results)
    ? results.map((r) => r.content || r.description || JSON.stringify(r)).join('\n')
    : JSON.stringify(rawResults);
  console.log(`  [search] 搜索完成，返回 ${Array.isArray(results) ? results.length : 0} 条结果`);

  return {
    search_results: resultText,
    messages: [new AIMessage(`已搜索到以下信息：\n${resultText.slice(0, 500)}`)],
  };
}

/**
 * 计算节点：调用 calculator 工具计算数学表达式
 */
async function calculateNode(state) {
  const lastMessage = state.messages[state.messages.length - 1];
  const userText = typeof lastMessage.content === 'string'
    ? lastMessage.content
    : JSON.stringify(lastMessage.content);

  // 用 LLM 从用户文本中提取数学表达式
  const extractPrompt = [
    { role: 'system', content: '从用户输入中提取数学表达式，只返回表达式本身，如 "1234*5678+987"。不要包含其他文字。' },
    { role: 'user', content: userText },
  ];
  const response = await model.invoke(extractPrompt);
  const expr = response.content.trim();
  console.log(`  [calculate] 提取表达式: ${expr}`);

  // 执行计算
  const result = await calculatorTool.invoke({ expr });
  console.log(`  [calculate] 结果: ${result}`);

  return {
    messages: [new AIMessage(`计算结果：${result}`)],
  };
}

/**
 * 人机协作节点（核心演示）：执行危险操作前用 interrupt() 暂停，等待用户确认
 *
 * interrupt() 的工作原理：
 *   1. 首次执行到此处 → 图暂停，interrupt 的参数返回给调用方
 *   2. 调用方检查暂停状态，展示信息给用户
 *   3. 用户确认/拒绝后，用 Command({ resume: value }) 恢复执行
 *   4. 恢复后 interrupt() 返回 resume 的值，节点继续往下执行
 */
function dangerNode(state) {
  const lastMessage = state.messages[state.messages.length - 1];
  const userText = typeof lastMessage.content === 'string'
    ? lastMessage.content
    : JSON.stringify(lastMessage.content);

  console.log(`  [danger] 检测到危险操作请求，暂停等待确认...`);

  // interrupt() 暂停图执行，参数会出现在 state 的 __interrupt__ 中
  // 恢复时返回值即为用户传入的 resume 值
  const userDecision = interrupt({
    message: `⚠️ 危险操作确认\n用户请求: "${userText}"\n是否允许执行？`,
    options: ['yes', 'no'],
  });

  // 以下代码在 resume 之后才执行
  if (userDecision === 'yes') {
    console.log(`  [danger] 用户已确认，执行操作`);
    return {
      messages: [new AIMessage('✅ 危险操作已执行（模拟）。')],
    };
  }
  console.log(`  [danger] 用户已拒绝，取消操作`);
  return {
    messages: [new AIMessage('❌ 操作已被用户取消。')],
  };
}

/**
 * 普通聊天节点：直接调 LLM 回答
 */
async function chatNode(state) {
  console.log(`  [chat] 普通对话`);
  const response = await model.invoke(state.messages);
  return { messages: [response] };
}

/**
 * 汇总节点：整合搜索/计算结果，生成最终回复
 */
async function respondNode(state) {
  // 如果已有搜索结果，用 LLM 整合生成最终回复
  if (state.search_results) {
    const summaryPrompt = [
      { role: 'system', content: '基于搜索结果，简洁回答用户问题。' },
      { role: 'user', content: `搜索结果：${state.search_results.slice(0, 1000)}` },
    ];
    const response = await model.invoke(summaryPrompt);
    return { messages: [response] };
  }
  // 已有计算结果等，直接返回
  return {};
}

// ======================================================================
// 五、路由函数（条件边的核心，像不像Coze/Dify平台的条件边？）
// 根据 state.intent 返回分支 key，映射表决定去哪个节点
// ======================================================================
function routeByIntent(state) {
  const intent = state.intent;
  console.log(`  [route] 路由: ${intent}`);
  // 返回 key → 映射表中查找目标节点名
  switch (intent) {
    case 'search':    return 'search';
    case 'calculate': return 'calculate';
    case 'danger':    return 'danger';
    default:          return 'chat';
  }
}

// ======================================================================
// 六、组装工作流图
// 结构：
//   START → classify →(条件边)→ search / calculate / danger / chat
//                                     ↓        ↓        ↓       ↓
//                                   respond ←───────────────────┘
//                                     ↓
//                                    END
// ======================================================================
function buildGraph() {
  const workflow = new StateGraph(StateAnnotation)
    .addNode('classify', classifyNode)
    .addNode('search', searchNode)
    .addNode('calculate', calculateNode)
    .addNode('danger', dangerNode)
    .addNode('chat', chatNode)
    .addNode('respond', respondNode)
    // 入口
    .addEdge(START, 'classify')
    // 条件分支：根据 intent 路由到不同处理节点
    .addConditionalEdges('classify', routeByIntent, {
      search: 'search',
      calculate: 'calculate',
      danger: 'danger',
      chat: 'chat',
    })
    // 各处理节点完成后汇入 respond
    .addEdge('search', 'respond')
    .addEdge('calculate', 'respond')
    .addEdge('danger', 'respond')
    .addEdge('chat', 'respond')
    // respond → 结束
    .addEdge('respond', END);

  // 编译时挂载 MemorySaver 检查点（持久化状态，支持中断后恢复）
  const checkpointer = new MemorySaver();
  return { app: workflow.compile({ checkpointer }), checkpointer };
}

// ======================================================================
// 七、终端交互工具（真实 human-in-the-loop：图中断后等待用户输入）
// ======================================================================

// readline 懒加载单例 + 行缓冲队列
// 为什么要自己缓冲：管道模式下多行输入一次性到达，readline.question 每次只消费一行，
// 未注册 question 时到达的行会丢失。这里统一用 'line' 事件入队，兼容终端逐行和管道批量输入
let _rl = null;
const _lineBuffer = [];   // 已到达但尚未被提问消费的行
const _waiters = [];      // 等待输入的提问回调

function getRl() {
  if (!_rl) {
    _rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    _rl.on('line', (line) => {
      const waiter = _waiters.shift();
      if (waiter) waiter(line);        // 有等待的提问 → 立即派发
      else _lineBuffer.push(line);     // 无等待者 → 入缓冲队列
    });
  }
  return _rl;
}

/**
 * 在终端向用户提问并等待输入
 * @param {string} question 提示语
 * @returns {Promise<string>} 用户输入（已 trim + 小写化）
 */
function askQuestion(question) {
  getRl(); // 确保接口已创建并监听 line 事件
  return new Promise((resolve) => {
    process.stdout.write(question);
    const buffered = _lineBuffer.shift();      // 先取缓冲中已到达的行
    if (buffered !== undefined) {
      resolve(buffered.trim().toLowerCase());
    } else {
      _waiters.push((line) => resolve(line.trim().toLowerCase())); // 否则排队等待
    }
  });
}

// ======================================================================
// 八、场景测试
// ======================================================================

/**
 * 场景 1：条件分支 —— 搜索意图
 */
async function testSearch(threadId, app) {
  console.log('\n' + '═'.repeat(60));
  console.log('场景 1: 条件分支 —— 搜索意图');
  console.log('═'.repeat(60));

  const config = { configurable: { thread_id: threadId } };
  const result = await app.invoke(
    { messages: [new HumanMessage('搜索一下 LangGraph 是什么')] },
    config,
  );
  const lastMsg = result.messages[result.messages.length - 1];
  console.log(`\n📤 回复: ${lastMsg.content?.toString().slice(0, 200)}`);
  return result;
}

/**
 * 场景 2：条件分支 —— 计算意图
 */
async function testCalculate(threadId, app) {
  console.log('\n' + '═'.repeat(60));
  console.log('场景 2: 条件分支 —— 计算意图');
  console.log('═'.repeat(60));

  const config = { configurable: { thread_id: threadId } };
  const result = await app.invoke(
    { messages: [new HumanMessage('帮我计算 1234 * 5678 + 987')] },
    config,
  );
  const lastMsg = result.messages[result.messages.length - 1];
  console.log(`\n📤 回复: ${lastMsg.content?.toString().slice(0, 200)}`);
  return result;
}

/**
 * 场景 3：人机协作 —— 危险操作中断 + 真实终端交互（核心演示）
 *
 * 流程：
 *   1. 用户请求危险操作 → classify 路由到 danger 节点
 *   2. danger 节点调用 interrupt() → 图暂停，返回中断信息
 *   3. 检查中断状态，打印确认信息，【阻塞等待用户在终端输入 yes/no】
 *   4. 用户输入后 → 用 Command({ resume: 用户输入 }) 恢复执行
 *   5. danger 节点根据 resume 值走"执行"或"取消"分支
 */
async function testDangerInterrupt(threadId, app) {
  console.log('\n' + '═'.repeat(60));
  console.log('场景 3: 人机协作 —— 危险操作中断 + 终端等待用户确认');
  console.log('═'.repeat(60));

  const config = { configurable: { thread_id: threadId } };

  // 1. 发起危险操作请求
  console.log('\n👤 用户: 删除所有数据库');
  await app.invoke(
    { messages: [new HumanMessage('删除所有数据库')] },
    config,
  );

  // 2. 检查中断状态
  const stateSnapshot = await app.getState(config);
  if (!stateSnapshot.next?.length) {
    console.log('⚠️ 图未中断，直接结束（未触发 danger 节点？）');
    return;
  }

  const interruptInfo = stateSnapshot.tasks?.[0]?.interrupts?.[0]?.value;
  console.log(`\n⏸️ 图已暂停，等待用户确认`);
  if (interruptInfo) {
    console.log(`\n${interruptInfo.message}`);
  }

  // 3. 真实终端交互：阻塞等待用户输入，校验只接受 yes/no
  let userDecision;
  while (true) {
    userDecision = await askQuestion('\n🔴 请输入 yes 确认执行 / no 取消操作: ');
    if (userDecision === 'yes' || userDecision === 'no') break;
    console.log('  输入无效，请输入 yes 或 no');
  }
  console.log(`👤 用户选择: ${userDecision}`);

  // 4. 携带用户决策恢复图执行
  const resumedResult = await app.invoke(
    new Command({ resume: userDecision }),
    config,
  );
  const lastMsg = resumedResult.messages[resumedResult.messages.length - 1];
  console.log(`\n📤 回复: ${lastMsg.content?.toString()}`);
  return resumedResult;
}

/**
 * 场景 4：状态恢复 —— 检查点持久化验证
 *
 * 同一 thread_id 的多次 invoke 会共享 state（检查点持久化）
 * 演示：先搜索，再在同一对话中追问，Agent 能记住上下文
 */
async function testStateRecovery(threadId, app) {
  console.log('\n' + '═'.repeat(60));
  console.log('场景 4: 状态恢复 —— 检查点持久化（多轮对话记忆）');
  console.log('═'.repeat(60));

  const config = { configurable: { thread_id: threadId } };

  // 第一轮：搜索
  console.log('\n--- 第一轮 ---');
  console.log('👤 用户: 搜索 Python asyncio');
  const result1 = await app.invoke(
    { messages: [new HumanMessage('搜索 Python asyncio')] },
    config,
  );
  const lastMsg1 = result1.messages[result1.messages.length - 1];
  console.log(`📤 回复: ${lastMsg1.content?.toString().slice(0, 200)}`);

  // 检查状态
  const snapshot1 = await app.getState(config);
  console.log(`\n📦 检查点状态: ${snapshot1.values.messages?.length || 0} 条消息, intent=${snapshot1.values.intent || 'null'}`);

  // 第二轮：追问（同一 thread_id，共享之前的状态）
  console.log('\n--- 第二轮 ---');
  console.log('👤 用户: 它和 asyncio.gather 有什么区别？（追问，测试上下文记忆）');
  const result2 = await app.invoke(
    { messages: [new HumanMessage('它和 asyncio.gather 有什么区别？')] },
    config,
  );
  const lastMsg2 = result2.messages[result2.messages.length - 1];
  console.log(`📤 回复: ${lastMsg2.content?.toString().slice(0, 200)}`);

  // 验证：第二轮应该能看到之前的搜索结果（检查点恢复）
  const snapshot2 = await app.getState(config);
  console.log(`\n📦 检查点状态: ${snapshot2.values.messages?.length || 0} 条消息（包含前两轮的完整对话历史）`);

  return result2;
}

// ======================================================================
// 八、主函数：运行全部场景
// ======================================================================
async function main() {
  try {
    const { app } = buildGraph();

    // 场景 1: 条件分支 —— 搜索
    await testSearch('thread-search', app);

    // 场景 2: 条件分支 —— 计算
    await testCalculate('thread-calc', app);

    // 场景 3: 人机协作 —— 中断后【真实终端】等待用户输入 yes/no
    await testDangerInterrupt('thread-danger', app);

    // 场景 4: 检查点持久化 —— 多轮对话记忆
    await testStateRecovery('thread-memory', app);

    console.log('\n' + '═'.repeat(60));
    console.log('✅ 全部场景测试完成');
    console.log('═'.repeat(60));
  } finally {
    // 关闭 readline，释放 stdin，确保进程正常退出
    if (_rl) _rl.close();
  }
}

// 统一捕获主流程异常（网络错误、鉴权失败等），避免 UnhandledPromiseRejection
main().catch((err) => {
  console.error('\n❌ Agent 执行出错:', err.message);
  if (_rl) _rl.close();
  process.exit(1);
});
