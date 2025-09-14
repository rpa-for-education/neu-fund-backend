// --- file: memory.js ---
// Simple short-term memory implemented on MongoDB.
// Exports: addToMemory(sessionId, role, text), getMemory(sessionId, limit), clearMemory(sessionId)

import { getDb } from "./db.js";

const DEFAULT_COLLECTION = process.env.SESSION_COLLECTION || "fundsessions";
const DEFAULT_MAX = parseInt(process.env.SHORT_MEMORY_SIZE || "5", 10);

// đảm bảo index unique cho sessionId
async function ensureIndexes(col) {
  try {
    await col.createIndex({ sessionId: 1 }, { unique: true });
  } catch (err) {
    console.error("Failed to ensure index on sessionId:", err.message);
  }
}

export async function addToMemory(sessionId, role, text, maxEntries = DEFAULT_MAX) {
  if (!sessionId) return;
  const db = await getDb();
  const col = db.collection(DEFAULT_COLLECTION);

  await ensureIndexes(col);

  const entry = { role, text, createdAt: new Date() };

  // updateOne thay vì insertOne → không tạo doc mới mỗi lần
  await col.updateOne(
    { sessionId },
    {
      $setOnInsert: { createdAt: new Date(), sessionId },
      $push: {
        entries: { $each: [entry], $slice: -maxEntries },
      },
    },
    { upsert: true }
  );
}

export async function getMemory(sessionId, limit = DEFAULT_MAX) {
  if (!sessionId) return [];
  const db = await getDb();
  const col = db.collection(DEFAULT_COLLECTION);

  await ensureIndexes(col);

  const doc = await col.findOne({ sessionId }, { projection: { entries: 1 } });
  if (!doc?.entries) return [];
  // return last `limit` entries in chronological order
  const entries = Array.isArray(doc.entries) ? doc.entries.slice(-limit) : [];
  return entries;
}

export async function clearMemory(sessionId) {
  if (!sessionId) return;
  const db = await getDb();
  const col = db.collection(DEFAULT_COLLECTION);

  await ensureIndexes(col);

  await col.deleteOne({ sessionId });
}
