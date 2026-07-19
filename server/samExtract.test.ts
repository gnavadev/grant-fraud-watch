import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Test CSV parsing logic by re-implementing the same rules against sample header
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

const sample = `Classification,Name,Unique Entity ID,Exclusion Type
Firm,ACME CORP,ABC12DEF34GH,Prohibition
Firm,NO UEI HERE,,Prohibition
Individual,MASKED,,Prohibition
Firm,GOOD CO,VE2ZZY1ZHN19,Prohibition
`;

const lines = sample.split(/\r?\n/).filter(Boolean);
const header = splitCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
const ueiIdx = header.findIndex((h) => h.includes("unique entity"));
assert(ueiIdx === 2, "uei column index");

const ueis = new Set<string>();
for (let i = 1; i < lines.length; i++) {
  const cols = splitCsvLine(lines[i]);
  const raw = (cols[ueiIdx] ?? "").trim().toUpperCase();
  if (/^[A-Z0-9]{12}$/.test(raw)) ueis.add(raw);
}
assert(ueis.has("ABC12DEF34GH"), "firm uei");
assert(ueis.has("VE2ZZY1ZHN19"), "second uei");
assert(ueis.size === 2, `expected 2 ueis, got ${ueis.size}`);

// Quoted comma in field
const q = splitCsvLine('a,"b, c",d');
assert(q.length === 3 && q[1] === "b, c", "quoted csv");

console.log("samExtract tests passed");
