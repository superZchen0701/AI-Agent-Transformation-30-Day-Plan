/**
 * 实现 ReAct Agent：Thought→Action→Observation 3段循环
 * 同一个任务，用来对比 Plan-and-Solve Agent 和 Reflection Agent
 */
import OpenAI from 'openai';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// 加载根目录下的.env到process.env
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

if (!process.env.DEEPSEEK_API_KEY) {
  throw new Error('未设置环境变量 DEEPSEEK_API_KEY，请先执行: export DEEPSEEK_API_KEY=你的key');
}

const openai = new OpenAI({
  baseURL: 'https://api.deepseek.com',
  apiKey: process.env.DEEPSEEK_API_KEY,
});

/**
 * 实现工具注册中心ToolRegistry：统一管理工具定义、描述、执行函数
 *
 * 采用单一容器设计（业界主流做法，同 LangChain/OpenAI SDK 的工具注册）：
 *   _tools: name -> { name, description, parameters, func }
 *
 * 支持两种注册方式：
 * 1）Tool对象注册：适合复杂工具，支持完整的参数定义和验证
 * 2）函数直接注册：适合简单工具，内部包装成标准Tool对象后复用 register_tool
 */
class ToolRegistry {
  constructor() {
    // 唯一容器：name -> { name, description, parameters, func }
    this._tools = {};
  }

  // 默认参数schema：无参数工具的兜底描述
  static EMPTY_PARAMETERS = { type: 'object', properties: {} };

  /**
   * 注册标准 Tool 对象
   * @param {*} tool 标准结构 { name, description, parameters, func }
   *                 - name: 工具名（唯一标识）
   *                 - description: 给LLM看的用途说明
   *                 - parameters: JSON Schema 描述参数
   *                 - func: 实际执行的JS函数（可为 async）
   */
  register_tool(tool) {
    // 校验必要字段，尽早暴露注册错误
    if (!tool || !tool.name || typeof tool.func !== 'function') {
      throw new Error(`无效的工具定义 '${tool?.name}': 需要 name(非空) 和 func(函数) 字段`);
    }
    if (this._tools[tool.name]) {
      console.log(`⚠️ 警告: 工具 '${tool.name}' 已存在，将被覆盖。`);
    }
    this._tools[tool.name] = tool;
    console.log(`✅ 工具 '${tool.name}' 已注册。`);
  }

  /**
   * 直接注册函数作为工具（简便方式）：包装成标准Tool对象后复用 register_tool
   * @param {*} name 工具名称
   * @param {*} description 工具描述（给LLM看）
   * @param {*} parameters 参数的 JSON Schema
   * @param {*} func 工具函数（参数为解析后的args对象，返回字符串或可序列化值）
   */
  register_function(name, description, parameters, func) {
    this.register_tool({
      name,
      description,
      parameters: parameters || ToolRegistry.EMPTY_PARAMETERS,
      func
    });
  }

  // 获取所有可用工具的格式化描述字符串
  get_tools_description() {
    const descriptions = Object.values(this._tools)
      .map((tool) => `- ${tool.name}: ${tool.description}`);
    return descriptions.length ? descriptions.join('\n') : '暂无可用工具';
  }

  /**
   * 按名称执行工具
   * @param {*} name 工具名
   * @param {*} args 已解析的参数对象（调用方先 JSON.parse(tool.function.arguments)）
   * @returns {Promise<string>} 字符串结果，回传给 LLM 时 role:'tool' 的 content 必须为字符串
   */
  async execute_tool(name, args = {}) {
    const tool = this._tools[name];
    if (!tool) {
      return `错误: 未找到工具 '${name}'，可用工具: ${Object.keys(this._tools).join(', ')}`;
    }
    try {
      const result = await tool.func(args);
      // 非字符串结果（如数字/对象）序列化为字符串，保证 content 类型合法
      return typeof result === 'string' ? result : JSON.stringify(result);
    } catch (err) {
      // 工具异常不中断 Agent 循环，将错误信息作为结果回传给 LLM 自行决策
      console.error(`❌ 执行工具 '${name}' 失败: ${err.message}`);
      return `工具 '${name}' 执行失败: ${err.message}`;
    }
  }
}

