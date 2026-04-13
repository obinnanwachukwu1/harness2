import {
  BoxRenderable,
  type CliRenderer,
  DiffRenderable,
  MarkdownRenderable,
  SyntaxStyle,
  RGBA,
  TextAttributes,
  TextRenderable
} from '@opentui/core';

import type { RenderBlock } from '../../../src/ui/render-types.js';

type ToolTone = Extract<RenderBlock, { kind: 'tool' }>['tone'];

const assistantMarkdownSyntaxStyle = createMarkdownSyntaxStyle({
  text: '#ffffff',
  accent: '#93c5fd',
  quote: '#d1d5db',
  code: '#c4b5fd'
});

const interruptionMarkdownSyntaxStyle = createMarkdownSyntaxStyle({
  text: '#f87171',
  accent: '#fca5a5',
  quote: '#fecaca',
  code: '#fda4af'
});

const thinkingMarkdownSyntaxStyle = createMarkdownSyntaxStyle({
  text: RGBA.fromValues(0.24, 0.68, 0.78, 0.72),
  accent: RGBA.fromValues(0.22, 0.62, 0.72, 0.72),
  quote: RGBA.fromValues(0.32, 0.74, 0.82, 0.62),
  code: RGBA.fromValues(0.40, 0.78, 0.88, 0.72),
  strongItalic: true
});

const diffSyntaxStyle = SyntaxStyle.fromStyles({
  default: { fg: RGBA.fromHex('#e4e4e7') },
  string: { fg: RGBA.fromHex('#c4b5fd') },
  keyword: { fg: RGBA.fromHex('#93c5fd'), bold: true },
  comment: { fg: RGBA.fromHex('#71717a'), italic: true },
  function: { fg: RGBA.fromHex('#f0abfc') },
  type: { fg: RGBA.fromHex('#67e8f9') }
});

export interface BlockView {
  container: BoxRenderable;
  kind?: RenderBlock['kind'];
  userBubble?: BoxRenderable;
  userText?: TextRenderable;
  markdown?: MarkdownRenderable;
  diff?: DiffRenderable;
}

export function createBlockView(
  renderer: CliRenderer,
  block: RenderBlock,
  options: { isFirst: boolean }
): BlockView {
  const container = new BoxRenderable(renderer, {
    id: `block-${block.id}`,
    width: '100%',
    flexDirection: 'column',
    paddingBottom: 1
  });

  const view: BlockView = { container };
  updateBlockView(renderer, view, block, options);
  return view;
}

