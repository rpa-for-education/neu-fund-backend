// db.js
import { MongoClient } from "mongodb";
import "dotenv/config";

const URI = process.env.MONGO_URI || process.env.MONGODB_URI;
const DBNAME = process.env.MONGO_DB || process.env.MONGODB_DB || "fitneu";

let _client;
let _db;

export async function getDb() {
  if (_db) return _db;
  if (!URI) throw new Error("❌ Missing MONGO_URI/MONGODB_URI");
  _client = new MongoClient(URI, {
    serverSelectionTimeoutMS: 60000,
    socketTimeoutMS: 60000,
    connectTimeoutMS: 60000,
  });
  await _client.connect();
  _db = _client.db(DBNAME);
  console.log(`✅ MongoDB connected → DB: ${DBNAME}`);
  return _db;
}

export async function closeDb() {
  if (_client) {
    await _client.close();
    _client = null;
    _db = null;
    console.log("🔌 MongoDB connection closed");
  }
}
