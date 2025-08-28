import os
import sys
from dotenv import load_dotenv
from pymongo import MongoClient
from qdrant_client import QdrantClient
from qdrant_client.http import models as rest
from sentence_transformers import SentenceTransformer
from bson import ObjectId
from tqdm import tqdm

# Load biến môi trường
load_dotenv()

MONGO_URI = os.getenv("MONGO_URI")
MONGO_DB = os.getenv("MONGO_DB")
MONGO_COLLECTION = os.getenv("MONGO_COLLECTION")

QDRANT_URL = os.getenv("QDRANT_URL")
QDRANT_API_KEY = os.getenv("QDRANT_API_KEY")
QDRANT_COLLECTION = os.getenv("QDRANT_COLLECTION")

EMBEDDING_MODEL = os.getenv("EMBEDDING_MODEL", "all-MiniLM-L6-v2")

def to_serializable(doc):
    """Chuyển ObjectId -> str để tránh lỗi serialization"""
    if isinstance(doc, dict):
        return {k: to_serializable(v) for k, v in doc.items()}
    elif isinstance(doc, list):
        return [to_serializable(v) for v in doc]
    elif isinstance(doc, ObjectId):
        return str(doc)
    return doc

print("🔗 Connecting to MongoDB...")
mongo_client = MongoClient(MONGO_URI)
db = mongo_client[MONGO_DB]
collection = db[MONGO_COLLECTION]
print("✅ Connected to MongoDB")

print("🔗 Connecting to Qdrant...")
qdrant = QdrantClient(url=QDRANT_URL, api_key=QDRANT_API_KEY)
print("✅ Connected to Qdrant")

print("🔗 Loading embedding model...")
model = SentenceTransformer(EMBEDDING_MODEL)
print("✅ Model loaded")

print("📦 Loading documents from MongoDB...")
docs = list(collection.find({}))
print(f"✅ Found {len(docs)} documents")

# Reset collection
print(f"🗑️ Collection '{QDRANT_COLLECTION}' sẽ được reset...")
if qdrant.collection_exists(QDRANT_COLLECTION):
    qdrant.delete_collection(QDRANT_COLLECTION)

qdrant.create_collection(
    collection_name=QDRANT_COLLECTION,
    vectors_config=rest.VectorParams(
        size=model.get_sentence_embedding_dimension(),
        distance=rest.Distance.COSINE,
    ),
)
print(f"✅ Collection '{QDRANT_COLLECTION}' ready")

# Batch insert
batch_size = 100
print(f"📤 Inserting {len(docs)} documents vào Qdrant (batch size={batch_size})...")

for i in tqdm(range(0, len(docs), batch_size)):
    batch = docs[i : i + batch_size]

    payloads, vectors, ids = [], [], []

    for j, doc in enumerate(batch):
        doc = to_serializable(doc)

        # Lấy toàn bộ text từ tất cả các field
        text_parts = []
        for k, v in doc.items():
            if isinstance(v, str):
                text_parts.append(v)
            elif isinstance(v, list):
                text_parts.extend([str(x) for x in v if isinstance(x, (str, int, float))])
            elif isinstance(v, (int, float)):
                text_parts.append(str(v))

        full_text = " ".join(text_parts).strip()
        if not full_text:
            continue

        vector = model.encode(full_text).tolist()

        # ID = int index toàn cục
        ids.append(i + j)

        # Payload = toàn bộ doc (bao gồm cả _id gốc đã stringify)
        payloads.append(doc)
        vectors.append(vector)

    if payloads:
        qdrant.upsert(
            collection_name=QDRANT_COLLECTION,
            points=rest.Batch(
                ids=ids,
                vectors=vectors,
                payloads=payloads,
            ),
        )

print("✅ Done! All documents inserted into Qdrant.")
