// radio.js — AZURE BAY car radio (rewrite round 2).
// Three stations, all WebAudio synth — no external audio files, so the
// game stays fully offline. Each station has its own tempo, root and note
// pattern, so switching stations is audible, not just a label change.
//
// Contract (main.js wires this in):
//   window.Radio = { stations, current(), next(), prev(), ... }
// Station switching is bound to KeyR, but ONLY while the player is in a
// car: on foot KeyR is reload (combat / input), and stealing it would
// break reloading. In a car the player cannot shoot, so R is free there —
// the GTA-style behaviour. The in-car check reads window.__azure.player
// when present and can be overridden with Radio.setInCarCheck(fn).
//
// Audio starts only after a user gesture (keydown / click): browsers block
// AudioContext before one. If WebAudio is unavailable the station name
// still switches and shows in the HUD — audio degrades, the feature does not.
//
// Round-2 fix — no leaked audio graph: the old version created one
// AudioContext and never closed it, and its keydown / pointerdown
// listeners could never be removed. This version keeps every listener in
// a named function, exposes stop() (halt the scheduler) and dispose()
// (halt + close the context + detach the listeners), and station changes
// reset the pattern clock so the new groove starts cleanly instead of
// mid-bar. A disposed radio can be started again — startAudio() rebuilds
// the graph from scratch.

export const STATIONS = [
  {
    id: 'naranja',
    name: 'RADIO NARANJA',
    freq: '99.1 FM',
    bpm: 112,
    root: 110.0, // A2
    wave: 'sawtooth',
    bassWave: 'triangle',
    // Minor-key driving loop: bass roots + a sparse lead arpeggio.
    bass: [0, 0, 7, 0, 3, 0, 5, 7],
    lead: [12, 15, 19, 15, 12, 10, 7, 10],
    hatEvery: 2, // hat on every 2nd 16th
  },
  {
    id: 'azure',
    name: 'AZURE FM',
    freq: '104.7 FM',
    bpm: 92,
    root: 130.81, // C3
    wave: 'sine',
    bassWave: 'sine',
    // Slow sunset chords: long bass notes, high soft lead.
    bass: [0, null, 0, null, 5, null, 3, null],
    lead: [24, null, 19, null, 24, null, 22, null],
    hatEvery: 4,
  },
  {
    id: 'baybeats',
    name: 'BAY BEATS',
    freq: '88.3 FM',
    bpm: 128,
    root: 98.0, // G2
    wave: 'square',
    bassWave: 'sawtooth',
    // Fast four-on-the-floor energy: busy bass, punchy lead.
    bass: [0, 0, 12, 0, 0, 10, 0, 7],
    lead: [12, 12, 15, 19, 15, 12, 10, 12],
    hatEvery: 1, // hat on every 16th
  },
];

// Semitone offset -> frequency, equal temperament from the station root.
function freqFromRoot(root, semitones) {
  return root * Math.pow(2, semitones / 12);
}

