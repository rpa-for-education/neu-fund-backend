# import-grants-csv.py
import pandas as pd
from pymongo import MongoClient

# 1. Đọc file CSV
csv_path = "grants-data.csv"
df = pd.read_csv(csv_path)

# 2. Kết nối MongoDB
MONGO_URI = "mongodb+srv://huycv:HuyCV20252026@fit.eab7efe.mongodb.net/"
DB_NAME = "fitneu"
COLLECTION = "fund"

client = MongoClient(MONGO_URI)
db = client[DB_NAME]
collection = db[COLLECTION]

# 3. Chuyển đổi DataFrame thành dict list
records = df.to_dict(orient="records")

# 4. Insert vào MongoDB
if records:
    collection.insert_many(records)
    print(f"✅ Đã import {len(records)} dòng vào MongoDB collection '{COLLECTION}'")
else:
    print("⚠️ Không có dữ liệu để import")

client.close()
