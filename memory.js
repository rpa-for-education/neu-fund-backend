import { getDb } from "./db.js";

const DEFAULT_COLLECTION = process.env.SESSION_COLLECTION || "fundsessions";
const DEFAULT_MAX = parseInt(process.env.SHORT_MEMORY_SIZE || "5", 10);

function normalizeSessionId(sessionId) {
  return sessionId ? String(sessionId).trim() : null;
}

/**
 * Lưu message vào mảng entries của document sessionId, tạo mới nếu chưa có
 * Chuẩn hóa entries thành mảng nếu cần tránh lỗi conflict MongoDB
 */
export async function addToMemory(sessionId, role, text, maxEntries = DEFAULT_MAX) {
  const sessionIdStr = normalizeSessionId(sessionId);
  if (!sessionIdStr) return;

  const db = await getDb();
  const col = db.collection(DEFAULT_COLLECTION);

  const entry = { role, text, createdAt: new Date() };

  // Lấy doc hiện tại
  const doc = await col.findOne({ sessionId: sessionIdStr });

  // Nếu tồn tại và entries không phải array, chuẩn hóa về mảng rỗng
  if (doc && !Array.isArray(doc.entries)) {
    await col.updateOne(
      { sessionId: sessionIdStr },
      [{ $set: { entries: { $cond: [{ $isArray: "$entries" }, "$entries", []] } } }]
    );
  }

  // Cập nhật/Thêm message mới, giới hạn maxEntries
  await col.updateOne(
    { sessionId: sessionIdStr },
    {
      $setOnInsert: { sessionId: sessionIdStr, entries: [] },
      $push: { entries: { $each: [entry], $slice: -maxEntries } }
    },
    { upsert: true }
  );
}

/**
 * Lấy mảng entries gần nhất của session
 */
export async function getMemory(sessionId, limit = DEFAULT_MAX) {
  const sessionIdStr = normalizeSessionId(sessionId);
  if (!sessionIdStr) return [];

  const db = await getDb();
  const col = db.collection(DEFAULT_COLLECTION);

  const doc = await col.findOne({ sessionId: sessionIdStr }, { projection: { entries: 1 } });
  if (!doc?.entries) return [];
  return doc.entries.slice(-limit);
}

/**
 * Xóa toàn bộ memory của session
 */
export async function clearMemory(sessionId) {
  const sessionIdStr = normalizeSessionId(sessionId);
  if (!sessionIdStr) return;

  const db = await getDb();
  const col = db.collection(DEFAULT_COLLECTION);
  await col.deleteOne({ sessionId: sessionIdStr });
}
