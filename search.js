// Kết hợp logic tìm kiếm (conference/journal), đọc file, embedding (local Xenova only)

process.env.TRANSFORMERS_CACHE = process.env.TRANSFORMERS_CACHE || "/tmp/transformers_cache";
process.env.HF_HUB_CACHE = process.env.HF_HUB_CACHE || "/tmp/hf_hub_cache";
process.env.HF_HOME = process.env.HF_HOME || "/tmp/hf_home";
process.env.XDG_CACHE_HOME = process.env.XDG_CACHE_HOME || "/tmp";
process.env.TMPDIR = process.env.TMPDIR || "/tmp";
process.env.HOME = process.env.HOME || "/tmp";

import { MongoClient } from "mongodb";
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import fetch from "node-fetch";
import * as docx from "docx-parser";
import mammoth from "mammoth";
import { getDb } from "./db.js";

const client = new MongoClient(process.env.MONGODB_URI);
const dbName = process.env.MONGODB_DB || "fitneu";

// Giới hạn topK (có thể cấu hình qua .env)
const MAX_TOPK = parseInt(process.env.MAX_TOPK || "30", 10);

// Vector collection / fields
const VECTOR_INDEX_NAME = process.env.VECTOR_INDEX_FUND || "vector_index_fund";
const VECTOR_PATH = process.env.VECTOR_PATH || "vector";
const MONGO_COLLECTION = process.env.MONGO_COLLECTION || "fund";

const UPLOADED_FILES_INDEX = process.env.UPLOADED_FILES_INDEX || "vector_index_uploaded_files";

let embedder = null;

/**
 * Initialize local Xenova embedder only.
 * If it fails, we throw — you requested no remote fallback.
 */
export async function initEmbedding() {
  if (embedder) return true;

  const model = process.env.EMBEDDING_MODEL || "Xenova/paraphrase-multilingual-mpnet-base-v2";
  const modelName = model.startsWith("Xenova/") ? model : `Xenova/${model}`;

  try {
    console.log(`⏳ Attempting to load JS embedding model: ${modelName}`);

    // dynamic import
    const transformers = await import("@xenova/transformers");
    try {
      if (transformers && transformers.env) {
        transformers.env.cacheDir = process.env.TRANSFORMERS_CACHE || "/tmp/transformers_cache";
        transformers.env.useFSCache = true;
      }
    } catch (ee) {
      // ignore
    }

    const { pipeline } = transformers;
    embedder = await pipeline("feature-extraction", modelName);
    console.log("✅ Embedder ready (local Xenova)");
    return true;
  } catch (err) {
    console.error("❌ initEmbedding failed (local only):", err);
    // Since we do not want remote fallback, throw here so caller knows embedding not available
    throw new Error(`Failed to initialize local embedder: ${err?.message || err}`);
  }
}

/**
 * Sinh vector embedding từ text — chỉ dùng local embedder.
 */
async function embed(text) {
  if (!embedder) {
    await initEmbedding(); // may throw
  }

  try {
    const out = await embedder(text, { pooling: "mean", normalize: true });
    return Array.from(out.data);
  } catch (e) {
    console.error("❌ Local embedder failed during embed():", e);
    // do not fallback to remote — throw so caller can handle
    throw e;
  }
}

export async function embedText(text) {
  if (!text || !String(text).trim()) return [];
  return embed(text);
}

/**
 * Đọc nội dung từ file path hoặc URL
 * Hỗ trợ: .pdf, .docx, .txt
 */
