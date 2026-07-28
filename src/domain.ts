export type ServerKey = "new" | "old";
export type ConfigStatus = "active" | "expired" | "revoked" | "error";

export interface UserRecord {
  id: number;
  telegramId: string;
  username: string | null;
  firstName: string;
  createdAt: string;
  updatedAt: string;
}

export interface VpnConfigRecord {
  id: string;
  userId: number;
  displayName: string;
  clientName: string;
  serverKey: ServerKey;
  expiresAt: string;
  status: ConfigStatus;
  isLegacy: boolean;
  revokedAt: string | null;
  hiddenAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface LegacyClientRecord {
  id: number;
  serverKey: ServerKey;
  clientName: string;
  assignedConfigId: string | null;
  discoveredAt: string;
}

export interface ServerTraffic {
  uploadBytes: number;
  downloadBytes: number;
}
