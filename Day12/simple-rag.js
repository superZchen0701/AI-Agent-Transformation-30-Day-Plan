/**
 * 用 JavaScript 实现极简 RAG：用 智谱 embedding-3 + DeepSeek 实现知识问答。
 * 参考资料：
 * - [RAG流程笔记](./RAG流程笔记.md)
 * - [Langchain 官方文档 - 构建本地 RAG 应用](https://python.langchain.ac.cn/docs/tutorials/local_rag/)
 * - [智谱 BigModel 文本嵌入 API使用指南](https://docs.bigmodel.cn/api-reference/%E6%A8%A1%E5%9E%8B-api/%E6%96%87%E6%9C%AC%E5%B5%8C%E5%85%A5)
 * 
 * 实现功能：
 * 阶段一：数据准备（索引构建）
 *   - 文档加载：支持 Markdown、PDF 等格式
 *   - 文本分片：使用 langchain RecursiveCharacterTextSplitter（固定大小分片 + 重叠 overlap）
 *   - Embedding（纯 API 调用）：使用 智谱 BigModel embedding-3
 *   - 向量存储：用内存数组 + 余弦相似度计算实现简易检索
 * 阶段二：查询与生成
 *   - 提问向量化：使用 智谱 BigModel embedding-3 对用户问题进行向量化
 *   - 相似度检索：根据余弦相似度计算，筛选出距离最近的 Top-K 个 chunk
 *   - 拼装 + 生成：把检索片段按模板拼进 Prompt（`上下文 + 问题 + "只根据上下文回答"`），LLM 生成答案
 * 
 * 测试：对一份技术文档（./demo-doc.pdf）进行问答，验证 RAG 功能是否正常
 */
import { ChatOpenAI } from '@langchain/openai';
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import { MarkItDown } from 'markitdown-ts';
import { extractText, getDocumentProxy } from 'unpdf';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

// 加载根目录下的.env到process.env
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

if (!process.env.DEEPSEEK_API_KEY) {
  throw new Error('未设置环境变量 DEEPSEEK_API_KEY，请先执行: export DEEPSEEK_API_KEY=你的key');
}
if (!process.env.BIGMODEL_EMBEDDING_API_URL || !process.env.BIGMODEL_EMBEDDING_API_KEY) {
  throw new Error('未设置环境变量 BIGMODEL_EMBEDDING_API_URL 或 BIGMODEL_EMBEDDING_API_KEY，请先执行: export BIGMODEL_EMBEDDING_API_URL=你的url; export BIGMODEL_EMBEDDING_API_KEY=你的key');
}

// ======================================================================
// 零、模型初始化
// ======================================================================
// 生成模型：DeepSeek（用于"拼装 + 生成"阶段）
const llm = new ChatOpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  modelName: 'deepseek-flash',
  temperature: 0,
  configuration: { baseURL: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com' },
  timeout: 120_000,
  maxRetries: 2,
});

// ======================================================================
// 一、Embedding：调用智谱 BigModel API 文本向量化
//
// 为什么封装成方法：
//   - 阶段一（建索引）和阶段二（查问题）都要把文本向量化
//   - 保证"建库和查询用同一个嵌入模型"这一硬性约束
// ======================================================================
async function embedTexts(texts) {
  // 智谱 embedding-3：单次请求输入上限 16 条，超过需分批
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
      body: JSON.stringify({
        input: batch,
        model: 'embedding-3',
        encoding_format: 'float',
      }),
    });

    if (!res.ok) {
      throw new Error(`Embedding API 调用失败: HTTP ${res.status} - ${await res.text()}`);
    }

    const data = await res.json();
    // data.data 是按 index 排列的向量数组
    const vectors = data.data
      .sort((a, b) => a.index - b.index)
      .map((item) => item.embedding);
    allVectors.push(...vectors);
  }

  return allVectors;
}

// 单条文本向量化（步骤 5：提问向量化的简易封装）
async function embedText(text) {
  const [vec] = await embedTexts([text]);
  return vec;
}

