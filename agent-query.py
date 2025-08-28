# agent-query.py
from qdrant_client import QdrantClient
from openai import OpenAI
import os

client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))
qdrant = QdrantClient("localhost", port=6333)
collection_name = "grants_embeddings"

def search_grants(query):
    embedding = client.embeddings.create(
        input=query,
        model="text-embedding-3-small"
    ).data[0].embedding

    results = qdrant.search(
        collection_name=collection_name,
        query_vector=embedding,
        limit=3
    )
    return results

def answer_query(user_query):
    results = search_grants(user_query)
    context = "\n\n".join([r.payload["title"] + ": " + r.payload["description"] for r in results])

    prompt = f"""
    You are a funding assistant. User asked: "{user_query}".
    Based on the following grant opportunities, give a helpful answer:

    {context}
    """

    response = client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[{"role":"user", "content":prompt}]
    )

    return response.choices[0].message.content

if __name__ == "__main__":
    print(answer_query("Cơ hội tài trợ về AI trong y tế"))
