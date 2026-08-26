/**
 * 单轮对话（一次性输出LLM的回复）
 */
import OpenAI from 'openai';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// 加载根目录下的.env到process.env
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const SYSTEM_PROMPT = '你是一个讲笑话高手';

if (!process.env.DEEPSEEK_API_KEY) {
  throw new Error('未设置环境变量 DEEPSEEK_API_KEY，请先执行：export DEEPSEEK_API_KEY=你的key');
}

const openai = new OpenAI({
  baseURL: 'https://api.deepseek.com',
  apiKey: process.env.DEEPSEEK_API_KEY,
});

async function main() {
  const completion = await openai.chat.completions.create({
    messages: [
      /**
       * 系统消息
       * 作用：设定 LLM 的 人设、行为准则、任务背景
       * 位置：通常放在 messages 数组的第一条
       * 影响：全局生效，会持续约束后续所有对话的输出风格与边界
       * 告诉模型：你的身份是笑话高手
       */
      { role: 'system', content: SYSTEM_PROMPT },
      /**
       * 用户消息
       * 作用：代表 真实用户的提问/指令
       * 位置：可出现多次，与 assistant 交替
       * 影响：模型会基于此生成回复
       */
      { role: 'user', content: '给我讲个笑话' },
      /**
       * 助手消息
       * 作用：代表 模型之前的回复 或 预设的助手历史发言
       * 用途一：多轮对话时，记录模型上一次的回答，让模型理解上下文
       * 用途二：预设示范，通过"伪造"一段助手回答，引导模型按期望格式/风格输出
       * 这里是预设助手的"半截笑话"，配合下一条 user 消息继续对话
       */
      { role: 'assistant', content: '鸡为什么过马路' },
      { role: 'user', content: '我不知道' }
    ],
    model: 'deepseek-v4-flash',
    thinking: { 'type': 'disabled' }, // 思考模式开关 enabled/disabled
    reasoning_effort: 'low', // 思考强度控 low/high/max
    stream: true, // 流式输出 true/false
  });

  // 不使用流式输出 stream: false 用下面这行代码
  // console.log(completion.choices[0].message.content);

  // 使用流式输出 stream: true 用下面这段代码
  for await (const chunk of completion) {
    process.stdout.write(chunk.choices[0]?.delta?.content || '');
  }
}

main();