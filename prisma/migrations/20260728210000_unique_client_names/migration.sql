CREATE TABLE "client_names" (
    "name" VARCHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "client_names_pkey" PRIMARY KEY ("name")
);

INSERT INTO "client_names" ("name")
SELECT "client_name" FROM "vpn_configs"
ON CONFLICT ("name") DO NOTHING;

INSERT INTO "client_names" ("name")
SELECT "client_name" FROM "legacy_clients"
ON CONFLICT ("name") DO NOTHING;
