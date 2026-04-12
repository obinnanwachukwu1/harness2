import {
  BoxRenderable,
  CliRenderEvents,
  type Selection,
  createCliRenderer,
  InputRenderable,
  InputRenderableEvents,
  ScrollBoxRenderable,
  TextAttributes,
  TextRenderable,
  type CliRenderer
} from '@opentui/core';

import type { OpenTuiBridgeEvent } from '../../../src/ui-opentui/protocol.js';
import type {
  OpenTuiExperimentSummary,
  OpenTuiRenderBlock,
  OpenTuiState,
  OpenTuiStatePatch
} from '../../../src/ui-opentui/render-types.js';
import { captureHeapSnapshot, writeDiagnosticReport } from '../../../src/ui-opentui/heap-snapshot.js';
import { BridgeClient } from './bridge-client.js';
import { copyToClipboard } from './clipboard.js';
import { createBlockView, updateBlockView, type BlockView } from './render-block-view.js';

export class OpenTuiApp {
  static async open(options: {
    cwd: string;
    sessionId?: string;
    mode?: 'study' | 'plan' | 'direct';
  }): Promise<OpenTuiApp> {
    const renderer = await createCliRenderer({
      exitOnCtrlC: true,
      useMouse: true,
      screenMode: 'alternate-screen',
      autoFocus: true
    });

    const bridge = new BridgeClient(options);
    await bridge.start();
    return new OpenTuiApp(renderer, bridge);
  }

  private state: OpenTuiState | null = null;
  private readonly root: BoxRenderable;
  private readonly transcriptScroll: ScrollBoxRenderable;
  private readonly transcriptContent: BoxRenderable;
  private readonly experimentRail: BoxRenderable;
  private readonly statusRow: BoxRenderable;
  private readonly input: InputRenderable;
  private readonly blockViews = new Map<string, BlockView>();
  private currentBlocks: OpenTuiRenderBlock[] = [];
  private readonly experimentChildIds = new Set<string>();
  private destroyed = false;
  private lastBridgeError: string | null = null;
  private lastRenderedStatus: OpenTuiState['status'] | null = null;
  private lastInputPlaceholder: string | null = null;
  private resolveRun?: () => void;
  private transientStatus: { message: string; timeout: ReturnType<typeof setTimeout> | null } | null = null;
  private capturingHeap = false;
  private readonly handleSigUsr2 = (): void => {
    void this.captureHeapSnapshots('signal');
  };
  private readonly handleSigTerm = (): void => {
    void this.captureDiagnosticReports('signal').finally(() => {
      process.exit(0);
    });
  };

  private constructor(
    private readonly renderer: CliRenderer,
    private readonly bridge: BridgeClient
  ) {
    this.renderer.setTerminalTitle('harness2 OpenTUI');
    this.root = this.buildLayout();
    this.transcriptScroll = this.root.findDescendantById('transcript-scroll') as ScrollBoxRenderable;
    this.transcriptContent = this.root.findDescendantById('transcript-content') as BoxRenderable;
    this.experimentRail = this.root.findDescendantById('experiment-rail') as BoxRenderable;
    this.statusRow = this.root.findDescendantById('status-row') as BoxRenderable;
    this.input = this.root.findDescendantById('composer-input') as InputRenderable;

    this.renderer.root.add(this.root);
    this.bindBridge();
    this.bindKeys();
    this.bindInput();
    this.bindSelection();
    process.on('SIGUSR2', this.handleSigUsr2);
    process.on('SIGTERM', this.handleSigTerm);
    this.input.focus();
  }

  async run(): Promise<void> {
    this.renderer.start();

    await new Promise<void>((resolve) => {
      this.resolveRun = resolve;
      this.renderer.on(CliRenderEvents.DESTROY, () => resolve());
    });
  }

