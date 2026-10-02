import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

export async function readProjectSource(projectRoot, relativePath) {
  return fs.readFile(path.join(projectRoot, relativePath), "utf8");
}

export function sourceBlock(source, anchor) {
  const anchorAt = source.indexOf(anchor);
  assert.notEqual(anchorAt, -1, `source contract anchor missing: ${anchor}`);
  const parametersAt = source.indexOf("(", anchorAt);
  assert.notEqual(parametersAt, -1, `source contract parameters missing: ${anchor}`);

  let parameterDepth = 0;
  let parametersEnd = -1;
  for (let index = parametersAt; index < source.length; index += 1) {
    if (source[index] === "(") parameterDepth += 1;
    if (source[index] !== ")") continue;
    parameterDepth -= 1;
    if (parameterDepth === 0) {
      parametersEnd = index;
      break;
    }
  }
  assert.notEqual(parametersEnd, -1, `source contract parameters are unbalanced: ${anchor}`);

  const openAt = source.indexOf("{", parametersEnd + 1);
  assert.notEqual(openAt, -1, `source contract body missing: ${anchor}`);

  let depth = 0;
  for (let index = openAt; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] !== "}") continue;
    depth -= 1;
    if (depth === 0) return source.slice(openAt + 1, index);
  }
  assert.fail(`source contract body is unbalanced: ${anchor}`);
}

export function assertInOrder(source, tokens, contract) {
  let cursor = -1;
  for (const token of tokens) {
    const next = source.indexOf(token, cursor + 1);
    assert.notEqual(next, -1, `${contract}: missing ${token}`);
    assert.ok(next > cursor, `${contract}: ${token} is out of order`);
    cursor = next;
  }
}

export function attachmentSocket(attachment) {
  return { deserializeAttachment: () => attachment };
}

export async function runTests(tests) {
  for (const [name, test] of tests) {
    await test();
    console.log(`ok - ${name}`);
  }
}
