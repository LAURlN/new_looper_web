import './styles.css';
import { LoopEngine } from './audio/engine';
import { createDiscView } from './ui/disc';
import { createSettingsSheet } from './ui/settings';
import { showInfoModal, showModal } from './ui/modal';

const app = document.getElementById('app');
if (!app) throw new Error('#app is missing from index.html');

const engine = new LoopEngine();
let calibrating = false;

const sheet = createSettingsSheet(document.body, {
  getInfo: () => engine.getAudioInfo(),
  onCalibrate: () => {
    void handleCalibrate();
  },
  onClearCalibration: () => {
    engine.clearCalibration();
    sheet.setStatus('Calibration cleared');
    sheet.refresh();
  },
  onRetryMicrophone: () => {
    void engine.retryMicrophone().then(() => sheet.refresh());
  },
});

const disc = createDiscView(app, {
  onTap: () => {
    void engine.tap();
  },
  onUndo: () => {
    void engine.undo();
  },
  onOpenSettings: () => sheet.open(),
});

engine.state.subscribe((snapshot) => disc.setSnapshot(snapshot));
engine.level.subscribe((level) => disc.setLevel(level));

async function handleCalibrate(): Promise<void> {
  if (calibrating) return;
  const confirmed = await showModal({
    title: 'Loud noise warning',
    body: [
      'Take your headphones OFF and place them against your phone’s microphone.',
      'The app will play 3 short loud sounds to measure round-trip latency.',
      'Do not hold the phone to your ear.',
    ],
    confirmLabel: 'Start calibration',
    cancelLabel: 'Cancel',
    tone: 'warn',
  });
  if (!confirmed) return;

  calibrating = true;
  sheet.setStatus('Calibrating…');
  try {
    const result = await engine.calibrate((status) => sheet.setStatus(status));
    if (result.ok && result.roundTripMs !== undefined) {
      const probes = result.probes
        .map((probe) =>
          probe.lagMs === null
            ? `${probe.kind}: not found`
            : `${probe.kind}: ${Math.round(probe.lagMs)} ms (peak ${probe.peak.toFixed(2)})`,
        )
        .join('\n');
      await showInfoModal('Calibration complete', [
        `Round-trip latency: ${Math.round(result.roundTripMs)} ms`,
        probes,
      ]);
    } else {
      await showInfoModal('Calibration failed', [
        result.message,
        'Your previous calibration (if any) was kept.',
      ]);
    }
  } finally {
    calibrating = false;
    sheet.setStatus(null);
    sheet.refresh();
  }
}

// Any pointerdown anywhere resumes a suspended context (iOS suspends on backgrounding).
window.addEventListener(
  'pointerdown',
  () => {
    engine.resumeIfNeeded();
  },
  { capture: true },
);

// A take cannot survive the app being backgrounded (the context is suspended anyway).
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') void engine.handleBackgrounded();
});

window.addEventListener('pagehide', () => {
  void engine.handleBackgrounded();
});
