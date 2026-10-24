import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
const bundle = await build({
  entryPoints: ["lib/editor/source-journal.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
});
const { snapshotSource, restoreSource, clearSource } = await import(
  "data:text/javascript;base64," +
    Buffer.from(bundle.outputFiles[0].text).toString("base64")
);
function memory() {
  const entries = new Map();
  return {
    entries,
    read: async (key) => entries.get(key),
    write: async (key, value) => {
      entries.set(key, structuredClone(value));
    },
    remove: async (key) => {
      entries.delete(key);
    },
    keys: async (prefix) =>
      [...entries.keys()].filter((key) => key.startsWith(prefix)),
  };
}
test("original-file journal owns byte chunks across loss of the OS file handle", async () => {
  const bytes = new Uint8Array(2 * 1048576 + 37);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
  const file = new File([bytes], "original.wav", {
      type: "audio/wav",
      lastModified: 42,
    }),
    store = memory();
  let largest = 0;
  const slice = file.slice.bind(file);
  file.slice = (start, end) => {
    largest = Math.max(largest, end - start);
    return slice(start, end);
  };
  file.arrayBuffer = () => {
    throw Error("must never read the entire original at once");
  };
  const key = "import-source/owner/project/id",
    manifest = await snapshotSource(key, file, store);
  file.slice = () => {
    throw Error("OS file backing handle was lost");
  };
  const recovered = await restoreSource(key, manifest, store);
  assert.deepEqual(new Uint8Array(await recovered.arrayBuffer()), bytes);
  assert.equal(recovered.name, "original.wav");
  assert.equal(recovered.lastModified, 42);
  assert.equal(largest, 1048576);
  await clearSource(key, store);
  assert.equal(store.entries.size, 0);
});
test("interrupted source byte snapshots clean up partial chunks and do not publish a manifest", async () => {
  const store = memory(),
    write = store.write;
  store.write = async (key, value) => {
    if (store.entries.size === 1) throw Error("quota");
    return write(key, value);
  };
  await assert.rejects(
    snapshotSource(
      "import-source/owner/project/id",
      new File([new Uint8Array(2 * 1048576)], "large.wav"),
      store,
    ),
    /quota/,
  );
  assert.equal(store.entries.size, 0);
});