/**
 * 3、工具函数：计算器:
 * calculator({expr})
 * 返回真实结果
 * 参数名与下方 tools schema 的 properties 字段保持一致，便于解构传参
 */
// 计算器 - 计算表达式结果
function calculator({ expr }) {
  // 用 Function 构造函数计算表达式（仅限可信输入，生产环境需校验防注入）
  const result = new Function('return ' + expr)();
  return `${expr} = ${result}`;
}

// ReAct 循环提示词模板
const REACT_PROMPT_TEMPLATE = `
请注意，你是一个有能力调用外部工具的智能助手。

可用工具如下:
{tools}

**重要规则**：
1. 任何数学计算（无论难易）都必须调用 calculator 工具获取准确结果，禁止自行心算。
2. 拿到工具返回的 Observation 后，如还需调用其他工具，继续按 Thought/Action 格式输出；如已收集到足够信息能直接回答用户，直接输出最终答案文本（无需 Action: 前缀，无需 Finish[...] 包装）。
3. 当任务含纯文本生成子任务（如写诗、写文案）且无对应工具时，可直接输出该文本作为最终答案。

请严格按照以下格式进行回应（每次只输出一个 Action）:

Thought: 你的思考过程，用于分析问题、拆解任务和规划下一步行动。
Action: 你决定采取的行动，必须是以下格式之一:
- 「{{tool_name}}[{{tool_input}}]」:调用一个可用工具。
- 「Finish[最终答案]」:当你认为已经获得最终答案时。
- 当你收集到足够的信息，能够回答用户的最终问题时，你必须在Action:字段后使用 Finish[最终答案] 来输出最终答案。

现在，请开始解决以下问题:
Question: {question}
History: {history}
`;

/**
 * 1、手写一个极简 ReAct 循环
 */
