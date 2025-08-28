// fetch-grants.js
import fetch from "node-fetch";
import { MongoClient } from "mongodb";

const MONGO_URI = "mongodb+srv://huycv:HuyCV20252026@fit.eab7efe.mongodb.net/";
const DB_NAME = "fitneu";

async function fetchGrants() {
  const url = "https://www.grants.gov/grantsws/rest/opportunities/search?keyword=AI";
  const res = await fetch(url);
  const data = await res.json();

  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db(DB_NAME);

  const grants = data.opportunities.map(g => ({
    id: g.opportunityId,
    title: g.title,
    agency: g.agency,
    deadline: g.closeDate,
    description: g.description,
    url: g.opportunityLink,
    last_updated: new Date()
  }));

  await db.collection("grants_raw").insertMany(grants);
  console.log(`Inserted ${grants.length} grants`);
  await client.close();
}

fetchGrants();
