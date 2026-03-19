// llm.js — Ollama LLM
import axios from "axios";

//const OLLAMA_BASE = process.env.OLLAMA_BASE_URL || "https://research.neu.edu.vn/ollama/api/generate";
const OLLAMA_BASE = process.env.OLLAMA_BASE_URL || "http://host.docker.internal:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "qwen3:8b";

// ==== Map model_id → model name (Ollama) ====
export const modelMap = {
  "qwen3-8b": { provider: "ollama", model: "qwen3:8b" },
  // "qwen3-1.7b": { provider: "ollama", model: "qwen3:1.7b" },
  // "qwen3-32b": { provider: "ollama", model: "qwen3:32b" },
  // "mistral-7b": { provider: "ollama", model: "mistral:7b" },
  // "llama3.2-3b": { provider: "ollama", model: "llama3.2:3b" },
  // "qwen2.5-coder-14b": { provider: "ollama", model: "qwen2.5-coder:14b" },
  // "deepseek-coder-33b": { provider: "ollama", model: "deepseek-coder:33b" },
  // "gemma3-27b": { provider: "ollama", model: "gemma3:27b" },
  // "deepseek-r1-32b": { provider: "ollama", model: "deepseek-r1:32b" },
};

const DEFAULT_MODEL_ID = "qwen3-8b";

async function callOllama(prompt, model) {
  const base = OLLAMA_BASE.replace(/\/$/, "");
  const res = await axios.post(
    `${base}/api/chat`,
    {
      model: model || OLLAMA_MODEL,
      messages: [{ role: "user", content: prompt }],
      stream: false,
    },
    {
      headers: { "Content-Type": "application/json" },
      timeout: 120000,
    }
  );

  const msg = res.data?.message?.content;
  return typeof msg === "string" ? msg : "";
}

// ===== Hàm gọi LLM chung =====
export async function callLLM(prompt, model_id = DEFAULT_MODEL_ID) {
  const info = modelMap[model_id];
  const model = info?.model || OLLAMA_MODEL;

  console.log(`⚡ callLLM: ${model_id || "default"} → ollama/${model}`);

  try {
    const answer = await callOllama(prompt, model);

    return {
      provider: "ollama",
      model_id: model_id || DEFAULT_MODEL_ID,
      model,
      answer: answer || "",
    };
  } catch (err) {
    console.error("❌ Ollama LLM error:", err.response?.data || err.message);

    return {
      provider: "ollama",
      model_id: model_id || DEFAULT_MODEL_ID,
      model,
      answer: `❌ Lỗi gọi Ollama: ${err.message}. Kiểm tra OLLAMA_BASE_URL và model.`,
    };
  }
}