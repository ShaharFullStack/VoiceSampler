/**
 * Voice Sampler App
 * Main application logic connecting UI with audio engine
*/

import { VoiceSampler, MicRecorder } from './voice-sampler.js';

// ─────────────────────────────────────────────────────────
// DOM Elements
// ─────────────────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const elements = {
  // Recording
  recordBtn: $('#recordBtn'),
  levelMeter: $('#levelMeter'),
  levelPeak: $('#levelPeak'),
  recordingTime: $('#recordingTime'),
  recordingStatus: $('#recordingStatus'),
  
  // Waveform
  waveformContainer: $('#waveformContainer'),
  waveformCanvas: $('#waveformCanvas'),
  loopRegion: $('#loopRegion'),
  loopStartHandle: $('#loopStartHandle'),
  loopEndHandle: $('#loopEndHandle'),
  playhead: $('#playhead'),
  
  // Loop Info
  loopStartTime: $('#loopStartTime'),
  loopEndTime: $('#loopEndTime'),
  loopDuration: $('#loopDuration'),
  playSampleBtn: $('#playSampleBtn'),
  
  // Sample Info
  rootNote: $('#rootNote'),
  rootFreq: $('#rootFreq'),
  pitchConfidence: $('#pitchConfidence'),
  duration: $('#duration'),
  
  // Keyboard
  keyboard: $('#keyboard'),
  octaveDown: $('#octaveDown'),
  octaveUp: $('#octaveUp'),
  octaveDisplay: $('#octaveDisplay'),
  
  // Envelope
  attackSlider: $('#attackSlider'),
  decaySlider: $('#decaySlider'),
  sustainSlider: $('#sustainSlider'),
  releaseSlider: $('#releaseSlider'),
  attackValue: $('#attackValue'),
  decayValue: $('#decayValue'),
  sustainValue: $('#sustainValue'),
  releaseValue: $('#releaseValue'),
  envelopeCanvas: $('#envelopeCanvas'),
  
  // Tempo
  tempoSyncToggle: $('#tempoSyncToggle'),
  bpmSlider: $('#bpmSlider'),
  bpmInput: $('#bpmInput'),
  noteDivisionSelect: $('#noteDivisionSelect'),
  tempoDuration: $('#tempoDuration'),

  // Export
  metronomeToggle: $('#metronomeToggle'),
  metronomeVolume: $('#metronomeVolume'),
  metronomeSettings: $('#metronomeSettings'),
  perfRecordBtn: $('#perfRecordBtn'),
  perfRecordTime: $('#perfRecordTime'),
  perfExportRow: $('#perfExportRow'),
  exportPerfWav: $('#exportPerfWav'),
  exportPerfWebm: $('#exportPerfWebm'),
  sampleExportType: $('#sampleExportType'),
  exportSampleWav: $('#exportSampleWav'),
  exportSampleWebm: $('#exportSampleWebm'),

  // Settings
  polyphonySelect: $('#polyphonySelect'),
  normalizeToggle: $('#normalizeToggle'),
  rootNoteSelect: $('#rootNoteSelect'),
  volumeSlider: $('#volumeSlider'),
  
  // Overlays
  loadingOverlay: $('#loadingOverlay'),
  toastContainer: $('#toastContainer')
};

// ─────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────
let audioContext = null;
let sampler = null;
let recorder = null;

let state = {
  isRecording: false,
  hasRecording: false,
  recordStartTime: 0,
  recordingTimerId: null,
  currentOctave: 4,
  peakLevel: 0,
  peakDecay: null,

  // Sample data
  sampleDuration: 0,
  loopStart: 0,
  loopEnd: 0,

  // Dragging
  isDragging: null, // 'start' | 'end' | null

  // Performance recording
  isRecordingPerformance: false,
  perfRecordStartTime: 0,
  perfRecordTimerId: null,
  lastPerformanceBlob: null
};

// Note names for display
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// Keyboard mapping
const KEY_MAP = {
  'a': 0, 'w': 1, 's': 2, 'e': 3, 'd': 4, 'f': 5,
  't': 6, 'g': 7, 'y': 8, 'h': 9, 'u': 10, 'j': 11,
  'k': 12, 'o': 13, 'l': 14
};

