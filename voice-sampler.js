/**
 * VoiceSampler v2.0
 * High-quality voice sampler with:
 * - YIN pitch detection (more accurate than autocorrelation)
 * - Crossfade looping (click-free)
 * - Voice pooling with steal modes
 * - Optional normalization
 * - Filter per voice for expressiveness
 * - Event system for UI integration
 */

class VoiceSampler {
  static STEAL_MODES = {
    NONE: 'none',        // Reject new notes when full
    OLDEST: 'oldest',    // Steal oldest voice
    QUIETEST: 'quietest' // Steal quietest voice
  };

  constructor(audioContext, options = {}) {
    this.ac = audioContext;
    this.buffer = null;
    this.crossfadeBuffer = null; // Pre-rendered crossfade loop

    // Configuration with defaults
    this.config = {
      maxPolyphony: options.maxPolyphony ?? 8,
      stealMode: options.stealMode ?? VoiceSampler.STEAL_MODES.OLDEST,
      crossfadeDuration: options.crossfadeDuration ?? 0.015, // 15ms crossfade
      normalize: options.normalize ?? true,
      defaultFilterFreq: options.defaultFilterFreq ?? 8000,
      useFilter: options.useFilter ?? false
    };

    // Sample parameters
    this.rootMidi = 60;
    this.loopStart = 0;
    this.loopEnd = 0;
    this.sampleStart = 0;
    this.sampleEnd = 0;

    // ADSR envelope
    this.env = {
      attack: 0.01,
      decay: 0.08,
      sustain: 0.75,
      release: 0.18
    };

    // Output chain
    this.output = this.ac.createGain();
    this.output.gain.value = 0.9;

    // Voice management
    this.activeVoices = new Map();
    this.voiceCounter = 0;

    // Event callbacks
    this._listeners = new Map();

    // Analysis cache
    this._analysisCache = null;
  }

  // ─────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────

  connect(node) {
    this.output.connect(node);
    return this;
  }

  disconnect() {
    this.output.disconnect();
    return this;
  }

  setEnvelope(env) {
    this.env = { ...this.env, ...env };
    return this;
  }

  setLoopPoints(start, end) {
    if (this.buffer) {
      this.loopStart = Math.max(0, Math.min(start, this.buffer.duration));
      this.loopEnd = Math.max(this.loopStart + 0.01, Math.min(end, this.buffer.duration));
      this._buildCrossfadeBuffer();
    }
    return this;
  }

  setRootNote(midiNote) {
    this.rootMidi = Math.max(0, Math.min(127, Math.round(midiNote)));
    return this;
  }

  async loadFromBlob(blob, options = {}) {
    const startTime = performance.now();
    
    this._emit('loadStart', { blob });

    try {
      const arrayBuffer = await blob.arrayBuffer();
      let audioBuffer = await this.ac.decodeAudioData(arrayBuffer);

      // Optional normalization
      if (this.config.normalize) {
        audioBuffer = this._normalizeBuffer(audioBuffer);
      }

      this.buffer = audioBuffer;

      // Analyze for root pitch and loop points
      const analysis = this._analyzeBuffer(audioBuffer);
      this._analysisCache = analysis;

      this.rootMidi = analysis.rootMidi;
      this.loopStart = analysis.loopStart;
      this.loopEnd = analysis.loopEnd;
      this.sampleStart = analysis.trimStartSec;
      this.sampleEnd = analysis.trimEndSec;

      // Pre-render crossfade buffer for seamless looping
      this._buildCrossfadeBuffer();

      const loadTime = performance.now() - startTime;
      
      this._emit('loadComplete', { 
        analysis, 
        loadTime,
        buffer: audioBuffer 
      });

      return analysis;

    } catch (error) {
      this._emit('loadError', { error });
      throw error;
    }
  }

