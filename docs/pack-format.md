# Character pack format

A character is a folder `packs/<id>/`. Folders starting with `_` are ignored. The loader is `src/pack/index.ts` (types `PackManifest`, `SheetMeta`); behavior types are in `src/behavior/mind.ts` (`MindConfig`). `packs/mage/` is a complete example. Check a pack with:

```powershell
node scripts/validate-pack.ts packs/<id>
```

To try a pack without your other characters: `$env:DESK_PET_PACKS='packs/<id>'; npm start` (progress is then saved under `temp/` instead of `data/save.json`).

## Files

```
packs/<id>/
  pack.json                                   manifest (required)
  sprites/<variant>/<outfit>/<action>-<facing>.png   sprite sheet
  sprites/<variant>/<outfit>/<action>-<facing>.json  frame table for that sheet
  behaviors.json                              behaviors and reactions (optional; without it: built-in walk / stand / sit)
  persona-sfw.md                              LLM persona (optional)
  voice.json                                  speech blip voice: {"pitch", "speed", "formantScale", "breath"} (optional)
```

Every combination of variant × outfit (of that action) × action × facing must have a `.json` and its `.png`.

## pack.json

| Field | Meaning |
|---|---|
| `schema` | `1` |
| `id`, `name` | id (= folder name), display name |
| `names` | display names in other languages, e.g. `{"en": "Mage"}` |
| `aliases` | other names the LLM may use for this character |
| `adult` | must be `true` ("the character is an adult"); anything else is refused |
| `restHeightModelPx` | standing height in model units (used to scale speeds) |
| `heightRatio` | height relative to the reference character (default 1) |
| `halfWidthRatio` | half the body width / height (collision, spacing) |
| `walkHeightsPerSec` | walking speed in body heights per second |
| `actions` | `{name: {frames, fps, loop, ...}}`; `idle` is required. Optional: `heightsPerSec` (moving actions), `anchor: "seat"` (sit on an edge), `outfits` (only these outfits have sheets), `hip` (per-frame hip x offset per facing, smooths action switches), `transition: {from, to}` (a generated in-between clip) |
| `transitions` | `[{from, to, action, entries: {action: [frames]}}]`: when switching to `to`, play `action` first if the current action is at one of the entry frames |
| `outfits` | from most to least dressed; the first must be `clothed` |
| `facings` | `["right", "left"]` |
| `variants` | `[{id, renderHeight, outline: "full" \| "inner" \| "none", style?: "smooth"}]`: rendering variants switchable from the tray |
| `defaultVariant` | one of the variant ids |
| `parts` | optional: names of clickable body parts (needs `<sheet>.parts.png` maps) |

Standard actions the engine uses when present: `idle`, `walk`, `sit`, `fall`, `dragged`, `downed`, `getup`, `crouch` (hiding), `jump_start`, `jump_air`, `jump_land`. Anything else can be played from `behaviors.json`.

## Sprite sheet frame table (`<action>-<facing>.json`)

| Field | Meaning |
|---|---|
| `action`, `facing`, `outfit`, `variant` | which sheet this is |
| `frames`, `fps`, `loop` | must match `pack.json` |
| `cell` | `[w, h]` of one frame, in render pixels |
| `cols` | frames per row |
| `chunk` | optional: frames per file when split; files are then `<sheet>.c0.png`, `<sheet>.c1.png`, ... |
| `foot` | `[x, y]` foot point inside a cell; drawn at the character's position |
| `footY` | optional per-frame foot line (overrides `foot[1]`) |

## behaviors.json

```jsonc
{
  "schema": 1,
  "stats": {"mood": {"start": 60, "toward": 60, "towardPerHour": 10}},
  "relations": {"user": {"affection": 40}},
  "reactions": {
    "click": [{"fx": "heart", "steps": [{"do": "play", "action": "wave", "state": "react"}]}],
    "stroke": {"fx": "heart", "cooldown": 4, "steps": [{"do": "play", "action": "idle", "sec": 2, "state": "react"}]},
    "discovered": {"steps": [{"do": "play", "action": "coy", "sec": 1.5, "state": "discovered"}]}
  },
  "behaviors": [
    {"id": "wander", "weight": 4, "steps": [{"do": "wander"}]},
    {"id": "sit", "weight": 2, "cooldown": 30, "when": {"==": [{"var": "self.support"}, "window"]}, "steps": [{"do": "sit", "sec": [10, 60]}]}
  ]
}
```

- `weight`, `when`, `prefer` and reaction `when` are numbers or [JSON Logic](https://jsonlogic.com/) over the character's view of the world (`self.*`, `others.<id>.*`, `user.*`, `env.*`; see `MindView` in `src/behavior/mind.ts`).
- Steps (`StepTemplate`): `idle`, `wander`, `sit`, `play`, `gotoHide`, `hide`, `unhide`, `outfit`, `approach`, `hop`, `enter`, `leave`, `emerge`, `peek`, `hideHere`.
- Reaction keys: `click`, `stroke`, `click:<part>`, `stroke:<part>`, `discovered`, `returned`.
- `next` chains behaviors; `effects: {start, end, interrupt}` change stats (`"stats.mood": 3`) and relations (`"relations.user.affection": 1`).
- `desktopDefault: "absent"` keeps a newly installed character off the desktop until it is ticked in the tray.
- `dialogueBanned`: words removed from generated lines (`[]` disables the filter).
