/**
 * Cloudflare Worker: waits for a Hetzner Cloud server type (e.g. cx33 / cx43)
 * to become available, orders exactly ONE server and notifies Telegram.
 *
 * Runs on a cron trigger. Once a server with our label exists in the project,
 * every subsequent run is a no-op, so you never end up with more than one VPS.
 */

const HETZNER_API = "https://api.hetzner.cloud/v1";

// Errors that mean "this type/location is not available right now, try another".
const RETRYABLE_ERRORS = new Set([
  "resource_unavailable",
  "placement_error",
  "unavailable",
  "server_error",
  "conflict",
]);

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(
      run(env)
        .then((r) => console.log(JSON.stringify(r)))
        .catch((e) => console.error("run failed:", e?.message || e)),
    );
  },

  async fetch(request, env) {
    try {
      return await handle(request, env);
    } catch (e) {
      console.error(e);
      return json({ error: String(e?.message || e) }, 500);
    }
  },
};

async function handle(request, env) {
  const url = new URL(request.url);

  if (url.pathname === "/health") return json({ ok: true });

  if (!isAuthorized(request, env)) return json({ error: "unauthorized" }, 401);

  if (url.pathname === "/status" && request.method === "GET") {
    const cfg = loadConfig(env);
    const existing = await findExistingServers(env, cfg);
    return json({ config: publicConfig(cfg), servers: existing.map(summarize) });
  }

  if (url.pathname === "/run" && request.method === "POST") {
    return json(await run(env));
  }

  if (url.pathname === "/test-telegram" && request.method === "POST") {
    await notify(env, "✅ Test message from hetzner-order-server");
    return json({ ok: true });
  }

  return json({ error: "not found" }, 404);
}

// ---------------------------------------------------------------------------

async function run(env) {
  const cfg = loadConfig(env);

  const existing = await findExistingServers(env, cfg);
  if (existing.length > 0) {
    return { status: "already_have_server", servers: existing.map(summarize) };
  }

  const candidates = await buildCandidates(env, cfg);
  if (candidates.length === 0) {
    return { status: "nothing_available", tried: [] };
  }

  const tried = [];
  for (const { serverType, location } of candidates) {
    const res = await createServer(env, cfg, serverType, location);
    tried.push({ serverType, location, result: res.ok ? "created" : res.code });

    if (res.ok) {
      await notify(env, formatSuccess(cfg, res.data)).catch((e) =>
        console.error("telegram notify failed", e),
      );
      return { status: "created", server: summarize(res.data.server), tried };
    }

    // Someone (a parallel run) already created it — stop.
    if (res.code === "uniqueness_error") {
      return { status: "already_have_server", tried };
    }

    if (!RETRYABLE_ERRORS.has(res.code)) {
      // Auth / limits / bad config: no point hammering other locations.
      await notifyErrorOnce(env, cfg, res);
      return { status: "error", error: res, tried };
    }
  }

  return { status: "nothing_available", tried };
}

function loadConfig(env) {
  if (!env.HETZNER_API_TOKEN) throw new Error("HETZNER_API_TOKEN is not set");

  return {
    project: env.HETZNER_PROJECT || "",
    // Priority order: first available type wins.
    serverTypes: list(env.SERVER_TYPES || "cx33,cx43"),
    // Empty = any location where the type is available.
    locations: list(env.LOCATIONS || ""),
    image: env.IMAGE || "ubuntu-24.04",
    serverName: env.SERVER_NAME || "marrek-vps",
    sshKeys: list(env.SSH_KEYS || ""),
    labelKey: "managed-by",
    labelValue: "hetzner-order-server",
    enableIpv4: (env.ENABLE_IPV4 || "true") !== "false",
  };
}

function publicConfig(cfg) {
  const { sshKeys, ...rest } = cfg;
  return { ...rest, sshKeys: sshKeys.length };
}

async function findExistingServers(env, cfg) {
  const selector = encodeURIComponent(`${cfg.labelKey}=${cfg.labelValue}`);
  const byLabel = await hetzner(env, "GET", `/servers?label_selector=${selector}`);
  if (!byLabel.ok) throw new Error(`Hetzner list servers failed: ${byLabel.code} ${byLabel.message}`);
  if (byLabel.data.servers.length > 0) return byLabel.data.servers;

  const byName = await hetzner(env, "GET", `/servers?name=${encodeURIComponent(cfg.serverName)}`);
  return byName.ok ? byName.data.servers : [];
}

/**
 * Returns [{serverType, location}] ordered by SERVER_TYPES priority, then
 * LOCATIONS priority. Uses /datacenters to skip locations where the type is
 * currently sold out; if that lookup fails we just try everything.
 */
