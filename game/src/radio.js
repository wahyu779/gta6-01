// radio.js — AZURE BAY car radio (Lane D, Fase 3).
// Three stations, all WebAudio synth — no external audio files, so the game
// stays fully offline. Each station has its own tempo, root and note
// pattern, so switching stations is audible, not just a label change.
//
// Contract (Lane E wires this into main.js):
//   window.Radio = { stations, current(), next(), prev(), ... }
// Station switching is bound to KeyR, but ONLY while the player is in a
// car: on foot KeyR is reload (combat.js / input.js), and stealing it would
// break reloading. In a car the player cannot shoot, so R is free there —
// the GTA-style behaviour. The in-car check reads window.__azure.player
// when present and can be overridden with Radio.setInCarCheck(fn).
//
// Audio starts only after a user gesture (keydown / click): browsers block
// AudioContext before one. If WebAudio is unavailable the station name
// still switches and shows in the HUD — audio degrades, the feature does not.

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
function noteFreq(root, semitones) {
  return root * Math.pow(2, semitones / 12);
}

export function createRadio() {
  let index = 0;
  let audioCtx = null;
  let master = null;
  let noiseBuf = null;
  let schedulerTimer = null;
  let nextNoteTime = 0;
  let step = 0; // 16th-note counter
  let stepsScheduled = 0; // 16th-note steps handed to the graph (debug probe)
  let analyser = null; // tap on master, for the debugAudio() RMS probe
  let muted = false;
  // Lane D (fase4): has a real user gesture happened yet? Creating the
  // AudioContext before one only logs an autoplay warning and sits
  // suspended — startAudio() is a no-op until the first keydown /
  // pointerdown, so staged shots (Radio.next() at load) stay silent
  // in the console and the context is born running, on the gesture.
  let gestureSeen = false;
  function noteGesture() { gestureSeen = true; }
  let inCarCheck = () => {
    const azure = typeof window !== 'undefined' ? window.__azure : null;
    const player = azure && azure.player;
    // No game state visible (e.g. unit context): allow switching.
    if (!player || typeof player.isInCar !== 'boolean') return true;
    return player.isInCar;
  };

  function station() {
    return STATIONS[index];
  }

  function label(st) {
    const s = st || station();
    return s.name + ' ' + s.freq;
  }

  // ---- WebAudio plumbing -------------------------------------------------
  function ensureAudio() {
    if (audioCtx) {
      if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
      return true;
    }
    const AC = typeof window !== 'undefined'
      && (window.AudioContext || window.webkitAudioContext);
    if (!AC) return false; // no WebAudio: names still work, sound degrades
    try {
      audioCtx = new AC();
      master = audioCtx.createGain();
      master.gain.value = muted ? 0 : 0.16;
      master.connect(audioCtx.destination);
      // Debug tap: an AnalyserNode branched off master. It draws no
      // sound itself — it only lets debugAudio() measure the signal
      // actually flowing through the graph (RMS > 0 proves the synth
      // is audible, not just "context running").
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      master.connect(analyser);
      // 0.25 s of white noise, reused for every hi-hat tick.
      noiseBuf = audioCtx.createBuffer(1, audioCtx.sampleRate * 0.25, audioCtx.sampleRate);
      const data = noiseBuf.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    } catch (err) {
      audioCtx = null;
      return false;
    }
    return true;
  }

  function blip(freq, at, dur, type, vol) {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, at);
    gain.gain.setValueAtTime(vol, at);
    gain.gain.exponentialRampToValueAtTime(0.001, at + dur);
    osc.connect(gain);
    gain.connect(master);
    osc.start(at);
    osc.stop(at + dur + 0.02);
  }

  function hat(at) {
    const src = audioCtx.createBufferSource();
    src.buffer = noiseBuf;
    const gain = audioCtx.createGain();
    const filter = audioCtx.createBiquadFilter();
    filter.type = 'highpass';
    filter.frequency.value = 6000;
    gain.gain.setValueAtTime(0.12, at);
    gain.gain.exponentialRampToValueAtTime(0.001, at + 0.04);
    src.connect(filter);
    filter.connect(gain);
    gain.connect(master);
    src.start(at);
    src.stop(at + 0.05);
  }

  // Schedule one 16th-note step for the current station.
  function scheduleStep(stepIndex, at) {
    stepsScheduled += 1;
    const st = station();
    const slot = stepIndex % 8;
    const bassNote = st.bass[slot];
    if (bassNote !== null && bassNote !== undefined) {
      blip(noteFreq(st.root, bassNote), at, 0.22, st.bassWave, 0.5);
    }
    const leadNote = st.lead[slot];
    if (leadNote !== null && leadNote !== undefined) {
      blip(noteFreq(st.root, leadNote), at, 0.16, st.wave, 0.16);
    }
    if (stepIndex % st.hatEvery === 0) hat(at);
  }

  function startScheduler() {
    if (schedulerTimer !== null || !audioCtx) return;
    step = 0;
    nextNoteTime = audioCtx.currentTime + 0.05;
    schedulerTimer = setInterval(() => {
      const st = station();
      const stepDur = 60 / st.bpm / 4; // one 16th note
      while (nextNoteTime < audioCtx.currentTime + 0.12) {
        scheduleStep(step, nextNoteTime);
        nextNoteTime += stepDur;
        step += 1;
      }
    }, 40);
  }

  function stopScheduler() {
    if (schedulerTimer !== null) {
      clearInterval(schedulerTimer);
      schedulerTimer = null;
    }
  }

  // Start (or resume) audio. Safe to call on every user gesture; the
  // AudioContext is created once, on the first gesture that reaches us.
  // Before any gesture (e.g. Radio.next() at load in a staged shot)
  // this is a no-op: the station still switches and the HUD still
  // updates, but no suspended context is created and no autoplay
  // warning is logged.
  function startAudio() {
    if (!gestureSeen) return false;
    if (!ensureAudio()) return false;
    startScheduler();
    return true;
  }

  function setMuted(value) {
    muted = Boolean(value);
    if (master) master.gain.value = muted ? 0 : 0.16;
    return muted;
  }

  // ---- station switching ---------------------------------------------------
  function setIndex(next) {
    index = ((next % STATIONS.length) + STATIONS.length) % STATIONS.length;
    // A station change restarts the pattern from step 0 so the new
    // station's groove starts cleanly instead of mid-bar.
    step = 0;
    if (audioCtx) nextNoteTime = audioCtx.currentTime + 0.05;
    return station();
  }

  function next() {
    const st = setIndex(index + 1);
    startAudio();
    notify(st);
    return st;
  }

  function prev() {
    const st = setIndex(index - 1);
    startAudio();
    notify(st);
    return st;
  }

  // Tell the HUD (and anyone else listening) that the station changed.
  // HudFase3 listens for this; Lane E may listen too.
  function notify(st) {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent('azure-radio', {
      detail: { id: st.id, name: st.name, freq: st.freq, label: label(st) },
    }));
  }

  // R cycles the station while in a car (see header: on foot R is reload).
  // Any keydown / pointerdown is also a user gesture, so it (re)starts the
  // audio context — the first R press in a car both starts the music and
  // switches the station.
  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    window.addEventListener('keydown', (event) => {
      noteGesture();
      if (event.code !== 'KeyR' || event.repeat) return;
      if (!inCarCheck()) return; // on foot: leave R to combat reload
      next();
    });
    document.addEventListener('pointerdown', () => { noteGesture(); startAudio(); }, { once: true });
  }

  const api = {
    stations: STATIONS,
    current() { return station(); },
    label() { return label(); },
    next,
    prev,
    startAudio,
    stop() { stopScheduler(); },
    setMuted,
    get muted() { return muted; },
    // Debug probe (Lane D, Fase 4): proves the synth really sounds in
    // a real browser — state + master gain + scheduler + steps handed
    // to the graph + RMS of the signal on master. RMS > 0 means
    // oscillators are actually flowing to the destination, not just
    // "context exists". Read-only: it changes no audio state.
    debugAudio() {
      const AC = typeof window !== 'undefined'
        && (window.AudioContext || window.webkitAudioContext);
      if (!AC) return { supported: false, state: 'unavailable' };
      if (!audioCtx) {
        return {
          supported: true, state: 'not-created', currentTime: 0,
          masterGain: 0, schedulerRunning: false, stepsScheduled: 0, rms: null,
        };
      }
      let rms = null;
      if (analyser) {
        const buf = new Uint8Array(analyser.fftSize);
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) {
          const v = (buf[i] - 128) / 128;
          sum += v * v;
        }
        rms = Math.sqrt(sum / buf.length);
      }
      return {
        supported: true,
        state: audioCtx.state,
        currentTime: audioCtx.currentTime,
        masterGain: master ? master.gain.value : 0,
        schedulerRunning: schedulerTimer !== null,
        stepsScheduled,
        rms,
      };
    },
    /** Override the in-car gate (Lane E can pass its own predicate). */
    setInCarCheck(fn) {
      if (typeof fn === 'function') inCarCheck = fn;
    },
  };
  return api;
}

export const Radio = createRadio();
if (typeof window !== 'undefined') window.Radio = Radio;
