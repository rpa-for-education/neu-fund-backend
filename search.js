process.env.TRANSFORMERS_CACHE = process.env.TRANSFORMERS_CACHE || "/tmp/transformers_cache";
process.env.HF_HUB_CACHE = process.env.HF_HUB_CACHE || "/tmp/hf_hub_cache";
process.env.HF_HOME = process.env.HF_HOME || "/tmp/hf_home";
process.env.XDG_CACHE_HOME = process.env.XDG_CACHE_HOME || "/tmp";
process.env.TMPDIR = process.env.TMPDIR || "/tmp";
process.env.HOME = process.env.HOME || "/tmp";

import fs from "fs/promises";
import path from "path";
import fetch from "node-fetch";
import * as docx from "docx-parser";
import mammoth from "mammoth";
import { getDb } from "./db.js";

// Giới hạn topK (có thể cấu hình qua .env)
const MAX_TOPK = parseInt(process.env.MAX_TOPK || "30", 10);

// Vector collection / fields
const VECTOR_INDEX_NAME = process.env.VECTOR_INDEX_FUND || "vector_index_fund";
const VECTOR_PATH = process.env.VECTOR_PATH || "vector";
const MONGO_COLLECTION = process.env.MONGO_COLLECTION || "fund";

const UPLOADED_FILES_INDEX = process.env.UPLOADED_FILES_INDEX || "vector_index_uploaded_files";

let embedder = null;
let embeddingInitPromise = null;

/**
 * Initialize local Xenova embedder (local only).
 * No remote embedding fallback is allowed.
 */
export async function initEmbedding() {
  if (embedder) return true;

  if (!embeddingInitPromise) {
    embeddingInitPromise = (async () => {
      const model =
        process.env.EMBEDDING_MODEL ||
        "Xenova/paraphrase-multilingual-mpnet-base-v2";

      const modelName = model.startsWith("Xenova/")
        ? model
        : `Xenova/${model}`;

      console.log(`⏳ Loading embedding model: ${modelName}`);

      const transformers = await import("@xenova/transformers");

      if (transformers?.env) {
        transformers.env.cacheDir =
          process.env.TRANSFORMERS_CACHE || "/tmp/transformers_cache";
        transformers.env.useFSCache = true;
      }

      const { pipeline } = transformers;
      embedder = await pipeline("feature-extraction", modelName);

      console.log("✅ Embedder ready (local Xenova)");
    })();
  }

  await embeddingInitPromise;
  return true;
}


/**
 * Sinh vector embedding từ text — chỉ dùng local embedder.
 */
async function embed(text) {
  if (!embedder) {
    await initEmbedding();
  }

  if (!embedder) {
    throw new Error("Embedder failed to initialize");
  }

  const out = await embedder(text, {
    pooling: "mean",
    normalize: true,
  });

  return Array.from(out.data);
}



export async function embedText(text) {
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



/*
export async function fundVectorSearch(question, topk = 5) {
  return await search({ question, topk });
}
*/


// Thêm hàm tìm kiếm vector file upload
const FILES_COLLECTION = process.env.FILES_COLLECTION || "uploaded_files";
const VECTOR_INDEX_UPLOADED_FILES = "vector_index_uploaded_files";
/*
export async function uploadedFilesVectorSearch(query, topk = 5) {
  const db = await getDb();
  const col = db.collection(FILES_COLLECTION);
  const queryVector = await embedText(query);
  const safeTopK = Math.min(Number(topk) || 5, MAX_TOPK);

  const pipeline = [
    {
      $vectorSearch: {
        index: VECTOR_INDEX_UPLOADED_FILES,
        path: "vector",
        queryVector,
        numCandidates: safeTopK * 10,
        limit: safeTopK,
        similarity: "cosine",
      },
    },
    {
      $project: {
        vector: 0,
        name: 1,
        text: 1,
        url: 1,
        uploadedAt: 1,
        score: { $meta: "vectorSearchScore" },
      },
    },
  ];
  const results = await col.aggregate(pipeline).toArray();
  return results.map(d => ({
    ...d,
    _id: String(d._id)
  }));
}
*/

export async function fundVectorSearchByVector(queryVector, topk = 5) {
  const db = await getDb();
  const safeTopK = Math.min(Number(topk) || 5, MAX_TOPK);

  return await db.collection(MONGO_COLLECTION).aggregate([
    {
      $vectorSearch: {
        index: VECTOR_INDEX_NAME,
        path: VECTOR_PATH,
        queryVector,
        numCandidates: Math.max(50, safeTopK * 10),
        limit: safeTopK,
        similarity: "cosine",
      },
    },
    {
      $project: {
        vector: 0,
        score: { $meta: "vectorSearchScore" },
      },
    },
  ]).toArray();
}

export async function uploadedFilesVectorSearchByVector(queryVector, topk = 5) {
  const db = await getDb();
  const col = db.collection(FILES_COLLECTION);
  const safeTopK = Math.min(Number(topk) || 5, MAX_TOPK);

  const pipeline = [
    {
      $vectorSearch: {
        index: VECTOR_INDEX_UPLOADED_FILES,
        path: "vector",
        queryVector,
        numCandidates: safeTopK * 10,
        limit: safeTopK,
        similarity: "cosine",
      },
    },
    {
      $project: {
        vector: 0,
        name: 1,
        text: 1,
        url: 1,
        uploadedAt: 1,
        score: { $meta: "vectorSearchScore" },
      },
    },
  ];

  const results = await col.aggregate(pipeline).toArray();

  return results.map(d => ({
    ...d,
    _id: String(d._id),
  }));
}

