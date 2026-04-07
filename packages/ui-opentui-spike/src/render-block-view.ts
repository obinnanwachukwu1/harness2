import {
  BoxRenderable,
  type CliRenderer,
  TextAttributes,
  TextRenderable
} from '@opentui/core';

import type { OpenTuiRenderBlock } from '../../../src/ui-opentui/render-types.js';

type ToolTone = Extract<OpenTuiRenderBlock, { kind: 'tool' }>['tone'];

export interface BlockView {
  container: BoxRenderable;
}

export function createBlockView(renderer: CliRenderer, block: OpenTuiRenderBlock): BlockView {
  const container = new BoxRenderable(renderer, {
    id: `block-${block.id}`,
    width: '100%',
    flexDirection: 'column',
    paddingBottom: 1
  });

  const view: BlockView = { container };
  updateBlockView(renderer, view, block);
  return view;
}

export function updateBlockView(
  renderer: CliRenderer,
  view: BlockView,
  block: OpenTuiRenderBlock
): void {
  clearBlockChildren(view);
  const baseId = view.container.id;

  switch (block.kind) {
    case 'user': {
      const bubble = new BoxRenderable(renderer, {
        id: `${baseId}-user`,
        width: '100%',
        backgroundColor: '#4b5563',
        paddingLeft: 1,
        paddingRight: 1
      });
      bubble.add(
        new TextRenderable(renderer, {
          id: `${baseId}-user-text`,
          content: block.text,
          fg: '#ffffff',
          selectionBg: '#93c5fd',
          selectionFg: '#111111',
          wrapMode: 'word'
        })
      );
      view.container.add(bubble);
      return;
    }
    case 'assistant':
      view.container.add(
        new TextRenderable(renderer, {
          id: `${baseId}-assistant`,
          content: block.text,
          fg: '#ffffff',
          selectionBg: '#93c5fd',
          selectionFg: '#111111',
          wrapMode: 'word'
        })
      );
      return;
    case 'thinking':
      view.container.add(
        new TextRenderable(renderer, {
          id: `${baseId}-thinking`,
          content: block.text,
          fg: '#5fd7ff',
          selectionBg: '#67e8f9',
          selectionFg: '#111111',
          attributes: TextAttributes.DIM,
          wrapMode: 'word'
        })
      );
      return;
    case 'tool': {
      const colors = getToolToneColors(block.tone);
      view.container.add(
        new TextRenderable(renderer, {
          id: `${baseId}-tool-header`,
          content: `⏺ ${block.header}`,
          fg: colors.header,
          selectionBg: colors.selectionBg,
          selectionFg: '#111111',
          attributes: TextAttributes.BOLD,
          wrapMode: 'word'
        })
      );
      if (block.body.length > 0) {
        const bodyRow = new BoxRenderable(renderer, {
          id: `${baseId}-tool-body-row`,
          width: '100%',
          flexDirection: 'row'
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
          flexDirection: 'row'
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

export function clearChildren(container: BoxRenderable): void {
  for (const childId of collectChildIds(container.id)) {
    container.remove(childId);
  }
}

function clearBlockChildren(view: BlockView): void {
  clearChildren(view.container);
}

function collectChildIds(baseId: string): string[] {
  return [
    `${baseId}-user`,
    `${baseId}-user-text`,
    `${baseId}-assistant`,
    `${baseId}-thinking`,
    `${baseId}-tool-header`,
    `${baseId}-tool-body-row`,
    `${baseId}-tool-body-gutter`,
    `${baseId}-tool-body`,
    `${baseId}-tool-footer-row`,
    `${baseId}-tool-footer-gutter`,
    `${baseId}-tool-footer`
  ];
}