// ─────────────────────────────────────────────────────────
// Initialization
// ─────────────────────────────────────────────────────────
function init() {
  buildKeyboard();
  setupEventListeners();
  drawEnvelopeViz();
  updateOctaveDisplay();
  updateTempoDurationDisplay();
}

async function initAudio() {
  if (audioContext) return;

  audioContext = new (window.AudioContext || window.webkitAudioContext)();

  sampler = new VoiceSampler(audioContext, {
    maxPolyphony: parseInt(elements.polyphonySelect.value),
    normalize: elements.normalizeToggle.checked
  });
  sampler.connect(audioContext.destination);

  // Set initial envelope
  updateEnvelope();

  // Set initial volume
  sampler.output.gain.value = elements.volumeSlider.value / 100;

  // Event listeners
  sampler.on('loadComplete', onSampleLoaded);
  sampler.on('loadError', (e) => showToast('Error loading recording', 'error'));

  recorder = new MicRecorder(audioContext);
  recorder.onLevel(updateLevelMeter);
}

// ─────────────────────────────────────────────────────────
// Event Listeners
// ─────────────────────────────────────────────────────────
function setupEventListeners() {
  // Record button
  elements.recordBtn.addEventListener('click', toggleRecording);

  // Octave controls
  elements.octaveDown.addEventListener('click', () => changeOctave(-1));
  elements.octaveUp.addEventListener('click', () => changeOctave(1));

  // Envelope sliders
  elements.attackSlider.addEventListener('input', onEnvelopeChange);
  elements.decaySlider.addEventListener('input', onEnvelopeChange);
  elements.sustainSlider.addEventListener('input', onEnvelopeChange);
  elements.releaseSlider.addEventListener('input', onEnvelopeChange);

  // Tempo controls
  elements.tempoSyncToggle.addEventListener('change', onTempoSyncChange);
  elements.bpmSlider.addEventListener('input', onBpmChange);
  elements.bpmInput.addEventListener('change', onBpmInputChange);
  elements.noteDivisionSelect.addEventListener('change', onNoteDivisionChange);

  // Export controls
  elements.metronomeToggle.addEventListener('change', onMetronomeToggle);
  elements.metronomeVolume.addEventListener('input', onMetronomeVolumeChange);
  elements.perfRecordBtn.addEventListener('click', onPerfRecordToggle);
  elements.exportPerfWav.addEventListener('click', () => exportPerformance('wav'));
  elements.exportPerfWebm.addEventListener('click', () => exportPerformance('webm'));
  elements.exportSampleWav.addEventListener('click', () => exportSample('wav'));
  elements.exportSampleWebm.addEventListener('click', () => exportSample('webm'));

  // Settings
  elements.polyphonySelect.addEventListener('change', onPolyphonyChange);
  elements.normalizeToggle.addEventListener('change', onNormalizeChange);
  elements.volumeSlider.addEventListener('input', onVolumeChange);
  elements.rootNoteSelect.addEventListener('change', onRootNoteChange);

  // Keyboard interaction (mouse/touch)
  elements.keyboard.addEventListener('pointerdown', onKeyDown);
  elements.keyboard.addEventListener('pointerup', onKeyUp);
  elements.keyboard.addEventListener('pointerleave', onKeyUp);

  // Computer keyboard
  document.addEventListener('keydown', onComputerKeyDown);
  document.addEventListener('keyup', onComputerKeyUp);

  // Prevent context menu on long press
  elements.keyboard.addEventListener('contextmenu', e => e.preventDefault());

  // Loop handle dragging
  setupLoopHandleDragging();

  // Play sample button
  elements.playSampleBtn.addEventListener('click', onPlaySampleClick);

  // Canvas resize
  window.addEventListener('resize', resizeCanvases);
  resizeCanvases();
}

