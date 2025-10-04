// server.js
import "dotenv/config";
import express from "express";
import cors from "cors";
import session from "express-session";
import multer from "multer";
import fs from "fs";
import pdfParse from "pdf-parse/lib/pdf-parse.js";
import mammoth from "mammoth";
import fetch from "node-fetch"; // ✅ thêm fetch để tải file từ link

import { ObjectId } from "mongodb";
import { callLLM } from "./llm.js";
import { encode } from "gpt-tokenizer";
import { getDb } from "./db.js";
import { fundVectorSearch, initEmbedding, embedText } from "./search.js";
import { addToMemory, getMemory } from "./memory.js";
import { s3Client } from "./s3.js";
import { PutObjectCommand } from "@aws-sdk/client-s3";

const PORT = process.env.PORT || 4000;
const MONGO_COLLECTION = process.env.MONGO_COLLECTION || "fund";
const FUNDLOGS_COLLECTION = process.env.FUNDLOGS_COLLECTION || "fundlogs";
const FILES_COLLECTION = process.env.FILES_COLLECTION || "uploaded_files";
const DEFAULT_LIMIT_FUND = 100;
const DEFAULT_SHORT_MEMORY_SIZE = 10;
const MAX_SHORT_HISTORY = 5; // 5 cặp hỏi - đáp gần nhất

function formatAnswerText(rawText) {
  if (!rawText) return "";
  let text = rawText.replace(/\*\*/g, "");
  text = text.replace(/(\d+)\.\s+/g, "\n- ");
  text = text.replace(/\n+/g, "\n\n");
  return text.trim();
}

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

const app = express();
app.use(cors());
app.use(
  session({
    secret: process.env.SESSION_SECRET || "fitneu2025",
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false },
  })
);
app.use(express.json({ limit: "10mb" }));

const upload = multer({ storage: multer.memoryStorage() });

