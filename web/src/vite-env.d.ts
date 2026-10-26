/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 'mock' (default) runs the in-browser simulator; 'api' uses the ASP.NET Core backend. */
  readonly VITE_DATA_SOURCE?: 'mock' | 'api';
  /** Base URL of the backend, e.g. http://localhost:5000 */
  readonly VITE_API_URL?: string;
  /** Simulator only: how much of the rig exists. 'zone-a' (default), 'two-zone' or 'full'. */
  readonly VITE_SIM_STAGE?: 'zone-a' | 'two-zone' | 'full';
}
