/**
 * task-view SPA entrypoint placeholder.
 *
 * The real SPA lands in ID-20.9 (read mode) + ID-20.10 (edit mode). For
 * Subtask 20.6 (fork prep) this is a stub so the Vite build target still
 * has a valid mount point; the deleted upstream `@plannotator/editor`
 * import that lived here has been removed.
 */
import React from 'react';
import ReactDOM from 'react-dom/client';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Could not find root element to mount to');
}

const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    <div style={{ padding: '2rem', fontFamily: 'system-ui, sans-serif' }}>
      <h1>task-view</h1>
      <p>The viewer SPA is wired in Subtasks 20.9 (read mode) and 20.10 (edit mode).</p>
    </div>
  </React.StrictMode>
);
