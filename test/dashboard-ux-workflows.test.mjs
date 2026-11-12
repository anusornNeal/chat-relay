import test from "node:test";
import assert from "node:assert/strict";
import { learnReviewReason, learnFocusItems, learnFocusSummary, usageDirectory } from "../dashboard/ux-insights.js";

test("Review queue is evidence-based, not a blanket low-score quality verdict", () => {
  const rated = {usage:{status:"rated",score:49,evaluated:2,applied:0}};
  assert.equal(learnReviewReason(rated), null);
  assert.equal(learnReviewReason({usage:{status:"rated",score:49,evaluated:3}})?.key, "low");
  assert.equal(learnReviewReason({usage:{status:"new",score:null}})?.key, "new");
  assert.equal(learnReviewReason({usage:{status:"unrated",score:null}})?.key, "unrated");
  assert.equal(learnReviewReason({usage:{status:"rated",score:98},positiveFeedback:0,negativeFeedback:1})?.key, "feedback");
});

test("Learn focus counters align with visible review and usage signals", () => {
  const items=[{usage:{status:"new",applied:0}},{usage:{status:"rated",score:88,applied:3}},{usage:{status:"rated",score:20,evaluated:5,applied:1},negativeFeedback:1}];
  assert.deepEqual(learnFocusSummary(items),{total:3,review:2,used:2,negative:1});
  assert.equal(learnFocusItems(items,"review").length,2);
  assert.equal(learnFocusItems(items,"used").length,2);
  assert.equal(learnFocusItems(items,"all").length,3);
});

test("Account search includes agent names but never mutates or loses order of API data", () => {
  const original=[
    {userId:"b",name:"Bravo",calls:10,agents:[{name:"Build Runner",agentId:"one"}]},
    {userId:"a",name:"Alpha",calls:70,agents:[{name:"My desktop",agentId:"two"}]},
  ];
  assert.deepEqual(usageDirectory(original,"build").map(a=>a.userId),["b"]);
  assert.deepEqual(usageDirectory(original,"", "calls").map(a=>a.userId),["a","b"]);
  assert.deepEqual(usageDirectory(original,"", "name").map(a=>a.userId),["a","b"]);
  assert.deepEqual(original.map(a=>a.userId),["b","a"]);
});
