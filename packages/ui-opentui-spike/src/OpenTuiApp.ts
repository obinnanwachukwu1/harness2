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
import { BridgeClient } from './bridge-client.js';
import { clearChildren, createBlockView, updateBlockView, type BlockView } from './render-block-view.js';

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
  private readonly statusLine: TextRenderable;
  private readonly input: InputRenderable;
  private readonly blockViews = new Map<string, BlockView>();
  private currentBlocks: OpenTuiRenderBlock[] = [];
  private readonly experimentChildIds = new Set<string>();
  private destroyed = false;
  private resolveRun?: () => void;
  private transientStatus: { message: string; timeout: ReturnType<typeof setTimeout> | null } | null = null;
  private lastCopiedSelection = '';

  private constructor(
    private readonly renderer: CliRenderer,
    private readonly bridge: BridgeClient
  ) {
    this.renderer.setTerminalTitle('harness2 OpenTUI');
    this.root = this.buildLayout();
    this.transcriptScroll = this.root.findDescendantById('transcript-scroll') as ScrollBoxRenderable;
    this.transcriptContent = this.root.findDescendantById('transcript-content') as BoxRenderable;
    this.experimentRail = this.root.findDescendantById('experiment-rail') as BoxRenderable;
    this.statusLine = this.root.findDescendantById('status-line') as TextRenderable;
    this.input = this.root.findDescendantById('composer-input') as InputRenderable;

    this.renderer.root.add(this.root);
    this.bindBridge();
    this.bindKeys();
    this.bindInput();
    this.bindSelection();
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
        content: ' h2',
        fg: '#ffffff',
        attributes: TextAttributes.BOLD
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
        border: ['left'],
        borderColor: '#333333',
        paddingLeft: 1
      })
    );

    const divider = new TextRenderable(this.renderer, {
      content: '─'.repeat(Math.max(8, this.renderer.width || 80)),
      fg: '#3a3a3a',
      width: '100%',
      truncate: true
    });

    const footer = new BoxRenderable(this.renderer, {
      width: '100%',
      height: 2,
      flexDirection: 'column'
    });
    footer.add(
      new TextRenderable(this.renderer, {
        id: 'status-line',
        content: '',
        fg: '#8b8b8b',
        truncate: true
      })
    );
    footer.add(
      new InputRenderable(this.renderer, {
        id: 'composer-input',
        placeholder: 'Send a prompt…  ctrl-c quit  pageup/pagedown scroll  ctrl-t thinking',
        textColor: '#ffffff',
        placeholderColor: '#6b7280',
        backgroundColor: '#111111',
        focusedTextColor: '#ffffff',
        focusedBackgroundColor: '#111111'
      })
    );

    app.add(header);
    app.add(body);
    app.add(divider);
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
      this.statusLine.content = ` bridge exited (${code ?? 'unknown'})`;
      this.renderer.requestRender();
    });
  }

  private bindKeys(): void {
    this.renderer.keyInput.on('keypress', (key) => {
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

      const text = selection.getSelectedText().trim();
      if (!text) {
        return;
      }
      if (text === this.lastCopiedSelection) {
        return;
      }

      const copied = this.renderer.copyToClipboardOSC52(text);
      this.lastCopiedSelection = text;
      this.setTransientStatus(copied ? 'copied selection' : 'copy unsupported in this terminal');
    });
  }

  private handleBridgeEvent(event: OpenTuiBridgeEvent): void {
    if (event.type === 'error') {
      this.statusLine.content = ` error  ${event.message}`;
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
    this.state = state;
    this.input.placeholder = state.inputPlaceholder;
    this.syncTranscript(state.blocks);
    this.syncExperiments(state.experiments);
    this.renderStatusLine(state.statusLine);
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

    for (const block of blocks) {
      const existing = this.blockViews.get(block.id);
      if (existing) {
        updateBlockView(this.renderer, existing, block);
        continue;
      }

      const view = createBlockView(this.renderer, block);
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

  private renderStatusLine(baseStatus: string): void {
    const transient = this.transientStatus?.message;
    this.statusLine.content = transient ? ` ${transient}  ·  ${baseStatus}` : ` ${baseStatus}`;
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
          this.renderStatusLine(this.state.statusLine);
          this.renderer.requestRender();
        }
      }, 1500)
    };

    if (this.state) {
      this.renderStatusLine(this.state.statusLine);
      this.renderer.requestRender();
    }
  }

  private async destroy(): Promise<void> {
    if (this.destroyed) {
      return;
    }

    this.destroyed = true;
    if (this.transientStatus?.timeout) {
      clearTimeout(this.transientStatus.timeout);
      this.transientStatus = null;
    }
    await this.bridge.dispose();
    this.renderer.destroy();
    this.resolveRun?.();
  }
}
