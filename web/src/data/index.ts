import { createApiSource } from './api/apiSource';
import { createMockSource } from './mock/mockSource';
import type { DataSource } from './source';

// VITE_DATA_SOURCE: 'mock' (default) runs the in-browser simulator; 'api' uses the backend.
// The backend serves this app itself, so the API is on the same address and
// VITE_API_URL is normally left empty. During `npm run dev`, Vite forwards
// /api and /hubs to the backend on localhost:5000 (see vite.config.ts).
const mode = import.meta.env.VITE_DATA_SOURCE ?? 'mock';
const apiUrl = import.meta.env.VITE_API_URL ?? '';

export const dataSource: DataSource = mode === 'api' ? createApiSource(apiUrl) : createMockSource();