  private buildLayout(): BoxRenderable {
    const app = new BoxRenderable(this.renderer, {
      width: '100%',
      height: '100%',
      flexDirection: 'column',
      backgroundColor: '#111111'
    });

    const header = new BoxRenderable(this.renderer, {
      width: '100%',
      height: 1,
      flexDirection: 'row'
    });
    header.add(
      new TextRenderable(this.renderer, {
        content: '  h2',
        fg: '#71717a'
      })
    );

    const body = new BoxRenderable(this.renderer, {
      width: '100%',
      flexGrow: 1,
      flexDirection: 'row'
    });

    const transcriptScroll = new ScrollBoxRenderable(this.renderer, {
      id: 'transcript-scroll',
      flexGrow: 1,
      height: '100%',
      scrollY: true,
      scrollX: false,
      stickyScroll: true,
      stickyStart: 'bottom',
      rootOptions: {
        border: false
      },
      viewportOptions: {
        paddingRight: 1
      },
      contentOptions: {
        width: '100%',
        flexDirection: 'column'
      },
      verticalScrollbarOptions: {
        trackOptions: {
          backgroundColor: '#111111'
        }
      }
    });
    transcriptScroll.content.id = 'transcript-content';
    body.add(transcriptScroll);

    body.add(
      new BoxRenderable(this.renderer, {
        id: 'experiment-rail',
        width: 34,
        height: '100%',
        flexDirection: 'column',
        marginBottom: 1,
        border: ['left'],
        borderColor: '#333333',
        paddingLeft: 1
      })
    );

    const footer = new BoxRenderable(this.renderer, {
      width: '100%',
      height: 5,
      flexDirection: 'column'
    });
    const promptShell = new BoxRenderable(this.renderer, {
      width: '100%',
      marginLeft: 1,
      marginRight: 1,
      backgroundColor: '#27272a',
      paddingTop: 1,
      paddingBottom: 1,
      paddingLeft: 1,
      paddingRight: 1
    });
    promptShell.add(
      new InputRenderable(this.renderer, {
        id: 'composer-input',
        placeholder: 'Send a prompt…',
        textColor: '#ffffff',
        placeholderColor: '#71717a',
        backgroundColor: '#27272a',
        focusedTextColor: '#ffffff',
        focusedBackgroundColor: '#27272a'
      })
    );
    footer.add(promptShell);
    footer.add(
      new BoxRenderable(this.renderer, {
        id: 'status-row',
        width: '100%',
        flexDirection: 'row',
        marginTop: 1,
        marginLeft: 2,
        marginRight: 2
      })
    );

    app.add(header);
    app.add(body);
    app.add(footer);
    return app;
  }

  private bindBridge(): void {
    this.bridge.on('event', (event) => {
      this.handleBridgeEvent(event);
    });
    this.bridge.on('exit', (code) => {
      if (this.destroyed) {
        return;
      }
      const exitLabel = `bridge exited (${code ?? 'unknown'})`;
      this.renderStatusLine({
        label: this.lastBridgeError ? 'error' : exitLabel,
        modeText: this.state?.status.modeText ?? 'study',
        model: this.state?.status.model ?? 'gpt-5.4',
        contextText: this.state?.status.contextText ?? '',
        contextUsagePercent: this.state?.status.contextUsagePercent ?? 0,
        usageText: this.lastBridgeError ? `${this.lastBridgeError} (${exitLabel})` : this.state?.status.usageText ?? '',
        pendingText: this.state?.status.pendingText ?? null
      });
      this.renderer.requestRender();
    });
  }

  private bindKeys(): void {
    this.renderer.keyInput.on('keypress', (key) => {
      if (key.name === 'escape' && this.renderer.hasSelection) {
        this.renderer.clearSelection();
        this.renderer.requestRender();
        return;
      }

      if (key.ctrl && key.name === 'c') {
        void this.destroy();
        return;
      }

      if (key.ctrl && key.name === 't') {
        const enabled = !(this.state?.thinkingEnabled ?? false);
        this.bridge.send({
          type: 'setThinking',
          enabled
        });
        return;
      }

      if (key.ctrl && key.name === 'y') {
        void this.captureDiagnosticReports('ui');
        return;
      }

      if (key.name === 'pageup') {
        this.transcriptScroll.scrollBy(-10, 'step');
        this.renderer.requestRender();
        return;
      }

      if (key.name === 'pagedown') {
        this.transcriptScroll.scrollBy(10, 'step');
        this.renderer.requestRender();
        return;
      }

      if (key.name === 'home') {
        this.transcriptScroll.scrollTo({ x: 0, y: 0 });
        this.renderer.requestRender();
        return;
      }

      if (key.name === 'end') {
        this.transcriptScroll.scrollTo({ x: 0, y: this.transcriptScroll.scrollHeight });
        this.renderer.requestRender();
      }
    });
  }

