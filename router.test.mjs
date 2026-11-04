// node --test router.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { _rate as rate } from "./router.mjs";

test("router rate text → bits per second", () => {
  assert.equal(rate("0 bps"), 0);
  assert.equal(rate("950 bps"), 950);
  assert.equal(rate("12.5 Kbps"), 12500);
  assert.equal(rate("3.2 Mbps"), 3.2e6);
  assert.equal(rate("1 Gbps"), 1e9);
  assert.equal(rate(undefined), 0);
  assert.equal(rate("garbage"), 0);
});
