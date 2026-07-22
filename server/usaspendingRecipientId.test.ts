import {
  usaspendingRecipientHashFromUei,
  usaspendingRecipientIdFromUei,
} from "./usaspendingRecipientId.js";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

assert(
  usaspendingRecipientHashFromUei("JE73CDQUAPA7") ===
    "7fe0d08f-685f-a9cc-f9f6-f9e6c6c20e22",
  "JE73 base hash",
);
assert(
  usaspendingRecipientIdFromUei("JE73CDQUAPA7") ===
    "7fe0d08f-685f-a9cc-f9f6-f9e6c6c20e22-C",
  "JE73 -C id",
);
assert(
  usaspendingRecipientHashFromUei("CF2QLVHJTBD7") ===
    "4e05ba89-8df7-4eeb-0f35-e5b880ee03e4",
  "PIT RIVER base hash",
);
assert(
  usaspendingRecipientIdFromUei("CF2QLVHJTBD7", "C") ===
    "4e05ba89-8df7-4eeb-0f35-e5b880ee03e4-C",
  "PIT RIVER profile id",
);
assert(
  usaspendingRecipientIdFromUei("cf2qlvhjtbd7") ===
    usaspendingRecipientIdFromUei("CF2QLVHJTBD7"),
  "case normalize",
);
assert(usaspendingRecipientIdFromUei("short") === null, "invalid uei");
assert(usaspendingRecipientIdFromUei("") === null, "empty");

console.log("usaspendingRecipientId tests passed");
