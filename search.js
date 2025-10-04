// ✅ Cho phép cache model trong thư mục ghi được của Vercel
process.env.TRANSFORMERS_CACHE = "/tmp";
process.env.HF_HUB_CACHE = "/tmp";

import { pipeline } from "@xenova/transformers";
import { getDb } from "./db.js";
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import fetch from "node-fetch";
import pdfParse from "pdf-parse/lib/pdf-parse.js";
import mammoth from "mammoth";

const MAX_TOPK = parseInt(process.env.MAX_TOPK || "30", 10);
const VECTOR_INDEX_NAME = process.env.VECTOR_INDEX_FUND || "vector_index_fund";
const VECTOR_PATH = process.env.VECTOR_PATH || "vector";
const MONGO_COLLECTION = process.env.MONGO_COLLECTION || "fund";

let embedder = null;

/**
 * Khởi tạo mô hình embedding
 */
export async function initEmbedding() {
  if (!embedder) {
    const model = process.env.EMBEDDING_MODEL || "Xenova/paraphrase-multilingual-mpnet-base-v2";
    const modelName = model.startsWith("Xenova/") ? model : `Xenova/${model}`;
    console.log(`⏳ Loading JS embedding model: ${modelName}`);
    embedder = await pipeline("feature-extraction", modelName);
    console.log("✅ Embedder ready");
  }
  return true;
}

/**
 * Sinh vector embedding từ text
 */
async function embed(text) {
  if (!embedder) await initEmbedding();
  const out = await embedder(text, { pooling: "mean", normalize: true });
  return Array.from(out.data);
}

export async function embedText(text) {
  return embed(text);
}

/**
 * Đọc nội dung từ file hoặc link tải về
 * - Hỗ trợ PDF, DOCX, TXT, và URL
 */
export async function readFileContent(inputPathOrUrl) {
  let filePath = inputPathOrUrl;
  let buffer;

  // Nếu là URL thì tải về /tmp
  if (inputPathOrUrl.startsWith("http://") || inputPathOrUrl.startsWith("https://")) {
    const response = await fetch(inputPathOrUrl);
    if (!response.ok) throw new Error(`❌ Không tải được file từ URL: ${inputPathOrUrl}`);
    buffer = Buffer.from(await response.arrayBuffer());
    const filename = `/tmp/${Date.now()}_${path.basename(new URL(inputPathOrUrl).pathname)}`;
    await fs.writeFile(filename, buffer);
    filePath = filename;
  }

  const ext = path.extname(filePath).toLowerCase();

  if (ext === ".pdf") {
    const dataBuffer = buffer || (await fs.readFile(filePath));
    const pdfData = await pdfParse(dataBuffer);
    return pdfData.text.trim();
  }

  if (ext === ".docx") {
    const dataBuffer = buffer || (await fs.readFile(filePath));
    const result = await mammoth.extractRawText({ buffer: dataBuffer });
    return result.value.trim();
  }

  // Mặc định đọc text
  const text = await fs.readFile(filePath, "utf8");
  return text.trim();
}

/**
 * Upload file → đọc nội dung → nhúng → lưu MongoDB
 */
export async function uploadAndIndexFile(filePathOrUrl) {
  const db = await getDb();
  const col = db.collection(MONGO_COLLECTION);

  // ✅ Đọc nội dung
  const content = await readFileContent(filePathOrUrl);
  if (!content || !content.trim()) {
    throw new Error("❌ File rỗng hoặc không đọc được nội dung.");
  }

  // ✅ Sinh vector
  const vector = await embed(content);

  // ✅ Lưu vào Mongo
  const doc = {
    text: content.slice(0, 5000), // Giới hạn nội dung lưu (tối đa 5k ký tự)
    [VECTOR_PATH]: vector,
    source: filePathOrUrl,
    createdAt: new Date(),
  };

  const result = await col.insertOne(doc);
  console.log(`✅ File đã được index vào MongoDB với _id=${result.insertedId}`);
  return result;
}

/**
 * Vector search trên collection 'fund'
 */
export async function fundVectorSearch(query, topk = 5) {
  const db = await getDb();
  const col = db.collection(MONGO_COLLECTION);

  const queryVector = await embed(query);
  const safeTopK = Math.min(Number(topk) || 5, MAX_TOPK);

  console.log(`🔎 Querying with vector length: ${queryVector.length}, topK=${safeTopK}`);

  const pipelineAgg = [
    {
      $vectorSearch: {
        index: VECTOR_INDEX_NAME,
        path: VECTOR_PATH,
        queryVector,
        numCandidates: safeTopK * 10,
        limit: safeTopK,
        similarity: "cosine",
      },
    },
    {
      $project: {
        [VECTOR_PATH]: 0,
        score: { $meta: "vectorSearchScore" },
      },
    },
  ];

  const items = await col.aggregate(pipelineAgg).toArray();

  if (!items || items.length === 0) {
    console.warn("⚠️ No results found for query:", query);
    return [];
  }

  return items.map(d => ({
    ...d,
    _id: String(d._id),
  }));
}
