CREATE SCHEMA IF NOT EXISTS "public";

CREATE TYPE "ServerKey" AS ENUM ('new', 'old');
CREATE TYPE "ConfigStatus" AS ENUM ('active', 'expired', 'revoked', 'error');

CREATE TABLE "users" (
    "id" SERIAL NOT NULL,
    "telegram_id" TEXT NOT NULL,
    "username" TEXT,
    "first_name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "vpn_configs" (
    "id" UUID NOT NULL,
    "user_id" INTEGER NOT NULL,
    "display_name" TEXT NOT NULL,
    "client_name" TEXT NOT NULL,
    "server_key" "ServerKey" NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "status" "ConfigStatus" NOT NULL DEFAULT 'active',
    "is_legacy" BOOLEAN NOT NULL DEFAULT false,
    "revoked_at" TIMESTAMPTZ(3),
    "hidden_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "vpn_configs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "notifications" (
    "id" SERIAL NOT NULL,
    "config_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "local_date" TEXT NOT NULL,
    "sent_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "legacy_clients" (
    "id" SERIAL NOT NULL,
    "server_key" "ServerKey" NOT NULL,
    "client_name" TEXT NOT NULL,
    "assigned_config_id" UUID,
    "discovered_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "legacy_clients_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "users_telegram_id_key" ON "users"("telegram_id");
CREATE INDEX "users_username_idx" ON "users"("username");
CREATE UNIQUE INDEX "vpn_configs_server_key_client_name_key" ON "vpn_configs"("server_key", "client_name");
CREATE INDEX "vpn_configs_user_id_idx" ON "vpn_configs"("user_id");
CREATE INDEX "vpn_configs_status_expires_at_idx" ON "vpn_configs"("status", "expires_at");
CREATE UNIQUE INDEX "notifications_config_id_kind_local_date_key" ON "notifications"("config_id", "kind", "local_date");
CREATE UNIQUE INDEX "legacy_clients_server_key_client_name_key" ON "legacy_clients"("server_key", "client_name");
CREATE INDEX "legacy_clients_assigned_config_id_idx" ON "legacy_clients"("assigned_config_id");

ALTER TABLE "vpn_configs" ADD CONSTRAINT "vpn_configs_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_config_id_fkey"
  FOREIGN KEY ("config_id") REFERENCES "vpn_configs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "legacy_clients" ADD CONSTRAINT "legacy_clients_assigned_config_id_fkey"
  FOREIGN KEY ("assigned_config_id") REFERENCES "vpn_configs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
