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

/* ===================== Express ===================== */
const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

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
  const header =
    "Bạn là trợ lý hỗ trợ tìm kiếm quỹ tài trợ. Dựa trên danh sách cơ hội bên dưới, hãy trả lời ngắn gọn, đưa ra 3–5 cơ hội phù hợp nhất, kèm lý do khớp và lưu ý về eligibility.\n";
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
    // đảm bảo embedder được khởi tạo sớm (giảm cold start trên dev)
    await initEmbedding().catch((e) => {
      console.warn("⚠️ initEmbedding warning:", e?.message || e);
    });
    res.json({
      status: "ok",
      db: "connected",
      collection: MONGO_COLLECTION,
      embedding_model: process.env.EMBEDDING_MODEL || null,
      time: new Date().toISOString(),
      counts: {
        fund: await db.collection(MONGO_COLLECTION).estimatedDocumentCount(),
      },
    });
  } catch (e) {
    console.error("❌ /api/health error:", e);
    res.status(500).json({ status: "error", error: e.message });
  }
});

/* ===================== Fund APIs ===================== */

app.get("/api/funds", async (req, res) => {
  try {
    const { q } = req.query;
    const { limit, skip, page } = getPagination(req);

    // các trường sẽ cho phép search
    const filter = buildSearchFilter(q, [
      "OPPORTUNITY_TITLE",
      "AGENCY_NAME",
      "AGENCY_CODE",
      "OPPORTUNITY_NUMBER",
      "ASSISTANCE_LISTINGS",
      "GRANTOR_CONTACT",
      "GRANTOR_CONTACT_EMAIL",
      "FUNDING_DESCRIPTION",
      "ELIGIBLE_APPLICANTS",
      "OPPORTUNITY_ID",
      "OPPORTUNITY_URL",
      "_key"
    ]);

    const col = await Funds();

    // Query
    const cursor = col.find(filter).sort({ POSTED_DATE: -1 });

    let items, total;
    if (!limit) {
      items = await cursor.toArray();
      total = items.length;
    } else {
      [items, total] = await Promise.all([
        cursor.skip(skip).limit(limit).toArray(),
        col.countDocuments(filter)
      ]);
    }

    res.json({
      page,
      limit: limit || total,
      total,
      items
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch funds", detail: err.message });
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

    // 1) Vector search trong MongoDB (reuse search.js)
    let hits = [];
    try {
      hits = await fundVectorSearch(question, k);
    } catch (e) {
      console.error("⚠️ fundVectorSearch failed:", e);
      hits = []; // fallback rỗng
    }

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

    // 4) Ghi log (non-fatal)
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
      app.listen(PORT, () => {
        console.log(`🚀 API running at http://localhost:${PORT}`);
      });
    } catch (e) {
      console.error("❌ Startup error:", e);
      process.exit(1);
    }
  })();
}

export default app;
