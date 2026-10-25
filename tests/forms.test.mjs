import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import React from "react";
import { create, act } from "react-test-renderer";
const require = createRequire(import.meta.url);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
async function load(entry) {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    jsx: "automatic",
    plugins: [
      {
        name: "isolate-effects",
        setup(b) {
          b.onResolve(
            {
              filter:
                /^(react|react\/jsx-runtime|react\/jsx-dev-runtime|fflate)$/,
            },
            (a) => ({
              path: pathToFileURL(require.resolve(a.path)).href,
              external: true,
            }),
          );
          b.onResolve(
            {
              filter:
                /^(next\/navigation|next\/server|@\/lib\/(auth|upload|supabase\/client))$/,
            },
            (a) => ({ path: a.path, namespace: "mock" }),
          );
          b.onResolve(
            {
              filter:
                /^\.\/(studio-motion|input-preview|processing-status|processing-controls|visualizer|studio-daw|podcast-editor|studio-clip-preview)$/,
            },
            (a) => ({ path: a.path, namespace: "child" }),
          );
          b.onLoad({ filter: /.*/, namespace: "child" }, (a) => ({
            contents: a.path.endsWith("studio-clip-preview")
              ? "export function ClipPreview(){return null}; export function ClipDuration(){return null}"
              : "export default function Child(){return null}",
          }));
          b.onResolve({ filter: /^\.\/studio-result$/ }, (a) => ({
            path: a.path,
            namespace: "layout",
          }));
          b.onLoad({ filter: /.*/, namespace: "layout" }, () => ({
            contents:
              "export default function Layout(p){return [p.controls,p.clipsPanel]}",
          }));
          b.onLoad({ filter: /.*/, namespace: "mock" }, (a) => ({
            contents:
              a.path === "next/navigation"
                ? "export function useRouter(){return {refresh(){}}}"
                : a.path === "next/server"
                  ? "export const NextResponse={json:(v,o)=>Response.json(v,o)}"
                  : a.path === "@/lib/auth"
                    ? "export async function requireUser(){return globalThis.__testContext}"
                    : a.path === "@/lib/upload"
                      ? "export async function uploadFile(){}"
                      : "export function browserClient(){return {storage:{from(){return {remove:async()=>{}}}}}}",
          }));
        },
      },
    ],
  });
  return import(
    "data:text/javascript;base64," +
      Buffer.from(result.outputFiles[0].text).toString("base64")
  );
}
for (const [label, path] of [
  ["JobForm", "components/job-form.tsx"],
  ["Studio", "components/audio-studio.tsx"],
  ["Podcast", "components/podcast-tool.tsx"],
])
  test(`${label}: Start enabled without choices, inline no-file alert, file-only submission`, async () => {
    const Component = (await load(path)).default;
    let view;
    const posts = [];
    const previous = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      posts.push(JSON.parse(opts.body));
      return Response.json(
        { id: "11111111-1111-4111-8111-111111111111" },
        { status: 201 },
      );
    };
    try {
      await act(async () => {
        view = create(
          React.createElement(Component, {
            userId: "11111111-1111-4111-8111-111111111111",
            maxMb: 25,
            initial: null,
          }),
        );
      });
      const start = () =>
        view.root
          .findAllByType("button")
          .find((b) =>
            b.children.includes(
              label === "Studio" ? "Submit" : "Start Processing",
            ),
          );
      assert.equal(start().props.disabled, false);
      await act(async () => {
        await view.root
          .findByType("form")
          .props.onSubmit({ preventDefault() {} });
      });
      assert.ok(
        view.root
          .findAll((n) => n.props.role === "alert")
          .some((n) => n.children.join("").includes("Choose at least one")),
      );
      const file = new File([new Uint8Array([1, 2, 3])], "clip.wav", {
        type: "audio/wav",
      });
      const input = view.root
        .findAllByType("input")
        .find((n) => n.props.type === "file");
      await act(async () => {
        input.props.onChange({ target: { files: [file], value: "" } });
      });
      assert.equal(start().props.disabled, false);
      await act(async () => {
        await view.root
          .findByType("form")
          .props.onSubmit({ preventDefault() {} });
      });
      assert.equal(posts.length, 1);
      assert.equal(
        posts[0].type,
        label === "Studio"
          ? "studio"
          : label === "Podcast"
            ? "podcast"
            : "clean",
      );
      if (label === "Studio") assert.equal(posts[0].settings.line_gap_ms, 300);
      else if (label === "Podcast")
        assert.equal(posts[0].settings.cleanup.noise.amount, 60);
      else assert.equal(posts[0].settings.noise.amount, 60);
    } finally {
      await act(async () => view?.unmount());
      globalThis.fetch = previous;
    }
  });
test("jobs API merges defaults before insertion and rejects explicit invalid values", async () => {
  const { POST } = await load("app/api/jobs/route.ts");
  let inserted;
  const db = {
    from: () => ({
      insert: (body) => {
        inserted = body;
        return {
          select: () => ({
            single: async () => ({ data: { id: "queued" }, error: null }),
          }),
        };
      },
    }),
  };
  globalThis.__testContext = {
    db,
    user: { id: "11111111-1111-4111-8111-111111111111" },
  };
  const request = (settings, type = "studio") =>
    new Request("http://localhost/api/jobs", {
      method: "POST",
      headers: {
        origin: "http://localhost",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        type,
        file_name: "session",
        input_path:
          "11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222.zip",
        settings,
      }),
    });
  assert.equal((await POST(request({}))).status, 201);
  assert.equal(inserted.settings.line_gap_ms, 300);
  assert.equal((await POST(request({}, "podcast"))).status, 201);
  assert.equal(inserted.settings.cleanup.noise.amount, 60);
  assert.equal((await POST(request({ speakers: 0 }, "podcast"))).status, 400);
  const invalid = await POST(request({ line_gap_ms: -1 }));
  assert.equal(invalid.status, 400);
  assert.equal(
    (await invalid.json()).issues[0].path.join("."),
    "settings.line_gap_ms",
  );
});
