/**
 * 多轮对话（流式输出 + 上下文累积）
 */
import OpenAI from 'openai';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline';

// 加载根目录下的.env到process.env
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const SYSTEM_PROMPT = `
你是一个讲笑话高手，每讲完一个笑话都询问用户：好不好笑？
当用户输入"不好笑"，你就继续讲笑话。
当用户输入"好笑"，你就退出循环。
限制：后面讲的笑话不能和前面的重复。
终止条件：讲笑话次数大于等于3次，或者用户输入：好笑。
`;

const LOOP_MAX = 3;
let count = 0;

if (!process.env.DEEPSEEK_API_KEY) {
  throw new Error('未设置环境变量 DEEPSEEK_API_KEY，请先执行：export DEEPSEEK_API_KEY=你的key');
}

const openai = new OpenAI({
  baseURL: 'https://api.deepseek.com',
  apiKey: process.env.DEEPSEEK_API_KEY,
});

// 创建命令行交互接口
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

// 封装 rl.question 为 Promise，便于 async/await 调用
const askUser = (q) => new Promise((resolve) => rl.question(q, resolve));

// 初始上下文：system 设定人设，user 触发第一次讲笑话
const messages = [
  { role: 'system', content: SYSTEM_PROMPT },
  { role: 'user', content: '给我讲个笑话' }
];

async function main() {
  console.log('=== 讲笑话循环开始（输入"好笑"提前结束）===\n');

  while (count < LOOP_MAX) {
    count++;
    console.log(`--- 第 ${count}/${LOOP_MAX} 次 ---`);

    const completion = await openai.chat.completions.create({
      messages,
      model: 'deepseek-v4-flash',
      thinking: { 'type': 'disabled' }, // 思考模式开关 enabled/disabled
      reasoning_effort: 'low', // 思考强度控 low/high/max
      stream: true, // 流式输出 true/false
      stream_options: { include_usage: true }, // 流式输出时返回 token 使用量（最后一个 chunk 带 usage）
    });
  
    // 不使用流式输出 stream: false 用下面这行代码
    // console.log(completion.choices[0].message.content);
  
    let assistantContent = '';
    let usage = null;

    // 使用流式输出 stream: true 用下面这段代码
    for await (const chunk of completion) {
      const delta = chunk.choices[0]?.delta?.content || '';
      process.stdout.write(delta);
      assistantContent += delta; // 累加完整文本，供后续上下文使用
      // 最后一个 chunk 才携带 usage 字段
      if (chunk.usage) {
        usage = chunk.usage;
      }
    }
    process.stdout.write('\n');

    /**
     * 打印本轮 token 使用量
     * prompt_tokens - 输入 token（system + 历史 messages 累计，会随轮次增加而增长）
     * completion_tokens - 本轮输出 token
     * total_tokens - 上面两者之和
     */
    if (usage) {
      console.log(`[tokens] prompt: ${usage.prompt_tokens}, completion: ${usage.completion_tokens}, total: ${usage.total_tokens}`);
    }

    // 把 LLM 回复 push 进 messages，保留上下文
    messages.push({ role: 'assistant', content: assistantContent });

    // 收集用户反馈
    const userInput = await askUser('你: ');
    messages.push({ role: 'user', content: userInput });

    // 用户输入"好笑"（且非"不好笑"）则提前退出；输入"不好笑"则继续讲
    const isFunny = userInput.includes('好笑') && !userInput.includes('不好笑');
    if (isFunny) {
      console.log('\n感谢使用，再见！');
      rl.close();
      return;
    }
  }

  console.log(`\n已达最大次数 ${LOOP_MAX} 次，循环结束。`);
  rl.close();
}

main().catch((err) => {
  console.error('\n程序出错:', err.message);
  rl.close();
  process.exit(1);
});
