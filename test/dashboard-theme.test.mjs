import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const html=readFileSync(new URL("../dashboard/index.html",import.meta.url),"utf8");
const base=readFileSync(new URL("../dashboard/styles.css",import.meta.url),"utf8");
const css=readFileSync(new URL("../dashboard/theme.css",import.meta.url),"utf8");
const js=readFileSync(new URL("../dashboard/theme.js",import.meta.url),"utf8");

function harness({saved=null,systemDark=false,denied=false}={}) {
  const store = new Map(saved === null ? [] : [["chat_relay_theme",saved]]);
  const listeners = {};
  const mediaListeners = {};
  let dark = systemDark;
  let color = "#18251e";
  const selects=[{value:"system",listeners:{}},{value:"system",listeners:{}}];
  for(const c of selects) c.addEventListener = (name,fn) => {c.listeners[name]=fn};
  const media = {
    get matches(){return dark},
    addEventListener(name,fn){mediaListeners[name]=fn},
  };
  const document = {
    documentElement:{dataset:{},style:{}},
    querySelector(sel){return sel==='meta[name="theme-color"]'?{setAttribute(_k,v){color=v}}:null},
    querySelectorAll(sel){return sel==="[data-theme-control]"?selects:[]},
    addEventListener(name,fn){listeners[name]=fn},
  };
  const window = {
    matchMedia(query){assert.equal(query,"(prefers-color-scheme: dark)");return media},
    localStorage:{
      getItem(k){if(denied)throw Error("blocked");return store.get(k)||null},
      setItem(k,v){if(denied)throw Error("blocked");store.set(k,v)},
    },
    addEventListener(name,fn){listeners[name]=fn},
  };
  runInNewContext(js,{document,window});
  listeners.DOMContentLoaded();
  return {
    document,store,selects,get themeColor(){return color},
    setSystemDark(next){dark=next;mediaListeners.change?.()},
    setMode(value,index=0){selects[index].value=value;selects[index].listeners.change()},
    external(value){listeners.storage?.({key:"chat_relay_theme",newValue:value})},
  };
}
test("Theme is prepaint, applies system dark, and keeps the two controls in sync",()=>{
  const h=harness({systemDark:true});
  assert.equal(h.document.documentElement.dataset.theme,"dark");
  assert.equal(h.document.documentElement.dataset.themeMode,"system");
  assert.equal(h.document.documentElement.style.colorScheme,"dark");
  assert.equal(h.themeColor,"#101827");
  assert.deepEqual(h.selects.map(s=>s.value),["system","system"]);
  h.setSystemDark(false);
  assert.equal(h.document.documentElement.dataset.theme,"light");
  assert.equal(h.themeColor,"#f8fafc");
});
test("Explicit mode overrides OS, persists across reloads and synchronizes across tabs",()=>{
  const h=harness({systemDark:false});
  h.setMode("dark",1);
  assert.equal(h.document.documentElement.dataset.theme,"dark");
  assert.equal(h.store.get("chat_relay_theme"),"dark");
  assert.deepEqual(h.selects.map(s=>s.value),["dark","dark"]);
  h.setSystemDark(true);
  h.setSystemDark(false);
  assert.equal(h.document.documentElement.dataset.theme,"dark");
  assert.equal(harness({saved:h.store.get("chat_relay_theme"),systemDark:false}).document.documentElement.dataset.theme,"dark");
  h.external("light");
  assert.equal(h.document.documentElement.dataset.theme,"light");
  h.external("invalid");
  assert.equal(h.document.documentElement.dataset.themeMode,"system");
});
test("Invalid preferences and disabled storage safely fall back to system",()=>{
  const invalid=harness({saved:"unsupported",systemDark:true});
  assert.equal(invalid.document.documentElement.dataset.theme,"dark");
  const denied=harness({denied:true});
  denied.setMode("dark");
  assert.equal(denied.document.documentElement.dataset.theme,"dark");
  denied.setMode("light");
  assert.equal(denied.document.documentElement.dataset.theme,"light");
});
test("All screens share prepaint theme, accessible controls and a scoped dark palette",()=>{
  const scriptAt=html.indexOf('src="/dashboard/theme.js"');
  const cssAt=html.indexOf('href="/dashboard/styles.css"');
  assert(scriptAt>=0 && cssAt>scriptAt,"Apply preference before stylesheet paints");
  assert.match(html,/href="\/dashboard\/theme.css"/);
  assert.equal((html.match(/data-theme-control/g)||[]).length,2,"Login and app both allow switching");
  assert.match(html,/Appearance on sign in/);
  assert.match(html,/Appearance"/);
  assert.match(css,/html\[data-theme="dark"\]\s*\{/);
  for(const marker of [".auth-shell",".sidebar",".main",".ledger-table",".chart-tooltip",
    ".learn-folder-tree",".learn-markdown",".learn-shared-dialog",".ux-refine-dialog"]) {
    assert(css.includes(marker),"Missing dark style for "+marker);
  }
  assert(css.length<32000,"Keep the additional transfer small");
  assert(!/@import|cdn\.|https?:\/\//.test(css),"Theme CSS needs no network fonts or dependencies");
  assert(base.includes("--accent:#4f46e5"),"Existing light palette must remain unchanged");
});
