import fs from "node:fs";

const googleSource = fs.readFileSync(new URL("../src/google-auth.ts", import.meta.url), "utf8");
const registrySource = fs.readFileSync(new URL("../src/registry.ts", import.meta.url), "utf8");
const adminSource = fs.readFileSync(new URL("../src/admin.ts", import.meta.url), "utf8");
const dashboard = fs.readFileSync(new URL("../dashboard/index.html", import.meta.url), "utf8");
const app = fs.readFileSync(new URL("../dashboard/app.js", import.meta.url), "utf8");

for (const required of ["code_challenge_method","S256","state","nonce","email_verified","accounts.google.com","GOOGLE_CLIENT_ID","GOOGLE_CLIENT_SECRET"]) {
  if (!googleSource.includes(required)) throw new Error(`google auth contract missing: ${required}`);
}
if (!googleSource.includes("sessionStorage.setItem('chat_relay_csrf'")) throw new Error("Google callback did not persist CSRF");
for (const required of ['case "/google/upsert"','key.userGoogleSub(googleSub)','existing.id === "owner"','existing.admin === true','delete existing.passwordHash','case "/admin-session/create-for-user"']) {
  if (!registrySource.includes(required)) throw new Error(`registry Google identity contract missing: ${required}`);
}
if (!adminSource.includes('path === "/admin/google/start"') || !adminSource.includes('path === "/admin/google/callback"')) throw new Error("admin Google routes are missing");
if (!dashboard.includes('href="/admin/google/start"')) throw new Error("dashboard Google sign-in entrypoint is missing");
if (!app.includes('sessionStorage.getItem("chat_relay_csrf")') || !app.includes('sessionStorage.removeItem("chat_relay_csrf")')) throw new Error("dashboard CSRF persistence contract is incomplete");

const base = process.env.TEST_RELAY_URL?.replace(/\/$/, "");
if (base) {
  const response = await fetch(base + "/admin/google/start", { redirect: "manual" });
  if (response.status !== 503) throw new Error(`unconfigured Google login should fail closed with 503, got ${response.status}`);
  const body = await response.text();
  if (!body.includes("Google login is not configured")) throw new Error("unconfigured Google login did not return a safe error");
}
console.log("google auth smoke test passed");
