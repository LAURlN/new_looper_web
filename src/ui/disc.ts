import type { EngineSnapshot } from '../audio/engine';
import type { CollabSnapshot } from '../collab/types';

export interface DiscHandlers {
  onTap(): void;
  onUndo(): void;
  onOpenSettings(): void;
  onOpenSession(): void;
}

export interface DiscView {
  setSnapshot(snapshot: EngineSnapshot): void;
  setLevel(level: number): void;
  setSession(snapshot: CollabSnapshot): void;
}

const GEAR_ICON = `
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2"
       stroke-dasharray="3.1 2.7" stroke-linecap="round" aria-hidden="true">
    <circle cx="12" cy="12" r="7.6" />
  </svg>
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"
       style="position:absolute">
    <circle cx="12" cy="12" r="3.1" />
  </svg>`;

function loopText(snapshot: EngineSnapshot): string {
  return snapshot.loopSeconds === null ? 'no loop yet' : `${snapshot.loopSeconds.toFixed(1)} s loop`;
}

function labelFor(snapshot: EngineSnapshot): { label: string; sub: string; cls: string } {
  const { state, layerCount, overdubIndex, maxLayers } = snapshot;
  const layers = `${layerCount} layer${layerCount === 1 ? '' : 's'}`;
  switch (state) {
    case 'RECORDING':
      return { label: 'Recording… tap to stop', sub: 'this take becomes the loop', cls: 'is-recording' };
    case 'OVERDUBBING':
      return {
        label: `Overdub ${overdubIndex}/4… tap to stop`,
        sub: `${layers} playing with you`,
        cls: 'is-overdubbing',
      };
    case 'FULL':
      return {
        label: `${maxLayers - 1}/4 overdubs — undo to continue`,
        sub: `looping ${layers} · ${loopText(snapshot)}`,
        cls: 'is-full',
      };
    case 'IDLE':
    default:
      if (layerCount === 0) {
        return { label: 'Tap to record', sub: 'the first take becomes the loop', cls: 'is-idle' };
      }
      return {
        label: 'Looping — tap to overdub',
        sub: `${layers} · ${loopText(snapshot)} · overdub ${layerCount}/4`,
        cls: 'is-idle',
      };
  }
}

export function createDiscView(root: HTMLElement, handlers: DiscHandlers): DiscView {
  const topbar = document.createElement('header');
  topbar.className = 'topbar';

  const title = document.createElement('h1');
  title.className = 'topbar-title';
  title.textContent = 'Loop Recorder';

  const gear = document.createElement('button');
  gear.type = 'button';
  gear.className = 'gear';
  gear.setAttribute('aria-label', 'Audio settings');
  gear.innerHTML = GEAR_ICON;
  gear.addEventListener('click', () => handlers.onOpenSettings());

  // Presence pill: hidden until a session is joined, then shows who is here.
  const sessionPill = document.createElement('button');
  sessionPill.type = 'button';
  sessionPill.className = 'pill';
  sessionPill.hidden = true;
  sessionPill.addEventListener('click', () => handlers.onOpenSession());

  topbar.append(title, sessionPill, gear);

  const banner = document.createElement('div');
  banner.className = 'banner';
  banner.hidden = true;

  const stage = document.createElement('main');
  stage.className = 'stage';

  const counter = document.createElement('div');
  counter.className = 'counter';
  counter.textContent = '0 / 5';

  const disc = document.createElement('button');
  disc.type = 'button';
  disc.className = 'disc is-idle';
  // pointerdown (not click) so a take starts the moment the finger lands.
  disc.addEventListener('pointerdown', () => handlers.onTap());
  disc.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      handlers.onTap();
    }
  });

  const discLabel = document.createElement('span');
  discLabel.className = 'disc-label';
  const discSub = document.createElement('span');
  discSub.className = 'disc-sub';
  disc.append(discLabel, discSub);

  const hint = document.createElement('div');
  hint.className = 'hint';

  stage.append(counter, disc, hint);

  const controls = document.createElement('div');
  controls.className = 'controls';
  const undo = document.createElement('button');
  undo.type = 'button';
  undo.className = 'btn';
  undo.textContent = 'Undo';
  undo.disabled = true;
  undo.addEventListener('click', () => handlers.onUndo());
  controls.append(undo);

  root.append(topbar, banner, stage, controls);

  return {
    setSnapshot(snapshot) {
      const { label, sub, cls } = labelFor(snapshot);
      discLabel.textContent = label;
      discSub.textContent = sub;
      disc.className = `disc ${cls}`;
      counter.textContent = `${snapshot.layerCount} / ${snapshot.maxLayers}`;
      undo.disabled = !snapshot.canUndo;

      const micBlocked =
        snapshot.micState === 'denied' ||
        snapshot.micState === 'unsupported' ||
        snapshot.micState === 'unavailable' ||
        snapshot.micState === 'error';
      disc.disabled = micBlocked;

      const needsResume = snapshot.contextState === 'suspended';
      if (needsResume) {
        banner.hidden = false;
        banner.className = 'banner is-warn';
        banner.textContent = 'Audio paused — tap the disc to resume';
      } else if (snapshot.message) {
        banner.hidden = false;
        banner.className = `banner${micBlocked ? ' is-error' : ''}`;
        banner.textContent = snapshot.message;
      } else {
        banner.hidden = true;
        banner.textContent = '';
      }

      if (!snapshot.calibrated && snapshot.layerCount > 0) {
        hint.textContent = 'Uncalibrated — overdubs may drift. Run Audio Setup › Calibrate.';
        hint.className = 'hint is-warn';
      } else if (snapshot.calibrated && snapshot.layerCount > 0 && snapshot.state === 'IDLE') {
        hint.textContent = `Calibrated to ${Math.round(snapshot.calibratedMs ?? 0)} ms round trip`;
        hint.className = 'hint';
      } else {
        hint.textContent = '';
        hint.className = 'hint';
      }
    },
    setLevel(level) {
      disc.style.setProperty('--level', level.toFixed(3));
    },
    setSession(snapshot) {
      if (!snapshot.active) {
        sessionPill.hidden = true;
        sessionPill.classList.remove('is-recording');
        sessionPill.title = '';
        return;
      }
      const total = snapshot.peers.length + 1;
      sessionPill.hidden = false;
      // The pill stays the session's own indicator: someone else recording adds a class (and
      // therefore a dot) and a line to the title, but never replaces what the pill shows.
      sessionPill.textContent = snapshot.connection === 'live' ? `\u25cf ${total}` : '\u25cc';
      sessionPill.classList.toggle('is-live', snapshot.connection === 'live');
      const remoteRecording = snapshot.remoteRecording;
      sessionPill.classList.toggle('is-recording', remoteRecording !== null);
      const parts: string[] = [
        total === 1 ? 'Live session — waiting for others' : `${total} in this session`,
      ];
      if (remoteRecording) parts.push(`${remoteRecording.name} is recording now`);
      if (snapshot.pendingClips > 0) parts.push(`fetching ${snapshot.pendingClips} clip(s)`);
      if (snapshot.status) parts.push(snapshot.status);
      sessionPill.title = parts.join(' · ');
    },
  };
}
