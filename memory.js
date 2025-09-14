// --- file: memory.js ---
// Simple short-term memory implemented on MongoDB.
// Exports: addToMemory(sessionId, role, text), getMemory(sessionId, limit), clearMemory(sessionId)

import { getDb } from "./db.js";

const DEFAULT_COLLECTION = process.env.SESSION_COLLECTION || "fundsessions";
const DEFAULT_MAX = parseInt(process.env.SHORT_MEMORY_SIZE || "5", 10);

// đảm bảo index unique cho sessionId
async function ensureIndexes(col) {
  try {
    // ép sessionId luôn là string
    await col.updateMany(
      { sessionId: { $type: "objectId" } },
      [{ $set: { sessionId: { $toString: "$sessionId" } } }]
    );

    // tạo index unique (drop nếu đã tồn tại conflict)
    const indexes = await col.indexes();
    const hasSessionIdx = indexes.find((idx) => idx.key && idx.key.sessionId);
    if (hasSessionIdx && !hasSessionIdx.unique) {
      await col.dropIndex(hasSessionIdx.name);
    }

    await col.createIndex({ sessionId: 1 }, { unique: true });
  } catch (err) {
    console.error("⚠️ ensureIndexes failed:", err.message);
  }
}

export async function addToMemory(sessionId, role, text, maxEntries = DEFAULT_MAX) {
  if (!sessionId) return;
  const db = await getDb();
  const col = db.collection(DEFAULT_COLLECTION);

  await ensureIndexes(col);

  const entry = { role, text, createdAt: new Date() };

  await col.updateOne(
    { sessionId: String(sessionId) },
    {
      $setOnInsert: { createdAt: new Date(), sessionId: String(sessionId) },
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

  const doc = await col.findOne(
    { sessionId: String(sessionId) },
    { projection: { entries: 1 } }
  );

  if (!doc?.entries) return [];
  const entries = Array.isArray(doc.entries) ? doc.entries.slice(-limit) : [];
  return entries;
}

export async function clearMemory(sessionId) {
  if (!sessionId) return;
  const db = await getDb();
  const col = db.collection(DEFAULT_COLLECTION);

  await ensureIndexes(col);

  await col.deleteOne({ sessionId: String(sessionId) });
}