// ─────────────────────────────────────────────────────────
// Loop Handle Dragging
// ─────────────────────────────────────────────────────────
function setupLoopHandleDragging() {
  const container = elements.waveformContainer;
  
  // Start drag
  elements.loopStartHandle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    state.isDragging = 'start';
    elements.loopStartHandle.classList.add('dragging');
    elements.loopStartHandle.setPointerCapture(e.pointerId);
  });
  
  elements.loopEndHandle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    state.isDragging = 'end';
    elements.loopEndHandle.classList.add('dragging');
    elements.loopEndHandle.setPointerCapture(e.pointerId);
  });

  // Drag move
  document.addEventListener('pointermove', (e) => {
    if (!state.isDragging || !state.hasRecording) return;
    
    const rect = container.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const pct = Math.max(0, Math.min(1, x / rect.width));
    const time = pct * state.sampleDuration;
    
    const minLoopDuration = 0.05; // 50ms minimum
    
    if (state.isDragging === 'start') {
      // Don't let start go past end - minLoopDuration
      const maxStart = state.loopEnd - minLoopDuration;
      state.loopStart = Math.max(0, Math.min(time, maxStart));
    } else if (state.isDragging === 'end') {
      // Don't let end go before start + minLoopDuration
      const minEnd = state.loopStart + minLoopDuration;
      state.loopEnd = Math.max(minEnd, Math.min(time, state.sampleDuration));
    }
    
    updateLoopUI();
    updateSamplerLoopPoints();
  });

  // End drag
  document.addEventListener('pointerup', (e) => {
    if (state.isDragging) {
      elements.loopStartHandle.classList.remove('dragging');
      elements.loopEndHandle.classList.remove('dragging');
      state.isDragging = null;
    }
  });

  // Keyboard control for handles
  elements.loopStartHandle.addEventListener('keydown', (e) => {
    handleLoopKeyboard(e, 'start');
  });
  
  elements.loopEndHandle.addEventListener('keydown', (e) => {
    handleLoopKeyboard(e, 'end');
  });
}

function handleLoopKeyboard(e, handle) {
  if (!state.hasRecording) return;
  
  const step = e.shiftKey ? 0.1 : 0.01; // Shift for larger steps
  const minLoopDuration = 0.05;
  
  if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
    e.preventDefault();
    if (handle === 'start') {
      state.loopStart = Math.max(0, state.loopStart - step);
    } else {
      state.loopEnd = Math.max(state.loopStart + minLoopDuration, state.loopEnd - step);
    }
  } else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (handle === 'start') {
      state.loopStart = Math.min(state.loopEnd - minLoopDuration, state.loopStart + step);
    } else {
      state.loopEnd = Math.min(state.sampleDuration, state.loopEnd + step);
    }
  }
  
  updateLoopUI();
  updateSamplerLoopPoints();
}

function updateLoopUI() {
  const startPct = (state.loopStart / state.sampleDuration) * 100;
  const endPct = (state.loopEnd / state.sampleDuration) * 100;
  
  // Update region
  elements.loopRegion.style.left = `${startPct}%`;
  elements.loopRegion.style.width = `${endPct - startPct}%`;
  
  // Update handles
  elements.loopStartHandle.style.left = `calc(${startPct}% - 7px)`;
  elements.loopEndHandle.style.left = `calc(${endPct}% - 7px)`;
  
  // Update info text
  elements.loopStartTime.textContent = state.loopStart.toFixed(2);
  elements.loopEndTime.textContent = state.loopEnd.toFixed(2);
  elements.loopDuration.textContent = (state.loopEnd - state.loopStart).toFixed(2);
}

function updateSamplerLoopPoints() {
  if (!sampler) return;
  sampler.setLoopPoints(state.loopStart, state.loopEnd);
}

// ─────────────────────────────────────────────────────────
// Recording
// ─────────────────────────────────────────────────────────
async function toggleRecording() {
  await initAudio();

  if (state.isRecording) {
    await stopRecording();
  } else {
    await startRecording();
  }
}

