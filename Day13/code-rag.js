/**
 * 代码仓库级 RAG 实战（AST 分片）
 * 参考资料：
 * - [RAG流程笔记](../Day12/RAG流程笔记.md)
 * - [《Hello-Agents》第8章「记忆与RAG系统」RAG部分 - 构建智能文档问答助手](https://datawhalechina.github.io/hello-agents/#/./chapter8/%E7%AC%AC%E5%85%AB%E7%AB%A0%20%E8%AE%B0%E5%BF%86%E4%B8%8E%E6%A3%80%E7%B4%A2?id=_84-%e6%9e%84%e5%bb%ba%e6%99%ba%e8%83%bd%e6%96%87%e6%a1%a3%e9%97%ae%e7%ad%94%e5%8a%a9%e6%89%8b)
 * - [Langchain 官方文档 - 构建本地 RAG 应用](https://python.langchain.ac.cn/docs/tutorials/local_rag/)
 *
 * 实现功能：
 * 1. 选择开源仓库 [homework-project1-personal-agent](https://github.com/superZchen0701/homework-project1-personal-agent.git) 作为知识库，先把代码克隆到本地（repo-demo）
 * 2. 实现代码感知分片：按文件 → 按函数/类（用 @babel/parser 生成 AST 再切分）
 * 3. 构建代码索引：文件路径 + 函数名 + 代码内容 + 注释
 * 4. search() 方法包装为代码检索工具，注册进 LangGraph Agent 的 tools
 *
 * 架构：
 *   AST 解析 → 函数/类级分片 → Embedding → 内存向量索引 → search() 工具 → LangGraph React Agent
 */
import { ChatOpenAI } from '@langchain/openai';
import { z } from 'zod';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import { StateGraph, START, END, Annotation, MessagesAnnotation } from '@langchain/langgraph';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { parse as babelParse } from '@babel/parser';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

// ======================================================================
// 零、环境初始化
// ======================================================================
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

if (!process.env.DEEPSEEK_API_KEY) {
  throw new Error('未设置环境变量 DEEPSEEK_API_KEY，请先执行: export DEEPSEEK_API_KEY=你的key');
}
if (!process.env.BIGMODEL_EMBEDDING_API_URL || !process.env.BIGMODEL_EMBEDDING_API_KEY) {
  throw new Error('未设置环境变量 BIGMODEL_EMBEDDING_API_URL 或 BIGMODEL_EMBEDDING_API_KEY');
}

// LLM：DeepSeek（用于 Agent 推理）
const llm = new ChatOpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  modelName: 'deepseek-flash',
  temperature: 0,
  configuration: { baseURL: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com' },
  timeout: 120_000,
  maxRetries: 2,
});

// ======================================================================
// 一、Embedding：调用智谱 BigModel API（与 Day12 一致）
// ======================================================================
async function embedTexts(texts) {
  const batchSize = 16;
  const allVectors = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const res = await fetch(process.env.BIGMODEL_EMBEDDING_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.BIGMODEL_EMBEDDING_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ input: batch, model: 'embedding-3', encoding_format: 'float' }),
    });
    if (!res.ok) throw new Error(`Embedding API 失败: HTTP ${res.status} - ${await res.text()}`);
    const data = await res.json();
    const vectors = data.data.sort((a, b) => a.index - b.index).map((item) => item.embedding);
    allVectors.push(...vectors);
  }
  return allVectors;
}

async function embedText(text) {
  const [vec] = await embedTexts([text]);
  return vec;
}

// 计算两个向量的余弦相似度：a・b / (|a| * |b|)，返回 -1~1（越大越相似）
function cosineSimilarity(a, b) {
  if (a.length !== b.length) throw new Error('向量维度不一致，请确认建库和查询使用同一嵌入模型');
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ======================================================================
// 二、代码仓库遍历与 AST 分片
// ======================================================================
const CODE_EXTS = ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.mts', '.cts', '.tsx'];

/** 递归收集仓库内所有代码文件（跳过 node_modules / .git / 构建产物） */
function collectCodeFiles(rootDir) {
  const results = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist' || entry.name === 'build') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (CODE_EXTS.includes(path.extname(entry.name))) results.push(full);
    }
  };
  walk(rootDir);
  return results;
}

