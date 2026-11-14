import assert from "node:assert/strict";
import { test } from "node:test";
import {
  median,
  normalizeWords,
  parseArgs,
  wordErrorRate,
} from "./benchmark-transcription.mjs";

test("normalizeWords lowercases and strips punctuation, keeps contractions", () => {
  assert.deepEqual(normalizeWords("And so, my fellow Americans: don't!"), [
    "and",
    "so",
    "my",
    "fellow",
    "americans",
    "don't",
  ]);
});

test("wordErrorRate counts substitutions, deletions and insertions", () => {
  assert.equal(wordErrorRate("ask not what", "Ask not, what."), 0);
  assert.equal(wordErrorRate("a b c d", "a x c d"), 0.25); // 1 sub
  assert.equal(wordErrorRate("a b c d", "a c d"), 0.25); // 1 del
  assert.equal(wordErrorRate("a b", "a b c d"), 1); // 2 ins
  assert.equal(wordErrorRate("", ""), 0);
  assert.equal(wordErrorRate("", "noise"), 1);
});

test("median and parseArgs", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.deepEqual(parseArgs(["--fetch-sample", "--runs", "2", "--json"]), {
    "fetch-sample": true,
    runs: "2",
    json: true,
  });
});
