// Controls.js — dependency-free, collapsible map-generation panel.
// Lives top-right; collapses to a single button so it's out of the way on mobile.

const FIELDS = [
  { key: 'size',        label: 'World Size',    min: 48,  max: 480, step: 32,   fmt: v => v },
  { key: 'tile',        label: 'Tile Scale',    min: 1,   max: 5,   step: 0.5,  fmt: v => v.toFixed(1) },
  { key: 'noiseScale',  label: 'Island Freq',   min: 1,   max: 6,   step: 0.1,  fmt: v => v.toFixed(1) },
  { key: 'octaves',     label: 'Detail',        min: 1,   max: 8,   step: 1,    fmt: v => v },
  { key: 'seaLevel',    label: 'Sea Level',     min: 0.2, max: 0.7, step: 0.01, fmt: v => v.toFixed(2) },
  { key: 'edgeFalloff', label: 'Edge Ocean',    min: 0,   max: 1.2, step: 0.05, fmt: v => v.toFixed(2) },
  { key: 'heightScale', label: 'Elevation',     min: 3,   max: 16,  step: 0.5,  fmt: v => v.toFixed(1) },
  { key: 'beachHeight', label: 'Beach Width',   min: 0.2, max: 2.5, step: 0.1,  fmt: v => v.toFixed(1) },
  { key: 'grassAmount', label: 'Grass',         min: 0,   max: 1,   step: 0.05, fmt: v => v.toFixed(2) },
];

export class Controls {
  // defaults: a params object (uses cols as the single 'size'). onChange(patch) fires live.
  constructor(defaults, onChange) {
    this.onChange = onChange;
    this.state = {
      size: defaults.cols,
      tile: defaults.tile,
      noiseScale: defaults.noiseScale,
      octaves: defaults.octaves,
      seaLevel: defaults.seaLevel,
      edgeFalloff: defaults.edgeFalloff,
      heightScale: defaults.heightScale,
      beachHeight: defaults.beachHeight,
      grassAmount: defaults.grassAmount,
      seed: defaults.seed,
    };
    this._build();
  }

  // Translate panel state -> IslandMap params patch.
  _patch() {
    return {
      cols: this.state.size,
      rows: this.state.size,
      tile: this.state.tile,
      noiseScale: this.state.noiseScale,
      octaves: this.state.octaves,
      seaLevel: this.state.seaLevel,
      edgeFalloff: this.state.edgeFalloff,
      heightScale: this.state.heightScale,
      beachHeight: this.state.beachHeight,
      grassAmount: this.state.grassAmount,
      seed: this.state.seed,
    };
  }

  _build() {
    const wrap = document.createElement('div');
    wrap.id = 'mapgen';
    wrap.innerHTML = `
      <style>
        #mapgen { position:absolute; top:12px; right:12px; z-index:20;
          font-family:'Courier New',monospace; color:#2b2118; }
        #mapgen .bar { display:flex; gap:6px; justify-content:flex-end; }
        #mapgen button { font-family:inherit; font-size:12px; cursor:pointer;
          background:rgba(255,250,238,0.92);
          border:1px solid #bfa977; border-radius:6px; padding:5px 9px; color:#2b2118; }
        #mapgen button:active { transform:translateY(1px); }
        #mapgen .panel { margin-top:6px; width:226px; padding:10px 12px;
          background:rgba(255,250,238,0.92); border:1px solid #bfa977;
          border-radius:8px; box-shadow:0 4px 14px rgba(0,0,0,0.18); }
        #mapgen .panel.hidden { display:none; }
        #mapgen .row { margin:7px 0; }
        #mapgen .row label { display:flex; justify-content:space-between;
          font-size:11px; letter-spacing:1px; margin-bottom:2px; }
        #mapgen .row .val { color:#8a6d2f; }
        #mapgen input[type=range] { width:100%; accent-color:#c98b2e; }
        #mapgen .seed { display:flex; gap:6px; align-items:center; margin-top:8px;
          border-top:1px solid #d8c79a; padding-top:8px; }
        #mapgen .seed input { width:92px; font-family:inherit; font-size:12px;
          border:1px solid #bfa977; border-radius:5px; padding:3px 5px; background:#fffdf6; }
      </style>
      <div class="bar">
        <button id="mg-toggle">⚙ MAP</button>
      </div>
      <div class="panel hidden" id="mg-panel">
        <div id="mg-rows"></div>
        <div class="seed">
          <span style="font-size:11px;">SEED</span>
          <input id="mg-seed" type="number" value="${this.state.seed}">
          <button id="mg-rand" title="random seed">🎲</button>
        </div>
        <button id="mg-regen" style="width:100%;margin-top:8px;">↻ REGENERATE</button>
      </div>`;
    document.body.appendChild(wrap);

    const rowsEl = wrap.querySelector('#mg-rows');
    for (const f of FIELDS) {
      const row = document.createElement('div');
      row.className = 'row';
      const v = this.state[f.key];
      row.innerHTML = `
        <label>${f.label}<span class="val" id="v-${f.key}">${f.fmt(v)}</span></label>
        <input type="range" id="r-${f.key}" min="${f.min}" max="${f.max}"
               step="${f.step}" value="${v}">`;
      rowsEl.appendChild(row);
      const input = row.querySelector(`#r-${f.key}`);
      const valEl = row.querySelector(`#v-${f.key}`);
      input.addEventListener('input', () => {
        const val = parseFloat(input.value);
        this.state[f.key] = val;
        valEl.textContent = f.fmt(val);
        this.onChange(this._patch());
      });
    }

    const panel = wrap.querySelector('#mg-panel');
    wrap.querySelector('#mg-toggle').addEventListener('click', () => {
      panel.classList.toggle('hidden');
    });

    const seedInput = wrap.querySelector('#mg-seed');
    seedInput.addEventListener('change', () => {
      this.state.seed = parseInt(seedInput.value) || 0;
      this.onChange(this._patch());
    });
    wrap.querySelector('#mg-rand').addEventListener('click', () => {
      this.state.seed = Math.floor(Math.random() * 99999);
      seedInput.value = this.state.seed;
      this.onChange(this._patch());
    });
    wrap.querySelector('#mg-regen').addEventListener('click', () => {
      this.onChange(this._patch());
    });
  }
}
