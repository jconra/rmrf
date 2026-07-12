// campaign.js — the ordered RMRF campaign: a sequence of designed maps, each unlocked by
// beating the one before it. Progress persists per-browser in localStorage, so a returning
// player keeps their unlocks. The game fetches a level's `file` (same-origin JSON) and hands
// it to the normal designed-map loader; a level with no `file` is an upcoming placeholder.
//
// To add a level: author it in the map-designer, drop the JSON in rmrf/campaign/, and add an
// entry here in play order. Nothing else needs to change — the menu builds from this list.

export const CAMPAIGN = [
  { id: 'basic-training', name: 'Basic Training', file: 'campaign/basic-training.json',
    blurb: 'Crack a lightly-held base and run the flag home. Learn the ropes.' },
  { id: 'crossroads',   name: 'Crossroads',   file: 'campaign/crossroads.json',
    blurb: 'Twin bases across a crossroads. A random opponent, still finding their feet.' },
  // ── Upcoming (no map yet → shown locked) ────────────────────────────────────
  { id: 'the-gauntlet', name: 'The Gauntlet', blurb: 'Coming soon.' },
];

const PROG_KEY = 'rmrf-campaign-done';

// The set of completed level ids (persisted). Safe on private-mode / blocked storage.
export function completedSet() {
  try { return new Set(JSON.parse(localStorage.getItem(PROG_KEY) || '[]')); }
  catch (e) { return new Set(); }
}
export function isCompleted(id) { return completedSet().has(id); }

// Record a level as beaten (unlocks the next one). No-op if already recorded.
export function markCompleted(id) {
  const s = completedSet();
  if (s.has(id)) return;
  s.add(id);
  try { localStorage.setItem(PROG_KEY, JSON.stringify([...s])); } catch (e) { /* storage blocked */ }
}

// A level is unlocked if it's the first, or the PREVIOUS level has been completed.
// (An upcoming level with no `file` still shows locked even once unlocked by progress.)
export function isUnlocked(index) {
  if (index <= 0) return true;
  const prev = CAMPAIGN[index - 1];
  return !!prev && completedSet().has(prev.id);
}
