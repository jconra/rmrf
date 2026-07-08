// checkpoint.config.js — a guard booth with a hazard-striped barrier arm (the arm is
// the most fragile piece, so it snaps off first when someone drives through).
export default {"id":"checkpoint","name":"Checkpoint","category":"structure","accent":true,"destructible":{"type":"building","hp":50},"footprint":{"w":1,"d":1},"parts":[
{"kind":"box","pos":[-0.9,1.1,-0.6],"mat":{"color":"#9a948a","mapKind":"concrete"},"fallAt":0.6,"params":{"w":1.5,"h":2.2,"d":1.5}},
{"kind":"box","pos":[-0.9,2.3,-0.6],"mat":{"color":"#6f6a61","mapKind":"concrete"},"fallAt":0.75,"params":{"w":1.8,"h":0.16,"d":1.8}},
{"kind":"box","pos":[-0.9,1.45,0.17],"mat":{"color":"#22282e","roughness":0.3,"metalness":0.4},"fallAt":0.4,"params":{"w":1.1,"h":0.6,"d":0.05}},
{"kind":"box","pos":[-0.9,0.35,0.17],"mat":{"team":true,"mapKind":"accent"},"fallAt":0.5,"params":{"w":1.5,"h":0.25,"d":0.04}},
{"kind":"box","pos":[0.1,0.55,-0.1],"mat":{"color":"#55585c"},"fallAt":0.3,"params":{"w":0.18,"h":1.1,"d":0.18}},
{"kind":"box","pos":[1.3,0.95,-0.1],"mat":{"color":"#ffffff","mapKind":"hazard","tile":[4,0.4]},"fallAt":0.2,"params":{"w":2.4,"h":0.12,"d":0.12}},
{"kind":"box","pos":[-0.25,0.9,-0.1],"mat":{"color":"#2e2e30"},"fallAt":0.3,"params":{"w":0.3,"h":0.3,"d":0.3}}]}
