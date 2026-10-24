// Isolated HTTP fixture for the production app's desk specs. No live credentials or jobs.
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
const owner = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const jobId = "33333333-3333-4333-8333-333333333333";
const foreignId = "44444444-4444-4444-8444-444444444444";
const user = {
  id: owner,
  email: "desk@example.test",
  aud: "authenticated",
  role: "authenticated",
  app_metadata: {},
  user_metadata: {},
  created_at: new Date().toISOString(),
};
const token = () =>
  [
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
    Buffer.from(
      JSON.stringify({
        sub: owner,
        aud: "authenticated",
        role: "authenticated",
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    ).toString("base64url"),
    "test-signature",
  ].join(".");
const profile = {
  id: owner,
  display_name: "Desk test",
  role: "user",
  plan_id: "test",
  minutes_balance: 100,
  suspended: false,
};
const plan = { id: "test", name: "Test plan", max_file_mb: 25 };
let podcasts = {};
let jobs = [],
  reports = {},
  arrangements = {},
  requests = [];

createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1:54331");
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
  };
  const send = (data, status = 200) => {
    res.writeHead(status, headers);
    res.end(JSON.stringify(data));
  };
  if (req.method === "OPTIONS") return send({});
  let text = "";
  for await (const chunk of req) text += chunk;
  let body;
  try {
    body = JSON.parse(text || "{}");
  } catch {
    body = {};
  }
  if (url.pathname === "/__reset") {
    profile.role = "user";
    jobs = [];
    podcasts = {};
    reports = {};
    arrangements = {};
    requests = [];
    return send({});
  }
  if (url.pathname === "/__admin") {
    profile.role = "admin";
    return send({});
  }
  if (url.pathname === "/__requests") return send(requests);
  if (url.pathname === "/__job") {
    if (body.podcast) podcasts[body.id] = body.podcast;
    if (body.report) reports[body.id] = body.report;
    if (body.arrangement)
      arrangements[body.id] = {
        revision: 1,
        exports_count: 0,
        arrangement: body.arrangement,
      };
    if (req.method === "POST")
      jobs = jobs.map((job) =>
        job.id === body.id ? { ...job, ...body } : job,
      );
    return send(jobs);
  }
  if (url.pathname === "/__seed") {
    jobs = [
      {
        id: jobId,
        user_id: owner,
        status: "done",
        error: null,
        duration_sec: 12.5,
        output_paths: [
          `${owner}/private/clean.wav`,
          `${owner}/private/report.json`,
        ],
      },
      {
        id: foreignId,
        user_id: other,
        status: "done",
        error: null,
        duration_sec: 10,
        output_paths: [`${other}/secret.wav`],
      },
    ];
    return send({ jobId, foreignId });
  }
  requests.push({
    method: req.method,
    path: url.pathname,
    query: Object.fromEntries(url.searchParams),
  });
  if (url.pathname === "/health") return send({ ok: true });
  if (url.pathname === "/auth/v1/token")
    return send({
      access_token: token(),
      token_type: "bearer",
      expires_in: 3600,
      refresh_token: "test-refresh-token",
      user,
    });
  if (url.pathname === "/auth/v1/user") return send(user);
  if (url.pathname === "/auth/v1/logout") return send({});
  if (url.pathname.endsWith("/alignment-report.json")) {
    const id = url.pathname.split("/").at(-2);
    return reports[id] ? send(reports[id]) : send({ error: "missing" }, 404);
  }
  if (url.pathname.startsWith("/rest/v1/podcast_")) {
    const id = (
      url.searchParams.get("job_id") ??
      url.searchParams.get("project_id") ??
      ""
    ).slice(3);
    const p = podcasts[id];
    if (!p) return send(null);
    if (url.pathname.endsWith("/podcast_projects"))
      return send({
        duration: p.duration,
        revision: p.revision,
        exports_count: p.exports_count,
      });
    if (url.pathname.endsWith("/podcast_transcripts"))
      return send({ transcript: p.transcript });
    if (url.pathname.endsWith("/podcast_edits"))
      return send({ edits: p.edits });
    if (url.pathname.endsWith("/podcast_media")) return send(p.media);
  }
  if (url.pathname === "/rest/v1/rpc/save_podcast_edits") {
    const p = podcasts[body.p_job];
    if (!p) return send({ message: "Unavailable" }, 404);
    if (p.revision !== body.p_revision)
      return send({ code: "40001", message: "Revision conflict" }, 409);
    p.edits = body.p_edits;
    p.revision++;
    return send(p.revision);
  }
  if (
    url.pathname.includes("/object/public/outputs/") &&
    /proxy-\d+\.mp4$/.test(url.pathname)
  ) {
    const data = readFileSync("tests/fixtures/podcast-proxy.mp4");
    res.writeHead(200, {
      "Content-Type": "video/mp4",
      "Access-Control-Allow-Origin": "*",
      "Accept-Ranges": "bytes",
    });
    res.end(data);
    return;
  }
  if (url.pathname === "/rest/v1/studio_arrangements")
    return send(arrangements[url.searchParams.get("job_id")?.slice(3)] ?? null);
  if (url.pathname === "/rest/v1/rpc/save_arrangement") {
    const a = arrangements[body.p_job];
    if (!a) return send({ message: "Unavailable" }, 404);
    if (a.revision !== body.p_revision)
      return send({ code: "40001", message: "Revision conflict" }, 409);
    a.arrangement = body.p_arrangement;
    a.revision++;
    return send(a.revision);
  }
  if (url.pathname.startsWith("/storage/v1/object/sign/outputs/")) {
    return send({
      signedURL: "/object/public/outputs/" + url.pathname.split("/outputs/")[1],
    });
  }
  if (
    url.pathname.includes("/object/public/outputs/") &&
    /(?:\/peaks\/c\d+|\/podcast-peaks|\/podcast-clip-\d+-peaks)\.json$/.test(url.pathname)
  )
    return send({
      rate: 100,
      peaks: Array.from({ length: 400 }, (_, i) => [-(i % 50), i % 70]),
    });
  if (
    url.pathname.includes("/object/public/outputs/") &&
    /(?:\/stems\/c\d+\.wav|\/podcast-preview\.mp3|\/podcast-source\.wav|\/podcast-clip-\d+\.wav)$/.test(url.pathname)
  ) {
    const wave = Buffer.alloc(64044);
    wave.write("RIFF");
    wave.writeUInt32LE(wave.length - 8, 4);
    wave.write("WAVEfmt ", 8);
    wave.writeUInt32LE(16, 16);
    wave.writeUInt16LE(1, 20);
    wave.writeUInt16LE(1, 22);
    wave.writeUInt32LE(8000, 24);
    wave.writeUInt32LE(16000, 28);
    wave.writeUInt16LE(2, 32);
    wave.writeUInt16LE(16, 34);
    wave.write("data", 36);
    wave.writeUInt32LE(64000, 40);
    res.writeHead(200, {
      "Content-Type": "audio/wav",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(wave);
    return;
  }
  if (url.pathname.startsWith("/storage/v1/object/"))
    return send({ Key: "uploads/test.wav", Id: jobId });
  if (url.pathname === "/rest/v1/profiles") return send(profile);
  if (url.pathname === "/rest/v1/plans") return send(plan);
  if (url.pathname === "/rest/v1/jobs") {
    if (req.method === "POST") {
      const id = crypto.randomUUID();
      jobs.push({
        ...body,
        id,
        user_id: owner,
        status: "queued",
        error: null,
        duration_sec: null,
        output_paths: [],
        created_at: new Date().toISOString(),
      });
      return send({ id }, 201);
    }
    const found = jobs.filter((j) =>
      ["id", "user_id", "type"].every(
        (key) =>
          !url.searchParams.has(key) ||
          url.searchParams.get(key) === `eq.${j[key]}`,
      ),
    );
    res.setHeader("Content-Range", `0-${found.length - 1}/${found.length}`);
    return send(
      req.headers.accept?.includes("vnd.pgrst.object") ? found[0] : found,
    );
  }
  return send({ error: `Unhandled fixture route: ${url.pathname}` }, 404);
}).listen(54331, "127.0.0.1");
