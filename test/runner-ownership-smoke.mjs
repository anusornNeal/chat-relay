import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { acquireRunnerOwnership, RunnerAlreadyActiveError } from "../cli/runner-ownership.mjs";

const relayUrl = "https://relay.example/";
const agentId = "ownership-test-agent";

async function runChild() {
  await acquireRunnerOwnership({
    relayUrl,
    agentId,
    directory: process.env.CHAT_RELAY_OWNERSHIP_TEST_DIR,
    startupGraceMs: 200,
    probeTimeoutMs: 200,
  });
  process.stdout.write("READY\n");
  setInterval(() => {}, 1_000);
}

async function waitForReady(child) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`ownership child did not start: ${output}`)), 5_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.includes("READY")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`ownership child exited early (${code}): ${output}`)));
  });
}

async function waitForExit(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once("exit", resolve);
  });
}

if (process.env.CHAT_RELAY_OWNERSHIP_TEST_CHILD === "1") {
  await runChild();
} else {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "chat-relay-ownership-"));
  const options = { directory, relayUrl, agentId, startupGraceMs: 200, probeTimeoutMs: 200 };
  let child;
  try {
    const owner = await acquireRunnerOwnership(options);
    await assert.rejects(
      acquireRunnerOwnership({ ...options, relayUrl: "https://RELAY.example" }),
      (error) => error instanceof RunnerAlreadyActiveError && error.code === "CHAT_RELAY_RUNNER_ACTIVE" && error.message.includes(agentId),
      "a duplicate relay/agent runner was allowed",
    );

    const otherAgent = await acquireRunnerOwnership({ ...options, agentId: "other-agent" });
    await otherAgent.release();
    const otherRelay = await acquireRunnerOwnership({ ...options, relayUrl: "https://other-relay.example" });
    await otherRelay.release();

    // Ownership surrounds the supervisor loop, so a child exit/restart does not create a gap.
    await assert.rejects(acquireRunnerOwnership(options), RunnerAlreadyActiveError);
    await owner.release();

    child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
      env: {
        ...process.env,
        CHAT_RELAY_OWNERSHIP_TEST_CHILD: "1",
        CHAT_RELAY_OWNERSHIP_TEST_DIR: directory,
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    await waitForReady(child);
    child.kill("SIGKILL");
    await waitForExit(child);

    const recovered = await acquireRunnerOwnership(options);
    await recovered.release();
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    fs.rmSync(directory, { recursive: true, force: true });
  }

  console.log(`runner ownership smoke test passed: ${process.platform}/${process.arch}`);
}
