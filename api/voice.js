// 入力は2通り:
//  (A) テキスト(JSON: { text, history }) … ブラウザの常時聞き取りで文字になったもの
//  (B) 録音データ(application/octet-stream) … 常時聞き取りが使えない端末のための予備
// 返答は2通り:
//  ・最新の情報が必要そうな質問 → Gemini（Google検索つき）。キー未設定・失敗時はGroqに切り替え
//  ・それ以外 → Groq（速い）
const GROQ = "https://api.groq.com/openai/v1";
const GEMINI = "https://generativelanguage.googleapis.com/v1beta/models";

// Groq/Geminiのエラー内容を、短い文字列にして返す（画面に表示して原因が分かるように）
async function errMsg(r) {
  const t = await r.text();
  try { return String(JSON.parse(t).error.message).slice(0, 200); } catch (_) { return t.slice(0, 200); }
}

// 読み上げ用に、記号・番号・URLを取り除く
const clean = (s) =>
  String(s || "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\[\d+(?:\s*,\s*\d+)*\]/g, "")
    .replace(/[*#_`>|]/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();

// 最新の情報が必要そうな質問かどうか
const LIVE = /天気|気温|降水|降る|雨|雪|台風|ニュース|速報|最新|株価|為替|レート|円相場|ビットコイン|試合|スコア|結果|ランキング|発売|調べて|検索|ググ|口コミ|営業時間|現在|今の|今日の|明日の|明後日|今週|来週|今年|今月|\d{4}年/;
const needsSearch = (t) => LIVE.test(t);

async function geminiSearch({ key, model, system, history, text }) {
  const contents = [
    ...history.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: String(m.content || "").slice(0, 500) }],
    })),
    { role: "user", parts: [{ text }] },
  ];
  const r = await fetch(`${GEMINI}/${model}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents,
      tools: [{ google_search: {} }],
      generationConfig: { temperature: 0.4 },
    }),
  });
  if (!r.ok) throw new Error(`Gemini ${r.status}: ${await errMsg(r)}`);
  const j = await r.json();
  const parts = (j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || [];
  const out = parts.filter((p) => p.text && !p.thought).map((p) => p.text).join("");
  if (!out.trim()) throw new Error("Geminiの返答が空でした");
  return clean(out);
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST only" });
  }

  const key = (process.env.GROQ_API_KEY || "").trim();
  if (!key) {
    return res.status(500).json({ error: "GROQ_API_KEY が未設定です" });
  }

  // 合言葉（任意）。APP_PASSCODE を設定した場合だけチェックする
  const pass = process.env.APP_PASSCODE;
  if (pass && req.headers["x-passcode"] !== pass) {
    return res.status(401).json({ error: "合言葉が違います" });
  }

  try {
    let heard = "";
    let history = [];

    if (Buffer.isBuffer(req.body)) {
      // (B) 録音データ → 文字起こし
      const audio = req.body;
      if (audio.length < 1000) {
        return res.status(400).json({ error: "音声が短すぎます" });
      }
      const mime = req.headers["x-mime"] || "audio/webm";
      const ext = mime.includes("mp4") ? "m4a" : mime.includes("ogg") ? "ogg" : "webm";
      const form = new FormData();
      form.append("file", new Blob([audio], { type: mime }), `voice.${ext}`);
      form.append("model", process.env.GROQ_STT_MODEL || "whisper-large-v3-turbo");
      form.append("language", "ja");
      form.append("response_format", "json");

      const sttRes = await fetch(`${GROQ}/audio/transcriptions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}` },
        body: form,
      });
      if (!sttRes.ok) {
        return res.status(502).json({ error: "文字起こしに失敗しました", status: sttRes.status, detail: await errMsg(sttRes) });
      }
      heard = ((await sttRes.json()).text || "").trim();
      try {
        const raw = req.headers["x-history"];
        if (raw) history = JSON.parse(decodeURIComponent(raw));
      } catch (_) {}
    } else if (req.body && typeof req.body.text === "string") {
      // (A) テキスト
      heard = req.body.text.trim().slice(0, 1000);
      if (Array.isArray(req.body.history)) history = req.body.history;
    } else {
      return res.status(400).json({ error: "入力が不正です" });
    }

    if (!heard) {
      return res.status(200).json({ heard: "", reply: "" });
    }
    history = history.slice(-6);

    const now = new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
    let city = "";
    try { city = decodeURIComponent(req.headers["x-vercel-ip-city"] || ""); } catch (_) {}
    const place = city
      ? `ユーザーのおおよその現在地（通信回線からの推定）: ${city}。ユーザーが場所を言ったら、そちらを優先してください。`
      : "";
    const baseSystem = [
      "あなたの名前はジャービスで、ユーザー専属のAI秘書です。",
      "声で会話しているので、返答は自然な話し言葉で、1〜3文の短さにしてください。",
      "箇条書き、記号、マークダウン、絵文字、URL、出典の番号は使わないでください（読み上げられるため）。",
      "音声認識の誤変換が混じることがあるので、意味が通るように汲み取ってください。",
      "分からないことは分からないと正直に言い、できないことは、できないと伝えてください。",
      `現在の日時（日本時間）: ${now}`,
      place,
    ].filter(Boolean).join("\n");

    let reply = "";
    let searched = false;
    let searchError = "";
    const live = needsSearch(heard);

    // 1) 最新の情報が必要そうなら、Gemini（Google検索つき）
    if (live) {
      const gKey = (process.env.GEMINI_API_KEY || "").trim();
      if (!gKey) {
        searchError = "GEMINI_API_KEY が未設定です";
      } else {
        try {
          reply = await geminiSearch({
            key: gKey,
            model: process.env.GEMINI_MODEL || "gemini-3.5-flash-lite",
            system: baseSystem + "\nGoogle検索で最新の情報を調べて、要点だけを答えてください。",
            history,
            text: heard,
          });
          searched = true;
        } catch (e) {
          searchError = String((e && e.message) || e).slice(0, 200);
        }
      }
    }

    // 2) それ以外（または検索できなかったとき）は、Groq
    if (!reply) {
      const system = live
        ? baseSystem + "\nこの質問は最新の情報が必要かもしれませんが、今は検索できません。推測で答えず、今は調べられないと伝えてください。"
        : baseSystem;
      const messages = [
        { role: "system", content: system },
        ...history.map((m) => ({
          role: m.role === "assistant" ? "assistant" : "user",
          content: String(m.content || "").slice(0, 500),
        })),
        { role: "user", content: heard },
      ];

      const chatRes = await fetch(`${GROQ}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: process.env.GROQ_CHAT_MODEL || "llama-3.3-70b-versatile",
          messages,
          temperature: 0.6,
          max_tokens: 300,
        }),
      });
      if (!chatRes.ok) {
        return res.status(502).json({ error: "返答の生成に失敗しました", status: chatRes.status, detail: await errMsg(chatRes) });
      }
      reply = clean((((await chatRes.json()).choices || [])[0] || {}).message?.content || "");
    }

    return res.status(200).json({ heard, reply, searched, searchError });
  } catch (e) {
    return res.status(500).json({ error: "サーバーエラー", detail: String(e) });
  }
};
