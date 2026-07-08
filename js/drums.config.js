// drums.config.js — a fuel-drum cluster: four standing (one hazard-striped), one
// stacked on top, one tipped over. Cheap clutter that makes a corner look worked-in.
export default {"id":"drums","name":"Fuel Drums","category":"structure","accent":false,"destructible":{"type":"building","hp":30},"footprint":{"w":1,"d":1},"parts":[
{"kind":"cylinder","pos":[-0.6,0.58,-0.5],"mat":{"color":"#4a5240","mapKind":"metal"},"fallAt":0.5,"params":{"rt":0.4,"rb":0.4,"h":1.15,"seg":10}},
{"kind":"cylinder","pos":[0.3,0.58,-0.7],"mat":{"color":"#6e4a34","mapKind":"metal"},"fallAt":0.6,"params":{"rt":0.4,"rb":0.4,"h":1.15,"seg":10}},
{"kind":"cylinder","pos":[-0.1,0.58,0.3],"mat":{"color":"#ffffff","mapKind":"hazard","tile":[2,1]},"fallAt":0.4,"params":{"rt":0.4,"rb":0.4,"h":1.15,"seg":10}},
{"kind":"cylinder","pos":[0.8,0.58,0.1],"mat":{"color":"#4a5240","mapKind":"metal"},"fallAt":0.5,"params":{"rt":0.4,"rb":0.4,"h":1.15,"seg":10}},
{"kind":"cylinder","pos":[-0.15,1.73,-0.6],"mat":{"color":"#5f5a3a","mapKind":"metal"},"fallAt":0.2,"params":{"rt":0.4,"rb":0.4,"h":1.15,"seg":10}},
{"kind":"cylinder","pos":[0.5,0.42,1.2],"rot":[0,0,1.571],"mat":{"color":"#6e4a34","mapKind":"metal"},"fallAt":0.4,"params":{"rt":0.4,"rb":0.4,"h":1.15,"seg":10}}]}
