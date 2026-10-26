import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const compiled = await build({
  entryPoints: ["lib/upload.ts"],
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
  define: {
    "process.env.NEXT_PUBLIC_SUPABASE_URL": '"https://test.supabase.co"',
    "process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY": '"public-key"',
  },
  plugins: [
    {
      name: "storage",
      setup(b) {
        b.onResolve(
          { filter: /^(\.\/supabase\/client|tus-js-client)$/ },
          (a) => ({ path: a.path, namespace: "fake" }),
        );
        b.onLoad({ filter: /.*/, namespace: "fake" }, (a) => ({
          contents:
            a.path === "tus-js-client"
              ? "export class Upload { constructor(file, options) { globalThis.tusOptions = options; } start() {} }"
              : "export function browserClient() { return globalThis.uploadDb; }",
        }));
      },
    },
  ],
});
const { uploadFile } = await import(
  "data:text/javascript;base64," +
    Buffer.from(compiled.outputFiles[0].text).toString("base64")
);
test("small upload is standard; large upload awaits TUS completion and forwards progress", async () => {
  let standard = 0;
  globalThis.uploadDb = {
    storage: {
      from: () => ({
        upload: async () => {
          standard++;
          return {};
        },
      }),
    },
    auth: {
      getSession: async () => ({
        data: { session: { access_token: "credential" } },
      }),
    },
  };
  const progress = [];
  await uploadFile("owner/small.wav", new File(["small"], "small.wav"), (n) =>
    progress.push(n),
  );
  assert.equal(standard, 1);
  assert.deepEqual(progress, [100]);
  let finished = false;
  const pending = uploadFile(
    "owner/session.zip",
    new File([new Uint8Array(6 * 1024 * 1024 + 1)], "session.zip"),
    (n) => progress.push(n),
  ).then(() => {
    finished = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  const options = globalThis.tusOptions;
  assert.equal(finished, false);
  assert.equal(standard, 1);
  assert.equal(options.chunkSize, 6 * 1024 * 1024);
  assert.equal(options.headers["x-upsert"], "false");
  assert.equal(
    options.endpoint,
    "https://test.storage.supabase.co/storage/v1/upload/resumable",
  );
  assert.equal(options.metadata.objectName, "owner/session.zip");
  assert.equal(
    options.onShouldRetry({ originalResponse: { getStatus: () => 413 } }),
    false,
  );
  assert.equal(
    options.onShouldRetry({ originalResponse: { getStatus: () => 503 } }),
    true,
  );
  options.onProgress(5, 10);
  assert.equal(progress.at(-1), 50);
  assert.equal(finished, false);
  options.onSuccess();
  await pending;
  assert.equal(finished, true);
});
