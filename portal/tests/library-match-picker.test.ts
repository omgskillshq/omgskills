import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { byStars, LibraryMatchPicker, libraryMatchOf } from "../src/app/unified/LibraryMatchPicker";

const key = `sha:${"a".repeat(40)}`;

test("only a well-formed offer to choose is shown", () => {
  assert.deepEqual(libraryMatchOf([{}, { catalogMatchKey: key, catalogCandidates: ["big/repo:x", "fork/repo:x"] }]),
    { matchKey: key, candidates: ["big/repo:x", "fork/repo:x"] });
  for (const bad of [
    { catalogMatchKey: "sha:nope", catalogCandidates: ["a/b", "c/d"] },
    { catalogMatchKey: key, catalogCandidates: ["only/one"] },
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
