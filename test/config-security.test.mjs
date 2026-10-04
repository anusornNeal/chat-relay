import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { clearConfig, configPath, loadConfig, saveConfig } from "../cli/config.mjs";
import { clearSecrets, readSecrets, resolveSecretStore, secretStorePaths, writeSecrets } from "../cli/secret-store.mjs";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "chat-relay-config-"));
}

function withEnv(values, run) {
  const previous = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("saveConfig keeps auth tokens out of config.json and restores them on load", () => {
  const home = tempDir();
  try {
    withEnv({ CHAT_RELAY_HOME: home, CHAT_RELAY_SECRET_STORE: "file" }, () => {
      saveConfig({
        relayUrl: "https://relay.example",
        user: { id: "user-1", name: "Test User" },
        userToken: "user-secret-value",
        agentId: "agent-1",
        agentName: "Test Agent",
        agentToken: "agent-secret-value",
        allowedRoots: home,
        terminalEnabled: true,
        desktopEnabled: false,
      });

      const persisted = fs.readFileSync(configPath(), "utf8");
      assert.ok(!persisted.includes("user-secret-value"));
      assert.ok(!persisted.includes("agent-secret-value"));
      assert.match(persisted, /"credentialStorage": "file"/);

      const loaded = loadConfig();
      assert.equal(loaded.userToken, "user-secret-value");
      assert.equal(loaded.agentToken, "agent-secret-value");

      const paths = secretStorePaths(home);
      assert.equal(fs.existsSync(paths.fallback), true);
      clearConfig();
      assert.equal(fs.existsSync(configPath()), false);
      assert.equal(fs.existsSync(paths.fallback), false);
    });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("loadConfig migrates legacy plaintext tokens out of config.json", () => {
  const home = tempDir();
  try {
    withEnv({ CHAT_RELAY_HOME: home, CHAT_RELAY_SECRET_STORE: "file" }, () => {
      const legacy = {
        relayUrl: "https://relay.example",
        userToken: "legacy-user-secret",
        agentId: "agent-legacy",
        agentToken: "legacy-agent-secret",
        allowedRoots: home,
      };
      fs.writeFileSync(path.join(home, "config.json"), JSON.stringify(legacy, null, 2));

      const loaded = loadConfig();
      assert.equal(loaded.userToken, "legacy-user-secret");
      assert.equal(loaded.agentToken, "legacy-agent-secret");

      const migrated = fs.readFileSync(path.join(home, "config.json"), "utf8");
      assert.ok(!migrated.includes("legacy-user-secret"));
      assert.ok(!migrated.includes("legacy-agent-secret"));
      assert.match(migrated, /"credentialStorage": "file"/);
    });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("secret store selects native protection by platform", () => {
  assert.equal(resolveSecretStore({ platform: "win32", env: {} }), "dpapi");
  assert.equal(resolveSecretStore({ platform: "darwin", env: {} }), "keychain");
  assert.equal(resolveSecretStore({ platform: "linux", env: {} }), "file");
  assert.equal(resolveSecretStore({ platform: "win32", env: { CHAT_RELAY_SECRET_STORE: "file" } }), "file");
});

test("Windows DPAPI store round-trips without plaintext at rest", { skip: process.platform !== "win32" }, () => {
  const home = tempDir();
  try {
    const storage = writeSecrets(home, {
      userToken: "dpapi-user-secret",
      agentToken: "dpapi-agent-secret",
    }, { store: "dpapi", platform: "win32", env: {} });
    assert.equal(storage, "dpapi");

    const file = secretStorePaths(home).dpapi;
    const encrypted = fs.readFileSync(file, "utf8");
    assert.ok(!encrypted.includes("dpapi-user-secret"));
    assert.ok(!encrypted.includes("dpapi-agent-secret"));

    const loaded = readSecrets(home, { store: "dpapi", platform: "win32", env: {} });
    assert.deepEqual(loaded, {
      userToken: "dpapi-user-secret",
      agentToken: "dpapi-agent-secret",
    });

    clearSecrets(home, { store: "dpapi", platform: "win32", env: {} });
    assert.equal(fs.existsSync(file), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
