// server.js
import "dotenv/config";
import express from "express";
import cors from "cors";
import { MongoClient } from "mongodb";
import { QdrantClient } from "@qdrant/js-client-rest";
import { pipeline } from "@xenova/transformers";
import { callLLM } from "./llm.js";
import { encode } from "gpt-tokenizer";

/* ===================== Env & constants ===================== */
const PORT = process.env.PORT || 4000;

const MONGO_URI = process.env.MONGO_URI;
const MONGO_DB = process.env.MONGO_DB || "fitneu";
const FUNDLOGS_COLLECTION = "fundlogs";

const QDRANT_URL = process.env.QDRANT_URL;
const QDRANT_API_KEY = process.env.QDRANT_API_KEY;
const QDRANT_COLLECTION = process.env.QDRANT_COLLECTION || "fund";

const EMBEDDING_MODEL =
  process.env.EMBEDDING_MODEL || "all-MiniLM-L6-v2";

/* ===================== Basic checks ===================== */
if (!MONGO_URI) {
  console.error("❌ Missing MONGO_URI in .env");
  process.exit(1);
}
if (!QDRANT_URL || !QDRANT_API_KEY) {
  console.error("❌ Missing QDRANT_URL or QDRANT_API_KEY in .env");
  process.exit(1);
}

/* ===================== Express ===================== */
const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

/* ===================== MongoDB ===================== */
let mongoClient;
let db;
let fundlogs;

async function connectMongo() {
  if (fundlogs) return; // tránh connect lại nhiều lần trên Vercel
  mongoClient = new MongoClient(MONGO_URI);
  await mongoClient.connect();
  db = mongoClient.db(MONGO_DB);
  fundlogs = db.collection(FUNDLOGS_COLLECTION);
  console.log(`✅ MongoDB connected: ${MONGO_DB}.${FUNDLOGS_COLLECTION}`);
}

/* ===================== Qdrant ===================== */
console.log("🔧 Using Qdrant URL:", QDRANT_URL);
const qdrant = new QdrantClient({
  url: QDRANT_URL,
  apiKey: QDRANT_API_KEY,
});

