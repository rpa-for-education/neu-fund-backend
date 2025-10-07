import "dotenv/config";
import express from "express";
import cors from "cors";
import session from "express-session";
import multer from "multer";
import fs from "fs";
import mammoth from "mammoth";
import fetch from "node-fetch";

import { ObjectId, MongoClient } from "mongodb";
import { callLLM } from "./llm.js";
import { encode } from "gpt-tokenizer";
import {
  fundVectorSearch,
  readFileContent,
  initEmbedding,
  embedText,
  uploadedFilesVectorSearch
} from "./search.js";

import { readDocxFromUrl } from "./search.js";
import { addToMemory, getMemory } from "./memory.js";
import { s3Client } from "./s3.js";
import { PutObjectCommand } from "@aws-sdk/client-s3";

const PORT = process.env.PORT || 4000;
const MONGO_COLLECTION = process.env.MONGO_COLLECTION || "fund";
const FUNDLOGS_COLLECTION = process.env.FUNDLOGS_COLLECTION || "fundlogs";
const FILES_COLLECTION = process.env.FILES_COLLECTION || "uploaded_files";
const DEFAULT_LIMIT_FUND = 100;
const MAX_SHORT_HISTORY = 5;

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

// MongoClient singleton
let mongoClient = null;
let db = null;
async function getDb() {
  if (db) return db;
  if (!mongoClient) {
    mongoClient = new MongoClient(process.env.MONGO_URI);
    await mongoClient.connect();
  }
  db = mongoClient.db(process.env.MONGO_DB || "fitneu");
  return db;
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

(async () => {
  try {
    await initEmbedding();
  } catch (e) {
    console.error("⚠️ initEmbedding failed at startup:", e);
  }
})();

app.post("/api/upload", upload.array("file"), async (req, res) => {
  try {
    const { folder, userEmail } = req.body;
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const db = await getDb();
    const fileCol = db.collection(FILES_COLLECTION);
    const uploadedUrls = [];

    for (const file of req.file_name) {
      const parts = file.originalname.split(".");
      const ext = parts.length > 1 ? "." + parts.pop().toLowerCase() : "";
      const baseName = parts.join(".");
      const timestamp = new Date().toISOString().replace(/[-:T.Z]/g, "");
      const uniqueName = `${baseName}_${timestamp}${ext}`;
      const prefix = userEmail || folder || "";
      const key = prefix ? `${prefix}/${uniqueName}` : uniqueName;

      try {
        await s3Client.send(
          new PutObjectCommand({
            Bucket: process.env.MINIO_BUCKET_NAME,
            Key: key,
            Body: file.buffer,
            ContentType: file.mimetype,
          })
        );
      } catch (err) {
        console.error("❌ S3 upload failed:", err);
      }

      const fileUrl = `http://${process.env.MINIO_ENDPOINT}:${process.env.MINIO_PORT}/${process.env.MINIO_BUCKET_NAME}/${key}`;

      let extractedText = "";
      if (ext === ".pdf") {
        try {
          const { default: pdfParse } = await import("pdf-parse");
          const data = await pdfParse(file.buffer);
          extractedText = data?.text || "";
        } catch (e) {
          console.error("❌ pdfParse error (upload):", e);
        }
      } else if (ext === ".docx") {
        try {
          const { value } = await mammoth.extractRawText({ buffer: file.buffer });
          extractedText = value || "";
        } catch (e) {
          console.error("❌ mammoth docx parse error (upload):", e);
        }
      } else if (ext === ".txt") {
        extractedText = file.buffer.toString("utf8");
      }

      if (extractedText && extractedText.trim()) {
        try {
          const embedding = await embedText(extractedText);
          await fileCol.insertOne({
            name: uniqueName,
            url: fileUrl,
            text: extractedText,
            vector: embedding,
            uploadedAt: new Date(),
          });
        } catch (e) {
          console.error("❌ Indexing uploaded file failed (embedding):", e);
        }
      } else {
        console.warn("⚠️ Uploaded file has no extracted text:", uniqueName);
      }

      uploadedUrls.push(fileUrl);
    }

    res.json({ status: "success", files: uploadedUrls });
  } catch (err) {
    console.error("❌ Upload error:", err);
    res.status(500).json({ error: err.message });
  }
});

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

app.get("/api/funds", async (req, res) => {
  try {
    const { q } = req.query;
    const { limit, skip, page } = getPagination(req);
    const filter = buildSearchFilter(q, ["OPPORTUNITY TITLE", "OPPORTUNITY URL", "_key"]);
    const db = await getDb();
    const col = db.collection(MONGO_COLLECTION);

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

      res.write(`{"page":1,"limit":${DEFAULT_LIMIT_FUND},"total":${total},"items":[`);

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

app.post("/api/agent", async (req, res) => {
  const startedAt = Date.now();
  try {
    const db = await getDb();
    const fundlogs = db.collection(FUNDLOGS_COLLECTION);
    const fileCol = db.collection(FILES_COLLECTION);

    console.log(">>> req.body:", req.body);
    console.log(">>> session_id from body:", req.body.session_id);

    const sid = req.body.session_id;
    const isNewSession = false;

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
      if (Array.isArray(file_name) && file_name.length > 0) {
        question =
          file_name.length === 1
            ? `Hãy đọc nội dung của file ${file_name[0]}`
            : `Hãy đọc nội dung các file: ${file_name.join(", ")}`;
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

      // Sau khi tạo vector embedding:
      console.log(">>> session_id before vector search:", req.body.session_id);
      console.log(">>> query vector length:", queryVec.length);

      fileHits = await fileCol.aggregate([
        {
          $vectorSearch: {
            index: process.env.UPLOADED_FILES_INDEX || "vector_index_uploaded_files",
            path: "vector",
            queryVector: queryVec,
            numCandidates: Math.max(50, k * 10),
            limit: k,
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

      if (fileHits && fileHits.length > 0) {
        fileContext = fileHits
          .map((f, i) => {
            const snippet = (f.text || "").replace(/\s+/g, " ").slice(0, 600);
            return `${i + 1}. ${f.name || "(no name)"} - ${f.url}\n${snippet}${snippet.length < (f.text || "").length ? "..." : ""}\n`;
          })
          .join("\n");
      }

      } catch (fileSearchErr) {
        console.warn("⚠️ uploaded_files vector search failed:", fileSearchErr?.message || fileSearchErr);
      }

      // Sau khi lọc theo sessionId:
      console.log(">>> filtered fileHits count:", fileHits.length);
    } catch (e) {
      hits = [];
      fileHits = [];
      fileContext = "";
    }

    let memoryEntries = [];
    if (Array.isArray(req.body.chat_history)) {
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
    console.error("❌ Unhandled error in /api/agent:", err);
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