  private bindInput(): void {
    this.input.on(InputRenderableEvents.ENTER, (value: string) => {
      const text = value.trim();
      if (!text) {
        return;
      }

      this.bridge.send({
        type: 'submit',
        text
      });
      this.input.value = '';
      this.renderer.requestRender();
    });
  }

  private bindSelection(): void {
    this.renderer.on(CliRenderEvents.SELECTION, (selection: Selection) => {
      if (selection.isDragging) {
        return;
      }

      const text = selection.getSelectedText();
      if (text.length === 0) {
        return;
      }

      void this.copySelectionText(text);
    });
  }

  private async copySelectionText(text: string): Promise<void> {
    const osc52Copied = this.renderer.copyToClipboardOSC52(text);
    const nativeCopied = await copyToClipboard(text);

    this.renderer.clearSelection();
    this.renderer.requestRender();
    this.setTransientStatus(
      osc52Copied || nativeCopied ? 'copied selection' : 'copy unsupported in this terminal'
    );
  }

  private handleBridgeEvent(event: OpenTuiBridgeEvent): void {
    if (event.type === 'error') {
      this.lastBridgeError = event.message;
      this.renderStatusLine({
        label: 'error',
        modeText: this.state?.status.modeText ?? 'study',
        model: this.state?.status.model ?? 'gpt-5.4',
        contextText: this.state?.status.contextText ?? '',
        contextUsagePercent: this.state?.status.contextUsagePercent ?? 0,
        usageText: event.message,
        pendingText: this.state?.status.pendingText ?? null
      });
      this.renderer.requestRender();
      return;
    }

    if (event.type === 'diagnosticCapture') {
      const rssMb = Math.round(event.rss / (1024 * 1024));
      this.setTransientStatus(`${event.processType} ${event.mode} ${rssMb}MB`);
      this.renderer.requestRender();
      return;
    }

    if (event.type === 'ready') {
      this.renderer.requestRender();
      return;
    }

    if (event.type === 'hydrate') {
      this.applyState(event.state);
      return;
    }

    this.applyStatePatch(event.patch);
  }

  private applyState(state: OpenTuiState): void {
    this.lastBridgeError = null;
    this.state = state;
    if (this.lastInputPlaceholder !== state.inputPlaceholder) {
      this.input.placeholder = state.inputPlaceholder;
      this.lastInputPlaceholder = state.inputPlaceholder;
    }
    this.syncTranscript(state.blocks);
    this.syncExperiments(state.experiments);
    if (!statusLineEquals(this.lastRenderedStatus, state.status)) {
      this.renderStatusLine(state.status);
    }
    this.renderer.requestRender();
  }

  private applyStatePatch(patch: OpenTuiStatePatch): void {
    if (!this.state) {
      return;
    }

    this.lastBridgeError = null;
    const nextState = mergeStatePatch(this.state, patch);
    this.state = nextState;

    if (
      Object.prototype.hasOwnProperty.call(patch, 'inputPlaceholder') &&
      this.lastInputPlaceholder !== nextState.inputPlaceholder
    ) {
      this.input.placeholder = nextState.inputPlaceholder;
      this.lastInputPlaceholder = nextState.inputPlaceholder;
    }

    if (patch.upsertBlocks || patch.removeBlockIds || patch.blockOrder) {
      this.syncTranscriptPatch(this.currentBlocks, nextState.blocks, patch);
    }

    if (patch.experiments) {
      this.syncExperiments(nextState.experiments);
    }

    if (patch.status && !statusLineEquals(this.lastRenderedStatus, nextState.status)) {
      this.renderStatusLine(nextState.status);
    }

    this.renderer.requestRender();
  }

  private syncTranscript(blocks: OpenTuiRenderBlock[]): void {
    const nextIds = new Set(blocks.map((block) => block.id));

    for (const [id, view] of this.blockViews) {
      if (!nextIds.has(id)) {
        this.transcriptContent.remove(view.container.id);
        this.blockViews.delete(id);
      }
    }

    for (const [index, block] of blocks.entries()) {
      const existing = this.blockViews.get(block.id);
      if (existing) {
        updateBlockView(this.renderer, existing, block, { isFirst: index === 0 });
        continue;
      }

      const view = createBlockView(this.renderer, block, { isFirst: index === 0 });
      this.transcriptContent.add(view.container);
      this.blockViews.set(block.id, view);
    }

    this.currentBlocks = blocks;
  }

