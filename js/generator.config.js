// generator.config.js — a skid-mounted diesel generator: hazard-striped skid, olive
// genset body, radiator end, exhaust stack, saddle fuel tank, team-colour control panel.
export default {"id":"generator","name":"Power Generator","category":"structure","accent":true,"destructible":{"type":"building","hp":60},"footprint":{"w":1,"d":1},"parts":[
{"kind":"box","pos":[0,0.12,0],"mat":{"color":"#ffffff","mapKind":"hazard","tile":[3,1]},"fallAt":0.6,"params":{"w":2.7,"h":0.24,"d":1.7}},
{"kind":"box","pos":[-0.25,0.95,0],"mat":{"color":"#4a5240","mapKind":"metal","tile":[2,1]},"fallAt":0.7,"params":{"w":1.9,"h":1.4,"d":1.4}},
{"kind":"box","pos":[0.95,0.9,0],"mat":{"color":"#3a4034","mapKind":"metal"},"fallAt":0.5,"params":{"w":0.5,"h":1.2,"d":1.3}},
{"kind":"cylinder","pos":[-0.7,1.95,-0.35],"mat":{"color":"#2e2e30"},"fallAt":0.3,"params":{"rt":0.1,"rb":0.1,"h":0.9,"seg":8}},
{"kind":"cylinder","pos":[-0.7,2.5,-0.35],"mat":{"color":"#2e2e30"},"fallAt":0.3,"params":{"rt":0.16,"rb":0.16,"h":0.22,"seg":8}},
{"kind":"box","pos":[-0.25,0.95,0.73],"mat":{"team":true,"mapKind":"accent"},"fallAt":0.4,"params":{"w":0.6,"h":0.5,"d":0.06}},
{"kind":"cylinder","pos":[0.1,0.42,-0.95],"rot":[0,0,1.571],"mat":{"color":"#5f5a3a","mapKind":"metal"},"fallAt":0.4,"params":{"rt":0.34,"rb":0.34,"h":1.5,"seg":10}}]}
