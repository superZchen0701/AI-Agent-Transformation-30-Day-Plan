/**
 * 实现 Reflection Agent：执行后让 LLM 评估结果，不满意则修正重试。
 * 1. 引入记忆管理机制：
 * Reflection 的核心在于迭代，而迭代的前提是能够记住之前的尝试和获得的反馈。
 * 因此，一个“短期记忆”模块是实现该范式的必需品。
 * 这个记忆模块将负责存储每一次“执行-反思”循环的完整轨迹。
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
 * 1. 实现一个简化版的记忆管理模块Memory，主体是这样的：
 * - 使用一个列表 records 来按顺序存储每一次的行动和反思。
 * - add_record 方法负责向记忆中添加新的条目。
 * - get_trajectory 方法是核心，它将记忆轨迹“序列化”成一段文本，可以直接插入到后续的提示词中，为模型的反思和优化提供完整的上下文。
 * - get_last_execution 方便我们获取最新的“初稿”以供反思。
 */
class Memory {
  constructor() {
    // 初始化一个空列表来存储所有记录。
    this.records = [];
  }
  /**
   * 向记忆中添加一条新记录。
   * 参数:
   * - record_type (string): 记录的类型 ('execution' 或 'reflection')。
   * - content (string): 记录的具体内容 (例如，生成的代码或反思的反馈)。
   */
  add_record(record_type, content) {
    this.records.push({
      type: record_type,
      content
    });
    console.log(`📝 记忆已更新，新增一条 '${record_type}' 记录。`);
  }
  // 将所有记忆记录格式化为一个连贯的字符串文本，用于构建提示词。
  get_trajectory() {
    const trajectory_parts = [];
    for (const record of this.records) {
      if (record.type === 'execution') {
        trajectory_parts.push(`--- 上一轮尝试 (产出) ---\n${record['content']}`);
      } else if (record.type === 'reflection') {
        trajectory_parts.push(`--- 评审员反馈 ---\n${record['content']}`);
      }
    }
    return trajectory_parts.join('\n\n');
  }
  /**
   * 获取最近一次的执行结果 (例如，最新生成的代码)。
   * 如果不存在，则返回 ''。
   */
  get_last_execution() {
    for (let i = this.records.length - 1; i >= 0; i--) {
      if (this.records[i].type === 'execution') {
        return this.records[i].content;
      }
    }
    return '';
  }
}

// 初始执行提示词 (Execution Prompt) - 通用化，由 task 描述指定具体领域与产出格式
const INITIAL_PROMPT_TEMPLATE = `
你是一位资深任务执行专家。请根据以下要求完成任务。
你的产出必须严格符合 task 描述的领域规范与输出格式要求。

要求: {task}

请直接输出结果，不要包含任何额外的解释。
`;
// 反思提示词 (Reflection Prompt) - 聚焦产出质量与方案优劣，与具体领域无关
const REFLECT_PROMPT_TEMPLATE = `
你是一位极其严格的质量评审专家，对产出的质量有极致的要求。
你的任务是审查以下产出，并专注于找出其在<strong>方案优劣与执行质量</strong>上的主要瓶颈。

# 原始任务:
{task}

# 待审查的产出:
\`\`\`
{output}
\`\`\`

请分析该产出在正确性、完整性、效率（如时间/空间复杂度、流程冗余、资源占用）等维度上的表现，并思考是否存在一种<strong>根本上更优</strong>的解决方案来显著提升质量。
如果存在，请清晰地指出当前方案的不足，并提出具体的、可行的改进建议（例如：算法层面换用更优解、流程层面消除冗余步骤、产出层面补全遗漏要点）。
如果产出在方案层面已经达到最优，才能回答“无需改进”。

请直接输出你的反馈，不要包含任何额外的解释。
`;
// 优化提示词 (Refinement Prompt) - 根据反馈迭代优化产出
const REFINE_PROMPT_TEMPLATE = `
你是一位资深任务执行专家。你正在根据一位质量评审专家的反馈来优化你的产出。

# 原始任务:
{task}

# 你上一轮尝试的产出:
{last_output_attempt}
评审员的反馈：
{feedback}

请根据评审员的反馈，生成一个优化后的新版本产出。
你的产出必须严格符合 task 描述的领域规范与输出格式要求。
请直接输出优化后的结果，不要包含任何额外的解释。
`;