  private syncTranscriptPatch(
    previousBlocks: OpenTuiRenderBlock[],
    nextBlocks: OpenTuiRenderBlock[],
    patch: OpenTuiStatePatch
  ): void {
    const removeBlockIds = new Set(patch.removeBlockIds ?? []);
    const upsertBlockIds = new Set((patch.upsertBlocks ?? []).map((block) => block.id));
    const previousIndexById = new Map(previousBlocks.map((block, index) => [block.id, index]));

    for (const id of removeBlockIds) {
      const view = this.blockViews.get(id);
      if (!view) {
        continue;
      }
      this.transcriptContent.remove(view.container.id);
      this.blockViews.delete(id);
    }

    for (const [index, block] of nextBlocks.entries()) {
      const existing = this.blockViews.get(block.id);
      if (!existing) {
        const view = createBlockView(this.renderer, block, { isFirst: index === 0 });
        this.transcriptContent.add(view.container, index);
        this.blockViews.set(block.id, view);
        continue;
      }

      if (upsertBlockIds.has(block.id)) {
        updateBlockView(this.renderer, existing, block, { isFirst: index === 0 });
      }

      const previousIndex = previousIndexById.get(block.id);
      if (previousIndex !== undefined && previousIndex !== index) {
        this.transcriptContent.remove(existing.container.id);
        this.transcriptContent.add(existing.container, index);
      }
    }

    this.currentBlocks = nextBlocks;
  }

  private syncExperiments(experiments: OpenTuiExperimentSummary[]): void {
    for (const childId of this.experimentChildIds) {
      this.experimentRail.remove(childId);
    }
    this.experimentChildIds.clear();

    this.experimentRail.add(
      new TextRenderable(this.renderer, {
        id: 'experiment-rail-title',
        content: 'experiments',
        fg: '#8b8b8b',
        attributes: TextAttributes.DIM
      })
    );
    this.experimentChildIds.add('experiment-rail-title');

    if (experiments.length === 0) {
      this.experimentRail.add(
        new TextRenderable(this.renderer, {
          id: 'experiment-rail-empty',
          content: 'No experiments yet.',
          fg: '#6b6b6b'
        })
      );
      this.experimentChildIds.add('experiment-rail-empty');
      return;
    }

    for (const [index, experiment] of experiments.entries()) {
      const headerId = `experiment-${index}-header`;
      const summaryId = `experiment-${index}-summary`;
      const metaId = `experiment-${index}-meta`;
      const spacerId = `experiment-${index}-spacer`;

      this.experimentRail.add(
        new TextRenderable(this.renderer, {
          id: headerId,
          content: `${experiment.id}  ${experiment.status}`,
          fg: '#ffffff',
          attributes: TextAttributes.BOLD,
          wrapMode: 'word'
        })
      );
      this.experimentChildIds.add(headerId);
      this.experimentRail.add(
        new TextRenderable(this.renderer, {
          id: summaryId,
          content: experiment.summary,
          fg: '#9ca3af',
          wrapMode: 'word'
        })
      );
      this.experimentChildIds.add(summaryId);
      this.experimentRail.add(
        new TextRenderable(this.renderer, {
          id: metaId,
          content: experiment.meta,
          fg: '#6b7280',
          wrapMode: 'word'
        })
      );
      this.experimentChildIds.add(metaId);
      this.experimentRail.add(
        new TextRenderable(this.renderer, {
          id: spacerId,
          content: '',
          fg: '#111111'
        })
      );
      this.experimentChildIds.add(spacerId);
    }
  }

