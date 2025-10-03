// memory.js

import { getDb } from "./db.js";

const DEFAULT_COLLECTION = process.env.SESSION_COLLECTION || "fundsessions";
const DEFAULT_MAX = parseInt(process.env.SHORT_MEMORY_SIZE || "5", 10);

function normalizeSessionId(sessionId) {
  return sessionId ? String(sessionId).trim() : null;
}

/**
 * Lưu một message ngắn hạn vào memory session
 * @param {string} sessionId
 * @param {string} role - "user" | "assistant"
 * @param {string} text - nội dung message
 * @param {number} maxEntries - số lượng tối đa message lưu
 */
export async function addToMemory(sessionId, role, text, maxEntries = DEFAULT_MAX) {
  const sessionIdStr = normalizeSessionId(sessionId);
  if (!sessionIdStr) return;

  const db = await getDb();
  const col = db.collection(DEFAULT_COLLECTION);

  const entry = { role, text, createdAt: new Date() };

  await col.updateOne(
    { sessionId: sessionIdStr },
    {
      $setOnInsert: { sessionId: sessionIdStr, entries: [] },
      $push: { entries: { $each: [entry], $slice: -maxEntries } },
    },
    { upsert: true }
  );
}

/**
 * Lấy mảng các message ngắn hạn cho session
 * @param {string} sessionId
 * @param {number} limit - lấy tối đa bao nhiêu message
 * @returns {Array<{role: string, text: string, createdAt: Date}>}
 */
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

/**
 * Xóa toàn bộ memory của một session
 * @param {string} sessionId
 */
export async function clearMemory(sessionId) {
  const sessionIdStr = normalizeSessionId(sessionId);
  if (!sessionIdStr) return;

  const db = await getDb();
  const col = db.collection(DEFAULT_COLLECTION);
  await col.deleteOne({ sessionId: sessionIdStr });
}
