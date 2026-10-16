import { XMLParser, XMLValidator } from 'fast-xml-parser';
import type { MobilePlatform } from './api/types.js';
import { VerifyError } from './errors.js';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One native UI element, normalized across Android UIAutomator XML and iOS accessibility JSON. */
export interface UiElement {
  testId: string;
  label: string;
  text: string;
  type: string;
  rect: Rect;
  enabled: boolean;
  editable: boolean;
}

const MAX_DEPTH = 200;
const MAX_ELEMENTS = 20_000;
const ANDROID_BOUNDS = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/;
const ANDROID_EDITABLE = new Set(['android.widget.EditText', 'android.widget.AutoCompleteTextView']);
const IOS_EDITABLE = new Set(['TextField', 'SecureTextField', 'TextView', 'SearchField']);

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  parseAttributeValue: false,
  ignoreDeclaration: true,
  processEntities: true,
  isArray: (name) => name === 'node',
});

export function parseHierarchy(raw: string, platform: MobilePlatform): UiElement[] {
  const elements: UiElement[] = [];
  const invalid = (reason: string): never => {
    throw new VerifyError('ACTION_FAILED', `Revyl returned an ${platform} UI hierarchy Verify cannot read: ${reason}`);
  };
  const push = (element: UiElement, depth: number): void => {
    if (depth > MAX_DEPTH || elements.length >= MAX_ELEMENTS) invalid('it is too deep or too large');
    elements.push(element);
  };

  if (platform === 'android') {
    const xml = raw.replace(/(<\/hierarchy>)[\s\S]*$/, '$1');
    if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) invalid('the XML is malformed');
    const document = xmlParser.parse(xml) as { hierarchy?: { node?: AndroidNode[] } };
    const visit = (node: AndroidNode, depth: number): void => {
      const bounds = ANDROID_BOUNDS.exec(node.bounds ?? '');
      if (!bounds) invalid(`a node has bounds "${node.bounds}"`);
      const [left, top, right, bottom] = bounds!.slice(1).map(Number) as [number, number, number, number];
      push(
        {
          testId: node['resource-id'] ?? '',
          label: node['content-desc'] ?? '',
          text: node.text ?? '',
          type: node.class ?? '',
          rect: { x: left, y: top, width: right - left, height: bottom - top },
          enabled: node.enabled !== 'false',
          editable: ANDROID_EDITABLE.has(node.class ?? ''),
        },
        depth,
      );
      for (const child of node.node ?? []) visit(child, depth + 1);
    };
    for (const node of document.hierarchy?.node ?? []) visit(node, 0);
    return elements;
  }

  let roots: unknown;
  try {
    roots = JSON.parse(raw);
  } catch {
    invalid('the JSON is malformed');
  }
  const visit = (node: IosNode, depth: number): void => {
    const frame = node.frame;
    if (!frame || ![frame.x, frame.y, frame.width, frame.height].every(Number.isFinite)) invalid('a node has no frame');
    const type = node.type ?? node.role ?? '';
    const editable = IOS_EDITABLE.has(type);
    const label = node.AXLabel ?? '';
    const value = node.AXValue ?? '';
    push(
      {
        testId: node.AXUniqueId ?? '',
        label,
        text: editable ? value : label || value,
        type,
        rect: { x: frame!.x, y: frame!.y, width: frame!.width, height: frame!.height },
        enabled: node.enabled !== false,
        editable,
      },
      depth,
    );
    for (const child of node.children ?? []) visit(child, depth + 1);
  };
  if (!Array.isArray(roots)) invalid('the root is not a list');
  for (const node of roots as IosNode[]) visit(node, 0);
  return elements;
}

export function isOnScreen(element: UiElement, screen: { width: number; height: number } | undefined): boolean {
  const { x, y, width, height } = element.rect;
  if (width <= 0 || height <= 0) return false;
  if (!screen) return true;
  const centerX = x + width / 2;
  const centerY = y + height / 2;
  return centerX >= 0 && centerY >= 0 && centerX < screen.width && centerY < screen.height;
}

export function center(element: UiElement): { x: number; y: number } {
  return {
    x: Math.floor(element.rect.x + element.rect.width / 2),
    y: Math.floor(element.rect.y + element.rect.height / 2),
  };
}

interface AndroidNode {
  bounds?: string;
  text?: string;
  class?: string;
  enabled?: string;
  'resource-id'?: string;
  'content-desc'?: string;
  node?: AndroidNode[];
}

interface IosNode {
  type?: string;
  role?: string;
  AXLabel?: string | null;
  AXValue?: string | null;
  AXUniqueId?: string | null;
  enabled?: boolean;
  frame?: { x: number; y: number; width: number; height: number };
  children?: IosNode[];
}