async function startRecording() {
  try {
    await recorder.start();
    state.isRecording = true;
    state.recordStartTime = Date.now();

    elements.recordBtn.classList.add('recording');
    elements.recordBtn.querySelector('.btn-text').textContent = 'Stop';
    elements.recordBtn.setAttribute('aria-label', 'Stop recording');
    elements.recordingStatus.textContent = 'Recording... sing a steady tone';

    // Start timer
    state.recordingTimerId = setInterval(updateRecordingTime, 100);

    showToast('Recording started', 'success');
  } catch (err) {
    console.error('Recording error:', err);
    showToast('Cannot access microphone', 'error');
  }
}

async function stopRecording() {
  state.isRecording = false;
  clearInterval(state.recordingTimerId);

  elements.recordBtn.classList.remove('recording');
  elements.recordBtn.querySelector('.btn-text').textContent = 'Record';
  elements.recordBtn.setAttribute('aria-label', 'Start recording');

  showLoading(true);
  elements.recordingStatus.textContent = 'Processing...';

  const blob = await recorder.stop();

  if (blob && blob.size > 0) {
    try {
      await sampler.loadFromBlob(blob);
      state.hasRecording = true;
      showToast('Recording loaded successfully!', 'success');
    } catch (err) {
      console.error('Load error:', err);
      showToast('Error processing recording', 'error');
    }
  } else {
    showToast('Recording is empty', 'error');
  }

  showLoading(false);
  resetLevelMeter();
}

function updateRecordingTime() {
  const elapsed = Date.now() - state.recordStartTime;
  const seconds = Math.floor(elapsed / 1000);
  const ms = Math.floor((elapsed % 1000) / 10);
  elements.recordingTime.textContent = 
    `${String(seconds).padStart(2, '0')}:${String(ms).padStart(2, '0')}`;
}

function updateLevelMeter(level) {
  const pct = Math.min(100, level * 150); // Boost for visibility
  elements.levelMeter.style.width = `${pct}%`;

  // Peak hold
  if (pct > state.peakLevel) {
    state.peakLevel = pct;
    elements.levelPeak.style.left = `${pct}%`;
    
    clearTimeout(state.peakDecay);
    state.peakDecay = setTimeout(() => {
      state.peakLevel = 0;
    }, 1500);
  }
}

function resetLevelMeter() {
  elements.levelMeter.style.width = '0%';
  elements.levelPeak.style.left = '0%';
  state.peakLevel = 0;
  elements.recordingTime.textContent = '00:00';
}

// ─────────────────────────────────────────────────────────
// Sample Loaded Handler
// ─────────────────────────────────────────────────────────
function onSampleLoaded({ analysis }) {
  // Store sample data
  state.sampleDuration = analysis.duration;
  state.loopStart = analysis.loopStart;
  state.loopEnd = analysis.loopEnd;
  
  // Update info display
  const noteName = NOTE_NAMES[analysis.rootMidi % 12];
  const octave = Math.floor(analysis.rootMidi / 12) - 1;
  
  elements.rootNote.textContent = `${noteName}${octave}`;
  elements.rootFreq.textContent = analysis.rootHz ? `${analysis.rootHz} Hz` : '—';
  elements.pitchConfidence.textContent = analysis.pitchConfidence 
    ? `${Math.round(analysis.pitchConfidence * 100)}%` 
    : '—';
  elements.duration.textContent = `${analysis.duration.toFixed(2)}s`;

  elements.recordingStatus.textContent = 'Ready to play! Use the keyboard below';

  // Resize canvas and draw waveform (ensures proper dimensions)
  resizeCanvases();

  // Show and position loop region & handles
  elements.loopRegion.classList.add('active');
  elements.loopStartHandle.classList.add('active');
  elements.loopEndHandle.classList.add('active');

  updateLoopUI();

  // Enable export buttons
  enableExportButtons();
}