async function buildCandidates(env, cfg) {
  const [typesRes, dcRes] = await Promise.all([
    hetzner(env, "GET", "/server_types?per_page=50"),
    hetzner(env, "GET", "/datacenters?per_page=50"),
  ]);

  const typeIdByName = new Map();
  const typeLocations = new Map();
  if (typesRes.ok) {
    for (const t of typesRes.data.server_types) {
      typeIdByName.set(t.name, t.id);
      typeLocations.set(t.name, (t.prices || []).map((p) => p.location));
    }
  }

  // location name -> Set(available server type ids)
  const available = new Map();
  if (dcRes.ok) {
    for (const dc of dcRes.data.datacenters) {
      const loc = dc.location.name;
      const set = available.get(loc) || new Set();
      for (const id of dc.server_types?.available || []) set.add(id);
      available.set(loc, set);
    }
  }

  const out = [];
  for (const serverType of cfg.serverTypes) {
    const id = typeIdByName.get(serverType);
    let locs = cfg.locations.length ? cfg.locations : typeLocations.get(serverType) || [];
    if (id !== undefined && available.size > 0) {
      locs = locs.filter((l) => available.get(l)?.has(id));
    }
    for (const location of locs) out.push({ serverType, location });
  }
  return out;
}

async function createServer(env, cfg, serverType, location) {
  const body = {
    name: cfg.serverName,
    server_type: serverType,
    image: cfg.image,
    location,
    start_after_create: true,
    labels: { [cfg.labelKey]: cfg.labelValue },
    public_net: { enable_ipv4: cfg.enableIpv4, enable_ipv6: true },
  };
  if (cfg.sshKeys.length) body.ssh_keys = cfg.sshKeys;
  return hetzner(env, "POST", "/servers", body);
}

async function hetzner(env, method, path, body) {
  const res = await fetch(HETZNER_API + path, {
    method,
    headers: {
      Authorization: `Bearer ${env.HETZNER_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.ok) return { ok: true, data };
  return {
    ok: false,
    status: res.status,
    code: data?.error?.code || `http_${res.status}`,
    message: data?.error?.message || res.statusText,
  };
}

// ---------------------------------------------------------------------------
// Telegram

async function notify(env, text) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    console.warn("Telegram is not configured, skipping notification");
    return;
  }
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_CHAT_ID,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });
  if (!res.ok) throw new Error(`Telegram ${res.status}: ${await res.text()}`);
}

// Avoid spamming Telegram every minute with the same config error.
let lastErrorNotified = "";
async function notifyErrorOnce(env, cfg, err) {
  const key = `${err.code}:${err.message}`;
  if (key === lastErrorNotified) return;
  lastErrorNotified = key;
  await notify(
    env,
    `⚠️ <b>Hetzner order error</b>${cfg.project ? ` (${esc(cfg.project)})` : ""}\n` +
      `<code>${esc(err.code)}</code>: ${esc(err.message)}`,
  ).catch((e) => console.error("telegram notify failed", e));
}

function formatSuccess(cfg, data) {
  const s = data.server;
  const lines = [
    `🎉 <b>Hetzner VPS purchased</b>`,
    cfg.project && `Project: <b>${esc(cfg.project)}</b>`,
    `Name: <b>${esc(s.name)}</b> (id ${s.id})`,
    `Type: <b>${esc(s.server_type?.name)}</b> — ${s.server_type?.cores} vCPU / ${s.server_type?.memory} GB RAM / ${s.server_type?.disk} GB`,
    `Location: <b>${esc(s.datacenter?.location?.name)}</b> (${esc(s.datacenter?.location?.city)})`,
    `Image: ${esc(s.image?.name || cfg.image)}`,
    s.public_net?.ipv4?.ip && `IPv4: <code>${esc(s.public_net.ipv4.ip)}</code>`,
    s.public_net?.ipv6?.ip && `IPv6: <code>${esc(s.public_net.ipv6.ip)}</code>`,
    data.root_password && `Root password: <tg-spoiler>${esc(data.root_password)}</tg-spoiler>`,
  ];
  return lines.filter(Boolean).join("\n");
}

// ---------------------------------------------------------------------------
// helpers

function isAuthorized(request, env) {
  if (!env.ADMIN_TOKEN) return false; // HTTP endpoints disabled unless a token is set
  return request.headers.get("Authorization") === `Bearer ${env.ADMIN_TOKEN}`;
}

function summarize(s) {
  return {
    id: s.id,
    name: s.name,
    status: s.status,
    type: s.server_type?.name,
    location: s.datacenter?.location?.name,
    ipv4: s.public_net?.ipv4?.ip,
  };
}

function list(s) {
  return s.split(",").map((x) => x.trim()).filter(Boolean);
}

function esc(s) {
  return String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
