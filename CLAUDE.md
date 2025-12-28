# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

VoiceSampler is a browser-based audio sampler built with vanilla JavaScript and the Web Audio API. It records voice/audio from a microphone, automatically detects pitch using the YIN algorithm, finds optimal loop points, and enables playback across a virtual keyboard at different pitches.

**Key Technologies:**
- Pure vanilla JavaScript (no build step or dependencies)
- Web Audio API (AudioContext, BufferSource, GainNode)
- MediaRecorder API for audio capture
- HTML5 Canvas for visualizations

## Running the Application

**Recommended method:**
```bash
npx serve .
```

**Alternative methods:**
```bash
# Python
python -m http.server 8000

# PHP
php -S localhost:8000
```

Then open `http://localhost:8000` in a browser.

**Note:** Opening `index.html` directly may work but some browsers restrict microphone access on `file://` URLs.

## Architecture

### File Structure

- `index.html` - UI structure, semantic HTML with ARIA labels
- `style.css` - All styling using CSS custom properties for theming
- `app.js` - UI logic, event handling, DOM manipulation
- `voice-sampler.js` - Core audio engine (VoiceSampler and MicRecorder classes)

### Audio Engine (`voice-sampler.js`)

**VoiceSampler Class:**
- Manages sample playback with pitch shifting via `playbackRate`
- YIN pitch detection algorithm (more accurate than autocorrelation)
- Automatic loop point detection based on amplitude consistency
- Crossfade looping for click-free playback
- Voice pooling with configurable steal modes (oldest/quietest/none)
- ADSR envelope per note
- Event system for UI integration

**Key Implementation Details:**
- Root pitch detection: Uses YIN algorithm with parabolic interpolation for sub-sample accuracy (voice-sampler.js:540-619)
- Loop finding: Searches for steady-state region (25-75% of sample) with consistent RMS, snaps to zero crossings (voice-sampler.js:621-693)
- Crossfade buffer: Pre-renders crossfaded loop to eliminate clicks (voice-sampler.js:418-466)
- Playback rate adjustment: Loop region extends proportionally to maintain constant perceived loop duration across different pitches (voice-sampler.js:186-192)

**MicRecorder Class:**
- Manages microphone recording with level monitoring
- Uses AnalyserNode for real-time level metering
- Automatic codec selection (prefers Opus in WebM)

### UI Logic (`app.js`)

**State Management:**
- Single `state` object tracks recording status, octave, loop points, dragging state
- No framework - direct DOM manipulation

**Key Features:**
- Virtual keyboard: Generated dynamically with white/black keys
- Computer keyboard mapping: A-L keys for notes (KEY_MAP object at line 98)
- Loop handle dragging: Pointer events with constraints for minimum loop duration
- Real-time visualizations: Waveform and ADSR envelope using Canvas

**Event Flow:**
1. Recording: User clicks Rec → `MicRecorder.start()` → level monitoring begins
2. Stop: `MicRecorder.stop()` returns blob → `VoiceSampler.loadFromBlob()` analyzes and loads
3. Analysis: YIN pitch detection + loop finding → UI updates with results
4. Playback: Keyboard input → `noteOn(midiNote)` creates voice with pitch-shifted BufferSource

## Common Modifications

### Adjusting Pitch Detection
- YIN threshold: `voice-sampler.js:543` (lower = more sensitive, higher = more conservative)
- Frequency range: `voice-sampler.js:541-542` (minHz/maxHz)

### Loop Detection Tuning
- Search region: `voice-sampler.js:641-642` (currently 25-75% of sample)
- Loop length: `voice-sampler.js:625-626` (150-600ms range)
- Crossfade duration: `voice-sampler.js:28` (default 15ms)

### Envelope Defaults
- Default ADSR: `voice-sampler.js:42-47` or HTML slider values in `index.html:98-114`

### Polyphony
- Max voices: Configured via UI select at `index.html:150-155`
- Steal mode: `voice-sampler.js:331-372` (oldest/quietest/none)

### Keyboard Layout
- Note mapping: `app.js:98-102` (KEY_MAP object)
- Virtual keyboard range: `app.js:485-499` (currently C to C, 13 keys)

## Audio Processing Pipeline

**Recording:**
```
Microphone → MediaStreamSource → AnalyserNode (for metering)
                              ↓
                          MediaRecorder → Blob
```

**Playback:**
```
AudioBuffer → BufferSource (pitch-shifted) → GainNode (ADSR envelope) → Output
```

**Analysis Pipeline:**
1. Trim silence from edges (voice-sampler.js:499-538)
2. YIN pitch detection on trimmed audio (voice-sampler.js:540-619)
3. Find optimal loop region based on amplitude stability (voice-sampler.js:621-693)
4. Pre-render crossfade buffer (voice-sampler.js:418-466)

## Browser Compatibility

- Chrome/Edge 80+
- Firefox 75+
- Safari 14+
- Requires: Web Audio API, MediaRecorder API, getUserMedia

## Important Constraints

- No build step - keep everything vanilla JS/HTML/CSS
- No external dependencies or libraries
- Must work with direct file serving (no bundler)
- All audio processing happens client-side