  private renderStatusLine(status: OpenTuiState['status']): void {
    clearStatusRow(this.statusRow);
    this.lastRenderedStatus = { ...status };

    const sessionLabel = this.state?.sessionId?.replace(/^session-/, '');
    const leftIds = {
      status: 'status-row-status',
      mode: 'status-row-mode',
      model: 'status-row-model',
      context: 'status-row-context',
      usage: 'status-row-usage',
      pending: 'status-row-pending'
    } as const;
    const rightIds = {
      transient: 'status-row-transient',
      session: 'status-row-session'
    } as const;

    this.statusRow.add(
      new TextRenderable(this.renderer, {
        id: leftIds.status,
        content: status.label,
        fg: getStatusColor(status.label)
      })
    );
    this.statusRow.add(newTextSpacer(this.renderer, 'status-row-gap-1'));
    this.statusRow.add(
      new TextRenderable(this.renderer, {
        id: leftIds.mode,
        content: status.modeText,
        fg: '#d4d4d8'
      })
    );
    this.statusRow.add(newTextSpacer(this.renderer, 'status-row-gap-1b'));
    this.statusRow.add(
      new TextRenderable(this.renderer, {
        id: leftIds.model,
        content: status.model,
        fg: '#a1a1aa'
      })
    );
    this.statusRow.add(newTextSpacer(this.renderer, 'status-row-gap-2'));
    this.statusRow.add(
      new TextRenderable(this.renderer, {
        id: leftIds.context,
        content: status.contextText,
        fg: getContextColor(status.contextUsagePercent)
      })
    );
    this.statusRow.add(newTextSpacer(this.renderer, 'status-row-gap-3'));
    this.statusRow.add(
      new TextRenderable(this.renderer, {
        id: leftIds.usage,
        content: status.usageText,
        fg: getContextColor(status.contextUsagePercent)
      })
    );
    if (status.pendingText) {
      this.statusRow.add(newTextSpacer(this.renderer, 'status-row-gap-3b'));
      this.statusRow.add(
        new TextRenderable(this.renderer, {
          id: leftIds.pending,
          content: status.pendingText,
          fg: '#fbbf24'
        })
      );
    }
    this.statusRow.add(
      new BoxRenderable(this.renderer, {
        id: 'status-row-spacer',
        flexGrow: 1
      })
    );

    if (this.transientStatus?.message) {
      this.statusRow.add(
        new TextRenderable(this.renderer, {
          id: rightIds.transient,
          content: this.transientStatus.message,
          fg: '#93c5fd'
        })
      );
      if (sessionLabel) {
        this.statusRow.add(newTextSpacer(this.renderer, 'status-row-gap-4'));
      }
    }

    if (sessionLabel) {
      this.statusRow.add(
        new TextRenderable(this.renderer, {
          id: rightIds.session,
          content: sessionLabel,
          fg: '#71717a',
          truncate: true,
          wrapMode: 'none'
        })
      );
    }
  }

  private setTransientStatus(message: string): void {
    if (this.transientStatus?.timeout) {
      clearTimeout(this.transientStatus.timeout);
    }

    this.transientStatus = {
      message,
      timeout: setTimeout(() => {
        this.transientStatus = null;
        if (this.state) {
          this.renderStatusLine(this.state.status);
          this.renderer.requestRender();
        }
      }, 1500)
    };

    if (this.state) {
      this.renderStatusLine(this.state.status);
      this.renderer.requestRender();
    }
  }

  private async destroy(): Promise<void> {
    if (this.destroyed) {
      return;
    }

    this.destroyed = true;
    process.off('SIGUSR2', this.handleSigUsr2);
    process.off('SIGTERM', this.handleSigTerm);
    if (this.transientStatus?.timeout) {
      clearTimeout(this.transientStatus.timeout);
      this.transientStatus = null;
    }
    await this.bridge.dispose();
    this.renderer.destroy();
    this.resolveRun?.();
  }

  private diagnosticExtra(): Record<string, unknown> {
    return {
      ui: {
        blockViews: this.blockViews.size,
        currentBlocks: this.currentBlocks.length,
        experimentCards: this.experimentChildIds.size,
        rendererSelectionActive: this.renderer.hasSelection
      },
      state: this.state
        ? {
            sessionId: this.state.sessionId,
            cwd: this.state.cwd,
            blocks: this.state.blocks.length,
            experiments: this.state.experiments.length,
            thinkingEnabled: this.state.thinkingEnabled
          }
        : null
    };
  }

