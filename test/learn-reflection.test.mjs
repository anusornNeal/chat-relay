import assert from "node:assert/strict";
import { LearnPreflightGuard, attachLearnReflectionAdvisory, isLearningCheckpointTool, shouldEmitLearnAdvisory } from "../src/learn-preflight-guard.mjs";

assert.equal(isLearningCheckpointTool("write_file", {}), true);
assert.equal(isLearningCheckpointTool("read_file", {}), false);
assert.equal(isLearningCheckpointTool("terminal_exec", {command: "git commit -m test"}), true);
assert.equal(isLearningCheckpointTool("terminal_exec", {command: "git status"}), false);
// Without a reliable conversation ID, a Worker isolate cannot deduplicate advice.
assert.equal(shouldEmitLearnAdvisory(false), false);
assert.equal(shouldEmitLearnAdvisory(undefined), false);
assert.equal(shouldEmitLearnAdvisory(true), true);
assert.equal(shouldEmitLearnAdvisory(true, true), false);
assert.equal(shouldEmitLearnAdvisory(true, false), true);
const guard = new LearnPreflightGuard();
assert.equal(guard.claimReflection("a", "chat"), true);
assert.equal(guard.claimReflection("a", "chat"), false);
assert.equal(guard.claimReflection("b", "chat"), true);
assert.equal(guard.claimReflection("a", "other"), true);
guard.markLearned("c", "chat");
assert.equal(guard.claimReflection("c", "chat"), false);
assert.equal(guard.claimReflection("a", undefined), false);
const original={structuredContent:{ok:true},content:[{type:"text",text:"original"}]};
const wrapped=attachLearnReflectionAdvisory(original);
assert.equal(wrapped.attached,true);
assert.equal(original.content.length,1);
assert.equal(wrapped.value.content.length,2);
assert.match(wrapped.value.content[1].text,/learn_reflection_recommended/);
assert.equal(attachLearnReflectionAdvisory({ok:true}).attached,false);
console.log("PASS proactive reflection checkpoints and account isolation");