export function createRadio() {
  let stationIdx = 0;
  let ctx = null;          // AudioContext, created once per gesture
  let bus = null;          // master gain -> destination
  let hissBuf = null;      // 0.25 s of white noise, reused for hi-hats
  let tickTimer = null;    // lookahead scheduler interval
  let nextStepAt = 0;      // audio-clock time of the next 16th note
  let patternStep = 0;     // 16th-note counter
  let scheduledSteps = 0;  // 16th-note steps handed to the graph (debug probe)
  let meter = null;        // analyser tap on the bus, for the debugAudio() RMS probe
  let isMuted = false;
  let sawGesture = false;
  let disposed = false;
  let carCheck = () => {
    const azure = typeof window !== 'undefined' ? window.__azure : null;
    const player = azure && azure.player;
    // No game state visible (e.g. unit context): allow switching.
    if (!player || typeof player.isInCar !== 'boolean') return true;
    return player.isInCar;
  };

  function currentStation() {
    return STATIONS[stationIdx];
  }

  function stationLabel(st) {
    const s = st || currentStation();
    return s.name + ' ' + s.freq;
  }

  // ---- WebAudio plumbing -------------------------------------------------
  function buildGraph() {
    if (ctx) {
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      return true;
    }
    const AC = typeof window !== 'undefined'
      && (window.AudioContext || window.webkitAudioContext);
    if (!AC) return false; // no WebAudio: names still work, sound degrades
    try {
      ctx = new AC();
      bus = ctx.createGain();
      bus.gain.value = isMuted ? 0 : 0.16;
      bus.connect(ctx.destination);
      // Debug tap: an AnalyserNode branched off the bus. It draws no
      // sound itself — it only lets debugAudio() measure the signal
      // actually flowing through the graph (RMS > 0 proves the synth
      // is audible, not just "context running").
      meter = ctx.createAnalyser();
      meter.fftSize = 512;
      bus.connect(meter);
      // 0.25 s of white noise, reused for every hi-hat tick.
      hissBuf = ctx.createBuffer(1, ctx.sampleRate * 0.25, ctx.sampleRate);
      const samples = hissBuf.getChannelData(0);
      for (let i = 0; i < samples.length; i++) samples[i] = Math.random() * 2 - 1;
    } catch (err) {
      ctx = null;
      return false;
    }
    return true;
  }

  function playTone(freq, at, dur, type, vol) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, at);
    gain.gain.setValueAtTime(vol, at);
    gain.gain.exponentialRampToValueAtTime(0.001, at + dur);
    osc.connect(gain);
    gain.connect(bus);
    osc.start(at);
    osc.stop(at + dur + 0.02);
  }

  function playHat(at) {
    const src = ctx.createBufferSource();
    src.buffer = hissBuf;
    const gain = ctx.createGain();
    const filter = ctx.createBiquadFilter();
    filter.type = 'highpass';
    filter.frequency.value = 6000;
    gain.gain.setValueAtTime(0.12, at);
    gain.gain.exponentialRampToValueAtTime(0.001, at + 0.04);
    src.connect(filter);
    filter.connect(gain);
    gain.connect(bus);
    src.start(at);
    src.stop(at + 0.05);
  }

  // Schedule one 16th-note step for the current station.
  function scheduleStep(stepIdx, at) {
    scheduledSteps += 1;
    const st = currentStation();
    const slot = stepIdx % 8;
    const bassNote = st.bass[slot];
    if (bassNote !== null && bassNote !== undefined) {
      playTone(freqFromRoot(st.root, bassNote), at, 0.22, st.bassWave, 0.5);
    }
    const leadNote = st.lead[slot];
    if (leadNote !== null && leadNote !== undefined) {
      playTone(freqFromRoot(st.root, leadNote), at, 0.16, st.wave, 0.16);
    }
    if (stepIdx % st.hatEvery === 0) playHat(at);
  }

  function startScheduler() {
    if (tickTimer !== null || !ctx) return;
    patternStep = 0;
    nextStepAt = ctx.currentTime + 0.05;
    tickTimer = setInterval(() => {
      const st = currentStation();
      const stepDur = 60 / st.bpm / 4; // one 16th note
      while (nextStepAt < ctx.currentTime + 0.12) {
        scheduleStep(patternStep, nextStepAt);
        nextStepAt += stepDur;
        patternStep += 1;
      }
    }, 40);
  }

  function haltScheduler() {
    if (tickTimer !== null) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
  }

  // Start (or resume) audio. Safe to call on every user gesture; the
  // AudioContext is created once, on the first gesture that reaches us.
  // Before any gesture (e.g. Radio.next() at load in a staged shot)
  // this is a no-op: the station still switches and the HUD still
  // updates, but no suspended context is created and no autoplay
  // warning is logged.
  function startAudio() {
    if (disposed) {
      // Reborn after dispose(): re-attach the listeners dispose() took
      // down, then build a fresh graph on this gesture.
      disposed = false;
      if (typeof window !== 'undefined' && typeof document !== 'undefined') {
        window.addEventListener('keydown', onKeyDown);
        document.addEventListener('pointerdown', onFirstPointer, { once: true });
      }
    }
    if (!sawGesture) return false;
    if (!buildGraph()) return false;
    startScheduler();
    return true;
  }

  function setMuted(value) {
    isMuted = Boolean(value);
    if (bus) bus.gain.value = isMuted ? 0 : 0.16;
    return isMuted;
  }

  // ---- station switching ---------------------------------------------------
  function jumpTo(nextIdx) {
    stationIdx = ((nextIdx % STATIONS.length) + STATIONS.length) % STATIONS.length;
    // A station change restarts the pattern from step 0 so the new
    // station's groove starts cleanly instead of mid-bar.
    patternStep = 0;
    if (ctx) nextStepAt = ctx.currentTime + 0.05;
    return currentStation();
  }

  function next() {
    const st = jumpTo(stationIdx + 1);
    startAudio();
    announce(st);
    return st;
  }

  function prev() {
    const st = jumpTo(stationIdx - 1);
    startAudio();
    announce(st);
    return st;
  }

  // Tell the HUD (and anyone else listening) that the station changed.
  // HudFase3 listens for this; main.js may listen too.
  function announce(st) {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent('azure-radio', {
      detail: { id: st.id, name: st.name, freq: st.freq, label: stationLabel(st) },
    }));
  }

  // ---- lifecycle: stop / dispose -------------------------------------------
  // stop(): silence the music but keep the graph (cheap to resume).
  function stop() {
    haltScheduler();
  }

  // dispose(): halt the scheduler, close the AudioContext so the browser
  // releases the audio device, and detach the global listeners. A
  // disposed radio is silent and leak-free; startAudio() after dispose
  // rebuilds the graph on the next gesture.
  function dispose() {
    haltScheduler();
    if (ctx) {
      const closing = ctx.close ? ctx.close() : null;
      if (closing && typeof closing.catch === 'function') closing.catch(() => {});
      ctx = null;
      bus = null;
      meter = null;
      hissBuf = null;
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onFirstPointer);
    }
    disposed = true;
  }

  // R cycles the station while in a car (see header: on foot R is reload).
  // Any keydown / pointerdown is also a user gesture, so it (re)starts the
  // audio context — the first R press in a car both starts the music and
  // switches the station.
  function onKeyDown(event) {
    sawGesture = true;
    if (event.code !== 'KeyR' || event.repeat) return;
    if (!carCheck()) return; // on foot: leave R to combat reload
    next();
  }

  function onFirstPointer() {
    sawGesture = true;
    startAudio();
  }

  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    window.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onFirstPointer, { once: true });
  }

  const api = {
    stations: STATIONS,
    current() { return currentStation(); },
    label() { return stationLabel(); },
    next,
    prev,
    startAudio,
    stop,
    dispose,
    setMuted,
    get muted() { return isMuted; },
    // Debug probe: proves the synth really sounds in a real browser —
    // state + master gain + scheduler + steps handed to the graph + RMS
    // of the signal on the bus. RMS > 0 means oscillators are actually
    // flowing to the destination, not just "context exists". Read-only:
    // it changes no audio state.
    debugAudio() {
      const AC = typeof window !== 'undefined'
        && (window.AudioContext || window.webkitAudioContext);
      if (!AC) return { supported: false, state: 'unavailable' };
      if (!ctx) {
        return {
          supported: true, state: 'not-created', currentTime: 0,
          masterGain: 0, schedulerRunning: false, stepsScheduled: 0, rms: null,
        };
      }
      let rms = null;
      if (meter) {
        const buf = new Uint8Array(meter.fftSize);
        meter.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) {
          const v = (buf[i] - 128) / 128;
          sum += v * v;
        }
        rms = Math.sqrt(sum / buf.length);
      }
      return {
        supported: true,
        state: ctx.state,
        currentTime: ctx.currentTime,
        masterGain: bus ? bus.gain.value : 0,
        schedulerRunning: tickTimer !== null,
        stepsScheduled: scheduledSteps,
        rms,
      };
    },
    /** Override the in-car gate (main.js can pass its own predicate). */
    setInCarCheck(fn) {
      if (typeof fn === 'function') carCheck = fn;
    },
  };
  return api;
}

export const Radio = createRadio();
if (typeof window !== 'undefined') window.Radio = Radio;
