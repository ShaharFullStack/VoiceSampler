# Basic Voice Sampler

A browser-based audio sampler that transforms your voice into a playable instrument. Record any sound, and the app automatically detects its pitch and lets you play it across a virtual keyboard at different notes.

## Features

- **One-Click Recording** — Record directly from your microphone with real-time level metering
- **Automatic Pitch Detection** — YIN algorithm accurately detects the root note of your recording
- **Smart Loop Detection** — Automatically finds the best loop region for sustained playback
- **Click-Free Looping** — Crossfade processing eliminates pops and clicks at loop points
- **Adjustable Loop Region** — Drag handles on the waveform to fine-tune loop start/end
- **Virtual Keyboard** — Play with mouse/touch or computer keyboard (A-L keys)
- **ADSR Envelope** — Shape your sound with Attack, Decay, Sustain, and Release controls
- **Polyphonic Playback** — Play chords with up to 16 simultaneous voices
- **Zero Dependencies** — Pure vanilla JavaScript, no build step required

##  Quick Start

### Option 1: Direct File Access
Simply open `index.html` in a modern browser. Note: Some browsers may restrict microphone access for `file://` URLs.

### Option 2: Local Server (Recommended)
```bash
# Using Node.js
npx serve .

# Using Python
python -m http.server 8000

# Using PHP
php -S localhost:8000
```

Then open `http://localhost:8000` in your browser.

##  How to Use

1. **Record** — Click the Record button and sing or play a steady tone (1-3 seconds works best)
2. **Wait** — The app analyzes your recording to detect pitch and find optimal loop points
3. **Play** — Use the virtual keyboard or your computer keyboard to play notes:

| Keys | Notes |
|------|-------|
| A S D F G H J K | C D E F G A B C |
| W E T Y U O | C# D# F# G# A# |

4. **Adjust** — Drag loop handles on the waveform to change the sustained portion
5. **Shape** — Use the ADSR sliders to control how notes start and fade

## Settings

| Setting | Description |
|---------|-------------|
| **Polyphony** | Maximum simultaneous notes (1-16) |
| **Auto Normalize** | Automatically adjusts recording volume |
| **Manual Root Note** | Override the detected pitch |
| **Volume** | Master output level |

## Technical Details

### Audio Engine
- **Pitch Detection**: YIN algorithm with parabolic interpolation for sub-sample accuracy
- **Loop Processing**: Crossfade at loop boundaries, zero-crossing alignment
- **Voice Management**: Pooling with configurable steal modes (oldest/quietest)
- **Sample Rate**: Native browser sample rate (typically 44.1kHz or 48kHz)

### Browser Compatibility
- Chrome/Edge 80+
- Firefox 75+
- Safari 14+
- Mobile browsers with Web Audio API support

### APIs Used
- Web Audio API (AudioContext, BufferSource, GainNode)
- MediaRecorder API
- getUserMedia for microphone access

##  Project Structure

```
voice-sampler/
├── index.html         # UI structure
├── style.css          # Styling (CSS custom properties)
├── app.js             # UI logic & event handling
├── voice-sampler.js   # Audio engine
├── README.md          # This file
└── CLAUDE.md          # AI assistant documentation
```

##  Customization

### Theming
Edit CSS custom properties in `style.css`:

```css
:root {
  --color-primary: #6366f1;      /* Main accent color */
  --color-secondary: #ec4899;    /* Secondary accent */
  --color-bg: #0f0f1a;           /* Background */
  --color-bg-card: #1a1a2e;      /* Card backgrounds */
}
```

### Default Envelope
Modify initial ADSR values in `index.html` slider attributes or `app.js` state.

##  API Reference

### VoiceSampler

```javascript
const sampler = new VoiceSampler(audioContext, {
  maxPolyphony: 8,           // Max simultaneous voices
  stealMode: 'oldest',       // 'oldest', 'quietest', or 'none'
  normalize: true,           // Auto-normalize recordings
  crossfadeDuration: 0.015   // Loop crossfade in seconds
});

// Load a recording
await sampler.loadFromBlob(audioBlob);

// Play notes
sampler.noteOn(60, 0.8);    // MIDI note 60 (C4), velocity 0.8
sampler.noteOff(60);

// Adjust parameters
sampler.setEnvelope({ attack: 0.1, decay: 0.2, sustain: 0.7, release: 0.3 });
sampler.setLoopPoints(0.2, 0.5);  // seconds
sampler.setRootNote(60);          // MIDI note

// Events
sampler.on('loadComplete', ({ analysis }) => console.log(analysis));
sampler.on('noteOn', ({ midiNote, velocity }) => { });

// Cleanup
sampler.panic();    // Stop all notes
sampler.dispose();  // Full cleanup
```

### MicRecorder

```javascript
const recorder = new MicRecorder(audioContext);

// Level monitoring
recorder.onLevel(level => updateMeter(level)); // 0-1

// Record
await recorder.start();
const blob = await recorder.stop();
```

## License

MIT License — feel free to use in personal and commercial projects.

##  Acknowledgments

- YIN pitch detection algorithm based on [de Cheveigné & Kawahara (2002)](http://audition.ens.fr/adc/pdf/2002_JASA_YIN.pdf)
- Inspired by classic hardware samplers like the Fairlight CMI and E-mu Emulator

---

Made with ❤️ for musicians and creative coders
