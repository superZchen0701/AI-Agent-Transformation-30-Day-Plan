/**
 * 《Hello-Agents》第6章「框架开发实践」LangChain / LangGraph 部分 + 
 * LangGraph 官方文档(https://github.langchain.ac.cn/langgraphjs/):
 * 
 * 1.跑通官方 Quickstart【学习基础知识】:
 *   - 智能体模式 - 构建一个带工具调用的简单 Agent
 *   - 工作流模式 - 自定义代理行为
 * 2.用 LangGraph 工作流模式重写 Day3 的 ReAct Agent，对比代码量差异
 */
import { TavilySearch } from '@langchain/tavily';
import { ChatOpenAI } from '@langchain/openai';
import { MemorySaver, StateGraph, MessagesAnnotation } from '@langchain/langgraph';
import { HumanMessage, AIMessage } from '@langchain/core/messages';
import { ToolNode, createReactAgent } from '@langchain/langgraph/prebuilt';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import dotenv from 'dotenv';
import path from 'path';
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

/* // 一、官方 Quickstart：智能体模式 - 构建一个带工具调用的简单 Agent
async function main1() {
  // agent用到的工具函数
  const agentTools = [new TavilySearch({ maxResults: 3 })];
  // agent用到的模型
  const model = new ChatOpenAI({
    apiKey: process.env.DEEPSEEK_API_KEY,
    modelName: 'deepseek-v4-flash',
    temperature: 0,
    // 关键：不配置 baseURL 会默认请求 api.openai.com（国内无法直连导致超时），必须指向 DeepSeek
    configuration: { baseURL: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com' },
    timeout: 120_000, // 单次请求超时 120s（工具调用链路多轮请求，需留足时间）
    maxRetries: 2     // 失败自动重试 2 次，缓解瞬时网络抖动
  });
  // 初始化记忆检查点，用于在图的多次运行之间持久化状态。说明：
  // - memory → 不是普通内存，LangGraph 里叫 checkpointer（检查点），
  // 负责把图执行到某一步的状态快照存下来。
  // - 跨 graph 运行，（即同一 thread 的多轮对话）保持 state 不丢
  const agentCheckpointer = new MemorySaver();

  const agent = createReactAgent({
    llm: model,
    tools: agentTools,
    checkpointSaver: agentCheckpointer,
  });

  // 开始执行
  const agentFirstState = await agent.invoke(
    { messages: [new HumanMessage('what is the current weather in san francisco')] },
    { configurable: { thread_id: '42' } }
  );
  console.log(agentFirstState.messages[agentFirstState.messages.length - 1].content);
  
  const agentNextState = await agent.invoke(
    { messages: [new HumanMessage('what about new york')] },
    { configurable: { thread_id: '42' } }
  );
  console.log(agentNextState.messages[agentNextState.messages.length - 1].content);
}

main1().catch((err) => {
  console.error('\n❌ Agent 执行出错:', err.message);
  process.exit(1);
}); */

// -----------------------------------------------------

/* // 二、官方 Quickstart：工作流模式 - 自定义代理行为
async function main2() {
  const tools = [new TavilySearch({ maxResults: 3 })];
  const toolNode = new ToolNode(tools);

  const model = new ChatOpenAI({
    apiKey: process.env.DEEPSEEK_API_KEY,
    modelName: 'deepseek-v4-flash',
    temperature: 0,
    configuration: { baseURL: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com' },
    timeout: 120_000, // 单次请求超时 120s（工具调用链路多轮请求，需留足时间）
    maxRetries: 2     // 失败自动重试 2 次，缓解瞬时网络抖动
  }).bindTools(tools);

  // Define the function that determines whether to continue or not
  function shouldContinue({ messages }) {
    const lastMessage = messages[messages.length - 1];
    // If the LLM makes a tool call, then we route to the 'tools' node
    if (lastMessage.tool_calls?.length) {
      return 'tools';
    }
    // Otherwise, we stop (reply to the user) using the special '__end__' node
    return '__end__';
  }

  async function callModel(state) {
    const response = await model.invoke(state.messages);
    // We return a list, because this will get added to the existing list
    return { messages: [response] };
  }

  // 自定义图
  const workflow = new StateGraph(MessagesAnnotation)
    .addNode('agent', callModel)
    .addEdge('__start__', 'agent') // __start__ is a special name for the entrypoint
    .addNode('tools', toolNode)
    .addEdge('tools', 'agent')
    .addConditionalEdges('agent', shouldContinue);
  
  // 开始执行
  const app = workflow.compile();
  const firstState = await app.invoke({
    messages: [new HumanMessage('what is the current weather in san francisco')]
  });
  console.log(firstState.messages[firstState.messages.length - 1].content);
  
  const nextState = await app.invoke({
    messages: [...firstState.messages, new HumanMessage('what about new york')]
  });
  console.log(nextState.messages[nextState.messages.length - 1].content);
}

main2().catch((err) => {
  console.error('\n❌ Agent 执行出错:', err.message);
  process.exit(1);
}); */

