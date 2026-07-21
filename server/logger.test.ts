import { redact } from "./logger.js";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

// Obviously fake key shape only (never use a real SAM key in tests)
const s1 = redact("api_key=SAM-00000000-1111-2222-3333-444444444444 failed");
assert(!s1.includes("00000000-1111"), "redacts SAM key form");
assert(s1.includes("[REDACTED]"), "placeholder present");

const s2 = redact("FAC_API_KEY=abc123secret&x=1");
assert(!s2.includes("abc123secret"), "redacts env assignment");

const s3 = redact("Bearer super-secret-token rest");
assert(!s3.includes("super-secret-token"), "redacts bearer");

const s4 = redact("normal error message");
assert(s4 === "normal error message", "leaves normal text");

console.log("logger tests passed");
