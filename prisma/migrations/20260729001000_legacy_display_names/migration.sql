UPDATE "vpn_configs"
SET
  "display_name" = "client_name" || '.ovpn',
  "updated_at" = CURRENT_TIMESTAMP
WHERE
  "is_legacy" = TRUE
  AND "display_name" ~ '^VPN #[0-9]+$';