// -----------------------------------------------------

// 三、用 LangGraph 工作流模式（上面的 main1 已实现智能体模式重写React Agent）
// 重写 Day3 的 ReAct Agent（react-minimal-loop.js）
//
// 【对比 Day3 的改进】
// Day3 手写 ReAct 循环（while + 文本解析 Thought/Action/Observation），约 100 行核心逻辑。
// 这里用 LangGraph 工作流模式重写：
// 1. 放弃手写文本解析 → 改用原生 Function Calling（.bindTools），LLM 直接返回结构化 tool_calls
// 2. 放弃手写 while 循环 → 改用 StateGraph 条件边（agent ↔ tools 循环）
// 3. 放弃手写 history 数组 → 改用 MessagesAnnotation（messages 通道 + messagesStateReducer 自动累积）
// 4. 工具仍复用 Day3 的 ToolRegistry，但用 adapter 转成 LangChain 的 DynamicStructuredTool

/**
 * 工具注册中心：统一管理工具定义、描述、执行函数
 * 单一容器设计：_tools: name -> { name, description, parameters, func }
 */
class ToolRegistry {
  constructor() {
    this._tools = {};
  }

  static EMPTY_PARAMETERS = { type: 'object', properties: {} };

  register_tool(tool) {
    if (!tool || !tool.name || typeof tool.func !== 'function') {
      throw new Error(`无效的工具定义 '${tool?.name}': 需要 name(非空) 和 func(函数) 字段`);
    }
    if (this._tools[tool.name]) {
      console.log(`⚠️ 警告: 工具 '${tool.name}' 已存在，将被覆盖。`);
    }
    this._tools[tool.name] = tool;
    console.log(`✅ 工具 '${tool.name}' 已注册。`);
  }

  register_function(name, description, parameters, func) {
    this.register_tool({
      name,
      description,
      parameters: parameters || ToolRegistry.EMPTY_PARAMETERS,
      func
    });
  }

  get_tools_description() {
    const descriptions = Object.values(this._tools)
      .map((tool) => `- ${tool.name}: ${tool.description}`);
    return descriptions.length ? descriptions.join('\n') : '暂无可用工具';
  }

  get_all_tools() { return Object.values(this._tools); }

  get_tool(name) { return this._tools[name]; }

  async execute_tool(name, args = {}) {
    const tool = this.get_tool(name);
    if (!tool) {
      return `错误: 未找到工具 '${name}'，可用工具: ${Object.keys(this._tools).join(', ')}`;
    }
    try {
      const result = await tool.func(args);
      return typeof result === 'string' ? result : JSON.stringify(result);
    } catch (err) {
      console.error(`❌ 执行工具 '${name}' 失败: ${err.message}`);
      return `工具 '${name}' 执行失败: ${err.message}`;
    }
  }

  /**
   * 将指定工具转为 LangChain DynamicStructuredTool（适配 ToolNode / bindTools）
   * ToolNode 要求工具是 Runnable，纯对象无法直接使用
   * @param {string} name 工具名
   * @returns {DynamicStructuredTool}
   */
  to_langchain_tool(name) {
    const tool = this.get_tool(name);
    if (!tool) throw new Error(`未找到工具 '${name}'`);
    return new DynamicStructuredTool({
      name: tool.name,
      description: tool.description,
      schema: this._infer_zod_schema(tool.parameters),
      func: async (args) => tool.func(args),
    });
  }

  /**
   * 从 JSON Schema 简单推断 zod schema（覆盖 string/number/boolean）
   * 仅用于教学场景的自动转换；复杂工具建议注册时直接传 zodSchema
   */
  _infer_zod_schema(parameters) {
    const props = parameters?.properties || {};
    const required = parameters?.required || [];
    const shape = {};
    for (const [key, val] of Object.entries(props)) {
      let fieldSchema;
      switch (val.type) {
        case 'number': fieldSchema = z.number(); break;
        case 'boolean': fieldSchema = z.boolean(); break;
        default: fieldSchema = z.string();
      }
      if (val.description) fieldSchema = fieldSchema.describe(val.description);
      if (!required.includes(key)) fieldSchema = fieldSchema.optional();
      shape[key] = fieldSchema;
    }
    return z.object(shape);
  }

