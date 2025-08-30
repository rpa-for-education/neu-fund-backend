// server.js
import "dotenv/config";
import express from "express";
import cors from "cors";
import { ObjectId } from "mongodb";
import { pipeline } from "@xenova/transformers";
import { callLLM } from "./llm.js";
import { encode } from "gpt-tokenizer";
import { getDb } from "./db.js";
import { fundVectorSearch, initEmbedding } from "./search.js";

/* ===================== Env & constants ===================== */
const PORT = process.env.PORT || 4000;
const MONGO_COLLECTION = process.env.MONGO_COLLECTION || "fund";
const FUNDLOGS_COLLECTION = process.env.FUNDLOGS_COLLECTION || "fundlogs";
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || "Xenova/paraphrase-multilingual-mpnet-base-v2";

/* ===================== Express ===================== */
const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

/* ===================== Embeddings (lazy for health info) ===================== */
let embedder = null;
async function getEmbedder() {
  if (!embedder) {
    const modelName = EMBEDDING_MODEL.startsWith("Xenova/") ? EMBEDDING_MODEL : `Xenova/${EMBEDDING_MODEL}`;
    console.log(`🔗 Loading embedding model (${modelName})...`);
    embedder = await pipeline("feature-extraction", modelName);
    console.log("✅ Embedding model loaded");
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
const sArr = (v) => (Array.isArray(v) ? v.filter(Boolean).join(", ") : (typeof v === "string" ? v : ""));

function summarizeFundPayload(p = {}) {
  const title = pick(p["OPPORTUNITY TITLE"]) || pick(p.title) || "Không có tiêu đề";
  const agency = pick(p["AGENCY NAME"]) || pick(p["AGENCY CODE"]) || "";
  const category = pick(p["CATEGORY OF FUNDING ACTIVITY"]) || pick(p["FUNDING CATEGORY EXPLANATION"]) || "";
  const assist = sArr(p["ASSISTANCE LISTINGS"]);
  const eligible = sArr(p["ELIGIBLE APPLICANTS"]);
  const desc = pick(p["SYNOPSIS"]) || pick(p["SYNOPSIS DESCRIPTION"]) || pick(p["FUNDING DESCRIPTION"]) || "";
  const url = pick(p["OPPORTUNITY URL"]) || pick(p["LINK TO ADDITIONAL INFORMATION"]) || "";

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
  const header = "Bạn là trợ lý hỗ trợ tìm kiếm quỹ tài trợ. Dựa trên danh sách cơ hội bên dưới, hãy trả lời ngắn gọn, đưa ra 3–5 cơ hội phù hợp nhất, kèm lý do khớp và lưu ý về eligibility.\n";
  const ctx =
    hits.length > 0
      ? hits
          .map((h, i) => `Kết quả #${i + 1} (score=${(h.score ?? 0).toFixed?.(4) || h.score}):\n${summarizeFundPayload(h)}`)
          .join("\n\n")
      : "Không tìm thấy kết quả nào trong cơ sở dữ liệu.";

  return `${header}\nCâu hỏi người dùng: "${question}"\n\nNgữ cảnh:\n${ctx}\n\nYêu cầu: Trả lời bằng TIẾNG VIỆT, liệt kê gọn, có tiêu đề từng cơ hội, nêu lý do phù hợp (theo chủ đề/đối tượng/quốc gia), thêm link nếu có.`;
}

/* ===================== Routes ===================== */
app.get("/api/health", async (_req, res) => {
  try {
    const db = await getDb();
    await initEmbedding();
    res.json({
      status: "ok",
      db: "connected",
      collection: MONGO_COLLECTION,
      embedding_model: EMBEDDING_MODEL,
      time: new Date().toISOString(),
      counts: {
        fund: await db.collection(MONGO_COLLECTION).estimatedDocumentCount(),
      },
    });
  } catch (e) {
    res.status(500).json({ status: "error", error: e.message });
  }
});

/* ===================== Fund APIs ===================== */

// GET /api/fund/:id  → lấy 1 record từ MongoDB
app.get("/api/fund/:id", async (req, res) => {
  try {
    const db = await getDb();
    const { id } = req.params;
    const doc = await db.collection(MONGO_COLLECTION).findOne({ _id: new ObjectId(id) }, { projection: { vector: 0 } });
    if (!doc) return res.status(404).json({ error: "Không tìm thấy fund" });
    res.json({ ...doc, _id: String(doc._id) });
  } catch (err) {
    console.error("❌ /api/fund/:id error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/fund  → liệt kê danh sách fund (pagination) hoặc vector search nếu có q
app.get("/api/fund", async (req, res) => {
  try {
    const db = await getDb();
    const col = db.collection(MONGO_COLLECTION);
    const { page = 1, limit = 20, q } = req.query;
    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
    const skip = (pageNum - 1) * pageSize;

    if (q && q.trim()) {
      // Vector search
      const queryVector = await embedText(q);
      const pipelineAgg = [
        {
          $vectorSearch: {
            index: process.env.VECTOR_INDEX_FUND || "vector_index_fund",
            path: "vector",
            queryVector,
            numCandidates: 200,
            limit: pageSize,
            similarity: "cosine",
          },
        },
        { $project: { vector: 0, score: { $meta: "vectorSearchScore" } } },
      ];
      const items = await col.aggregate(pipelineAgg).toArray();
      return res.json({
        page: 1,
        limit: pageSize,
        total: items.length,
        items: items.map(d => ({ ...d, _id: String(d._id) })),
      });
    }

    // Listing thường
    const cursor = col.find({}, { projection: { vector: 0 } }).sort({ "POSTED DATE": -1 }).skip(skip).limit(pageSize);
    const [items, total] = await Promise.all([cursor.toArray(), col.estimatedDocumentCount()]);
    res.json({
      page: pageNum,
      limit: pageSize,
      total,
      items: items.map(d => ({ ...d, _id: String(d._id) })),
    });
  } catch (err) {
    console.error("❌ /api/fund error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ===================== Agent API ===================== */
app.post("/api/agent", async (req, res) => {
  const startedAt = Date.now();
  try {
    const db = await getDb();
    const fundlogs = db.collection(FUNDLOGS_COLLECTION);

    const { question, model_id = "qwen-max", topk = 5 } = req.body || {};
    if (!question?.trim()) return res.status(400).json({ error: "Missing 'question'" });
    const k = Math.max(1, Math.min(parseInt(topk, 10) || 5, 50));

    // 1) Vector search trong MongoDB
    const hits = await fundVectorSearch(question, k);

    // 2) Gọi LLM
    const prompt = buildPrompt(question, hits);
    const llmRes = await callLLM(prompt, model_id);

    let text = "";
    let provider = null;
    let resolvedModel = model_id;
    if (typeof llmRes === "string") text = llmRes;
    else if (llmRes && typeof llmRes === "object") {
      text = llmRes.answer ?? llmRes.text ?? llmRes.content ?? "";
      provider = llmRes.provider ?? null;
      resolvedModel = llmRes.model ?? resolvedModel;
    }

    // 3) Meta
    let prompt_tokens = null, answer_tokens = null, tokens_used = null;
    try {
      prompt_tokens = encode(prompt).length;
      answer_tokens = encode(text).length;
      tokens_used = prompt_tokens + answer_tokens;
    } catch (_) {}
    const response_time_ms = Date.now() - startedAt;

    // 4) Ghi log
    try {
      await fundlogs.insertOne({
        question,
        asked_at: new Date(startedAt),
        answer: text,
        answered_at: new Date(),
        withLLM: true,
        model_id,
        provider,
        model: resolvedModel,
        topk: k,
        hits: hits.slice(0, 5),
        meta: { response_time_ms, tokens_used, prompt_tokens, answer_tokens },
        createdAt: new Date(),
      });
    } catch (e) {
      console.error("⚠️ Cannot write fundlogs:", e.message);
    }

    // 5) Trả về client — giữ shape quen thuộc
    return res.json({
      model_id,
      answer: {
        answer: text,
        model: resolvedModel,
        provider,
      },
      retrieved: { fund: hits },
      meta: { response_time_ms, tokens_used, prompt_tokens, answer_tokens },
    });
  } catch (err) {
    console.error("❌ /api/agent error:", err?.response?.data || err.message);
    return res.status(500).json({ error: err.message || "Internal error" });
  }
});

/* ===================== Boot ===================== */
if (!process.env.VERCEL) {
  (async () => {
    try {
      await getDb();
      await initEmbedding();
      app.listen(PORT, () => {
        console.log(`🚀 API running at http://localhost:${PORT}`);
      });
    } catch (e) {
      console.error("❌ Startup error:", e.message);
      process.exit(1);
    }
  })();
}

export default app;
