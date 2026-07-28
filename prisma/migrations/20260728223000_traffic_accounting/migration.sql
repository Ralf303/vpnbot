ALTER TABLE "client_names" ADD COLUMN "config_id" UUID;

CREATE INDEX "client_names_config_id_idx" ON "client_names"("config_id");

ALTER TABLE "client_names"
ADD CONSTRAINT "client_names_config_id_fkey"
FOREIGN KEY ("config_id") REFERENCES "vpn_configs"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

UPDATE "client_names" AS names
SET "config_id" = configs."id"
FROM "vpn_configs" AS configs
WHERE names."name" = configs."client_name";

CREATE TABLE "traffic_events" (
    "server_key" "ServerKey" NOT NULL,
    "event_id" VARCHAR(160) NOT NULL,
    "config_id" UUID,
    "client_name" VARCHAR(64) NOT NULL,
    "upload_bytes" BIGINT NOT NULL,
    "download_bytes" BIGINT NOT NULL,
    "connected_at" TIMESTAMPTZ(3) NOT NULL,
    "disconnected_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "traffic_events_pkey" PRIMARY KEY ("server_key", "event_id")
);

CREATE INDEX "traffic_events_config_id_idx" ON "traffic_events"("config_id");
CREATE INDEX "traffic_events_server_key_disconnected_at_idx" ON "traffic_events"("server_key", "disconnected_at");

ALTER TABLE "traffic_events"
ADD CONSTRAINT "traffic_events_config_id_fkey"
FOREIGN KEY ("config_id") REFERENCES "vpn_configs"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
