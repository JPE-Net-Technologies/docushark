/**
 * Authentication and Authorization Types
 *
 * Defines types for user authentication, roles, and permissions
 * in Relay (Team) mode.
 */

/**
 * User role in the team
 */
export type UserRole = 'admin' | 'user';

/**
 * User account information
 */
export interface User {
  /** Unique user identifier */
  id: string;
  /** Display name */
  displayName: string;
  /** Username for login */
  username: string;
  /** User's role in the team */
  role: UserRole;
  /** Timestamp when user was created */
  createdAt: number;
  /** Timestamp when user last logged in */
  lastLoginAt?: number;
}

/**
 * JWT session token payload
 */
export interface SessionTokenPayload {
  /** User ID */
  sub: string;
  /** Username */
  username: string;
  /** User role */
  role: UserRole;
  /** Token issued at (Unix timestamp) */
  iat: number;
  /** Token expires at (Unix timestamp) */
  exp: number;
}

/**
 * Session token wrapper with metadata
 */
export interface SessionToken {
  /** The JWT token string */
  token: string;
  /** Token expiration timestamp (milliseconds) */
  expiresAt: number;
}

/**
 * Login credentials
 */
export interface LoginCredentials {
  username: string;
  password: string;
}

/**
 * Login response from server
 */
export interface LoginResponse {
  success: boolean;
  user?: User;
  token?: SessionToken;
  error?: string;
}

/**
 * Permission action types
 */
export type PermissionAction =
  | 'edit'        // Modify existing content
  | 'create'      // Create new content
  | 'delete'      // Remove content
  | 'lock'        // Lock/unlock content
  | 'manage';     // Administrative actions

/**
 * Permission target types
 */
export type PermissionTarget =
  | 'document'    // Document-level operations
  | 'page'        // Page-level operations
  | 'shape'       // Shape-level operations
  | 'group'       // Group-level operations
  | 'styleProfile' // Style profile operations
  | 'user';       // User management

/**
 * Permission check result
 */
export interface PermissionResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Ownership information for owned entities
 */
export interface Ownership {
  /** User ID of the owner (null = SYSTEM owned) */
  ownerId: string | null;
  /** Whether the entity is locked by owner (undefined treated as false) */
  locked?: boolean | undefined;
  /** User ID of who locked it (if locked) */
  lockedBy?: string | undefined;
  /** Timestamp when locked */
  lockedAt?: number | undefined;
}

/**
 * Team document metadata (extends DocumentMetadata)
 */
export interface TeamDocumentMetadata {
  /** Whether this is a relay document (stored on host) */
  isRelayDocument: boolean;
  /** User ID who currently has the document locked for editing */
  lockedBy?: string;
  /** Display name of user who locked it */
  lockedByName?: string;
  /** Timestamp when document was locked */
  lockedAt?: number;
}

/**
 * Team member information
 */
export interface TeamMember {
  /** User information */
  user: User;
  /** Whether the member is currently online */
  online: boolean;
  /** Last seen timestamp */
  lastSeenAt?: number;
}

/**
 * Server mode for the application
 */
export type ServerMode = 'offline' | 'host' | 'client';

/**
 * Connection status
 */
export interface ConnectionStatus {
  /** Current server mode */
  mode: ServerMode;
  /** Whether connected to a host (for client mode) */
  connected: boolean;
  /** Host address if in client mode */
  hostAddress?: string;
  /** Port if hosting */
  hostPort?: number;
  /** Error message if connection failed */
  error?: string;
}

/**
 * Check if a user has admin privileges
 */
export function isAdmin(user: User | null): boolean {
  return user?.role === 'admin';
}

/**
 * Check if a user owns an entity
 */
export function isOwner(userId: string | null, ownership: Ownership | null): boolean {
  if (!ownership || ownership.ownerId === null) {
    return false; // SYSTEM-owned
  }
  return ownership.ownerId === userId;
}

/**
 * Special owner ID for system-owned entities
 */
export const SYSTEM_OWNER_ID = null;

/**
 * Default session token expiry (24 hours in milliseconds)
 */
export const DEFAULT_TOKEN_EXPIRY_MS = 24 * 60 * 60 * 1000;
