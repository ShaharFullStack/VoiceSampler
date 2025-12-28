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

    // BPM / Tempo sync configuration
    // Note divisions define how many beats the loop represents
    this.tempo = {
      bpm: options.bpm ?? 120,
      enabled: options.tempoSync ?? false,
      // Note division: how many beats the loop should last
      // 0.5 = 8th note (half a beat), 1 = quarter note (1 beat),
      // 2 = half note, 4 = whole note, etc.
      noteDivision: options.noteDivision ?? 1
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

    // Metronome
    this.metronome = {
      enabled: false,
      gain: null,
      intervalId: null,
      nextTickTime: 0,
      ticksPerBeat: 1,
      volume: 0.5
    };

    // Performance recording
    this.recorder = {
      isRecording: false,
      mediaRecorder: null,
      destination: null,
      chunks: [],
      startTime: 0
    };
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

  setTempo(bpm, noteDivision = null) {
    this.tempo.bpm = Math.max(20, Math.min(300, bpm));
    if (noteDivision !== null) {
      this.tempo.noteDivision = noteDivision;
    }
    this._emit('tempoChange', {
      bpm: this.tempo.bpm,
      noteDivision: this.tempo.noteDivision,
      loopDuration: this.getTempoLoopDuration()
    });
    return this;
  }

  setTempoSync(enabled) {
    this.tempo.enabled = enabled;
    this._emit('tempoSyncChange', { enabled });
    return this;
  }

  setNoteDivision(division) {
    this.tempo.noteDivision = division;
    this._emit('tempoChange', {
      bpm: this.tempo.bpm,
      noteDivision: this.tempo.noteDivision,
      loopDuration: this.getTempoLoopDuration()
    });
    return this;
  }

  // Calculate loop duration in seconds based on BPM and note division
  getTempoLoopDuration() {
    // Seconds per beat = 60 / BPM
    // Loop duration = seconds per beat * note division
    const secondsPerBeat = 60 / this.tempo.bpm;
    return secondsPerBeat * this.tempo.noteDivision;
  }

  // Get info about current tempo settings
  getTempoInfo() {
    const loopDuration = this.getTempoLoopDuration();
    return {
      bpm: this.tempo.bpm,
      noteDivision: this.tempo.noteDivision,
      enabled: this.tempo.enabled,
      loopDurationMs: Math.round(loopDuration * 1000),
      loopDurationSec: loopDuration
    };
  }

  // ─────────────────────────────────────────────────────────
  // Metronome
  // ─────────────────────────────────────────────────────────

  startMetronome(volume = 0.5) {
    if (this.metronome.enabled) return;

    this.metronome.enabled = true;
    this.metronome.volume = volume;

    // Create metronome gain node (separate from main output, not recorded)
    this.metronome.gain = this.ac.createGain();
    this.metronome.gain.gain.value = volume;
    this.metronome.gain.connect(this.ac.destination); // Direct to speakers, bypasses recorder

    // Schedule first tick
    this.metronome.nextTickTime = this.ac.currentTime + 0.1;
    this._scheduleMetronomeTicks();

    this._emit('metronomeStart', { bpm: this.tempo.bpm });
  }

  stopMetronome() {
    if (!this.metronome.enabled) return;

    this.metronome.enabled = false;

    if (this.metronome.intervalId) {
      clearInterval(this.metronome.intervalId);
      this.metronome.intervalId = null;
    }

    if (this.metronome.gain) {
      this.metronome.gain.disconnect();
      this.metronome.gain = null;
    }

    this._emit('metronomeStop');
  }

  setMetronomeVolume(volume) {
    this.metronome.volume = Math.max(0, Math.min(1, volume));
    if (this.metronome.gain) {
      this.metronome.gain.gain.value = this.metronome.volume;
    }
  }

  _scheduleMetronomeTicks() {
    const scheduleAhead = 0.1; // Schedule 100ms ahead
    const secondsPerBeat = 60 / this.tempo.bpm;

    const scheduler = () => {
      if (!this.metronome.enabled) return;

      while (this.metronome.nextTickTime < this.ac.currentTime + scheduleAhead) {
        this._playMetronomeTick(this.metronome.nextTickTime);
        this.metronome.nextTickTime += secondsPerBeat;
      }
    };

    // Run scheduler every 25ms
    this.metronome.intervalId = setInterval(scheduler, 25);
    scheduler(); // Run immediately
  }

  _playMetronomeTick(time) {
    if (!this.metronome.gain) return;

    // Create a short click sound
    const osc = this.ac.createOscillator();
    const clickGain = this.ac.createGain();

    osc.frequency.value = 1000; // 1kHz click
    osc.type = 'sine';

    clickGain.gain.setValueAtTime(0.5, time);
    clickGain.gain.exponentialRampToValueAtTime(0.001, time + 0.03);

    osc.connect(clickGain);
    clickGain.connect(this.metronome.gain);

    osc.start(time);
    osc.stop(time + 0.03);

    this._emit('metronomeTick', { time });
  }

  // ─────────────────────────────────────────────────────────
  // Performance Recording
  // ─────────────────────────────────────────────────────────

  startPerformanceRecording() {
    if (this.recorder.isRecording) return false;

    // Create a separate destination for recording (excludes metronome)
    this.recorder.destination = this.ac.createMediaStreamDestination();

    // Connect sampler output to recorder destination
    this.output.connect(this.recorder.destination);

    // Setup MediaRecorder
    this.recorder.chunks = [];

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

    this.recorder.mediaRecorder = new MediaRecorder(
      this.recorder.destination.stream,
      { mimeType }
    );

    this.recorder.mediaRecorder.ondataavailable = (e) => {
      if (e.data?.size > 0) {
        this.recorder.chunks.push(e.data);
      }
    };

    this.recorder.mediaRecorder.start(100);
    this.recorder.isRecording = true;
    this.recorder.startTime = Date.now();

    this._emit('recordingStart', { time: this.recorder.startTime });

    return true;
  }

  async stopPerformanceRecording() {
    if (!this.recorder.isRecording) return null;

    this.recorder.isRecording = false;

    const blob = await new Promise((resolve) => {
      this.recorder.mediaRecorder.onstop = () => {
        const type = this.recorder.mediaRecorder.mimeType || 'audio/webm';
        resolve(new Blob(this.recorder.chunks, { type }));
      };
      this.recorder.mediaRecorder.stop();
    });

    // Disconnect recorder destination
    this.output.disconnect(this.recorder.destination);
    this.recorder.destination = null;
    this.recorder.mediaRecorder = null;

    const duration = Date.now() - this.recorder.startTime;
    this._emit('recordingStop', { duration, blob });

    return blob;
  }

  isRecordingPerformance() {
    return this.recorder.isRecording;
  }

  // ─────────────────────────────────────────────────────────
  // Export Functions
  // ─────────────────────────────────────────────────────────

  // Export the original loaded sample
  async exportOriginalSample(format = 'wav') {
    if (!this.buffer) return null;

    if (format === 'wav') {
      return this._bufferToWav(this.buffer);
    } else {
      // For other formats, encode via MediaRecorder
      return this._encodeBuffer(this.buffer, format);
    }
  }

  // Export just the loop region
  async exportLoopRegion(format = 'wav') {
    if (!this.buffer) return null;

    const sr = this.buffer.sampleRate;
    const startSample = Math.floor(this.loopStart * sr);
    const endSample = Math.floor(this.loopEnd * sr);
    const length = endSample - startSample;

    const loopBuffer = this.ac.createBuffer(
      this.buffer.numberOfChannels,
      length,
      sr
    );

    for (let ch = 0; ch < this.buffer.numberOfChannels; ch++) {
      const src = this.buffer.getChannelData(ch);
      const dst = loopBuffer.getChannelData(ch);
      for (let i = 0; i < length; i++) {
        dst[i] = src[startSample + i];
      }
    }

    if (format === 'wav') {
      return this._bufferToWav(loopBuffer);
    } else {
      return this._encodeBuffer(loopBuffer, format);
    }
  }

  // Convert AudioBuffer to WAV blob
  _bufferToWav(audioBuffer) {
    const numChannels = audioBuffer.numberOfChannels;
    const sampleRate = audioBuffer.sampleRate;
    const format = 1; // PCM
    const bitDepth = 16;

    const bytesPerSample = bitDepth / 8;
    const blockAlign = numChannels * bytesPerSample;

    const samples = audioBuffer.length;
    const dataSize = samples * blockAlign;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);

    // WAV header
    const writeString = (offset, string) => {
      for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i));
      }
    };

    writeString(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true); // fmt chunk size
    view.setUint16(20, format, true);
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitDepth, true);
    writeString(36, 'data');
    view.setUint32(40, dataSize, true);

    // Interleave channels and write samples
    const channels = [];
    for (let ch = 0; ch < numChannels; ch++) {
      channels.push(audioBuffer.getChannelData(ch));
    }

    let offset = 44;
    for (let i = 0; i < samples; i++) {
      for (let ch = 0; ch < numChannels; ch++) {
        const sample = Math.max(-1, Math.min(1, channels[ch][i]));
        const intSample = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
        view.setInt16(offset, intSample, true);
        offset += 2;
      }
    }

    return new Blob([buffer], { type: 'audio/wav' });
  }

  // Encode buffer using MediaRecorder for WebM/compressed formats
  async _encodeBuffer(audioBuffer, format = 'webm') {
    return new Promise((resolve, reject) => {
      // Create a temporary audio context for playback
      const tempCtx = new (window.AudioContext || window.webkitAudioContext)();

      const source = tempCtx.createBufferSource();
      source.buffer = audioBuffer;

      // Create destination for recording
      const dest = tempCtx.createMediaStreamDestination();
      source.connect(dest);

      // Also connect to a silent gain so we don't hear it
      const silentGain = tempCtx.createGain();
      silentGain.gain.value = 0;
      source.connect(silentGain);
      silentGain.connect(tempCtx.destination);

      const mimeType = format === 'mp3' ? 'audio/webm;codecs=opus' : `audio/${format}`;
      const chunks = [];

      let recorderMimeType = 'audio/webm';
      if (MediaRecorder.isTypeSupported(mimeType)) {
        recorderMimeType = mimeType;
      } else if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) {
        recorderMimeType = 'audio/webm;codecs=opus';
      }

      const recorder = new MediaRecorder(dest.stream, { mimeType: recorderMimeType });

      recorder.ondataavailable = (e) => {
        if (e.data?.size > 0) chunks.push(e.data);
      };

      recorder.onstop = () => {
        tempCtx.close();
        resolve(new Blob(chunks, { type: recorder.mimeType }));
      };

      recorder.onerror = (e) => {
        tempCtx.close();
        reject(e);
      };

      // Start recording and playback
      recorder.start();
      source.start();

      // Stop after the buffer duration plus a small buffer
      const duration = audioBuffer.duration * 1000 + 100;
      setTimeout(() => {
        if (recorder.state === 'recording') {
          recorder.stop();
        }
      }, duration);
    });
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

    // Calculate the base playback rate for pitch shifting
    const pitchRate = Math.pow(2, (midiNote - this.rootMidi) / 12);

    // The original loop region duration (in seconds)
    const originalLoopDuration = this.loopEnd - this.loopStart;

    let finalRate;
    if (this.tempo.enabled) {
      // Tempo sync mode: stretch/shrink the sample to fit the BPM-based duration
      // Target duration is determined by BPM and note division
      const targetDuration = this.getTempoLoopDuration();

      // Calculate tempo stretch rate: how much to speed up/slow down to fit target
      // If original is 1s and target is 0.5s, we need to play at 2x speed
      // If original is 0.5s and target is 1s, we need to play at 0.5x speed
      const tempoStretchRate = originalLoopDuration / targetDuration;

      // Combine pitch shift and tempo stretch
      // The final rate applies both transformations
      finalRate = pitchRate * tempoStretchRate;

      // Use the original loop points - the rate change handles the timing
      src.loopStart = this.loopStart;
      src.loopEnd = this.loopEnd;
    } else {
      // Normal mode (tempo sync disabled): just pitch shift
      // But still ensure all notes loop at the same wall-clock time
      finalRate = pitchRate;

      // Adjust loop end to maintain consistent perceived loop duration
      // across different pitches
      const adjustedLoopDuration = originalLoopDuration * pitchRate;
      const adjustedLoopEnd = this.loopStart + adjustedLoopDuration;
      const maxLoopEnd = (this.crossfadeBuffer || this.buffer).duration;

      src.loopStart = this.loopStart;
      src.loopEnd = Math.min(adjustedLoopEnd, maxLoopEnd);
    }

    src.playbackRate.setValueAtTime(finalRate, now);

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