/**
 * 智能体主类 ReflectionAgent
 */
class ReflectionAgent {
  constructor(llm, max_iterations = 3) {
    this.llm = llm;
    this.max_iterations = max_iterations;
    this.memory = new Memory();
  }
  async _sendMessages(messages) {
    // 流式输出：实时打印 delta，避免长时间无输出不知道是否在跑
    const completion = await this.llm.chat.completions.create({
      messages,
      model: 'deepseek-v4-flash',
      stream: true,
      stream_options: { include_usage: true }, // 最后一个 chunk 携带 usage 字段
    });
    let assistantContent = '';
    for await (const chunk of completion) {
      const delta = chunk.choices[0]?.delta?.content || '';
      if (delta) {
        process.stdout.write(delta);
        assistantContent += delta;
      }
    }
    process.stdout.write('\n');
    return { role: 'assistant', content: assistantContent };
  }
  // 辅助方法：调用 LLM 流式获取完整响应（屏幕实时显示 delta）
  async _get_llm_response(prompt) {
    const messages = [
      { role: 'user', content: prompt },
    ];
    const response = await this._sendMessages(messages);
    return response.content || '';
  }
  async run(task) {
    console.log(`\n--- 开始处理任务 ---\n任务: ${task}`);
    // 1. 初始执行
    console.log('\n--- 正在进行初始尝试 ---');
    const initialPrompt = INITIAL_PROMPT_TEMPLATE.replace('{task}', task);
    const initialResponse = await this._get_llm_response(initialPrompt);
    this.memory.add_record('execution', initialResponse);

    // 2. 迭代循环:反思与优化
    for (let i = 0; i < this.max_iterations; i++) {
      console.log(`\n--- 第 ${i+1}/${this.max_iterations} 轮迭代 ---`);
      // 2.1 反思
      console.log('\n-> 正在进行反思...');
      const lastExecution = this.memory.get_last_execution();
      const reflectPrompt = REFLECT_PROMPT_TEMPLATE
        .replace('{task}', task)
        .replace('{output}', lastExecution);
      const feedback = await this._get_llm_response(reflectPrompt);
      this.memory.add_record('reflection', feedback);

      // 2.2 检查是否需要停止：LLM 输出"无需改进""不需要改进""已最优""已达到最优"等变体都视为收敛
      if (/无[需须]改进|不需[要]?改进|已(达到)?最优|已足够好/.test(feedback)) {
        console.log('\n✅ 反思认为产出已无需改进，任务完成。');
        break;
      }

      // 2.3 优化
      console.log('\n-> 正在进行优化...');
      const refinePrompt = REFINE_PROMPT_TEMPLATE
        .replace('{task}', task)
        .replace('{last_output_attempt}', lastExecution)
        .replace('{feedback}', feedback);
      const refinedResponse = await this._get_llm_response(refinePrompt);
      this.memory.add_record('execution', refinedResponse);
    }
    const finalResponse = this.memory.get_last_execution();
    console.log(`\n--- 任务完成 ---\n最终产出:\n${finalResponse}`);
    return finalResponse;
  }
}

async function main() {
  const agent = new ReflectionAgent(openai);
  // 运行Agent（统一对比任务：验证容错修复后能跑通含纯文本生成的复合任务）
  const task = '小明有 15 个苹果，给了小红 5 个，又从果园摘了 8 个，然后把剩余的苹果平均分给 3 个朋友，每个朋友得到几个？最后请把整个计算过程写成一首四句的中文小诗。';
  const result = await agent.run(task);
  return result;
}

// 统一捕获主流程异常（网络错误、鉴权失败等），避免 UnhandledPromiseRejection
main().catch((err) => {
  console.error('\n❌ Agent 执行出错:', err.message);
  process.exit(1);
});
