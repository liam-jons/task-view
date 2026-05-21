import { describe, expect, it } from 'bun:test';
import {
  createShortcutRegistry,
  defineShortcutScope,
  dispatchShortcutEvent,
  formatShortcutBindingText,
  formatShortcutBindingTokens,
  getShortcut,
  listRegistryShortcutSections,
  matchesKeyName,
  matchesShortcutBinding,
  parseDoubleTapBinding,
  validateShortcutRegistry,
} from './shortcuts';

/**
 * Tests for the shortcut framework (core + runtime).
 *
 * Upstream Plannotator's shortcut tests asserted plan-review, annotate,
 * and code-review shortcut registries that lived in the deleted
 * `@plannotator/editor` and `@plannotator/review-editor` workspace
 * packages. task-view's actual shortcut scopes (Tab / Enter / Esc /
 * Cmd+Enter per PRODUCT inv 53) are defined in ID-20.9 / ID-20.10
 * alongside the viewer surface. This file retains the framework-level
 * tests so the formatter/dispatcher/validator helpers stay regression-
 * guarded across the fork.
 */

describe('shortcuts framework', () => {
  it('formats bindings for docs and keycaps', () => {
    expect(formatShortcutBindingText('Mod+Enter')).toBe('Cmd/Ctrl+Enter');
    expect(formatShortcutBindingText('Alt hold')).toBe('Hold Alt');
    expect(formatShortcutBindingText('Alt Alt')).toBe('Double-tap Alt');
    expect(formatShortcutBindingText('Alt Alt', 'mac')).toBe('Double-tap Option');
    expect(formatShortcutBindingTokens('Mod+Enter', 'mac')).toEqual(['⌘', '⏎']);
    expect(formatShortcutBindingTokens('Mod+Enter', 'non-mac')).toEqual(['Ctrl', '↵']);
    expect(formatShortcutBindingTokens('Alt Alt', 'mac')).toEqual(['⌥', '×2']);
    expect(formatShortcutBindingTokens('Alt Alt', 'non-mac')).toEqual(['Alt', '×2']);
  });

  it('validates duplicate scope ids and non-normalized tokens', () => {
    const duplicateScope = defineShortcutScope({
      id: 'dup',
      title: 'Duplicate',
      shortcuts: {
        submit: {
          description: 'Submit',
          bindings: ['Mod+Enter'],
          section: 'Actions',
        },
      },
    });

    const badScope = defineShortcutScope({
      id: 'bad',
      title: 'Bad',
      shortcuts: {
        broken: {
          description: 'Broken',
          bindings: ['Cmd+Enter'],
          section: 'Actions',
        },
        missingCopy: {
          description: '',
          bindings: ['Mod+C'],
          section: '',
        },
      },
    });

    const errors = validateShortcutRegistry([duplicateScope, duplicateScope, badScope]);

    expect(errors).toContain('Duplicate shortcut scope id: dup');
    expect(errors.some(error => error.includes('Cmd'))).toBe(true);
    expect(errors).toContain('Shortcut bad.missingCopy is missing a section.');
    expect(errors).toContain('Shortcut bad.missingCopy is missing a description.');
    expect(() => createShortcutRegistry([duplicateScope, duplicateScope])).toThrow();
  });

  it('matches normalized runtime bindings', () => {
    const submitEvent = { key: 'Enter', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false, code: 'Enter' } as KeyboardEvent;
    const reverseSearchEvent = { key: 'F3', ctrlKey: false, metaKey: false, shiftKey: true, altKey: false, code: 'F3' } as KeyboardEvent;
    const typeEvent = { key: 'A', ctrlKey: false, metaKey: false, shiftKey: true, altKey: false, code: 'KeyA' } as KeyboardEvent;
    const quickLabelEvent = { key: '3', ctrlKey: false, metaKey: false, shiftKey: false, altKey: true, code: 'Digit3' } as KeyboardEvent;
    const macOptionQuickLabelEvent = { key: '£', ctrlKey: false, metaKey: false, shiftKey: false, altKey: true, code: 'Digit3' } as KeyboardEvent;
    const wrongEvent = { key: 'Enter', ctrlKey: false, metaKey: false, shiftKey: false, altKey: true, code: 'Enter' } as KeyboardEvent;

    expect(matchesShortcutBinding(submitEvent, 'Mod+Enter')).toBe(true);
    expect(matchesShortcutBinding(reverseSearchEvent, 'Shift+F3')).toBe(true);
    expect(matchesShortcutBinding(typeEvent, 'A-Z')).toBe(true);
    expect(matchesShortcutBinding(quickLabelEvent, 'Alt+1-0')).toBe(true);
    expect(matchesShortcutBinding(macOptionQuickLabelEvent, 'Alt+1-0')).toBe(true);
    expect(matchesShortcutBinding(wrongEvent, 'Mod+Enter')).toBe(false);
  });

  it('dispatches matching registry actions', () => {
    const submitScope = defineShortcutScope({
      id: 'submit-scope',
      title: 'Submit',
      shortcuts: {
        submitPlan: {
          description: 'Submit plan',
          bindings: ['Mod+Enter'],
          section: 'Actions',
        },
        quickSave: {
          description: 'Quick save',
          bindings: ['Mod+S'],
          section: 'Actions',
        },
      },
    });

    const calls: string[] = [];
    const event = { key: 'Enter', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false } as KeyboardEvent;

    const handled = dispatchShortcutEvent(submitScope, {
      submitPlan: () => calls.push('submitPlan'),
      quickSave: () => calls.push('quickSave'),
    }, event);

    expect(handled).toBe(true);
    expect(calls).toEqual(['submitPlan']);
  });

  it('supports guarded handlers and continues after a failed guard', () => {
    const guardedScope = defineShortcutScope({
      id: 'guarded',
      title: 'Guarded',
      shortcuts: {
        primary: {
          description: 'Primary',
          bindings: ['Enter'],
          section: 'Actions',
          preventDefault: true,
        },
        fallback: {
          description: 'Fallback',
          bindings: ['Enter'],
          section: 'Actions',
          preventDefault: true,
        },
      },
    });

    const calls: string[] = [];
    const event = {
      key: 'Enter',
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      altKey: false,
      preventDefault: () => calls.push('preventDefault'),
    } as unknown as KeyboardEvent;

    const handled = dispatchShortcutEvent(guardedScope, {
      primary: {
        when: () => false,
        handle: () => calls.push('primary'),
      },
      fallback: {
        when: () => true,
        handle: () => calls.push('fallback'),
      },
    }, event);

    expect(handled).toBe(true);
    expect(calls).toEqual(['preventDefault', 'fallback']);
  });

  it('parses double-tap bindings', () => {
    expect(parseDoubleTapBinding('Alt Alt')).toBe('Alt');
    expect(parseDoubleTapBinding('Shift Shift')).toBe('Shift');
    expect(parseDoubleTapBinding('Alt hold')).toBeNull();
    expect(parseDoubleTapBinding('Mod+Enter')).toBeNull();
    expect(parseDoubleTapBinding('Alt Shift')).toBeNull();
    expect(parseDoubleTapBinding('Alt+Shift Alt+Shift')).toBeNull();
  });

  it('matches key names for sequential binding support', () => {
    const altEvent = { key: 'Alt' } as KeyboardEvent;
    const shiftEvent = { key: 'Shift' } as KeyboardEvent;
    const metaEvent = { key: 'Meta' } as KeyboardEvent;
    const ctrlEvent = { key: 'Control' } as KeyboardEvent;

    expect(matchesKeyName(altEvent, 'Alt')).toBe(true);
    expect(matchesKeyName(altEvent, 'Shift')).toBe(false);
    expect(matchesKeyName(shiftEvent, 'Shift')).toBe(true);
    expect(matchesKeyName(metaEvent, 'Mod')).toBe(true);
    expect(matchesKeyName(ctrlEvent, 'Mod')).toBe(true);
  });

  it('does not handle or prevent default when a guard fails', () => {
    const guardedScope = defineShortcutScope({
      id: 'guarded-skip',
      title: 'Guarded Skip',
      shortcuts: {
        save: {
          description: 'Save',
          bindings: ['Mod+S'],
          section: 'Actions',
          preventDefault: true,
        },
      },
    });

    let preventDefaultCalls = 0;
    const event = {
      key: 's',
      ctrlKey: true,
      metaKey: false,
      shiftKey: false,
      altKey: false,
      preventDefault: () => {
        preventDefaultCalls += 1;
      },
    } as unknown as KeyboardEvent;

    const handled = dispatchShortcutEvent(guardedScope, {
      save: {
        when: () => false,
        handle: () => {
          throw new Error('should not run');
        },
      },
    }, event);

    expect(handled).toBe(false);
    expect(preventDefaultCalls).toBe(0);
  });

  it('lists registry sections from a scope', () => {
    const scope = defineShortcutScope({
      id: 'list-sections',
      title: 'List sections',
      shortcuts: {
        save: {
          description: 'Save',
          bindings: ['Mod+S'],
          section: 'Actions',
        },
        zoom: {
          description: 'Zoom in',
          bindings: ['Mod+='],
          section: 'View',
        },
      },
    });

    const sections = listRegistryShortcutSections([scope]);
    const titles = sections.map(section => section.title);
    expect(titles).toContain('Actions');
    expect(titles).toContain('View');
    expect(getShortcut([scope], 'list-sections', 'save')?.description).toBe('Save');
  });
});
