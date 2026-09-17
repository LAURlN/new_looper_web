import type { AudioInfo } from '../audio/engine';

export interface SheetTab {
  id: string;
  label: string;
  render(host: HTMLElement): void;
}

export interface SettingsSheetOptions {
  getInfo(): AudioInfo;
  onCalibrate(): void;
  onClearCalibration(): void;
  onRetryMicrophone(): void;
  onTestTone(): void;
}

export interface SettingsSheet {
  open(): void;
  close(): void;
  refresh(): void;
  setStatus(text: string | null): void;
}

function formatMs(value: number | null): string {
  if (value === null) return 'n/a';
  return `${value.toFixed(1)} ms`;
}

export function createSettingsSheet(
  host: HTMLElement,
  options: SettingsSheetOptions,
): SettingsSheet {
  const scrim = document.createElement('div');
  scrim.className = 'scrim';

  const sheet = document.createElement('section');
  sheet.className = 'sheet';
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  sheet.setAttribute('aria-label', 'Settings');

  const grab = document.createElement('div');
  grab.className = 'sheet-grab';
  const grabBar = document.createElement('span');
  grab.append(grabBar);

  const tabbar = document.createElement('div');
  tabbar.className = 'tabbar';
  tabbar.setAttribute('role', 'tablist');

  const panelHost = document.createElement('div');
  panelHost.className = 'tabpanel';

  // Adding another tab later is just another entry here.
  const tabs: SheetTab[] = [
    {
      id: 'audio',
      label: 'Audio Setup',
      render(panel) {
        const info = options.getInfo();

        const calibrationField = document.createElement('div');
        calibrationField.className = 'field';
        const calibrationLabel = document.createElement('span');
        calibrationLabel.className = 'field-label';
        calibrationLabel.textContent = 'Round-trip latency';
        const calibrationValue = document.createElement('span');
        calibrationValue.className = 'field-value';
        if (info.calibration && !info.calibrationUsable) {
          calibrationValue.textContent = 'Not calibrated (sample rate changed)';
          calibrationValue.classList.add('is-muted');
        } else if (info.calibratedMs === null) {
          calibrationValue.textContent = 'Not calibrated';
          calibrationValue.classList.add('is-muted');
        } else {
          calibrationValue.textContent = `${Math.round(info.calibratedMs)} ms`;
        }
        calibrationField.append(calibrationLabel, calibrationValue);
        panel.append(calibrationField);

        const calibrate = document.createElement('button');
        calibrate.type = 'button';
        calibrate.className = 'btn btn-primary btn-block';
        calibrate.textContent = 'Calibrate Latency';
        calibrate.addEventListener('click', () => options.onCalibrate());
        panel.append(calibrate);

        const tone = document.createElement('button');
        tone.type = 'button';
        tone.className = 'btn btn-block';
        tone.style.marginTop = '10px';
        tone.textContent = 'Play test tone';
        tone.addEventListener('click', () => options.onTestTone());
        panel.append(tone);

        if (info.calibration) {
          const when = info.calibration.measuredAt
            ? new Date(info.calibration.measuredAt).toLocaleString()
            : 'unknown time';
          const detail = document.createElement('p');
          detail.className = 'diagnostic';
          detail.style.marginTop = '10px';
          detail.textContent = `Measured ${when} at ${Math.round(info.calibration.sampleRate)} Hz.`;
          panel.append(detail);

          const clear = document.createElement('button');
          clear.type = 'button';
          clear.className = 'btn-text';
          clear.textContent = 'Clear calibration';
          clear.addEventListener('click', () => options.onClearCalibration());
          panel.append(clear);
        }

        const diagnostic = document.createElement('p');
        diagnostic.className = 'diagnostic';
        diagnostic.style.marginTop = '16px';
        const reported = [
          `base ${formatMs(info.baseLatencyMs)}`,
          `output ${formatMs(info.outputLatencyMs)}`,
          `rate ${info.sampleRate ? Math.round(info.sampleRate) : 'n/a'} Hz`,
          `context ${info.contextState}`,
        ].join(' · ');
        diagnostic.textContent = `Browser-reported (not the measured round trip): ${reported}.`;
        panel.append(diagnostic);

        if (info.lastTake) {
          const silent = info.lastTake.peak < 0.01;
          const lastTake = document.createElement('p');
          lastTake.className = `diagnostic${silent ? ' diagnostic-error' : ''}`;
          lastTake.style.marginTop = '10px';
          lastTake.textContent = silent
            ? `Last take: ${info.lastTake.seconds.toFixed(1)} s, silent (peak ${info.lastTake.peak.toFixed(3)}) — the mic captured nothing.`
            : `Last take: ${info.lastTake.seconds.toFixed(1)} s, peak ${info.lastTake.peak.toFixed(2)}.`;
          panel.append(lastTake);
        }

        const build = document.createElement('p');
        build.className = 'diagnostic';
        build.style.marginTop = '16px';
        build.textContent = `Build ${__BUILD_STAMP__}.`;
        panel.append(build);

        const status = document.createElement('p');
        status.className = 'status';
        status.textContent = currentStatus ?? '';
        panel.append(status);

        const micBlocked =
          info.micState !== 'ready' && info.micState !== 'unknown' && info.micMessage !== null;
        if (micBlocked) {
          const problem = document.createElement('p');
          problem.className = 'diagnostic diagnostic-error';
          problem.textContent = info.micMessage ?? '';
          panel.append(problem);

          const retry = document.createElement('button');
          retry.type = 'button';
          retry.className = 'btn';
          retry.style.marginTop = '10px';
          retry.textContent = 'Retry microphone';
          retry.addEventListener('click', () => options.onRetryMicrophone());
          panel.append(retry);
        }
      },
    },
  ];

  let activeTabId = tabs[0]?.id ?? '';
  let currentStatus: string | null = null;
  const tabButtons = new Map<string, HTMLButtonElement>();

  const renderPanel = (): void => {
    panelHost.textContent = '';
    const tab = tabs.find((candidate) => candidate.id === activeTabId) ?? tabs[0];
    if (tab) tab.render(panelHost);
  };

  const selectTab = (id: string): void => {
    activeTabId = id;
    for (const [tabId, button] of tabButtons) {
      button.setAttribute('aria-selected', String(tabId === id));
    }
    renderPanel();
  };

  for (const tab of tabs) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'tab';
    button.setAttribute('role', 'tab');
    button.textContent = tab.label;
    button.addEventListener('click', () => selectTab(tab.id));
    tabButtons.set(tab.id, button);
    tabbar.append(button);
  }

  sheet.append(grab, tabbar, panelHost);
  host.append(scrim, sheet);
  selectTab(activeTabId);

  const open = (): void => {
    renderPanel();
    scrim.classList.add('is-open');
    sheet.classList.add('is-open');
  };

  const close = (): void => {
    scrim.classList.remove('is-open');
    sheet.classList.remove('is-open');
    sheet.style.transform = '';
  };

  scrim.addEventListener('click', close);

  // Swipe the grab handle down to dismiss. Only the handle captures the pointer: capturing
  // on the tab bar would retarget `click` and break tab switching.
  let dragStartY = 0;
  let dragging = false;
  const dragStart = (event: PointerEvent): void => {
    dragging = true;
    dragStartY = event.clientY;
    sheet.classList.add('is-dragging');
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  };
  const dragMove = (event: PointerEvent): void => {
    if (!dragging) return;
    const delta = Math.max(0, event.clientY - dragStartY);
    sheet.style.transform = `translateY(${delta}px)`;
  };
  const dragEnd = (event: PointerEvent): void => {
    if (!dragging) return;
    dragging = false;
    sheet.classList.remove('is-dragging');
    const delta = Math.max(0, event.clientY - dragStartY);
    sheet.style.transform = '';
    if (delta > 80) close();
  };
  for (const target of [grab]) {
    target.addEventListener('pointerdown', dragStart);
    target.addEventListener('pointermove', dragMove);
    target.addEventListener('pointerup', dragEnd);
    target.addEventListener('pointercancel', dragEnd);
  }

  return {
    open,
    close,
    refresh: renderPanel,
    setStatus(text) {
      currentStatus = text;
      renderPanel();
    },
  };
}
