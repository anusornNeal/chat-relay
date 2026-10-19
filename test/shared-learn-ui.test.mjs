import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createSharedLearnUI } from "../dashboard/shared-learn.js";

let markup = "", header = "", bindings = 0, sharedOpened = 0, notice = "";
const elements = new Map();
globalThis.document = {
  getElementById(id) {
    if (!elements.has(id)) elements.set(id, { onclick: null, addEventListener() {} });
    return elements.get(id);
  },
  querySelectorAll() { return []; },
};
const group = {
  id: "grp_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  name: "Buddy2", projectKey: "buddy2", role: "viewer", ownerUserId: "owner",
};
const mockApi = async (path) => path === "/admin/api/learn/groups" ? { items: [group] } : {
  group,
  members: [{ userId: "owner", role: "owner" }],
  memories: [{ id: "smem_1", key: "shared-rule", kind: "workflow",
    content: "**Bold** details", revision: 1, sourceUserId: "owner", approvedBy: "owner" }],
  proposals: [{ id: "prp_1", key: "pending-rule", kind: "correction",
    content: "not approved", status: "pending", sourceUserId: "owner" }],
};
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"]/g,
  (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]);
const ui = createSharedLearnUI({
  api: mockApi,
  renderContent(value) { markup = value; },
  setHeader(value) { header = value; },
  setNotice(value) { notice = value; },
  escape: escapeHtml,
  showPersonal() {},
  getSidebar: () => '<aside class="learn-folder-tree"><button data-learn-shared-group="' + group.id + '">Buddy2</button></aside>',
  bindSidebar: () => { bindings++; },
  onSharedMode: () => { sharedOpened++; },
  getSearch: () => "",
});
await ui.show(group.id);
assert.equal(header, "My Learn");
assert.equal(ui.getSelectedGroupId(), group.id);
assert.equal(ui.getGroups().length, 1);
assert.equal(sharedOpened, 2); // Enter mode and render.
assert.equal(bindings, 1);
assert.equal((markup.match(/<aside class="learn-folder-tree">/g) || []).length, 1,
  "Shared Learn must reuse the Library sidebar, not introduce a second one.");
assert.match(markup, /data-learn-shared-group/);
assert.doesNotMatch(markup, /id="sharedBack"/, "Navigation should stay in the Library tree.");
assert.match(markup, /Approved/);
assert.match(markup, /Pending/);
assert.match(markup, /History/);
assert.match(markup, /<strong>Bold<\/strong>/);
assert.doesNotMatch(markup, /data-shared-review=/, "Viewer must not see review actions.");
await ui.shareMemory({ scope: "global", key: "private" });
assert.match(notice, /Only project memories/);

const empty = createSharedLearnUI({
  api: async () => ({ items: [] }),
  renderContent(value) { markup = value; },
  setHeader() {}, setNotice() {}, escape: escapeHtml, showPersonal() {},
  getSidebar: () => '<aside class="learn-folder-tree">No groups yet <button>Create group</button></aside>',
  bindSidebar() {}, onSharedMode() {}, getSearch: () => "",
});
await empty.show();
assert.equal(empty.getSelectedGroupId(), null);
assert.match(markup, /No groups yet/);
assert.match(markup, /Create group/);

const app = readFileSync(new URL("../dashboard/app.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../dashboard/styles.css", import.meta.url), "utf8");
assert.match(app, /data-learn-shared-toggle/);
assert.match(app, /data-learn-shared-group/);
assert.match(app, /data-learn-shared-create/);
assert.doesNotMatch(app, /id="openSharedLearn"/);
assert.match(app, /learnScopeFilter === "project" && !learnScopeKeyFilter/);
assert.match(css, /learn-folder-library-scroll\{[^}]*overflow-y:auto/);
console.log("PASS Shared Learn unified Library sidebar, navigation, markdown, empty and viewer states");
