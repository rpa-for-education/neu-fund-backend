// search.js
import { pipeline } from "@xenova/transformers";
import { getDb } from "./db.js";

const MAX_TOPK = parseInt(process.env.MAX_TOPK || "30", 10);
const VECTOR_INDEX_NAME = process.env.VECTOR_INDEX_FUND || "vector_index_fund";
const VECTOR_PATH = process.env.VECTOR_PATH || "vector";


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
 * @param {string} text
 * @returns {Promise<number[]>}
 */
async function embed(text) {
  if (!embedder) await initEmbedding();
  const out = await embedder(text, { pooling: "mean", normalize: true });
  return Array.from(out.data);
}

/**
 * Vector search trên collection 'fund'
 * @param {string} question
 * @param {number} topk
 * @returns {Promise<Array<{_id, score, ...payload}>>}
 */
export async function fundVectorSearch(question, topk = 5) {
  const db = await getDb();
  const col = db.collection(process.env.MONGO_COLLECTION || "fund");

  const queryVector = await embed(question);
  const safeTopK = Math.min(Number(topk) || 5, MAX_TOPK);

  console.log(`🔎 Querying with vector length: ${queryVector.length}, topK=${safeTopK}`);

  const pipelineAgg = [
    {
      $vectorSearch: {
        index: VECTOR_INDEX_NAME,
        path: VECTOR_PATH,
        queryVector,
        numCandidates: safeTopK * 10, // tốt hơn fix cứng 200
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
  ];

  const items = await col.aggregate(pipelineAgg).toArray();

  if (!items || items.length === 0) {
    console.warn("⚠️ No results found for query:", question);
    return [];
  }

  return items.map(d => ({
    ...d,
    _id: String(d._id),
  }));
}
