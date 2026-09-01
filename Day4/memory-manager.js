/**
 * 1. 区分短期记忆（对话历史）与长期记忆（向量存储）
 * 2. 为 Agent 加对话历史管理：保留最近 N 轮 + 自动摘要旧对话，上下文溢出处理（超预算时裁剪/压缩）
 * 3. 实现粗略 Token 计数估算
 * 4. 测试：连续 20 轮以上对话，观察上下文管理效果
 * 
 * 产出：memory-manager.js + 长对话测试记录
 * 验收：长对话不超 Token 限制，且 Agent 能记住早期关键信息
 * 
 * 温馨提示：代码较长，只作为参考所以没做模块拆分。建议先阅读注释再理解，再运行测试
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
 * 生产环境 SYSTEM_PROMPT：引导 LLM 主动调用 memory 工具存/取长期记忆
 * 不强制每轮调用，而是在"遇到关键信息"或"被问是否记得"时自然触发
 */
const SYSTEM_PROMPT = `你是一个具备长期记忆能力的智能助手。你可以调用 memory 工具来存取记忆。

【存储规则 - 必须分条存储，禁止把多条信息拼成一条】
- 姓名、偏好、技术栈、计划、事件等，每条各调一次 memory(action='add', type='semantic'/'working', content='单条信息', importance=...)
- ❌ 错误示例：memory(action='add', content='张三，偏好简洁，用TS，计划30天...') — 把所有信息塞一条，会导致检索失败
- ✅ 正确示例：memory(action='add', type='semantic', content='用户名叫张三', importance=0.9)
              memory(action='add', type='semantic', content='用户偏好简洁代码风格，不喜欢多余注释', importance=0.9)
              memory(action='add', type='semantic', content='用户技术栈 TypeScript、Node.js', importance=0.85)

调用时机（按信息性质选择记忆类型，不要只存单一类型）：
1. 用户告知【长期稳定的个人属性/抽象知识】（姓名/偏好/技术栈/长期计划/领域知识等）→ 直接存 semantic（跨会话长期知识，无需经过短期记忆）
   memory(action='add', type='semantic', content='...', importance=...)
2. 用户告知【当前会话发生的具体交互事件/任务进展】（如"今天完成了X练习""刚才在讨论Y"）→ 存 working（会话级短期记忆，会话结束由 consolidate 自动固化为长期情景记忆作为"经历"）
   memory(action='add', type='working', content='...', importance=...)
3. 当用户询问"你还记得...吗""你知道我...吗""之前说过的X是什么"等回溯类问题时，【必须】调用 memory(action='search', query='...') 检索长期记忆再回答。
   - 禁止在回溯类问题下调用 memory(add)：用户在问"是否记得"，不是在告知新信息，重复存储会造成记忆膨胀
   - search query 必须用具体关键词（用"张三"而非"用户姓名"；用"TypeScript"而非"用户技术栈"）
   - 如果 search 结果命中 → 基于检索内容回答；如果 search 结果为空 → 如实告知"记忆中没有该信息"
4. 普通寒暄或当前轮次能直接回答的问题，无需调用工具

【禁止重复存储】
- 调 memory(add) 之前先判断：该信息是否已在记忆中（可先调 memory(search) 确认）。已在记忆中的信息禁止重复 add，避免记忆膨胀
- 同一会话内用户多次提及同一信息（如多次说"我叫张三"），只在首次调用 memory(add)

importance 取值指引（由你按内容语义自主判定，禁止固定单一值）：
- 0.8~0.9：身份/长期偏好/明确计划/核心技术栈（用户亲口告知的稳定事实）
- 0.5~0.7：具体事件/当前任务/阶段性背景
- 0.2~0.3：寒暄/临时性/易变信息

search query 指引：必须用具体关键词而非自然语言描述。用"张三"而非"用户姓名"；用"TypeScript Node.js"而非"用户技术栈"。

回答要求：简洁直接，基于检索到的记忆和当前上下文作答。`;

// ======================================================================
/**
 * 1. 区分短期记忆（对话历史）与长期记忆（向量存储）
 * 记忆系统包含 5 个认知阶段：
 *   编码(Encoding) → 存储(Storage) → 检索(Retrieval) → 整合(Consolidation) → 遗忘(Forgetting)
 *
 * 按生命周期划分：
 *   短期记忆（会话级）：
 *     - 工作记忆 WorkingMemory：当前对话上下文，容量限制（默认50条），会话结束清理
 *   长期记忆（跨会话）：
 *     - 情景记忆 EpisodicMemory：具体交互事件，按时间序列检索
 *     - 语义记忆 SemanticMemory：抽象知识/用户偏好，按重要性持久化
 *
 * 存储方案（教学版，零外部依赖）：
 *   - 短期：纯内存数组 + FIFO 淘汰
 *   - 长期：内存数组 + 关键词匹配（模拟向量检索）
 *   生产环境可替换为 Qdrant 向量库 + Neo4j 图库（接口已预留）
 */

