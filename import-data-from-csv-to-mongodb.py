#!/usr/bin/env python3
"""
import-data-from-csv-to-mongodb.py

- Đọc CSV (mặc định grants-data.csv hoặc truyền tên file như arg1)
- Chuẩn hóa và ghép nhiều trường văn bản "giàu ngữ nghĩa" để embedding
- Điền u_key cho các document hiện có nếu thiếu
- Tạo unique index cho u_key (sau khi đảm bảo không còn null/duplicate)
- Upsert các bản ghi CSV (set tất cả trường + vector)
"""

import os
import re
import sys
import math
import hashlib
import pandas as pd
from tqdm import tqdm
from dotenv import load_dotenv
from pymongo import MongoClient, UpdateOne
from sentence_transformers import SentenceTransformer

# -------------------------
# Cấu hình / env
# -------------------------
load_dotenv()
CSV_PATH = sys.argv[1] if len(sys.argv) > 1 else "grants-data.csv"

MONGO_URI = os.getenv("MONGO_URI") or os.getenv("MONGODB_URI")
MONGO_DB = os.getenv("MONGO_DB") or os.getenv("MONGODB_DB") or "fitneu"
MONGO_COLLECTION = os.getenv("MONGO_COLLECTION", "fund")

EMBEDDING_MODEL = os.getenv("EMBEDDING_MODEL", "paraphrase-multilingual-mpnet-base-v2")
# Nếu bạn đặt EMBEDDING_MODEL = "Xenova/paraphrase-..." ở .env, script sẽ tự remove phần "Xenova/"
if EMBEDDING_MODEL.lower().startswith("xenova/"):
    EMBEDDING_MODEL = EMBEDDING_MODEL.split("/", 1)[1]

BATCH_SIZE = int(os.getenv("BATCH_SIZE", "64"))
BATCH_UPSERT = int(os.getenv("BATCH_UPSERT", "128"))

if not MONGO_URI:
    raise RuntimeError("MONGO_URI (hoặc MONGODB_URI) chưa được đặt trong .env")

# -------------------------
# Helpers
# -------------------------
HYPERLINK_RE = re.compile(r'^\s*=\s*HYPERLINK\(\s*"([^"]+)"\s*,\s*"([^"]+)"\s*\)\s*$', re.I)

def is_nan(v):
    return v is None or (isinstance(v, float) and math.isnan(v))

def to_str(v):
    if is_nan(v): return ""
    return str(v).strip()

def parse_hyperlink(cell):
    s = to_str(cell)
    if not s: return (None, "")
    m = HYPERLINK_RE.match(s)
    if m:
        return (m.group(1), m.group(2))
    return (None, s)

def make_u_key(record, code):
    # ưu tiên code (OPPORTUNITY CODE) hoặc code từ OPPORTUNITY NUMBER hyperlink
    title = to_str(record.get("OPPORTUNITY TITLE", ""))[:200]
    agency_code = to_str(record.get("AGENCY CODE", ""))[:50]
    base = (to_str(code) or f"{title}::{agency_code}").lower().strip()
    return hashlib.sha1(base.encode("utf-8")).hexdigest()

def build_text_for_embedding(r):
    # Ghép nhiều trường quan trọng (loại bỏ None/NaN)
    fields = [
        r.get("OPPORTUNITY TITLE"),
        r.get("SYNOPSIS"),
        r.get("SYNOPSIS DESCRIPTION"),
        r.get("FUNDING DESCRIPTION"),
        r.get("ELIGIBLE APPLICANTS"),
        r.get("CATEGORY OF FUNDING ACTIVITY"),
        r.get("FUNDING CATEGORY EXPLANATION"),
        r.get("FUNDING INSTRUMENT TYPE"),
        r.get("ASSISTANCE LISTINGS"),
        r.get("AGENCY NAME"),
        r.get("AGENCY CODE"),
        r.get("COST SHARING / MATCH REQUIREMENT"),
        r.get("OPPORTUNITY STATUS"),
        r.get("OPPORTUNITY PACKAGE"),
        r.get("GRANTOR CONTACT"),
        r.get("GRANTOR CONTACT EMAIL"),
        r.get("LINK TO ADDITIONAL INFORMATION"),
        r.get("ESTIMATED TOTAL FUNDING"),
        r.get("EXPECTED NUMBER OF AWARDS"),
        r.get("AWARD CEILING"),
        r.get("AWARD FLOOR"),
        r.get("POSTED DATE"),
        r.get("CLOSE DATE"),
    ]
    parts = [to_str(x) for x in fields if to_str(x)]
    # limit length to avoid extremely long strings
    joined = " | ".join(parts)
    return joined[:16000]  # hạn chế chuỗi quá dài nếu cần

# -------------------------
# Kết nối Mongo
# -------------------------
print("🔗 Connecting to MongoDB...")
client = MongoClient(MONGO_URI)
db = client[MONGO_DB]
col = db[MONGO_COLLECTION]
print(f"✅ Connected → {MONGO_DB}.{MONGO_COLLECTION}")

# -------------------------
# 1) Điền u_key cho docs hiện có nếu thiếu
# -------------------------
print("🧭 Step 1 — Ensure existing documents have u_key (fill missing)...")
cursor_missing = col.find(
    {"$or": [{"u_key": {"$exists": False}}, {"u_key": None}, {"u_key": ""}]},
    projection=["OPPORTUNITY NUMBER", "OPPORTUNITY TITLE", "AGENCY CODE"]
)

