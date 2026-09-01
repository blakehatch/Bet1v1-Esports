import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const NON_PLAYER_CLIENT_NUM = 64;
const killLine = /^Kill: (\d+) (\d+) (\d+): (.+) killed (.+) by (\S+)$/;

export const parseUncreditedDeath = (line, observedAt = Date.now()) => {
  const match = line.trim().match(killLine);
  if (!match) return null;
  const killerClientNum = Number(match[1]);
  const victimClientNum = Number(match[2]);
  if (killerClientNum !== victimClientNum && killerClientNum < NON_PLAYER_CLIENT_NUM) return null;
  return {
    event: "death",
    victim: { clientNum: victimClientNum, name: match[5] },
    meansOfDeath: Number(match[3]),
    observedAt
  };
};

const postDeath = async (event) => {
  const endpoint = process.env.Q3JS_EVENT_URL;
  const secret = process.env.Q3JS_EVENT_CLIENT_SECRET;
  if (!endpoint || !secret) throw new Error("Q3JS death reporting is not configured");
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-q3js-client-secret": secret
    },
    body: JSON.stringify(event)
  });
  if (!response.ok) throw new Error(`Q3JS death callback failed with HTTP ${response.status}`);
};

const forwardAndInspect = (stream, destination) => {
  let remainder = "";
  stream.on("data", (chunk) => {
    destination.write(chunk);
    const lines = `${remainder}${chunk.toString("utf8")}`.split(/\r?\n/);
    remainder = lines.pop() ?? "";
    for (const line of lines) {
      const event = parseUncreditedDeath(line);
      if (event) void postDeath(event).catch((error) => console.error(error.message));
    }
  });
};

const isEntrypoint = process.argv[1] === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  const server = spawn(process.execPath, ["app/main.mjs", ...process.argv.slice(2)], {
    env: process.env,
    stdio: ["inherit", "pipe", "pipe"]
  });
  forwardAndInspect(server.stdout, process.stdout);
  forwardAndInspect(server.stderr, process.stderr);
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => server.kill(signal));
  }
  server.on("exit", (code, signal) => {
    process.exit(code ?? (signal ? 0 : 1));
  });
}
