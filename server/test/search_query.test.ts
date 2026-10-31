/** The one search grammar every list uses (web/src/lib/search.ts): ids, voucher numbers, field:value, dates, number ranges. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { matchRow } from "../../web/src/lib/search.js";

const rows = [
  { id: 63, voucher_no: "WS-125", type: "supply", client_name: "Green Fields Agri Farms", product: "HSD", litres: 5000, rate: 266, amount: 1_330_000, txn_date: "2026-10-28T07:00:00.000Z", created_by: "Israr Ahmad", vehicle_no: "TLA-565", note: "Bypass delivery #2" },
  { id: 64, voucher_no: "RV-64", type: "payment", client_name: "Shah Transport", method: "Cash", amount: 200_000, txn_date: "2026-10-30T05:00:00.000Z", created_by: "Haroon Khan" },
  { id: 2, delivery_id: 2, product: "PMG", litres: 1000, unit_cost: 258, cost_amount: 258_000, tank: "Tank-1 Petrol", txn_date: "2026-10-30T06:16:00.000Z", created_by: "Haji Abdul Rehman", note: "tanker me bacha hua" },
];
const hits = (q: string) => rows.filter((r) => matchRow(q, r)).map((r) => r.id);

test("plain words AND-ed, any column", () => {
  assert.deepEqual(hits("green hsd"), [63]);
  assert.deepEqual(hits("israr"), [63]);
  assert.deepEqual(hits(""), [63, 64, 2]);
  assert.deepEqual(hits("nothing-here"), []);
});
test("#id and id: match the row id or any id-like column exactly", () => {
  assert.deepEqual(hits("#63"), [63]);
  assert.deepEqual(hits("id:64"), [64]);
  assert.deepEqual(hits("#2"), [63, 2]); // row 2 by id, and row 63 because its note literally says "#2"
  assert.deepEqual(hits("#125"), [63]); // the voucher's number
});
test("document numbers: WS-125, RV-64, BYP-2", () => {
  assert.deepEqual(hits("ws-125"), [63]);
  assert.deepEqual(hits("WS-125"), [63]);
  assert.deepEqual(hits("rv-64"), [64]);
  assert.deepEqual(hits("byp-2"), [2]);
});
test("field:value with loose keys", () => {
  assert.deepEqual(hits("type:payment"), [64]);
  assert.deepEqual(hits("client:shah"), [64]);
  assert.deepEqual(hits("fuel:hsd"), [63]);
  assert.deepEqual(hits("method:cash"), [64]);
  assert.deepEqual(hits("by:israr"), [63]);
  assert.deepEqual(hits("gaari:tla"), [63]);
  assert.deepEqual(hits("tank:1"), [2]);
});
test("dates and numbers", () => {
  assert.deepEqual(hits("date:2026-10-28"), [63]);
  assert.deepEqual(hits("date:2026-10"), [63, 64, 2]);
  assert.deepEqual(hits("d:30"), [64, 2]);
  assert.deepEqual(hits("amount:>500000"), [63]);
  assert.deepEqual(hits("amount:<300000"), [64, 2]);
  assert.deepEqual(hits("amount:200000"), [64]);
  assert.deepEqual(hits("litre:1000-5000"), [63, 2]);
  assert.deepEqual(hits("rate:>=260"), [63]);
  assert.deepEqual(hits("fuel:hsd amount:>1000000 by:israr"), [63]);
});
test("a caller-supplied text still gets ids and fields from the row", () => {
  assert.equal(matchRow("ws-125", rows[0], "green fields"), true);
  assert.equal(matchRow("type:payment", rows[0], "green fields"), false);
});
