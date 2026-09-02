/**
 * 实现 Plan-and-Solve Agent：先让 LLM 输出步骤计划，再逐步执行
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
 * 规划器
 * 规划阶段的目标是让大语言模型接收原始问题，并输出一个清晰、分步骤的行动计划。
 * 这个计划必须是结构化的，以便我们的代码可以轻松解析并逐一执行。
 */
const PLANNER_PROMPT_TEMPLATE = `
你是一个顶级的AI规划专家。你的任务是将用户提出的复杂问题分解成一个由多个简单步骤组成的行动计划。
请确保计划中的每个步骤都是一个独立的、可执行的子任务，并且严格按照逻辑顺序排列。
你的输出必须是一个JavaScript字符串数组（标准 JSON 可解析的字符串数组），其中每个元素都是一个描述子任务的字符串。

问题: {question}

请严格按照以下格式输出你的计划，\`\`\`javascript 与 \`\`\` 作为前后缀是必要的：
\`\`\`javascript
["步骤1", "步骤2", "步骤3", ...]
\`\`\`
`;
class Planner {
  constructor(llm) {
    this.llm = llm;
  }
  async _sendMessages(messages) {
    const completion = await this.llm.chat.completions.create({
      messages,
      model: 'deepseek-v4-flash'
    });
    return completion.choices[0].message;
  }
  // 根据用户问题生成一个行动计划。
  async plan(question) {
    const messages = [
      { role: 'user', content: PLANNER_PROMPT_TEMPLATE.replace('{question}', question) },
    ];
    console.log('--- 正在生成计划 ---');
    const message = await this._sendMessages(messages);
    const content = message.content || '';
    console.log(`✅ 计划已生成：\n${content}`);
    // 解析 LLM 输出的字符串数组：优先匹配 ```javascript 代码块，失败则尝试直接 JSON.parse 整段
    try {
      // 用正则字面量匹配代码块（[\s\S] 跨行匹配，非贪婪到下一个 ```）
      const blockMatch = content.match(/```javascript\s*([\s\S]*?)```/);
      const planContent = blockMatch ? blockMatch[1].trim() : content.trim();
      const plan = JSON.parse(planContent).map(item => item.toString());
      if (!Array.isArray(plan) || plan.length === 0) {
        throw new Error('计划为空或非数组');
      }
      return plan;
    } catch (error) {
      console.error('计划格式错误，请检查输出是否符合要求:', error.message);
      return [];
    }
  }
}

/**
 * 执行器
 * 循环遍历计划，调用 LLM，并维护一个历史记录（状态）。
 */
const EXECUTOR_PROMPT_TEMPLATE = `
你是一位顶级的AI执行专家。你的任务是严格按照给定的计划，一步步地解决问题。
你将收到原始问题、完整的计划、以及到目前为止已经完成的步骤和结果。
请你专注于解决“当前步骤”，并仅输出该步骤的最终答案，不要输出任何额外的解释或对话。

# 原始问题:
{question}

# 完整计划:
{plan}

# 历史步骤与结果:
{history}

# 当前步骤:
{current_step}

请仅输出针对“当前步骤”的回答:
`;
class Executor {
  constructor(llm) {
    this.llm = llm;
  }
  async _sendMessages(messages) {
    const completion = await this.llm.chat.completions.create({
      messages,
      model: 'deepseek-v4-flash'
    });
    return completion.choices[0].message;
  }
  // 根据计划，逐步执行并解决问题。
  async execute(question, plan) {
    // 用于存储历史步骤和结果的字符串
    let history = '';
    let content = '';
    console.log('--- 正在执行计划 ---');
    for (let i = 0; i < plan.length; i++) {
      const step = plan[i];
      console.log(`\n-> 正在执行步骤 ${i+1}/${plan.length}：${step}`);
      const messages = [
        { role: 'user',
          content: EXECUTOR_PROMPT_TEMPLATE
            .replace('{question}', question)
            .replace('{plan}', plan.map((s, idx) => `${idx + 1}. ${s}`).join('\n'))
            .replace('{history}', history || '无')
            .replace('{current_step}', step)
        }
      ];
      const message = await this._sendMessages(messages);
      content = message.content || '';
      // 更新历史记录，为下一步做准备
      history += `步骤 ${i+1}: ${step}\n结果: ${content}\n\n`;
      console.log(`✅ 步骤 ${i+1} 已完成，结果: ${content}`);
    }
    return content;
  }
}

/**
 * 智能体主类 PlanAndSolveAgent
 * 接收一个 LLM 客户端，初始化内部的规划器和执行器，并提供一个简单的 run 方法来启动整个流程
 */
class PlanAndSolveAgent {
  constructor(llm) {
    this.llm = llm;
    this.planner = new Planner(this.llm);
    this.executor = new Executor(this.llm);
  }
  // 运行智能体的完整流程:先规划，后执行。
  async run(question) {
    console.log(`\n--- 开始处理问题 ---\n问题: ${question}`);
    // 1. 调用规划器生成计划
    const plan = await this.planner.plan(question);
    if (plan.length === 0) {
      throw new Error('规划器生成的计划为空，无法解决问题。');
    }
    // 2. 调用执行器执行计划
    const result = await this.executor.execute(question, plan);
    return result;
  }
}

async function main() {
  // 初始化智能体
  const agent = new PlanAndSolveAgent(openai);
  // 运行Agent（统一对比任务：验证容错修复后能跑通含纯文本生成的复合任务）
  const question = '小明有 15 个苹果，给了小红 5 个，又从果园摘了 8 个，然后把剩余的苹果平均分给 3 个朋友，每个朋友得到几个？最后请把整个计算过程写成一首四句的中文小诗。';
  const result = await agent.run(question);
  console.log(`\n--- 最终结果 ---\n${result}`);
}

// 统一捕获主流程异常（网络错误、鉴权失败等），避免 UnhandledPromiseRejection
main().catch((err) => {
  console.error('\n❌ Agent 执行出错:', err.message);
  process.exit(1);
});
