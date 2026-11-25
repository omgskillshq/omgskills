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
  assert.match(html, />Neither</);
  assert.match(html, /role="radiogroup" aria-labelledby="library-match-sha:a{40}"/);
  const label = (candidates: string[]) => renderToStaticMarkup(createElement(LibraryMatchPicker, {
    match: { matchKey: key, candidates }, load: async () => [], choose: async () => {} }));
  assert.match(label(["a/b:x"]), />No, it isn&#x27;t</);
  assert.match(label(["a/b:x", "c/d:x", "e/f:x"]), />None of these</);
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

test("shown under a library skill that isn't a candidate: offered to keep that creator when the server allows it", async () => {
  const nameKey = `n:${"c".repeat(64)}`;
  const also = ["howdeploy/NekoFree:pair-agent"];
  assert.deepEqual(libraryMatchOf([{ catalogMatchKey: key, catalogCandidates: ["garrytan/gstack:pair-agent"], catalogNameKey: nameKey, catalogAlsoByName: also }]),
    { matchKey: key, candidates: ["garrytan/gstack:pair-agent"], nameKey, alsoByName: also });
  assert.equal(libraryMatchOf([{ catalogMatchKey: key, catalogCandidates: ["a/b"], catalogNameKey: "nope", catalogAlsoByName: also }])?.nameKey, undefined);
  const saved: unknown[] = [];
  const picker = (current?: { catalogId: string; author: string }, alsoByName = also) => createElement(LibraryMatchPicker, {
    match: { matchKey: key, candidates: ["garrytan/gstack:pair-agent"], nameKey, alsoByName },
    current, load: async () => [], choose: async (...args) => { saved.push(args); },
  });
  assert.match(renderToStaticMarkup(picker({ catalogId: "howdeploy/NekoFree:pair-agent", author: "howdeploy" })), /Keep @howdeploy/);
  // A candidate already ("This one"), not on a library skill, or one the server wouldn't save: no third option.
  assert.doesNotMatch(renderToStaticMarkup(picker({ catalogId: "garrytan/gstack:pair-agent", author: "garrytan" })), /Keep/);
  assert.doesNotMatch(renderToStaticMarkup(picker()), /Keep/);
  assert.doesNotMatch(renderToStaticMarkup(picker({ catalogId: "howdeploy/NekoFree:pair-agent", author: "howdeploy" }, [])), /Keep/);
});
