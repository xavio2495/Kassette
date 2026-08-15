// Which Groq models accept a FORCED tool_choice, and do they classify sanely?
// Probed, not assumed: FCE-B's own notes record gpt-oss-20b advertising tool
// support on OpenRouter and then rejecting a named tool_choice with HTTP 400.
import { readFileSync } from "node:fs";
import path from "node:path";

const key = readFileSync(path.join(process.cwd(), "..", ".env"), "utf8")
  .split("\n").find((l) => l.startsWith("GROQ_API="))!.split("=").slice(1).join("=").trim().replace(/^["']|["']$/g, "");

const SYSTEM = readFileSync("scripts/ingest-x.ts", "utf8")
  .split("const SYSTEM_PROMPT = `")[1].split("`;")[0];

const TOOL = {
  type: "function",
  function: {
    name: "emit_trade_signal",
    description: "Emit the classification of the post.",
    parameters: {
      type: "object",
      properties: {
        template: { type: "string", enum: ["DIRECTIONAL", "TARGET_CALL", "GEM_SHILL", "NOT_A_SIGNAL"] },
        asset_symbol: { type: ["string", "null"] },
        direction: { type: ["string", "null"] },
        target_price: { type: ["number", "null"] },
        expiry_days: { type: ["number", "null"] },
        confidence: { type: "number" },
      },
      required: ["template", "asset_symbol", "direction", "target_price", "expiry_days", "confidence"],
    },
  },
};

const CASES: [string, string][] = [
  ["$PEPE about to 10x 🚀", "GEM_SHILL PEPE"],
  ["GM 😊 XRP MILLIONAIRES! Have a blessed saturday..", "NOT_A_SIGNAL  ← the false positive"],
  ["Chainlink under $10 has been a GOOD BUY for a long time, in my personal non-financial advice opinion.", "a LINK call"],
  ["🚨 XRP ARMY ALERT! White House Meets Ripple Execs", "NOT_A_SIGNAL (news)"],
];

const MODELS = ["llama-3.3-70b-versatile", "openai/gpt-oss-120b", "openai/gpt-oss-20b", "qwen/qwen3.6-27b", "llama-3.1-8b-instant"];

(async () => {
  for (const model of MODELS) {
    console.log(`\n=== ${model} ===`);
    for (const [text, expect] of CASES) {
      try {
        const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model, temperature: 0,
            messages: [{ role: "system", content: SYSTEM }, { role: "user", content: `<post>\n${text}\n</post>` }],
            tools: [TOOL],
            tool_choice: { type: "function", function: { name: "emit_trade_signal" } },
          }),
        });
        if (!res.ok) { console.log(`  ✗ HTTP ${res.status} ${(await res.text()).slice(0, 110)}`); break; }
        const b = await res.json();
        const args = b.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
        if (!args) { console.log("  ✗ no tool call"); continue; }
        const s = JSON.parse(args);
        console.log(`  ${String(s.template).padEnd(13)} ${String(s.asset_symbol ?? "-").padEnd(6)} conf=${s.confidence}   expect: ${expect}`);
      } catch (e) { console.log("  ✗", (e as Error).message.slice(0, 90)); break; }
    }
  }
})();
