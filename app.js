(function () {
  // ---- Config state ----
  const cfg = { work: 30, rest: 30, rounds: 10, prep: 5 };
  const steps = { work: 5, rest: 5, rounds: 1, prep: 5 };
  const bounds = {
    work:   { min: 5,  max: 900 },
    rest:   { min: 0,  max: 600 },
    rounds: { min: 1,  max: 99  },
    prep:   { min: 0,  max: 30  }
  };

  const fmtField = (k, v) => k === 'rounds' ? String(v) : v + ' с';
  const els = {
    work: document.getElementById('v-work'),
    rest: document.getElementById('v-rest'),
    rounds: document.getElementById('v-rounds'),
    prep: document.getElementById('v-prep'),
  };
  const summaryEl = document.getElementById('summary');

  function mmss(s) {
    const m = Math.floor(s / 60), sec = s % 60;
    return m + ':' + String(sec).padStart(2, '0');
  }
  function totalSeconds() {
    return cfg.prep + cfg.rounds * cfg.work + Math.max(0, cfg.rounds - 1) * cfg.rest;
  }
  function renderSetup() {
    for (const k in els) els[k].textContent = fmtField(k, cfg[k]);
    summaryEl.innerHTML =
      'Общая длительность <b>' + mmss(totalSeconds()) + '</b>. ' +
      cfg.rounds + ' × (' + cfg.work + ' с работа + ' + cfg.rest + ' с отдых).';
  }

  document.querySelectorAll('.stepper button').forEach(btn => {
    btn.addEventListener('click', () => {
      const k = btn.dataset.key, act = btn.dataset.act;
      const d = (act === 'inc' ? 1 : -1) * steps[k];
      cfg[k] = Math.min(bounds[k].max, Math.max(bounds[k].min, cfg[k] + d));
      renderSetup();
    });
  });

  // ---- Presets ----
  document.querySelectorAll('.presets button').forEach(btn => {
    btn.addEventListener('click', () => {
      const [w, r, n, p] = btn.dataset.p.split(',').map(Number);
      cfg.work = w; cfg.rest = r; cfg.rounds = n; cfg.prep = p;
      renderSetup();
    });
  });

  renderSetup();

  // ---- Sound (WebAudio beeps) ----
  let audioCtx = null;
  function ensureAudio() {
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) audioCtx = new AC();
    }
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
  }
  function beep(freq, dur, when, vol) {
    if (!audioCtx) return;
    const t = audioCtx.currentTime + (when || 0);
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'square';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(vol || 0.3, t + 0.01);
    gain.gain.setValueAtTime(vol || 0.3, t + dur - 0.02);
    gain.gain.linearRampToValueAtTime(0, t + dur);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }
  const tick   = () => beep(660, 0.09, 0, 0.22);   // countdown 3-2-1
  const goWork = () => { beep(880, 0.14, 0, 0.35); beep(1180, 0.18, 0.13, 0.35); };
  const goRest = () => beep(440, 0.22, 0, 0.32);
  const finish = () => { beep(880,0.15,0,0.35); beep(1100,0.15,0.16,0.35); beep(1320,0.32,0.32,0.35); };

  // ---- Runtime ----
  const body = document.body;
  const clockEl = document.getElementById('clock');
  const phaseNameEl = document.getElementById('phaseName');
  const roundLabel = document.getElementById('roundLabel');
  const totalLeftEl = document.getElementById('totalLeft');
  const trackEl = document.getElementById('track');
  const pauseBtn = document.getElementById('pauseBtn');

  let seq = [];
  let starts = [];   // offset from run start, seconds, per step
  let totalDur = 0;
  let idx = 0;
  let remain = 0;
  let totalRemain = 0;
  let running = false;
  let paused = false;
  let rafTimer = null;
  let startAt = 0;   // epoch ms of run start; shifted forward on resume
  let pausedAt = 0;
  let lastWholeSecond = -1;

  // Time comes from the wall clock, not accumulated frame deltas: rAF is
  // throttled in background tabs and stops entirely on a locked screen.
  const elapsed = () => (Date.now() - startAt) / 1000;

  function buildSequence() {
    seq = [];
    if (cfg.prep > 0) seq.push({ type: 'ready', dur: cfg.prep, round: 0 });
    for (let r = 1; r <= cfg.rounds; r++) {
      seq.push({ type: 'work', dur: cfg.work, round: r });
      if (r < cfg.rounds && cfg.rest > 0) seq.push({ type: 'rest', dur: cfg.rest, round: r });
    }
    starts = [];
    totalDur = 0;
    for (const step of seq) { starts.push(totalDur); totalDur += step.dur; }
  }
  function buildTrack() {
    trackEl.innerHTML = '';
    for (let r = 1; r <= cfg.rounds; r++) {
      const d = document.createElement('div');
      d.className = 'dot';
      d.dataset.round = r;
      trackEl.appendChild(d);
    }
  }
  function updateTrack(currentRound, phase) {
    trackEl.querySelectorAll('.dot').forEach(d => {
      const r = +d.dataset.round;
      d.classList.toggle('done', r < currentRound || (r === currentRound && phase === 'rest'));
      d.classList.toggle('current', r === currentRound && phase === 'work');
    });
  }

  const PHASE_LABEL = { ready: 'Готовься', work: 'Работа', rest: 'Отдых', done: 'Готово!' };

  function setPhaseClass(type) {
    body.classList.remove('phase-work','phase-rest','phase-ready','phase-done');
    body.classList.add('phase-' + type);
  }

  function enterStep(i) {
    idx = i;
    const step = seq[i];
    setPhaseClass(step.type);
    phaseNameEl.textContent = PHASE_LABEL[step.type];
    remain = step.dur;
    if (step.type === 'work') {
      roundLabel.textContent = 'Раунд ' + step.round + ' / ' + cfg.rounds;
      goWork();
    } else if (step.type === 'rest') {
      roundLabel.textContent = 'Отдых после ' + step.round;
      goRest();
    } else {
      roundLabel.textContent = 'Раунд 1 / ' + cfg.rounds;
    }
    updateTrack(step.round || 1, step.type);
    renderClock();
  }

  function renderClock() {
    clockEl.textContent = mmss(Math.ceil(remain));
    totalLeftEl.textContent = 'Осталось ' + mmss(Math.ceil(totalRemain));
  }

  function finishAll() {
    running = false;
    cancelAnimationFrame(rafTimer);
    setPhaseClass('done');
    phaseNameEl.textContent = PHASE_LABEL.done;
    clockEl.textContent = '✓';
    roundLabel.textContent = cfg.rounds + ' раундов';
    totalLeftEl.textContent = 'Тренировка завершена';
    trackEl.querySelectorAll('.dot').forEach(d => d.classList.add('done'));
    pauseBtn.querySelector('span').textContent = 'Заново';
    finish();
    if (navigator.vibrate) navigator.vibrate([120,80,120,80,220]);
    releaseWake();
  }

  function loop() {
    if (!running || paused) return;
    const e = elapsed();

    if (e >= totalDur) { finishAll(); return; }

    // Skip straight to the step we belong in — after a long background gap
    // that may be several steps ahead, and only its cue should sound.
    let i = idx;
    while (i + 1 < seq.length && e >= starts[i + 1]) i++;
    if (i !== idx) { enterStep(i); lastWholeSecond = -1; }

    remain = starts[idx] + seq[idx].dur - e;
    totalRemain = totalDur - e;

    const whole = Math.ceil(remain);
    if (whole !== lastWholeSecond) {
      lastWholeSecond = whole;
      if (whole <= 3 && whole >= 1) tick();
    }
    renderClock();

    rafTimer = requestAnimationFrame(loop);
  }

  function startRun() {
    ensureAudio();
    buildSequence();
    buildTrack();
    totalRemain = totalDur;
    running = true;
    paused = false;
    startAt = Date.now();
    lastWholeSecond = -1;
    body.classList.add('running');
    pauseBtn.querySelector('span').textContent = 'Пауза';
    enterStep(0);
    requestWake();
    rafTimer = requestAnimationFrame(loop);
  }

  function togglePause() {
    if (!running) {          // finished -> back to setup
      body.classList.remove('running');
      return;
    }
    paused = !paused;
    pauseBtn.querySelector('span').textContent = paused ? 'Дальше' : 'Пауза';
    if (!paused) {
      startAt += Date.now() - pausedAt;   // pushing the origin forward hides the pause
      rafTimer = requestAnimationFrame(loop);
    } else {
      pausedAt = Date.now();
      cancelAnimationFrame(rafTimer);
    }
  }

  function stopRun() {
    running = false; paused = false;
    cancelAnimationFrame(rafTimer);
    body.classList.remove('running','phase-work','phase-rest','phase-ready','phase-done');
    releaseWake();
  }

  document.getElementById('startBtn').addEventListener('click', startRun);
  pauseBtn.addEventListener('click', togglePause);
  document.getElementById('stopBtn').addEventListener('click', stopRun);

  // ---- Wake lock (keep screen on) ----
  let wakeLock = null;
  async function requestWake() {
    try {
      if (navigator.wakeLock) wakeLock = await navigator.wakeLock.request('screen');
    } catch (e) {}
  }
  function releaseWake() {
    if (wakeLock) { wakeLock.release().catch(()=>{}); wakeLock = null; }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && running && !paused) requestWake();
  });

  // keyboard: space = pause
  document.addEventListener('keydown', e => {
    if (e.code === 'Space' && body.classList.contains('running')) {
      e.preventDefault(); togglePause();
    }
  });

  // ---- Service worker (offline) ----
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    });
  }
})();
