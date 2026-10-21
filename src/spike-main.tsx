// Spike entry (ticket #2 qualification). Served from spike.html so the product
// keeps the root path; opened via YAW_APP=http://127.0.0.1:4173/spike.html.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import SpikeApp from './spike/SpikeApp';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SpikeApp />
  </StrictMode>,
);
