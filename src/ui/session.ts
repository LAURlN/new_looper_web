/**
 * The "Session" tab: start/leave a live room, share the invite link, and see
 * who else is here.
 *
 * It is intentionally explicit that this mode is **live-only** — there is no
 * server holding the project, so the promise is "everyone here shares the same
 * loop right now", not "saved to the cloud". Saying that plainly is better than
 * letting someone lose a take they assumed was safe.
 */
import type { PeerIdentity } from '../collab/identity';
import type { CollabSnapshot } from '../collab/types';
import type { SheetTab } from './settings';

export interface SessionTabOptions {
  getSnapshot(): CollabSnapshot;
  getIdentity(): PeerIdentity;
  onStart(): void;
  onLeave(): void;
  onCopyLink(): void;
  /** Copies a paste-ready report of the document and wire state (see `diagnosticsReport()`). */
  onCopyDiagnostics(): void;
}

const CONNECTION_LABEL: Record<CollabSnapshot['connection'], string> = {
  idle: 'Not in a session',
  searching: 'Looking for peers…',
  live: 'Connected',
  error: 'Connection problem',
};

function peerDot(color: string): HTMLSpanElement {
  const dot = document.createElement('span');
  dot.className = 'peer-dot';
  dot.style.background = color;
  return dot;
}

/** Whole seconds since a claim was made or refreshed; never negative, even with clock skew. */
function secondsSince(at: number): number {
  return Math.max(0, Math.round((Date.now() - at) / 1000));
}

export function createSessionTab(options: SessionTabOptions): SheetTab {
  return {
    id: 'session',
    label: 'Session',
    render(panel) {
      const snapshot = options.getSnapshot();
      const identity = options.getIdentity();

      const statusField = document.createElement('div');
      statusField.className = 'field';
      const statusLabel = document.createElement('span');
      statusLabel.className = 'field-label';
      statusLabel.textContent = 'Status';
      const statusValue = document.createElement('span');
      statusValue.className = 'field-value';
      statusValue.textContent = snapshot.active
        ? `${CONNECTION_LABEL[snapshot.connection]} · ${snapshot.peers.length + 1} in session`
        : CONNECTION_LABEL[snapshot.connection];
      statusField.append(statusLabel, statusValue);
      panel.append(statusField);

      // "Someone else is recording" is information, not a lock: a take here is always
      // allowed, so this is an ordinary field and never a warning.
      const remote = snapshot.remoteRecording;
      if (remote) {
        const recordingField = document.createElement('div');
        recordingField.className = 'field';
        const recordingLabel = document.createElement('span');
        recordingLabel.className = 'field-label';
        recordingLabel.textContent = 'Recording now';
        const recordingValue = document.createElement('span');
        recordingValue.className = 'field-value';
        const recordingName = document.createElement('span');
        recordingName.textContent = remote.name;
        recordingName.style.color = remote.color;
        const recordingAge = document.createElement('span');
        recordingAge.style.color = 'var(--muted)';
        recordingAge.style.marginLeft = '6px';
        // The claim is refreshed while their take runs, so this is "since they last said so".
        recordingAge.textContent = `${secondsSince(remote.since)} s ago`;
        recordingValue.append(peerDot(remote.color), recordingName, recordingAge);
        recordingField.append(recordingLabel, recordingValue);
        panel.append(recordingField);
      }

      if (snapshot.active) {
        const roomField = document.createElement('div');
        roomField.className = 'field';
        const roomLabel = document.createElement('span');
        roomLabel.className = 'field-label';
        roomLabel.textContent = 'Room code';
        const roomValue = document.createElement('span');
        roomValue.className = 'field-value is-code';
        roomValue.textContent = snapshot.roomId ?? '—';
        roomField.append(roomLabel, roomValue);
        panel.append(roomField);

        if (snapshot.peers.length > 0) {
          const peersField = document.createElement('div');
          peersField.className = 'field';
          const peersLabel = document.createElement('span');
          peersLabel.className = 'field-label';
          peersLabel.textContent = 'Also in this session';
          const list = document.createElement('ul');
          list.className = 'peers';
          for (const peer of snapshot.peers) {
            const item = document.createElement('li');
            item.className = 'peer';
            const name = document.createElement('span');
            name.textContent = peer.name;
            item.append(peerDot(peer.color), name);
            list.append(item);
          }
          peersField.append(peersLabel, list);
          panel.append(peersField);
        }

        const copy = document.createElement('button');
        copy.type = 'button';
        copy.className = 'btn btn-primary btn-block';
        copy.textContent = 'Copy invite link';
        copy.addEventListener('click', () => options.onCopyLink());
        panel.append(copy);

        const leave = document.createElement('button');
        leave.type = 'button';
        leave.className = 'btn btn-block';
        leave.style.marginTop = '10px';
        leave.textContent = 'Leave session';
        leave.addEventListener('click', () => options.onLeave());
        panel.append(leave);

        const note = document.createElement('p');
        note.className = 'diagnostic';
        note.style.marginTop = '14px';
        note.textContent =
          'Live-only: this project is shared directly between the people here, not stored on a server. It disappears when everyone leaves, so keep a device in the session to hold it. Everyone plays on their own clock — the loop is replicated, not the timing.';
        panel.append(note);
      } else {
        const start = document.createElement('button');
        start.type = 'button';
        start.className = 'btn btn-primary btn-block';
        start.textContent = 'Start a session';
        start.addEventListener('click', () => options.onStart());
        panel.append(start);

        const note = document.createElement('p');
        note.className = 'diagnostic';
        note.style.marginTop = '14px';
        note.textContent =
          'Creates a room and puts its code in the URL. Share that link (or the code) and anyone who opens it joins the same loop. No account and no server: audio moves phone-to-phone over WebRTC.';
        panel.append(note);
      }

      const identityField = document.createElement('div');
      identityField.className = 'field';
      identityField.style.marginTop = '18px';
      const identityLabel = document.createElement('span');
      identityLabel.className = 'field-label';
      identityLabel.textContent = 'You appear as';
      const identityRow = document.createElement('span');
      identityRow.className = 'field-value';
      const name = document.createElement('span');
      name.textContent = identity.name;
      identityRow.append(peerDot(identity.color), name);
      identityField.append(identityLabel, identityRow);
      panel.append(identityField);

      // Not decoration: every wire path swallows its own errors, so this report is the only
      // way to tell from a phone whether a take actually reached the shared document.
      const diagnostics = document.createElement('button');
      diagnostics.type = 'button';
      diagnostics.className = 'btn btn-block';
      diagnostics.style.marginTop = '12px';
      diagnostics.textContent = 'Copy diagnostics';
      diagnostics.addEventListener('click', () => options.onCopyDiagnostics());
      panel.append(diagnostics);

      if (snapshot.status) {
        const message = document.createElement('p');
        message.className = `diagnostic${snapshot.connection === 'error' ? ' diagnostic-error' : ''}`;
        message.style.marginTop = '12px';
        message.textContent = snapshot.status;
        panel.append(message);
      }

      if (snapshot.pendingClips > 0) {
        const pending = document.createElement('p');
        pending.className = 'diagnostic';
        pending.style.marginTop = '8px';
        pending.textContent = `Fetching ${snapshot.pendingClips} clip${
          snapshot.pendingClips === 1 ? '' : 's'
        } from peers…`;
        panel.append(pending);
      }
    },
  };
}