  private async captureDiagnosticReports(trigger: 'ui' | 'signal'): Promise<void> {
    this.setTransientStatus('capturing diagnostic reports…');
    try {
      const cwd = this.state?.cwd ?? process.cwd();
      const report = await writeDiagnosticReport({
        cwd,
        processType: 'tui',
        trigger,
        extra: this.diagnosticExtra()
      });
      const rssMb = Math.round(report.rss / (1024 * 1024));
      this.setTransientStatus(`tui report ${rssMb}MB`);
      this.bridge.send({
        type: 'captureDiagnostics',
        mode: 'report',
        trigger
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setTransientStatus(`diagnostic report failed: ${message}`);
    }
  }

  private async captureHeapSnapshots(trigger: 'ui' | 'signal'): Promise<void> {
    if (this.capturingHeap) {
      this.setTransientStatus('heap snapshot already running');
      return;
    }

    this.capturingHeap = true;
    this.setTransientStatus('capturing heap snapshots…');
    try {
      const cwd = this.state?.cwd ?? process.cwd();
      const snapshot = await captureHeapSnapshot({
        cwd,
        processType: 'tui',
        trigger,
        extra: this.diagnosticExtra()
      });
      const rssMb = Math.round(snapshot.rss / (1024 * 1024));
      this.setTransientStatus(`tui heap ${rssMb}MB`);
      this.bridge.send({
        type: 'captureDiagnostics',
        mode: 'heap',
        trigger
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setTransientStatus(`heap snapshot failed: ${message}`);
    } finally {
      this.capturingHeap = false;
    }
  }
}

function getStatusColor(status: string): string {
  if (status === 'running' || status === 'running turn') {
    return '#60a5fa';
  }
  if (status === 'error') {
    return '#f87171';
  }
  return '#71717a';
}

function getContextColor(usedPercent: number): string {
  if (usedPercent >= 85) {
    return '#f87171';
  }
  if (usedPercent >= 60) {
    return '#fbbf24';
  }
  return '#71717a';
}

function newTextSpacer(renderer: CliRenderer, id: string): TextRenderable {
  return new TextRenderable(renderer, {
    id,
    content: '  ',
    fg: '#71717a'
  });
}

function clearStatusRow(container: BoxRenderable): void {
  for (const id of [
    'status-row-status',
    'status-row-gap-1',
    'status-row-mode',
    'status-row-gap-1b',
    'status-row-model',
    'status-row-gap-2',
    'status-row-context',
    'status-row-gap-3',
    'status-row-usage',
    'status-row-gap-3b',
    'status-row-pending',
    'status-row-spacer',
    'status-row-transient',
    'status-row-gap-4',
    'status-row-session'
  ]) {
    container.remove(id);
  }
}

function statusLineEquals(
  left: OpenTuiState['status'] | null,
  right: OpenTuiState['status']
): boolean {
  if (!left) {
    return false;
  }

  return (
    left.label === right.label &&
    left.modeText === right.modeText &&
    left.model === right.model &&
    left.contextText === right.contextText &&
    left.contextUsagePercent === right.contextUsagePercent &&
    left.usageText === right.usageText &&
    left.pendingText === right.pendingText
  );
}

function mergeStatePatch(state: OpenTuiState, patch: OpenTuiStatePatch): OpenTuiState {
  let blocks = state.blocks;
  if (patch.removeBlockIds || patch.upsertBlocks || patch.blockOrder) {
    const blockById = new Map(state.blocks.map((block) => [block.id, block]));
    for (const id of patch.removeBlockIds ?? []) {
      blockById.delete(id);
    }
    for (const block of patch.upsertBlocks ?? []) {
      blockById.set(block.id, block);
    }
    const seen = new Set<string>();
    const orderedIds = patch.blockOrder ?? state.blocks.map((block) => block.id);
    blocks = orderedIds
      .map((id) => {
        const block = blockById.get(id);
        if (!block) {
          return null;
        }
        seen.add(id);
        return block;
      })
      .filter((block): block is OpenTuiRenderBlock => block !== null);

    for (const block of patch.upsertBlocks ?? []) {
      if (seen.has(block.id)) {
        continue;
      }
      blocks.push(block);
    }
  }

  return {
    sessionId: patch.sessionId,
    cwd: patch.cwd,
    status: patch.status ?? state.status,
    thinkingEnabled:
      Object.prototype.hasOwnProperty.call(patch, 'thinkingEnabled')
        ? patch.thinkingEnabled!
        : state.thinkingEnabled,
    inputPlaceholder: patch.inputPlaceholder ?? state.inputPlaceholder,
    blocks,
    experiments: patch.experiments ?? state.experiments
  };
}
