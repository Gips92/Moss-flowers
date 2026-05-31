import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.OPENROUTER_API_KEY;
const MODEL = process.env.OPENROUTER_MODEL || "google/gemini-3.1-flash-image-preview";
const EST_COST = Number(process.env.EST_COST_PER_IMAGE || 0.07); // ориентир стоимости 1 картинки, $
const ACCESS_PASSWORD = process.env.ACCESS_PASSWORD || "";
const BASE = "https://openrouter.ai/api/v1";

const orHeaders = () => ({
  Authorization: `Bearer ${API_KEY}`,
  "Content-Type": "application/json",
  "HTTP-Referer": process.env.APP_URL || "http://localhost",
  "X-Title": "MOSS Flower Visualizer",
});

const app = express();
app.use(express.json({ limit: "30mb" }));
app.use(express.static(path.join(__dirname, "public")));

const num = (v) => (typeof v === "number" ? v : v == null ? null : Number(v));

function buildPrompt(preferences) {
  const wishes = (preferences || "").trim();
  return `Edit the first image. The first image is a room interior with a bright magenta circle drawn on it that marks where a flower arrangement should go. Take the flower arrangement from the second image and place it into the room at that marked spot. Return the edited photo as an image.

Make it photorealistic: match the room's perspective, scale, lighting direction and shadows, and add a natural contact shadow under the arrangement. Keep the same flowers, colors and shape as in the second image. Keep the rest of the room unchanged and the same framing as the first image. Completely remove the magenta marker so no trace of it remains. No text or labels in the result.${wishes ? `\n\nAdditional notes (may be in Russian, follow them): ${wishes}` : ""}`;
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, keyConfigured: Boolean(API_KEY), model: MODEL });
});

// Остаток баланса/лимита по ключу
app.get("/api/balance", async (_req, res) => {
  if (!API_KEY) return res.json({ available: false, reason: "no_key" });
  try {
    let usage = null, limit = null, remaining = null;

    // 1) Инфо по самому ключу (работает с обычным ключом)
    const kr = await fetch(`${BASE}/key`, { headers: orHeaders() });
    if (kr.ok) {
      const d = (await kr.json())?.data || {};
      usage = num(d.usage);
      limit = d.limit == null ? null : num(d.limit);
      if (d.limit_remaining != null) remaining = num(d.limit_remaining);
      else if (limit != null && usage != null) remaining = limit - usage;
    }

    // 2) Если лимита на ключе нет — пробуем остаток по аккаунту (может требовать management-ключ)
    if (remaining == null) {
      const cr = await fetch(`${BASE}/credits`, { headers: orHeaders() });
      if (cr.ok) {
        const d = (await cr.json())?.data || {};
        const tc = num(d.total_credits), tu = num(d.total_usage);
        if (tc != null && tu != null) remaining = tc - tu;
      }
    }

    const estGen = remaining != null && EST_COST > 0 ? Math.floor(remaining / EST_COST) : null;
    res.json({ available: true, remaining, usage, limit, estGen, estCost: EST_COST });
  } catch {
    res.json({ available: false, reason: "error" });
  }
});

app.post("/api/generate", async (req, res) => {
  try {
    if (ACCESS_PASSWORD && req.get("x-access-password") !== ACCESS_PASSWORD) {
      return res.status(401).json({ error: "Неверный пароль доступа." });
    }
    if (!API_KEY) {
      return res.status(500).json({ error: "На сервере не задан OPENROUTER_API_KEY." });
    }

    const {
      interiorBase64,
      interiorMime = "image/jpeg",
      compositionBase64,
      compositionMime = "image/jpeg",
      preferences = "",
    } = req.body || {};

    if (!interiorBase64 || !compositionBase64) {
      return res.status(400).json({ error: "Нужны оба изображения: интерьер и композиция." });
    }

    const body = {
      model: MODEL,
      modalities: ["image", "text"],
      image_config: { image_size: "2K" },
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: buildPrompt(preferences) },
            { type: "image_url", image_url: { url: `data:${interiorMime};base64,${interiorBase64}` } },
            { type: "image_url", image_url: { url: `data:${compositionMime};base64,${compositionBase64}` } },
          ],
        },
      ],
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120000);
    let apiRes;
    try {
      apiRes = await fetch(`${BASE}/chat/completions`, {
        method: "POST",
        headers: orHeaders(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (e) {
      clearTimeout(timeout);
      if (e?.name === "AbortError") {
        return res.status(504).json({ error: "Генерация заняла слишком много времени. Попробуйте ещё раз." });
      }
      return res.status(502).json({ error: "Не удалось связаться с OpenRouter. Проверьте интернет и повторите." });
    }
    clearTimeout(timeout);

    const data = await apiRes.json().catch(() => ({}));

    if (!apiRes.ok) {
      console.log("[generate] HTTP", apiRes.status, "| body:", JSON.stringify(data).slice(0, 500));
      const raw = data?.error?.message || `OpenRouter вернул статус ${apiRes.status}.`;
      let friendly;
      if (apiRes.status === 401 || apiRes.status === 403) {
        friendly = "Проблема с API-ключом OpenRouter: неверный ключ или нет доступа. Проверьте ключ на сервере.";
      } else if (apiRes.status === 402) {
        friendly = "Закончились кредиты OpenRouter — достигнут лимит. Пополните баланс, чтобы продолжить генерацию.";
      } else if (apiRes.status === 429) {
        friendly = "Слишком много запросов подряд. Подождите несколько секунд и повторите.";
      } else if (apiRes.status >= 500) {
        friendly = "Сервис генерации временно недоступен. Попробуйте ещё раз через минуту.";
      } else {
        friendly = raw;
      }
      return res.status(apiRes.status).json({ error: friendly, code: apiRes.status });
    }

    const msg = data?.choices?.[0]?.message || {};
    const url = (msg.images || [])[0]?.image_url?.url || null;

    console.log(
      "[generate] provider:", data?.provider,
      "| finish:", data?.choices?.[0]?.finish_reason,
      "| images:", (msg.images || []).length,
      "| text:", typeof msg.content === "string" ? msg.content.slice(0, 200) : ""
    );

    if (!url) {
      const txt = typeof msg.content === "string" ? msg.content.trim() : "";
      const finish = data?.choices?.[0]?.finish_reason;
      return res.status(422).json({
        error:
          "Модель не вернула изображение" +
          (txt ? `: ${txt.slice(0, 200)}` : ". Возможно, сработал фильтр — попробуйте другое фото или нейтральнее пожелания.") +
          (finish && !txt ? ` (${finish})` : ""),
        code: 422,
      });
    }

    res.json({ image: url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Внутренняя ошибка сервера: " + (err?.message || String(err)) });
  }
});

app.listen(PORT, () => {
  console.log(`Floral Viz (OpenRouter) запущен на http://localhost:${PORT}`);
  if (!API_KEY) console.warn("ВНИМАНИЕ: OPENROUTER_API_KEY не задан — генерация работать не будет.");
});