export async function readFileContent(inputPathOrUrl) {
  // If it's a URL -> fetch into /tmp
  let tmpPath = null;
  let buffer = null;

  if (typeof inputPathOrUrl === "string" && (inputPathOrUrl.startsWith("http://") || inputPathOrUrl.startsWith("https://"))) {
    const resp = await fetch(inputPathOrUrl);
    if (!resp.ok) {
      throw new Error(`Failed to fetch ${inputPathOrUrl}: ${resp.status}`);
    }
    const ab = await resp.arrayBuffer();
    buffer = Buffer.from(ab);
    tmpPath = path.join("/tmp", `${Date.now()}_${path.basename(new URL(inputPathOrUrl).pathname)}`);
    await fs.writeFile(tmpPath, buffer);
  }

  const filePath = tmpPath || inputPathOrUrl;
  const ext = (path.extname(String(filePath)) || "").toLowerCase();

  if (ext === ".pdf") {
    const dataBuffer = buffer || await fs.readFile(filePath);
    try {
      const { default: pdfParse } = await import("pdf-parse");
      const pdf = await pdfParse(dataBuffer);
      return pdf.text || "";
    } catch (e) {
      console.error("❌ pdfParse error in readFileContent:", e);
      throw e;
    }
  } else if (ext === ".docx") {
    const dataBuffer = buffer || await fs.readFile(filePath);
    const { value } = await mammoth.extractRawText({ buffer: dataBuffer });
    return value || "";
  } else {
    const txt = await fs.readFile(filePath, "utf8");
    return txt || "";
  }
}

/**
 * Đọc nội dung .docx từ URL (dùng docx-parser fallback)
 */
export async function readDocxFromUrl(url) {
  try {
    console.log(`📄 Đang tải nội dung file từ: ${url}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`❌ Lỗi tải file: ${res.statusText}`);
    const arrayBuffer = await res.arrayBuffer();

    const tempPath = `/tmp/${Date.now()}_temp.docx`;
    await fs.writeFile(tempPath, Buffer.from(arrayBuffer));

    const text = await new Promise((resolve, reject) => {
      docx.parseDocx(tempPath, (data) => {
        if (!data) reject("❌ Không thể đọc nội dung file");
        else resolve(data);
      });
    });

    console.log("✅ Đọc file thành công, độ dài:", text.length);
    return text;
  } catch (err) {
    console.error("⚠️ Lỗi khi đọc file docx:", err);
    return "";
  }
}

/**
 * Upload filePathOrUrl -> đọc -> embed -> lưu Mongo
 * - filePathOrUrl có thể là đường dẫn local hoặc URL (http/https)
 */
export async function uploadAndIndexFile(filePathOrUrl) {
  const db = await getDb();
  const col = db.collection(MONGO_COLLECTION);

  const content = await readFileContent(filePathOrUrl);
  if (!content || !content.trim()) {
    throw new Error("❌ File rỗng hoặc không đọc được nội dung.");
  }

  const vector = await embed(content);

  const doc = {
    text: content.slice(0, 20000), // lưu giới hạn
    [VECTOR_PATH]: vector,
    source: filePathOrUrl,
    uploadedAt: new Date(),
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

  return items.map((d) => ({
    ...d,
    _id: String(d._id),
  }));
}

// --- search for conferences & journals (alias) ---
export async function search({ question, topk = 5 }) {
  await client.connect();
  const dbCli = client.db(dbName);

  const queryVector = await embed(question);
  const safeTopK = Math.min(Number(topk) || 5, MAX_TOPK);

  const confResults = await dbCli.collection("conference").aggregate([
    {
      $vectorSearch: {
        index: "vector_index_conference",
        path: "vector",
        queryVector,
        numCandidates: 100,
        limit: safeTopK,
        similarity: "cosine",
      },
    },
    {
      $project: {
        _id: 0,
        vector: 0,
        created_time: 0,
        modified_time: 0,
        score: { $meta: "vectorSearchScore" },
      },
    },
  ]).toArray();

  const journalResults = await dbCli.collection("journal").aggregate([
    {
      $vectorSearch: {
        index: "vector_index_journal",
        path: "vector",
        queryVector,
        numCandidates: 100,
        limit: safeTopK,
        similarity: "cosine",
      },
    },
    {
      $project: {
        _id: 0,
        vector: 0,
        created_time: 0,
        modified_time: 0,
        score: { $meta: "vectorSearchScore" },
      },
    },
  ]).toArray();

  return {
    conference: confResults,
    journal: journalResults,
  };
}

export async function conferenceVectorSearch(question, topk = 5) {
  const result = await search({ question, topk });
  return result.conference;
}

export async function journalVectorSearch(question, topk = 5) {
  const result = await search({ question, topk });
  return result.journal;
}