/**
 * MemoryItem：标准化记忆项 - 记忆系统的最小数据单元
 */
class MemoryItem {
  constructor({ content, type, metadata = {}, importance = 0.5 }) {
    this.id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`; // 唯一ID
    this.content = content;            // 记忆内容文本
    this.type = type;                  // working / episodic / semantic
    this.metadata = metadata;          // 附加元数据（用户ID、轮次、来源等）
    this.importance = importance;      // 重要性 0~1，影响整合与遗忘
    this.createdAt = Date.now();       // 创建时间
    this.lastAccessedAt = Date.now();  // 最近访问时间
    this.accessCount = 0;              // 访问次数
  }

  // 记录一次访问（用于遗忘策略中的"久未访问"判断）
  touch() {
    this.lastAccessedAt = Date.now();
    this.accessCount++;
  }
}

/**
 * 编码(Encoding) → 存储(Storage) → 检索(Retrieval) → 整合(Consolidation) → 遗忘(Forgetting)
 * BaseMemory：记忆基类 - 定义统一的记忆系统的 5 个认知阶段的接口。
 * 其中”整合（consolidate）“阶段放在MemoryManager中实现，因为它是跨记忆容器的操作，不是单一记忆类型内部的操作。
 */
class BaseMemory {
  constructor(config = {}) {
    this.config = config;
    this.items = [];
  }

  // 编码：把原始文本转换为 MemoryItem（不存储，只构造对象）
  encode(content, metadata = {}, importance = 0.5) {
    return new MemoryItem({
      content,
      type: this.typeName,
      metadata,
      importance
    });
  }

  // 存储：子类实现（短期有容量淘汰，长期无限制）
  add(item) {
    throw new Error('子类必须实现 add()');
  }

  // 检索：子类实现（短期按时间，长期按相关性）
  search(query, limit = 5) {
    throw new Error('子类必须实现 search()');
  }

  // 遗忘：子类实现（不同记忆类型有不同的遗忘策略）
  forget() {
    throw new Error('子类必须实现 forget()');
  }

  // 通用工具：分词 OR 匹配（教学版实现效果可能不够好，条件允许的话，TODO - 生产版可替换为向量相似度）
  // 1) 先尝试整段包含（兼容 LLM 用精确关键词如 "张三" 的情况）
  // 2) 整段不命中 → 分词 OR：按标点/空白拆 token，再对中文 token 生成 n-gram 子串（2/3 字滑动窗口）
  // 3) 任一 token 或 n-gram 命中即返回 true
  // 例：query="用户姓名" → tokens=["用户姓名"] → ngrams=["用户","户姓","姓名","用户姓","户姓名"]
  //     text="用户名叫张三" 命中 "用户" → true
  _match(text, query) {
    if (!query) return true;
    const t = String(text).toLowerCase();
    const q = String(query).toLowerCase();
    // 1) 整段包含（最快路径，LLM 用精确关键词时命中）
    if (t.includes(q)) return true;
    // 2) 按标点/空白拆分
    const rawTokens = q
      .split(/[\s,，。、;；:：.!?？！"'"'()（）\[\]【】\-—_\/]+/)
      .filter(tk => tk.length >= 1);
    if (!rawTokens.length) return false;
    // 3) 对每个 token，先尝试直接匹配；若不命中且为中文，生成 n-gram（2/3/4 字滑动窗口）
    //    英文 token 直接匹配（英文以空格分词，天然独立）
    const isChinese = (s) => /[\u4e00-\u9fa5]/.test(s);
    const ngramsOf = (s) => {
      // 生成所有 2~min(len,4) 字连续子串，用于中文模糊匹配
      const grams = new Set();
      for (let n = 2; n <= Math.min(s.length, 4); n++) {
        for (let i = 0; i <= s.length - n; i++) {
          grams.add(s.slice(i, i + n));
        }
      }
      return [...grams];
    };
    for (const tk of rawTokens) {
      // 直接匹配
      if (t.includes(tk)) return true;
      // 中文 token → n-gram 辅助匹配
      if (isChinese(tk) && tk.length >= 2) {
        for (const gram of ngramsOf(tk)) {
          if (t.includes(gram)) return true;
        }
      }
    }
    return false;
  }
}

/**
 * 工作记忆（短期） - 当前对话上下文
 * 容量有限，FIFO 淘汰，会话级生命周期
 */
class WorkingMemory extends BaseMemory {
  constructor(config = {}) {
    super(config);
    this.typeName = 'working';
    this.maxSize = config.maxSize || 50;  // 默认50条，对标文档建议
  }

  add(item) {
    item.type = 'working';
    this.items.push(item);
    // 超容量时淘汰最早的（FIFO，对标"近期记忆优先"的人类认知）
    while (this.items.length > this.maxSize) {
      this.items.shift();
    }
  }

  search(query, limit = 5) {
    // 短期记忆：按时间倒序取最近 N 条匹配项
    return this.items
      .filter(item => this._match(item.content, query))
      .slice(-limit)
      .reverse()
      .map(item => { item.touch(); return item; });
  }

  forget() {
    // 工作记忆：不主动遗忘（由会话结束时的 clear() 全量清理）
    // 这里保留空实现，供 MemoryManager 统一调用
  }

  // 会话结束时清理全部短期记忆
  clear() {
    this.items = [];
  }
}

/**
 * 情景记忆（长期） - 具体交互事件，按时间序列检索
 * 跨会话持久化，是 Agent "复盘学习" 的基础
 */
class EpisodicMemory extends BaseMemory {
  constructor(config = {}) {
    super(config);
    this.typeName = 'episodic';
  }

  add(item) {
    item.type = 'episodic';
    this.items.push(item);
    // 长期记忆无容量限制（TODO - 如果条件允许，可持久化到向量数据库）
  }

  search(query, limit = 5) {
    // 情景记忆：按时间倒序 + 关键词匹配
    return this.items
      .filter(item => this._match(item.content, query))
      // 长期记忆生命周期更复杂：未来可能导入历史数据（createdAt 早于现有条目）、从 working 整合进来旧事件，
      // 数组有序这个前提容易被打破。sort(createdAt) 不依赖隐含前提，更稳健。
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
      .map(item => { item.touch(); return item; });
  }

  forget() {
    // 遗忘策略：重要性低(低于0.3) + 长期未访问(超过7天未访问)
    const now = Date.now();
    const staleThreshold = 7 * 24 * 60 * 60 * 1000;  // 7 天
    const before = this.items.length;
    this.items = this.items.filter(item =>
      item.importance > 0.3 || (now - item.lastAccessedAt) < staleThreshold
    );
    return before - this.items.length; // 返回遗忘条数，便于观测
  }
}

/**
 * 语义记忆（长期） - 抽象知识/概念/用户偏好
 * 高持久性，是 Agent 形成"知识体系"的核心
 */
class SemanticMemory extends BaseMemory {
  constructor(config = {}) {
    super(config);
    this.typeName = 'semantic';
  }

  add(item) {
    item.type = 'semantic';
    // 语义记忆去重（按内容相似度，教学版用精确匹配），避免重复存储相同内容
    const exists = this.items.some(i => i.content === item.content);
    if (!exists) this.items.push(item);
  }

  search(query, limit = 5) {
    // 语义记忆：按重要性 + 关键词匹配
    return this.items
      .filter(item => this._match(item.content, query))
      .sort((a, b) => b.importance - a.importance)
      .slice(0, limit)
      .map(item => { item.touch(); return item; });
  }

  forget() {
    // 遗忘策略：仅遗忘重要性极低的记忆(低于0.1)
    const before = this.items.length;
    this.items = this.items.filter(item => item.importance > 0.1);
    return before - this.items.length; // 返回遗忘条数，便于观测
  }
}

/**
 * MemoryManager：记忆管理器 - 统一调度 5 阶段认知流程
 */
class MemoryManager {
  constructor(params = {}) {
    const {
      userID = 'default_user',
      enableWorking = true,
      enableEpisodic = true,
      enableSemantic = true
    } = params;

    this.userID = userID;
    this.memory_types = {};

    // 按启用标志初始化各类型记忆
    if (enableWorking) this.memory_types.working = new WorkingMemory();
    if (enableEpisodic) this.memory_types.episodic = new EpisodicMemory();
    if (enableSemantic) this.memory_types.semantic = new SemanticMemory();

    console.log(`[MemoryManager] 初始化完成，启用记忆类型: [${Object.keys(this.memory_types).join(', ')}]`);
  }

  // 阶段1+2：编码+存储
  add(content, type = 'working', metadata = {}, importance = 0.5) {
    const memory = this.memory_types[type];
    if (!memory) throw new Error(`未知记忆类型: '${type}'，可用: ${Object.keys(this.memory_types).join(', ')}`);
    // 编码
    const item = memory.encode(content, metadata, importance);
    // 存储
    memory.add(item);
    return item;
  }

  // 阶段3：检索（跨记忆类型）
  search(query, types = ['working', 'episodic', 'semantic'], limit = 5) {
    const results = [];
    // 遍历所有记忆类型，找出不同记忆类型中的匹配项
    for (const t of types) {
      const memory = this.memory_types[t];
      if (memory) results.push(...memory.search(query, limit));
    }
    // 综合排序：重要性优先，其次按访问时间
    const sorted = results
      .sort((a, b) => b.importance - a.importance || b.lastAccessedAt - a.lastAccessedAt)
      .slice(0, limit);

    // 降级兜底：精确匹配完全空时，返回 Top-N 高 importance 记忆给 LLM 参考
    // 场景：LLM 用自然语言 query 没命中，但高 importance 记忆里可能有相关信息
    if (sorted.length === 0) {
      const fallback = [];
      for (const t of types) {
        const memory = this.memory_types[t];
        if (memory) fallback.push(...memory.items);
      }
      return fallback
        .sort((a, b) => b.importance - a.importance || b.lastAccessedAt - a.lastAccessedAt)
        .slice(0, limit)
        .map(item => { item.touch(); return item; });
    }
    return sorted;
  }

  // 阶段4：整合 - 把重要的工作记忆转化为长期记忆（对标"短期(工作记忆)→长期(情景记忆)"的人类记忆固化）
  consolidate() {
    const working = this.memory_types.working;
    const episodic = this.memory_types.episodic;
    if (!working || !episodic) return 0;

    let count = 0;
    for (const item of working.items) {
      // 重要性高于阈值(0.6)的短期记忆，固化为长期情景记忆
      if (item.importance >= 0.6) {
        const consolidated = new MemoryItem({
          content: item.content,
          type: 'episodic',
          metadata: { ...item.metadata, consolidatedFrom: 'working' },
          importance: item.importance
        });
        episodic.add(consolidated);
        count++;
      }
    }
    console.log(`[MemoryManager] 整合完成：${count} 条工作记忆 → 情景记忆`);
    return count;
  }

  // 阶段5：遗忘 - 删除不重要或过时的信息
  forget() {
    let total = 0;
    // 遍历所有记忆类型，执行遗忘策略
    for (const memory of Object.values(this.memory_types)) {
      if (memory.forget) {
        const removed = memory.forget() || 0;
        total += removed;
      }
    }
    console.log(`[MemoryManager] 遗忘完成：清理 ${total} 条低价值记忆`);
    return total;
  }

  // 会话结束清理（仅短期记忆）
  clearSession() {
    if (this.memory_types.working) {
      this.memory_types.working.clear();
      console.log('[MemoryManager] 工作记忆会话清理完成');
    }
  }

  // 观测：打印各类型记忆统计
  stats() {
    const stats = {};
    for (const [type, memory] of Object.entries(this.memory_types)) {
      stats[type] = memory.items.length;
    }
    return stats;
  }
}

/**
 * MemoryTool：记忆工具 - 作为 Agent 可调用的工具
 * 让 Agent 通过 Function Calling 主动存取记忆
 */
class MemoryTool {
  constructor({ userID = 'default_user' } = {}) {
    this.name = 'memory';
    this.description = '存储和检索记忆，支持短期(working)/长期(episodic/semantic)记忆管理';
    this.parameters = {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: '操作类型: add(存储) / search(检索) / consolidate(整合) / forget(遗忘)'
        },
        content: { type: 'string', description: 'add 时的记忆内容' },
        query: { type: 'string', description: 'search 时的检索关键词。必须用具体关键词而非自然语言：用"张三"而非"用户姓名"；用"TypeScript Node.js"而非"用户技术栈"；用"计划 30 天"而非"用户打算学几天"' },
        type: {
          type: 'string',
          enum: ['working', 'episodic', 'semantic'],
          description: '记忆类型，默认 working'
        },
        importance: { type: 'number', description: '重要性 0~1，默认 0.5。按内容语义自主取值：身份/长期偏好/明确计划取0.8-0.9；具体事件/当前任务取0.5-0.7；寒暄/临时信息取0.2-0.3' }
      },
      required: ['action']
    };
    this.func = this._execute.bind(this);
    this.memoryManager = new MemoryManager({ userID });
  }

  async _execute({ action, content = '', query = '', type = 'working', importance = 0.5 }) {
    switch (action) {
      case 'add':
        return `已存储记忆: ${this.memoryManager.add(content, type, {}, importance).id}`;
      case 'search': {
        const results = this.memoryManager.search(query);
        return JSON.stringify(results.map(r => ({
          type: r.type,
          content: r.content,
          importance: r.importance
        })), null, 2);
      }
      case 'consolidate':
        return `已整合 ${this.memoryManager.consolidate()} 条记忆`;
      case 'forget':
        return `已遗忘 ${this.memoryManager.forget()} 条记忆`;
      default:
        return `未知操作: ${action}`;
    }
  }
}

// ======================================================================
/**
 * 2. 为 Agent 加对话历史管理：保留最近 N 轮 + 自动摘要旧对话，上下文溢出处理（超预算时裁剪/压缩）
 */
/**
 * ConversationHistory：对话历史管理器
 * - 保留最近 N 轮原始对话（短期记忆窗口）
 * - 旧对话自动摘要压缩（避免超 Token 限制）
 * - 与 MemoryManager 协同：可把关键信息存入长期记忆
 */
class ConversationHistory {
  constructor({ maxRounds = 10, memoryManager = null, llmClient = null } = {}) {
    this.maxRounds = maxRounds;          // 保留最近 N 轮原始对话
    this.messages = [];                  // 当前窗口内的原始消息
    this.summary = '';                   // 旧对话的摘要
    this.memoryManager = memoryManager;  // 可选：接入长期记忆
    this.llmClient = llmClient;          // 可选：生产环境用 LLM 总结旧对话
  }

  // 添加一轮对话（异步：生产环境摘要会调用 LLM）
  async push(message) {
    this.messages.push(message);
    // 超出窗口时触发摘要压缩
    if (this.messages.length > this.maxRounds * 2) {  // 一轮 = user + assistant
      await this._summarize();
    }
  }

  // 获取给 LLM 用的 messages（摘要作为 system 兜底 + 最近 N 轮原文）
  getMessages(systemPrompt) {
    const result = [];
    if (systemPrompt) result.push({ role: 'system', content: systemPrompt });
    if (this.summary) {
      result.push({ role: 'system', content: `[历史摘要] ${this.summary}` });
    }
    result.push(...this.messages);
    return result;
  }

  // 摘要旧对话
  // - 教学版（无 llmClient）：简单拼接，零外部依赖
  // - 生产环境（有 llmClient）：调用 LLM 在已有摘要上增量浓缩关键事实，失败时降级为简单拼接
  async _summarize() {
    const oldMessages = this.messages.splice(0, 2);  // 移出最早的一轮
    const oldText = oldMessages.map(m => `${m.role}: ${m.content}`).join(' | ');
    // 默认权重 0.6（教学版兜底）；生产环境由 LLM 判定后覆盖
    let summarizedImportance = 0.6;

    if (this.llmClient) {
      // 生产环境：用 LLM 同时产出「摘要」+「重要性」，要求 JSON 输出
      const prompt = [
        { role: 'system', content: '你是对话摘要助手。将「已有摘要」与「新增对话」融合，输出 JSON：{"summary": "不超过300字的摘要", "importance": 0.0~1.0}。摘要要求：保留关键事实（姓名/偏好/计划/技术栈/已做决定/关键数字），省略寒暄与冗余问答。importance 取值指引（按内容语义判定，禁止固定单一值）：0.8~0.9 含稳定身份/长期偏好/明确计划；0.5~0.7 具体事件/当前任务；0.2~0.3 寒暄/临时信息。只输出 JSON，不要附加说明或 markdown 标记。' },
        { role: 'user', content: `已有摘要：${this.summary || '（无）'}\n\n新增对话：\n${oldText}` }
      ];
      try {
        const completion = await this.llmClient.chat.completions.create({
          messages: prompt,
          model: 'deepseek-v4-flash'
        });
        const raw = (completion.choices[0].message.content || '').trim();
        // 解析 JSON：兼容 LLM 偶发包裹 ```json ... ``` 的情况
        let parsed = null;
        try {
          const jsonMatch = raw.match(/\{[\s\S]*\}/);
          parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(raw);
        } catch { /* 解析失败走降级 */ }

        if (parsed && typeof parsed.summary === 'string') {
          this.summary = parsed.summary.trim().slice(0, 500);
          // importance 数值校验 + clamp 到 [0,1]，非法则兜底 0.6
          const imp = Number(parsed.importance);
          summarizedImportance = (Number.isFinite(imp) && imp >= 0 && imp <= 1) ? imp : 0.6;
        } else {
          // 非法 JSON 但有文本输出：把整段当摘要，importance 取兜底0.6
          this.summary = raw.slice(0, 500) || (this.summary ? `${this.summary} | ${oldText}` : oldText).slice(-500);
          console.warn('[ConversationHistory] LLM 返回非 JSON，摘要降级为原文截断，importance 兜底 0.6');
        }
      } catch (err) {
        // LLM 调用本身失败（网络/限流等），降级为简单拼接
        console.warn(`[ConversationHistory] LLM 摘要失败，降级为简单拼接: ${err.message}`);
        this.summary = (this.summary ? `${this.summary} | ${oldText}` : oldText).slice(-500);
      }
    } else {
      // 教学版：截取前半部分简单拼接
      this.summary = (this.summary ? `${this.summary} | ${oldText}` : oldText).slice(-500);
    }

    // 可选：把关键信息存入长期记忆（存储原始对话文本，便于检索时关键词命中）
    // importance：prod 由 LLM 按内容语义判定，教学版默认 0.6（窗口外历史摘要的工程经验值）
    if (this.memoryManager) {
      this.memoryManager.add(oldText, 'episodic', { source: 'history_summary' }, summarizedImportance);
    }
  }

  // 获取当前历史轮数
  size() {
    return Math.floor(this.messages.length / 2);
  }
}
/**
 * LongConversationAgent：长对话测试 Agent
 * - 单轮 chat()：push 历史 → 调 LLM → 解析 tool_calls → 执行工具 → 二次调 LLM 生成最终回复
 * - 批量 runLongConversation()：顺序跑 N 个测试用例，每轮打印 token 数和工具调用情况
 */
class LongConversationAgent {
  constructor({ llmClient, memoryTool, history, maxRounds = 10 }) {
    this.llmClient = llmClient;
    this.memoryTool = memoryTool;
    this.history = history;
    this.maxRounds = maxRounds;
    // 工具 schema（DeepSeek Function Calling 格式）
    this.tools = [{
      type: 'function',
      function: {
        name: this.memoryTool.name,
        description: this.memoryTool.description,
        parameters: this.memoryTool.parameters
      }
    }];
    // 工具名 → 执行函数 的映射
    this.toolMap = { [this.memoryTool.name]: this.memoryTool.func };
  }

  // 调用 LLM（封装一层便于统一加参数）
  async _sendMessages(messages) {
    const completion = await this.llmClient.chat.completions.create({
      messages,
      model: 'deepseek-v4-flash',
      tools: this.tools
    });
    // 返回 message + usage：usage 含 prompt/completion/total tokens（DeepSeek 非流式默认返回）
    return { message: completion.choices[0].message, usage: completion.usage };
  }

  // 单轮对话：返回 assistant 最终回复文本
  // 单轮 chat()：push 历史 → 调 LLM → 解析 tool_calls → 执行工具 → 二次调 LLM 生成最终回复
  async chat(userInput) {
    // 1. 用户消息入历史（可能触发自动摘要压缩，生产环境会调 LLM）
    await this.history.push({ role: 'user', content: userInput });

    // 2. 构造给 LLM 的 messages：system + 历史摘要 + 最近 N 轮原文
    let messages = this.history.getMessages(SYSTEM_PROMPT);

    // 3. Agent 循环（最多 2 轮：第 1 轮可能调工具，第 2 轮生成最终回复）
    let round = 0;
    let tokenUsage = null;  // 累计每轮真实 usage（来自 DeepSeek API），最终保留生成回复那轮
    while (round < 2) {
      round++;
      const { message, usage } = await this._sendMessages(messages);
      if (usage) tokenUsage = usage;

      // 没有工具调用 → 直接返回文本
      if (!message.tool_calls) {
        // 在两轮内得到有效回复，push到历史记录history，返回，结束循环
        const reply = message.content || '';
        // 可能触发自动摘要压缩，生产环境会调 LLM
        await this.history.push({ role: 'assistant', content: reply });
        return { reply, toolCalls: [], tokenUsage };
      }

      // 有工具调用 → 执行并把结果回传
      messages.push(message);
      const toolCallsInfo = [];
      for (const tool of message.tool_calls) {
        const toolName = tool.function.name;
        let args = {};
        try { args = JSON.parse(tool.function.arguments || '{}'); }
        catch { console.error(`⚠️ 工具 '${toolName}' 参数解析失败`); }

        const toolResult = await this.toolMap[toolName](args);
        console.log(`  [Tool] ${toolName}(${JSON.stringify(args)}) → ${toolResult.slice(0, 80)}...`);
        toolCallsInfo.push({ name: toolName, args, result: toolResult });

        messages.push({ role: 'tool', tool_call_id: tool.id, content: toolResult });
      }
      // 工具结果已回传，进入下一轮让 LLM 生成最终回复
      // 注意：不把中间 message push 到 history，只 push 最终文本回复，否则会导致 历史记录history 膨胀
    }
    // 走到这里说明两轮都没拿到最终回复，兜底返回
    const reply = '（未生成有效回复）';
    // 可能触发自动摘要压缩，生产环境会调 LLM
    await this.history.push({ role: 'assistant', content: reply });
    return { reply, toolCalls: [], tokenUsage };
  }

  // 批量跑长对话测试用例
  async runLongConversation(testCases) {
    console.log(`\n========== 开始 ${testCases.length} 轮长对话测试 ==========\n`);
    for (let i = 0; i < testCases.length; i++) {
      const userInput = testCases[i];
      console.log(`--- 第 ${i + 1}/${testCases.length} 轮 ---`);
      console.log(`👤 用户: ${userInput}`);

      const { reply, toolCalls, tokenUsage } = await this.chat(userInput);
      console.log(`🤖 助手: ${reply}`);
      if (toolCalls.length) {
        console.log(`🔧 本轮调用工具 ${toolCalls.length} 次`);
      }

      // 打印真实 token 使用量（来自 DeepSeek API usage 字段，替代字符粗估）
      // prompt_tokens = 本轮输入（system+摘要+历史+用户消息）真实 token，随轮次增长，用于验证上下文不超限
      // completion_tokens = 本轮输出（assistant 回复）真实 token，随轮次增长，用于验证上下文不超限
      // total_tokens = prompt_tokens + completion_tokens，随轮次增长，用于验证上下文不超限
      if (tokenUsage) {
        console.log(`📊 [tokens] prompt: ${tokenUsage.prompt_tokens}, completion: ${tokenUsage.completion_tokens}, total: ${tokenUsage.total_tokens} | 窗口内 ${this.history.size()} 轮\n`);
      } else {
        console.log(`📊 窗口内 ${this.history.size()} 轮\n`);
      }
    }
  }
}

// ======================================================================
/**
 * 3. 实现粗略 Token 计数估算
 */
// 简易 Token 估算器（4 字符 ≈ 1 token，仅中文/英文混合粗估）
function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(String(text).length / 4);
}

// 计算整个 messages 数组的 token 数
function countMessagesTokens(messages) {
  return messages.reduce((sum, m) => sum + estimateTokens(m.content || ''), 0);
}

// ======================================================================
/**
 * 4. 测试：连续 20 轮以上对话，观察上下文管理效果
 */
/**
 * 生产环境测试用例：20 轮对话，含关键信息埋点 + 回溯验证
 */
const LONG_CONVERSATION_CASES = [
  '你好，我叫张三，今天开始学习 AI Agent 开发',             // 1. 埋点：姓名→semantic + 学习启动事件→semantic
  '我偏好简洁的代码风格，不喜欢太多注释',                    // 2. 埋点：偏好→semantic
  '我在用 TypeScript 和 Node.js',                          // 3. 埋点：技术栈→semantic
  'ReAct 里的 Thought 和 Action 有什么区别？',              // 4. 普通问答（不存记忆）
  '今天天气怎么样？',                                       // 5. 无关问题（不存记忆）
  'Function Calling 和 ReAct 是一回事吗？',                 // 6. 普通问答（不存记忆）
  '帮我算一下 1234 * 5678 等于多少',                       // 7. 无关问题（不存记忆，无 calculator 工具）
  '我计划 30 天学完 Agent 开发',                            // 8. 埋点：长期计划→semantic
  '今天我刚完成了 Day3 的练习',                              // 9. 交互事件/任务进展→working
  '刚在讨论 Agent 开发的 ReAct 框架',                      // 10. 交互事件/任务进展→working
  '工作记忆和长期记忆有什么区别？',                         // 11. 普通问答（不存记忆）
  '我喜欢用 Trae 编辑器',                                   // 12. 埋点：偏好→semantic
  '能举个例子说明 Agent 是怎么"感知-规划-行动"的吗？',      // 13. 普通问答（不存记忆）
  'Token 计数为什么重要？',                                 // 14. 普通问答（不存记忆）
  '你还记得我叫什么名字吗？',                               // 15. ★回溯验证：search→命中 semantic
  '你还记得我的技术栈是什么吗？',                            // 16. ★回溯验证：search→命中 semantic
  '你还记得我有什么偏好吗？',                               // 17. ★回溯验证：search→命中 semantic
  '整合和遗忘在记忆系统里起什么作用？',                     // 18. 普通问答（不存记忆）
  '你还记得我打算学几天的 Agent 开发吗？',                  // 19. ★回溯验证：search→命中 semantic
  '请简要总结我们这轮对话的关键信息'                        // 20. 验证长上下文保持（summary 通路）
];

const isProdEnv = process.env.MEMORY_MANAGER_ENV === 'prod';

async function main() {
  if (isProdEnv) {
    console.log('\n========== MEMORY_MANAGER_ENV=prod 生产环境执行开始 ==========');
    // 1. 初始化 LLM 客户端 + 记忆工具 + 对话历史
    const memoryTool = new MemoryTool({ userID: 'prod_user_001' });
    const history = new ConversationHistory({
      maxRounds: 10,              // 保留最近 10 轮原文
      memoryManager: memoryTool.memoryManager,
      llmClient: openai           // 生产环境：用 LLM 增量总结旧对话
    });
    // 2. 预置一些长期语义记忆（模拟跨会话带入的先验知识）
    const mm = memoryTool.memoryManager;

    // 3. 注入长对话 Agent
    const agent = new LongConversationAgent({
      llmClient: openai,
      memoryTool,
      history,
      maxRounds: 10
    });

    // 4. 执行 20 轮长对话测试
    await agent.runLongConversation(LONG_CONVERSATION_CASES);

    // 5. 测试结束：先整合工作记忆 → 情景记忆
    console.log('\n========== 记忆整合（working → episodic）==========');
    mm.consolidate();
    // 6. 然后打印统计 + 执行遗忘
    console.log('\n========== 记忆统计 ==========');
    console.log(mm.stats());
    console.log('\n========== 执行遗忘 ==========');
    mm.forget();
    console.log('遗忘后统计:', mm.stats());
    console.log('\n========== MEMORY_MANAGER_ENV=prod 生产环境执行结束 ==========');
    return;
  }
  console.log('\n========== MEMORY_MANAGER_ENV=test 测试环境Mock执行开始 ==========');
  console.log('\n========== 1. 记忆系统基础测试 ==========');
  const memoryTool = new MemoryTool({ userID: 'test_user_001' });
  const mm = memoryTool.memoryManager;

  // 短期记忆：模拟当前对话
  mm.add('用户姓名: 张三', 'working', {}, 0.9);
  mm.add('正在学习 Python', 'working', {}, 0.8);
  mm.add('当前在第4天学习', 'working', {}, 0.6);

  // 长期情景记忆：过去的交互事件
  mm.add('2026-08-20 完成了 Day1 单轮对话练习', 'episodic', {}, 0.7);
  mm.add('2026-08-25 实现了 ReAct 循环', 'episodic', {}, 0.8);

  // 长期语义记忆：抽象偏好
  mm.add('用户偏好简洁的代码风格', 'semantic', {}, 0.9);
  mm.add('用户技术栈: TypeScript/Node.js', 'semantic', {}, 0.85);

  console.log('\n--- 各类型记忆统计 ---');
  console.log(mm.stats());

  console.log('\n--- 检索: "张三" ---');
  console.log(mm.search('张三').map(r => `[${r.type}] ${r.content} (imp=${r.importance})`));

  console.log('\n--- 检索: "Python" ---');
  console.log(mm.search('Python').map(r => `[${r.type}] ${r.content} (imp=${r.importance})`));

  console.log('\n========== 2. 整合：短期 → 长期 ==========');
  mm.consolidate();
  console.log('整合后统计:', mm.stats());

  console.log('\n========== 3. 对话历史管理测试 ==========');
  const history = new ConversationHistory({ maxRounds: 3, memoryManager: mm });

  // 模拟 6 轮对话（超出 maxRounds=3，触发摘要压缩；无 llmClient，走教学版拼接）
  for (let i = 1; i <= 6; i++) {
    await history.push({ role: 'user', content: `第${i}轮提问` });
    await history.push({ role: 'assistant', content: `第${i}轮回答，包含一些内容用于测试` });
  }

  console.log(`当前窗口内轮数: ${history.size()}`);  // 应 ≤ 3
  console.log(`摘要长度: ${history.summary.length} 字符`);
  console.log('最终消息数:', history.getMessages('你是一个助手').length);

  console.log('\n========== 4. Token 计数测试 ==========');
  const testMessages = history.getMessages('你是一个助手');
  const tokens = countMessagesTokens(testMessages);
  console.log(`当前 messages 估算 token 数: ${tokens}`);

  console.log('\n========== 5. 通过 MemoryTool 调用（Function Calling 接口）==========');
  console.log(await memoryTool.func({ action: 'search', query: 'TypeScript' }));
  console.log(await memoryTool.func({ action: 'forget' }));

  console.log('\n========== MEMORY_MANAGER_ENV=test 测试环境Mock执行结束 ==========');
}

// 统一捕获主流程异常
main().catch((err) => {
  console.error('\n❌ 执行出错:', err.message);
  process.exit(1);
});