// ─────────────────────────────────────────────────────────
// Waveform Visualization
// ─────────────────────────────────────────────────────────
function drawWaveform() {
  const canvas = elements.waveformCanvas;
  const ctx = canvas.getContext('2d');
  const { width, height } = canvas;

  // Clear - dark background
  ctx.fillStyle = '#0d0d0d';
  ctx.fillRect(0, 0, width, height);

  // Draw center line
  const centerY = height / 2;
  ctx.strokeStyle = '#333';
  ctx.beginPath();
  ctx.moveTo(0, centerY);
  ctx.lineTo(width, centerY);
  ctx.stroke();

  if (!sampler || !state.hasRecording) return;

  const waveform = sampler.getWaveformData(width);
  if (!waveform) return;

  // Draw waveform - blue like professional samplers
  ctx.fillStyle = '#4a9eff';

  for (let i = 0; i < waveform.length; i++) {
    const amp = waveform[i] * centerY * 0.9;
    ctx.fillRect(i, centerY - amp, 1, amp * 2);
  }
}

function resizeCanvases() {
  // Waveform canvas
  const waveformContainer = elements.waveformCanvas.parentElement;
  elements.waveformCanvas.width = waveformContainer.offsetWidth;
  elements.waveformCanvas.height = waveformContainer.offsetHeight;
  drawWaveform();
  
  // Update loop UI if we have a recording
  if (state.hasRecording) {
    updateLoopUI();
  }

  // Envelope canvas
  const envContainer = elements.envelopeCanvas.parentElement;
  elements.envelopeCanvas.width = envContainer.offsetWidth;
  elements.envelopeCanvas.height = envContainer.offsetHeight;
  drawEnvelopeViz();
}

// ─────────────────────────────────────────────────────────
// Virtual Keyboard
// ─────────────────────────────────────────────────────────
function buildKeyboard() {
  const keyboard = elements.keyboard;
  keyboard.innerHTML = '';

  // Build one octave + 3 more notes (C to E)
  const pattern = [
    { note: 0, black: false },  // C
    { note: 1, black: true },   // C#
    { note: 2, black: false },  // D
    { note: 3, black: true },   // D#
    { note: 4, black: false },  // E
    { note: 5, black: false },  // F
    { note: 6, black: true },   // F#
    { note: 7, black: false },  // G
    { note: 8, black: true },   // G#
    { note: 9, black: false },  // A
    { note: 10, black: true },  // A#
    { note: 11, black: false }, // B
    { note: 12, black: false }, // C (next octave)
  ];

  pattern.forEach(({ note, black }) => {
    const key = document.createElement('div');
    key.className = `key ${black ? 'key-black' : 'key-white'}`;
    key.dataset.note = note;
    
    if (!black) {
      const noteName = NOTE_NAMES[note % 12];
      key.textContent = noteName;
    }

    keyboard.appendChild(key);
  });
}

function getMidiNote(relativeNote) {
  return (state.currentOctave + 1) * 12 + relativeNote;
}

function changeOctave(delta) {
  state.currentOctave = Math.max(1, Math.min(7, state.currentOctave + delta));
  updateOctaveDisplay();
}

function updateOctaveDisplay() {
  elements.octaveDisplay.textContent = `C${state.currentOctave}`;
}

// ─────────────────────────────────────────────────────────
// Keyboard Input Handling
// ─────────────────────────────────────────────────────────
function onKeyDown(e) {
  if (!e.target.classList.contains('key')) return;
  
  initAudio();
  
  const relativeNote = parseInt(e.target.dataset.note);
  const midiNote = getMidiNote(relativeNote);

  playNote(midiNote, e.target);
  e.target.setPointerCapture(e.pointerId);
}

function onKeyUp(e) {
  if (!e.target.classList.contains('key')) return;
  
  const relativeNote = parseInt(e.target.dataset.note);
  const midiNote = getMidiNote(relativeNote);

  stopNote(midiNote, e.target);
}

function onComputerKeyDown(e) {
  if (e.repeat) return;
  if (document.activeElement.tagName === 'INPUT' || 
      document.activeElement.tagName === 'SELECT') return;

  const relativeNote = KEY_MAP[e.key.toLowerCase()];
  if (relativeNote === undefined) return;

  initAudio();
  
  const midiNote = getMidiNote(relativeNote);
  const keyEl = elements.keyboard.querySelector(`[data-note="${relativeNote}"]`);

  playNote(midiNote, keyEl);
}