/* ===================== Embeddings (Xenova) ===================== */
let embedder = null;
async function getEmbedder() {
  if (!embedder) {
    const modelName = EMBEDDING_MODEL.startsWith("Xenova/")
      ? EMBEDDING_MODEL
      : `Xenova/${EMBEDDING_MODEL}`;
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
function stringifyArray(v) {
  if (Array.isArray(v)) return v.filter(Boolean).join(", ");
  return typeof v === "string" ? v : "";
}

// Rút gọn payload fund thành đoạn văn gọn để feed LLM
function summarizeFundPayload(p = {}) {
  const title =
    pick(p["OPPORTUNITY TITLE"]) || pick(p.title) || pick(p.name) || "Không có tiêu đề";

  const agency =
    pick(p["AGENCY NAME"]) || pick(p.agency) || pick(p.organization) || "";

  const category =
    pick(p["FUNDING CATEGORY EXPLANATION"]) || pick(p.category) || pick(p.categories) || "";

  const assist =
    stringifyArray(p["ASSISTANCE LISTINGS"]) || stringifyArray(p.assistance_listings) || "";

  const eligible =
    stringifyArray(p["ELIGIBLE APPLICANTS"]) || stringifyArray(p.eligible) || "";

  const desc =
    pick(p["FUNDING DESCRIPTION"]) || pick(p.description) || pick(p.summary) || "";

  const url = pick(p.url) || pick(p.link) || pick(p["OPPORTUNITY URL"]) || "";

  let lines = [`• ${title}`];
  if (agency) lines.push(`  - Cơ quan: ${agency}`);
  if (category) lines.push(`  - Nhóm: ${category}`);
  if (assist) lines.push(`  - Assistance: ${assist}`);
  if (eligible) lines.push(`  - Đối tượng: ${eligible}`);
  if (desc) lines.push(`  - Mô tả: ${desc.slice(0, 400)}${desc.length > 400 ? "..." : ""}`);
  if (url) lines.push(`  - Link: ${url}`);
  return lines.join("\n");
}

// Build prompt cho LLM
function buildPrompt(question, hits = []) {
  const header =
    "Bạn là trợ lý hỗ trợ tìm kiếm quỹ tài trợ. Dựa trên danh sách cơ hội bên dưới, hãy trả lời ngắn gọn, đưa ra 3–5 cơ hội phù hợp nhất, kèm lý do khớp và lưu ý về eligibility.\n";
  const ctx =
    hits.length > 0
      ? hits
          .map(
            (h, i) =>
              `Kết quả #${i + 1} (score=${h.score?.toFixed?.(4) ?? h.score}):\n${summarizeFundPayload(
                h.payload
              )}`
          )
          .join("\n\n")
      : "Không tìm thấy kết quả nào trong cơ sở dữ liệu.";

  return `${header}\nCâu hỏi người dùng: "${question}"\n\nNgữ cảnh:\n${ctx}\n\nYêu cầu: Trả lời bằng TIẾNG VIỆT, liệt kê gọn, có tiêu đề từng cơ hội, nêu lý do phù hợp (theo chủ đề/đối tượng/quốc gia), thêm link nếu có.`;
}

/* ===================== Routes ===================== */
app.get("/api/health", async (_req, res) => {
  await connectMongo();
  res.json({
    status: "ok",
    mongo_db: MONGO_DB,
    qdrant_url: QDRANT_URL,
    collection: QDRANT_COLLECTION,
    embedding_model: EMBEDDING_MODEL,
    time: new Date().toISOString(),
  });
});

/* ===================== Fund APIs ===================== */

// GET /api/fund/:id  → lấy 1 record từ Qdrant
app.get("/api/fund/:id", async (req, res) => {
  try {
    const { id } = req.params;
    if (!id) return res.status(400).json({ error: "Thiếu id" });

    const record = await qdrant.retrieve(QDRANT_COLLECTION, {
      ids: [id],
      with_payload: true,
      with_vector: false,
    });

    if (!record || record.length === 0) {
      return res.status(404).json({ error: "Không tìm thấy fund" });
    }

    return res.json(record[0]);
  } catch (err) {
    console.error("❌ /api/fund/:id error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/fund  → liệt kê danh sách fund (có phân trang + filter q)
app.get("/api/fund", async (req, res) => {
  try {
    const { page = 1, limit = 20, q } = req.query;
    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);

    // Nếu có query q thì tìm theo vector
    if (q && q.trim()) {
      const queryVector = await embedText(q);
      const results = await qdrant.search(QDRANT_COLLECTION, {
        vector: queryVector,
        limit: pageSize,
        with_payload: true,
        with_vector: false,
      });

      return res.json({
        page: pageNum,
        limit: pageSize,
        total: results.length,
        items: results.map(r => ({
          id: r.id,
          score: r.score,
          payload: r.payload,
        })),
      });
    }

    // Nếu không có query thì scan toàn bộ (theo offset)
    const offset = (pageNum - 1) * pageSize;
    const resQdrant = await qdrant.scroll(QDRANT_COLLECTION, {
      limit: pageSize,
      offset,
      with_payload: true,
      with_vector: false,
    });

    return res.json({
      page: pageNum,
      limit: pageSize,
      next_page_offset: resQdrant.next_page_offset || null,
      items: (resQdrant.points || []).map(p => ({
        id: p.id,
        payload: p.payload,
      })),
    });
  } catch (err) {
    console.error("❌ /api/fund error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ===================== Agent API (chuẩn backend cho worker) ===================== */
/**
 * Body:
 *  {
 *    "question": "string",
 *    "model_id": "qwen-max" | ...,
 *    "topk": number
 *  }
 *
 * Trả về (tương thích worker /v1/ask):
 *  {
 *    "model_id": "...",
 *    "answer": { "answer": "markdown", "model": "...", "provider": "..." },
 *    "retrieved": { "fund": [ { id, score, payload }, ... ] },
 *    "meta": { "response_time_ms": ..., "tokens_used": ..., "prompt_tokens": ..., "answer_tokens": ... }
 *  }
 */
app.post("/api/agent", async (req, res) => {
  const startedAt = Date.now();
  try {
    await connectMongo();

    const { question, model_id = "qwen-max", topk = 5 } = req.body || {};
    if (!question?.trim()) {
      return res.status(400).json({ error: "Missing 'question'" });
    }
    const k = Math.max(1, Math.min(parseInt(topk, 10) || 5, 50));

    // 1) Embed & search Qdrant (fund collection)
    const queryVector = await embedText(question);
    const results = await qdrant.search(QDRANT_COLLECTION, {
      vector: queryVector,
      limit: k,
      with_payload: true,
      with_vector: false,
    });

    const hits = (results || []).map(r => ({
      id: r.id,
      score: r.score,
      payload: r.payload || {},
    }));

    // 2) Gọi LLM với prompt đã chuẩn hoá cho fund
    const prompt = buildPrompt(question, hits);
    const llmRes = await callLLM(prompt, model_id);

    // Chuẩn hoá output từ callLLM (chấp nhận cả kiểu string hoặc object tuỳ provider)
    let text = "";
    let provider = null;
    let resolvedModel = model_id;

    if (typeof llmRes === "string") {
      text = llmRes;
    } else if (llmRes && typeof llmRes === "object") {
      text = llmRes.answer ?? llmRes.text ?? llmRes.content ?? "";
      provider = llmRes.provider ?? null;
      resolvedModel = llmRes.model ?? resolvedModel;
    }

    // 3) Meta (thống kê token, thời gian)
    let prompt_tokens = null;
    let answer_tokens = null;
    let tokens_used = null;
    try {
      prompt_tokens = encode(prompt).length;
      answer_tokens = encode(text).length;
      tokens_used = prompt_tokens + answer_tokens;
    } catch (_) {}

    const response_time_ms = Date.now() - startedAt;

    // 4) Ghi log (không phá vỡ logic cũ)
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
      });
    } catch (e) {
      console.error("⚠️ Cannot write fundlogs (/api/agent):", e.message);
    }

    // 5) Trả về đúng shape mà Cloudflare worker đang dùng
    return res.json({
      model_id,
      answer: {
        answer: text,          // worker đọc: data.answer.answer
        model: resolvedModel,  // worker đọc: data.answer.model
        provider,
      },
      retrieved: { fund: hits },
      meta: {
        response_time_ms,
        tokens_used,
        prompt_tokens,
        answer_tokens,
      },
    });
  } catch (err) {
    console.error("❌ /api/agent error:", err?.response?.data || err.message);
    try {
      await fundlogs.insertOne({
        question: req.body?.question || null,
        asked_at: new Date(startedAt),
        error: err.message || String(err),
        withLLM: true,
        model_id: req.body?.model_id || "qwen-max",
        route: "/api/agent",
      });
    } catch (_) {}
    return res.status(500).json({
      error: err.message || "Internal error",
      detail: err?.response?.data,
    });
  }
});


app.post("/api/ask", async (req, res) => {
  const startedAt = new Date();
  try {
    await connectMongo();

    const { question, topk = 5, withLLM = true, model_id = "qwen-max" } = req.body || {};
    if (!question?.trim()) {
      return res.status(400).json({ error: "Thiếu 'question'" });
    }
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
    let answer = null;
    let provider = null;
    let resolvedModel = null;

    if (withLLM) {
      const prompt = buildPrompt(question, hits);
      const llmRes = await callLLM(prompt, model_id);
      provider = llmRes.provider;
      resolvedModel = llmRes.model;
      answer = llmRes.answer;
    }

    // 4) Log → Mongo fundlogs
    const endedAt = new Date();
    try {
      await fundlogs.insertOne({
        question,
        asked_at: startedAt,
        answer: answer,
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
        answered_at: new Date().toISOString(),
        topk: k,
      },
    });
  } catch (err) {
    console.error("❌ /api/ask error:", err?.response?.data || err.message);
    try {
      await fundlogs.insertOne({
        question: req.body?.question || null,
        asked_at: startedAt,
        error: err.message || String(err),
        withLLM: !!req.body?.withLLM,
        model_id: req.body?.model_id || "qwen-max",
      });
    } catch (_) {}
    return res.status(500).json({
      error: err.message || "Internal error",
      detail: err?.response?.data,
    });
  }
});

/* ===================== Boot ===================== */
if (process.env.NODE_ENV !== "production") {
  // Local: chạy express server
  (async () => {
    try {
      await connectMongo();
      await getEmbedder();
      app.listen(PORT, () => {
        console.log(`🚀 API running at http://localhost:${PORT}`);
      });
    } catch (e) {
      console.error("❌ Startup error:", e.message);
      process.exit(1);
    }
  })();
}

// ✅ Export cho Vercel
export default app;