  // 批量转换所有工具为 LangChain 工具（适配 ToolNode / bindTools）
  get_langchain_tools() {
    return Object.keys(this._tools).map((name) => this.to_langchain_tool(name));
  }
}
// 计算器工具函数 - 计算表达式结果
function calculator({ expr }) {
  // 用 Function 构造函数计算表达式（仅限可信输入，生产环境需校验防注入）
  const result = new Function('return ' + expr)();
  return `${expr} = ${result}`;
}
async function main() {
  // 1. 注册工具（复用 Day3 的 ToolRegistry）
  const registry = new ToolRegistry();
  registry.register_function(
    'calculator',
    '计算数学表达式并返回结果',
    { type: 'object', properties: { expr: { type: 'string', description: '数学表达式' } }, required: ['expr'] },
    calculator
  );

  // 2. 转成 LangChain 工具 + 创建 ToolNode
  const langChainTools = registry.get_langchain_tools();
  const toolNode = new ToolNode(langChainTools);

  // 3. 模型绑定工具（原生 Function Calling，不再手写文本解析）
  const model = new ChatOpenAI({
    apiKey: process.env.DEEPSEEK_API_KEY,
    modelName: 'deepseek-v4-flash',
    temperature: 0,
    configuration: { baseURL: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com' },
    timeout: 120_000,
    maxRetries: 2
  }).bindTools(langChainTools);

  // 4. 路由函数：检查最后一条消息有无 tool_calls → 决定走 tools 还是 END
  let step = 0;
  function shouldContinue({ messages }) {
    const lastMessage = messages[messages.length - 1];
    if (lastMessage.tool_calls?.length) {
      console.log(`  → 路由: tools（LLM 要求调用 ${lastMessage.tool_calls.map((tc) => tc.name).join(', ')}）`);
      return 'tools';
    }
    console.log('  → 路由: __end__（LLM 直接给出最终答案，流程结束）');
    return '__end__';
  }

  // 5. agent 节点：调 LLM，返回 AIMessage（含 tool_calls 或最终文本）
  //    不再需要手写 Thought/Action 解析、history 维护、while 循环
  async function callModel(state) {
    step++;
    const lastMsg = state.messages[state.messages.length - 1];
    console.log(`\n--- 第 ${step} 步: agent 节点 ---`);
    console.log(`  输入: [${lastMsg._getType()}] ${typeof lastMsg.content === 'string' ? lastMsg.content.slice(0, 100) : JSON.stringify(lastMsg.content).slice(0, 100)}`);

    const response = await model.invoke(state.messages);

    // 打印 LLM 输出：有 tool_calls 则打印工具调用，否则打印文本回答
    if (response.tool_calls?.length) {
      console.log(`  LLM 输出: 请求调用工具`);
      response.tool_calls.forEach((tc) => {
        console.log(`    🔧 ${tc.name}(${JSON.stringify(tc.args)})`);
      });
    } else {
      console.log(`  LLM 输出: ${response.content?.slice(0, 200)}`);
    }
    return { messages: [response] }; // messagesStateReducer 自动追加
  }

  // 6. tools 节点的日志包装：ToolNode 本身不打印，用包装节点加日志
  async function callTools(state) {
    console.log(`\n--- 第 ${step} 步: tools 节点 ---`);
    const result = await toolNode.invoke(state);
    const toolMsg = result.messages[result.messages.length - 1];
    console.log(`  工具返回: ${toolMsg.content?.toString().slice(0, 200)}`);
    return { messages: result.messages };
  }

  // 7. 组装图：agent ↔ tools 条件边循环 = ReAct 的「思考→行动→观察」循环
  const workflow = new StateGraph(MessagesAnnotation)
    .addNode('agent', callModel)
    .addNode('tools', callTools)              // 用带日志的包装节点
    .addEdge('__start__', 'agent')            // 入口 → agent
    .addConditionalEdges('agent', shouldContinue) // agent →(有 tool_calls?)→ tools 或 END
    .addEdge('tools', 'agent')               // tools 结果回 agent → 下一轮思考
    .compile();                              // 编译（此处可挂 checkpointer）

  // 8. 执行
  const question = '1234 * 5678 + 987 等于多少';
  console.log(`🚀 开始执行: ${question}`);
  const finalState = await workflow.invoke({
    messages: [new HumanMessage(question)]
  });
  console.log(`\n🎉 最终答案: ${finalState.messages[finalState.messages.length - 1].content}`);
}
// 统一捕获主流程异常（网络错误、鉴权失败等），避免 UnhandledPromiseRejection
main().catch((err) => {
  console.error('\n❌ Agent 执行出错:', err.message);
  process.exit(1);
});