function onComputerKeyUp(e) {
  const relativeNote = KEY_MAP[e.key.toLowerCase()];
  if (relativeNote === undefined) return;

  const midiNote = getMidiNote(relativeNote);
  const keyEl = elements.keyboard.querySelector(`[data-note="${relativeNote}"]`);

  stopNote(midiNote, keyEl);
}

function playNote(midiNote, keyEl) {
  if (!sampler || !state.hasRecording) return;

  sampler.noteOn(midiNote, 0.9);
  keyEl?.classList.add('active');
}

function stopNote(midiNote, keyEl) {
  if (!sampler) return;

  sampler.noteOff(midiNote);
  keyEl?.classList.remove('active');
}

// ─────────────────────────────────────────────────────────
// Play Sample Preview
// ─────────────────────────────────────────────────────────
let samplePreviewPlaying = false;

function onPlaySampleClick() {
  if (!sampler || !state.hasRecording) return;

  initAudio();

  if (samplePreviewPlaying) {
    // Stop playing - use the root note to stop
    sampler.noteOff(sampler.rootMidi);
    samplePreviewPlaying = false;
    elements.playSampleBtn.classList.remove('playing');
  } else {
    // Play at root pitch (no pitch shift)
    sampler.noteOn(sampler.rootMidi, 0.9);
    samplePreviewPlaying = true;
    elements.playSampleBtn.classList.add('playing');

    // Auto-stop after a reasonable time (loop duration * 3 or 5 seconds max)
    const duration = Math.min((state.loopEnd - state.loopStart) * 3, 5);
    setTimeout(() => {
      if (samplePreviewPlaying) {
        sampler.noteOff(sampler.rootMidi);
        samplePreviewPlaying = false;
        elements.playSampleBtn.classList.remove('playing');
      }
    }, duration * 1000);
  }
}

// ─────────────────────────────────────────────────────────
// Envelope Controls
// ─────────────────────────────────────────────────────────
function onEnvelopeChange() {
  elements.attackValue.textContent = elements.attackSlider.value;
  elements.decayValue.textContent = elements.decaySlider.value;
  elements.sustainValue.textContent = elements.sustainSlider.value;
  elements.releaseValue.textContent = elements.releaseSlider.value;

  updateEnvelope();
  drawEnvelopeViz();
}

function updateEnvelope() {
  if (!sampler) return;

  sampler.setEnvelope({
    attack: parseInt(elements.attackSlider.value) / 1000,
    decay: parseInt(elements.decaySlider.value) / 1000,
    sustain: parseInt(elements.sustainSlider.value) / 100,
    release: parseInt(elements.releaseSlider.value) / 1000
  });
}

