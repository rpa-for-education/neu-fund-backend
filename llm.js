import axios from "axios";

// ==== Map model_id → provider + model ====
const modelMap = {
  // OpenAI
  "gpt-4o":       { provider: "openai", model: "gpt-4o" },
  "gpt-4o-mini":  { provider: "openai", model: "gpt-4o-mini" },
  "gpt-4.1":      { provider: "openai", model: "gpt-4.1" },
  "gpt-4.1-mini": { provider: "openai", model: "gpt-4.1-mini" },

  // Gemini
  "gemini-1.5-pro":   { provider: "gemini", model: "gemini-1.5-pro" },
  "gemini-1.5-flash": { provider: "gemini", model: "gemini-1.5-flash" },

  // Qwen
  "qwen-max":   { provider: "qwen", model: "qwen-max" },
  "qwen-plus":  { provider: "qwen", model: "qwen-plus" },
  "qwen-turbo": { provider: "qwen", model: "qwen-turbo" },
};

// ===== Qwen =====
async function callQwen(prompt, model) {
  const baseUrl = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";
  const res = await axios.post(
    `${baseUrl}/chat/completions`,
    { model, messages: [{ role: "user", content: prompt }] },
    { headers: { Authorization: `Bearer ${process.env.QWEN_API_KEY}` } }
  );
  return res.data.choices?.[0]?.message?.content || "";
}

// ===== OpenAI =====
async function callOpenAI(prompt, model) {
  const res = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    { model, messages: [{ role: "user", content: prompt }] },
    { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` } }
  );
  return res.data.choices?.[0]?.message?.content || "";
}

// ===== Gemini =====
async function callGemini(prompt, model) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;
  const res = await axios.post(url, {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
  });
  return res.data.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

// ===== Hàm gọi LLM chung =====
export async function callLLM(prompt, model_id = "qwen-max") {
  const info = modelMap[model_id];
  if (!info) return { answer: `❌ Model_id '${model_id}' không được hỗ trợ` };

  try {
    let answer = "";
    if (info.provider === "qwen") answer = await callQwen(prompt, info.model);
    if (info.provider === "openai") answer = await callOpenAI(prompt, info.model);
    if (info.provider === "gemini") answer = await callGemini(prompt, info.model);

    return { provider: info.provider, model: info.model, answer };
  } catch (err) {
    return { provider: info.provider, model: info.model, answer: `❌ Lỗi: ${err.message}` };
  }
}
