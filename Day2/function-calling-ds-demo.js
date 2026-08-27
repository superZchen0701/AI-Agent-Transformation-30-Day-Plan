/**
 * DeepSeek官方文档【Tool Calls / Function Calling】demo
 * 调用get_weather 和 calculator 两个工具函数
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
 * 1. 定义2个JS函数: get_weather({location})、calculator({expr})，返回真实结果
 * 参数名与下方 tools schema 的 properties 字段保持一致，便于解构传参
 */
// 获取传入城市的当前天气情况（调用 wttr.in 免费 API，无需 key）
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
// 计算表达式结果
function calculator({ expr }) {
  // 用 Function 构造函数计算表达式（仅限可信输入，生产环境需校验防注入）
  const result = new Function('return ' + expr)();
  return `${expr} = ${result}`;
}

/**
 * 2. 构造tools数组: 用 JSON Schema 描述每个函数的 name/parameters 供 LLM 识别
 */
const tools = [
  {
    type: 'function',
    function: {
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
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'calculator',
      description: '计算数学表达式并返回结果',
      parameters: {
        type: 'object',
        properties: {
          expr: {
            type: 'string',
            description: '数学表达式，如 3*7、(1+2)*3',
          }
        },
        required: ['expr']
      }
    }
  }
];

// 工具名→函数 的映射表，便于根据 LLM 返回的函数名动态调用
const TOOL_CALL_MAP = {
  get_weather,
  calculator
}

/**
 * 3. 发请求时带上 tools
 */
async function send_messages(messages) {
  const completion = await openai.chat.completions.create({
    messages,
    model: 'deepseek-v4-flash',
    tools
  });
  return completion.choices[0].message;
}

const messages = [{ role: 'user', content: '北京天气如何， plus 3*7 等于多少' }];

async function main() {
  let curTurn = 1;
  console.log(`User: ${messages[0].content}`);
  // 循环请求，直到没有工具调用为止（设最大轮次，防止 LLM 无限调用工具）
  const MAX_ROUNDS = 5;
  // 4. 循环请求，直到没有工具调用为止
  while (true) {
    if (curTurn > MAX_ROUNDS) {
      console.log(`\n⚠️ 已达最大轮次 ${MAX_ROUNDS}，强制结束（可能发生了工具循环调用）`);
      break;
    }
    const message = await send_messages(messages);
    messages.push(message);
    const content = message.content;
    const toolCalls = message.tool_calls;
    console.log(`当前轮次: ${curTurn}\ncontent: ${content}\ntool_calls: ${JSON.stringify(toolCalls)}`);
    // 5. 检查返回里的 tool_calls，没有工具调用说明 LLM 已生成最终回复，退出循环
    if (!toolCalls) break;
    // 循环执行toolCalls数组中的每个tool
    for (const tool of toolCalls) {
      const toolFuncName = tool.function.name;
      // 解析 LLM 返回的 JSON 参数字符串（如 '{"location":"北京"}'）
      // 解析 LLM 返回的 JSON 参数字符串；解析失败也要继续走完工具消息回传，
      // 否则 messages 会残留"有 tool_calls 但无 tool 结果"，下一轮 API 报 400
      let args = {};
      try {
        args = JSON.parse(tool.function.arguments);
      } catch {
        console.error(`⚠️ 工具 '${toolFuncName}' 的参数不是合法JSON: ${tool.function.arguments}`);
      }
      // 6. 动态调用对应的本地函数并传入解析后的参数对象
      const toolResult = await TOOL_CALL_MAP[toolFuncName](args);
      console.log(`tool result for ${toolFuncName}: ${toolResult}\n`);
      // 7. 把工具结果回传给 LLM，role 必须为 'tool'，并带 tool_call_id 关联
      messages.push({
        role: 'tool',
        tool_call_id: tool.id,
        content: toolResult
      });
    }
    curTurn++;
  }
};

// 统一捕获主流程异常（网络错误、鉴权失败等），避免 UnhandledPromiseRejection
main().catch((err) => {
  console.error('\n❌ Agent 执行出错:', err.message);
  process.exit(1);
});