// ============================= UPLOAD FILE API =============================
app.post("/api/upload", upload.array("file"), async (req, res) => {
  try {
    const { folder, userEmail } = req.body;
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const db = await getDb();
    const fileCol = db.collection(FILES_COLLECTION);
    const uploadedUrls = [];

    for (const file of req.files) {
      const parts = file.originalname.split(".");
      const ext = parts.length > 1 ? "." + parts.pop().toLowerCase() : "";
      const baseName = parts.join(".");
      const timestamp = new Date().toISOString().replace(/[-:T.Z]/g, "");
      const uniqueName = `${baseName}_${timestamp}${ext}`;
      const prefix = userEmail || folder || "";
      const key = prefix ? `${prefix}/${uniqueName}` : uniqueName;

      await s3Client.send(
        new PutObjectCommand({
          Bucket: process.env.MINIO_BUCKET_NAME,
          Key: key,
          Body: file.buffer,
          ContentType: file.mimetype,
        })
      );

      const fileUrl = `http://${process.env.MINIO_ENDPOINT}:${process.env.MINIO_PORT}/${process.env.MINIO_BUCKET_NAME}/${key}`;

      let extractedText = "";
      if (ext === ".pdf") {
        const data = await pdfParse(file.buffer);
        extractedText = data.text;
      } else if (ext === ".docx") {
        const { value } = await mammoth.extractRawText({ buffer: file.buffer });
        extractedText = value;
      } else if (ext === ".txt") {
        extractedText = file.buffer.toString("utf8");
      }

      if (extractedText.trim()) {
        const embedding = await embedText(extractedText);
        await fileCol.insertOne({
          name: uniqueName,
          url: fileUrl,
          text: extractedText,
          vector: embedding,
          uploadedAt: new Date(),
        });
      }

      uploadedUrls.push(fileUrl);
    }

    res.json({ status: "success", files: uploadedUrls });
  } catch (err) {
    console.error("❌ Upload error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ============================= HEALTH CHECK =============================
app.get("/api/health", async (_req, res) => {
  try {
    const db = await getDb();
    await initEmbedding().catch(() => {});
    res.json({
      status: "ok",
      db: "connected",
      collection: MONGO_COLLECTION,
      counts: {
        fund: await db.collection(MONGO_COLLECTION).estimatedDocumentCount(),
        files: await db.collection(FILES_COLLECTION).estimatedDocumentCount(),
      },
    });
  } catch (e) {
    res.status(500).json({ status: "error", error: e.message });
  }
});

// ============================= GET FUNDS =============================
app.get("/api/funds", async (req, res) => {
  try {
    const { q } = req.query;
    const { limit, skip, page } = getPagination(req);
    const filter = buildSearchFilter(q, [
      "OPPORTUNITY TITLE",
      "OPPORTUNITY URL",
      "_key",
    ]);
    const col = await Funds();

    if (!limit) {
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
      });

      const cursor = col
        .find(filter, {
          projection: { "OPPORTUNITY TITLE": 1, "OPPORTUNITY URL": 1 },
        })
        .sort({ POSTED_DATE: -1 })
        .limit(DEFAULT_LIMIT_FUND);

      const total = await col.countDocuments(filter);
      let first = true;

      res.write(
        `{"page":1,"limit":${DEFAULT_LIMIT_FUND},"total":${total},"items":[`
      );

      await cursor.forEach((doc) => {
        const mapped = {
          name: doc["OPPORTUNITY TITLE"],
          url: doc["OPPORTUNITY URL"],
        };
        if (!first) res.write(",");
        res.write(JSON.stringify(mapped));
        first = false;
      });

      res.write("]}");
      res.end();
    } else {
      const cursor = col
        .find(filter, {
          projection: { "OPPORTUNITY TITLE": 1, "OPPORTUNITY URL": 1 },
        })
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

// ============================= AGENT HANDLER =============================
app.post("/api/agent", async (req, res) => {
  const startedAt = Date.now();

  try {
    const db = await getDb();
    const fundlogs = db.collection(FUNDLOGS_COLLECTION);
    const fileCol = db.collection(FILES_COLLECTION);

    console.log(req.body);

    const sid = req.body.session_id;
    let isNewSession = false;
    if (!req.session.isInitialized) {
      req.session.isInitialized = true;
      isNewSession = true;
    }

    let {
      question: rawQuestion,
      prompt,
      model_id,
      topk = 5,
      fileName,
      files,
      context,
      file_name,
    } = req.body || {};

    let question = rawQuestion || prompt;

    if (!question?.trim()) {
      if (Array.isArray(files) && files.length > 0) {
        question =
          files.length === 1
            ? `Hãy đọc nội dung của file ${files[0]}`
            : `Hãy đọc nội dung các file: ${files.join(", ")}`;
      } else if (fileName) {
        question = `Hãy đọc nội dung của file ${fileName}`;
      }
    }

    if (!question?.trim()) {
      return res.status(400).json({ error: "Missing 'question' or 'prompt'" });
    }

    const resolvedModel = model_id || "qwen-max";
    const k = Math.max(1, Math.min(parseInt(topk, 10) || 5, 50));
    let hits = [];
    let fileHits = [];
    let fileContext = "";

    try {
      hits = await fundVectorSearch(question, k);
      hits = hits.map(
        ({ VECTOR, vector, score, ["OPPORTUNITY NUMBER"]: _, ...rest }) => rest
      );

      const queryVec = await embedText(question);

      // ✅ XỬ LÝ FILE LINK
      if (Array.isArray(file_name) && file_name.length > 0) {
        for (const link of file_name) {
          const existing = await fileCol.findOne({ url: link });
          if (!existing) {
            try {
              const resp = await fetch(link);
              if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
              const buffer = Buffer.from(await resp.arrayBuffer());
              const ext = link.toLowerCase().endsWith(".pdf")
                ? ".pdf"
                : link.toLowerCase().endsWith(".docx")
                ? ".docx"
                : ".txt";

              let extractedText = "";
              if (ext === ".pdf") {
                const data = await pdfParse(buffer);
                extractedText = data.text;
              } else if (ext === ".docx") {
                const { value } = await mammoth.extractRawText({ buffer });
                extractedText = value;
              } else {
                extractedText = buffer.toString("utf8");
              }

              if (extractedText.trim()) {
                const embedding = await embedText(extractedText);
                await fileCol.insertOne({
                  name: link.split("/").pop(),
                  url: link,
                  text: extractedText,
                  vector: embedding,
                  uploadedAt: new Date(),
                });
              }
            } catch (fetchErr) {
              console.error("❌ Không thể đọc file link:", link, fetchErr);
            }
          }
        }

        const foundFiles = await fileCol
          .find({ url: { $in: file_name } })
          .toArray();

        fileContext = foundFiles
          .map((f, i) => `${i + 1}. ${f.name} - ${f.url}`)
          .join("\n");

        fileHits = foundFiles.slice(0, k);
      } else {
        fileHits = [];
        fileContext = "";
      }
    } catch (e) {
      hits = [];
      fileHits = [];
      fileContext = "";
    }

    let memoryEntries = [];
    if (Array.isArray(req.body.chat_history)) {
      console.log("DEBUG chat_history:");
      req.body.chat_history.forEach((entry, idx) => {
        console.log(`[${idx}] role: ${entry.role}, content: ${entry.content}`);
      });

      const recentHistory = req.body.chat_history.slice(-MAX_SHORT_HISTORY * 2);
      memoryEntries = recentHistory
        .map((entry) => ({
          role: entry.role || "user",
          text: entry.content || "",
        }))
        .filter((m) => m.text.trim().length > 0);
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

    if (fileContext.trim()) {
      fileContext = `Dưới đây là các file người dùng đã tải lên có liên quan:\n${fileContext}\n\n`;
    }

    const promptText = `
Người dùng hỏi: "${question}"

${memoryText ? "Ngữ cảnh hội thoại gần đây:\n" + memoryText + "\n\n" : ""}
Dưới đây là danh sách quỹ có liên quan:
${contextText}

${fileContext}Hãy trả lời bằng tiếng Việt, trích dẫn tên quỹ hoặc file và đường dẫn.
Nếu không có dữ liệu phù hợp thì hãy nói rõ ràng "Không tìm thấy dữ liệu phù hợp".
`;

    console.log("=== PROMPT ===\n", promptText, "\n=== END PROMPT ===");

    const llmRes = await callLLM(promptText, resolvedModel);

    let text = "";
    let provider = null;
    if (typeof llmRes === "string") {
      text = llmRes;
    } else if (llmRes && typeof llmRes === "object") {
      text = llmRes.answer ?? llmRes.text ?? llmRes.content ?? "";
      provider = llmRes.provider ?? null;
    }

    text = formatAnswerText(text);

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
        model_id: resolvedModel,
        provider,
        topk: k,
        hits: hits.slice(0, 5),
        fileHits: fileHits.slice(0, 5),
        meta: { response_time_ms, tokens_used, prompt_tokens, answer_tokens },
        createdAt: new Date(),
      });
    } catch (e) {}

    return res.json({
      sessionId: sid,
      isNewSession,
      model_id: resolvedModel,
      answer: { answer: text, model: resolvedModel, provider },
      retrieved: { fund: hits, files: fileHits },
      memory: { entries_count: memoryEntries.length },
      meta: { response_time_ms, tokens_used, prompt_tokens, answer_tokens },
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Internal error" });
  }
});

// ============================= SERVER STARTUP =============================
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
