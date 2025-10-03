// --- memory.js ---
// Best-practice short-term memory: mỗi message thành 1 document

import { getDb } from "./db.js";

const DEFAULT_COLLECTION = process.env.SESSION_COLLECTION || "fundsessions";
const DEFAULT_MAX = parseInt(process.env.SHORT_MEMORY_SIZE || "5", 10);

function normalizeSessionId(sessionId) {
  return sessionId ? String(sessionId).trim() : null;
}

// Lưu 1 message vào memory. Tự động giới hạn số entry theo maxEntries.
export async function addToMemory(sessionId, role, text, maxEntries = DEFAULT_MAX) {
  const sessionIdStr = normalizeSessionId(sessionId);
  if (!sessionIdStr) return;
  const db = await getDb();
  const col = db.collection(DEFAULT_COLLECTION);

  // Insert bản ghi mới
  await col.insertOne({ sessionId: sessionIdStr, role, text, createdAt: new Date() });

  // Xoá bản ghi cũ nếu vượt quá maxEntries
  const count = await col.countDocuments({ sessionId: sessionIdStr });
  if (count > maxEntries) {
    const old = await col.find({ sessionId: sessionIdStr })
      .sort({ createdAt: 1 })
      .limit(count - maxEntries)
      .project({ _id: 1 }).toArray();
    if (old.length > 0) {
      await col.deleteMany({ _id: { $in: old.map(e => e._id) } });
    }
  }
}

// Lấy context hội thoại gần nhất cho sessionId
export async function getMemory(sessionId, limit = DEFAULT_MAX) {
  const sessionIdStr = normalizeSessionId(sessionId);
  if (!sessionIdStr) return [];
  const db = await getDb();
  const col = db.collection(DEFAULT_COLLECTION);

  return await col.find({ sessionId: sessionIdStr })
    .sort({ createdAt: 1 })
    .limit(limit)
    .project({ _id: 0, role: 1, text: 1, createdAt: 1 })
    .toArray();
}

// Xoá toàn bộ memory theo sessionId
export async function clearMemory(sessionId) {
  const sessionIdStr = normalizeSessionId(sessionId);
  if (!sessionIdStr) return;
  const db = await getDb();
  const col = db.collection(DEFAULT_COLLECTION);
  await col.deleteMany({ sessionId: sessionIdStr });
}
