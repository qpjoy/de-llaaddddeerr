-- HDO organization control plane.
-- Mesh groups, user memberships, client plugin inventory, and queued device
-- tasks are the server-side basis for managed HDO provisioning.

CREATE TABLE hdo_mesh_groups (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                text NOT NULL,
  slug                text NOT NULL UNIQUE,
  description         text,
  default_profile_id  uuid REFERENCES hdo_profiles(id) ON DELETE SET NULL,
  enabled             boolean NOT NULL DEFAULT true,
  metadata            jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE hdo_mesh_memberships (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mesh_group_id  uuid NOT NULL REFERENCES hdo_mesh_groups(id) ON DELETE CASCADE,
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role           text NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'admin', 'support')),
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'revoked')),
  profile_id     uuid REFERENCES hdo_profiles(id) ON DELETE SET NULL,
  metadata       jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (mesh_group_id, user_id)
);
CREATE INDEX hdo_mesh_memberships_user_idx ON hdo_mesh_memberships(user_id);
CREATE INDEX hdo_mesh_memberships_status_idx ON hdo_mesh_memberships(status);

CREATE TABLE hdo_device_plugin_states (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id      text NOT NULL REFERENCES hdo_devices(id) ON DELETE CASCADE,
  plugin_id      text NOT NULL,
  npm            text,
  name           text,
  version        text,
  state          text NOT NULL,
  manifest       jsonb,
  health         jsonb,
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (device_id, plugin_id)
);
CREATE INDEX hdo_device_plugin_states_device_idx ON hdo_device_plugin_states(device_id);
CREATE INDEX hdo_device_plugin_states_plugin_idx ON hdo_device_plugin_states(plugin_id);

CREATE TABLE hdo_device_tasks (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id           text REFERENCES hdo_devices(id) ON DELETE CASCADE,
  plugin_id           text,
  kind                text NOT NULL CHECK (
                        kind IN (
                          'install-plugin',
                          'uninstall-plugin',
                          'activate-plugin',
                          'deactivate-plugin',
                          'apply-hdo-profile'
                        )
                      ),
  status              text NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'claimed', 'done', 'failed', 'cancelled')),
  payload             jsonb,
  result              jsonb,
  created_by_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  completed_at        timestamptz
);
CREATE INDEX hdo_device_tasks_user_status_idx ON hdo_device_tasks(user_id, status);
CREATE INDEX hdo_device_tasks_device_status_idx ON hdo_device_tasks(device_id, status);