export function updateBlockView(
  renderer: CliRenderer,
  view: BlockView,
  block: RenderBlock,
  options: { isFirst: boolean }
): void {
  const baseId = view.container.id;

  switch (block.kind) {
    case 'user': {
      if (view.kind === 'user' && view.userText && view.userBubble) {
        view.userBubble.marginTop = options.isFirst ? 1 : 0;
        view.userText.content = block.text;
        return;
      }

      clearBlockChildren(view);
      const bubble = new BoxRenderable(renderer, {
        id: `${baseId}-user`,
        width: '100%',
        marginTop: options.isFirst ? 1 : 0,
        marginLeft: 1,
        marginRight: 1,
        backgroundColor: '#27272a',
        paddingTop: 1,
        paddingBottom: 1,
        paddingLeft: 1,
        paddingRight: 1
      });
      const userText = new TextRenderable(renderer, {
        id: `${baseId}-user-text`,
        content: block.text,
        fg: '#ffffff',
        selectionBg: '#93c5fd',
        selectionFg: '#111111',
        wrapMode: 'word'
      });
      bubble.add(userText);
      view.container.add(bubble);
      view.kind = 'user';
      view.userBubble = bubble;
      view.userText = userText;
      view.markdown = undefined;
      view.diff = undefined;
      return;
    }
    case 'assistant': {
      const isInterruption = block.tone === 'interruption';
      const syntaxStyle = isInterruption ? interruptionMarkdownSyntaxStyle : assistantMarkdownSyntaxStyle;
      const foreground = isInterruption ? '#f87171' : '#ffffff';
      if (view.kind === 'assistant' && view.markdown) {
        view.markdown.content = block.text;
        view.markdown.streaming = block.live ?? false;
        view.markdown.syntaxStyle = syntaxStyle;
        view.markdown.fg = foreground;
        view.markdown.bg = '#111111';
        return;
      }

      clearBlockChildren(view);
      const markdown = new MarkdownRenderable(renderer, {
        id: `${baseId}-assistant`,
        content: block.text,
        syntaxStyle,
        fg: foreground,
        bg: '#111111',
        marginLeft: 1,
        marginRight: 1,
        conceal: true,
        streaming: block.live ?? false
      });
      view.container.add(markdown);
      view.kind = 'assistant';
      view.userBubble = undefined;
      view.userText = undefined;
      view.markdown = markdown;
      view.diff = undefined;
      return;
    }
    case 'thinking': {
      if (view.kind === 'thinking' && view.markdown) {
        view.markdown.content = block.text;
        view.markdown.streaming = block.live ?? false;
        view.markdown.fg = RGBA.fromValues(0.24, 0.68, 0.78, 0.72);
        view.markdown.bg = '#111111';
        return;
      }

      clearBlockChildren(view);
      const markdown = new MarkdownRenderable(renderer, {
        id: `${baseId}-thinking`,
        content: block.text,
        syntaxStyle: thinkingMarkdownSyntaxStyle,
        fg: RGBA.fromValues(0.24, 0.68, 0.78, 0.72),
        bg: '#111111',
        marginLeft: 1,
        marginRight: 1,
        conceal: true,
        streaming: block.live ?? false
      });
      view.container.add(markdown);
      view.kind = 'thinking';
      view.userBubble = undefined;
      view.userText = undefined;
      view.markdown = markdown;
      view.diff = undefined;
      return;
    }
    case 'diff': {
      clearBlockChildren(view);
      const wrapper = new BoxRenderable(renderer, {
        id: `${baseId}-diff-wrapper`,
        width: '100%',
        marginTop: options.isFirst ? 1 : 0,
        marginLeft: 1,
        marginRight: 1,
        flexDirection: 'column'
      });
      wrapper.add(
        new TextRenderable(renderer, {
          id: `${baseId}-diff-title`,
          content: block.title,
          fg: '#a1a1aa',
          attributes: TextAttributes.BOLD,
          wrapMode: 'word'
        })
      );
      const diffShell = new BoxRenderable(renderer, {
        id: `${baseId}-diff-shell`,
        width: '100%',
        height: estimateDiffHeight(block.diff),
        flexDirection: 'column'
      });
      const diff = new DiffRenderable(renderer, {
        id: `${baseId}-diff`,
        width: '100%',
        height: '100%',
        diff: block.diff,
        view: block.view ?? 'unified',
        filetype: block.filetype,
        syntaxStyle: diffSyntaxStyle,
        showLineNumbers: true,
        wrapMode: 'none',
        fg: '#e4e4e7',
        lineNumberFg: '#71717a',
        addedBg: RGBA.fromValues(0.07, 0.18, 0.12, 0.65),
        removedBg: RGBA.fromValues(0.22, 0.08, 0.08, 0.65),
        contextBg: RGBA.fromValues(0, 0, 0, 0),
        addedSignColor: '#4ade80',
        removedSignColor: '#f87171'
      });
      diffShell.add(diff);
      wrapper.add(diffShell);
      view.container.add(wrapper);
      view.kind = 'diff';
      view.userBubble = undefined;
      view.userText = undefined;
      view.markdown = undefined;
      view.diff = diff;
      return;
    }
    case 'tool': {
      clearBlockChildren(view);
      view.kind = 'tool';
      view.userBubble = undefined;
      view.userText = undefined;
      view.markdown = undefined;
      view.diff = undefined;
      const colors = getToolToneColors(block.tone);
      const headerRow = new BoxRenderable(renderer, {
        id: `${baseId}-tool-header-row`,
        width: '100%',
        flexDirection: 'row',
        marginLeft: 1,
        marginRight: 1
      });
      headerRow.add(
        new TextRenderable(renderer, {
          id: `${baseId}-tool-header-dot`,
          content: '⏺ ',
          fg: colors.header,
          selectionBg: colors.selectionBg,
          selectionFg: '#111111',
          attributes: block.live
            ? TextAttributes.BOLD | TextAttributes.BLINK
            : TextAttributes.BOLD
        })
      );
      headerRow.add(
        new TextRenderable(renderer, {
          id: `${baseId}-tool-header`,
          content: block.header,
          fg: colors.header,
          selectionBg: colors.selectionBg,
          selectionFg: '#111111',
          attributes: TextAttributes.BOLD,
          wrapMode: 'word',
          flexGrow: 1
        })
      );
      view.container.add(headerRow);
      if (block.body.length > 0) {
        const bodyRow = new BoxRenderable(renderer, {
          id: `${baseId}-tool-body-row`,
          width: '100%',
          flexDirection: 'row',
          marginLeft: 1,
          marginRight: 1
        });
        bodyRow.add(
          new TextRenderable(renderer, {
            id: `${baseId}-tool-body-gutter`,
            content: '⎿ ',
            fg: colors.gutter
          })
        );
        bodyRow.add(
          new TextRenderable(renderer, {
            id: `${baseId}-tool-body`,
            content: block.body.join('\n'),
            fg: colors.body,
            selectionBg: colors.selectionBg,
            selectionFg: '#111111',
            wrapMode: 'word',
            flexGrow: 1
          })
        );
        view.container.add(bodyRow);
      }
      if (block.footer.length > 0) {
        const footerRow = new BoxRenderable(renderer, {
          id: `${baseId}-tool-footer-row`,
          width: '100%',
          flexDirection: 'row',
          marginLeft: 1,
          marginRight: 1
        });
        footerRow.add(
          new TextRenderable(renderer, {
            id: `${baseId}-tool-footer-gutter`,
            content: '  ',
            fg: colors.footer
          })
        );
        footerRow.add(
          new TextRenderable(renderer, {
            id: `${baseId}-tool-footer`,
            content: block.footer.join('\n'),
            fg: colors.footer,
            selectionBg: colors.selectionBg,
            selectionFg: '#111111',
            wrapMode: 'word',
            flexGrow: 1
          })
        );
        view.container.add(footerRow);
      }
    }
  }
}