  noteOn(midiNote, velocity = 1, options = {}) {
    if (!this.buffer) return null;

    // Handle polyphony limit
    if (this.activeVoices.size >= this.config.maxPolyphony) {
      const stolen = this._stealVoice();
      if (!stolen && this.config.stealMode === VoiceSampler.STEAL_MODES.NONE) {
        return null;
      }
    }

    const now = this.ac.currentTime;
    const voiceId = ++this.voiceCounter;
    const v = Math.max(0, Math.min(1, velocity));

    // Create voice nodes
    const src = this.ac.createBufferSource();
    const gain = this.ac.createGain();
    
    // Optional filter for expressiveness
    let filter = null;
    if (this.config.useFilter) {
      filter = this.ac.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = this.config.defaultFilterFreq * v; // Velocity affects brightness
      filter.Q.value = 1;
    }

    // Use crossfade buffer if available, otherwise original
    src.buffer = this.crossfadeBuffer || this.buffer;
    src.loop = true;
    src.loopStart = this.loopStart;
    src.loopEnd = this.loopEnd;

    // Calculate playback rate for pitch
    const rate = Math.pow(2, (midiNote - this.rootMidi) / 12);
    src.playbackRate.setValueAtTime(rate, now);

    // ADSR envelope
    gain.gain.setValueAtTime(0, now);
    const peak = v;
    const { attack, decay, sustain } = this.env;
    
    gain.gain.linearRampToValueAtTime(peak, now + attack);
    gain.gain.linearRampToValueAtTime(peak * sustain, now + attack + decay);

    // Connect chain
    if (filter) {
      src.connect(filter);
      filter.connect(gain);
    } else {
      src.connect(gain);
    }
    gain.connect(this.output);

    // Start playback from sample start (after trim)
    src.start(now, this.sampleStart);

    // Store voice
    const voice = {
      id: voiceId,
      midiNote,
      velocity: v,
      src,
      gain,
      filter,
      startTime: now,
      released: false
    };

    this.activeVoices.set(midiNote, voice);
    this._emit('noteOn', { midiNote, velocity: v, voiceId });

    return voiceId;
  }

  noteOff(midiNote) {
    const voice = this.activeVoices.get(midiNote);
    if (!voice || voice.released) return;

    voice.released = true;
    const now = this.ac.currentTime;
    const { release } = this.env;

    // Smooth release
    voice.gain.gain.cancelScheduledValues(now);
    voice.gain.gain.setValueAtTime(voice.gain.gain.value, now);
    voice.gain.gain.linearRampToValueAtTime(0, now + release);

    // Schedule cleanup
    const stopTime = now + release + 0.05;
    voice.src.stop(stopTime);

    // Remove from active voices after release
    setTimeout(() => {
      if (this.activeVoices.get(midiNote)?.id === voice.id) {
        this.activeVoices.delete(midiNote);
        this._cleanupVoice(voice);
      }
    }, (release + 0.1) * 1000);

    this._emit('noteOff', { midiNote, voiceId: voice.id });
  }

  panic() {
    // Immediately stop all voices
    const now = this.ac.currentTime;
    
    for (const [midiNote, voice] of this.activeVoices) {
      voice.gain.gain.cancelScheduledValues(now);
      voice.gain.gain.setValueAtTime(0, now);
      voice.src.stop(now + 0.01);
      this._cleanupVoice(voice);
    }
    
    this.activeVoices.clear();
    this._emit('panic');
  }

  getAnalysis() {
    return this._analysisCache;
  }

  getWaveformData(numPoints = 200) {
    if (!this.buffer) return null;

    const samples = this.buffer.getChannelData(0);
    const step = Math.floor(samples.length / numPoints);
    const data = new Float32Array(numPoints);

    for (let i = 0; i < numPoints; i++) {
      const start = i * step;
      let max = 0;
      for (let j = 0; j < step && start + j < samples.length; j++) {
        const abs = Math.abs(samples[start + j]);
        if (abs > max) max = abs;
      }
      data[i] = max;
    }

    return data;
  }

  // Event system
  on(event, callback) {
    if (!this._listeners.has(event)) {
      this._listeners.set(event, new Set());
    }
    this._listeners.get(event).add(callback);
    return this;
  }

  off(event, callback) {
    this._listeners.get(event)?.delete(callback);
    return this;
  }

  dispose() {
    this.panic();
    this.disconnect();
    this.buffer = null;
    this.crossfadeBuffer = null;
    this._listeners.clear();
  }

  // ─────────────────────────────────────────────────────────
  // Private Methods
  // ─────────────────────────────────────────────────────────

  _emit(event, data = {}) {
    this._listeners.get(event)?.forEach(cb => {
      try { cb(data); } catch (e) { console.error(e); }
    });
  }

