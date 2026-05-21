-- Per-mesh persistent device state.
-- A device row records the physical client; this table records the device's
-- standing inside each mesh it has joined.

CREATE TABLE hdo_device_mesh_states (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mesh_group_id       uuid NOT NULL REFERENCES hdo_mesh_groups(id) ON DELETE CASCADE,
  device_id           text NOT NULL REFERENCES hdo_devices(id) ON DELETE CASCADE,
  user_id             uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status              text NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'disabled', 'kicked')),
  note                text,
  metadata            jsonb,
  last_seen_at        timestamptz,
  created_by_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (mesh_group_id, device_id)
);
CREATE INDEX hdo_device_mesh_states_mesh_idx
  ON hdo_device_mesh_states(mesh_group_id, status);
CREATE INDEX hdo_device_mesh_states_device_idx
  ON hdo_device_mesh_states(device_id);
CREATE INDEX hdo_device_mesh_states_user_idx
  ON hdo_device_mesh_states(user_id);

INSERT INTO hdo_device_mesh_states (
  mesh_group_id,
  device_id,
  user_id,
  status,
  last_seen_at,
  metadata
)
SELECT
  m.mesh_group_id,
  d.id,
  d.user_id,
  'active',
  d.last_seen_at,
  jsonb_build_object('backfilled', true)
FROM hdo_devices d
JOIN hdo_mesh_memberships m
  ON m.user_id = d.user_id
WHERE m.status = 'active'
ON CONFLICT (mesh_group_id, device_id) DO NOTHING;

ALTER TABLE hdo_device_tasks
  DROP CONSTRAINT IF EXISTS hdo_device_tasks_kind_check;
ALTER TABLE hdo_device_tasks
  ADD CONSTRAINT hdo_device_tasks_kind_check
  CHECK (
    kind IN (
      'install-plugin',
      'uninstall-plugin',
      'activate-plugin',
      'deactivate-plugin',
      'apply-hdo-profile',
      'notify'
    )
  );
