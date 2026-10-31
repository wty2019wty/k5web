import type { RouteRecordNormalized } from 'vue-router';

export interface AppState {
  theme: string;
  colorWeak: boolean;
  navbar: boolean;
  menu: boolean;
  topMenu: boolean;
  hideMenu: boolean;
  menuCollapse: boolean;
  footer: boolean;
  themeColor: string;
  menuWidth: number;
  globalSettings: boolean;
  device: string;
  tabBar: boolean;
  menuFromServer: boolean;
  serverMenu: RouteRecordNormalized[];

  // Device connection/runtime info (set on successful handshake in navbar connect)
  connectState?: boolean;
  connectPort?: unknown;
  firmwareVersion?: string;
  configuration?: unknown;

  // BLE 写分片档位：'auto' 或 509/256/128/64/32/20
  bleChunkSize?: string | number;

  [key: string]: unknown;
}
