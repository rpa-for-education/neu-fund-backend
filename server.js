// server.js
import "dotenv/config";
import { MongoClient } from "mongodb";
import { QdrantClient } from "@qdrant/js-client-rest";
import { pipeline } from "@xenova/transformers";
import { callLLM } from "./llm.js";

/* ===================== Env & constants ===================== */
const MONGO_URI = process.env.MONGO_URI;
const MONGO_DB = process.env.MONGO_DB || "fitneu";
const FUNDLOGS_COLLECTION = "fundlogs";

const QDRANT_URL = process.env.QDRANT_URL;
const QDRANT_API_KEY = process.env.QDRANT_API_KEY;
const QDRANT_COLLECTION = process.env.QDRANT_COLLECTION || "fund";

const EMBEDDING_MODEL =
  process.env.EMBEDDING_MODEL || "all-MiniLM-L6-v2";

if (!MONGO_URI) throw new Error("❌ Missing MONGO_URI in .env");
if (!QDRANT_URL || !QDRANT_API_KEY)
  throw new Error("❌ Missing QDRANT_URL or QDRANT_API_KEY in .env");

/* ===================== Mongo ===================== */
let mongoClient, db, fundlogs;
async function connectMongo() {
  if (!mongoClient) {
    mongoClient = new MongoClient(MONGO_URI);
    await mongoClient.connect();
    db = mongoClient.db(MONGO_DB);
    fundlogs = db.collection(FUNDLOGS_COLLECTION);
    console.log(`✅ MongoDB connected: ${MONGO_DB}.${FUNDLOGS_COLLECTION}`);
  }
  return fundlogs;
}

/* ===================== Qdrant ===================== */
const qdrant = new QdrantClient({
  url: QDRANT_URL,
  apiKey: QDRANT_API_KEY,
});

/* ===================== Embeddings ===================== */
let embedder = null;
async function getEmbedder() {
  if (!embedder) {
    const modelName = EMBEDDING_MODEL.startsWith("Xenova/")
      ? EMBEDDING_MODEL
      : `Xenova/${EMBEDDING_MODEL}`;
    console.log(`🔗 Loading embedding model (${modelName})...`);
    embedder = await pipeline("feature-extraction", modelName);
  }
  return embedder;
}
async function embedText(text) {
  const e = await getEmbedder();
  const out = await e(text, { pooling: "mean", normalize: true });
  return Array.from(out.data);
}

/* ===================== Helpers ===================== */
const pick = (v) => v ?? "";
function stringifyArray(v) {
  if (Array.isArray(v)) return v.filter(Boolean).join(", ");
  return typeof v === "string" ? v : "";
}
function summarizeFundPayload(p = {}) {
  const title = pick(p["OPPORTUNITY TITLE"]) || pick(p.title) || pick(p.name) || "Không có tiêu đề";
  const agency = pick(p["AGENCY NAME"]) || pick(p.agency) || "";
  const category = pick(p["FUNDING CATEGORY EXPLANATION"]) || pick(p.category) || "";
  const assist = stringifyArray(p["ASSISTANCE LISTINGS"]) || "";
  const eligible = stringifyArray(p["ELIGIBLE APPLICANTS"]) || "";
  const desc = pick(p["FUNDING DESCRIPTION"]) || pick(p.description) || "";
  const url = pick(p.url) || pick(p.link) || "";

  let lines = [`• ${title}`];
  if (agency) lines.push(`  - Cơ quan: ${agency}`);
  if (category) lines.push(`  - Nhóm: ${category}`);
  if (assist) lines.push(`  - Assistance: ${assist}`);
  if (eligible) lines.push(`  - Đối tượng: ${eligible}`);
  if (desc) lines.push(`  - Mô tả: ${desc.slice(0, 400)}${desc.length > 400 ? "..." : ""}`);
  if (url) lines.push(`  - Link: ${url}`);
  return lines.join("\n");
}
function buildPrompt(question, hits = []) {
  const header =
    "Bạn là trợ lý hỗ trợ tìm kiếm quỹ tài trợ. Dựa trên danh sách cơ hội bên dưới, hãy trả lời ngắn gọn, đưa ra 3–5 cơ hội phù hợp nhất, kèm lý do khớp và lưu ý về eligibility.\n";
  const ctx =
    hits.length > 0
      ? hits.map(
          (h, i) =>
            `Kết quả #${i + 1} (score=${h.score?.toFixed?.(4) ?? h.score}):\n${summarizeFundPayload(h.payload)}`
        ).join("\n\n")
      : "Không tìm thấy kết quả nào trong cơ sở dữ liệu.";
  return `${header}\nCâu hỏi người dùng: "${question}"\n\nNgữ cảnh:\n${ctx}\n\nYêu cầu: Trả lời bằng TIẾNG VIỆT, liệt kê gọn, có tiêu đề từng cơ hội, nêu lý do phù hợp, thêm link nếu có.`;
}

/* ===================== Vercel Handler ===================== */
export default async function handler(req, res) {
  if (req.method === "GET") {
    return res.json({
      status: "ok",
      mongo_db: MONGO_DB,
      qdrant_url: QDRANT_URL,
      collection: QDRANT_COLLECTION,
      embedding_model: EMBEDDING_MODEL,
      time: new Date().toISOString(),
    });
  }

  if (req.method === "POST") {
    const startedAt = new Date();
    try {
      const { question, topk = 5, withLLM = true, model_id = "qwen-max" } = req.body || {};
      if (!question?.trim()) {
        return res.status(400).json({ error: "Thiếu 'question'" });
      }

      const fundlogs = await connectMongo();
      const k = Math.max(1, Math.min(parseInt(topk, 10) || 5, 20));

      // 1) Embed query
      const queryVector = await embedText(question);

      // 2) Qdrant search
      const results = await qdrant.search(QDRANT_COLLECTION, {
        vector: queryVector,
        limit: k,
        with_payload: true,
        with_vector: false,
      });

      const hits = (results || []).map((r) => ({
        id: r.id,
        score: r.score,
        payload: r.payload || {},
      }));

      // 3) Optional LLM
      let answer = null, provider = null, resolvedModel = null;
      if (withLLM) {
        const prompt = buildPrompt(question, hits);
        const llmRes = await callLLM(prompt, model_id);
        provider = llmRes.provider;
        resolvedModel = llmRes.model;
        answer = llmRes.answer;
      }

      // 4) Log
      const endedAt = new Date();
      try {
        await fundlogs.insertOne({
          question,
          asked_at: startedAt,
          answer,
          answered_at: endedAt,
          withLLM: !!withLLM,
          model_id,
          provider,
          model: resolvedModel,
          topk: k,
          hits: hits.slice(0, 5),
        });
      } catch (e) {
        console.error("⚠️ Cannot write fundlogs:", e.message);
      }

      return res.json({
        model_id,
        provider,
        model: resolvedModel,
        answer,
        hits,
        meta: {
          asked_at: startedAt.toISOString(),
          answered_at: endedAt.toISOString(),
          topk: k,
        },
      });
    } catch (err) {
      console.error("❌ /api/ask error:", err?.response?.data || err.message);
      return res.status(500).json({
        error: err.message || "Internal error",
        detail: err?.response?.data,
      });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}
