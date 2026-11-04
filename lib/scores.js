// Pickleball games go to 11, 15 or 21 and are won by 2, so even a long one ends
// in the 20s. Anything past this is a typo (13-111 for 13-11 once put a player
// at +93 on the leaderboard), so it's refused rather than recorded.
export const MAX_SCORE = 30;

/** What's wrong with a score as typed, or null when it's fine to record. */
export function scoreProblem(scoreA, scoreB) {
  if (!Number.isInteger(scoreA) || !Number.isInteger(scoreB)) return "Enter both scores as whole numbers.";
  if (scoreA < 0 || scoreB < 0) return "Scores can't be negative.";
  if (scoreA === 0 && scoreB === 0) return "Enter the score -- 0-0 isn't a result.";
  if (scoreA > MAX_SCORE || scoreB > MAX_SCORE) return `${Math.max(scoreA, scoreB)} is too high for a game score (max ${MAX_SCORE}) -- check for an extra digit.`;
  return null;
}