  _stealVoice() {
    if (this.activeVoices.size === 0) return false;

    let victimNote = null;

    if (this.config.stealMode === VoiceSampler.STEAL_MODES.OLDEST) {
      let oldestTime = Infinity;
      for (const [note, voice] of this.activeVoices) {
        if (voice.startTime < oldestTime) {
          oldestTime = voice.startTime;
          victimNote = note;
        }
      }
    } else if (this.config.stealMode === VoiceSampler.STEAL_MODES.QUIETEST) {
      let lowestGain = Infinity;
      for (const [note, voice] of this.activeVoices) {
        const g = voice.gain.gain.value;
        if (g < lowestGain) {
          lowestGain = g;
          victimNote = note;
        }
      }
    }

    if (victimNote !== null) {
      const voice = this.activeVoices.get(victimNote);
      const now = this.ac.currentTime;
      
      // Quick fade out
      voice.gain.gain.cancelScheduledValues(now);
      voice.gain.gain.setValueAtTime(voice.gain.gain.value, now);
      voice.gain.gain.linearRampToValueAtTime(0, now + 0.01);
      voice.src.stop(now + 0.02);
      
      this.activeVoices.delete(victimNote);
      this._cleanupVoice(voice);
      
      return true;
    }

    return false;
  }

  _cleanupVoice(voice) {
    try {
      voice.src.disconnect();
      voice.gain.disconnect();
      voice.filter?.disconnect();
    } catch (e) { /* already disconnected */ }
  }

  _normalizeBuffer(audioBuffer) {
    const numChannels = audioBuffer.numberOfChannels;
    const length = audioBuffer.length;
    const sr = audioBuffer.sampleRate;

    // Find peak
    let peak = 0;
    for (let ch = 0; ch < numChannels; ch++) {
      const data = audioBuffer.getChannelData(ch);
      for (let i = 0; i < length; i++) {
        const abs = Math.abs(data[i]);
        if (abs > peak) peak = abs;
      }
    }

    if (peak < 0.01 || peak > 0.95) {
      // Only normalize if needed
      const targetPeak = 0.9;
      const gain = targetPeak / Math.max(peak, 0.001);

      const newBuffer = this.ac.createBuffer(numChannels, length, sr);
      
      for (let ch = 0; ch < numChannels; ch++) {
        const src = audioBuffer.getChannelData(ch);
        const dst = newBuffer.getChannelData(ch);
        for (let i = 0; i < length; i++) {
          dst[i] = src[i] * gain;
        }
      }
      
      return newBuffer;
    }

    return audioBuffer;
  }

  _buildCrossfadeBuffer() {
    if (!this.buffer) return;

    const sr = this.buffer.sampleRate;
    const numChannels = this.buffer.numberOfChannels;
    const crossfadeSamples = Math.floor(this.config.crossfadeDuration * sr);

    const loopStartSample = Math.floor(this.loopStart * sr);
    const loopEndSample = Math.floor(this.loopEnd * sr);
    const loopLength = loopEndSample - loopStartSample;

    if (loopLength < crossfadeSamples * 2) {
      // Loop too short for crossfade
      this.crossfadeBuffer = null;
      return;
    }

    // Create new buffer with crossfade applied
    const newBuffer = this.ac.createBuffer(
      numChannels,
      this.buffer.length,
      sr
    );

    for (let ch = 0; ch < numChannels; ch++) {
      const src = this.buffer.getChannelData(ch);
      const dst = newBuffer.getChannelData(ch);

      // Copy original data
      dst.set(src);

      // Apply crossfade at loop point
      for (let i = 0; i < crossfadeSamples; i++) {
        const fadeOut = 1 - (i / crossfadeSamples);
        const fadeIn = i / crossfadeSamples;

        // Position in the loop region
        const endPos = loopEndSample - crossfadeSamples + i;
        const startPos = loopStartSample + i;

        if (endPos >= 0 && endPos < dst.length && startPos >= 0 && startPos < src.length) {
          // Crossfade: blend end of loop with beginning
          dst[endPos] = src[endPos] * fadeOut + src[startPos] * fadeIn;
        }
      }
    }

    this.crossfadeBuffer = newBuffer;
  }

  // ─────────────────────────────────────────────────────────
  // Audio Analysis (YIN Pitch Detection)
  // ─────────────────────────────────────────────────────────

