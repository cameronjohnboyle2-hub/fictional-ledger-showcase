import { createRoot } from 'react-dom/client';
import { activateShowcaseStorage } from './showcase/bootstrap';
import './index.css';

// Load application modules only after establishing an isolated memory store.
// If the browser refuses isolation, fail closed without importing the app.
try {
  activateShowcaseStorage(window);
  import('./App').then(({ default: App }) => {
    createRoot(document.getElementById('root')!).render(<App />);
  }).catch(() => {
    document.getElementById('root')!.textContent = 'The fictional demo could not load. Please reload.';
  });
} catch {
  document.getElementById('root')!.textContent = 'This browser cannot isolate the fictional demo safely.';
}