/**
 * 代码感知分片核心：用 @babel/parser 生成 AST，提取函数/方法/类的代码片段。
 * 比按行/按字符分片更贴合代码语义——每个"切片"恰好是一个有边界的逻辑单元。
 * @param {string} source 文件源码
 * @returns {Array<{name, code, startLine}>} 函数/类级片段列表
 */
function astChunk(source) {
  const chunks = [];
  let ast;
  try {
    // 宽松解析：sourceType module，自动处理 TS/JSX
    ast = babelParse(source, {
      sourceType: 'unambiguous',
      plugins: ['jsx', 'typescript', 'classProperties'],
    });
  } catch {
    // 解析失败（如极简脚本）则放弃分片，返回空（调用方回退为整文件切片）
    return chunks;
  }

  for (const node of ast.program.body) {
    // 顶层函数声明 / 箭头函数 / 函数表达式
    if (node.type === 'FunctionDeclaration') {
      chunks.push({ name: node.id?.name || '(anonymous)', code: source.slice(node.start, node.end), startLine: node.loc.start.line });
    } else if ((node.type === 'VariableDeclaration')) {
      for (const decl of node.declarations) {
        const fn = decl.init;
        if (fn && (fn.type === 'ArrowFunctionExpression' || fn.type === 'FunctionExpression')) {
          chunks.push({
            name: decl.id?.name || '(anonymous)',
            code: source.slice(node.start, node.end),
            startLine: node.loc.start.line,
          });
        }
      }
    } else if (node.type === 'ClassDeclaration') {
      // 类：整体一段 + 类内方法逐段
      chunks.push({ name: `class ${node.id?.name}`, code: source.slice(node.start, node.end), startLine: node.loc.start.line });
      for (const member of node.body.body) {
        if ((member.type === 'ClassMethod' || member.type === 'ClassProperty') && member.key?.name) {
          let code = source.slice(member.start, member.end);
          chunks.push({ name: `${node.id?.name}#${member.key.name}`, code, startLine: member.loc.start.line });
        }
      }
    }
  }
  return chunks;
}

/**
 * 解析一个文件为代码片段列表。
 * 解释 AST 成功则用函数/类级片段；对解析失败的文件回退为行级块，保证不丢内容。
 */
function chunkFile(filePath) {
  const relative = path.relative(__dirname, filePath);
  const source = fs.readFileSync(filePath, 'utf-8');
  const astChunks = astChunk(source);
  // 成功解析 AST 则使用函数/类级片段
  if (astChunks.length > 0) {
    return astChunks.map((c) => ({
      name: c.name,
      path: relative,
      startLine: c.startLine,
      content: c.code,
      kind: 'function/class',
    }));
  }
  // 解析失败的回退：按行切块（约 60 行一块，带 10 行重叠）
  const lines = source.split('\n');
  const chunks = [];
  const chunkSize = 60, overlap = 10;
  for (let i = 0; i < lines.length; i += chunkSize - overlap) {
    const seg = lines.slice(i, i + chunkSize).join('\n');
    if (seg.trim()) chunks.push({ name: `file#L${i + 1}`, path: relative, startLine: i + 1, content: seg, kind: 'fallback-block' });
  }
  return chunks;
}

// ======================================================================
// 三、CodeRAG 引擎：建库 + 检索
// ======================================================================
class CodeRAG {
  constructor(rootDir) {
    // 代码仓库根目录
    this.rootDir = rootDir;
    // 代码片段向量库：[{ name, path, startLine, content, vector }]
    this.store = [];
  }

  /** 建索引：遍历文件 → AST 分片 → Embedding → 写入内存向量库 */
  async buildIndex() {
    const files = collectCodeFiles(this.rootDir);
    console.log(`扫描到 ${files.length} 个代码文件`);

    let allChunks = [];
    for (const f of files) {
      const fileChunks = chunkFile(f);
      allChunks.push(...fileChunks);
      console.log(`  ${path.basename(f)}: ${fileChunks.length} 个片段`);
    }
    console.log(`共 ${allChunks.length} 个代码片段，开始向量化...`);

    const contents = allChunks.map((c) => c.content);
    const vectors = await embedTexts(contents);
    this.store = allChunks.map((c, i) => ({ ...c, vector: vectors[i] }));
    console.log(`✅ 索引构建完成，共 ${this.store.length} 条`);
  }

