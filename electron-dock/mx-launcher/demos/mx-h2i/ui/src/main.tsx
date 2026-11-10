import '../../src/release-notes-markdown.js';
import '../../src/renderer.js';
import { createRoot } from 'react-dom/client';
import App from './App';
import '../../src/styles.css';
import './styles.css';

createRoot(document.getElementById('app')!).render(<App />);
