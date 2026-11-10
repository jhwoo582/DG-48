# DG-48 Digger

A pocket-style sampler and step sequencer that runs in the browser. Twelve pads, four groups, sixteen patterns, sampling from any tab or input, and a built-in sound library.

**Try it:** [jhwoo582.github.io/DG-48](https://jhwoo582.github.io/DG-48/) (Chrome or Edge)

The workflow is inspired by small hardware samplers such as the Teenage Engineering EP-133 K.O. II. This is an independent hobby project and is not affiliated with Teenage Engineering.

## Run it

Requires Node.js 18 or newer.

```bash
npm install
npm run dev
```

Open the printed local address in Chrome or Edge. Click once to turn on audio.

`npm run build` writes a static build to `dist/`, which can be served from any static host.

## What it does

- **Pads**: 12 pads × 4 groups (48 sounds), played with the mouse, touch or keyboard. Built-in kits are synthesized in code, so there are no bundled audio files.
- **Sound editing**: trim on the waveform, volume, pitch, pan, attack, release, one-shot or gate, reverse, choke groups.
- **Length**: cut every sound at a note length (1/32 to 1 bar) that follows the tempo, per pad or for a whole group at once.
- **Tempo sync**: stretch a sample from its own BPM to the project tempo, or fit it to a number of bars. Keeps pitch (WSOLA, in a Web Worker) or works like tape.
- **Sampling**: hold the red button (or `G`) to record from a shared browser tab, a mic or interface, or the sampler's own output. Tapping keeps the last 4 seconds. The last 60 seconds are always buffered, so you never miss the moment.
- **Chop**: slice a sample onto the next pads, evenly or at each hit.
- **Library**: browse and preview sounds, then add them to a pad or drag them onto one. Includes classic drum machines, the CC0 Versilian Community Sample Library, and Freesound search.
- **YouTube cue pads**: paste a link and turn the pads into cue points in the video. Hold a pad to play from its cue.
- **Sequencer**: 16 patterns of up to 4 bars, each holding all four groups. Live recording with quantize, swing, metronome, and a song chain.
- **Effects**: one send effect at a time (delay, reverb, chorus, drive) with an XY pad, a master filter and compressor, and punch-in loop and filter effects.
- **Undo and redo** for edits, and everything is saved in the browser (IndexedDB).

## Keyboard

| Keys | Action |
| --- | --- |
| `1 2 3` `Q W E` `A S D` `Z X C` | Pads |
| `Space` | Play / stop |
| `G` (hold) | Sample while held, tap for the last 4 s |
| `↑` `↓` | Group |
| `[` `]` | Pattern |
| `R` | Record into the pattern |
| `N` | Song mode |
| `K` | Keys mode |
| `Y` | YouTube cue pads |
| `L` | Library |
| `T` | Tap tempo |
| `M` | Metronome |
| `7 8 9 0 - =` | Punch-in effects |
| `⌘Z` / `⇧⌘Z` | Undo / redo |

Keys are read by physical position, so they work with any keyboard input language. Sliders and the XY pad also respond to two-finger trackpad swipes.

## Sounds and licenses

The app does not ship any third-party audio. Library sounds are fetched at runtime from their original sources:

| Source | License |
| --- | --- |
| [Versilian Community Sample Library](https://github.com/sgossner/VCSL) | CC0 |
| [tidal-drum-machines](https://github.com/ritchse/tidal-drum-machines) | Not stated. Check before releasing music made with these. |
| [Freesound](https://freesound.org) | Per sound (CC0, CC BY, CC BY-NC). Shown next to each result. |

Sample maps come from [felixroos/dough-samples](https://github.com/felixroos/dough-samples). Freesound search needs your own free API key from [freesound.org/apiv2/apply](https://freesound.org/apiv2/apply). The key is stored only in your browser.

## About sampling

The embedded YouTube player is only used for cue pads. Its audio is never recorded, in line with YouTube's developer policies. Recording from a shared tab or an input works with any source, and you are responsible for having the rights to what you record and release.

## License

[MIT](LICENSE)
