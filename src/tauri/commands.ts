/**
 * Tauri IPC Commands
 *
 * This module provides TypeScript bindings for Tauri backend commands.
 * These commands communicate with the Rust backend via Tauri's IPC system.
 */

import { invoke } from '@tauri-apps/api/core';

/**
 * Network access mode for the server
 */
export type NetworkMode = 'localhost' | 'lan';

/**
 * Server configuration
 */
export interface ServerConfig {
  /** Network access mode */
  network_mode: NetworkMode;
  /** Maximum connections allowed (0 = unlimited) */
  max_connections: number;
  /** Port to listen on */
  port: number;
}

/**
 * Server status information from the Tauri backend
 */
export interface ServerStatus {
  /** Whether the server is currently running */
  running: boolean;
  /** Port the server is listening on (0 if not running) */
  port: number;
  /** Number of connected clients */
  connected_clients: number;
  /** Primary WebSocket address (empty if not running) */
  address: string;
  /** All available addresses to connect to */
  addresses: string[];
  /** Current network mode */
  network_mode: NetworkMode;
  /** Maximum allowed connections (0 = unlimited) */
  max_connections: number;
}

/**
 * Check if running in Tauri environment
 * Tauri v2 uses __TAURI_INTERNALS__ instead of __TAURI__
 */
export function isTauri(): boolean {
  return (
    typeof window !== 'undefined' &&
    ('__TAURI_INTERNALS__' in window || '__TAURI__' in window)
  );
}

/**
 * Get the current server mode status
 * @returns true if Protected Local mode is enabled
 */
export async function getServerMode(): Promise<boolean> {
  if (!isTauri()) return false;
  return invoke<boolean>('get_server_mode');
}

/**
 * Set the server mode (Protected Local on/off)
 * @param enabled - Whether to enable server mode
 */
export async function setServerMode(enabled: boolean): Promise<void> {
  if (!isTauri()) return;
  return invoke<void>('set_server_mode', { enabled });
}

/**
 * Get the app version from Cargo.toml
 * @returns Version string (e.g., "0.1.0")
 */
export async function getAppVersion(): Promise<string> {
  if (!isTauri()) return '0.1.0-web';
  return invoke<string>('get_app_version');
}

/**
 * Start the WebSocket server for Protected Local mode
 * @param port - Port to listen on
 * @returns Server URL on success
 */
export async function startServer(port: number): Promise<string> {
  if (!isTauri()) {
    throw new Error('Server mode only available in desktop app');
  }
  return invoke<string>('start_server', { port });
}

/**
 * Stop the WebSocket server
 */
export async function stopServer(): Promise<void> {
  if (!isTauri()) return;
  return invoke<void>('stop_server');
}

/**
 * Get the current server status
 * @returns Server status information
 */
export async function getServerStatus(): Promise<ServerStatus> {
  if (!isTauri()) {
    return {
      running: false,
      port: 0,
      connected_clients: 0,
      address: '',
      addresses: [],
      network_mode: 'lan',
      max_connections: 10,
    };
  }
  return invoke<ServerStatus>('get_server_status');
}

/**
 * Get the current server configuration
 * @returns Server configuration
 */
export async function getServerConfig(): Promise<ServerConfig> {
  if (!isTauri()) {
    return {
      network_mode: 'lan',
      max_connections: 10,
      port: 9876,
    };
  }
  return invoke<ServerConfig>('get_server_config');
}

/**
 * Update server configuration (only when server is not running)
 * @param config - New server configuration
 */
export async function setServerConfig(config: ServerConfig): Promise<void> {
  if (!isTauri()) {
    throw new Error('Server configuration only available in desktop app');
  }
  return invoke<void>('set_server_config', { config });
}

/**
 * Get available LAN IP addresses for client connections
 * @returns Array of IP address strings
 */
export async function getLanAddresses(): Promise<string[]> {
  if (!isTauri()) {
    return [];
  }
  return invoke<string[]>('get_lan_addresses');
}

/**
 * Open the documentation in the system browser
 * Uses bundled docs if available, otherwise falls back to online docs
 */
export async function openDocs(): Promise<void> {
  if (!isTauri()) {
    // In browser, just open online docs
    window.open('https://QR-Madness.github.io/diagrammer/', '_blank');
    return;
  }
  return invoke<void>('open_docs');
}

// ============ MCP Server (Model Context Protocol) ============

/**
 * MCP server status reported by the Tauri backend.
 */
export interface McpStatus {
  /** True if the MCP HTTP listener is bound */
  running: boolean;
  /** Port the listener is bound to (0 if not running) */
  port: number;
  /** Loopback address + port, e.g. "127.0.0.1:9877" */
  address: string;
}

/** Length bounds for user-supplied MCP tokens. Mirrors the Rust constants. */
export const MCP_TOKEN_MIN_LEN = 16;
export const MCP_TOKEN_MAX_LEN = 128;
/** URL-safe alphabet accepted for MCP tokens (matches the Rust validator). */
export const MCP_TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/;

export async function mcpStatus(): Promise<McpStatus> {
  if (!isTauri()) {
    return { running: false, port: 0, address: '' };
  }
  return invoke<McpStatus>('mcp_status');
}

export async function mcpStart(): Promise<string> {
  if (!isTauri()) {
    throw new Error('MCP server only available in desktop app');
  }
  return invoke<string>('mcp_start');
}

export async function mcpStop(): Promise<void> {
  if (!isTauri()) {
    throw new Error('MCP server only available in desktop app');
  }
  return invoke<void>('mcp_stop');
}

export async function mcpGetToken(): Promise<string> {
  if (!isTauri()) {
    throw new Error('MCP server only available in desktop app');
  }
  return invoke<string>('mcp_get_token');
}

export async function mcpRegenerateToken(): Promise<string> {
  if (!isTauri()) {
    throw new Error('MCP server only available in desktop app');
  }
  return invoke<string>('mcp_regenerate_token');
}

export async function mcpSetToken(token: string): Promise<string> {
  if (!isTauri()) {
    throw new Error('MCP server only available in desktop app');
  }
  return invoke<string>('mcp_set_token', { token });
}

/**
 * Push a snapshot of a local (renderer-owned) document into the MCP local
 * mirror. Silently swallowed when not in Tauri so the persistence layer
 * can call this unconditionally on every save.
 */
export async function mcpMirrorLocalDocument(document: unknown): Promise<void> {
  if (!isTauri()) return;
  try {
    await invoke<void>('mcp_mirror_local_document', { document });
  } catch (e) {
    // Mirroring is opportunistic — never block a save on it.
    console.warn('MCP mirror failed:', e);
  }
}

export async function mcpUnmirrorLocalDocument(docId: string): Promise<void> {
  if (!isTauri()) return;
  try {
    await invoke<boolean>('mcp_unmirror_local_document', { docId });
  } catch (e) {
    console.warn('MCP unmirror failed:', e);
  }
}

export async function mcpClearLocalMirror(): Promise<void> {
  if (!isTauri()) return;
  return invoke<void>('mcp_clear_local_mirror');
}

export async function mcpGetLocalAccess(): Promise<boolean> {
  if (!isTauri()) return false;
  return invoke<boolean>('mcp_get_local_access');
}

export async function mcpSetLocalAccess(enabled: boolean): Promise<boolean> {
  if (!isTauri()) return false;
  return invoke<boolean>('mcp_set_local_access', { enabled });
}
