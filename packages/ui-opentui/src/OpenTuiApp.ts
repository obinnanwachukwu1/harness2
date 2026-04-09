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
  OpenTuiState
} from '../../../src/ui-opentui/render-types.js';
import { captureHeapSnapshot } from '../../../src/ui-opentui/heap-snapshot.js';
import { BridgeClient } from './bridge-client.js';
import { copyToClipboard } from './clipboard.js';
import { createBlockView, updateBlockView, type BlockView } from './render-block-view.js';

export class OpenTuiApp {
  static async open(options: { cwd: string; sessionId?: string }): Promise<OpenTuiApp> {
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
  private resolveRun?: () => void;
  private transientStatus: { message: string; timeout: ReturnType<typeof setTimeout> | null } | null = null;
  private capturingHeap = false;
  private readonly handleSigUsr2 = (): void => {
    void this.captureHeapSnapshots('signal');
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
        model: this.state?.status.model ?? 'gpt-5.4',
        contextText: this.state?.status.contextText ?? '',
        contextUsagePercent: this.state?.status.contextUsagePercent ?? 0,
        usageText: this.lastBridgeError ? `${this.lastBridgeError} (${exitLabel})` : this.state?.status.usageText ?? ''
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
        void this.captureHeapSnapshots('ui');
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
        model: this.state?.status.model ?? 'gpt-5.4',
        contextText: this.state?.status.contextText ?? '',
        contextUsagePercent: this.state?.status.contextUsagePercent ?? 0,
        usageText: event.message
      });
      this.renderer.requestRender();
      return;
    }

    if (event.type === 'heapSnapshot') {
      const rssMb = Math.round(event.rss / (1024 * 1024));
      this.setTransientStatus(`${event.processType} heap ${rssMb}MB`);
      this.renderer.requestRender();
      return;
    }

    if (event.type === 'ready') {
      this.renderer.requestRender();
      return;
    }

    this.applyState(event.state);
  }

  private applyState(state: OpenTuiState): void {
    this.lastBridgeError = null;
    this.state = state;
    this.input.placeholder = state.inputPlaceholder;
    this.syncTranscript(state.blocks);
    this.syncExperiments(state.experiments);
    this.renderStatusLine(state.status);
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

    const sessionLabel = this.state?.sessionId?.replace(/^session-/, '');
    const leftIds = {
      status: 'status-row-status',
      model: 'status-row-model',
      context: 'status-row-context',
      usage: 'status-row-usage'
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
    if (this.transientStatus?.timeout) {
      clearTimeout(this.transientStatus.timeout);
      this.transientStatus = null;
    }
    await this.bridge.dispose();
    this.renderer.destroy();
    this.resolveRun?.();
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
        trigger
      });
      const rssMb = Math.round(snapshot.rss / (1024 * 1024));
      this.setTransientStatus(`tui heap ${rssMb}MB`);
      this.bridge.send({
        type: 'captureHeap',
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
  if (status === 'running turn') {
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
    'status-row-model',
    'status-row-gap-2',
    'status-row-context',
    'status-row-gap-3',
    'status-row-usage',
    'status-row-spacer',
    'status-row-transient',
    'status-row-gap-4',
    'status-row-session'
  ]) {
    container.remove(id);
  }
}
