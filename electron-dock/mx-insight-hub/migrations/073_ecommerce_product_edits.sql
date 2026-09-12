-- Editable management projection; immutable paid response evidence remains untouched.
CREATE TABLE IF NOT EXISTS ecommerce_product_edits (
 request_id uuid NOT NULL, ordinal integer NOT NULL CHECK (ordinal > 0),
 product jsonb NOT NULL, manual boolean NOT NULL DEFAULT false,
 deleted boolean NOT NULL DEFAULT false, revision integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 audit jsonb NOT NULL DEFAULT '[]'::jsonb,
 PRIMARY KEY (request_id, ordinal)
);
CREATE INDEX IF NOT EXISTS ecommerce_product_edits_manual_idx ON ecommerce_product_edits (created_at DESC, request_id DESC) WHERE manual;
