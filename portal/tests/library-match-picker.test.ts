import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { byStars, LibraryMatchPicker, libraryMatchOf, potentialMatch } from "../src/app/unified/LibraryMatchPicker";

const key = `sha:${"a".repeat(40)}`;

test("only a well-formed offer to choose is shown; one suggestion is enough", () => {
  assert.deepEqual(libraryMatchOf([{ catalogMatchKey: `n:${"b".repeat(64)}`, catalogCandidates: ["only/one"] }]),
    { matchKey: `n:${"b".repeat(64)}`, candidates: ["only/one"] });
  assert.deepEqual(libraryMatchOf([{}, { catalogMatchKey: key, catalogCandidates: ["big/repo:x", "fork/repo:x"] }]),
    { matchKey: key, candidates: ["big/repo:x", "fork/repo:x"] });
  for (const bad of [
    { catalogMatchKey: "sha:nope", catalogCandidates: ["a/b", "c/d"] },
    { catalogMatchKey: key, catalogCandidates: "a/b" },
  ]) assert.equal(libraryMatchOf([bad]), null);
});

test("the picker lists the candidates, most stars first already selected, with a way to say it's your own", () => {
  const html = renderToStaticMarkup(createElement(LibraryMatchPicker, {
    match: { matchKey: key, candidates: ["big/repo:x", "fork/repo:x"] },
    load: async () => [], choose: async () => {},
  }));
  assert.match(html, /Looks like a library skill/);
  assert.match(html, /checked=""[^>]*>.*?big\/repo/s);
  assert.match(html, /This one/);
  assert.match(html, /It&#x27;s my own/);
  assert.match(html, /role="radiogroup" aria-labelledby="library-match-sha:a{40}"/);
});

test("choices show most stars first, whatever order they arrive in", () => {
  const skill = (stars?: number) => (stars === undefined ? null : { stars } as never);
  assert.deepEqual(byStars(["a/x", "b/x", "c/x"], [skill(6), skill(138000), skill(84)]), ["b/x", "c/x", "a/x"]);
  assert.deepEqual(byStars(["a/x", "b/x"], []), ["a/x", "b/x"]);
});

test("a skill is a potential match while one of its copies is unlinked with several library matches", () => {
  const offer = { catalogMatchKey: key, catalogCandidates: ["big/repo:x", "fork/repo:x"] };
  assert.equal(potentialMatch({ installed: { sourceSkills: [offer] } }), true);
  assert.equal(potentialMatch({ installed: { sourceSkills: [{ ...offer, catalogSkillId: "big/repo:x" }] } }), false);
  assert.equal(potentialMatch({ installed: { sourceSkills: [{}] } }), false);
  assert.equal(potentialMatch({}), false);
});

test("shown under a library skill that isn't a candidate: offered to keep that creator, saved for the name", async () => {
  const nameKey = `n:${"c".repeat(64)}`;
  assert.deepEqual(libraryMatchOf([{ catalogMatchKey: key, catalogCandidates: ["garrytan/gstack:pair-agent"], catalogNameKey: nameKey }]),
    { matchKey: key, candidates: ["garrytan/gstack:pair-agent"], nameKey });
  assert.equal(libraryMatchOf([{ catalogMatchKey: key, catalogCandidates: ["a/b"], catalogNameKey: "nope" }])?.nameKey, undefined);
  const render = (current?: { catalogId: string; author: string }, withName = true) => renderToStaticMarkup(createElement(LibraryMatchPicker, {
    match: { matchKey: key, candidates: ["garrytan/gstack:pair-agent"], ...(withName ? { nameKey } : {}) },
    current, load: async () => [], choose: async () => {},
  }));
  assert.match(render({ catalogId: "howdeploy/NekoFree:pair-agent", author: "howdeploy" }), /Keep @howdeploy/);
  // Already a candidate ("This one" covers it), not shown under a library skill, or nowhere to save it: no third option.
  assert.doesNotMatch(render({ catalogId: "garrytan/gstack:pair-agent", author: "garrytan" }), /Keep/);
  assert.doesNotMatch(render(), /Keep/);
  assert.doesNotMatch(render({ catalogId: "howdeploy/NekoFree:pair-agent", author: "howdeploy" }, false), /Keep/);
});
