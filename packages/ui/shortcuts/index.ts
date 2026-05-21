// Shortcut framework barrel — core types/helpers + runtime hooks.
//
// task-view's actual shortcut scopes (Tab / Enter / Esc / Cmd+Enter per
// PRODUCT inv 53) are defined alongside the viewer surface in ID-20.9 /
// ID-20.10. Upstream Plannotator's plan-review and code-review scopes
// were annotation-coupled and got removed in the §1.2 strip.
export * from './core';
export * from './runtime';
