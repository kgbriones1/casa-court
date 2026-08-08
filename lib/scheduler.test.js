import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { generateDraft, eligiblePlayers, typeCoverage, matchTypeLabel } from "./scheduler.js";

// Deterministic PRNG so the simulated event below doesn't flake in CI --
// scheduler.js's shuffle() calls Math.random() directly.
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let originalRandom;
beforeAll(() => {
  originalRandom = Math.random;
  Math.random = mulberry32(42);
});
afterAll(() => {
  Math.random = originalRandom;
});

function makePlayer(id, gender, attendance_status = "checked_in") {
  return {
    id,
    gender,
    attendance_status,
    display_name: id,
    games_played: 0,
    last_played_round: null,
    partner_ids: [],
    opponent_counts: {},
  };
}

// Mirrors the history-mutation half of lib/db.js's publishRound(), plus an
// immediate games_played increment -- standing in for "the round got scored"
// so priorityScore() has real numbers to balance against on the next round,
// same as a real event where you score before drafting the next one.
function applyPublish(byId, matches, roundNumber) {
  matches.forEach((m) => {
    const [a1, a2] = m.team_a;
    const [b1, b2] = m.team_b;
    byId[a1].partner_ids.push(a2);
    byId[a2].partner_ids.push(a1);
    byId[b1].partner_ids.push(b2);
    byId[b2].partner_ids.push(b1);
    [a1, a2, b1, b2].forEach((id) => {
      byId[id].last_played_round = roundNumber;
      byId[id].games_played += 1;
    });
    m.team_a.forEach((a) =>
      m.team_b.forEach((b) => {
        byId[a].opponent_counts[b] = (byId[a].opponent_counts[b] || 0) + 1;
        byId[b].opponent_counts[a] = (byId[b].opponent_counts[a] || 0) + 1;
      })
    );
  });
}

// Reproduces the real test event from the handoff doc: 30 players (6 women /
// 24 men), 3 courts, run long enough (16 rounds ~= a 4-hour window at 18min
// rounds) to actually stress the partner-pool, coverage, and pacing rules.
function runEvent({ women = 6, men = 24, courts = 3, rounds = 16 } = {}) {
  const players = [
    ...Array.from({ length: women }, (_, i) => makePlayer(`w${i + 1}`, "female")),
    ...Array.from({ length: men }, (_, i) => makePlayer(`m${i + 1}`, "male")),
  ];
  const byId = Object.fromEntries(players.map((p) => [p.id, p]));

  let justPlayedIds = new Set();
  const warningsByRound = [];
  const matchesByRound = [];
  const errors = [];

  for (let round = 1; round <= rounds; round++) {
    const draft = generateDraft(players, courts, round, new Set(), justPlayedIds);

    if (draft.error) {
      errors.push({ round, error: draft.error });
      justPlayedIds = new Set();
      continue;
    }

    warningsByRound.push({ round, warnings: draft.warnings });
    matchesByRound.push({ round, matches: draft.matches });
    applyPublish(byId, draft.matches, round);
    justPlayedIds = new Set(draft.matches.flatMap((m) => [...m.team_a, ...m.team_b]));
  }

  return { players, byId, warningsByRound, matchesByRound, errors };
}

