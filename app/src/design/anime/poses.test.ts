import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { FUMI_ART, FUMI_WIDTHS } from "./manifest";
import { FUMI_POSES, FUMI_POSE_KEYS, drawnPose, resolvePose } from "./poses";

const CORE = new Set(["pointing", "cheering", "shocked", "ticket", "thumbsdown"]);

test("poses without art fall back to the agreed core pose", () => {
  assert.equal(resolvePose("crying", CORE), "shocked");
  assert.equal(resolvePose("moneyeyes", CORE), "cheering");
  assert.equal(resolvePose("waving", CORE), "pointing");
  assert.equal(resolvePose("thinking", CORE), "pointing");
  assert.equal(resolvePose("facepalm", CORE), "thumbsdown");
  assert.equal(resolvePose("running", CORE), "cheering");
  assert.equal(resolvePose("ticket", CORE), "ticket");
  assert.equal(resolvePose("crying", new Set()), "pointing");
});

test("every fallback chain ends at a core pose", () => {
  for (const k of FUMI_POSE_KEYS) assert.ok(CORE.has(resolvePose(k, CORE)), k);
});

test("shipped art: every manifest pose has both WebP sizes, and drawn poses use real art", () => {
  for (const k of FUMI_ART) for (const w of FUMI_WIDTHS) assert.ok(existsSync(join(process.cwd(), "public", "fumi", `${k}-${w}.webp`)), `${k}-${w}`);
  for (const k of FUMI_ART) assert.ok(k in FUMI_POSES, k);
  for (const k of FUMI_POSE_KEYS) assert.ok((FUMI_ART as readonly string[]).includes(drawnPose(k)), k);
});
