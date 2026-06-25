// AssetStaging.js — per-asset DESTRUCTION-STAGING overrides authored in the asset
// designer. To apply an asset's authored crumble, EXPORT it from the designer and paste
// its JSON here keyed by manifest id (only each part's pos + fallAt + dmgStyle are read).
// Anything not listed falls back to Destructible's generic height-based default, so this
// file is purely additive. One source of truth, read by the game when it builds an asset.
//
// Shape:  <id>: { parts: [ { pos:[x,y,z], fallAt:0.8, dmgStyle:'tumble'|'squish' }, ... ] }

export const STAGING = {
  // Example (authored in the designer): the fuel tank's ground hazard strips squish flat
  // early, its legs tumble, and the bulky tank/caps/bands tumble a bit later.
  fuel: { parts: [
    { pos: [0, 2.3, 0],       fallAt: 0.75, dmgStyle: 'tumble' },
    { pos: [-2.38, 2.3, 0],   fallAt: 0.75, dmgStyle: 'tumble' },
    { pos: [2.38, 2.3, 0],    fallAt: 0.75, dmgStyle: 'tumble' },
    { pos: [-1.04, 2.3, 0],   fallAt: 0.75, dmgStyle: 'tumble' },
    { pos: [1.04, 2.3, 0],    fallAt: 0.75, dmgStyle: 'tumble' },
    { pos: [-1.52, 1, -0.84], fallAt: 0.55, dmgStyle: 'tumble' },
    { pos: [-1.52, 1, 0.84],  fallAt: 0.55, dmgStyle: 'tumble' },
    { pos: [1.52, 1, -0.84],  fallAt: 0.55, dmgStyle: 'tumble' },
    { pos: [1.52, 1, 0.84],   fallAt: 0.55, dmgStyle: 'tumble' },
    { pos: [2.38, 2.25, 0],   fallAt: 0.75, dmgStyle: 'tumble' },
    { pos: [-3.38, 0.1, 0],   fallAt: 0.9,  dmgStyle: 'squish' },
    { pos: [3.38, 0.1, 0],    fallAt: 0.9,  dmgStyle: 'squish' },
  ] },
};

// Tag a freshly-built asset GROUP (before it's wrapped in a Destructible) so the staged
// crumble uses the authored thresholds — position-matched to the group's pieces inside
// Destructible. No-op when nothing is authored for that id.
export function applyStaging(group, id) {
  const cfg = STAGING[id];
  if (!cfg || !cfg.parts) return;
  const stages = cfg.parts.filter(p => p && p.pos && (p.fallAt != null || p.dmgStyle));
  if (stages.length) group.userData.fallStages = stages;
}
