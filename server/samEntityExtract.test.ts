import { parseEntityDataLine } from "./samEntityExtract.js";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

// BOF / EOF skip
assert(parseEntityDataLine("BOF PUBLIC V2 00000000 20200414") === null, "bof");
assert(parseEntityDataLine("EOF PUBLIC V2 00000000") === null, "eof");
assert(parseEntityDataLine("") === null, "empty");

// Sample-style PUBLIC V2 data row (pipe-delimited)
const row =
  "VE2ZZY1ZHN19|928338656||81341||A|Z4|20061102|20201217|20200128|20191218|ORANGE COUNTY HEALTH CARE AGENCY|F A A|||123 TESTING ST||WASHINGTON|DC|20591|0001|USA|98|Y|20060920|0930||2A|||0003|2R~NG~QW|481211|0004|481211N~488111N~488119N~541611N|0000||N||1234 TEST LN||WASHINGTON|20591|0004|USA|DC|";

const parsed = parseEntityDataLine(row);
assert(parsed != null, "parsed");
assert(parsed!.uei === "VE2ZZY1ZHN19", `uei ${parsed!.uei}`);
assert(parsed!.registrationStatus === "A", "status A");
assert(parsed!.registrationDate === "2006-11-02", `reg ${parsed!.registrationDate}`);
assert(parsed!.expirationDate === "2020-12-17", `exp ${parsed!.expirationDate}`);
assert(
  parsed!.legalBusinessName === "ORANGE COUNTY HEALTH CARE AGENCY",
  `name ${parsed!.legalBusinessName}`,
);

// Tilde multi-value groups should not break column positions for early fields
const withTilde =
  "ABC12DEF34GH||||||||20010101|20250101|||ACME CORP||";
// too few fields after split - need 12+ fields
const padded =
  "ABC12DEF34GH|x||y||A|Z|20010101|20250101|x|x|ACME CORP|rest";
const p2 = parseEntityDataLine(padded);
assert(p2?.uei === "ABC12DEF34GH", "uei2");
assert(p2?.legalBusinessName === "ACME CORP", "name2");

console.log("samEntityExtract tests passed");
