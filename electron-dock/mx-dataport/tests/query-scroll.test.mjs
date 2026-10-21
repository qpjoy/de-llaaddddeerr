import test from "node:test";
import assert from "node:assert/strict";
import { resetQueryScroll, revealQueryResult } from "../apps/web/query-scroll.ts";

function workspace({ height, scrollHeight, offset, scrollTop = 0 }) {
  const moves = [];
  const content = {
    scrollTop,
    clientTop: 1,
    getBoundingClientRect: () => ({ top: 40 }),
    scrollTo(options) {
      moves.push(options);
      this.scrollTop = Math.min(scrollHeight - height, Math.max(0, options.top));
    },
  };
  const result = {
    closest(selector) {
      assert.equal(selector, ".harbor-console");
      return content;
    },
    getBoundingClientRect: () => ({ top: 41 + offset - content.scrollTop }),
    focus(options) { assert.deepEqual(options, { preventScroll: true }); },
    scrollIntoView() { assert.fail("would also scroll the hidden outer frame"); },
  };
  return { content, result, moves };
}

test("large-screen detail that already fits does not move the outer frame or hide the input", () => {
  // Production reproduction: content fits 1272px, but the outer hidden frame
  // was scrolled 313px by scrollIntoView while the visible scrollbar stayed 0.
  const { content, result } = workspace({ height: 1272, scrollHeight: 1272, offset: 313 });
  revealQueryResult(result);
  assert.equal(content.scrollTop, 0);
});

test("long details scroll only the visible content and can return to the input at zero", () => {
  const { content, result, moves } = workspace({ height: 700, scrollHeight: 1700, offset: 347, scrollTop: 500 });
  revealQueryResult(result);
  assert.equal(content.scrollTop, 331);
  assert.equal(result.getBoundingClientRect().top, 57);
  resetQueryScroll(result);
  assert.equal(content.scrollTop, 0);
  assert.deepEqual(moves.at(-1), { top: 0, left: 0, behavior: "instant" });
});

test("new-query remount cancels a retained detail scroll immediately, including repeated navigation", () => {
  const { content, result, moves } = workspace({ height: 600, scrollHeight: 2200, offset: 400, scrollTop: 1200 });
  resetQueryScroll(result);
  resetQueryScroll(result);
  assert.equal(content.scrollTop, 0);
  assert.equal(moves.length, 2);
  assert.ok(moves.every(move => move.behavior === "instant"));
});

test("missing or detached query elements never fall back to scrolling the document", () => {
  resetQueryScroll(null);
  revealQueryResult(null);
  const detached = { closest: () => null, focus: () => {}, getBoundingClientRect: () => assert.fail("no console") };
  resetQueryScroll(detached);
  revealQueryResult(detached);
});
