import { parseLocation, parseLocationString } from "./location.js";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

// Object form (current USAspending)
const obj = parseLocation({
  city_name: "HOUSTON",
  county_name: "HARRIS",
  state_code: "TX",
});
assert(obj.city === "Houston", `city title case, got ${obj.city}`);
assert(obj.county?.toLowerCase().includes("harris") ?? false, "county");
assert(obj.state === "TX", "state TX");

// Legacy string
const s = parseLocationString("HOUSTON, HARRIS, TX");
assert(s.state === "TX", "string state");
assert(s.city === "Houston", `string city ${s.city}`);

// City + state only
const cs = parseLocationString("Austin, TX");
assert(cs.city === "Austin" && cs.state === "TX" && cs.county == null, "city state");

// Empty
const empty = parseLocation(null);
assert(empty.city == null && empty.state == null, "null location");

// Junk
const junk = parseLocationString("   ");
assert(junk.state == null, "blank");

console.log("location tests passed");