// ======================================================================
// 二、向量检索：余弦相似度 + Top-K
// ======================================================================
// 计算两个向量的余弦相似度：a・b / (|a| * |b|)，返回 -1~1（越大越相似）
function cosineSimilarity(a, b) {
  if (a.length !== b.length) {
    throw new Error('向量维度不一致，请确认建库和查询使用了同一个嵌入模型');
  }
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  // 防止除零
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * 在向量库中检索与 queryVector 最相似的 Top-K 个 chunk
 * @param {Array<{content:string, vector:number[], metadata:object}>} store 内存向量库
 * @param {number[]} queryVector 查询向量
 * @param {number} topK 返回条数
 * @returns 按相似度降序排列的结果
 */
function searchTopK(store, queryVector, topK = 3) {
  return store
    .map((item, index) => ({
      index,
      content: item.content,
      metadata: item.metadata,
      score: cosineSimilarity(queryVector, item.vector),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

// ======================================================================
// 三、文档加载：读取任意格式为纯文本/Markdown
//   - 纯文本格式（.md/.txt/.json/.csv/.html/.js 等）：直接读文件
//   - PDF：用 unpdf（pdfjs）提取文本；docx/xlsx 等：用 markitdown-ts 转 Markdown
// ======================================================================
async function loadDocument(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const supportedText = ['.md', '.markdown', '.txt', '.json', '.csv', '.html', '.js', '.ts', '.py'];

  // 纯文本格式：直接读文件
  if (supportedText.includes(ext)) {
    return fs.readFileSync(filePath, 'utf-8');
  }

  // PDF：用 unpdf（基于 pdfjs）稳定提取文本
  //（markitdown-ts 内置 PDF 解析器不完整，会返回原始二进制字节导致乱码）
  if (ext === '.pdf') {
    try {
      const buffer = fs.readFileSync(filePath);
      const pdf = await getDocumentProxy(new Uint8Array(buffer));
      const { text } = await extractText(pdf, { mergePages: true });
      return text;
    } catch (err) {
      throw new Error(`PDF 解析失败: ${err.message}`);
    }
  }

  // 其他复杂格式（Word/Excel 等）：用 markitdown-ts 转为 Markdown
  try {
    const markitdown = new MarkItDown();
    const result = await markitdown.convert(filePath, { file_extension: ext });
    return result?.markdown ?? '';
  } catch (err) {
    throw new Error(`转换为 "${ext}" 失败: ${err.message}，可尝试先手工转为 Markdown 文本。`);
  }
}

// ======================================================================
// 四、RAG 主流程
// ======================================================================
async function main() {
  console.log('═'.repeat(60));
  console.log('极简 RAG：用 智谱 embedding-3 + DeepSeek 实现知识问答');
  console.log('═'.repeat(60));

  // ---------- 阶段一：数据准备（索引构建） ----------
  // 1. 文档加载：优先读取同目录演示文档，不存在则用内置语料兜底
  console.log('\n📄 [1/4] 加载文档...');
  const demoDocPath = path.resolve(__dirname, './demo-doc.pdf');
  let sourceDoc = '';
  if (fs.existsSync(demoDocPath)) {
    sourceDoc = await loadDocument(demoDocPath);
    console.log(`  ✅ 已从 ${path.basename(demoDocPath)} 加载文档`);
  } else {
  sourceDoc = `
# JavaScript 异步编程

## 回调函数（Callback）
回调函数是 JavaScript 中最基础的异步处理方式，将函数作为参数传给另一个函数，在异步操作完成后被调用。
回调地狱问题：多层嵌套的回调使代码难以阅读和维护。

## Promise
Promise 是 ES6 引入的异步编程解决方案，解决回调地狱问题。
一个 Promise 有三种状态：pending（进行中）、fulfilled（已成功）、rejected（已失败）。
状态一经改变，就不会再变。

## async/await
async/await 是 ES7 引入的语法糖，基于 Promise 实现，让异步代码看起来像同步代码。
async 函数返回一个 Promise。await 只能用在 async 函数内部。

## 事件循环（Event Loop）
JavaScript 是单线程语言，通过事件循环实现非阻塞的异步。
宏任务（macrotask）如 setTimeout、I/O；微任务（microtask）如 Promise.then。
事件循环每轮先执行一个宏任务，再清空所有微任务。

# Rust 内存安全

## 所有权（Ownership）
Rust 的核心特性是所有权系统，确保内存安全而无需垃圾回收。
每个值有且仅有一个所有者，所有权可以转移（move）或借用（borrow）。

## 借用与引用（Borrowing）
借用用 & 符号表示，允许读取数据但不拥有数据。
可变借用 &mut 同一时间只能存在一个，避免数据竞争。

## 生命周期（Lifetime）
生命周期是 Rust 编译器用来确保引用不会悬空的机制。
使用  'a 这样的标注来关联引用之间的生命周期关系。
`;
    console.log('  ✅ 内置演示文档已加载（未找到 demo-doc.pdf）');
  }
  console.log(`  文档共 ${sourceDoc.length} 字符`);

  // 2. 文本分片：使用 langchain RecursiveCharacterTextSplitter（递归字符分割）
  //    - chunkSize: 目标块大小（token/字符）
  //    - chunkOverlap: 相邻块重叠区，防止语义断裂
  console.log('\n✂️  [2/4] 文本分片...');
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: 120, // 每个 chunk 最大字符数
    chunkOverlap: 20, // 相邻块重叠区，防止语义断裂
    separators: ['\n\n', '\n', '。', '！', '？', ' ', ''],
  });
  const chunks = await splitter.splitText(sourceDoc);
  console.log(`  ✅ 共分成 ${chunks.length} 个 chunk（chunkSize=120, overlap=20）`);

  // 3. Embedding 向量化
  console.log('\n🧬 [3/4] Embedding 向量化...');
  const chunkVectors = await embedTexts(chunks);
  console.log(`  ✅ 生成 ${chunkVectors.length} 个向量，维度=${chunkVectors[0]?.length ?? 0}`);

  // 4. 向量存储：内存数组（每个元素含原文 + 向量 + 元数据，便于检索和溯源）
  const store = chunks.map((content, i) => ({
    content,
    vector: chunkVectors[i],
    metadata: { chunkIndex: i, source: path.basename(demoDocPath) },
  }));
  console.log(`  ✅ 向量库就绪，共 ${store.length} 条记录`);

  // ---------- 阶段二：查询与生成 ----------
  // 5-7. 连续提问验证 RAG 效果
  const questions = [
    'Rust 的所有权是什么？',
    '什么是 Promise？它解决了什么问题？',
  ];

  for (const question of questions) {
    console.log('\n' + '═'.repeat(60));
    console.log(`❓ 用户问题: ${question}`);
    console.log('═'.repeat(60));

    // 5. 提问向量化（必须用与建库相同的 embedding-3）
    const queryVector = await embedText(question);

    // 6. 相似度检索：Top-K
    const topK = 3;
    const results = searchTopK(store, queryVector, topK);
    console.log(`\n🔍 [检索] 命中最相似的 ${topK} 个 chunk:`);
    results.forEach((r, i) => {
      console.log(`  [${i + 1}] 相似度=${r.score.toFixed(4)} | ${r.content.slice(0, 60).replace(/\n/g, ' ')}...`);
    });

    // 7. 拼装 + 生成：把检索片段注入 Prompt，DeepSeek 基于上下文生成答案
    const context = results
      .map((r, i) => `[资料${i + 1}]\n${r.content}`)
      .join('\n\n');

    const prompt = [
      {
        role: 'system',
        content:
          '你是一个知识问答助手。请只根据提供的上下文资料回答问题。' +
          '如果资料中没有相关信息，请回答"根据提供的资料无法回答"。' +
          '回答要简洁、准确。',
      },
      {
        role: 'user',
        content: `【上下文资料】\n${context}\n\n【问题】\n${question}`,
      },
    ];

    console.log('\n🤖 [生成] 正在调用 DeepSeek 生成答案...');
    const response = await llm.invoke(prompt);
    console.log(`\n💡 答案: ${response.content.trim()}\n`);
  }
}

// 统一捕获主流程异常
main().catch((err) => {
  console.error('\n❌ RAG 执行出错:', err.message);
  process.exit(1);
});