function getToolToneColors(tone: ToolTone): {
  header: string;
  gutter: string;
  body: string;
  footer: string;
  selectionBg: string;
} {
  switch (tone) {
    case 'experiment':
      return {
        header: '#facc15',
        gutter: '#facc15',
        body: '#facc15',
        footer: '#ca8a04',
        selectionBg: '#fde68a'
      };
    case 'study_debt':
      return {
        header: '#fb7185',
        gutter: '#fb7185',
        body: '#fda4af',
        footer: '#e11d48',
        selectionBg: '#fecdd3'
      };
    default:
      return {
        header: '#8b8b8b',
        gutter: '#9ca3af',
        body: '#9ca3af',
        footer: '#6b7280',
        selectionBg: '#d1d5db'
      };
  }
}

function createMarkdownSyntaxStyle(colors: {
  text: string | RGBA;
  accent: string | RGBA;
  quote: string | RGBA;
  code: string | RGBA;
  strongItalic?: boolean;
}): SyntaxStyle {
  return SyntaxStyle.fromStyles({
    default: { fg: toRgba(colors.text) },
    'markup.heading': { fg: toRgba(colors.text), bold: true },
    'markup.list': { fg: toRgba(colors.accent) },
    'markup.link': { fg: toRgba(colors.accent), underline: true },
    'markup.quote': { fg: toRgba(colors.quote) },
    'markup.raw': { fg: toRgba(colors.code) },
    'markup.bold': { fg: toRgba(colors.text), bold: true },
    'markup.strong': { fg: toRgba(colors.text), bold: true, italic: colors.strongItalic ?? false },
    'markup.italic': { fg: toRgba(colors.text), italic: true }
  });
}

function toRgba(color: string | RGBA): RGBA {
  return typeof color === 'string' ? RGBA.fromHex(color) : color;
}

function estimateDiffHeight(diff: string): number {
  const normalized = diff.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const visibleLines = lines.filter((line) => /^( |[+-])/.test(line)).length;
  return Math.max(1, visibleLines);
}

export function clearChildren(container: BoxRenderable): void {
  for (const childId of collectChildIds(container.id)) {
    container.remove(childId);
  }
}

function clearBlockChildren(view: BlockView): void {
  clearChildren(view.container);
  view.userBubble = undefined;
  view.userText = undefined;
  view.markdown = undefined;
  view.diff = undefined;
  view.kind = undefined;
}

function collectChildIds(baseId: string): string[] {
  return [
    `${baseId}-user`,
    `${baseId}-user-text`,
    `${baseId}-assistant`,
    `${baseId}-thinking`,
    `${baseId}-diff-wrapper`,
    `${baseId}-diff-title`,
    `${baseId}-diff-shell`,
    `${baseId}-diff`,
    `${baseId}-tool-header-row`,
    `${baseId}-tool-header-dot`,
    `${baseId}-tool-header`,
    `${baseId}-tool-body-row`,
    `${baseId}-tool-body-gutter`,
    `${baseId}-tool-body`,
    `${baseId}-tool-footer-row`,
    `${baseId}-tool-footer-gutter`,
    `${baseId}-tool-footer`
  ];
}
