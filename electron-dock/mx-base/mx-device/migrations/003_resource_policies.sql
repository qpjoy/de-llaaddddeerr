CREATE TABLE mx_device.resource_policies (
 id uuid PRIMARY KEY,
 mode text NOT NULL CHECK(mode IN ('sim','real')),
 resource_key text NOT NULL,
 document jsonb NOT NULL,
 UNIQUE(mode,resource_key)
);