  /** 语义检索：按 query 找最相似的 topK 个代码片段 */
  async search(query, topK = 3) {
    const qv = await embedText(query);
    return this.store
      .map((item) => ({ ...item, score: cosineSimilarity(qv, item.vector) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }
}

// ======================================================================
// 四、把 search 包装成 LangGraph 工具
// ======================================================================
function buildSearchTool(rag) {
  return new DynamicStructuredTool({
    name: 'code_search',
    description:
      '在代码仓库中按语义检索相关代码片段。当需要定位某个函数/类定义在哪、查看某段逻辑实现时使用。返回片段含文件路径、函数名、起始行号和代码内容。',
    schema: z.object({
      query: z.string().describe('要检索的代码相关内容描述，如"用户管理函数的实现"'),
      topK: z.number().optional().describe('返回条数，默认 3'),
    }),
    func: async ({ query, topK = 3 }) => {
      const results = await rag.search(query, topK);
      return results
        .map(
          (r, i) =>
            `[${i + 1}] ${r.kind} | ${r.path}:${r.startLine} | 相似度=${r.score.toFixed(4)}\n` +
            `名称: ${r.name}\n\`\`\`js\n${r.content}\n\`\`\``
        )
        .join('\n\n---\n\n');
    },
  });
}

// ======================================================================
// 五、LangGraph React Agent：用 code_search 工具回答代码库问题
// ======================================================================
const AgentState = Annotation.Root({
  ...MessagesAnnotation.spec,
});

// 绑定工具后的模型（在 buildAgent 中被惰性赋值）
let modelWithTools = null;

async function agentNode(state) {
  const sysPrompt = new SystemMessage(
    `你是代码库检索助手。你可以使用 code_search 工具在代码仓库中检索代码。
回答问题前先调用 code_search 定位相关代码，再基于检索结果回答，并给出函数所在文件路径和行号。
如果用户问"XX函数在哪里定义"，请明确回答：函数名、文件路径、起始行号。`
  );
  // 注意：必须用 bindTools 后的模型，才能让 LLM 原生返回结构化 tool_calls
  if (!modelWithTools) {
    throw new Error('模型未绑定工具，无法调用 code_search 工具');
  }
  const resp = await modelWithTools.invoke([sysPrompt, ...state.messages]);
  return { messages: [resp] };
}

function buildAgent(tool) {
  // 给模型绑定工具：让 LLM 原生返回结构化 tool_calls，而不是输出"调用意图"的文字
  modelWithTools = llm.bindTools([tool]);
  const workflow = new StateGraph(AgentState)
    .addNode('agent', agentNode)
    .addNode('tools', new ToolNode([tool]))
    .addEdge(START, 'agent')
    .addConditionalEdges('agent', (state) => {
      // 先由 LLM 决定是否调用工具
      const last = state.messages[state.messages.length - 1];
      const toolCalls = last?.tool_calls ?? [];
      return toolCalls.length > 0 ? 'tools' : END;
    })
    .addEdge('tools', 'agent'); // 工具结果回送 agent
  return workflow.compile();
}

// ======================================================================
// 六、主流程
// ======================================================================
async function main() {
  const repoRoot = path.resolve(__dirname, './repo-demo');
  if (!fs.existsSync(repoRoot)) {
    throw new Error(`未找到知识库目录 ${repoRoot}，请先: git clone https://github.com/superZchen0701/homework-project1-personal-agent.git repo-demo`);
  }

  console.log('═'.repeat(60));
  console.log('代码仓库级 RAG：AST 分片 + LangGraph Agent');
  console.log('═'.repeat(60));

  // 1. 建索引
  const rag = new CodeRAG(repoRoot);
  await rag.buildIndex();

  // 2. 包装为工具并构建 Agent
  const tool = buildSearchTool(rag);
  const app = buildAgent(tool);

  // 3. 连续提问
  const questions = [
    'agent 这个函数在哪里定义？它的主要逻辑是什么？',
    '记忆系统中 working memory 是怎么实现的？',
  ];

  for (const q of questions) {
    console.log('\n' + '═'.repeat(60));
    console.log(`❓ ${q}`);
    console.log('═'.repeat(60));
    const result = await app.invoke({ messages: [new HumanMessage(q)] });
    const answer = result.messages.filter((m) => m.constructor?.name === 'AIMessage');
    const last = answer[answer.length - 1];
    console.log('\n💡 最终回答:\n' + (last?.content ?? '(无)' ));
  }
}

main().catch((err) => {
  console.error('\n❌ 执行出错:', err);
  process.exit(1);
});