  _analyzeBuffer(audioBuffer) {
    const sr = audioBuffer.sampleRate;
    const ch0 = audioBuffer.getChannelData(0);

    // Trim silence
    const trimmed = this._trimSilence(ch0, sr);

    // YIN pitch detection (more accurate than autocorrelation)
    const pitchResult = this._detectPitchYIN(trimmed.samples, sr);
    const rootMidi = pitchResult.midi ?? 60;

    // Find optimal loop region
    const loop = this._findOptimalLoop(trimmed.samples, sr, pitchResult.period);

    return {
      rootHz: pitchResult.hz,
      rootMidi,
      pitchConfidence: pitchResult.confidence,
      loopStart: trimmed.startSec + loop.start / sr,
      loopEnd: trimmed.startSec + loop.end / sr,
      duration: audioBuffer.duration,
      trimStartSec: trimmed.startSec,
      trimEndSec: trimmed.endSec,
      rms: this._calculateRMS(trimmed.samples)
    };
  }

  _trimSilence(samples, sr, thresholdRms = 0.015) {
    const windowSize = Math.floor(sr * 0.01); // 10ms windows
    
    const rmsAt = (start) => {
      let sum = 0;
      const end = Math.min(samples.length, start + windowSize);
      for (let i = start; i < end; i++) {
        sum += samples[i] * samples[i];
      }
      return Math.sqrt(sum / (end - start));
    };

    // Find start
    let start = 0;
    while (start < samples.length - windowSize && rmsAt(start) < thresholdRms) {
      start += windowSize;
    }
    // Back up slightly to catch attack
    start = Math.max(0, start - windowSize);

    // Find end
    let end = samples.length;
    while (end > windowSize && rmsAt(end - windowSize) < thresholdRms) {
      end -= windowSize;
    }
    end = Math.min(samples.length, end + windowSize);

    // Ensure minimum length
    const minSamples = Math.floor(sr * 0.1); // 100ms minimum
    if (end - start < minSamples) {
      start = 0;
      end = samples.length;
    }

    return {
      samples: samples.slice(start, end),
      startSec: start / sr,
      endSec: end / sr
    };
  }

  _detectPitchYIN(samples, sr) {
    const minHz = 70;
    const maxHz = 900;
    const threshold = 0.15; // YIN threshold

    // Use up to 50ms for analysis
    const bufferSize = Math.min(samples.length, Math.floor(sr * 0.05));
    if (bufferSize < 512) {
      return { hz: null, midi: null, confidence: 0, period: null };
    }

    const yinBuffer = new Float32Array(Math.floor(bufferSize / 2));

    // Step 1: Calculate difference function
    for (let tau = 0; tau < yinBuffer.length; tau++) {
      yinBuffer[tau] = 0;
      for (let i = 0; i < yinBuffer.length; i++) {
        const delta = samples[i] - samples[i + tau];
        yinBuffer[tau] += delta * delta;
      }
    }

    // Step 2: Cumulative mean normalized difference
    yinBuffer[0] = 1;
    let runningSum = 0;
    for (let tau = 1; tau < yinBuffer.length; tau++) {
      runningSum += yinBuffer[tau];
      yinBuffer[tau] *= tau / runningSum;
    }

    // Step 3: Find first dip below threshold
    const minPeriod = Math.floor(sr / maxHz);
    const maxPeriod = Math.min(yinBuffer.length - 1, Math.floor(sr / minHz));

    let bestTau = -1;
    let bestValue = 1;

    for (let tau = minPeriod; tau < maxPeriod; tau++) {
      if (yinBuffer[tau] < threshold) {
        // Find local minimum
        while (tau + 1 < maxPeriod && yinBuffer[tau + 1] < yinBuffer[tau]) {
          tau++;
        }
        bestTau = tau;
        bestValue = yinBuffer[tau];
        break;
      }
      
      if (yinBuffer[tau] < bestValue) {
        bestValue = yinBuffer[tau];
        bestTau = tau;
      }
    }

    if (bestTau < 0) {
      return { hz: null, midi: null, confidence: 0, period: null };
    }

    // Step 4: Parabolic interpolation for better precision
    const tau = bestTau;
    let betterTau = tau;
    
    if (tau > 0 && tau < yinBuffer.length - 1) {
      const s0 = yinBuffer[tau - 1];
      const s1 = yinBuffer[tau];
      const s2 = yinBuffer[tau + 1];
      betterTau = tau + (s2 - s0) / (2 * (2 * s1 - s2 - s0));
    }

    const hz = sr / betterTau;
    const confidence = 1 - bestValue;
    const midi = 69 + 12 * Math.log2(hz / 440);

    return {
      hz: Math.round(hz * 10) / 10,
      midi: Math.round(midi),
      confidence: Math.round(confidence * 100) / 100,
      period: betterTau
    };
  }

