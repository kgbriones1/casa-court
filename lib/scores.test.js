import { describe, test, expect } from "vitest";
import { scoreProblem, MAX_SCORE } from "./scores.js";

describe("scoreProblem", () => {
  test("accepts ordinary game scores", () => {
    expect(scoreProblem(11, 7)).toBeNull();
    expect(scoreProblem(13, 11)).toBeNull();
    expect(scoreProblem(21, 19)).toBeNull();
    expect(scoreProblem(11, 0)).toBeNull();
  });

  test("accepts the highest allowed score and rejects one above it", () => {
    expect(scoreProblem(MAX_SCORE, MAX_SCORE - 2)).toBeNull();
    expect(scoreProblem(MAX_SCORE + 1, 11)).toMatch(/too high/);
  });

  test("rejects the typo that put a player at +93 (13-111)", () => {
    expect(scoreProblem(13, 111)).toMatch(/extra digit/);
  });

  test("rejects blanks, fractions, negatives and 0-0", () => {
    expect(scoreProblem(NaN, 11)).toMatch(/whole numbers/);
    expect(scoreProblem(11, 2.5)).toMatch(/whole numbers/);
    expect(scoreProblem(-1, 11)).toMatch(/negative/);
    expect(scoreProblem(0, 0)).toMatch(/0-0/);
  });
});