function drawEnvelopeViz() {
  const canvas = elements.envelopeCanvas;
  const ctx = canvas.getContext('2d');
  const { width, height } = canvas;

  // Clear - dark background
  ctx.fillStyle = '#0d0d0d';
  ctx.fillRect(0, 0, width, height);

  const attack = parseInt(elements.attackSlider.value);
  const decay = parseInt(elements.decaySlider.value);
  const sustain = parseInt(elements.sustainSlider.value) / 100;
  const release = parseInt(elements.releaseSlider.value);

  const total = attack + decay + 150 + release;
  const padding = 8;
  const drawWidth = width - padding * 2;
  const drawHeight = height - padding * 2;

  const toX = (ms) => padding + (ms / total) * drawWidth;
  const toY = (level) => padding + (1 - level) * drawHeight;

  // Fill area
  ctx.beginPath();
  ctx.moveTo(toX(0), toY(0));
  ctx.lineTo(toX(attack), toY(1));
  ctx.lineTo(toX(attack + decay), toY(sustain));
  ctx.lineTo(toX(attack + decay + 150), toY(sustain));
  ctx.lineTo(toX(total), toY(0));
  ctx.lineTo(toX(total), height);
  ctx.lineTo(toX(0), height);
  ctx.closePath();
  ctx.fillStyle = 'rgba(232, 122, 26, 0.15)';
  ctx.fill();

  // Stroke line
  ctx.beginPath();
  ctx.moveTo(toX(0), toY(0));
  ctx.lineTo(toX(attack), toY(1));
  ctx.lineTo(toX(attack + decay), toY(sustain));
  ctx.lineTo(toX(attack + decay + 150), toY(sustain));
  ctx.lineTo(toX(total), toY(0));
  ctx.strokeStyle = '#e87a1a';
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

// ─────────────────────────────────────────────────────────
// Settings
// ─────────────────────────────────────────────────────────
function onPolyphonyChange() {
  if (!sampler) return;
  sampler.config.maxPolyphony = parseInt(elements.polyphonySelect.value);
}

function onNormalizeChange() {
  if (!sampler) return;
  sampler.config.normalize = elements.normalizeToggle.checked;
}

function onVolumeChange() {
  if (!sampler) return;
  sampler.output.gain.value = elements.volumeSlider.value / 100;
}

function onRootNoteChange() {
  if (!sampler || !state.hasRecording) return;

  const value = elements.rootNoteSelect.value;
  if (value !== 'auto') {
    sampler.setRootNote(parseInt(value));

    // Update display
    const midi = parseInt(value);
    const noteName = NOTE_NAMES[midi % 12];
    const octave = Math.floor(midi / 12) - 1;
    elements.rootNote.textContent = `${noteName}${octave}`;
  }
}

// ─────────────────────────────────────────────────────────
// Tempo Controls
// ─────────────────────────────────────────────────────────
function onTempoSyncChange() {
  if (!sampler) return;

  const enabled = elements.tempoSyncToggle.checked;
  sampler.setTempoSync(enabled);

  // Visual feedback - dim controls when disabled
  const tempoControls = document.querySelector('.tempo-controls');
  if (tempoControls) {
    tempoControls.classList.toggle('disabled', !enabled);
  }

  updateTempoDurationDisplay();
}

function onBpmChange() {
  const bpm = parseInt(elements.bpmSlider.value);
  elements.bpmInput.value = bpm;

  if (sampler) {
    sampler.setTempo(bpm);
  }

  updateTempoDurationDisplay();
}

function onBpmInputChange() {
  let bpm = parseInt(elements.bpmInput.value);
  bpm = Math.max(20, Math.min(300, bpm || 120));

  elements.bpmInput.value = bpm;
  elements.bpmSlider.value = Math.min(200, bpm); // Slider max is 200

  if (sampler) {
    sampler.setTempo(bpm);
  }

  updateTempoDurationDisplay();
}

function onNoteDivisionChange() {
  const division = parseFloat(elements.noteDivisionSelect.value);

  if (sampler) {
    sampler.setNoteDivision(division);
  }

  updateTempoDurationDisplay();
}

function updateTempoDurationDisplay() {
  const bpm = parseInt(elements.bpmInput.value) || 120;
  const division = parseFloat(elements.noteDivisionSelect.value) || 1;

  // Calculate duration: (60 / BPM) * division * 1000 for ms
  const durationMs = Math.round((60 / bpm) * division * 1000);

  // Format: show ms for short durations, seconds for longer
  if (durationMs >= 1000) {
    const durationSec = (durationMs / 1000).toFixed(2);
    elements.tempoDuration.textContent = `${durationSec}s`;
  } else {
    elements.tempoDuration.textContent = `${durationMs}ms`;
  }
}

// ─────────────────────────────────────────────────────────
// Export & Recording Controls
// ─────────────────────────────────────────────────────────
function onMetronomeToggle() {
  if (!sampler) return;

  if (elements.metronomeToggle.checked) {
    const volume = elements.metronomeVolume.value / 100;
    sampler.startMetronome(volume);
    elements.metronomeSettings.classList.add('active');
  } else {
    sampler.stopMetronome();
    elements.metronomeSettings.classList.remove('active');
  }
}

function onMetronomeVolumeChange() {
  if (!sampler) return;
  sampler.setMetronomeVolume(elements.metronomeVolume.value / 100);
}

async function onPerfRecordToggle() {
  await initAudio();

  if (state.isRecordingPerformance) {
    // Stop recording
    state.isRecordingPerformance = false;
    clearInterval(state.perfRecordTimerId);

    const blob = await sampler.stopPerformanceRecording();

    // Stop metronome if it was on
    if (elements.metronomeToggle.checked) {
      sampler.stopMetronome();
    }

    // Update UI
    elements.perfRecordBtn.classList.remove('recording');
    elements.perfRecordBtn.querySelector('.btn-text').textContent = 'Record';

    if (blob && blob.size > 0) {
      state.lastPerformanceBlob = blob;
      elements.perfExportRow.hidden = false;
      elements.exportPerfWav.disabled = false;
      elements.exportPerfWebm.disabled = false;
      showToast('Performance recorded!', 'success');
    }
  } else {
    // Start recording
    if (!state.hasRecording) {
      showToast('Record a sample first', 'error');
      return;
    }

    // Start metronome if enabled
    if (elements.metronomeToggle.checked) {
      const volume = elements.metronomeVolume.value / 100;
      sampler.startMetronome(volume);
    }

    sampler.startPerformanceRecording();
    state.isRecordingPerformance = true;
    state.perfRecordStartTime = Date.now();

    // Update UI
    elements.perfRecordBtn.classList.add('recording');
    elements.perfRecordBtn.querySelector('.btn-text').textContent = 'Stop';
    elements.perfExportRow.hidden = true;

    // Start timer
    state.perfRecordTimerId = setInterval(updatePerfRecordTime, 100);
  }
}

function updatePerfRecordTime() {
  const elapsed = Date.now() - state.perfRecordStartTime;
  const seconds = Math.floor(elapsed / 1000);
  const ms = Math.floor((elapsed % 1000) / 10);
  elements.perfRecordTime.textContent =
    `${String(seconds).padStart(2, '0')}:${String(ms).padStart(2, '0')}`;
}

async function exportPerformance(format) {
  if (!state.lastPerformanceBlob) {
    showToast('No performance recorded', 'error');
    return;
  }

  showLoading(true);

  try {
    let blob = state.lastPerformanceBlob;
    let filename = `performance_${Date.now()}`;

    if (format === 'wav') {
      // Convert to WAV using AudioContext
      const arrayBuffer = await blob.arrayBuffer();
      const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
      blob = sampler._bufferToWav(audioBuffer);
      filename += '.wav';
    } else {
      filename += '.webm';
    }

    downloadBlob(blob, filename);
    showToast(`Exported as ${format.toUpperCase()}`, 'success');
  } catch (err) {
    console.error('Export error:', err);
    showToast('Export failed', 'error');
  }

  showLoading(false);
}

async function exportSample(format) {
  if (!sampler || !state.hasRecording) {
    showToast('No sample loaded', 'error');
    return;
  }

  showLoading(true);

  try {
    const exportType = elements.sampleExportType.value;
    let blob;

    if (exportType === 'loop') {
      blob = await sampler.exportLoopRegion(format);
    } else {
      blob = await sampler.exportOriginalSample(format);
    }

    if (blob) {
      const filename = `sample_${exportType}_${Date.now()}.${format === 'wav' ? 'wav' : 'webm'}`;
      downloadBlob(blob, filename);
      showToast(`Exported as ${format.toUpperCase()}`, 'success');
    }
  } catch (err) {
    console.error('Export error:', err);
    showToast('Export failed', 'error');
  }

  showLoading(false);
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function enableExportButtons() {
  elements.perfRecordBtn.disabled = false;
  elements.exportSampleWav.disabled = false;
  elements.exportSampleWebm.disabled = false;
  elements.playSampleBtn.disabled = false;
}

// ─────────────────────────────────────────────────────────
// UI Helpers
// ─────────────────────────────────────────────────────────
function showLoading(show) {
  elements.loadingOverlay.hidden = !show;
}

function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  
  elements.toastContainer.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(20px)';
    setTimeout(() => toast.remove(), 300);
  }, 3000);

}

// ─────────────────────────────────────────────────────────
// Initialize
// ─────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);
