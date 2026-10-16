import { describe, expect, it } from 'vitest';
import { parseHierarchy } from '../src/hierarchy.js';
import { androidXml } from './helpers/fake-revyl.js';

describe('parseHierarchy', () => {
  it('reads Android UIAutomator XML', () => {
    const elements = parseHierarchy(
      androidXml([{ text: 'Sign in', id: 'com.app:id/sign_in', cls: 'android.widget.Button', bounds: [100, 200, 300, 260], enabled: false }]),
      'android',
    );
    expect(elements[1]).toEqual({
      testId: 'com.app:id/sign_in',
      label: '',
      text: 'Sign in',
      type: 'android.widget.Button',
      rect: { x: 100, y: 200, width: 200, height: 60 },
      enabled: false,
      editable: false,
    });
  });

  it('reads iOS accessibility JSON and uses field values as text', () => {
    const raw = JSON.stringify([
      {
        type: 'Application',
        frame: { x: 0, y: 0, width: 390, height: 844 },
        children: [
          { type: 'TextField', AXLabel: 'Email', AXValue: 'a@b.co', AXUniqueId: 'email', frame: { x: 20, y: 100, width: 350, height: 44 } },
          { type: 'Button', AXLabel: 'Continue', frame: { x: 20, y: 200, width: 350, height: 44 } },
        ],
      },
    ]);
    const [, field, button] = parseHierarchy(raw, 'ios');
    expect(field).toMatchObject({ testId: 'email', label: 'Email', text: 'a@b.co', editable: true });
    expect(button).toMatchObject({ label: 'Continue', text: 'Continue', type: 'Button' });
  });

  it('rejects XML with a DOCTYPE and malformed JSON', () => {
    expect(() => parseHierarchy('<!DOCTYPE x [<!ENTITY a "b">]><hierarchy/>', 'android')).toThrow('malformed');
    expect(() => parseHierarchy('{not json', 'ios')).toThrow('JSON is malformed');
  });
});