  _findOptimalLoop(samples, sr, period) {
    const totalSamples = samples.length;
    
    // Target loop length: 3-8 periods, or 200-600ms
    const minLoopSamples = Math.floor(sr * 0.15);
    const maxLoopSamples = Math.floor(sr * 0.6);
    
    let loopLength;
    if (period && period > 0) {
      // Use multiple of detected period for seamless loop
      const periodsToUse = Math.max(3, Math.min(8, Math.floor(maxLoopSamples / period)));
      loopLength = Math.floor(period * periodsToUse);
    } else {
      loopLength = Math.floor((minLoopSamples + maxLoopSamples) / 2);
    }

    loopLength = Math.max(minLoopSamples, Math.min(maxLoopSamples, loopLength));

    // Find steady-state region (after attack, before decay)
    // Typically 30-70% of the sample
    const searchStart = Math.floor(totalSamples * 0.25);
    const searchEnd = Math.floor(totalSamples * 0.75);

    // Find region with most consistent amplitude (RMS)
    let bestStart = searchStart;
    let bestVariance = Infinity;
    const windowSize = Math.floor(sr * 0.02); // 20ms windows

    for (let pos = searchStart; pos < searchEnd - loopLength; pos += windowSize) {
      const regionEnd = pos + loopLength;
      if (regionEnd > totalSamples) break;

      // Calculate RMS variance across the region
      const rmsValues = [];
      for (let w = pos; w < regionEnd - windowSize; w += windowSize) {
        let sum = 0;
        for (let i = w; i < w + windowSize; i++) {
          sum += samples[i] * samples[i];
        }
        rmsValues.push(Math.sqrt(sum / windowSize));
      }

      const mean = rmsValues.reduce((a, b) => a + b, 0) / rmsValues.length;
      const variance = rmsValues.reduce((a, b) => a + (b - mean) ** 2, 0) / rmsValues.length;

      if (variance < bestVariance) {
        bestVariance = variance;
        bestStart = pos;
      }
    }

    // Snap to zero crossings
    const findZeroCrossing = (pos, direction) => {
      const limit = Math.min(2048, Math.floor(sr * 0.02));
      for (let i = 0; i < limit; i++) {
        const idx = pos + i * direction;
        if (idx < 1 || idx >= totalSamples - 1) break;
        
        if (samples[idx - 1] <= 0 && samples[idx] > 0) {
          return idx;
        }
        if (samples[idx - 1] >= 0 && samples[idx] < 0) {
          return idx;
        }
      }
      return pos;
    };

    const start = findZeroCrossing(bestStart, 1);
    const end = findZeroCrossing(start + loopLength, 1);

    return { start, end };
  }

  _calculateRMS(samples) {
    let sum = 0;
    for (let i = 0; i < samples.length; i++) {
      sum += samples[i] * samples[i];
    }
    return Math.sqrt(sum / samples.length);
  }
}


/**
 * Enhanced MicRecorder with level monitoring
 */
class MicRecorder {
  constructor(audioContext) {
    this.ac = audioContext;
    this.stream = null;
    this.recorder = null;
    this.chunks = [];
    this.analyser = null;
    this.isRecording = false;
    
    this._levelCallback = null;
    this._levelRAF = null;
  }

  async start(options = {}) {
    const constraints = {
      audio: {
        echoCancellation: options.echoCancellation ?? false,
        noiseSuppression: options.noiseSuppression ?? false,
        autoGainControl: options.autoGainControl ?? false,
        sampleRate: options.sampleRate
      }
    };

    this.stream = await navigator.mediaDevices.getUserMedia(constraints);
    this.chunks = [];

    // Setup analyser for level metering
    const source = this.ac.createMediaStreamSource(this.stream);
    this.analyser = this.ac.createAnalyser();
    this.analyser.fftSize = 256;
    source.connect(this.analyser);

    // Start level monitoring
    if (this._levelCallback) {
      this._monitorLevel();
    }

    // Prefer higher quality codec if available
    const mimeTypes = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
      'audio/mp4'
    ];

