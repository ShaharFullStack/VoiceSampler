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
  isDragging: null // 'start' | 'end' | null
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

  // Draw waveform
  drawWaveform();

  // Show and position loop region & handles
  elements.loopRegion.classList.add('active');
  elements.loopStartHandle.classList.add('active');
  elements.loopEndHandle.classList.add('active');
  
  updateLoopUI();
}

// ─────────────────────────────────────────────────────────
// Waveform Visualization
// ─────────────────────────────────────────────────────────
function drawWaveform() {
  const canvas = elements.waveformCanvas;
  const ctx = canvas.getContext('2d');
  const { width, height } = canvas;

  // Clear
  ctx.fillStyle = '#252542';
  ctx.fillRect(0, 0, width, height);

  if (!sampler || !state.hasRecording) return;

  const waveform = sampler.getWaveformData(width);
  if (!waveform) return;

  // Draw waveform
  const gradient = ctx.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, '#6366f1');
  gradient.addColorStop(0.5, '#818cf8');
  gradient.addColorStop(1, '#6366f1');

  ctx.fillStyle = gradient;

  const centerY = height / 2;

  for (let i = 0; i < waveform.length; i++) {
    const amp = waveform[i] * centerY * 0.9;
    ctx.fillRect(i, centerY - amp, 1, amp * 2);
  }

  // Draw center line
  ctx.strokeStyle = 'rgba(255,255,255,0.1)';
  ctx.beginPath();
  ctx.moveTo(0, centerY);
  ctx.lineTo(width, centerY);
  ctx.stroke();
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
// Envelope Controls
// ─────────────────────────────────────────────────────────
function onEnvelopeChange() {
  elements.attackValue.textContent = `${elements.attackSlider.value}ms`;
  elements.decayValue.textContent = `${elements.decaySlider.value}ms`;
  elements.sustainValue.textContent = `${elements.sustainSlider.value}%`;
  elements.releaseValue.textContent = `${elements.releaseSlider.value}ms`;

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

  // Clear
  ctx.fillStyle = '#252542';
  ctx.fillRect(0, 0, width, height);

  const attack = parseInt(elements.attackSlider.value);
  const decay = parseInt(elements.decaySlider.value);
  const sustain = parseInt(elements.sustainSlider.value) / 100;
  const release = parseInt(elements.releaseSlider.value);

  const total = attack + decay + 200 + release; // 200ms sustain hold
  const padding = 20;
  const drawWidth = width - padding * 2;
  const drawHeight = height - padding * 2;

  const toX = (ms) => padding + (ms / total) * drawWidth;
  const toY = (level) => padding + (1 - level) * drawHeight;

  // Draw envelope shape
  ctx.beginPath();
  ctx.moveTo(toX(0), toY(0));
  ctx.lineTo(toX(attack), toY(1)); // Attack
  ctx.lineTo(toX(attack + decay), toY(sustain)); // Decay
  ctx.lineTo(toX(attack + decay + 200), toY(sustain)); // Sustain
  ctx.lineTo(toX(total), toY(0)); // Release

  // Fill
  const gradient = ctx.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, 'rgba(99, 102, 241, 0.3)');
  gradient.addColorStop(1, 'rgba(99, 102, 241, 0.05)');
  ctx.fillStyle = gradient;
  ctx.lineTo(toX(total), toY(0));
  ctx.lineTo(toX(0), toY(0));
  ctx.fill();

  // Stroke
  ctx.beginPath();
  ctx.moveTo(toX(0), toY(0));
  ctx.lineTo(toX(attack), toY(1));
  ctx.lineTo(toX(attack + decay), toY(sustain));
  ctx.lineTo(toX(attack + decay + 200), toY(sustain));
  ctx.lineTo(toX(total), toY(0));
  ctx.strokeStyle = '#6366f1';
  ctx.lineWidth = 2;
  ctx.stroke();

  // Draw points
  const points = [
    { x: toX(0), y: toY(0), label: 'A' },
    { x: toX(attack), y: toY(1), label: 'D' },
    { x: toX(attack + decay), y: toY(sustain), label: 'S' },
    { x: toX(attack + decay + 200), y: toY(sustain), label: 'R' }
  ];

  ctx.fillStyle = '#818cf8';
  points.forEach(({ x, y }) => {
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fill();
  });

  // Labels
  ctx.fillStyle = '#94a3b8';
  ctx.font = '11px Inter, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('A', toX(attack / 2), height - 5);
  ctx.fillText('D', toX(attack + decay / 2), height - 5);
  ctx.fillText('S', toX(attack + decay + 100), height - 5);
  ctx.fillText('R', toX(attack + decay + 200 + release / 2), height - 5);
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
