#!/usr/bin/env node
/**
 * Launch a Cursor cloud agent against McCANNParis/MCPServerLaBelleVie `dev`.
 *
 * Used by `.github/workflows/deps-cursor-agent.yml`. `@cursor/sdk` is installed
 * in CI (CURSOR_SDK_ROOT), not as a dependency of the grocery MCP.
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_REPO = "https://github.com/McCANNParis/MCPServerLaBelleVie";
const DEFAULT_REF = "dev";
const DEFAULT_PROMPT = join(
  REPO_ROOT,
  ".cursor/automations/deps-security.md",
);

function loadSdk() {
  const sdkRoot = process.env.CURSOR_SDK_ROOT;
  if (sdkRoot) {
    return createRequire(join(sdkRoot, "package.json"))("@cursor/sdk");
  }
  try {
    return createRequire(join(REPO_ROOT, "package.json"))("@cursor/sdk");
  } catch {
    throw new Error(
      "Cannot load @cursor/sdk. Set CURSOR_SDK_ROOT to a directory where it is installed, or install it next to this repo.",
    );
  }
}

function isoWeekKey(date = new Date()) {
  const utc = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  const day = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((utc - yearStart) / 86400000 + 1) / 7);
  return `${utc.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is not set`);
  }
  return value;
}

async function main() {
  const apiKey = requireEnv("CURSOR_API_KEY");
  const promptPath = process.env.DEPS_PROMPT_PATH?.trim() || DEFAULT_PROMPT;
  const prompt = readFileSync(promptPath, "utf8").trim();
  if (!prompt) {
    throw new Error(`Prompt file is empty: ${promptPath}`);
  }

  const { Agent, CursorAgentError } = loadSdk();
  const idempotencyKey = `lbv-deps-security-${isoWeekKey()}`;
  const repoUrl = process.env.CURSOR_REPO_URL?.trim() || DEFAULT_REPO;
  const startingRef = process.env.CURSOR_STARTING_REF?.trim() || DEFAULT_REF;

  const agent = await Agent.create({
    apiKey,
    model: { id: "composer-2.5" },
    idempotencyKey,
    cloud: {
      repos: [{ url: repoUrl, startingRef }],
      autoCreatePR: true,
      skipReviewerRequest: true,
      metadata: {
        automation: "deps-security",
        source: "github-actions",
        week: isoWeekKey(),
      },
    },
  });

  try {
    console.log(`agentId=${agent.agentId}`);
    console.log(`idempotencyKey=${idempotencyKey}`);

    const run = await agent.send(prompt);
    console.log(`runId=${run.id}`);

    const result = await run.wait();
    const prUrls = (result.git?.branches ?? [])
      .map((branch) => branch.prUrl)
      .filter(Boolean);

    console.log(`status=${result.status}`);
    if (result.durationMs != null) {
      console.log(`durationMs=${result.durationMs}`);
    }
    for (const url of prUrls) {
      console.log(`prUrl=${url}`);
    }
    if (result.result) {
      console.log(result.result);
    }

    if (result.status === "error") {
      console.error(`run failed: ${result.id}`);
      if (result.error?.message) {
        console.error(result.error.message);
      }
      process.exitCode = 2;
      return;
    }
    if (result.status === "cancelled") {
      console.error(`run cancelled: ${result.id}`);
      process.exitCode = 2;
    }
  } catch (err) {
    if (err instanceof CursorAgentError) {
      console.error(
        `startup failed: ${err.message}, retryable=${err.isRetryable}`,
      );
      process.exitCode = 1;
      return;
    }
    throw err;
  } finally {
    if (typeof agent[Symbol.asyncDispose] === "function") {
      await agent[Symbol.asyncDispose]();
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
