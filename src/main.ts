import './styles.css';
import { LoopEngine } from './audio/engine';
import { CollaborationController } from './collab/controller';
import { generateRoomId, readRoomId } from './collab/room';
import { createDiscView } from './ui/disc';
import { createSessionTab } from './ui/session';
import { createSettingsSheet } from './ui/settings';
import { showInfoModal, showModal } from './ui/modal';

const app = document.getElementById('app');
if (!app) throw new Error('#app is missing from index.html');

const engine = new LoopEngine();

// The collaboration controller is always constructed, but it does nothing on the
// network until a room is joined — solo use is byte-for-byte the old behaviour.
const collab = new CollaborationController();
collab.attachEngine(engine);

let calibrating = false;

const sessionTab = createSessionTab({
  getSnapshot: () => collab.snapshot.get(),
  getIdentity: () => collab.getIdentity(),
  onStart: () => {
    void startSession(generateRoomId());
  },
  onLeave: () => {
    void leaveSession();
  },
  onCopyLink: () => {
    void copyInviteLink();
  },
});

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
  onTestTone: () => {
    void engine.ensureReady().then((problem) => {
      if (problem === null) engine.playTestTone();
      else sheet.setStatus(problem);
    });
  },
  extraTabs: [sessionTab],
});

const disc = createDiscView(app, {
  onTap: () => {
    void engine.tap();
  },
  onUndo: () => {
    void engine.undo();
  },
  onOpenSettings: () => sheet.openTab('audio'),
  onOpenSession: () => sheet.openTab('session'),
});

engine.state.subscribe((snapshot) => disc.setSnapshot(snapshot));
engine.level.subscribe((level) => disc.setLevel(level));
collab.snapshot.subscribe((snapshot) => {
  disc.setSession(snapshot);
  // Keep the sheet's Session tab live while it is open; skip the work when closed.
  if (sheet.isOpen()) sheet.refresh();
});

async function startSession(roomId: string): Promise<void> {
  sheet.setStatus('Starting session…');
  try {
    // Deliberately *not* `engine.ensureReady()`: joining a room must not ask for
    // microphone access. But the context itself is required — without one the pump
    // can only move metadata, so a device that joins and never records would hold
    // the audio and still hear nothing. Starting a session is a gesture (or an
    // invite link), so opening the context here is allowed and never prompts.
    await engine.ensureAudioContext();
    await collab.start(roomId);
    // The context now exists, so this pass also decodes and plays what has arrived.
    await collab.pumpPublic();
    sheet.setStatus(null);
  } catch (error) {
    // A swallowed rejection here is indistinguishable from a dead button.
    sheet.setStatus(error instanceof Error ? error.message : 'Could not start the session');
  }
}

async function leaveSession(): Promise<void> {
  try {
    await collab.stop();
  } catch (error) {
    sheet.setStatus(error instanceof Error ? error.message : 'Could not leave the session');
  }
}

async function copyInviteLink(): Promise<void> {
  const url = collab.shareUrl();
  if (!url) return;
  try {
    await navigator.clipboard.writeText(url);
    sheet.setStatus('Invite link copied');
  } catch {
    // Clipboard can be blocked; showing the link is still useful.
    sheet.setStatus(url);
  }
}

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

// Any pointerdown anywhere resumes a suspended context (iOS suspends on backgrounding),
// and also flushes collaboration work that was waiting for that context.
window.addEventListener(
  'pointerdown',
  () => {
    engine.resumeIfNeeded();
    void collab.pumpPublic();
  },
  { capture: true },
);

// A take cannot survive the app being backgrounded (the context is suspended anyway).
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    void engine.handleBackgrounded();
  } else {
    engine.handleForegrounded();
    // iOS tears down sockets/PeerConnections when backgrounded; re-entering the
    // page is the natural moment to resume fetching.
    void collab.pumpPublic();
  }
});

window.addEventListener('pagehide', () => {
  void engine.handleBackgrounded();
});

// Opening an invite link joins that room immediately. The AudioContext will
// still wait for a gesture, but presence and clip metadata start syncing now.
const initialRoom = readRoomId();
if (initialRoom) void startSession(initialRoom);
