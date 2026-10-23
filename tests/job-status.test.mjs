import test from "node:test";
import assert from "node:assert/strict";
import { jobDownloads, jobStatusSchema } from "../lib/job-status.ts";

test("live downloads keep output indices, filter other users, and never expose storage keys", () => {
  const links = jobDownloads("job", "owner", [
    "other/private.wav",
    null,
    "owner/private/master.wav",
    "owner/private/report.json",
  ]);
  assert.deepEqual(links, [
    { label: "Download WAV", href: "/api/jobs/job/download?index=2" },
    {
      label: "Download measured report (JSON)",
      href: "/api/jobs/job/download?index=3",
    },
  ]);
  assert.deepEqual(jobDownloads("job", "owner", {}), []);
  assert.deepEqual(jobDownloads("job", "owner", ["owner2/file.wav"]), []);
});

test("poll snapshots only accept worker lifecycle states and valid measured duration", () => {
  for (const status of ["queued", "processing", "done", "failed"])
    assert.equal(
      jobStatusSchema.safeParse({
        status,
        error: null,
        durationSec: null,
        downloads: [],
      }).success,
      true,
    );
  assert.equal(
    jobStatusSchema.safeParse({
      status: "uploading",
      error: null,
      durationSec: null,
      downloads: [],
    }).success,
    false,
  );
  assert.equal(
    jobStatusSchema.safeParse({
      status: "done",
      error: null,
      durationSec: NaN,
      downloads: [],
    }).success,
    false,
  );
});
