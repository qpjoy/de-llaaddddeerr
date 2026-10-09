-- One bounded latest image per device; never embed screenshots in device snapshots/events.
CREATE TABLE IF NOT EXISTS mx_device.latest_frames (
 device_id uuid PRIMARY KEY REFERENCES mx_device.devices(id),
 capture_id uuid NOT NULL,
 config_version uuid NOT NULL,
 received_at bigint NOT NULL,
 png bytea NOT NULL CHECK (octet_length(png) <= 6291456)
);
