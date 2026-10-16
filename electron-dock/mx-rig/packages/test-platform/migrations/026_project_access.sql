-- NULL preserves the existing deployment-wide catalog. New workbench projects
-- carry an explicit owner and policy; updates use row locking + revision CAS.
ALTER TABLE mxt_apps ADD COLUMN project_access jsonb;
ALTER TABLE mxt_apps ADD CONSTRAINT mxt_apps_project_access_shape CHECK (
  project_access IS NULL OR (
    jsonb_typeof(project_access) = 'object' AND
    project_access->>'visibility' IN ('legacy-shared', 'private', 'members') AND
    jsonb_typeof(project_access->'members') = 'array' AND
    jsonb_typeof(project_access->'revision') = 'number' AND
    jsonb_typeof(project_access->'ownerId') = 'string'
  ) IS TRUE
);
