import { MongoClient } from "mongodb";

const MONGO_URI = process.env.MONGO_URI;
const MONGO_DB = process.env.MONGO_DB || "fitneu";
const VECTOR_INDEX_NAME = process.env.VECTOR_INDEX_FUND || "vector_index_fund";
const VECTOR_PATH = process.env.VECTOR_PATH || "vector";
const MAX_TOPK = parseInt(process.env.MAX_TOPK || "30", 10);

let mongoClient = null;
let db = null;
export async function getDb() {
  if (!db) {
    if (!mongoClient) {
      mongoClient = new MongoClient(MONGO_URI, {
        useUnifiedTopology: true,
      });
      await mongoClient.connect();
    }
    db = mongoClient.db(MONGO_DB);
  }
  return db;
}

// EMBEDDING SINGLETON
let embedder = null;
let embeddingInitialized = false;
export async function initEmbedding() {
  if (embedder && embeddingInitialized) return true;
  const model = process.env.EMBEDDING_MODEL || "Xenova/paraphrase-multilingual-mpnet-base-v2";
  const modelName = model.startsWith("Xenova/") ? model : `Xenova/${model}`;
  try {
    const transformers = await import("@xenova/transformers");
    if (transformers && transformers.env) {
      transformers.env.cacheDir = process.env.TRANSFORMERS_CACHE || "/tmp/transformers_cache";
      transformers.env.useFSCache = true;
    }
    const { pipeline } = transformers;
    embedder = await pipeline("feature-extraction", modelName);
    embeddingInitialized = true;
    console.log("✅ Embedder ready (local Xenova)");
    return true;
  } catch (err) {
    console.error("❌ initEmbedding failed (local only):", err);
    throw new Error(`Failed to initialize local embedder: ${err?.message || err}`);
  }
}

async function embed(text) {
  if (!embedder || !embeddingInitialized) {
    await initEmbedding();
  }
  try {
    const out = await embedder(text, { pooling: "mean", normalize: true });
    return Array.from(out.data);
  } catch (e) {
    console.error("❌ Local embedder failed during embed():", e);
    throw e;
  }
}

export async function embedText(text) {
  if (!text || !String(text).trim()) return [];
  return embed(text);
}

export async function fundVectorSearch(query, topk = 5) {
  const db = await getDb();
  const col = db.collection(process.env.MONGO_COLLECTION || "fund");
  const queryVector = await embed(query);
  const safeTopK = Math.min(Number(topk) || 5, MAX_TOPK);
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
