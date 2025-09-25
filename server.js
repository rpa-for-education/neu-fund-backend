import "dotenv/config";
import express from "express";
import cors from "cors";
import session from "express-session"; // thêm import này
import { ObjectId } from "mongodb";
import { callLLM } from "./llm.js";
import { encode } from "gpt-tokenizer";
import { getDb } from "./db.js";
import { fundVectorSearch, initEmbedding } from "./search.js";
import { addToMemory, getMemory } from "./memory.js"; // short-term memory

/* ===================== Env & constants ===================== */
const PORT = process.env.PORT || 4000;
//... các hằng số khác giữ nguyên

/* ===================== Express ===================== */
const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

// Thêm middleware express-session
app.use(session({
  secret: process.env.SESSION_SECRET || "fitneu2025", // nên đặt trong .env
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false } // nếu dùng HTTPS thì đặt true
}));


// ... các hàm helper và route giữ nguyên

/* ===================== Agent API (short-term memory) ===================== */
app.post("/api/agent", async (req, res) => {
  const startedAt = Date.now();
  try {
    const db = await getDb();
    const fundlogs = db.collection(FUNDLOGS_COLLECTION);

    // Dùng session của express-session
    let sid = req.sessionID;
    let isNewSession = false;
    if (!req.session.isInitialized) {
      req.session.isInitialized = true;
      isNewSession = true;
    }

    // Hoặc nếu vẫn muốn dùng sessionId tự tạo thì dùng đoạn gốc:
    /*
    sid = req.query.sid || (req.body && req.body.sid) || null;
    if (!sid) {
      sid = new ObjectId().toString();
      isNewSession = true;
    }
    sid = String(sid);
    */

    
    console.log(req);
    // Phần còn lại giữ nguyên, chỉ thay thế sid từ trên

    const { question: rawQuestion, prompt, model_id = "qwen-max", topk = 5 } =
      req.body || {};
    const question = rawQuestion || prompt;
    if (!question?.trim())
      return res.status(400).json({ error: "Missing 'question' or 'prompt'" });

    const k = Math.max(1, Math.min(parseInt(topk, 10) || 5, 50));
    let hits = [];
    try {
      hits = await fundVectorSearch(question, k);
      hits = hits.map(
        ({ VECTOR, vector, score, ["OPPORTUNITY NUMBER"]: _, ...rest }) => rest
      );
    } catch (e) {
      console.error("⚠️ fundVectorSearch failed:", e);
      hits = [];
    }

    let memoryEntries = [];
    try {
      memoryEntries = await getMemory(sid, DEFAULT_SHORT_MEMORY_SIZE);
    } catch (e) {
      console.warn("⚠️ getMemory failed:", e);
      memoryEntries = [];
    }

    const contextText = hits
      .map(
        (f, i) =>
          `${i + 1}. ${f["OPPORTUNITY TITLE"] || ""} - ${
            f["AGENCY NAME"] || ""
          } - ${f["OPPORTUNITY URL"] || ""}`
      )
      .join("\n");

    const memoryText = memoryEntries
      .map((m) => `- [${m.role}] ${m.text}`)
      .join("\n");

    const promptText = `
Người dùng hỏi: "${question}"


${memoryText ? "Ngữ cảnh hội thoại gần đây:\n" + memoryText + "\n\n" : ""}
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
        sessionId: sid,
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

    try {
      await addToMemory(sid, "user", question, DEFAULT_SHORT_MEMORY_SIZE);
      await addToMemory(sid, "assistant", text, DEFAULT_SHORT_MEMORY_SIZE);
    } catch (e) {
      console.warn("⚠️ addToMemory failed:", e);
    }

    return res.json({
      sessionId: sid,
      isNewSession,
      model_id,
      answer: { answer: text, model: resolvedModel, provider },
      retrieved: { fund: hits },
      memory: { entries_count: memoryEntries.length },
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
