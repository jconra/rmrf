// quonset.config.js — the Quonset Hut, redesigned in the asset-designer and exported
// as data. Built by AssetBuilder.buildAssetGroup: a half-buried ribbed-steel barrel
// vault (the classic quonset arch) with a dark end wall at the door end.
// To update: redesign in the asset-designer, EXPORT, re-bake here.
// (The export's redundant baked-geometry blob was stripped — the door is a plain
// params box; the exporter no longer emits blobs for pristine primitives.)
export default {"id":"quonset","name":"Quonset Hut","category":"structure","accent":true,"destructible":{"type":"building","hp":140},"footprint":{"w":1,"d":2},"parts":[{"kind":"cylinder","rot":[1.571],"mat":{"color":"#ffffff","roughness":0.7,"metalness":0.3,"flatShading":false,"mapKind":"metal","rot":90},"params":{"rt":2.25,"rb":2.25,"h":6.5,"seg":16}},{"kind":"box","pos":[0,0.58,3.26],"scale":[0.732,0.837],"mat":{"color":"#3b3f44","roughness":0.6,"metalness":0.2,"mapKind":"concrete"},"params":{"w":1.5,"h":2,"d":0.3}}]}