describe("scheduler regression audit (30 players, 6 women / 24 men, 3 courts, 16 rounds, mixed doubles allowed)", () => {
  let sim;
  // Must run inside beforeAll, not directly in the describe body: describe bodies run
  // during Vitest's collection phase, before the outer beforeAll above (which seeds
  // Math.random) has fired -- calling runEvent() here would silently use real,
  // unseeded randomness and make every assertion below flaky.
  beforeAll(() => { sim = runEvent(); });

  test("every round generates without error", () => {
    expect(sim.errors).toEqual([]);
    expect(sim.matchesByRound.length).toBe(16);
  });

  test("every match's division is a known type and matchTypeLabel never throws", () => {
    sim.matchesByRound.forEach(({ matches }) => {
      matches.forEach((m) => {
        expect(["women", "men", "mixed", "edge"]).toContain(m.division);
        expect(() => matchTypeLabel(m, sim.byId)).not.toThrow();
      });
    });
  });

  test("never repeats a partnership, unless the partner pool is exhausted and a warning was logged that round", () => {
    const exhaustedRounds = new Set();
    sim.warningsByRound.forEach(({ round, warnings }) => {
      if (warnings.some((w) => w.includes("partner pool is exhausted"))) exhaustedRounds.add(round);
    });

    const seenPairs = new Set();
    sim.matchesByRound.forEach(({ round, matches }) => {
      matches.forEach((m) => {
        [m.team_a, m.team_b].forEach(([p1, p2]) => {
          const key = [p1, p2].sort().join("|");
          if (seenPairs.has(key)) {
            expect(exhaustedRounds.has(round), `repeat partnership ${key} in round ${round} with no exhaustion warning that round`).toBe(true);
          }
          seenPairs.add(key);
        });
      });
    });
  });

  test("never plays a player back-to-back, unless the rest gap was relaxed and a warning was logged that round", () => {
    const relaxedRounds = new Set();
    sim.warningsByRound.forEach(({ round, warnings }) => {
      if (warnings.some((w) => w.startsWith("Not enough rested players"))) relaxedRounds.add(round);
    });

    let previousRoundPlayers = new Set();
    sim.matchesByRound.forEach(({ round, matches }) => {
      const thisRoundPlayers = new Set(matches.flatMap((m) => [...m.team_a, ...m.team_b]));
      thisRoundPlayers.forEach((id) => {
        if (previousRoundPlayers.has(id)) {
          expect(relaxedRounds.has(round), `${id} played back-to-back into round ${round} with no rest-gap relaxation warning`).toBe(true);
        }
      });
      previousRoundPlayers = thisRoundPlayers;
    });
  });

  // The rule that replaced strict segregation: mixed doubles is allowed, and every
  // player who's actually played must have tried both types applicable to their
  // gender (their own-gender doubles, and mixed) at least once. Best-effort, not a
  // hard filter at generation time -- checked here against the finished simulation.
  test("every player who played has experienced both their own-gender doubles and mixed doubles at least once", () => {
    const gaps = sim.players
      .filter((p) => p.games_played > 0)
      .map((p) => ({ p, ...typeCoverage(p, sim.byId) }))
      .filter(({ own, mixed }) => own === 0 || mixed === 0);
    expect(gaps, `players missing a type: ${gaps.map(({ p, own, mixed }) => `${p.id} (own=${own}, mixed=${mixed})`).join(", ")}`).toEqual([]);
  });

  test("edge (uneven) compositions are rare -- used only as a last resort, not a routine choice", () => {
    const totalMatches = sim.matchesByRound.reduce((s, { matches }) => s + matches.length, 0);
    const edgeMatches = sim.matchesByRound.reduce((s, { matches }) => s + matches.filter((m) => m.division === "edge").length, 0);
    expect(edgeMatches / totalMatches).toBeLessThan(0.1);
  });

  test("generateDraft never mutates its input players (draft-only rounds can't leak into history)", () => {
    const players = [makePlayer("a", "female"), makePlayer("b", "female"), makePlayer("c", "female"), makePlayer("d", "female")];
    const snapshot = JSON.parse(JSON.stringify(players));
    generateDraft(players, 1, 1);
    expect(players).toEqual(snapshot);
  });

  test("repeat opponents stay a small minority of matchups (soft constraint; mixed doubles measured ~8%, well under strict segregation's ~35%)", () => {
    let totalOpponentPairs = 0;
    const metPairs = new Map();
    sim.matchesByRound.forEach(({ matches }) => {
      matches.forEach((m) => {
        m.team_a.forEach((a) => m.team_b.forEach((b) => {
          totalOpponentPairs++;
          const key = [a, b].sort().join("|");
          metPairs.set(key, (metPairs.get(key) || 0) + 1);
        }));
      });
    });
    const repeatedPairs = [...metPairs.values()].filter((c) => c > 1).length;
    expect(repeatedPairs / totalOpponentPairs).toBeLessThan(0.2);
  });

  test("games played stay tightly balanced across all players", () => {
    const counts = sim.players.map((p) => p.games_played);
    const spread = Math.max(...counts) - Math.min(...counts);
    expect(spread).toBeLessThanOrEqual(2);
  });

  test("women's and men's average games played track each other (mixed doubles gives the smaller division more court-time efficiency, not less)", () => {
    const avg = (arr) => (arr.length ? arr.reduce((s, p) => s + p.games_played, 0) / arr.length : 0);
    const avgWomen = avg(sim.players.filter((p) => p.gender === "female"));
    const avgMen = avg(sim.players.filter((p) => p.gender === "male"));
    expect(Math.abs(avgWomen - avgMen)).toBeLessThan(1.0);
  });
});

describe("scheduler eligibility", () => {
  test("only checked_in players ever appear in a generated draft -- late/not_arrived/no_show/temporarily_unavailable/withdrawn never do", () => {
    const statuses = ["not_arrived", "late", "checked_in", "temporarily_unavailable", "no_show", "withdrawn"];
    const pool = statuses.map((s) => makePlayer(`status_${s}`, "female", s));
    // pad with enough checked-in players (any gender) to fill 2 courts alongside the one checked_in status player above
    for (let i = 0; i < 7; i++) pool.push(makePlayer(`extra${i}`, "female", "checked_in"));

    const draft = generateDraft(pool, 2, 1);
    const appeared = new Set([...draft.matches.flatMap((m) => [...m.team_a, ...m.team_b]), ...draft.sitting]);

    statuses.filter((s) => s !== "checked_in").forEach((s) => {
      expect(appeared.has(`status_${s}`), `${s} player should never appear in a draft`).toBe(false);
    });
  });
});

describe("eligiblePlayers", () => {
  test("relaxes the rest gap only when strict exclusion would leave fewer than 4 eligible overall", () => {
    const players = [makePlayer("a", "female"), makePlayer("b", "female"), makePlayer("c", "male"), makePlayer("d", "male")];
    const justPlayed = new Set(["a"]);
    const { pool, warnings } = eligiblePlayers(players, new Set(), justPlayed);
    expect(pool.length).toBe(4); // relaxed back to everyone, since excluding "a" leaves only 3
    expect(warnings.length).toBe(1);
  });

  test("does not relax when enough players remain without the just-played ones", () => {
    const players = [
      makePlayer("a", "female"), makePlayer("b", "female"), makePlayer("c", "male"),
      makePlayer("d", "male"), makePlayer("e", "male"), makePlayer("f", "male"),
    ];
    const justPlayed = new Set(["a"]);
    const { pool, warnings } = eligiblePlayers(players, new Set(), justPlayed);
    expect(pool.map((p) => p.id)).not.toContain("a");
    expect(warnings.length).toBe(0);
  });
});
