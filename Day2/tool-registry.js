/**
 * 实现工具注册中心ToolRegistry：统一管理工具定义、描述、执行函数
 * 封装3个工具函数：计算器、天气查询（wttr.in）、网络搜索（百度AI搜索（千帆AppBuilder））
 * Agent 能根据用户问题自动选择正确的工具并调用
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
 * 1. 实现工具注册中心ToolRegistry：统一管理工具定义、描述、执行函数
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
   * 转换为 DeepSeek/OpenAI Function Calling 所需的 tools 参数格式
   * @returns {Array} [{ type: 'function', function: { name, description, parameters } }]
   */
  get_tools_schemas() {
    return Object.values(this._tools).map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters || ToolRegistry.EMPTY_PARAMETERS
      }
    }));
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
 * 2. 3个工具函数：计算器、天气查询（wttr.in）、网络搜索（百度AI搜索（千帆AppBuilder））:
 * get_weather({location})
 * calculator({expr})
 * web_search({query})
 * 返回真实结果
 * 参数名与下方 tools schema 的 properties 字段保持一致，便于解构传参
 */
// 计算器 - 计算表达式结果
function calculator({ expr }) {
  // 用 Function 构造函数计算表达式（仅限可信输入，生产环境需校验防注入）
  const result = new Function('return ' + expr)();
  return `${expr} = ${result}`;
}
// 天气查询 - 获取传入城市的当前天气情况（调用 wttr.in 免费 API，无需 key）
async function get_weather({ location }) {
  // wttr.in 文档 https://github.com/chubin/wttr.in
  // format=j1 返回 JSON，lang=zh 让描述带中文
  const url = `https://wttr.in/${encodeURIComponent(location)}?format=j1&lang=zh`;
  const resp = await fetch(url);
  if (!resp.ok) {
    return `${location}: 天气查询失败（HTTP ${resp.status}）`;
  }
  const data = await resp.json();
  const cur = data.current_condition?.[0];
  if (!cur) return `${location}: 未获取到天气数据`;
  const temp = cur.temp_C;
  // 优先取中文描述，兜底英文
  const desc = cur.lang_zh?.[0]?.value || cur.weatherDesc?.[0]?.value || '未知';
  const humidity = cur.humidity;
  return `${location}: ${desc}，${temp}°C，湿度${humidity}%`;
}
// 网络搜索 - 百度AI搜索（千帆AppBuilder），每天100次免费额度
async function web_search({ query }) {
  if (!process.env.BAIDU_SEARCH_API_KEY) {
    throw new Error('未设置环境变量 BAIDU_SEARCH_API_KEY，请先执行: export BAIDU_SEARCH_API_KEY=你的key');
  }
  const resp = await fetch('https://qianfan.baidubce.com/v2/ai_search', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.BAIDU_SEARCH_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messages: [{ role: 'user', content: query }],
      search_source: 'baidu_search_v2', // 百度全网搜索源
      search_recency_filter: 'month',   // 时间范围，可选
    }),
  });
  if (!resp.ok) return `搜索失败（HTTP ${resp.status}）`;
  const data = await resp.json();
  // 提取标题+链接+摘要，拼接为文本供 LLM 阅读
  const docs = (data.references || [])
    .map((r, i) => `${i + 1}. ${r.title}\n${r.url}\n${r.content || ''}`)
    .join('\n\n');
  return docs || '未搜索到相关结果';
}

/**
 * 发请求 - 带上 tools
 */
async function send_messages(messages, tools) {
  const completion = await openai.chat.completions.create({
    messages,
    model: 'deepseek-v4-flash',
    tools
  });
  return completion.choices[0].message;
}

/**
 * 3. Agent主循环函数 - 根据用户问题自动选择正确的工具并调用
 */
async function main() {
  const registry = new ToolRegistry();
  // 1）依次注册3个工具函数
  // 方式一：函数注册
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
  // 方式二：Tool对象注册
  registry.register_tool({
    name: 'get_weather',
    description: '获取指定城市的当前天气情况，用户需先提供城市名',
    parameters: {
      type: 'object',
      properties: {
        location: {
          type: 'string',
          description: '城市名，例如: 北京、上海、San Francisco',
        }
      },
      required: ['location']
    },
    func: get_weather
  });
  registry.register_tool({
    name: 'web_search',
    description: '根据搜索内容全网搜索出答案',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '搜索内容',
        }
      },
      required: ['query']
    },
    func: web_search
  });
  // 2）根据用户问题自动选择正确的工具并调用
  const messages = [{ role: 'user', content: '深圳天气如何？plus 111*222 等于多少？SpaceX最新发射的星舰有几台发动机？' }];
  let curTurn = 1;
  // 获取全部tools
  const tools = registry.get_tools_schemas();
  console.log(`User: ${messages[0].content}`);
  // 循环请求，直到没有工具调用为止（设最大轮次，防止 LLM 无限调用工具）
  const MAX_ROUNDS = 5;
  while (true) {
    if (curTurn > MAX_ROUNDS) {
      console.log(`\n⚠️ 已达最大轮次 ${MAX_ROUNDS}，强制结束（可能发生了工具循环调用）`);
      break;
    }
    const message = await send_messages(messages, tools);
    messages.push(message);
    const content = message.content;
    const toolCalls = message.tool_calls;
    console.log(`当前轮次: ${curTurn}\ncontent: ${content}\ntool_calls: ${JSON.stringify(toolCalls)}`);
    // 检查返回里的 tool_calls，没有工具调用说明 LLM 已生成最终回复，退出循环
    if (!toolCalls) break;
    // 循环执行toolCalls数组中的每个tool
    for (const tool of toolCalls) {
      const toolFuncName = tool.function.name;
      // 解析 LLM 返回的 JSON 参数字符串；解析失败也要继续走完工具消息回传，
      // 否则 messages 会残留"有 tool_calls 但无 tool 结果"，下一轮 API 报 400
      let args = {};
      try {
        args = JSON.parse(tool.function.arguments);
      } catch {
        console.error(`⚠️ 工具 '${toolFuncName}' 的参数不是合法JSON: ${tool.function.arguments}`);
      }
      // 动态调用对应的本地函数并传入解析后的参数对象
      const toolResult = await registry.execute_tool(toolFuncName, args);
      console.log(`tool result for ${toolFuncName}: ${toolResult}\n`);
      // 把工具结果回传给 LLM，role 必须为 'tool'，并带 tool_call_id 关联
      messages.push({
        role: 'tool',
        tool_call_id: tool.id,
        content: toolResult
      });
    }
    curTurn++;
  }
}

// 统一捕获主流程异常（网络错误、鉴权失败等），避免 UnhandledPromiseRejection
main().catch((err) => {
  console.error('\n❌ Agent 执行出错:', err.message);
  process.exit(1);
});
