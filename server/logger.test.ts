import { redact } from "./logger.js";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

const s1 = redact("api_key=SAM-60d8b144-9eb0-46f6-b38f-667d8056b39d failed");
assert(!s1.includes("60d8b144"), "redacts SAM key form");
assert(s1.includes("[REDACTED]"), "placeholder present");

const s2 = redact("FAC_API_KEY=abc123secret&x=1");
assert(!s2.includes("abc123secret"), "redacts env assignment");

const s3 = redact("Bearer super-secret-token rest");
assert(!s3.includes("super-secret-token"), "redacts bearer");

const s4 = redact("normal error message");
assert(s4 === "normal error message", "leaves normal text");

console.log("logger tests passed");
