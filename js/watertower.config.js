// watertower.config.js — a tall 4-leg water tower with a team-colour band on the tank.
// The tallest base prop (about 11u) — reads as a landmark from across the island.
export default {"id":"watertower","name":"Water Tower","category":"structure","accent":true,"destructible":{"type":"building","hp":150},"footprint":{"w":1,"d":1},"parts":[
{"kind":"box","pos":[1.35,3.1,1.35],"mat":{"color":"#55585c"},"fallAt":0.3,"params":{"w":0.22,"h":6.4,"d":0.22}},
{"kind":"box","pos":[-1.35,3.1,1.35],"mat":{"color":"#55585c"},"fallAt":0.2,"params":{"w":0.22,"h":6.4,"d":0.22}},
{"kind":"box","pos":[-1.35,3.1,-1.35],"mat":{"color":"#55585c"},"fallAt":0.35,"params":{"w":0.22,"h":6.4,"d":0.22}},
{"kind":"box","pos":[1.35,3.1,-1.35],"mat":{"color":"#55585c"},"fallAt":0.25,"params":{"w":0.22,"h":6.4,"d":0.22}},
{"kind":"box","pos":[1.35,2.4,0],"mat":{"color":"#4a4e52"},"fallAt":0.3,"params":{"w":0.15,"h":0.15,"d":2.9}},
{"kind":"box","pos":[-1.35,2.4,0],"mat":{"color":"#4a4e52"},"fallAt":0.3,"params":{"w":0.15,"h":0.15,"d":2.9}},
{"kind":"box","pos":[0,2.4,1.35],"mat":{"color":"#4a4e52"},"fallAt":0.3,"params":{"w":2.9,"h":0.15,"d":0.15}},
{"kind":"box","pos":[0,2.4,-1.35],"mat":{"color":"#4a4e52"},"fallAt":0.3,"params":{"w":2.9,"h":0.15,"d":0.15}},
{"kind":"box","pos":[0,6.35,0],"mat":{"color":"#6f6a61","mapKind":"concrete"},"fallAt":0.55,"params":{"w":3.4,"h":0.18,"d":3.4}},
{"kind":"cylinder","pos":[0,7.95],"mat":{"color":"#8a8d90","mapKind":"metal","tile":[4,1]},"fallAt":0.75,"params":{"rt":1.95,"rb":1.95,"h":2.9,"seg":12}},
{"kind":"cylinder","pos":[0,8.62],"mat":{"team":true,"mapKind":"accent"},"fallAt":0.75,"params":{"rt":2.0,"rb":2.0,"h":0.55,"seg":12}},
{"kind":"cylinder","pos":[0,10.0],"mat":{"color":"#4a4e52"},"fallAt":0.85,"params":{"rt":0.12,"rb":2.05,"h":1.1,"seg":12}},
{"kind":"cylinder","pos":[0,3.2],"mat":{"color":"#55585c"},"fallAt":0.5,"params":{"rt":0.14,"rb":0.14,"h":6.4,"seg":8}}]}
