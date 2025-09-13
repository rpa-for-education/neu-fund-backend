// server.js
import "dotenv/config";
import express from "express";
import cors from "cors";
import { ObjectId } from "mongodb";
import { callLLM } from "./llm.js";
import { encode } from "gpt-tokenizer";
import { getDb } from "./db.js";
import { fundVectorSearch, initEmbedding } from "./search.js";

/* ===================== Env & constants ===================== */
const PORT = process.env.PORT || 4000;
const MONGO_COLLECTION = process.env.MONGO_COLLECTION || "fund";
const FUNDLOGS_COLLECTION = process.env.FUNDLOGS_COLLECTION || "fundlogs";
const DEFAULT_LIMIT_FUND = 100; // 👈 số bản ghi Fund mặc định

/* ===================== Express ===================== */
const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

/* ===================== Helpers ===================== */
function getPagination(req) {
  const page = parseInt(req.query.page) > 0 ? parseInt(req.query.page) : 1;
  const limit = parseInt(req.query.limit) > 0 ? parseInt(req.query.limit) : 0;
  const skip = limit ? (page - 1) * limit : 0;
  return { page, limit, skip };
}
function buildSearchFilter(q, fields = []) {
  if (!q) return {};
  const regex = { $regex: q, $options: "i" };
  return { $or: fields.map((f) => ({ [f]: regex })) };
}
async function Funds() {
  const db = await getDb();
  return db.collection(MONGO_COLLECTION);
}

/* ===================== Healthcheck ===================== */
app.get("/api/health", async (_req, res) => {
  try {
    const db = await getDb();
    await initEmbedding().catch(() => {});
    res.json({
      status: "ok",
      db: "connected",
      collection: MONGO_COLLECTION,
      counts: { fund: await db.collection(MONGO_COLLECTION).estimatedDocumentCount() },
    });
  } catch (e) {
    res.status(500).json({ status: "error", error: e.message });
  }
});

/* ===================== Fund APIs ===================== */
app.get("/api/funds", async (req, res) => {
  try {
    const { q } = req.query;
    const { limit, skip, page } = getPagination(req);

    const filter = buildSearchFilter(q, ["OPPORTUNITY TITLE", "OPPORTUNITY URL", "_key"]);
    const col = await Funds();

    if (!limit) {
      // Stream toàn bộ {name, url} với DEFAULT_LIMIT_FUND
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      const cursor = col
        .find(filter, { projection: { "OPPORTUNITY TITLE": 1, "OPPORTUNITY URL": 1 } })
        .sort({ POSTED_DATE: -1 })
        .limit(DEFAULT_LIMIT_FUND);

      const total = await col.countDocuments(filter);
      let first = true;
      res.write(`{"page":1,"limit":${DEFAULT_LIMIT_FUND},"total":${total},"items":[`);

      await cursor.forEach((doc) => {
        const mapped = { name: doc["OPPORTUNITY TITLE"], url: doc["OPPORTUNITY URL"] };
        if (!first) res.write(",");
        res.write(JSON.stringify(mapped));
        first = false;
      });

      res.write("]}");
      res.end();
    } else {
      // Phân trang
      const cursor = col
        .find(filter, { projection: { "OPPORTUNITY TITLE": 1, "OPPORTUNITY URL": 1 } })
        .sort({ POSTED_DATE: -1 });

      const [items, total] = await Promise.all([
        cursor.skip(skip).limit(limit).toArray(),
        col.countDocuments(filter),
      ]);

      const mappedItems = items.map((doc) => ({
        name: doc["OPPORTUNITY TITLE"],
        url: doc["OPPORTUNITY URL"],
      }));

      res.json({ page, limit, total, items: mappedItems });
    }
  } catch (err) {
    console.error("❌ /api/funds error:", err);
    res.status(500).json({ error: "Failed to fetch funds", detail: err.message });
  }
});

/* ===================== Agent API ===================== */
app.post("/api/agent", async (req, res) => {
  const startedAt = Date.now();
  try {
    const db = await getDb();
    const fundlogs = db.collection(FUNDLOGS_COLLECTION);

    // Hỗ trợ cả question và prompt
    const { question: rawQuestion, prompt, model_id = "qwen-max", topk = 5 } = req.body || {};
    const question = rawQuestion || prompt;
    if (!question?.trim()) return res.status(400).json({ error: "Missing 'question' or 'prompt'" });

    const k = Math.max(1, Math.min(parseInt(topk, 10) || 5, 50));
    let hits = [];
    try {
      hits = await fundVectorSearch(question, k);
      hits = hits.map(({ VECTOR, vector, score, ["OPPORTUNITY NUMBER"]: _, ...rest }) => rest);
    } catch (e) {
      console.error("⚠️ fundVectorSearch failed:", e);
      hits = [];
    }

    // 👉 Ghép dữ liệu retrieved vào prompt cho LLM
    const contextText = hits
      .map(
        (f, i) =>
          `${i + 1}. ${f["OPPORTUNITY TITLE"] || ""} - ${f["AGENCY NAME"] || ""} - ${
            f["OPPORTUNITY URL"] || ""
          }`
      )
      .join("\n");

    const promptText = `
Người dùng hỏi: "${question}"

Dưới đây là danh sách quỹ có liên quan:
${contextText}

Hãy trả lời bằng tiếng Việt, liệt kê rõ tên quỹ, cơ quan cấp và đường dẫn. 
Nếu không có dữ liệu phù hợp thì hãy nói rõ ràng "Không tìm thấy quỹ phù hợp".
    `;

    const llmRes = await callLLM(promptText, model_id);

    let text = "";
    let provider = null;
    let resolvedModel = model_id;
    if (typeof llmRes === "string") text = llmRes;
    else if (llmRes && typeof llmRes === "object") {
      text = llmRes.answer ?? llmRes.text ?? llmRes.content ?? "";
      provider = llmRes.provider ?? null;
      resolvedModel = llmRes.model ?? resolvedModel;
    }

    let prompt_tokens = null,
      answer_tokens = null,
      tokens_used = null;
    try {
      prompt_tokens = encode(promptText).length;
      answer_tokens = encode(text).length;
      tokens_used = prompt_tokens + answer_tokens;
    } catch (_) {}

    const response_time_ms = Date.now() - startedAt;
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
      console.error("⚠️ Cannot write fundlogs:", e);
    }

    return res.json({
      model_id,
      answer: { answer: text, model: resolvedModel, provider },
      retrieved: { fund: hits },
      meta: { response_time_ms, tokens_used, prompt_tokens, answer_tokens },
    });
  } catch (err) {
    console.error("❌ /api/agent error:", err);
    return res.status(500).json({ error: err.message || "Internal error" });
  }
});

/* ===================== Boot ===================== */
if (!process.env.VERCEL) {
  (async () => {
    try {
      await getDb();
      await initEmbedding();
      app.listen(PORT, () =>
        console.log(`🚀 API running at http://localhost:${PORT}`)
      );
    } catch (e) {
      console.error("❌ Startup error:", e);
      process.exit(1);
    }
  })();
}

export default app;
