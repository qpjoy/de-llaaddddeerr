-- Expand HDO service protocol labels. Protocol remains metadata for
-- display/probing; routing is still driven by target_host/target_port.

ALTER TABLE hdo_services
  DROP CONSTRAINT IF EXISTS hdo_services_protocol_check;

ALTER TABLE hdo_services
  ADD CONSTRAINT hdo_services_protocol_check
  CHECK (
    protocol IN (
      'tcp',
      'udp',
      'http',
      'https',
      'ws',
      'wss',
      'ssh',
      'sftp',
      'scp',
      'ftp',
      'ftps',
      'mysql',
      'postgresql',
      'redis',
      'mongodb',
      'mssql',
      'rdp',
      'vnc',
      'smb',
      'ldap',
      'ldaps',
      'grpc',
      'grpcs',
      'mqtt',
      'amqp',
      'smtp',
      'imap',
      'pop3',
      'dns',
      'custom'
    )
  );