    let mimeType;
    for (const type of mimeTypes) {
      if (MediaRecorder.isTypeSupported(type)) {
        mimeType = type;
        break;
      }
    }

    this.recorder = new MediaRecorder(this.stream, { mimeType });
    
    this.recorder.ondataavailable = (e) => {
      if (e.data?.size > 0) this.chunks.push(e.data);
    };

    this.recorder.start(100); // Collect data every 100ms
    this.isRecording = true;
    
    return { mimeType: this.recorder.mimeType };
  }

  async stop() {
    if (!this.recorder || !this.isRecording) return null;

    this.isRecording = false;
    
    // Stop level monitoring
    if (this._levelRAF) {
      cancelAnimationFrame(this._levelRAF);
      this._levelRAF = null;
    }

    const blob = await new Promise((resolve) => {
      this.recorder.onstop = () => {
        const type = this.recorder.mimeType || 'audio/webm';
        resolve(new Blob(this.chunks, { type }));
      };
      this.recorder.stop();
    });

    // Cleanup
    if (this.stream) {
      this.stream.getTracks().forEach(t => t.stop());
    }

    this.stream = null;
    this.recorder = null;
    this.analyser = null;

    return blob;
  }

  onLevel(callback) {
    this._levelCallback = callback;
    if (this.isRecording && this.analyser) {
      this._monitorLevel();
    }
    return this;
  }

  _monitorLevel() {
    if (!this.analyser || !this.isRecording) return;

    const dataArray = new Uint8Array(this.analyser.frequencyBinCount);

    const check = () => {
      if (!this.isRecording) return;

      this.analyser.getByteFrequencyData(dataArray);
      
      // Calculate RMS level (0-1)
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) {
        const normalized = dataArray[i] / 255;
        sum += normalized * normalized;
      }
      const rms = Math.sqrt(sum / dataArray.length);

      this._levelCallback?.(rms);
      this._levelRAF = requestAnimationFrame(check);
    };

    check();
  }

  getLevel() {
    if (!this.analyser) return 0;

    const dataArray = new Uint8Array(this.analyser.frequencyBinCount);
    this.analyser.getByteFrequencyData(dataArray);

    let sum = 0;
    for (let i = 0; i < dataArray.length; i++) {
      sum += dataArray[i];
    }
    return sum / (dataArray.length * 255);
  }
}


// ─────────────────────────────────────────────────────────
// Usage Example
// ─────────────────────────────────────────────────────────

/*
const ac = new AudioContext();

// Create sampler with options
const sampler = new VoiceSampler(ac, {
  maxPolyphony: 8,
  stealMode: VoiceSampler.STEAL_MODES.OLDEST,
  normalize: true
});

sampler.connect(ac.destination);

// Listen for events
sampler.on('loadComplete', ({ analysis, loadTime }) => {
  console.log(`Loaded in ${loadTime.toFixed(0)}ms`);
  console.log(`Root: ${analysis.rootHz}Hz (MIDI ${analysis.rootMidi})`);
  console.log(`Confidence: ${analysis.pitchConfidence * 100}%`);
  console.log(`Loop: ${analysis.loopStart.toFixed(3)}s - ${analysis.loopEnd.toFixed(3)}s`);
});

sampler.on('noteOn', ({ midiNote, velocity }) => {
  console.log(`Note ON: ${midiNote} @ ${velocity}`);
});

// Create recorder with level monitoring
const recorder = new MicRecorder(ac);

recorder.onLevel(level => {
  // Update UI meter (level is 0-1)
  updateMeter(level);
});

// Record
await recorder.start();
// ... user sings ...
const blob = await recorder.stop();

// Load into sampler
const analysis = await sampler.loadFromBlob(blob);

// Play notes
sampler.noteOn(60, 0.8);  // C4
setTimeout(() => sampler.noteOff(60), 1000);

sampler.noteOn(64, 0.9);  // E4
sampler.noteOn(67, 0.9);  // G4

// Get waveform for visualization
const waveform = sampler.getWaveformData(200);

// Cleanup
sampler.dispose();
*/

export { VoiceSampler, MicRecorder };
