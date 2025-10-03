import { getDb } from "./db.js";

const DEFAULT_COLLECTION = process.env.SESSION_COLLECTION || "fundsessions";
const DEFAULT_MAX = parseInt(process.env.SHORT_MEMORY_SIZE || "5", 10);

function normalizeSessionId(sessionId) {
  return sessionId ? String(sessionId).trim() : null;
}

// Chạy 1 lần khi startup, không cần gọi đi gọi lại (bỏ trong các hàm bên dưới)
export async function ensureIndexes() {
  const db = await getDb();
  const col = db.collection(DEFAULT_COLLECTION);
  await col.createIndex({ sessionId: 1 });
}

export async function addToMemory(sessionId, role, text, maxEntries = DEFAULT_MAX) {
  const sessionIdStr = normalizeSessionId(sessionId);
  if (!sessionIdStr) return;
  const db = await getDb();
  const col = db.collection(DEFAULT_COLLECTION);

  // Thêm entry vào cuối mảng entries
  await col.updateOne(
    { sessionId: sessionIdStr },
    {
      $setOnInsert: { createdAt: new Date(), sessionId: sessionIdStr },
      $push: { entries: { role, text, createdAt: new Date() } }
    },
    { upsert: true }
  );

  // Cắt lại mảng entries chỉ lấy maxEntries phần cuối cùng
  await col.updateOne(
    { sessionId: sessionIdStr },
    [ { $set: { entries: { $slice: ["$entries", -maxEntries] } } } ]
  );
}

export async function getMemory(sessionId, limit = DEFAULT_MAX) {
  const sessionIdStr = normalizeSessionId(sessionId);
  if (!sessionIdStr) return [];
  const db = await getDb();
  const col = db.collection(DEFAULT_COLLECTION);

  const doc = await col.findOne(
    { sessionId: sessionIdStr },
    { projection: { entries: 1 } }
  );
  if (!doc?.entries) return [];
  return doc.entries.slice(-limit);
}

export async function clearMemory(sessionId) {
  const sessionIdStr = normalizeSessionId(sessionId);
  if (!sessionIdStr) return;
  const db = await getDb();
  const col = db.collection(DEFAULT_COLLECTION);
  await col.deleteOne({ sessionId: sessionIdStr });
}