ops = []
count_missing = 0
for doc in cursor_missing:
    count_missing += 1
    url, code = parse_hyperlink(doc.get("OPPORTUNITY NUMBER"))
    # if 'OPPORTUNITY CODE' already present in doc prefer it
    code = doc.get("OPPORTUNITY CODE") or code
    ukey = make_u_key(doc, code)
    ops.append(UpdateOne({"_id": doc["_id"]}, {"$set": {"u_key": ukey}}))
    if len(ops) >= BATCH_UPSERT:
        col.bulk_write(ops, ordered=False)
        ops = []
if ops:
    col.bulk_write(ops, ordered=False)
print(f"   → Filled u_key for {count_missing} existing docs (if any).")

# -------------------------
# 2) Detect duplicates on u_key and fix by appending short suffix if any duplicates
# -------------------------
print("🔎 Checking duplicate u_key groups...")
dup_pipeline = [
    {"$group": {"_id": "$u_key", "count": {"$sum": 1}, "ids": {"$push": "$_id"}}},
    {"$match": {"_id": {"$ne": None}, "count": {"$gt": 1}}}
]
dups = list(col.aggregate(dup_pipeline))
if dups:
    print(f"⚠️ Found {len(dups)} duplicate u_key groups — fixing by making keys unique per document.")
    ops = []
    for group in dups:
        ukey = group["_id"]
        ids = group["ids"]
        # for each id, append short suffix of its ObjectId hex to make unique
        for oid in ids:
            suffix = str(oid)[-6:]
            new_key = f"{ukey}-{suffix}"
            ops.append(UpdateOne({"_id": oid}, {"$set": {"u_key": new_key}}))
            if len(ops) >= BATCH_UPSERT:
                col.bulk_write(ops, ordered=False)
                ops = []
    if ops:
        col.bulk_write(ops, ordered=False)
    print("   → Duplicates fixed (u_key made unique).")
else:
    print("   → No duplicate u_key found.")

# -------------------------
# 3) Create unique index on u_key (only for non-null strings)
# -------------------------
print("🔧 Creating unique index on u_key (if not exists)...")
try:
    # partialFilterExpression để chỉ index những doc có u_key là chuỗi (loại bỏ null)
    col.create_index([("u_key", 1)], unique=True, partialFilterExpression={"u_key": {"$type": "string"}})
    print("✅ Unique index on u_key created/ensured.")
except Exception as e:
    print("❌ create_index(u_key) failed:", e)
    print("   → Continuing; index may already exist or need manual intervention.")

# -------------------------
# 4) Load embedding model (sentence-transformers)
# -------------------------
print(f"⏳ Loading embedding model: {EMBEDDING_MODEL} (this may download the model first time)")
model = SentenceTransformer(EMBEDDING_MODEL)
print("✅ Embedding model ready.")

# -------------------------
# 5) Read CSV and upsert with vector
# -------------------------
print(f"📄 Loading CSV: {CSV_PATH}")
df = pd.read_csv(CSV_PATH)
records = df.to_dict(orient="records")
print(f"📦 {len(records)} rows in CSV")

ops = []
buf_texts = []
buf_docs = []
processed = 0
for rec in tqdm(records, desc="Processing CSV"):
    # Normalize record fields (remove NaN)
    doc = {k: v for k, v in rec.items() if not is_nan(v)}

    # parse hyperlink in OPPORTUNITY NUMBER
    url, code = parse_hyperlink(doc.get("OPPORTUNITY NUMBER"))
    if url:
        doc["OPPORTUNITY URL"] = url
    if code:
        doc["OPPORTUNITY CODE"] = code

    # build u_key
    ukey = make_u_key(doc, doc.get("OPPORTUNITY CODE") or code)
    doc["u_key"] = ukey

    # Prepare text for embedding
    text = build_text_for_embedding(doc)
    if not text:
        # fallback minimal text
        text = to_str(doc.get("OPPORTUNITY TITLE") or doc.get("OPPORTUNITY NUMBER") or doc.get("OPPORTUNITY CODE") or ukey)

    buf_docs.append(doc)
    buf_texts.append(text)

    if len(buf_docs) >= BATCH_SIZE:
        vectors = model.encode(buf_texts, batch_size=BATCH_SIZE, show_progress_bar=False, convert_to_numpy=True, normalize_embeddings=True)
        for vec, d in zip(vectors, buf_docs):
            d["vector"] = [float(x) for x in vec]
            ops.append(UpdateOne({"u_key": d["u_key"]}, {"$set": d}, upsert=True))
        if ops:
            res = col.bulk_write(ops, ordered=False)
            print(f"   ↑ Upserted batch: upserted={res.upserted_count}, modified={res.modified_count}")
        ops = []
        buf_docs = []
        buf_texts = []

processed = 0
# flush remaining
if buf_docs:
    vectors = model.encode(buf_texts, batch_size=BATCH_SIZE, show_progress_bar=False, convert_to_numpy=True, normalize_embeddings=True)
    for vec, d in zip(vectors, buf_docs):
        d["vector"] = [float(x) for x in vec]
        ops.append(UpdateOne({"u_key": d["u_key"]}, {"$set": d}, upsert=True))
    if ops:
        res = col.bulk_write(ops, ordered=False)
        print(f"   ↑ Upserted final batch: upserted={res.upserted_count}, modified={res.modified_count}")

print("✅ All done. CSV imported and vectors stored in MongoDB.")
client.close()
