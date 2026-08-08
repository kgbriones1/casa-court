import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { generateDraft, suggestCourtSplit, eligiblePlayersByGender } from "./scheduler.js";

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
// rounds) to actually stress the partner-pool and pacing constraints.
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
    // Must mirror app/admin/[eventId]/page.js exactly: computing the court split from a
    // raw "!justPlayedIds" filter (ignoring generateDraft's own rest-gap relaxation) was
    // the actual bug this suite caught -- see lib/scheduler.js's eligiblePlayersByGender.
    const { eligibleByGender } = eligiblePlayersByGender(players, new Set(), justPlayedIds);
    const split = suggestCourtSplit(eligibleByGender.female, eligibleByGender.male, courts);
    const draft = generateDraft(players, courts, round, new Set(), justPlayedIds, split);

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

describe("scheduler regression audit (30 players, 6 women / 24 men, 3 courts, 16 rounds)", () => {
  // Must run inside beforeAll, not directly in the describe body: describe bodies run
  // during Vitest's collection phase, before the outer beforeAll above (which seeds
  // Math.random) has fired -- calling runEvent() here would silently use real,
  // unseeded randomness and make every assertion below flaky.
  let sim;
  beforeAll(() => { sim = runEvent(); });

  test("every round generates without error", () => {
    expect(sim.errors).toEqual([]);
    expect(sim.matchesByRound.length).toBe(16);
  });

  test("never repeats a partnership within a division, unless that division's pair budget is exhausted and a warning was logged for that round", () => {
    const seenPairs = { female: new Set(), male: new Set() };
    const exhaustedRounds = { female: new Set(), male: new Set() };
    sim.warningsByRound.forEach(({ round, warnings }) => {
      warnings.forEach((w) => {
        if (w.includes("Women's partner pool is exhausted")) exhaustedRounds.female.add(round);
        if (w.includes("Men's partner pool is exhausted")) exhaustedRounds.male.add(round);
      });
    });

    sim.matchesByRound.forEach(({ round, matches }) => {
      matches.forEach((m) => {
        const gender = m.division;
        [m.team_a, m.team_b].forEach(([p1, p2]) => {
          const key = [p1, p2].sort().join("|");
          if (seenPairs[gender].has(key)) {
            expect(exhaustedRounds[gender].has(round), `repeat partnership ${key} in round ${round} (${gender}) with no exhaustion warning that round`).toBe(true);
          }
          seenPairs[gender].add(key);
        });
      });
    });
  });

  test("never plays a player back-to-back, unless the rest gap was relaxed and a warning was logged for that round", () => {
    const relaxedRounds = { female: new Set(), male: new Set() };
    sim.warningsByRound.forEach(({ round, warnings }) => {
      warnings.forEach((w) => {
        if (w.startsWith("Not enough rested women")) relaxedRounds.female.add(round);
        if (w.startsWith("Not enough rested men")) relaxedRounds.male.add(round);
      });
    });

    let previousRoundPlayers = new Set();
    sim.matchesByRound.forEach(({ round, matches }) => {
      const genderOfId = {};
      matches.forEach((m) => [...m.team_a, ...m.team_b].forEach((id) => { genderOfId[id] = m.division; }));
      const thisRoundPlayers = new Set(Object.keys(genderOfId));
      thisRoundPlayers.forEach((id) => {
        if (previousRoundPlayers.has(id)) {
          const gender = genderOfId[id];
          expect(relaxedRounds[gender].has(round), `${id} played back-to-back into round ${round} (${gender}) with no rest-gap relaxation warning`).toBe(true);
        }
      });
      previousRoundPlayers = thisRoundPlayers;
    });
  });

  test("every match is strictly single-gender and matches its division label -- zero exceptions", () => {
    sim.matchesByRound.forEach(({ matches }) => {
      matches.forEach((m) => {
        const ids = [...m.team_a, ...m.team_b];
        const genders = new Set(ids.map((id) => sim.byId[id].gender));
        expect(genders.size).toBe(1);
        expect([...genders][0]).toBe(m.division);
      });
    });
  });

  // "History integrity" per the audit also requires that a drafted-but-unpublished
  // round never touches players.partner_ids/opponent_counts -- that guarantee lives
  // in lib/db.js (publishRound is the only thing that mutates history, and it's only
  // called on an explicit Publish click). It isn't reachable from scheduler.js alone
  // without mocking Supabase, so this only covers the pure-function half: generateDraft
  // must not mutate what it's given.
  test("generateDraft never mutates its input players (draft-only rounds can't leak into history)", () => {
    const players = [makePlayer("a", "female"), makePlayer("b", "female"), makePlayer("c", "female"), makePlayer("d", "female")];
    const snapshot = JSON.parse(JSON.stringify(players));
    generateDraft(players, 1, 1);
    expect(players).toEqual(snapshot);
  });

  // Checked per division, not pooled -- a 6-woman division playing 14+ rounds while
  // never repeating a partner (rule #1, which outranks this one) will structurally run
  // through its 15 possible opponent pairs and start repeating them; that's pigeonhole
  // arithmetic, not an algorithm defect. Pooling both divisions into one ratio let that
  // unavoidable small-division math mask whether the metric is actually healthy where
  // it's meaningful: the 24-man division, which has enough players that a real defect
  // (e.g. the search not bothering to spread opponents) would show up clearly.
  test("repeat opponents stay a small minority of matchups in a well-supplied division (soft constraint; real run measured ~6%)", () => {
    let totalMatches = 0;
    const metPairs = new Map();
    sim.matchesByRound.forEach(({ matches }) => {
      matches.forEach((m) => {
        if (m.division !== "male") return;
        totalMatches++;
        m.team_a.forEach((a) => m.team_b.forEach((b) => {
          const key = [a, b].sort().join("|");
          metPairs.set(key, (metPairs.get(key) || 0) + 1);
        }));
      });
    });
    const repeatedPairs = [...metPairs.values()].filter((c) => c > 1).length;
    // Healthy runs land ~4-16%; disabling REPEAT_OPPONENT entirely (to calibrate this
    // bound) pushed it to ~24%. 20% sits clear of both, so it won't flake on incidental
    // Math.random draws yet still catches the constraint actually breaking.
    expect(repeatedPairs / totalMatches).toBeLessThan(0.2);
  });

  test("a division too small to avoid repeat opponents forever still doesn't repeat a pair more than a couple of times", () => {
    const metPairs = new Map();
    sim.matchesByRound.forEach(({ matches }) => {
      matches.forEach((m) => {
        if (m.division !== "female") return;
        m.team_a.forEach((a) => m.team_b.forEach((b) => {
          const key = [a, b].sort().join("|");
          metPairs.set(key, (metPairs.get(key) || 0) + 1);
        }));
      });
    });
    const maxRepeat = Math.max(...metPairs.values());
    expect(maxRepeat).toBeLessThanOrEqual(4);
  });

  test("games played stay tightly balanced across all players (real run: 18 players on 6 games, 12 on 7 -- spread of 1)", () => {
    const counts = sim.players.map((p) => p.games_played);
    const spread = Math.max(...counts) - Math.min(...counts);
    expect(spread).toBeLessThanOrEqual(2);
  });

  test("the smaller division's pace tracks the larger division's -- doesn't run away or lag behind (real run: 6.7 avg women vs 6.3 avg men)", () => {
    const avg = (arr) => arr.reduce((s, p) => s + p.games_played, 0) / arr.length;
    const avgWomen = avg(sim.players.filter((p) => p.gender === "female"));
    const avgMen = avg(sim.players.filter((p) => p.gender === "male"));
    expect(Math.abs(avgWomen - avgMen)).toBeLessThan(1.0);
  });
});

describe("scheduler eligibility", () => {
  test("only checked_in players ever appear in a generated draft -- late/not_arrived/no_show/temporarily_unavailable/withdrawn never do", () => {
    const statuses = ["not_arrived", "late", "checked_in", "temporarily_unavailable", "no_show", "withdrawn"];
    const pool = statuses.map((s) => makePlayer(`status_${s}`, "female", s));
    // pad with enough checked-in women to fill 2 courts alongside the one checked_in status player above
    for (let i = 0; i < 7; i++) pool.push(makePlayer(`extra${i}`, "female", "checked_in"));

    const draft = generateDraft(pool, 2, 1);
    const appeared = new Set([...draft.matches.flatMap((m) => [...m.team_a, ...m.team_b]), ...draft.sitting]);

    statuses.filter((s) => s !== "checked_in").forEach((s) => {
      expect(appeared.has(`status_${s}`), `${s} player should never appear in a draft`).toBe(false);
    });
  });
});
