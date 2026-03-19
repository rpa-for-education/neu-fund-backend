// llm.js
import axios from "axios";

// ==== Map model_id → provider + model ====
const modelMap = {
  // OpenAI
  "gpt-smart": { provider: "openai", model: "gpt-5-mini" },
  // "gpt-pro": { provider: "openai", model: "gpt-5" },
  "gpt-fast": { provider: "openai", model: "gpt-4.1-mini" },

  // Gemini
  "gemini-smart": { provider: "gemini", model: "gemini-2.5-flash" },
  "gemini-fast": { provider: "gemini", model: "gemini-2.5-flash-lite" },
  
  // Qwen
  // "qwen-smart": { provider: "qwen", model: "qwen-plus" },
  // "qwen-pro": { provider: "qwen", model: "qwen-max" },
  // "qwen-fast": { provider: "qwen", model: "qwen-flash" },
};

// ===== OpenAI =====
/* Phiên bản cũ POST /v1/chat/completions
async function callOpenAI(prompt, model) {
  const res = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    {
      model,
      messages: [{ role: "user", content: prompt }],
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      timeout: 30000,
    }
  );

  return res.data.choices?.[0]?.message?.content || "";
}
*/
/* Phiên bản mới POST /v1/responses */
function extractOpenAIText(data) {
  // shortcut (GPT-4.1 thường có)
  if (data.output_text) return data.output_text;

  // fallback chuẩn cho GPT-5
  const output = data.output || [];

  let text = "";

  for (const item of output) {
    if (!item.content) continue;

    for (const c of item.content) {
      if (c.type === "output_text" && c.text) {
        text += c.text;
      }
    }
  }

  return text;
}

async function callOpenAI(prompt, model) {
  const res = await axios.post(
    "https://api.openai.com/v1/responses",
    {
      model,
      input: prompt
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      timeout: model.startsWith("gpt-5") ? 90000 : 30000,
    }
  );

  return extractOpenAIText(res.data);
}


// ===== Gemini =====
/* Phiên bản cũ Gemini
async function callGemini(prompt, model) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;

  const res = await axios.post(
    url,
    {
      contents: [
        {
          role: "user",
          parts: [{ text: prompt }],
        },
      ],
    },
    {
      headers: { "Content-Type": "application/json" },
      timeout: 30000,
    }
  );

  return res.data.candidates?.[0]?.content?.parts?.[0]?.text || "";
}
*/

// Phiên bản mới Gemini cho đồng nhất với OpenAI
async function callGemini(prompt, model) {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent` +
    `?key=${process.env.GEMINI_API_KEY}`;

  const res = await axios.post(
    url,
    {
      contents: [
        {
          role: "user",
          parts: [{ text: prompt }]
        }
      ]
    },
    {
      headers: { "Content-Type": "application/json" },
      timeout: 30000
    }
  );

  const parts = res.data.candidates?.[0]?.content?.parts || [];
  return parts.map(p => p.text || "").join("");
}

// ===== Qwen =====
async function callQwen(prompt, model) {
  const baseUrl = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";

  const res = await axios.post(
    `${baseUrl}/chat/completions`,
    {
      model,
      messages: [{ role: "user", content: prompt }],
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.QWEN_API_KEY}`,
        "Content-Type": "application/json",
      },
      timeout: 30000,
    }
  );

  return res.data.choices?.[0]?.message?.content || "";
}


// ===== Hàm gọi LLM chung =====
export async function callLLM(prompt, model_id = "gpt-smart") {
  const info = modelMap[model_id];

  if (!info) {
    return {
      provider: null,
      model_id,
      model: null,
      answer: `❌ Model_id '${model_id}' không được hỗ trợ`,
    };
  }

  console.log(`⚡ callLLM: ${model_id} → ${info.provider}/${info.model}`);

  try {
    let answer = "";

    switch (info.provider) {
      case "openai":
        answer = await callOpenAI(prompt, info.model);
        break;
      case "gemini":
        answer = await callGemini(prompt, info.model);
        break;
      //case "qwen":
      //  answer = await callQwen(prompt, info.model);
      //  break;
    }

    return {
      provider: info.provider,
      model_id,
      model: info.model,
      answer,
    };

  } catch (err) {
    console.error("❌ LLM error:", err.response?.data || err.message);

    return {
      provider: info.provider,
      model_id,
      model: info.model,
      answer: `❌ Lỗi gọi ${info.provider}: ${err.message}`,
    };
  }
}