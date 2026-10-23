// Isolated HTTP fixture for the production app's desk specs. No live credentials or jobs.
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
let jobs = [],
  reports = {},
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
    reports = {};
    requests = [];
    return send({});
  }
  if (url.pathname === "/__admin") {
    profile.role = "admin";
    return send({});
  }
  if (url.pathname === "/__requests") return send(requests);
  if (url.pathname === "/__job") {
    if (body.report) reports[body.id] = body.report;
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