class ReActAgent {
  constructor(registry, maxSteps = 5) {
    this.toolRegistry = registry;
    this.llm = openai;
    this.maxSteps = maxSteps;
    this.history = [];
  }
  async _sendMessages(messages) {
    // 纯 ReAct 模式：不传 tools 参数（避免与原生 Function Calling 双重触发，导致 LLM 行为分裂）
    // LLM 只用文本输出 Thought/Action，由代码解析
    const completion = await this.llm.chat.completions.create({
      messages,
      model: 'deepseek-v4-flash'
    });
    return completion.choices[0].message;
  }
  /**
   * 把 LLM 输出的 toolInput 字符串转成工具期望的 args 对象
   * 兼容两种格式：
   *   1) JSON: calculator[{"expr":"3*7+12"}]  → 直接 JSON.parse
   *   2) 裸文本: calculator[3*7+12]            → 按 schema 第一个 required 字段包装
   */
  _parseToolInput(toolName, toolInput) {
    // 先尝试 JSON 解析
    try {
      return JSON.parse(toolInput);
    } catch {
      // 非 JSON，按工具 schema 的第一个 required 字段包装成对象
      const tool = this.toolRegistry._tools[toolName];
      const firstRequired = tool?.parameters?.required?.[0];
      return firstRequired ? { [firstRequired]: toolInput } : { input: toolInput };
    }
  }
  // 解析LLM的输出，提取Thought和Action
  _parseOutput(text) {
    // Thought: 匹配到 Action: 或文本末尾（s flag 让 . 能匹配换行，等价于 Python re.DOTALL）
    const thoughtMatch = text.match(/Thought:\s*(.*?)(?=\nAction:|$)/s);
    // Action: 匹配到文本末尾
    const actionMatch = text.match(/Action:\s*(.*?)$/s);
    const thought = thoughtMatch ? thoughtMatch[1].trim() : null;
    const action = actionMatch ? actionMatch[1].trim() : null;
    return { thought, action };
  }
  // 解析Action字符串，提取工具名称和输入（如 calculator[3*7+12] / Finish[最终答案]）
  _parseAction(actionText) {
    // ^ 从开头匹配（等价 Python re.match）；\w+ 匹配工具名；(.*) 跨行匹配中括号内内容
    const match = actionText.match(/^(\w+)\[(.*)\]/s);
    if (match) {
      return { toolName: match[1], toolInput: match[2] };
    }
    return { toolName: null, toolInput: null };
  }
  /**
   * 2、实现 ReAct 循环
   */
  async run(question) {
    // 每次运行时重置历史记录
    this.history = [];
    let currentStep = 0;
    while (currentStep < this.maxSteps) {
      currentStep++;
      console.log(`--- 第 ${currentStep} 步 ---`);
      // 1 - 格式化提示词
      const toolsDesc = this.toolRegistry.get_tools_description();
      const history = this.history.join('\n');
      const prompt = REACT_PROMPT_TEMPLATE
        .replace('{tools}', toolsDesc)
        .replace('{question}', question)
        .replace('{history}', history);
      // 2 - 调用 LLM 进行思考（纯 ReAct，不传 tools 参数）
      const messages = [{ role: 'user', content: prompt }];
      const message = await this._sendMessages(messages);
      const content = message.content;
      if (!content) {
        throw new Error('错误:LLM未能返回有效响应。');
      }
      // 3 - 解析 LLM 输出，提取 Thought 和 Action
      const { thought, action } = this._parseOutput(content);
      if (thought) {
        console.log(`Thought: ${thought}`);
        // 将本轮的 Thought 记入历史，供下一轮 LLM 参考
        this.history.push(`Thought: ${thought}`);
      }
      if (!action) {
        // 容错兜底：LLM 直接输出最终答案但未带 Action: 前缀
        // 场景：任务含纯文本生成子步骤（如写诗）且无对应工具，LLM 按 prompt 规则3 直接输出文本
        // 此时把整段 content 当作最终答案返回，避免解析失败导致流程崩溃
        console.log(`🎉 最终答案（LLM 直接输出，无 Action 包装）: ${content}`);
        return content;
      }
      // 4 - 执行 Action
      if (action.startsWith('Finish')) {
        // Finish[最终答案]：解析出最终答案并返回
        const finishMatch = action.match(/Finish\[(.*)\]/s);
        const finalAnswer = finishMatch ? finishMatch[1] : action;
        console.log(`🎉 最终答案: ${finalAnswer}`);
        return finalAnswer;
      }
      const { toolName, toolInput } = this._parseAction(action);
      if (!toolName || toolInput === null) {
        // 无效 Action 格式：跳过本轮，下一轮 LLM 会基于 history 自我纠正
        console.log(`⚠️ 无效 Action 格式，跳过: ${action}`);
        continue;
      }
      console.log(`Action: ${toolName}[${toolInput}]`);
      // 把 LLM 输出的 toolInput 字符串转成工具期望的 args 对象
      const args = this._parseToolInput(toolName, toolInput);
      // 调用真实工具
      const observation = await this.toolRegistry.execute_tool(toolName, args);
      console.log(`Observation: ${observation}`);
      // 5 - 将本轮的 Action/Observation 都记入历史，供下一轮 LLM 参考
      this.history.push(`Action: ${action}`);
      this.history.push(`Observation: ${observation}`);
    }
    throw new Error(`警告:已达最大步骤数 ${this.maxSteps}，流程终止。`);
  }
}

async function main() {
  const registry = new ToolRegistry();
  // 函数方式注册工具函数calculator
  registry.register_function(
    'calculator',
    '计算数学表达式并返回结果',
    {
      type: 'object',
      properties: {
        expr: {
          type: 'string',
          description: '数学表达式，如 3*7、(1+2)*3',
        }
      },
      required: ['expr']
    },
    calculator
  );
  // 初始化Agent
  const agent = new ReActAgent(registry);
  // 运行Agent（统一对比任务：验证容错修复后能跑通含纯文本生成的复合任务）
  await agent.run('小明有 15 个苹果，给了小红 5 个，又从果园摘了 8 个，然后把剩余的苹果平均分给 3 个朋友，每个朋友得到几个？最后请把整个计算过程写成一首四句的中文小诗。');
}

// 统一捕获主流程异常（网络错误、鉴权失败等），避免 UnhandledPromiseRejection
main().catch((err) => {
  console.error('\n❌ Agent 执行出错:', err.message);
  process.exit(1);
});


