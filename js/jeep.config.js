// jeep.config.js — a parked olive utility jeep (decorative motor-pool prop, fragile).
export default {"id":"jeep","name":"Utility Jeep","category":"structure","accent":false,"destructible":{"type":"building","hp":40},"footprint":{"w":1,"d":1},"parts":[
{"kind":"box","pos":[0,0.72,0],"mat":{"color":"#4a5240","mapKind":"metal","tile":[2,1]},"fallAt":0.5,"params":{"w":2.9,"h":0.5,"d":1.5}},
{"kind":"box","pos":[1.05,0.86,0],"mat":{"color":"#4a5240"},"fallAt":0.6,"params":{"w":0.85,"h":0.28,"d":1.4}},
{"kind":"box","pos":[1.5,0.6,0],"mat":{"color":"#3a4034"},"fallAt":0.6,"params":{"w":0.06,"h":0.5,"d":1.3}},
{"kind":"box","pos":[0.6,1.28,0],"rot":[0,0,0.15],"mat":{"color":"#22282e","roughness":0.3,"metalness":0.4},"fallAt":0.3,"params":{"w":0.06,"h":0.55,"d":1.35}},
{"kind":"box","pos":[-0.15,0.95,0.35],"mat":{"color":"#33393f"},"fallAt":0.3,"params":{"w":0.5,"h":0.35,"d":0.55}},
{"kind":"box","pos":[-0.15,0.95,-0.35],"mat":{"color":"#33393f"},"fallAt":0.3,"params":{"w":0.5,"h":0.35,"d":0.55}},
{"kind":"cylinder","pos":[1.0,0.44,0.82],"rot":[1.571],"mat":{"color":"#24262a"},"fallAt":0.15,"params":{"rt":0.42,"rb":0.42,"h":0.32,"seg":10}},
{"kind":"cylinder","pos":[-1.0,0.44,0.82],"rot":[1.571],"mat":{"color":"#24262a"},"fallAt":0.2,"params":{"rt":0.42,"rb":0.42,"h":0.32,"seg":10}},
{"kind":"cylinder","pos":[1.0,0.44,-0.82],"rot":[1.571],"mat":{"color":"#24262a"},"fallAt":0.2,"params":{"rt":0.42,"rb":0.42,"h":0.32,"seg":10}},
{"kind":"cylinder","pos":[-1.0,0.44,-0.82],"rot":[1.571],"mat":{"color":"#24262a"},"fallAt":0.15,"params":{"rt":0.42,"rb":0.42,"h":0.32,"seg":10}},
{"kind":"cylinder","pos":[-1.55,0.85,0],"rot":[0,0,1.571],"mat":{"color":"#24262a"},"fallAt":0.4,"params":{"rt":0.42,"rb":0.42,"h":0.28,"seg":10}},
{"kind":"box","pos":[-1.52,0.35,0],"mat":{"color":"#55585c"},"fallAt":0.5,"params":{"w":0.1,"h":0.18,"d":1.45}}]}
